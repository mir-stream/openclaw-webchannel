/**
 * WebChannel NATS Client Wrapper — public browser-facing state adapter.
 *
 * This module wraps `WebChannelNatsClient` with transcript, approval, progress,
 * and subscription state suitable for UI integrations.
 *
 * Changes from gateway-WS:
 * - No WebSocket connection to /webchannel/ws
 * - NATS WebSocket connection with JWT authentication
 * - Per-peer NATS subjects instead of single socket
 * - Message format preserved (compatible with existing UI)
 */

import type {
  WebChannelOptions,
  WebChannelState,
  WebChannelErrorCause,
  Listener,
  ApprovalDecision,
  ApprovalOption,
  ChatMessage,
  ReasoningItem,
  ToolActivityItem,
  ApprovalRequest,
  SendReceipt,
  SendFailure,
  SendState,
} from "./types.js";
import {
  WebChannelNatsClient,
  type WebChannelNatsClientOptions as DirectClientOptions,
  type InboundMessage,
} from "./nats-client.js";

/**
 * P0-4: the state a `SendReceipt` observes. A separate `receiptKey`-keyed record
 * (not the render bubble) is authoritative: it survives `retract()` removing the
 * bubble and history adoption rewriting the bubble's `id`, so `snapshot()` never
 * loses its backing or reports a stuck `queued`. The render bubble's
 * `sendState`/`sendFailure` mirror this record for the UI.
 */
type ReceiptRecord = {
  id: string;
  /** Assigned at immediate publish or held release; absent while still held. */
  wireId?: string;
  /** Whether this user publish can produce a `turn_settled` frame. */
  settlementEligible: boolean;
  /** One-way latch: the first authoritative publish/settle decision consumes it. */
  turnOpeningConsumed: boolean;
  state: NonNullable<ChatMessage["sendState"]>;
  failure?: SendFailure;
  // P0-4 (review R5): mirrors `SendReceipt.snapshot()` — a concrete, non-optional
  // state (a record always has one), so consumers never narrow an impossible
  // `undefined`.
  subscribers: Set<(s: { state: NonNullable<ChatMessage["sendState"]>; failure?: SendFailure }) => void>;
  /** Nested transitions wait until the current bubble/subscriber fanout ends. */
  pendingTransitions: Array<{
    state: NonNullable<ChatMessage["sendState"]>;
    failure?: SendFailure;
    extraBubblePatch?: Partial<ChatMessage>;
  }>;
  drainingTransitions: boolean;
};

/** Frozen before outcome fanout, which may synchronously mutate `openTurns`. */
type TurnSettlementPlacement = {
  openPrefix: string[];
};

/**
 * Wrapper operations admitted after connect() is requested from inside close().
 * They share one FIFO so no operation can target the still-live old session or
 * overtake a user/control publish while the replacement queue is committed.
 */
type DeferredReplacementOperation =
  | {
      kind: "user";
      localId: string;
      text: string;
      receiptKey: string;
    }
  | { kind: "approval-decision"; id: string; decision: ApprovalDecision }
  | { kind: "load-history"; before?: string; limit?: number }
  | { kind: "load-commands" };

function normalizeAssistantMessageIndex(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}
// P1-9: the client-side mirror of core's abort predicate (§3.3). Intentionally
// NOT re-exported from the public barrel; imported directly here and by the
// plugin-side contract test.
import { isLikelyAbortText, isExplicitStop } from "./abort-mirror.js";

// ---------------------------------------------------------------------------
// WebChannel NATS Client
// ---------------------------------------------------------------------------

/**
 * NATS-based WebChannel client.
 *
 * Uses per-peer NATS subjects for browser messaging.
 */

/**
 * Canonical constructor options for `WebChannelNATSClient` — the public type a
 * consumer should annotate its config with. `url` and `jwt` are supplied
 * through the `WebChannelOptions` aliases `natsUrl` / `bootstrapJwt`, so they
 * are Omitted from the `NatsClientOptions` half — otherwise the intersection
 * would require the caller to ALSO pass a raw `url` the wrapper ignores.
 * Everything else (accountId, tenant, peerId, registration, natsCredentials,
 * reconnect tuning) is forwarded as-is.
 */
export type WebChannelNATSClientOptions = Omit<WebChannelOptions, "bootstrapJwt"> &
  Omit<DirectClientOptions, "url" | "jwt"> & {
    bootstrapJwt: string;
  };

/** Public state is additive; this wrapper's live snapshots always own the lane. */
type InitializedWebChannelState = Omit<WebChannelState, "toolActivity"> & {
  toolActivity: ToolActivityItem[];
};

export class WebChannelNATSClient {
  private readonly natsOptions: DirectClientOptions;
  private readonly client: WebChannelNatsClient;

  private state: InitializedWebChannelState = {
    messages: [],
    reasoning: [],
    toolActivity: [],
    approvals: [],
    status: "connecting",
    connected: false,
    // Learned from the register handshake; null until a register completes.
    agentProtocolVersion: null,
    agentPluginVersion: null,
  };

  private readonly listeners = new Set<Listener>();
  /** Counts public state fanouts so a staged bubble is exposed exactly once. */
  private stateNotificationSeq = 0;
  /** Receipt bubbles installed silently while their low-level send commits. */
  private readonly stagedReceiptExposures = new Set<string>();

  /**
   * P1-9: user messages HELD locally because a turn was in flight at send time
   * (the local twin of the server-side coalesce buffer). Insertion-ordered;
   * released FIFO once the turn settles AND the session key exists. Each entry's
   * `localId` is the id of its `pending: true` transcript bubble.
   */
  private readonly held: Array<{ localId: string; text: string; receiptKey: string }> = [];
  /** Every outbound operation staged for a connect requested inside close(). */
  private readonly deferredReplacementOperations: DeferredReplacementOperation[] = [];
  /** Keeps reentrant operations behind entries already staged for replacement. */
  private deferredReplacementOperationCommitDepth = 0;
  /** Prevent reentrant sends from jumping ahead of a final entry being released. */
  private heldReleaseCommitDepth = 0;
  /**
   * Explicit `/stop` is a small commit transaction. Ordinary sends created by
   * cancellation/finalization callbacks stay held until the outermost stop has
   * owned its low-level queue position; nested stops share the same transaction.
   */
  private stopCommitDepth = 0;

  /**
   * P0-4: receipt records keyed by the immutable `receiptKey`, and the
   * wireId → receiptKey routing for the low-level tracker's `onSendState`
   * transitions (a wireId is assigned at publish/release; a held send has a
   * receipt but no wireId yet).
   */
  private readonly receipts = new Map<string, ReceiptRecord>();
  private readonly wireIdToReceiptKey = new Map<string, string>();
  /** P0-4: forward rank for the receipt-level monotonic guard (incl. `completed`). */
  private static readonly RECEIPT_RANK: Record<"queued" | "sent" | "accepted" | "completed", number> = {
    queued: 0,
    sent: 1,
    accepted: 2,
    completed: 3,
  };
  /**
   * P1-9 §3.2: true only between a session KEY establishment (onSession, fired
   * after flushQueue) and the next disconnect. The release gate depends on THIS,
   * not the raw `connected` flip — at onState(true) the conversation key does not
   * exist yet, so releasing there would push held texts into the SDK outbound
   * queue (committed, ✕ gone) with nothing publishable AND ahead of the P0-7b
   * ledger replay (FIFO inversion). Cleared on every onState(false).
   */
  private sessionEstablished = false;
  /** Latest raw transport edge; true before session flush, false immediately on loss. */
  private rawTransportConnected = false;
  /** Distinguishes initial authentication from replacement-session readiness. */
  private everSessionEstablished = false;
  /** Invalidates ready-notification continuations after raw loss/close/error. */
  private wrapperLifecycleGeneration = 0;
  /** Wrapper-owned ordinary-follow-up application-stall episode. */
  private heldStallSinceAt: number | null = null;
  private heldStallRecoveryIssued = false;
  private heldStallMutationEpoch = 0;
  private heldStallTimer: ReturnType<typeof setTimeout> | null = null;
  private heldStallTimerGeneration = 0;
  /** Defers held-admission UI fanout until the first owner's timer commit ends. */
  private heldAdmissionNotificationDepth = 0;
  private heldAdmissionNotificationPending = false;
  /**
   * P0-4: true once a terminal failure has been observed (wrapper mirror of the
   * low-level `terminalReached`). PERMANENT — a terminal instance is retired
   * (CL2 contract: every terminal cause is `retryable:false`; recovery means
   * re-initializing with fresh credentials, not reviving this instance). While
   * set, `send()` must NEVER hold — a held send arriving after the terminal
   * held[] sweep would be orphaned — so holding is disabled and the send
   * publishes, resolving immediately to failed{terminal}. Symmetric with the
   * low-level `terminalReached`, which also never resets.
   */
  private terminal = false;
  /**
   * P0-4 (review): true between an explicit `close()` and the next `connect()`.
   * CONNECTION-SCOPED — the exact opposite of the permanent `terminal` latch: a
   * closed instance is reusable, so `connect()` clears this. It is the wrapper
   * mirror of the low-level `disconnected` gate (`nats-client.ts`), which fails a
   * send onto a closed instance as `failed{closed}`. The mirror is required
   * because that gate only fires for sends that actually REACH
   * `sendUserMessage()`: a send arriving while a turn is still in flight is
   * pushed into `held[]` instead, and `held[]` drains only on `onSession` — which
   * a closed instance never fires again. `close()` does not settle live `working`
   * drafts (only the terminal path does) and it clears the staleness valve, so
   * `turnInFlight()` can stay true forever after a close. Without this flag such
   * a send is stranded at `queued` — the exact failure P0-4 exists to eliminate.
   */
  private closed = false;
  /** Nested close() calls share one teardown; the latest connect/close intent wins. */
  private closeTransactionDepth = 0;
  private connectDeferredUntilCloseCompletes = false;
  /** Replacement-held work gets a fresh timer only after its new session exists. */
  private replacementHeldNeedsFreshEpisode = false;
  /**
   * P1-9 §3.6.2: post-reconnect staleness valve. `staleDraftWatch` holds the ids
   * of `working` drafts recorded when onSession fired; the timer flips any still
   * in the set to `working: false` in place (never swapping the id) after the
   * grace. Both are connection-scoped: cleared on every onState(false)/close()
   * and re-armed FRESH on every onSession, so the grace counts only connected
   * time. A draft-touching frame (progress/agent_message by id, reasoning by
   * turnId) disarms its entry — the turn is demonstrably alive.
   */
  private readonly staleDraftWatch = new Set<string>();
  private staleDraftTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly STALE_DRAFT_GRACE_MS = 30_000;
  /**
   * #96: ids of the turns THIS client started that have not settled yet (the id
   * is the publish wireId, which the plugin echoes as `turn_settled.turnId`).
   * A Set, not a boolean: several turns can be outstanding at once (a released
   * held burst, or sends that land in the quiet gaps of a running turn).
   * INSERTION ORDER IS LOAD-BEARING — it is publish order, which is what lets a
   * settle retire the whole coalesced prefix (see `closeTurnsThrough`).
   * `state.turnActive` is exactly `size > 0`.
   *
   * ADVISORY ONLY. It is read NOWHERE outside `turnActive` state construction —
   * never by `turnInFlight()`/`shouldHold()`/`maybeRelease()`, never by the
   * receipt machinery, never by the #81 held-stall detector. Widening the
   * existing `turnInFlight()` instead would have kept held follow-ups held for
   * the whole turn and made #81's 30s stall detector fire soft reconnects on
   * ordinary multi-step turns.
   */
  private readonly openTurns = new Set<string>();

  constructor(options: WebChannelNATSClientOptions) {
    this.natsOptions = {
      url: options.natsUrl ?? "wss://nats.example.com",
      jwt: options.bootstrapJwt,
      accountId: options.accountId ?? "default-account",
      tenant: options.tenant ?? "default-tenant",
      peerId: options.peerId ?? "anonymous-peer",
      registration: options.registration,
      // CL1: forward the NATS-layer NKEY credentials + reconnect tuning. A
      // production JWT-auth nats-server REQUIRES `natsCredentials` — without it
      // CONNECT ships only the bootstrap JWT with no signed nonce, the server
      // returns `-ERR Authorization Violation`, and the client enters an
      // unwinnable reconnect loop. Dropping these silently made the public
      // wrapper unusable against any real (non-open) NATS deployment.
      natsCredentials: options.natsCredentials,
      reconnectBaseMs: options.reconnectBaseMs,
      reconnectCapMs: options.reconnectCapMs,
      // CL3: forward the keepalive interval too (same drop-on-the-floor class as
      // the CL1 natsCredentials bug — the wrapper rebuilds the options object, so
      // any NatsClientOptions field it doesn't name is silently lost).
      heartbeatIntervalMs: options.heartbeatIntervalMs,
      // P1-3: forward the connect-stage deadline (same drop-on-the-floor class);
      // without this the public type advertises `connectTimeoutMs` but the low
      // level always runs its 10s default — 0 (disable) must survive too.
      connectTimeoutMs: options.connectTimeoutMs,
      // #81 application-level policy remains owned and validated by the inner
      // high-level client. Forward the caller's raw value unchanged.
      ackStallTimeoutMs: options.ackStallTimeoutMs,
      // Preserve the existing deterministic scheduler seams for wrapper-based
      // tests and embedded runtimes; the held lane uses the global clock/timer.
      _retryNow: options._retryNow,
      _retryRandom: options._retryRandom,
      _retrySetTimeout: options._retrySetTimeout,
      _retryClearTimeout: options._retryClearTimeout,
    };

    this.client = new WebChannelNatsClient(this.natsOptions);

    // Wire up message listener
    this.client.onMessage((msg: InboundMessage) => this.handleMessage(msg));

    // Wire up state listener.
    this.client.onState((connected: boolean) => {
      // Record the raw edge before any cleanup/public callout. A ws.send() seam
      // can synchronously deliver onclose yet return normally; its trailing
      // tracker `sent` must see false and consume without opening.
      this.rawTransportConnected = connected;
      const wasSessionEstablished = this.sessionEstablished;
      this.wrapperLifecycleGeneration++;
      // Raw transport is never public readiness. Invalidate the release gate
      // before timer cleanup or any wrapper state callback.
      this.sessionEstablished = false;
      if (!connected || wasSessionEstablished) this.consumeHeldStallForRawLoss();
      this.clearStaleDraftWatch();
      // P0-4: a CL2 terminal instance is PERMANENTLY retired — the onState handler
      // must not mutate status/error at all, on EITHER edge. This matters because
      // a registration-path terminal sets only the WCNC-level `terminalReached`
      // (the raw transport is NOT terminal), so a later explicit `connect()`
      // re-dials and emits `connected:true`; without this guard that would flip
      // the sticky "error" to "connected" and clear the cause while every send
      // still immediate-fails (a green status on a wedged instance). It also
      // supersedes the old one-sided (!connected && status==="error") sticky
      // guard, since `terminal` is always set whenever status is "error".
      // Recovery is a fresh client with fresh credentials, never this instance.
      if (this.terminal) return;
      // A low-level tracker can already have advanced beyond `queued` while its
      // wrapper callbacks wait behind another send-state fanout. Consume those
      // latches before the disconnect sweep so an earlier delayed `sent` cannot
      // resurrect a turn afterward (even if the latest snapshot is `failed`).
      // Truly queued work remains eligible after reconnect publication.
      if (!connected) this.consumeAdvancedTurnOpeningsAcrossDisconnect();
      // #96: a raw loss ends every turn this client was tracking — the same
      // reason it force-clears isTyping.
      //
      // NOT symmetric with isTyping, though: a later `typing` frame re-arms
      // isTyping, but a receipt whose first successful publish already opened a
      // turn has consumed its one-way opening latch. A later accepted/replay
      // transition therefore cannot re-open it after this sweep, so a transient
      // reconnect during a long multi-step turn leaves `turnActive` false for
      // the REST of that turn. A still-queued, never-published receipt retains
      // its latch and may open for the first time after reconnect.
      const turnsCleared = !connected && this.clearOpenTurns();
      this.setState({
        status: this.everSessionEstablished ? "reconnecting" : "connecting",
        connected: false,
        ...(!connected ? { isTyping: false } : {}),
        ...(turnsCleared ? { turnActive: false } : {}),
      });
    });

    // P1-9 §3.2/§3.6.2: session KEY established (both register-unwrap and legacy
    // handshake paths, strictly AFTER flushQueue). Open the release gate, arm the
    // staleness valve fresh, and try to release — ordered behind the ledger replay.
    this.client.onSession(() => {
      // P0-4 (R4): defense in depth — a retired instance must never open the
      // release gate, arm the staleness valve, or release, even if a stray
      // onSession somehow fired. The mid-level `onConnected` terminal guard is the
      // root fix; this makes the wrapper safe regardless.
      if (this.terminal || this.closed) return;
      const lifecycle = this.wrapperLifecycleGeneration;
      this.sessionEstablished = true;
      this.everSessionEstablished = true;
      this.setState({
        status: "connected",
        connected: true,
        error: undefined,
        errorCause: undefined,
      });
      // A public ready-state listener may synchronously close or retire this
      // lifecycle. It wins over every trailing stale-watch/release action.
      if (
        this.wrapperLifecycleGeneration !== lifecycle
        || !this.sessionEstablished || this.terminal || this.closed
        || !this.state.connected
      ) {
        return;
      }
      // A hold admitted after connect() was requested from inside close() could
      // not age against the old session. Its application-stall interval starts
      // only now, when the replacement session is authenticated and usable.
      if (this.replacementHeldNeedsFreshEpisode) {
        this.replacementHeldNeedsFreshEpisode = false;
        if (this.held.length > 0) this.beginHeldStallEpisode(true);
      }
      if (
        this.wrapperLifecycleGeneration !== lifecycle
        || !this.sessionEstablished || this.terminal || this.closed
        || !this.state.connected
      ) {
        return;
      }
      this.armStaleDraftWatch();
      if (
        this.wrapperLifecycleGeneration !== lifecycle
        || !this.sessionEstablished || this.terminal || this.closed
        || !this.state.connected
      ) {
        return;
      }
      this.maybeRelease();
    });

    // P0-4: the authoritative tracker drives every send-state transition. Route
    // it through the wireId → receiptKey alias to the receipt record + render
    // bubble. A wireId with no local receipt (a direct/internal send) is ignored.
    this.client.onSendState((wireId: string, state: SendState, failure?: SendFailure) => {
      const receiptKey = this.wireIdToReceiptKey.get(wireId);
      if (!receiptKey) return;
      // The record already starts at queued, so this is not a receipt transition.
      // It is nevertheless the first safe point to expose a silently staged
      // bubble: the low level owns A's outbound queue position before emitting it.
      if (state === "queued" && this.stagedReceiptExposures.delete(receiptKey)) {
        this.notifyStateListeners();
      }
      this.receiptTransition(receiptKey, state, failure);
    });

    // CL2: surface a TERMINAL failure to the embedder. The underlying client
    // fires onError for non-retryable failures — a failed PoP registration or an
    // authoritative NATS auth rejection (`-ERR Authorization Violation`, expired
    // creds) — and has stopped reconnecting. We move to the terminal `"error"`
    // status with a reason so the app can prompt for fresh credentials instead
    // of showing an eternal reconnect spinner.
    this.client.onError((err: Error, cause?: WebChannelErrorCause) => {
      console.error("[nats-wrapper] terminal connection error:", err);
      // P0-4: mark terminal BEFORE failing held[] so a re-entrant send from a
      // receipt subscriber during the sweep does NOT hold (shouldHold is gated on
      // this) — it publishes and resolves immediately to failed{terminal}.
      this.terminal = true;
      this.connectDeferredUntilCloseCompletes = false;
      this.replacementHeldNeedsFreshEpisode = false;
      this.wrapperLifecycleGeneration++;
      const deferredEntries = this.deferredReplacementOperations.splice(0);
      // P0-4 (D5 held/terminal): the queued/ledgered sends were already swept to
      // failed{terminal} by the low-level terminal sequence BEFORE this listener
      // ran; fail the wrapper-owned held[] here (they have no wireId, so the sweep
      // could not reach them). Retracted bubbles are preserved by failHeld.
      this.failHeld({ reason: "terminal", cause: cause ?? "unknown", retryable: false });
      this.failDeferredReplacementOperations(
        deferredEntries,
        { reason: "terminal", cause: cause ?? "unknown", retryable: false },
      );
      // P0-4 (R4): settle the live-turn UI in the SAME terminal update. A terminal
      // mid-turn otherwise leaves an eternal "typing…" (or a spinning `working`
      // draft): the gated onState(false) skips the normal cleanup, and the
      // staleness valve only arms on a reconnect this retired instance never does.
      // Flip isTyping off and every `working` draft to `working:false` in place
      // (id/text untouched — the /stop idiom), atomically with the error status so
      // there is no intermediate flicker. Does NOT touch status/error semantics.
      let draftsSettled = false;
      const settledMessages = this.state.messages.map((m) => {
        if (m.working) {
          draftsSettled = true;
          this.staleDraftWatch.delete(m.id);
          return { ...m, working: false };
        }
        return m;
      });
      // #96: a retired instance can never see another `turn_settled`, so every
      // open turn ends here too — in the SAME atomic update as isTyping.
      const turnsCleared = this.clearOpenTurns();
      // P1-7: carry the machine-readable cause onto state so the embedder picks
      // truthful wording + the right recovery affordance. A classified emit site
      // supplies its cause; an unclassified failure falls back to "unknown".
      this.setState({
        status: "error",
        connected: false,
        error: err.message,
        errorCause: cause ?? "unknown",
        isTyping: false,
        ...(turnsCleared ? { turnActive: false } : {}),
        ...(draftsSettled ? { messages: settledMessages } : {}),
      });
    });

    // Register-handshake outcome: surface the agent-plugin's protocol/plugin
    // version on state for diagnostics (admin screen). A version MISMATCH never
    // arrives here — it flows through onError above as a terminal failure.
    this.client.onProtocol(({ protocolVersion, pluginVersion }) => {
      this.setState({
        agentProtocolVersion: protocolVersion,
        agentPluginVersion: pluginVersion,
      });
    });
  }

  /** Get current state */
  getState(): WebChannelState {
    return this.state;
  }

  /** Subscribe to state changes */
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Connect to NATS */
  connect(): void {
    // P0-4 (review): a reconnect reopens the send path — clear the closed gate so
    // holding resumes. Mirrors `WebChannelNatsClient.connect()`, which clears its
    // own `disconnected` flag; the ordering mirrors it too — that method REFUSES
    // outright on a terminally-retired instance, so a retired wrapper must stay
    // closed rather than silently re-enable holding onto a dead instance.
    if (!this.terminal) {
      this.closed = false;
      if (this.closeTransactionDepth > 0) {
        // The old raw socket has not been disconnected yet. Record the reopen
        // intent, but never let this connect (or sends following it) target that
        // socket; the outermost close replays it after teardown completes.
        this.connectDeferredUntilCloseCompletes = true;
        return;
      }
    }
    this.client.connect();
  }

  /** Disconnect from NATS */
  close(): void {
    // P0-4 (review): gate holding FIRST — a send arriving after this close (or
    // re-entrantly, from a listener the sweep below fires) must publish and
    // resolve to failed{closed} via the low-level `disconnected` gate, never land
    // in `held[]` whose only drain (onSession) this instance will never fire.
    this.closed = true;
    // A later nested close overrides an earlier deferred connect. A connect
    // occurring from one of THIS close's callouts can set the intent again.
    this.connectDeferredUntilCloseCompletes = false;
    this.wrapperLifecycleGeneration++;
    this.closeTransactionDepth++;
    try {
      // Detach only this lifecycle's wrapper ownership before any timer or raw
      // teardown callout. Work created after a reentrant connect is replacement
      // ownership and remains in the live collections.
      const deferredEntries = this.deferredReplacementOperations.splice(0);
      const heldEntries = this.takeHeld();
      // P1-9: tear down the connection-scoped staleness valve (§3.6.2).
      this.clearStaleDraftWatch();
      // #96: this lifecycle will never see another `turn_settled`. Clear its
      // turns before raw teardown, but delay the public flip until disconnect()
      // has completed so no state listener can reopen onto the old socket.
      const turnsCleared = this.clearOpenTurns();
      this.client.disconnect();
      // Replacement operations admitted by a disconnect callback have not been
      // published yet, so an empty set still belongs solely to the old lifecycle.
      if (turnsCleared && this.openTurns.size === 0) {
        this.setState({ turnActive: false });
      }
      // Notify only the detached old lifecycle after raw teardown. Reentrant
      // replacement work cannot be consumed by either failure sweep.
      this.failDeferredReplacementOperations(
        deferredEntries,
        { reason: "closed", retryable: false },
      );
      this.failHeldEntries(heldEntries, { reason: "closed", retryable: false });
    } finally {
      this.closeTransactionDepth--;
      if (this.closeTransactionDepth === 0) this.finishDeferredCloseConnect();
    }
  }

  /** True only for the replacement lifecycle opened from an active close(). */
  private deferredReplacementOpen(): boolean {
    return this.closeTransactionDepth > 0
      && this.connectDeferredUntilCloseCompletes
      && !this.closed
      && !this.terminal;
  }

  /**
   * Finish the latest connect intent after the old inner lifecycle is completely
   * torn down. Staged controls are then committed live/FIFO into the new inner
   * queue; callbacks that publish during the drain append behind existing work.
   */
  private finishDeferredCloseConnect(): void {
    const shouldConnect = this.connectDeferredUntilCloseCompletes
      && !this.closed
      && !this.terminal;
    this.connectDeferredUntilCloseCompletes = false;

    if (!shouldConnect) {
      const stranded = this.deferredReplacementOperations.splice(0);
      if (stranded.length > 0) {
        this.failDeferredReplacementOperations(
          stranded,
          this.terminal
            ? {
                reason: "terminal",
                cause: this.state.errorCause ?? "unknown",
                retryable: false,
              }
            : { reason: "closed", retryable: false },
        );
      }
      return;
    }

    this.deferredReplacementOperationCommitDepth++;
    try {
      // Own the commit transaction BEFORE connect(): an injected WebSocket
      // factory or synchronous onState callback may emit wrapper operations
      // during the dial. They must append behind the already-staged FIFO, never
      // enter the inner queue ahead of it.
      this.client.connect();
      while (this.deferredReplacementOperations.length > 0) {
        if (this.closed || this.terminal) {
          const entries = this.deferredReplacementOperations.splice(0);
          this.failDeferredReplacementOperations(
            entries,
            this.terminal
              ? {
                  reason: "terminal",
                  cause: this.state.errorCause ?? "unknown",
                  retryable: false,
                }
              : { reason: "closed", retryable: false },
          );
          break;
        }
        this.commitDeferredReplacementOperation(
          this.deferredReplacementOperations.shift()!,
        );
      }
    } finally {
      this.deferredReplacementOperationCommitDepth--;
    }
  }

  /**
   * Send user message. Returns a `SendReceipt` (P0-4) for observing the send's
   * terminal outcome — source-compatible with the old `void` return (callers may
   * ignore it). `undefined` ONLY for trimmed-empty input (R2b-3): no bubble, no
   * tracker mutation, no fabricated receipt.
   */
  send(text: string): SendReceipt | undefined {
    const trimmed = text.trim();
    if (!trimmed) return undefined;

    // P1-9 §3.3: abort-shaped text ALWAYS bypasses the hold. Holding an abort
    // deadlocks (the hold waits for the settle, the settle needs the abort);
    // releasing it later aborts the WRONG turn (the user's own just-started
    // follow-up, or a turn another device started). The server control lane
    // stays the single authority on what an abort DOES — we only ensure the text
    // reaches it immediately. An explicit `/stop` additionally retracts the held
    // messages (§3.4: "stop means stop everything, including what I queued"); NL
    // abort words leave held entries intact (mirroring the server, where only the
    // explicit command clears the buffer).
    if (isLikelyAbortText(trimmed)) {
      if (isExplicitStop(trimmed)) {
        this.stopCommitDepth++;
        let stopCommitted = false;
        try {
          // Snapshot the stop boundary before cancellation/finalization fanout:
          // every existing candidate is stopped one-way, while a follow-up that
          // a cancellation listener creates belongs after /stop and stays
          // eligible.
          this.consumeAllTurnOpenings();
          this.markHeldRetracted();
          // §3.4: /stop means "stop everything". Also locally finalize the live
          // turn-in-flight state (working drafts AND the typing indicator) so the
          // composer unwedges even when a turn dies WITHOUT a disconnect (agent
          // dies with the socket alive) — the staleness valve only arms on
          // reconnect, so without this /stop cannot rescue a socket-alive wedge.
          // Covers both a working-draft hang and a pre-first-token typing-only
          // hang. NL abort words do NOT call this.
          this.finalizeLocalTurnState();
          // #96: control-lane text — the plugin dispatches it with
          // `controlLane: true`, which sets `settlementEligible = false`, so this
          // publish never receives a `turn_settled` and must NOT open a turn.
          const receipt = this.publish(trimmed, false);
          stopCommitted = true;
          return receipt;
        } finally {
          this.stopCommitDepth--;
          // A failed outer publish must not release replacements ahead of a stop
          // that never committed. A nested stop never drains while its outer
          // transaction is still active.
          if (this.stopCommitDepth === 0 && stopCommitted) this.maybeRelease();
        }
      }
      // Control-lane text is a real published user message → a normal receipt.
      // #96: NL abort words route onto the control lane exactly like `/stop`
      // (`isControlLaneMessage` uses the FULL abort vocabulary, of which this
      // client mirror is a subset), so this publish never settles either.
      return this.publish(trimmed, false);
    }

    // P1-9 §3.1: hold while a turn is in flight OR anything is already held. The
    // `held.length > 0` latch preserves FIFO across a disconnect (onState(false)
    // forces isTyping:false, so without the latch a send during the reconnect
    // window would publish ahead of an earlier held message).
    if (this.shouldHold()) {
      const receiptKey = this.newReceiptKey();
      const localId = `u-${this.uid()}`;
      const heldEntry = { localId, text: trimmed, receiptKey };
      this.held.push(heldEntry);
      if (this.deferredReplacementOpen()) {
        this.replacementHeldNeedsFreshEpisode = true;
      }
      // P0-4: a held send has a receipt (queued) but NO wireId yet — the wireId
      // is minted at release (2-phase). The receiptKey is the stable handle.
      this.receipts.set(receiptKey, {
        id: receiptKey,
        settlementEligible: true,
        turnOpeningConsumed: false,
        state: "queued",
        subscribers: new Set(),
        pendingTransitions: [],
        drainingTransitions: false,
      });
      // Install A's bubble silently before the timer callout, then expose the
      // entire nested admission transaction only after the outer timer/episode
      // commit finishes. A synchronous setTimeout hook that sends B therefore
      // preserves both UI and ownership order A,B and cannot expose a timerless
      // intermediate state.
      this.heldAdmissionNotificationDepth++;
      try {
        this.appendMessage({
          id: localId, role: "user", text: trimmed, pending: true, receiptKey, sendState: "queued",
        });
        this.ensureHeldStallEpisode();
      } finally {
        this.heldAdmissionNotificationDepth--;
        if (
          this.heldAdmissionNotificationDepth === 0
          && this.heldAdmissionNotificationPending
        ) {
          this.heldAdmissionNotificationPending = false;
          this.notifyStateListeners();
        }
      }
      return this.makeReceipt(receiptKey);
    }

    // #96: an ordinary user message — the plugin runs it as a normal turn and
    // answers with `turn_settled`, so its first `sent`/`accepted` transition can
    // open a turn.
    return this.publish(trimmed, true);
  }

  /**
   * P1-9 retraction. Accepts a PENDING (still held) or a RETRACTED (/stop-marked)
   * bubble by id: removes it from `held[]` (pending case) and from the transcript,
   * returns true. Any other id (a normal sent bubble, an agent bubble, unknown) →
   * false, no-op. No race with release: both run on the single JS thread and
   * release flips `pending` off synchronously before any user event observes it.
   */
  retract(id: string): boolean {
    const msg = this.state.messages.find((m) => m.id === id);
    if (!msg || (msg.pending !== true && msg.retracted !== true)) return false;
    const hi = this.held.findIndex((h) => h.localId === id);
    if (hi !== -1) {
      this.held.splice(hi, 1);
      if (this.held.length === 0) this.endHeldStallEpisode();
    }
    this.setState({ messages: this.state.messages.filter((m) => m.id !== id) });
    // P0-4 (R3-4): a cancel is still a terminal RECEIPT outcome even though the
    // render bubble is gone. The receipt record outlives the bubble, so
    // snapshot()/subscribe() report failed{cancelled} rather than a stuck queued.
    // A second retract of an already-cancelled bubble is a receipt no-op (guard).
    if (msg.receiptKey) {
      this.receiptTransition(msg.receiptKey, "failed", { reason: "cancelled", retryable: false });
    }
    return true;
  }

  /**
   * Publish a user message immediately — today's send path. Extracted so both the
   * no-hold and the abort-bypass branches share it (§3.1/§3.3).
   *
   * P0-4 commit order (D4): reserve the wire id, register the receipt record +
   * alias + render bubble SILENTLY, then let `sendUserMessage` own A's outbound
   * queue position before any state callback can synchronously send B. The queued
   * low-level event exposes the staged bubble; if that event is itself delayed by
   * a nested event drain, the commit helper exposes it once before returning.
   *
   * `settlementEligible` (#96) says whether the plugin will answer this publish
   * with a `turn_settled` — false for the two abort branches of `send()`, whose
   * text the server routes onto the control lane. The CALLER already knows which
   * branch it is; publish must never re-sniff the text.
   */
  private publish(trimmed: string, settlementEligible: boolean): SendReceipt {
    if (this.shouldDeferReplacementOperation()) {
      return this.deferReplacementPublish(trimmed, settlementEligible);
    }
    const receiptKey = this.newReceiptKey();
    const wireId = this.client.reserveWireId();
    this.wireIdToReceiptKey.set(wireId, receiptKey);
    this.receipts.set(receiptKey, {
      id: receiptKey,
      wireId,
      settlementEligible,
      turnOpeningConsumed: false,
      state: "queued",
      subscribers: new Set(),
      pendingTransitions: [],
      drainingTransitions: false,
    });
    const bubble: ChatMessage = {
      id: `u-${this.uid()}`,
      role: "user",
      text: trimmed,
      wireId,
      turnId: wireId,
      receiptKey,
      sendState: "queued",
    };
    this.stageReceiptStateThenCommit(
      receiptKey,
      { messages: [...this.state.messages, bubble] },
      () => { this.client.sendUserMessage(trimmed, wireId); },
    );
    return this.makeReceipt(receiptKey);
  }

  // ---------------------------------------------------------------------------
  // #96 — turn-scoped "this turn is still open" signal (`state.turnActive`)
  // ---------------------------------------------------------------------------
  //
  // Opening/closing helpers mutate the open-turn set and report whether
  // `state.turnActive` must change; settlement placement is frozen separately
  // before reducer callouts. That lets each caller fold the flip into the state
  // patch it was already emitting rather than emitting a second one.
  //
  // That folding is per-CALLER, not a global atomicity claim: a reducer that
  // already emits several patches still emits several. `turn_settled{error}` is
  // the case to know about — its `promoteAnchor` fans out the anchor's
  // `failed{turn-failed}` bubble patch first (P0-4 requires the outcome to commit
  // before any UI settlement callout), so the `turnActive` flip lands in the
  // FOLLOWING fanout alongside `isTyping:false`. Both are consistent snapshots;
  // there is simply no single frame that carries the whole settle.

  /**
   * Consume a receipt's one chance to open its turn on the first authoritative
   * `sent`/`accepted` transition. `queued` is only client ownership; it can sit
   * pre-connect without ever reaching the wire. The one-way latch prevents a
   * later ack/replay from reopening a turn that a disconnect safety sweep closed.
   * Control-lane publishes are consumed without opening because they never emit
   * `turn_settled`; retired/closed instances likewise cannot start a live turn.
   */
  private openTurnFromReceipt(
    receipt: ReceiptRecord,
    state: NonNullable<ChatMessage["sendState"]>,
  ): boolean {
    if ((state !== "sent" && state !== "accepted") || receipt.turnOpeningConsumed) {
      return false;
    }
    receipt.turnOpeningConsumed = true;
    if (
      !receipt.settlementEligible
      || !receipt.wireId
      || !this.rawTransportConnected
      || this.terminal
      || this.closed
    ) {
      return false;
    }
    this.openTurns.add(receipt.wireId);
    return this.state.turnActive !== true;
  }

  /**
   * A settle can race ahead of the wrapper's authoritative publish callback
   * (notably an outcome-less legacy settle from a synchronous transport seam).
   * Consume every local settlement-eligible candidate through the named id in
   * publish order before any settlement callout, so a delayed `sent`/`accepted`
   * event cannot open work that has already ended.
   */
  private consumeTurnOpeningsThrough(
    turnId: string | undefined,
  ): TurnSettlementPlacement | undefined {
    if (!turnId) return undefined;
    const targetKey = this.wireIdToReceiptKey.get(turnId);
    const target = targetKey ? this.receipts.get(targetKey) : undefined;
    if (!target?.settlementEligible) return undefined;

    // The normal path needs only the live Set prefix. It avoids rescanning the
    // lifetime-retained wire map on every settle (which would make N sequential
    // turns O(N²)), and freezing the prefix here keeps it stable across the
    // synchronous outcome/subscriber fanout before `closeTurnsThrough` runs.
    if (this.openTurns.has(turnId)) {
      const openPrefix: string[] = [];
      for (const openTurnId of this.openTurns) {
        openPrefix.push(openTurnId);
        if (openTurnId === turnId) break;
      }
      return { openPrefix };
    }

    // Consumed + absent means an old replay (or safety-cleared turn) and must
    // remain a no-op. Only the rare settle-before-sent case needs publish-order
    // placement from the retained wire map.
    if (target.turnOpeningConsumed) return undefined;
    const openPrefix: string[] = [];
    for (const [wireId, receiptKey] of this.wireIdToReceiptKey) {
      const receipt = this.receipts.get(receiptKey);
      if (receipt?.settlementEligible) receipt.turnOpeningConsumed = true;
      if (this.openTurns.has(wireId)) openPrefix.push(wireId);
      if (wireId === turnId) break;
    }
    return { openPrefix };
  }

  /** Consume every candidate that exists at an explicit-stop boundary. */
  private consumeAllTurnOpenings(): void {
    for (const receipt of this.receipts.values()) {
      if (receipt.settlementEligible) receipt.turnOpeningConsumed = true;
    }
  }

  /**
   * Consume non-queued low-level outcomes whose wrapper callbacks are delayed
   * across a raw disconnect. Queued candidates deliberately survive for replay.
   */
  private consumeAdvancedTurnOpeningsAcrossDisconnect(): void {
    for (const receipt of this.receipts.values()) {
      if (!receipt.settlementEligible || receipt.turnOpeningConsumed || !receipt.wireId) continue;
      const tracked = this.client.getSendStateSnapshot(receipt.wireId);
      // A failed snapshot can still have an earlier `sent` event waiting in the
      // global FIFO (for example sent→failed{evicted}). Consume every advanced
      // state, not just success, or that stale sent event could open after loss.
      if (tracked && tracked.state !== "queued") {
        receipt.turnOpeningConsumed = true;
      }
    }
  }

  /**
   * Close a settled turn AND every turn opened before it (insertion order).
   *
   * Turns are NOT 1:1 with publishes. The agent buffers messages that arrive
   * while a turn runs and merges them: `inbound-queue.ts`
   * `coalesceUserMessages` folds N buffered messages into one turn keyed by the
   * LAST id (`messages[messages.length - 1].id`). The current plugin emits one
   * same-outcome `turn_settled` per member, in arrival order with that anchor
   * last. Exact-id receipt promotion handles the normal path. The prefix sweep
   * here remains necessary when an earlier member frame is lost/missing and for
   * older anchor-only v3 plugin builds; without
   * it an earlier wireId could sit in `openTurns` forever on a healthy
   * connection, a permanent false "still working".
   *
   * The session's work is processed in publish order and coalescing only ever
   * merges FORWARD, so a settle for `w3` proves every turn published before `w3`
   * has been subsumed by it or already settled. `Set` iterates in insertion
   * order, which is publish order here, so sweeping the prefix is exactly that
   * proof. The prefix is frozen before outcome fanout, so synchronous receipt
   * subscribers cannot move the boundary or make a later turn eligible to close.
   *
   * A known local target whose settle raced its first publish callback is also
   * placeable: its consume helper uses the wire-id map once to capture the
   * already-open prefix even though the target itself has not entered
   * `openTurns`. Normal settles never rescan that lifetime-retained map. An
   * unknown/other-device id or a consumed, already-closed replay remains a
   * no-op; neither may retire live work this frame cannot place.
   */
  private closeTurnsThrough(
    placement: TurnSettlementPlacement | undefined,
  ): boolean {
    if (!placement) return false;
    for (const wireId of placement.openPrefix) {
      this.openTurns.delete(wireId);
    }
    return this.openTurns.size === 0 && this.state.turnActive === true;
  }

  /**
   * Close exactly one turn whose send can no longer produce one. Used only by
   * the terminal-`failed` receipt hook (see `receiptTransition`): unlike a
   * settle, a failure says nothing about the turns published around it, so this
   * never sweeps the prefix.
   */
  private closeTurn(turnId: string | undefined): boolean {
    if (!turnId || !this.openTurns.delete(turnId)) return false;
    return this.openTurns.size === 0 && this.state.turnActive === true;
  }

  /**
   * Safety-point sweep: close EVERY open turn. Used by exactly the sites that
   * already force-clear `isTyping` (disconnect, terminal, `close()`, explicit
   * `/stop`, the post-reconnect staleness valve) — a lost `turn_settled` must
   * degrade to a missing signal, never a stuck one.
   */
  private clearOpenTurns(): boolean {
    if (this.openTurns.size === 0) return false;
    this.openTurns.clear();
    return this.state.turnActive === true;
  }

  /**
   * Stage an immediate/control send for the replacement lifecycle. Ownership is
   * installed before exposing the bubble, so a nested close can detach and fail
   * it without leaving a queued receipt behind.
   */
  private deferReplacementPublish(
    trimmed: string,
    settlementEligible: boolean,
  ): SendReceipt {
    const receiptKey = this.newReceiptKey();
    const localId = `u-${this.uid()}`;
    this.deferredReplacementOperations.push({
      kind: "user", localId, text: trimmed, receiptKey,
    });
    this.receipts.set(receiptKey, {
      id: receiptKey,
      settlementEligible,
      turnOpeningConsumed: false,
      state: "queued",
      subscribers: new Set(),
      pendingTransitions: [],
      drainingTransitions: false,
    });
    this.appendMessage({
      id: localId,
      role: "user",
      text: trimmed,
      receiptKey,
      sendState: "queued",
    });
    return this.makeReceipt(receiptKey);
  }

  /** Preserve staged FIFO while replacement entries are being committed. */
  private shouldDeferReplacementOperation(): boolean {
    if (this.closed || this.terminal) return false;
    return this.deferredReplacementOpen()
      || this.deferredReplacementOperationCommitDepth > 0;
  }

  /** Queue an untracked operation or run it immediately on the current lifecycle. */
  private deferOrRunReplacementOperation(
    operation: Exclude<DeferredReplacementOperation, { kind: "user" }>,
  ): void {
    if (this.deferReplacementOperation(operation)) return;
    this.commitDeferredReplacementOperation(operation);
  }

  /** Reserve FIFO ownership before a public state callout when replacement-bound. */
  private deferReplacementOperation(
    operation: Exclude<DeferredReplacementOperation, { kind: "user" }>,
  ): boolean {
    if (!this.shouldDeferReplacementOperation()) return false;
    this.deferredReplacementOperations.push(operation);
    return true;
  }

  /** Hand one staged operation to the replacement inner lifecycle. */
  private commitDeferredReplacementOperation(
    entry: DeferredReplacementOperation,
  ): void {
    if (entry.kind === "approval-decision") {
      this.client.sendApprovalDecision(entry.id, entry.decision);
      return;
    }
    if (entry.kind === "load-history") {
      this.client.loadHistory(entry.before, entry.limit);
      return;
    }
    if (entry.kind === "load-commands") {
      this.client.loadCommands();
      return;
    }

    const receipt = this.receipts.get(entry.receiptKey);
    if (!receipt || receipt.state === "failed" || receipt.state === "completed") return;

    const wireId = this.client.reserveWireId();
    this.wireIdToReceiptKey.set(wireId, entry.receiptKey);
    receipt.wireId = wireId;
    const bubble = this.state.messages.find(
      (message) => message.receiptKey === entry.receiptKey,
    );
    if (bubble) {
      const messages = this.state.messages.map((message) =>
        message.receiptKey === entry.receiptKey
          ? { ...message, wireId, turnId: wireId }
          : message,
      );
      this.stageReceiptStateThenCommit(
        entry.receiptKey,
        { messages },
        () => { this.client.sendUserMessage(entry.text, wireId); },
      );
    } else {
      this.client.sendUserMessage(entry.text, wireId);
    }
  }

  /** P1-9 §3.1: a turn is in flight when the agent is typing or a draft is working. */
  private turnInFlight(): boolean {
    return this.state.isTyping === true || this.state.messages.some((m) => m.working);
  }

  /** P1-9 §3.1: hold predicate — in flight OR the latch keeps prior holds first. */
  private shouldHold(): boolean {
    // P0-4: never hold after a terminal failure (a held send would escape the
    // held[] sweep and orphan). Publish instead → immediate failed{terminal}.
    if (this.terminal) return false;
    // A connect requested from a close() callout opens the replacement wrapper
    // lifecycle before the old socket is gone. Ordinary sends belong to that
    // replacement, but must remain held until its own session is established.
    if (this.deferredReplacementOpen()) return true;
    // P0-4 (review): never hold after an explicit close() either — held[] drains
    // only on onSession, which a closed instance never fires, so a hold here is a
    // permanent `queued`. Publish instead → immediate failed{closed}.
    if (this.closed) return false;
    // Ordinary callback-created sends cannot publish during an explicit-stop
    // transaction. They release only after the outer stop owns its queue slot.
    if (this.stopCommitDepth > 0) return true;
    if (this.heldReleaseCommitDepth > 0) return true;
    return this.turnInFlight() || this.held.length > 0;
  }

  /**
   * P1-9 §3.2: release ALL held messages FIFO once the turn has settled AND the
   * session key exists (a released burst hits an idle session — the first starts
   * a turn, the rest coalesce into one follow-up, exactly as a live burst does).
   *
   * Each released bubble is published, patched `{pending:false, wireId, turnId}`,
   * AND MOVED TO THE TAIL of `state.messages` (display position = publish
   * position). Moving to the tail is load-bearing, not cosmetic: the history
   * merge assumes local order mirrors transcript order (the tier-3 probe + the
   * insertion cursor). An in-place release would order a held chip ABOVE the
   * reply it delayed while the server transcript orders it after — the next
   * snapshot would mis-adopt or duplicate. Moving to the tail makes a released
   * bubble an ordinary send in an ordinary position.
   *
   * Re-entrancy: drain `held[]` LIVE — `shift()` one entry per iteration rather
   * than snapshot-and-clear before the loop. Each staged bubble is exposed to
   * listeners synchronously after its low-level queue commit; a listener calling
   * `send()` re-entrantly must NOT jump the queue. With a live drain the still-
   * unreleased entries are genuinely present in `held[]`, so `shouldHold()`'s
   * `held.length > 0` latch holds that new message and the continuing loop takes
   * it in FIFO order. A snapshot-and-clear would leave `held[]` empty mid-loop
   * and let the re-entrant send publish AHEAD of the not-yet-released entries
   * (M1, M3, M2).
   * Two behaviors this preserves: (a) a re-entrant `retract()` of a not-yet-
   * released held item splices it out of the live array, so `shift()` never
   * reaches it — its publish is cancelled; (b) the last entry's listener calling
   * `send()` runs only AFTER that entry's `sendUserMessage` already fired, so
   * order stays correct.
   */
  private maybeRelease(): void {
    if (
      this.deferredReplacementOpen() ||
      this.stopCommitDepth > 0 ||
      this.heldReleaseCommitDepth > 0 ||
      this.held.length === 0 ||
      this.turnInFlight() ||
      !this.state.connected ||
      !this.sessionEstablished
    ) {
      return;
    }
    this.heldReleaseCommitDepth++;
    try {
      while (this.held.length > 0) {
        const heldEntry = this.held[0];
        if (this.held.length === 1) {
          // Keep the final entry explicitly wrapper-owned across timer cleanup.
          // clearTimeout is an embedder callout: close/retract/terminal must be
          // able to see and settle this entry before the stale release stack can
          // assign it a wire id. A plain reentrant send appends behind the exact
          // owner and is drained FIFO after it.
          const lifecycle = this.wrapperLifecycleGeneration;
          const receipt = this.receipts.get(heldEntry.receiptKey);
          this.endHeldStallEpisode();
          if (
            this.wrapperLifecycleGeneration !== lifecycle
            || !this.heldSessionReady()
            || this.held[0] !== heldEntry
            || this.receipts.get(heldEntry.receiptKey) !== receipt
            || receipt?.state !== "queued"
            || receipt.wireId !== undefined
          ) {
            return;
          }
        }

        // No callout exists between the exact-owner fence above and detachment.
        // For a non-final entry this is the ordinary live FIFO shift; for the
        // final entry the timer/lifecycle transaction has now committed.
        if (this.held[0] !== heldEntry) return;
        this.held.shift();
        const { localId, text, receiptKey } = heldEntry;
        // P0-4 commit order: reserve the wireId, register the alias, stage the bubble
        // at the tail, THEN let the low level own/publish A before exposing that move.
        const wireId = this.client.reserveWireId();
        this.wireIdToReceiptKey.set(wireId, receiptKey);
        const receipt = this.receipts.get(receiptKey);
        if (receipt) receipt.wireId = wireId;
        const bubble = this.state.messages.find((m) => m.id === localId);
        // A re-entrant listener may have already removed the bubble; the text is
        // still published (correct — release is a commit), so just skip the patch.
        if (bubble) {
          const messages = this.state.messages.filter((m) => m.id !== localId);
          messages.push({ ...bubble, pending: false, wireId, turnId: wireId });
          this.stageReceiptStateThenCommit(
            receiptKey,
            { messages },
            () => { this.client.sendUserMessage(text, wireId); },
          );
        } else {
          // No bubble remains to stage. The authoritative `sent`/`accepted`
          // receipt callback still opens and exposes the turn only after the
          // low-level publish succeeds; `heldReleaseCommitDepth` keeps a listener
          // reached by that fanout from jumping this entry's FIFO position.
          this.client.sendUserMessage(text, wireId);
        }
      }
    } finally {
      this.heldReleaseCommitDepth--;
    }
  }

  /**
   * P1-9 §3.4: an explicit /stop moves every held entry out of `held[]` and flips
   * its bubble to `{pending:false, retracted:true}` — KEPT in the transcript
   * (text preserved, restorable), never auto-released. Unlike the server's
   * allowlist-gated buffer drop, client-held text exists nowhere else, so we mark
   * rather than delete (A6). NL abort words do not call this.
   */
  private markHeldRetracted(): void {
    if (this.held.length === 0) return;
    const entries = this.held.splice(0);
    this.endHeldStallEpisode();
    // P0-4: /stop is a user-intentional cancel — each held receipt ends at
    // failed{cancelled,retryable:false}, and its bubble flips to the retracted
    // marker (text preserved, restorable). receiptTransition patches the bubble
    // (sendState/sendFailure) alongside the pending→retracted flip.
    for (const e of entries) {
      this.receiptTransition(
        e.receiptKey,
        "failed",
        { reason: "cancelled", retryable: false },
        { pending: false, retracted: true },
      );
    }
  }

  /**
   * P0-4 (D5): fail every wrapper-owned held[] entry with `failure` and clear the
   * hold (they can no longer release). Their bubbles flip pending→false with the
   * failed sendState/sendFailure; `retracted` bubbles (already terminal) are left
   * untouched because they carry no held entry. Used by close() and terminal error.
   */
  private failHeld(failure: SendFailure): void {
    this.failHeldEntries(this.takeHeld(), failure);
  }

  private takeHeld(): Array<{ localId: string; text: string; receiptKey: string }> {
    const entries = this.held.splice(0);
    if (entries.length > 0) {
      this.endHeldStallEpisode();
    }
    return entries;
  }

  /** Fail a detached ownership snapshot without consuming replacement holds. */
  private failHeldEntries(
    entries: readonly { localId: string; text: string; receiptKey: string }[],
    failure: SendFailure,
  ): void {
    for (const e of entries) {
      this.receiptTransition(e.receiptKey, "failed", failure, { pending: false });
    }
  }

  /** Drop detached operations and fail only those with observable receipts. */
  private failDeferredReplacementOperations(
    entries: readonly DeferredReplacementOperation[],
    failure: SendFailure,
  ): void {
    for (const entry of entries) {
      if (entry.kind !== "user") continue;
      this.receiptTransition(entry.receiptKey, "failed", failure);
    }
  }

  // ---------------------------------------------------------------------------
  // #81 — wrapper-owned held-work application liveness
  // ---------------------------------------------------------------------------

  private heldSessionReady(): boolean {
    return this.sessionEstablished
      && this.state.connected
      && !this.deferredReplacementOpen()
      && !this.closed
      && !this.terminal;
  }

  /** Start only the first owner's episode; later held sends preserve its age. */
  private ensureHeldStallEpisode(): void {
    if (
      this.client.getAckStallTimeoutMs() === 0
      || this.held.length === 0
      || this.heldStallSinceAt !== null
      || this.heldStallRecoveryIssued
    ) {
      return;
    }
    this.beginHeldStallEpisode(this.heldSessionReady());
  }

  /**
   * Replace the held interval after authenticated live-turn activity, or record
   * a non-ready hold as already covered by the connection recovery in progress.
   */
  private beginHeldStallEpisode(ready: boolean): void {
    if (this.client.getAckStallTimeoutMs() === 0 || this.held.length === 0) return;
    const lifecycleGeneration = this.wrapperLifecycleGeneration;
    const mutationEpoch = ++this.heldStallMutationEpoch;
    this.heldStallSinceAt = null;
    this.heldStallRecoveryIssued = !ready;
    const cancellationToken = this.cancelHeldStallTimer();
    if (
      this.heldStallMutationEpoch !== mutationEpoch
      || this.heldStallTimerGeneration !== cancellationToken
      || this.heldStallTimer !== null
      || this.wrapperLifecycleGeneration !== lifecycleGeneration
      || this.held.length === 0
    ) {
      return;
    }
    if (!ready || !this.heldSessionReady()) return;

    const startedAt = Date.now();
    if (
      this.heldStallMutationEpoch !== mutationEpoch
      || this.heldStallTimerGeneration !== cancellationToken
      || this.heldStallTimer !== null
      || this.wrapperLifecycleGeneration !== lifecycleGeneration
      || this.held.length === 0 || !this.heldSessionReady()
    ) {
      return;
    }
    this.heldStallSinceAt = startedAt;
    this.heldStallRecoveryIssued = false;
    this.armHeldStallTimer();
  }

  /** Null ownership before clearTimeout so reentrant scheduling always wins. */
  private cancelHeldStallTimer(): number {
    const token = ++this.heldStallTimerGeneration;
    const timer = this.heldStallTimer;
    this.heldStallTimer = null;
    if (timer !== null) clearTimeout(timer);
    return token;
  }

  private armHeldStallTimer(): void {
    const timeoutMs = this.client.getAckStallTimeoutMs();
    const cancellationToken = this.cancelHeldStallTimer();
    if (
      timeoutMs === 0
      || this.heldStallTimerGeneration !== cancellationToken
      || this.heldStallTimer !== null
      || this.held.length === 0
      || this.heldStallSinceAt === null
      || this.heldStallRecoveryIssued
      || !this.heldSessionReady()
    ) {
      return;
    }
    const mutationEpoch = this.heldStallMutationEpoch;
    const lifecycleGeneration = this.wrapperLifecycleGeneration;
    const sinceAt = this.heldStallSinceAt;
    const now = Date.now();
    if (
      this.heldStallMutationEpoch !== mutationEpoch
      || this.heldStallTimerGeneration !== cancellationToken
      || this.heldStallTimer !== null
      || this.wrapperLifecycleGeneration !== lifecycleGeneration
      || this.held.length === 0 || this.heldStallSinceAt !== sinceAt
      || this.heldStallRecoveryIssued || !this.heldSessionReady()
    ) {
      return;
    }
    const delay = Math.max(0, timeoutMs - Math.max(0, now - sinceAt));
    const generation = ++this.heldStallTimerGeneration;
    const timer = setTimeout(() => {
      if (
        this.heldStallTimerGeneration !== generation
        || this.heldStallMutationEpoch !== mutationEpoch
        || this.wrapperLifecycleGeneration !== lifecycleGeneration
        || this.held.length === 0 || this.heldStallSinceAt !== sinceAt
        || this.heldStallRecoveryIssued || !this.heldSessionReady()
      ) {
        return;
      }
      this.heldStallTimer = null;
      this.heldStallTimerGeneration++;
      this.heldStallMutationEpoch++;
      this.heldStallRecoveryIssued = true;
      this.client.requestApplicationRecovery();
    }, delay);
    if (
      this.heldStallTimerGeneration !== generation
      || this.heldStallMutationEpoch !== mutationEpoch
      || this.heldStallTimer !== null
      || this.wrapperLifecycleGeneration !== lifecycleGeneration
      || this.held.length === 0 || this.heldStallSinceAt !== sinceAt
      || this.heldStallRecoveryIssued || !this.heldSessionReady()
    ) {
      clearTimeout(timer);
      return;
    }
    this.heldStallTimer = timer;
    const unrefTimer = timer as ReturnType<typeof setTimeout> & { unref?: () => void };
    unrefTimer.unref?.();
  }

  /** Raw replacement consumes the current allowance and owns all scheduling. */
  private consumeHeldStallForRawLoss(): void {
    if (this.client.getAckStallTimeoutMs() === 0 || this.held.length === 0) return;
    this.heldStallMutationEpoch++;
    this.heldStallRecoveryIssued = true;
    this.cancelHeldStallTimer();
  }

  /** Final-owner removal retires state before any receipt/state/client callback. */
  private endHeldStallEpisode(): void {
    // Clear the retired owner's marker before canceling its timer. A synchronous
    // clearTimeout hook may connect+send replacement work and set the marker
    // again; that newer ownership must win when this method resumes.
    this.replacementHeldNeedsFreshEpisode = false;
    this.heldStallMutationEpoch++;
    this.heldStallSinceAt = null;
    this.heldStallRecoveryIssued = false;
    this.cancelHeldStallTimer();
  }

  private observeHeldTurnActivity(msg: InboundMessage, preFrameLiveTurn: boolean): void {
    if (
      !preFrameLiveTurn
      || this.held.length === 0
      || !this.heldSessionReady()
      || (
        msg.type !== "typing"
        && msg.type !== "progress"
        && msg.type !== "reasoning"
        // #97: a tool_activity frame, like reasoning, proves the turn is alive.
        && msg.type !== "tool_activity"
        && msg.type !== "agent_message"
      )
    ) {
      return;
    }
    this.beginHeldStallEpisode(true);
  }

  // ---------------------------------------------------------------------------
  // P1-9 §3.6: stale working-draft reconciliation
  // ---------------------------------------------------------------------------

  /**
   * §3.6.1: finalize any `working` draft whose turnId matches a settled turn
   * (flip `working: false` in place — id/text untouched). Settled means no more
   * upserts are coming; if `turnInFlight` drops as a result, the end-of-frame
   * `maybeRelease()` releases held messages.
   */
  private finalizeDraftsForTurn(turnId?: string): void {
    if (!turnId) return;
    let changed = false;
    const messages = this.state.messages.map((m) => {
      if (m.working && m.turnId === turnId) {
        changed = true;
        this.staleDraftWatch.delete(m.id);
        return { ...m, working: false };
      }
      return m;
    });
    if (changed) this.setState({ messages });
  }

  /**
   * §3.4: finalize the local turn-in-flight state — flip EVERY live `working`
   * draft to `working: false` in place (id/text untouched, staleness-watch entry
   * dropped) AND clear the `isTyping` indicator. Both feed `turnInFlight()`, so
   * clearing them is what actually unwedges the composer. Called only from the
   * explicit-`/stop` branch of send(): "stop everything" must unwedge
   * immediately, not wait for a `turn_settled`/final frame that may never arrive
   * (agent died with the socket alive). Covers BOTH a working-draft hang and a
   * pre-first-token typing-only hang (isTyping true, zero drafts). Same
   * self-healing invariant as the staleness valve: if the turn is actually still
   * alive, a later `typing`/`progress` frame re-sets the state it cleared.
   */
  private finalizeLocalTurnState(): void {
    let changed = false;
    const messages = this.state.messages.map((m) => {
      if (m.working) {
        changed = true;
        this.staleDraftWatch.delete(m.id);
        return { ...m, working: false };
      }
      return m;
    });
    const clearTyping = this.state.isTyping === true;
    // #96: "stop everything" includes the turn-open signal — otherwise a widget
    // would keep claiming the agent is working on a turn the user just killed
    // (no `turn_settled` is coming for an aborted turn).
    const turnsCleared = this.clearOpenTurns();
    if (!changed && !clearTyping && !turnsCleared) return;
    this.setState({
      ...(changed ? { messages } : {}),
      ...(clearTyping ? { isTyping: false } : {}),
      ...(turnsCleared ? { turnActive: false } : {}),
    });
  }

  /**
   * §3.6.2: arm the post-reconnect staleness valve FRESH — record the ids of the
   * currently-`working` drafts and start a one-shot grace timer. Called only from
   * onSession (session re-establishment), never during a healthy connection, so
   * the normal lifecycle can't trip it. Clears any prior watch/timer first.
   */
  private armStaleDraftWatch(): void {
    this.clearStaleDraftWatch();
    for (const m of this.state.messages) {
      if (m.working) this.staleDraftWatch.add(m.id);
    }
    if (this.staleDraftWatch.size === 0) return;
    this.staleDraftTimer = setTimeout(
      () => this.expireStaleDrafts(),
      WebChannelNATSClient.STALE_DRAFT_GRACE_MS,
    );
  }

  /** §3.6.2: clear the watch set AND the grace timer (connection teardown / re-arm). */
  private clearStaleDraftWatch(): void {
    this.staleDraftWatch.clear();
    if (this.staleDraftTimer) {
      clearTimeout(this.staleDraftTimer);
      this.staleDraftTimer = null;
    }
  }

  /** §3.6.2: reasoning-frame disarm — drop watched drafts belonging to `turnId`. */
  private disarmStaleDraftsByTurn(turnId: string): void {
    if (this.staleDraftWatch.size === 0) return;
    for (const m of this.state.messages) {
      if (m.turnId === turnId && this.staleDraftWatch.has(m.id)) {
        this.staleDraftWatch.delete(m.id);
      }
    }
  }

  /**
   * §3.6.2: grace expired. Any draft still in the watch set (no draft-touching
   * frame arrived across the grace) is presumed stale — flip `working: false` IN
   * PLACE (id and text untouched, so a WRONG guess self-heals: a later progress
   * upsert re-matches the id and re-flips it working, re-engaging the hold). Then
   * re-evaluate the release gate.
   */
  private expireStaleDrafts(): void {
    this.staleDraftTimer = null;
    if (this.staleDraftWatch.size === 0) return;
    let changed = false;
    const messages = this.state.messages.map((m) => {
      if (this.staleDraftWatch.has(m.id) && m.working) {
        changed = true;
        return { ...m, working: false };
      }
      return m;
    });
    // #96: the same verdict applies to the turn-open signal — the grace expired
    // with no proof of life, so stop claiming a turn is running.
    //
    // SCOPE, stated honestly: the evidence is PER-DRAFT but this sweep is
    // ALL-OR-NOTHING. One wedged draft expiring therefore also drops the signal
    // for any other turn that happens to be open, healthy or not (drafts are
    // watched by id; turns are not correlated to them at all). Accepted: the
    // error is one-sided, which is strictly better than a spinner for a turn that
    // is already dead. But be precise about the cost — unlike a swept `isTyping`,
    // which a later `typing` frame re-arms, a swept turn is NOT recoverable: its
    // receipt already consumed the one-way opening latch. A turn that was really
    // alive loses its indicator for good, and only its own settle (or a later one
    // sweeping past it) tidies the set. Swept BEFORE `maybeRelease()`, so a
    // follow-up released right here opens its own fresh turn rather than being
    // caught by this same sweep.
    const turnsCleared = this.clearOpenTurns();
    this.staleDraftWatch.clear();
    if (changed || turnsCleared) {
      this.setState({
        ...(changed ? { messages } : {}),
        ...(turnsCleared ? { turnActive: false } : {}),
      });
    }
    this.maybeRelease();
  }

  /** Send approval decision */
  decide(id: string, decision: ApprovalDecision): void {
    const operation = { kind: "approval-decision", id, decision } as const;
    // In a replacement transaction, reserve the decision's FIFO position before
    // optimistic UI fanout. A state listener may synchronously emit another
    // outbound operation; it belongs behind this already-invoked decision.
    const deferred = this.deferReplacementOperation(operation);
    this.patchApproval(id, (a) =>
      a.resolvedDecision === undefined
        ? { ...a, resolvedDecision: decision }
        : a,
    );
    if (!deferred) this.deferOrRunReplacementOperation(operation);
  }

  /** Request history page */
  loadHistory(request?: { before?: string; limit?: number }): void {
    this.deferOrRunReplacementOperation({
      kind: "load-history", before: request?.before, limit: request?.limit,
    });
  }

  /**
   * Request the slash-command discovery catalog (P0-3). The agent answers with
   * a `commands` frame that lands in `state.commands`. UI calls this the first
   * time the user types `/` (lazy discovery); repeat calls are cheap and simply
   * refresh the catalog.
   */
  loadCommands(): void {
    this.deferOrRunReplacementOperation({ kind: "load-commands" });
  }

  // ---------------------------------------------------------------------------
  // State management
  // ---------------------------------------------------------------------------

  /**
   * Public state listeners are isolated so an embedder render bug cannot abort a
   * send, a staged-bubble exposure, or a held drain midway through its FIFO commit.
   */
  private setState(patch: Partial<InitializedWebChannelState>): void {
    this.state = { ...this.state, ...patch };
    this.notifyStateListeners();
  }

  private notifyStateListeners(): void {
    if (this.heldAdmissionNotificationDepth > 0) {
      this.heldAdmissionNotificationPending = true;
      return;
    }
    this.stateNotificationSeq++;
    for (const listener of this.listeners) {
      try {
        listener(this.state);
      } catch (e) {
        console.error("[nats-wrapper] state listener threw:", e);
      }
    }
  }

  /**
   * Install a receipt bubble/update before committing its low-level send, without
   * exposing it early. The low-level queued callback normally performs the public
   * fanout after queue ownership is established. If that callback is delayed by a
   * surrounding send-state drain, expose the staged state once after commit.
   */
  private stageReceiptStateThenCommit(
    receiptKey: string,
    patch: Partial<InitializedWebChannelState>,
    commit: () => void,
  ): void {
    const notificationSeq = this.stateNotificationSeq;
    this.state = { ...this.state, ...patch };
    this.stagedReceiptExposures.add(receiptKey);
    try {
      commit();
    } finally {
      this.stagedReceiptExposures.delete(receiptKey);
      if (this.stateNotificationSeq === notificationSeq) this.notifyStateListeners();
    }
  }

  private appendMessage(message: ChatMessage): void {
    this.setState({ messages: [...this.state.messages, message] });
  }

  private upsertReasoning(item: ReasoningItem): void {
    const current = this.state.reasoning;
    const idx = current.findIndex((entry) => entry.id === item.id);
    const next = idx === -1
      ? [...current, item]
      : current.map((entry, i) => (i === idx ? item : entry));
    this.setState({ reasoning: next.slice(-100) });
  }

  // #97: upsert a tool-activity item by turn-scoped `(turnId, id)`. A later
  // sparse lifecycle frame refines the same call without erasing name/argKeys
  // learned at start. Bounded like `reasoning`; ephemeral, NOT cleared on
  // turn_settled (a live-not-durable surface).
  private upsertToolActivity(item: ToolActivityItem): void {
    const current = this.state.toolActivity;
    const idx = current.findIndex(
      (entry) => entry.turnId === item.turnId && entry.id === item.id,
    );
    const next = idx === -1
      ? [...current, item]
      : current.map((entry, i) => (i === idx ? { ...entry, ...item } : entry));
    this.setState({ toolActivity: next.slice(-100) });
  }

  private upsertMessage(
    id: string,
    update: (prev: ChatMessage) => ChatMessage,
    fallback: ChatMessage,
  ): void {
    const messages = this.state.messages;
    const idx = messages.findIndex((m) => m.id === id);
    if (idx === -1) {
      this.setState({ messages: [...messages, fallback] });
      return;
    }
    const next = messages.slice();
    next[idx] = update(next[idx]);
    this.setState({ messages: next });
  }

  private patchApproval(
    id: string,
    update: (prev: ApprovalRequest) => ApprovalRequest,
  ): void {
    this.setState({
      approvals: this.state.approvals.map((a) => (a.id === id ? update(a) : a)),
    });
  }

  private uid(): string {
    return `${this.seq++}`;
  }

  private seq = 0;

  // ---------------------------------------------------------------------------
  // P0-4 — receipt records + send-state projection (D5)
  // ---------------------------------------------------------------------------

  /** Dedicated counter so receiptKeys never perturb the `u-`/`a-` bubble id sequence. */
  private receiptSeq = 0;
  private newReceiptKey(): string {
    return `r-${this.receiptSeq++}`;
  }

  /** A thin observable view over the receiptKey-keyed record (no state duplication). */
  private makeReceipt(receiptKey: string): SendReceipt {
    return {
      id: receiptKey,
      snapshot: () => this.receiptSnapshot(receiptKey),
      subscribe: (cb) => {
        const rec = this.receipts.get(receiptKey);
        if (!rec) return () => {};
        rec.subscribers.add(cb);
        return () => { rec.subscribers.delete(cb); };
      },
    };
  }

  /**
   * Read the wrapper projection unless the low tracker has already reached a
   * later state whose callback is merely waiting in the global FIFO drain. This
   * is a read-only overlay: bubbles and receipt subscribers still transition
   * through `receiptTransition` in serialized event order.
   *
   * While this receipt's own transition is fanning out, its record remains the
   * snapshot authority so every subscriber sees the event it was passed. The
   * wrapper-only terminal outcomes (`completed` and `failed`, including
   * `turn-failed`) likewise outrank the low tracker's accepted/sent projection.
   * A held receipt has no wire id and therefore remains queued.
   */
  private receiptSnapshot(receiptKey: string): ReturnType<SendReceipt["snapshot"]> {
    const rec = this.receipts.get(receiptKey);
    // A record always exists for a receipt we handed out; the fallback keeps the
    // type total. Records are intentionally retained across adoption/retraction.
    if (!rec) return { state: "failed" };

    const wrapperState = rec.state;
    const wrapperSnapshot = { state: wrapperState, failure: rec.failure };
    if (
      rec.drainingTransitions ||
      wrapperState === "failed" ||
      wrapperState === "completed" ||
      !rec.wireId
    ) {
      return wrapperSnapshot;
    }

    const tracked = this.client.getSendStateSnapshot(rec.wireId);
    if (!tracked) return wrapperSnapshot;
    if (
      tracked.state === "failed" ||
      WebChannelNATSClient.RECEIPT_RANK[tracked.state] > WebChannelNATSClient.RECEIPT_RANK[wrapperState]
    ) {
      return tracked;
    }
    return wrapperSnapshot;
  }

  /** Monotonic receipt guard (wrapper-level, incl. `completed`): queued<sent<accepted<completed; failed/completed terminal. */
  private receiptAdvances(from: ReceiptRecord["state"], to: NonNullable<ChatMessage["sendState"]>): boolean {
    if (from === to) return false;
    if (from === "failed" || from === "completed") return false; // terminal
    if (to === "failed") return true; // failable from any non-terminal state
    return WebChannelNATSClient.RECEIPT_RANK[to] > WebChannelNATSClient.RECEIPT_RANK[from];
  }

  /**
   * P0-4: apply a send-state transition to a receipt record (authoritative) and
   * mirror it onto the render bubble, enforcing the wrapper-level monotonic guard
   * (which alone knows `completed`). A bubble/state or receipt subscriber can
   * synchronously cause another transition for this same receipt, so the whole
   * guard→mutation→bubble fanout→receipt fanout transaction is drained FIFO per
   * receipt. The current event remains the authoritative snapshot until every
   * subscriber has seen it; a rejected transition touches nothing.
   */
  private receiptTransition(
    receiptKey: string,
    state: NonNullable<ChatMessage["sendState"]>,
    failure?: SendFailure,
    extraBubblePatch?: Partial<ChatMessage>,
  ): void {
    const rec = this.receipts.get(receiptKey);
    if (!rec) return;
    rec.pendingTransitions.push({ state, failure, extraBubblePatch });
    if (rec.drainingTransitions) return;

    rec.drainingTransitions = true;
    try {
      while (rec.pendingTransitions.length > 0) {
        const next = rec.pendingTransitions.shift()!;
        if (!this.receiptAdvances(rec.state, next.state)) continue;
        rec.state = next.state;
        rec.failure = next.failure;
        // Terminal outcomes consume an unpublished candidate too: a delayed
        // lower-level callback must never revive a failed/completed receipt.
        if (next.state === "failed" || next.state === "completed") {
          rec.turnOpeningConsumed = true;
        }
        // #96: publication authority lives in the low-level tracker. Fold the
        // first `sent`/`accepted` opening into this same bubble/state fanout;
        // queued ownership alone never claims that the agent has a live turn.
        const turnOpened = this.openTurnFromReceipt(rec, next.state);
        // #96: close the turn of a send whose failure is our best evidence that
        // no turn will ever settle for it (see the `overloaded` note below — it
        // is a proxy, not a proof).
        // This is the one funnel every terminal receipt outcome passes through
        // (the low-level tracker's `onSendState`, plus the wrapper's own), which
        // is why the hook lives here and not on any single emit site.
        //
        // THE RULE — do not extend this by listing more reasons. An id may be
        // removed here ONLY if no `turn_settled` can ever name it. Anything a
        // settle might still name must be left to `closeTurnsThrough`, because
        // removing it early makes that sweep's `openTurns.has(turnId)` guard fail
        // and strands EVERY earlier coalesced wireId permanently. Turns left here
        // are not leaked: they sit earlier in publish order than any later turn,
        // so the next settle sweeps them as part of its prefix — bounded, the
        // same way the control-lane residual is bounded.
        //
        // `overloaded` is the only reason we treat as clearing that bar — as the
        // best available PROXY for non-delivery, not as proof of it. The common
        // case is an ingress rejection before any turn was dispatched, and closing
        // immediately is worth having. But the agent can also reject a message it
        // already admitted: the client live-retries an unacked id on the SAME
        // healthy connection, ack delivery back to us is itself best-effort, and
        // an accepted-marker loss (a memory-only record evicted from the bounded
        // dedupe caches, or the dual-marker branch) makes that retry look fresh
        // and rejectable while its turn is already running. Then a `turn_settled`
        // DOES name this id, arriving after we removed it, and the prefix bails.
        // Accepted knowingly: that residual sits inside the bound documented on
        // `turnActive` — dropping `overloaded` from the hook would instead latch
        // every genuinely-rejected send until the same next-turn sweep, the
        // identical bound, while giving up the immediate close in the common case.
        // Two reasons that look eligible are NOT:
        //  - `turn-failed` comes FROM a settle (`outcome:"error"`), whose reducer
        //    promotes the anchor from the top — before the sweep at the bottom —
        //    so closing here would consume the settle's own id;
        //  - `evicted` is a CLIENT-side unacked-ledger cap drop. Ack loss is not
        //    delivery failure: the message may have reached the agent, been
        //    coalesced, and be the very id its turn settles under.
        // (`cancelled` and `closed` need no exclusion — a `cancelled` receipt is
        // still held and has no wireId, while a `closed` receipt becomes terminal
        // before any authoritative publish transition can open it. Neither can
        // reach an open turn, so neither is a turn-closing mechanism.)
        const turnClosed =
          next.state === "failed"
          && next.failure?.reason === "overloaded"
          && this.closeTurn(rec.wireId);
        this.patchBubbleByReceiptKey(
          receiptKey,
          {
            sendState: next.state,
            sendFailure: next.failure,
            ...(next.extraBubblePatch ?? {}),
          },
          turnOpened
            ? { turnActive: true }
            : turnClosed
              ? { turnActive: false }
              : undefined,
        );
        for (const cb of [...rec.subscribers]) {
          try {
            cb({ state: next.state, failure: next.failure });
          } catch (e) {
            console.error("[nats-wrapper] receipt subscriber threw:", e);
          }
        }
      }
    } finally {
      rec.drainingTransitions = false;
    }
  }

  /**
   * Patch the render bubble carrying `receiptKey` (a no-op if it was retracted).
   * `extraState` rides along in the SAME fanout — #96 uses it so a turn closed by
   * a terminal failure flips `turnActive` atomically with the bubble's
   * `sendState`, and still lands when the bubble itself is gone.
   */
  private patchBubbleByReceiptKey(
    receiptKey: string,
    patch: Partial<ChatMessage>,
    extraState?: Partial<InitializedWebChannelState>,
  ): void {
    const idx = this.state.messages.findIndex((m) => m.receiptKey === receiptKey);
    if (idx === -1) {
      if (extraState) this.setState(extraState);
      return;
    }
    const messages = this.state.messages.slice();
    messages[idx] = { ...messages[idx], ...patch };
    this.setState({ messages, ...(extraState ?? {}) });
  }

  /**
   * P0-4: promote the exact user bubble named by `turnId` (wireId === turnId) to
   * `completed` (outcome ok) or fail it `turn-failed` (outcome error). The method
   * keeps its historical anchor name, but the current plugin sends one frame per
   * coalesced member, so repeated exact-id promotion resolves the whole group.
   * An older anchor-only producer, or a missing member frame, leaves an unnamed
   * non-anchor receipt at `accepted`; the turn-activity prefix sweep does not
   * fabricate a receipt outcome.
   */
  private promoteAnchor(turnId: string, state: "completed" | "failed", failure?: SendFailure): void {
    const anchor = this.state.messages.find((m) => m.role === "user" && m.wireId === turnId);
    if (anchor?.receiptKey) this.receiptTransition(anchor.receiptKey, state, failure);
  }

  // ---------------------------------------------------------------------------
  // Message handling
  // ---------------------------------------------------------------------------

  private handleMessage(msg: InboundMessage): void {
    // Observe authenticated turn activity against the pre-frame live-turn latch.
    // Reducers may settle that latch or invoke public listeners, so this must be
    // the first operation for every decrypted frame.
    const preFrameLiveTurn = this.turnInFlight();
    this.observeHeldTurnActivity(msg, preFrameLiveTurn);
    this.handleFrame(msg);
    // P1-9 §3.2: every handled frame is a state transition — re-evaluate the
    // release gate after the reducer settles (a no-op when nothing is held or a
    // turn is still in flight).
    this.maybeRelease();
  }

  private handleFrame(msg: InboundMessage): void {
    switch (msg.type) {
      case "history": {
        const incoming = Array.isArray(msg.messages) ? msg.messages : [];
        if (incoming.length === 0) return;

        const existing = this.state.messages;
        const seen = new Set(existing.map((m) => m.id));

        // Phase 6 (stateless register, shared conversation key): a snapshot
        // triggered by ANY device's register — this device's reconnect or a
        // second device joining — arrives at every device mid-session on the
        // shared `.out`. Messages already rendered LIVE on this device sit in
        // state under LOCAL id namespaces while the snapshot carries the core
        // transcript's canonical ids, so plain id-dedup would duplicate them:
        //   - user sends → synthetic local echo ids (`u-<n>`);
        //   - agent replies → the plugin's live-frame ids (`webchannel-…`
        //     from nextMessageId(), or `a-<n>` when a frame had no id) — the
        //     core transcript NEVER stores that platform id, so history ids
        //     can never match live ids for agent messages either.
        // Matching happens in three tiers, in snapshot order:
        //   1. id — a message whose canonical id we already hold (a prior
        //      snapshot placed or adopted it) is a no-op;
        //   2. exact text+role — adopt the server id onto the first
        //      text-matching local bubble (covers user echoes always; covers
        //      agent replies only when live text == stored text);
        //   3. POSITIONAL (agent only) — openclaw's live reply text is NOT
        //      byte-equal to the stored transcript text (core strips metadata
        //      sections from live replies but stores the raw model output), so
        //      tier 2 can miss agent bubbles entirely. Structure saves us: an
        //      agent reply in the snapshot immediately FOLLOWS the message it
        //      answered, and that predecessor matched some local index i via
        //      tier 1/2 — so if the local message at i+1 is a live-id agent
        //      bubble, it IS this reply's live rendering; adopt onto it (and
        //      keep the canonical stored text). Chains across multi-frame
        //      replies because each adoption advances the anchor.
        // PLACEMENT of the unmatched (fresh) messages is ORDERED, not a blanket
        // prepend (#16). We carry an insertion CURSOR = the index into `next`
        // before which the next fresh message lands; every match/adoption walks
        // it to `matchedIndex + 1`. So a mid-session snapshot whose overlapping
        // prefix matches the local tail inserts its unseen suffix chronologically
        // AFTER that prefix (a turn sent from another device, or turns that
        // landed while this tab was disconnected, appear at the bottom — not the
        // top). Pagination and zero-overlap frames match nothing → the cursor
        // stays 0 → the whole page prepends in order (unchanged); initial
        // hydration into empty state inserts everything at 0 in order (unchanged).
        // A `working:true` progress draft is never an adoption target: its
        // live id must survive for the upcoming progress/final upserts.
        // Known cosmetic edge (accepted): if TWO devices send the identical
        // text near-simultaneously, text-only matching can adopt the OTHER
        // device's server id onto this device's bubble — the ids swap between
        // the two bubbles, but the bubble COUNT stays exactly right and every
        // later snapshot still dedups, so nothing duplicates or disappears.
        // P1-9 §6.3: a held (pending) or /stop-retracted user bubble is
        // LOCAL-ONLY (never on the wire, never in the transcript). It must NEVER
        // be an adoption target — a snapshot row with identical text (the same
        // text sent from another device) would otherwise steal its server id onto
        // our UNSENT bubble, and the later release would run/duplicate it. Exclude
        // both from the tier-2 text-match pool.
        const isLocalLiveId = (m: ChatMessage): boolean =>
          m.role === "user"
            ? m.id.startsWith("u-") && m.pending !== true && m.retracted !== true
            : !m.working && (m.id.startsWith("a-") || m.id.startsWith("webchannel-"));
        const adoptKey = (role: string, text: string): string => `${role} ${text}`;

        const next = existing.slice();
        const localIndexById = new Map<string, number>();
        next.forEach((m, i) => localIndexById.set(m.id, i));
        const claimed = new Set<number>();
        const adoptable = new Map<string, number[]>();
        next.forEach((m, i) => {
          if ((m.role === "user" || m.role === "agent") && isLocalLiveId(m)) {
            const key = adoptKey(m.role, m.text);
            const idxs = adoptable.get(key) ?? [];
            idxs.push(i);
            adoptable.set(key, idxs);
          }
        });

        let adopted = false;
        /**
         * Fresh (unmatched) snapshot messages, grouped by the INSERTION CURSOR
         * value in effect when each was seen — the index into `next` BEFORE
         * which they must land. We cannot splice into `next` mid-loop (that
         * invalidates every cached local index in
         * `localIndexById`/`claimed`/`adoptable`), so the placement is deferred
         * to a single rebuild after the loop. Multiple fresh messages sharing a
         * cursor keep their snapshot order (appended to the same array).
         */
        const inserts = new Map<number, ChatMessage[]>();
        /** Local index the PREVIOUS snapshot message resolved to (tier-3 anchor). */
        let anchor: number | null = null;
        /**
         * Index into `next` before which the NEXT fresh message is inserted.
         * Advances to `matchedIndex + 1` past every matched (tier 1) or adopted
         * (tier 2/3) message, so a snapshot's unseen tail lands chronologically
         * AFTER the overlapping matched prefix instead of being prepended (#16).
         */
        let cursor = 0;

        const adoptAt = (idx: number, m: { id: string; text: string; ts?: number }): void => {
          // Keep the canonical stored text on adoption, so this device
          // converges to exactly what a reloading device would render. The
          // observed live block ordinal is deliberately discarded: history
          // cannot validate or persist this run/attempt-local metadata.
          const { assistantMessageIndex: _liveOrdinal, ...adoptedMessage } = next[idx];
          next[idx] = {
            ...adoptedMessage,
            id: m.id,
            text: m.text,
            ts: m.ts,
          };
          claimed.add(idx);
          localIndexById.set(m.id, idx);
          adopted = true;
          anchor = idx;
          cursor = idx + 1;
        };

        for (const m of incoming) {
          if (!m || typeof m !== "object") continue;
          if (typeof m.id !== "string" || m.id.length === 0) continue;
          if (m.role !== "user" && m.role !== "agent") continue;
          if (typeof m.text !== "string") continue;
          if (seen.has(m.id)) {
            const li = localIndexById.get(m.id);
            anchor = li ?? null;
            // Tier-1 match: walk the cursor past this already-held message so
            // later fresh messages insert after it. An id we can't locate
            // locally (should not happen — `seen` is seeded from `next`) leaves
            // the cursor untouched.
            if (li !== undefined) cursor = li + 1;
            continue;
          }

          seen.add(m.id);
          // Tier 2: exact text+role.
          const idxs = adoptable.get(adoptKey(m.role, m.text));
          while (idxs && idxs.length > 0 && claimed.has(idxs[0])) idxs.shift();
          if (idxs && idxs.length > 0) {
            adoptAt(idxs.shift()!, m);
            continue;
          }
          // Tier 3: positional (agent replies whose live text was reformatted).
          if (m.role === "agent" && anchor !== null) {
            // P1-9 §6.3: a held (pending) or retracted user chip is local-only
            // and sits BETWEEN the anchor and the agent reply it delayed
            // (`[u2, h3(pending), A]`). The probe was hard-coded to `anchor + 1`,
            // which would land on the chip (role user) and miss `A` → the
            // snapshot row fresh-inserts → duplicate agent bubble. Skip past
            // pending/retracted bubbles (they can never correspond to a snapshot
            // row) and probe the first NON-local candidate after the anchor.
            // CURSOR MECHANICS ARE UNTOUCHED — fresh rows still insert at the
            // plain `cursor` (before a held chip is chronologically correct;
            // anything the snapshot carries predates the unpublished chip).
            let cand = anchor + 1;
            while (
              cand < next.length &&
              (next[cand].pending === true || next[cand].retracted === true)
            ) {
              cand++;
            }
            if (
              cand < next.length &&
              !claimed.has(cand) &&
              next[cand].role === "agent" &&
              isLocalLiveId(next[cand])
            ) {
              adoptAt(cand, m);
              continue;
            }
          }
          const atCursor = inserts.get(cursor) ?? [];
          atCursor.push({
            id: m.id,
            role: m.role,
            text: m.text,
            ts: m.ts,
            working: false,
          });
          inserts.set(cursor, atCursor);
          anchor = null;
        }

        if (inserts.size === 0 && !adopted) return;

        // Rebuild `next` with each fresh group spliced in at its cursor. Slot i
        // holds the messages that must precede `next[i]`; slot `next.length`
        // holds any tail appended after the last local message.
        const merged: ChatMessage[] = [];
        for (let i = 0; i <= next.length; i++) {
          const ins = inserts.get(i);
          if (ins) merged.push(...ins);
          if (i < next.length) merged.push(next[i]);
        }
        this.setState({ messages: merged });
        return;
      }

      case "keyframe": {
        // #173: an AUTHORITATIVE REPLACE, not the additive merge `history` does.
        // The plugin sends this at settlement when it detected the tool-only-turn
        // overwrite path corrupted the live view ([A,A,B]). We re-establish ground
        // truth from the transcript exactly as a fresh reload would — but only for
        // the REGION the keyframe covers. The plugin sends a tail window (<= the
        // history limit), so a device that paginated OLDER scrollback in must keep
        // it; a blanket replace would collapse the timeline to the window. The
        // keyframe does NOT merge/dedup row-by-row — it REPLACES its covered
        // region — so there is no per-bubble identity mapping to get wrong.
        const incoming = Array.isArray(msg.messages) ? msg.messages : [];

        // SENDER INPUT CONTRACT: rows carry unique ids and run oldest→newest.
        //
        // Rebuild the keyframe rows using the SAME ordered, one-bubble-per-row
        // insert the empty-state history hydration uses (working:false), so the
        // covered region equals what a reloading device would render. Same row
        // validation as the `history` reducer above, and the same guarantee it
        // gets from its own `seen` Set — scoped to what this frame BUILDS: no id
        // is rendered twice across `keptPrefix ++ rebuilt`. It does NOT extend to
        // the preserved tail, which may legitimately re-append a bubble whose row
        // the frame also carries (accepted residual cases 1 and 4 below); that
        // duplicate is the deliberate price of never deleting a send.
        //
        // That reducer seeds `seen` from EXISTING STATE, so one Set buys it both
        // halves at once. This reducer needs two, because it emits two segments:
        //  - this in-frame Set stops a frame carrying [A,B,A] from rendering A
        //    twice within `rebuilt`;
        //  - the `keptPrefix` filter below stops a row from colliding with a
        //    bubble that survives IN FRONT of `rebuilt`.
        // Both are exact-id lookups, and both matter for the same reason: a
        // duplicate ID is unrepairable afterwards. `upsertMessage` and
        // `patchBubbleByReceiptKey` patch only the FIRST match, the next
        // keyframe's anchor `findIndex` would latch the wrong occurrence and
        // mis-scope its region, and an embedder's React keys collide. Same
        // receiving-end argument as the empty-frame guard below.
        //
        // The FIRST occurrence wins. Under the contract just stated that is the
        // older copy, so a sender re-emitting a corrected row later in the same
        // frame has its correction dropped — harmless while the contract holds,
        // and the contract is what makes it a non-case.
        const rebuilt: ChatMessage[] = [];
        const seen = new Set<string>();
        for (const m of incoming) {
          if (!m || typeof m !== "object") continue;
          if (typeof m.id !== "string" || m.id.length === 0) continue;
          if (m.role !== "user" && m.role !== "agent") continue;
          if (typeof m.text !== "string") continue;
          if (seen.has(m.id)) continue;
          seen.add(m.id);
          rebuilt.push({
            id: m.id,
            role: m.role,
            text: m.text,
            ts: m.ts,
            working: false,
          });
        }

        // An empty rebuild carries no ground truth to replace anything WITH, and
        // a replace that finds no anchor wipes the timeline — so a stray or
        // fully-invalid frame would blank the screen. Guard at the RECEIVING
        // end, symmetrical with the `history` reducer's empty-frame guard above:
        // this reducer's failure mode is a white page, and that must not depend
        // on what any particular sender happens to gate on.
        if (rebuilt.length === 0) return;

        // The keyframe covers the transcript from its OLDEST row forward. Older
        // loaded history bubbles carry the SAME transcript ids, so the boundary
        // lines up: find where this keyframe's oldest row sits in the current
        // timeline.
        const oldestKfId = rebuilt[0].id;
        const anchor = this.state.messages.findIndex((m) => m.id === oldestKfId);

        // No overlap (fresh session, or the device's coverage is shorter than
        // the window) → anchor -1 → the covered region is the WHOLE timeline. It
        // happens at most once per keyframe and is accepted — but it resets
        // essentially everything on screen, so say so. The warning is emitted
        // BELOW, once `preserved` is known: bubbles the filter keeps are not
        // dropped, and a count that includes them overstates the reset.

        // Keep strictly-older scrollback the keyframe does NOT cover (everything
        // before the anchor) EXACTLY as it stands — local chips up there are left
        // in place rather than swept to the tail (a /stop chip is a permanent
        // in-timeline marker until `retract()`, so moving it rewrites history the
        // keyframe never spoke about).
        //
        // …minus any bubble whose id this frame also rebuilds. Rendered order can
        // legitimately diverge from transcript order: this reducer re-appends a
        // preserved user bubble AT THE TAIL, and once `history` has adopted that
        // bubble it carries a CANONICAL id. A later keyframe anchoring on that id
        // then finds intervening canonical rows sitting in front of the anchor —
        // in `keptPrefix` AND in `rebuilt`. No sender defect required; the
        // keyframe row is the authoritative copy, so the prefix yields.
        //
        // Chips are EXEMPT unconditionally. A bare `!seen.has(m.id)` would let a
        // frame that happened to carry a local id (`u-0`) DELETE local-only text
        // from the prefix, and nothing in this reducer may ever delete that. It
        // is also what the promise above — chips up there stay exactly as they
        // stand — actually requires.
        const keptPrefix = (anchor > 0 ? this.state.messages.slice(0, anchor) : []).filter(
          (m) => m.pending === true || m.retracted === true || !seen.has(m.id),
        );

        // PRESERVE, from the COVERED region only, user bubbles the keyframe's
        // source transcript cannot account for. THE RULE: a covered user bubble
        // is dropped only when this client holds POSITIVE EVIDENCE that its send
        // ran and therefore became transcript material — and only a settle
        // produces that evidence. Everything else is kept. Decided from this
        // client's own records — never from message text or position, and never
        // by matching a bubble to a row. Two reasons to keep:
        //
        //  (a) A held (pending) or /stop-retracted chip is LOCAL-ONLY: it was
        //      never published, so no transcript can contain it, and its text
        //      exists nowhere else — dropping it destroys user input. Neither
        //      flag can appear on a published bubble (`publish` sets neither, and
        //      only held entries are ever flipped to `retracted`).
        //
        //  (b) A published send with no evidence that it ran. That covers a send
        //      still in flight (`queued`/`sent`/`accepted`), a #96 control-lane
        //      publish (`/stop` and the NL abort vocabulary) which sticks at
        //      `accepted` for the life of the session, and a FAILED one
        //      (`overloaded`/`closed`/`terminal`/`evicted`/`cancelled`) — a
        //      failure is simply one more case with no evidence of a run, and
        //      dropping it would delete the user's text along with the retry
        //      affordance attached to it. A bubble with no receipt
        //      (server-hydrated, or an agent row) is not ours to keep.
        //      `settlementEligible` was the old discriminator here and is GONE:
        //      it answers "is an outcome COMING?", which is not the question.
        //      A control-lane send is permanently ineligible, yet in its normal
        //      case it never ran at all — core's fast-abort consumes it and
        //      nothing is appended (the fall-through to an ordinary agent turn
        //      is the OTHER branch of that disjunction; see the `/stop` note in
        //      `packages/plugin/src/inbound.ts`). Keying on eligibility deleted
        //      every Stop the user ever pressed.
        //
        // The two exclusions are grounded in WHERE the evidence comes from — a
        // settle — not in a list of state names: `completed` comes from
        // `turn_settled{outcome:"ok"}`, `failed{turn-failed}` from
        // `turn_settled{outcome:"error"}`. Do not extend the list with anything
        // a settle does not emit.
        //
        // ACCEPTED RESIDUAL RISK — this predicate's only failure mode is a
        // DUPLICATE bubble, never a deletion. Four sources:
        //  1. a coalesced member's `turn_settled` is lost → that send sits at
        //     `accepted` forever (`promoteAnchor` and the `turn_settled` reducer
        //     both document that state as reachable) while the keyframe carries
        //     its row;
        //  2. `overloaded` returned for a message the agent had ALREADY admitted
        //     — the live-retry of an unacked id whose accepted-marker was evicted
        //     (documented in full on the turn-closing hook in
        //     `receiptTransition`, which is where a terminal receipt outcome
        //     decides whether to close the turn);
        //  3. `evicted` is a CLIENT-side unacked-ledger cap drop, NOT evidence of
        //     non-delivery (see the `evicted` note on that same hook: the message
        //     may have reached the agent, been coalesced, and be the very id its
        //     turn settles under) — it is kept because we lack evidence either
        //     way;
        //  4. a control-lane send that fell THROUGH to an ordinary agent turn: its
        //     row is in the transcript, and no settle will ever arrive to promote
        //     it.
        // In ALL FOUR the duplicate is permanent for the life of the page: no
        // later frame removes it. `history` is additive and dedups by id, so it
        // can never delete the extra bubble; a repeat keyframe re-derives the
        // identical preserve, because the bubble's `sendState` never changes
        // again. Only a RELOAD clears it. Deliberate even so: a reload does fix a
        // duplicate, while text that never entered the transcript is gone for
        // good once deleted — not recoverable by a reload or anything else.
        //
        // Order is kept (filter is stable) and these are re-appended at the tail.
        const covered = anchor >= 0 ? this.state.messages.slice(anchor) : this.state.messages;
        const preserved = covered.filter((m) => {
          if (m.role !== "user") return false;
          // Redundant TODAY — every local chip carries a receiptKey, a pending
          // one is `queued` and a retracted one is `failed{cancelled}`, so the
          // rule below already keeps both. Kept deliberately: (a) is an
          // invariant about local-only TEXT, not a consequence of the sendState
          // rules, and must not vanish silently if those rules change.
          if (m.pending === true || m.retracted === true) return true;
          if (m.receiptKey === undefined) return false;
          // Keep unless this client holds POSITIVE evidence the send ran.
          if (m.sendState === "completed") return false;
          if (m.sendState === "failed" && m.sendFailure?.reason === "turn-failed") return false;
          return true;
        });

        // The anchor-miss reset, reported with what this reducer actually KNOWS.
        // It does NOT know what was lost: an anchor miss frequently rebuilds the
        // very ids it replaced — including the benign short-coverage case named
        // above, where the window simply reaches further back than this device
        // does and nothing goes missing at all. So report sizes, not loss.
        // `incoming` vs `rebuilt` is the other half of the diagnostic: when a
        // malformed sender is the problem, the gap between rows RECEIVED and rows
        // USABLE is what shows it. Counts only — never message text.
        if (anchor === -1 && this.state.messages.length > 0) {
          const total = this.state.messages.length;
          console.warn(
            `[nats-wrapper] keyframe anchor not found — replacing the whole timeline: ${total} rendered, ${incoming.length} row(s) received (${rebuilt.length} usable), ${preserved.length} local kept`,
          );
        }

        // Idempotent: re-applying the same keyframe re-finds the anchor at the
        // same boundary, so `keptPrefix` ends right before the oldest row and
        // `rebuilt`/`preserved` re-derive identically, yielding the same array.
        this.setState({ messages: [...keptPrefix, ...rebuilt, ...preserved] });
        return;
      }

      case "typing": {
        this.setState({ isTyping: true });
        return;
      }

      case "commands": {
        // P0-3 discovery: replace the catalog wholesale (idempotent — a repeat
        // request just refreshes it). NOT turn activity, so isTyping is left
        // untouched.
        this.setState({ commands: Array.isArray(msg.commands) ? msg.commands : [] });
        return;
      }

      case "ack": {
        // P0-4: acceptance is now driven authoritatively by the low-level
        // tracker — the same `ack` frame already advanced each matching wireId to
        // `accepted` via `onSendState` (which patched the bubble's sendState).
        // Nothing to do at the reducer level; `handleMessage` runs the release
        // gate (`maybeRelease`) AFTER this reducer returns, so the ack still
        // participates in re-evaluating held-message release.
        return;
      }

      case "inbound_rejected": {
        // The low-level client has already removed ledger entries and emitted
        // failed{overloaded}; receipt/bubble state arrives through onSendState.
        return;
      }

      case "approval_request": {
        const req: ApprovalRequest = {
          id: msg.id ?? "",
          kind: msg.kind ?? "exec",
          title: msg.title ?? "",
          description: msg.description,
          prompt: msg.prompt ?? "",
          options: (msg.options ?? []) as ApprovalOption[],
          expiresAtMs: msg.expiresAtMs,
        };

        const approvals = this.state.approvals;
        const idx = approvals.findIndex((a) => a.id === req.id);

        if (idx === -1) {
          this.setState({
            approvals: [...approvals, req],
            isTyping: false,
          });
        } else {
          // Upsert-preserve (#15): a re-delivered `approval_request` (stateless
          // register, retry) rebuilds a FRESH entry from the frame, which would
          // otherwise CLOBBER a locally-set resolution and resurrect actionable
          // buttons for an already-decided card. Carry the existing resolution
          // (and its server-confirmed flag) over the refreshed payload.
          const prev = approvals[idx];
          const next = approvals.slice();
          next[idx] =
            prev.resolvedDecision !== undefined
              ? {
                  ...req,
                  resolvedDecision: prev.resolvedDecision,
                  resolutionConfirmed: prev.resolutionConfirmed,
                }
              : req;
          this.setState({ approvals: next, isTyping: false });
        }
        return;
      }

      case "approval_resolved": {
        const id = msg.id ?? "";
        const decision = msg.decision as ApprovalDecision | undefined;
        // Server-confirmed resolution: set the decision AND mark it confirmed, so
        // the snapshot reconciler treats it as authoritative (never re-sends it
        // as a lost decision, never overwrites it with "unknown"). (#15)
        this.patchApproval(id, (a) => ({
          ...a,
          resolvedDecision: decision,
          resolutionConfirmed: true,
        }));
        return;
      }

      case "approval_snapshot": {
        // Authoritative pending-approval reconciliation (#15). The snapshot is
        // the account's COMPLETE still-pending set for this peer at publish time;
        // we reconcile local approval state against it to close three legs:
        //   A (reload lost the card) — a snapshot id with no local entry is
        //     rehydrated as pending;
        //   B (missed approval_resolved) — a local unresolved card ABSENT from
        //     the snapshot was decided/expired elsewhere → mark it non-actionable.
        //     If the snapshot's `resolved` set (#19) carries the actual outcome,
        //     show that decision; otherwise (aged out of the server's resolved
        //     ring) fall back to the "unknown" sentinel. Either way confirmed.
        //   C (lost decision frame) — a locally-decided but NOT server-confirmed
        //     card the snapshot STILL lists as pending → the decision frame was
        //     lost; re-send it and keep the card resolved (every future register
        //     retries until the server confirms, so it converges hands-free).
        const incoming = Array.isArray(msg.approvals) ? msg.approvals : [];
        const snapshotById = new Map<string, ApprovalRequest>();
        for (const p of incoming) {
          if (!p || typeof p.id !== "string" || p.id.length === 0) continue;
          snapshotById.set(p.id, {
            id: p.id,
            kind: p.kind ?? "exec",
            title: p.title ?? "",
            description: p.description,
            prompt: p.prompt ?? "",
            options: (p.options ?? []) as ApprovalOption[],
            expiresAtMs: p.expiresAtMs,
          });
        }
        // #19: the recently-RESOLVED outcomes riding alongside the pending set.
        // A resolved-list id with no local card is NOT rehydrated (it is done —
        // nothing actionable); the map only upgrades Leg B / the optimistic branch.
        const resolvedIncoming = Array.isArray(msg.resolved) ? msg.resolved : [];
        const resolvedById = new Map<string, ApprovalDecision>();
        for (const r of resolvedIncoming) {
          if (!r || typeof r.id !== "string" || r.id.length === 0) continue;
          resolvedById.set(r.id, r.decision as ApprovalDecision);
        }

        const existing = this.state.approvals;
        const seen = new Set<string>();
        const next: ApprovalRequest[] = [];
        let changed = false;
        // Tracks whether a NEW actionable (pending) card was rehydrated (Leg A),
        // so we clear the typing indicator in parity with the live
        // `approval_request` path — a fresh actionable card means the agent is
        // BLOCKED on the user, not still working.
        let rehydratedActionable = false;

        for (const a of existing) {
          seen.add(a.id);
          // Defense in depth: an id in BOTH the pending `approvals` and the
          // `resolved` lists is impossible server-side (finalize deletes the
          // pending entry and records the resolved outcome in ONE synchronous
          // step before publishing), but if it ever happens the TERMINAL outcome
          // must win — never keep/make the card actionable. So a resolved-listed
          // id is routed to the resolved-upgrade branches below, ignoring `snap`.
          const snap = resolvedById.has(a.id) ? undefined : snapshotById.get(a.id);
          if (snap) {
            if (a.resolvedDecision === undefined) {
              // Present + unresolved: already actionable with the full payload
              // (an approval is immutable once minted), so keep the existing
              // entry — a duplicate snapshot stays a no-op.
              next.push(a);
            } else if (!a.resolutionConfirmed && a.resolvedDecision !== "unknown") {
              // Leg C: re-send the lost decision, keep the card resolved. Stays
              // unconfirmed so the next register retries until the server echoes
              // an authoritative `approval_resolved`.
              this.deferOrRunReplacementOperation({
                kind: "approval-decision", id: a.id, decision: a.resolvedDecision,
              });
              next.push(a);
            } else {
              // Server-confirmed resolution wins over a stale-by-ms snapshot.
              next.push(a);
            }
          } else if (a.resolvedDecision === undefined) {
            // Leg B: decided/expired while we weren't looking — no longer
            // actionable, server-confirmed (authoritative). #19: show the ACTUAL
            // outcome if the snapshot carried it, else the "unknown" sentinel.
            const outcome = resolvedById.get(a.id);
            next.push({
              ...a,
              resolvedDecision: outcome ?? "unknown",
              resolutionConfirmed: true,
            });
            changed = true;
          } else if (!a.resolutionConfirmed) {
            // Optimistic decision the server no longer has pending — our decision
            // (or another device's) won. #19: if the snapshot's resolved outcome
            // DIFFERS from our optimistic guess, the SERVER decision wins;
            // otherwise just confirm what we already showed.
            const outcome = resolvedById.get(a.id);
            next.push(
              outcome !== undefined && outcome !== a.resolvedDecision
                ? { ...a, resolvedDecision: outcome, resolutionConfirmed: true }
                : { ...a, resolutionConfirmed: true },
            );
            changed = true;
          } else {
            next.push(a);
          }
        }

        // Leg A: snapshot ids with no local entry → rehydrate as pending cards.
        for (const [id, snap] of snapshotById) {
          if (seen.has(id)) continue;
          // Defense in depth (see the loop above): an id present in BOTH lists is
          // terminal, so do NOT rehydrate an actionable card for it.
          if (resolvedById.has(id)) continue;
          next.push(snap);
          changed = true;
          rehydratedActionable = true;
        }

        if (changed) {
          this.setState({
            approvals: next,
            ...(rehydratedActionable ? { isTyping: false } : {}),
          });
        }
        return;
      }

      case "progress": {
        const { id } = msg;
        const text = msg.text ?? "";
        this.upsertMessage(
          id ?? "",
          (prev) => ({ ...prev, text, working: true, turnId: msg.turnId ?? prev.turnId }),
          { id: id ?? "", role: "agent", text, working: true, turnId: msg.turnId },
        );
        this.setState({ isTyping: false });
        // P1-9 §3.6.2: a progress upsert on a watched draft proves the turn is
        // still alive — disarm its staleness entry.
        this.staleDraftWatch.delete(id ?? "");
        return;
      }

      case "reasoning": {
        if (!msg.id || !msg.turnId || typeof msg.text !== "string" || msg.text.length === 0) return;
        this.upsertReasoning({ id: msg.id, turnId: msg.turnId, text: msg.text });
        // P1-9 §3.6.2: reasoning correlates by turnId — disarm any watched draft
        // for this turn (the turn is demonstrably still producing frames).
        this.disarmStaleDraftsByTurn(msg.turnId);
        return;
      }

      case "tool_activity": {
        // #97: structured tool-call activity. Required correlation keys `id` and
        // `turnId` must be non-empty strings; drop otherwise. Only the KEY NAMES
        // in `argKeys` are carried — no arg values ever reach state.
        if (typeof msg.id !== "string" || msg.id.length === 0) return;
        if (typeof msg.turnId !== "string" || msg.turnId.length === 0) return;
        this.upsertToolActivity({
          id: msg.id,
          turnId: msg.turnId,
          ...(typeof msg.name === "string" ? { name: msg.name } : {}),
          ...(typeof msg.phase === "string" ? { phase: msg.phase } : {}),
          ...(typeof msg.status === "string" ? { status: msg.status } : {}),
          ...(typeof msg.summary === "string" ? { summary: msg.summary } : {}),
          // Trust boundary: the wire is untrusted; keep only string key names
          // (the "argKeys are key names only" contract) and drop anything else.
          ...(Array.isArray(msg.argKeys)
            ? { argKeys: msg.argKeys.filter((k): k is string => typeof k === "string") }
            : {}),
        });
        // Like reasoning, a tool_activity frame correlates by turnId and proves
        // the turn is still producing frames — disarm any watched stale draft.
        this.disarmStaleDraftsByTurn(msg.turnId);
        return;
      }

      case "turn_settled": {
        // Consume before outcome promotion or UI settlement: either operation
        // can fan out synchronously, and a delayed publish callback must not open
        // a turn whose settle has already arrived.
        const turnPlacement = this.consumeTurnOpeningsThrough(msg.turnId);
        // P0-4 (§1): promote the exact send named by an EXPLICIT outcome.
        // `"ok"` → `accepted → completed` where turnId === wireId; `"error"`
        // → `failed{turn-failed, retryable:true}`. The current plugin emits one
        // same-outcome frame per coalesced member, anchor last. ABSENT `outcome`
        // means a legacy plugin (fires turn_settled from a finally regardless of
        // success): the UI still
        // settles below, but the send honestly stays `accepted` — never a
        // fabricated `completed`. A turn_settled that beats the ack promotes
        // straight past `sent` (the receipt guard allows the monotonic upgrade).
        if (msg.turnId && msg.outcome === "ok") {
          this.promoteAnchor(msg.turnId, "completed");
        } else if (msg.turnId && msg.outcome === "error") {
          this.promoteAnchor(msg.turnId, "failed", { reason: "turn-failed", retryable: true });
        }
        // Outcome is authoritative and must be committed before either UI
        // settlement callout. A listener reacting to typing/draft completion may
        // close the client; that teardown cannot overwrite completed/turn-failed.
        //
        // #96: this frame ends the turn it names AND every turn published before
        // it. Current coalesced groups emit one frame per member, anchor last;
        // the prefix behavior preserves compatibility with older anchor-only
        // producers and recovers from lost/missing earlier member frames (see
        // `closeTurnsThrough`). An outcome-less legacy `turn_settled` closes just
        // the same (the settlement is what matters, not the outcome).
        // Unknown/foreign ids and replays of an already-consumed local settle
        // remain no-ops; a local settle racing its first sent callback still
        // closes the already-open prefix.
        const turnClosed = this.closeTurnsThrough(turnPlacement);
        this.setState({ isTyping: false, ...(turnClosed ? { turnActive: false } : {}) });
        // P1-9 §3.6.1: settled ⇒ no more upserts — finalize any lingering working
        // draft whose turnId matches (in the normal flow the final agent_message
        // already did this, a no-op). Never swaps the id.
        this.finalizeDraftsForTurn(msg.turnId);
        return;
      }

      case "agent_message": {
        const { text, id } = msg;
        const assistantMessageIndex = normalizeAssistantMessageIndex(
          msg.assistantMessageIndex,
        );
        this.setState({ isTyping: false });

        if (id) {
          this.upsertMessage(
            id,
            (prev) => ({
              ...prev,
              text: text ?? "",
              working: false,
              turnId: msg.turnId ?? prev.turnId,
              ...(assistantMessageIndex !== undefined ? { assistantMessageIndex } : {}),
            }),
            {
              id,
              role: "agent",
              text: text ?? "",
              working: false,
              turnId: msg.turnId,
              ...(assistantMessageIndex !== undefined ? { assistantMessageIndex } : {}),
            },
          );
          // P1-9 §3.6.2: the final upsert also proves liveness — disarm.
          this.staleDraftWatch.delete(id);
          return;
        }

        this.appendMessage({
          id: `a-${this.uid()}`,
          role: "agent",
          text: text ?? "",
          turnId: msg.turnId,
          ...(assistantMessageIndex !== undefined ? { assistantMessageIndex } : {}),
        });
        return;
      }
    }
  }
}
