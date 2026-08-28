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
  ChatBubble,
  ChatMessage,
  ChatReasoningMessage,
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
import {
  applyDurableEvent,
  projectDurableFromClient,
  type DurableEvent,
  type DurableView,
} from "./durable-view-reducer.js";

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
    extraBubblePatch?: Partial<ChatBubble>;
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

/**
 * v6 §15.4: the per-id CLIENT-LOCAL overlay `mergeDurable` lays on top of the
 * shared reducer's durable view. Keyed by bubble id because one event can touch
 * many bubbles — a `turn_snapshot` finalizes every answer it names.
 *
 * An explicit `undefined` value DELETES the field (see `mergeDurable` rule 3);
 * that is how `draftOnly` is cleared when a frame authors durable text.
 *
 * ⚠️ `Partial<ChatBubble>`, NOT `Partial<ChatMessage>` (#242 half 2). Every field
 * an overlay can carry — `working`, `draftOnly`, `sendState`, `receiptKey`,
 * `pending`, `wireId` — is bubble-only, and a reasoning entry has none of them
 * (see `ChatReasoningMessage`). Typing it to the bubble arm makes an overlay
 * aimed at a reasoning id a COMPILE error at the call site rather than a silent
 * no-op inside `mergeDurable`, which is where it would otherwise be discovered.
 */
type DurableLocalOverlay = Record<string, Partial<ChatBubble>>;

/**
 * What a state mutation may carry.
 *
 * ⚠️ `reasoning` IS EXCLUDED AT THE TYPE LEVEL (#242 half 2), and that exclusion
 * IS the "one source of truth" guarantee. The field is DERIVED from
 * `state.messages` by `nextStateFrom` below; a patch that could also set it
 * would let the two disagree, which is the whole defect class this slice closes.
 * Writing `setState({ reasoning: … })` is now a compile error, not a convention.
 */
type StatePatch = Omit<Partial<InitializedWebChannelState>, "reasoning">;

/**
 * The reasoning bursts inside a transcript, in transcript order — what
 * `state.reasoning` exposes.
 *
 * ⚠️ NO CAP. `upsertReasoning`'s `.slice(-100)` is deliberately not reproduced
 * here: the durable view is uncapped, so a live cap would be exactly the
 * live≠history divergence #242 half 2 exists to close (the argument is at the
 * reducer's `applyReasoning`; retention is #299's, at the store). Do not add one.
 */
function deriveReasoning(messages: readonly ChatMessage[]): ReasoningItem[] {
  const out: ReasoningItem[] = [];
  for (const m of messages) {
    if (m.kind === "reasoning") out.push({ id: m.id, turnId: m.turnId, text: m.text });
  }
  return out;
}

/**
 * Apply one patch and recompute every DERIVED field.
 *
 * The derivation is conditional on `messages` being in the patch, so
 * `state.reasoning` keeps its ARRAY IDENTITY across patches that do not touch
 * the transcript — `typing`, `commands`, `approvals`, connection status.
 *
 * ⚠️ BE HONEST ABOUT WHAT THAT DOES AND DOES NOT BUY. An earlier revision said
 * the alternative "would report a change on every `typing` frame", which is true
 * and also the least of it. MEASURED: `state.reasoning` gets a FRESH array on
 * EVERY patch that touches `messages`, contents identical or not — two
 * consecutive `progress` frames each produce a new one. `progress` is far more
 * frequent during a turn than `typing` is, so a listener that keys off
 * `state.reasoning`'s identity still sees churn; what this condition removes is
 * the churn OUTSIDE a turn, not inside one.
 *
 * That is consistent with the rest of the object rather than a compromise —
 * `WebChannelState`'s docblock promises a new object per change, "the arrays
 * too", and `messages` itself is rebuilt by `mergeDurable` on every durable
 * frame. A content-equality memo here would be a fourth opinion about when a
 * view changed; the reducer's own header already refuses that reasoning for
 * array identity.
 */
function nextStateFrom(
  prev: InitializedWebChannelState,
  patch: StatePatch,
): InitializedWebChannelState {
  const next = { ...prev, ...patch };
  if (patch.messages !== undefined) next.reasoning = deriveReasoning(patch.messages);
  return next;
}

/**
 * Shallow equality over a transcript entry's own enumerable fields, so
 * `mergeDurable` can hand an UNCHANGED entry back by reference. `Object.is`
 * rather than `===` only to keep `NaN` (a plausible `ts`/`assistantMessageIndex`
 * corruption) from reporting a spurious change on every apply.
 *
 * ⚠️ "ENTRY", NOT "BUBBLE" — this said `bubble` while it only ever saw bubbles,
 * and #242 half 2 gave it a second caller (`mergeDurable`'s reasoning branch,
 * `sameChatMessage(prevEntry, nextReasoning)`). The key-count check is what makes
 * that work for BOTH kinds, which is why `ChatBubble.kind` and a reasoning
 * entry's `ts` are absent as OWN KEYS rather than present-and-`undefined`.
 *
 * ⚠️ ONLY ONE OF THOSE TWO CITES THIS FUNCTION, so do not go looking for a pair.
 * `ChatBubble.kind`'s declaration in `types.ts` carries the reason; the reasoning
 * `ts` is explained at its ASSIGNMENT site (`mergeDurable`'s reasoning branch),
 * not at its declaration. An earlier revision of this block claimed both
 * declarations did — corrected rather than deleted, because "both declarations
 * say so" is exactly the kind of census a reader trusts without checking.
 */
function sameChatMessage(a: ChatMessage, b: ChatMessage): boolean {
  const aKeys = Object.keys(a);
  if (aKeys.length !== Object.keys(b).length) return false;
  for (const key of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
    if (!Object.is((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])) {
      return false;
    }
  }
  return true;
}

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
   * in the set to `working: false` in place after the grace, never swapping the
   * id and never dropping the bubble — this valve GUESSES that a turn died, so it
   * promotes the partial to durable rather than deleting it (see
   * `expireStaleDrafts` for why this site differs from the three turn-end sites).
   * Both are connection-scoped: cleared on every onState(false)/close()
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
      // #251: a lane that never received durable text has nothing to settle INTO,
      // so it is dropped rather than frozen at its last partial.
      let draftsSettled = false;
      const settledMessages = this.dropSpentDrafts(
        this.state.messages.map((m) => {
          if (m.working) {
            draftsSettled = true;
            this.staleDraftWatch.delete(m.id);
            return { ...m, working: false };
          }
          return m;
        }),
      );
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
      const localId = this.mintLocalBubbleId("u");
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
    // v6 §15.4: the echo's durable half (id/role/text/turnId + tail placement) is
    // the reducer's `user` transition; the receipt overlay is the client's.
    const bubbleId = this.mintLocalBubbleId("u");
    const messages = this.nextPublishedUserMessages(
      bubbleId,
      trimmed,
      wireId,
      { wireId, receiptKey, sendState: "queued" },
    );
    this.stageReceiptStateThenCommit(
      receiptKey,
      { messages },
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
    const localId = this.mintLocalBubbleId("u");
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
      const messages = this.nextPublishedUserMessages(
        bubble.id,
        entry.text,
        wireId,
        { wireId },
        bubble,
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
   * merge assumes local order mirrors the ORDER THE JOURNAL REPLAYS. An
   * in-place release would order a held chip ABOVE the reply it delayed while
   * the journal orders it after — a later user row could then adopt at a lower
   * index and drag the insertion cursor backwards, misplacing the rows after it.
   * Moving to the tail makes a released bubble an ordinary send in an ordinary
   * position.
   *
   * ⚠️ THE REASON NARROWED AT #240 HALF 2 AND STILL HOLDS. It used to cite the
   * tier-3 positional probe (deleted) and "the server transcript" (never read
   * any more — N2). What carries it now is the insertion cursor alone, on the
   * USER path, which is the one tier that still adopts. Also worth keeping from
   * the deleted tier: a fresh row inserting at the plain `cursor`, AHEAD of a
   * held chip, is chronologically right — anything a snapshot carries predates
   * an unpublished chip.
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
          const messages = this.nextPublishedUserMessages(
            bubble.id,
            text,
            wireId,
            { pending: false, wireId },
            bubble,
          );
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
   * §3.6.1: settle any `working` draft whose turnId matches a settled turn.
   * Settled means no more upserts are coming; if `turnInFlight` drops as a
   * result, the end-of-frame `maybeRelease()` releases held messages.
   *
   * "Settle" is TWO outcomes since #251, not the flip-in-place this used to
   * promise: a draft that received durable text flips `working: false` with its
   * id and text untouched, while one that never did is DROPPED. `turn_settled` is
   * a genuine turn-end signal, so an unfinalized lane has nothing left to become.
   */
  /**
   * #212 (Phase 3, targeted): reconcile the live turn's AGENT ANSWER bubbles to
   * the plugin's authoritative `turn_snapshot`. The plugin owns per-message
   * identity; this is a PURE VIEW of its `answers` (ordered {id,text}) with a
   * `remove` set naming the bubbles it mis-routed answer content onto.
   *
   * The contract is EXPLICIT, never a blanket "drop everything not listed":
   *  - `answers` bubbles are upserted by id (existing bubble updated in place; an
   *    id we do not hold yet is MINTED — a lane that streamed but whose wire
   *    frames failed, e.g. the #215 mid-lane B recovery) and then reordered into
   *    snapshot order among the slots answer bubbles already occupy;
   *  - `remove` ids are dropped (an overflow final, or a recovery block now
   *    represented by an `answers` lane);
   *  - EVERYTHING else is untouched: user bubbles (receipts/held/sendState),
   *    notices/errors, an adopted durable-history agent row that shares the turn,
   *    and every non-answer agent bubble keeps its slot — only answer bubbles
   *    reorder, and only among themselves.
   * Case X is unaffected: its tool bubble is neither in `answers` (it never
   * streamed) nor in `remove`, so it is preserved exactly as before.
   *
   * v6 §15.4: that whole reconciliation now lives in the shared reducer's `seal`
   * transition (`durable-view-reducer.ts`'s `applySeal`, which was already a
   * line-for-line port of the body this method used to hold). What survives here
   * is the FRAME → EVENT mapper plus the client-local half:
   *
   *  - the two early returns are reproduced EXACTLY, including that neither sets
   *    `isTyping: false`. A no-op snapshot must stay a no-op — emitting a state
   *    patch and a listener notification for a frame that changes nothing is a
   *    real regression, however small;
   *  - the wire filters are applied HERE as well as inside `applySeal` (which
   *    re-applies them idempotently) because the early-return decision and the
   *    per-answer overlay both need the FILTERED set. An answer with a blank id
   *    is dropped by the reducer, so it must not contribute an overlay either;
   *  - `working: false` + clearing `draftOnly` on every answer is the overlay
   *    that reproduces the old body's answer objects, for the reused and the
   *    minted branch alike.
   */
  private applyTurnSnapshot(msg: InboundMessage): void {
    const turnId = msg.turnId;
    if (typeof turnId !== "string" || turnId.length === 0) return;
    const rawAnswers = (Array.isArray(msg.answers) ? msg.answers : []).filter(
      (a): a is { id: string; text: string } =>
        !!a &&
        typeof a.id === "string" &&
        a.id.length > 0 &&
        typeof a.text === "string",
    );
    // Defense-in-depth: the plugin never repeats an id (lane ids and minted ids
    // are unique), but a duplicate would break the slot-refill's
    // `slots.length === answers.length` assumption. Keep the FIRST occurrence.
    const answerSeen = new Set<string>();
    const answers = rawAnswers.filter((a) =>
      answerSeen.has(a.id) ? false : (answerSeen.add(a.id), true),
    );
    const remove = (Array.isArray(msg.remove) ? msg.remove : []).filter(
      (r): r is string => typeof r === "string" && r.length > 0,
    );
    if (answers.length === 0 && remove.length === 0) return;

    // Answer ids are wire-controlled; `__proto__` must be an ordinary overlay key.
    const local = Object.create(null) as DurableLocalOverlay;
    for (const a of answers) {
      // A sealed answer is authored durable text, so it is no longer a draft.
      local[a.id] = { working: false, draftOnly: undefined };
    }
    this.applyDurable({ kind: "seal", turnId, answers, remove }, local, { isTyping: false });
  }

  private finalizeDraftsForTurn(turnId?: string): void {
    if (!turnId) return;
    let changed = false;
    // #251: the ordinary turn end. A lane whose draft never became durable text
    // disappears here — the same thing Telegram's user sees when an unfinalized
    // preview is cleared at turn end.
    const messages = this.dropSpentDrafts(
      this.state.messages.map((m) => {
        if (m.working && m.turnId === turnId) {
          changed = true;
          this.staleDraftWatch.delete(m.id);
          return { ...m, working: false };
        }
        return m;
      }),
    );
    if (changed) this.setState({ messages });
  }

  /**
   * §3.4: settle the local turn-in-flight state — flip EVERY live `working` draft
   * to `working: false` (staleness-watch entry dropped) AND clear the `isTyping`
   * indicator. Both feed `turnInFlight()`, so clearing them is what actually
   * unwedges the composer. Called only from the explicit-`/stop` branch of send():
   * "stop everything" must unwedge immediately, not wait for a
   * `turn_settled`/final frame that may never arrive (agent died with the socket
   * alive). Covers BOTH a working-draft hang and a pre-first-token typing-only
   * hang (isTyping true, zero drafts).
   *
   * #251: a draft that never received durable text is DROPPED rather than flipped
   * in place — an explicit `/stop` is a genuine turn end, so an unfinalized lane
   * has nothing to become. A draft that DID receive durable text keeps its id and
   * text exactly as before.
   *
   * The self-healing invariant survives the drop, but ONLY FOR IDENTITY, not for
   * position: if the turn was actually still alive, a later `typing`/`progress`
   * re-sets the state this cleared and the lane comes back under the SAME id (one
   * bubble, and its eventual final still matches it) — but `applyPlacement`
   * appends, so it re-materialises at the TAIL rather than in its old slot. A
   * `/stop` mid-turn can therefore leave the late answer BELOW the user's `/stop`
   * bubble. That is Telegram-faithful: the preview was deleted, so the lane
   * returning is a new delivery act. Pinned in `durable-view-reducer.test.ts`
   * ("late progress after a drop re-materialises the lane at the TAIL (#251)").
   */
  private finalizeLocalTurnState(): void {
    let changed = false;
    // #251: "stop everything" ends the turn, so an unfinalized lane's bubble goes
    // with it rather than freezing at its last partial.
    const messages = this.dropSpentDrafts(
      this.state.messages.map((m) => {
        if (m.working) {
          changed = true;
          this.staleDraftWatch.delete(m.id);
          return { ...m, working: false };
        }
        return m;
      }),
    );
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
   * PLACE and PROMOTE its partial text to durable (id, text and slot untouched,
   * so a WRONG guess self-heals: a later progress upsert re-matches the id and
   * re-flips it working, in its original slot, re-engaging the hold). Then
   * re-evaluate the release gate.
   */
  private expireStaleDrafts(): void {
    this.staleDraftTimer = null;
    if (this.staleDraftWatch.size === 0) return;
    let changed = false;
    // #251 DOES NOT APPLY HERE, and the difference is the whole point: this is
    // the ONE draft-settling site that is not a turn-end signal. The reference
    // deletes an unfinalized preview inside a `finally` around the whole dispatch
    // — `[core] extensions/telegram/src/bot-message-dispatch.ts:2954-2975`, i.e.
    // the turn genuinely ENDED, abort path included. This valve is a
    // CONSUMER-SIDE GUESS fired MID-TURN: armed at session re-establish, tripped
    // by 30s of quiet on a turn that may be perfectly healthy. Deleting content on
    // a guess is the wrong side of N10, so the other three sites (terminal settle,
    // `turn_settled`, explicit `/stop` — all real turn-end signals) drop, and this
    // one PROMOTES: `draftOnly` is cleared, the partial the user was already
    // reading becomes durable, and the bubble stays in its slot.
    //
    // Clearing the bit is required, not cosmetic — merely SKIPPING the drop here
    // would commit `working:false && draftOnly:true`, which `mergeDurable`'s rule
    // 4 would then drop on the next unrelated frame anyway.
    //
    // Honest consequence: a dropped connection whose turn never settles leaves the
    // frozen partial bubble on screen. That is the pre-#251 status quo at this
    // site, not a regression — we only delete when we KNOW the turn ended.
    const messages = this.state.messages.map((m) => {
      if (this.staleDraftWatch.has(m.id) && m.working) {
        changed = true;
        const promoted: ChatMessage = { ...m, working: false };
        delete promoted.draftOnly;
        return promoted;
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
  private setState(patch: StatePatch): void {
    this.state = nextStateFrom(this.state, patch);
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
    patch: StatePatch,
    commit: () => void,
  ): void {
    const notificationSeq = this.stateNotificationSeq;
    // Routed through the SAME derivation as `setState` — this is the other door
    // into `this.state`, and a direct spread here would leave `reasoning` stale
    // for any staged patch that touches `messages`.
    this.state = nextStateFrom(this.state, patch);
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

  // ---------------------------------------------------------------------------
  // v6 §15.4 (#237) — the durable half of `state.messages` is computed by the
  // SHARED REDUCER, not by hand-rolled reconciliation here.
  // ---------------------------------------------------------------------------
  //
  // The design's central bet is `history == the live view` BY CONSTRUCTION: one
  // pure reducer (`durable-view-reducer.ts`) produces both this client's live
  // view and — later, from the journal — the server's history projection. A
  // reducer with no runtime consumer guarantees nothing, so THIS is its first
  // consumer (NOT-list N8).
  //
  // Shape: `state.messages` stays the ONE array. There is deliberately no
  // parallel durable event log and no retained `DurableView` field — we PROJECT
  // `state.messages`, apply exactly one event, and merge the result back. That
  // keeps bubbles the reducer never authored (adopted history rows, notices)
  // inside the view, so they hold their slots through a `seal` exactly as
  // `applySeal` promises, and it means the history merge's adoption of a
  // snapshot row (which writes `state.messages` directly) automatically seeds
  // the next projection without being routed through the reducer.
  //
  // Split of ownership, per §0.1 / the north star: the REDUCER owns id, role,
  // durable text, turnId and ORDER; the CLIENT owns its own overlay (`working`,
  // `ts`, `sendState`/`sendFailure`, `receiptKey`, `wireId`, `pending`,
  // `retracted`, `assistantMessageIndex`, `draftOnly`), which is never journaled.

  /**
   * Project `state.messages` down to the durable view the reducer operates on.
   *
   * The §15.9 rule it applies (a `draftOnly` bubble contributes `text: ""`) lives
   * in the reducer module, NOT here: it is the durability boundary itself, and
   * the eventual server projection must inherit the same one. A second copy in
   * the render path would be an N8 live≠history divergence with nothing to make
   * it go red.
   */
  private durableProjection(): DurableView {
    return projectDurableFromClient(this.state.messages);
  }

  /**
   * #251: an agent bubble that claimed a slot via `progress` and never received
   * durable text renders NOTHING once it stops working.
   *
   * Settled from the reference, not chosen: core's built-in Telegram extension
   * DELETES an unfinalized preview at turn end —
   * `[core] extensions/telegram/src/bot-message-dispatch.ts:2971-2975`
   * (`lane.finalized ? stream.stop() : stream.clear()`), and `clear()` really
   * deletes (`draft-stream.ts:653-668` → `:634 api.deleteMessage`). A preview
   * becomes durable in exactly two cases — it finalized, or it is a completed
   * overflow chunk (`draft-stream.ts:409`, `:479`, the only two `retain: true`
   * sites). `draft-stream.ts:277` says it outright: "ephemeral preview to
   * delete, NOT a durable content chunk to retain."
   *
   * The predicate keys on `draftOnly`, NOT on `text === ""`. Two reasons:
   *  - `draftOnly` OUTLIVES the `working` flip, so the drop is actually
   *    reachable at turn end. A text test is not: by then `text` holds the last
   *    partial, so the bubble would freeze forever — today's bug;
   *  - it cannot swallow a legitimately empty durable message. Every answer /
   *    final path guards non-empty text (`message-adapter.ts:944`, `:1716`,
   *    `:2521`; `inbound.ts:1446`), but the generic outbound seam
   *    (`channel.ts:311`) forwards core's `ctx.text` unchecked, so empty durable
   *    text is not structurally impossible. Keying on `draftOnly` makes that
   *    moot instead of relying on the guarantee.
   */
  private isSpentDraft(m: ChatMessage): boolean {
    return m.role === "agent" && m.working !== true && m.draftOnly === true;
  }

  /**
   * Apply the #251 drop to a messages array the caller built WITHOUT the
   * reducer. THREE sites call this — terminal settle, `finalizeDraftsForTurn`
   * and `finalizeLocalTurnState`. Each is a real turn-end signal, which is what
   * makes the drop safe: core deletes an unfinalized preview at TURN END
   * (`[core] extensions/telegram/src/bot-message-dispatch.ts:2954-2975`).
   *
   * ⚠️ `expireStaleDrafts` also flips `working: false` and is deliberately NOT
   * routed here — it PROMOTES instead (see its body). Do not "fix" that
   * asymmetry: that valve is a consumer-side guess fired mid-turn on a possibly
   * healthy turn, and deleting a partial the user is reading on a guess is the
   * N10 violation this split exists to prevent. Wiring it in would look like a
   * consistency cleanup and would silently restore content deletion.
   *
   * Doing the drop here rather than routing these sites through `applyDurable`
   * keeps them event-free: there is no "nothing happened" `DurableEvent`, and
   * BOUNDARY 2 forbids inventing one.
   */
  private dropSpentDrafts(messages: ChatMessage[]): ChatMessage[] {
    return messages.some((m) => this.isSpentDraft(m))
      ? messages.filter((m) => !this.isSpentDraft(m))
      : messages;
  }

  /**
   * Merge a reducer-produced `DurableView` back onto `state.messages`.
   *
   *  1. every client-local field is carried from the `prev` bubble with the same
   *     id (the whole overlay — `ts`, `working`, `sendState`, `receiptKey`, …).
   *     ⚠️ THE CARRY IS KEYED BY (KIND, id), NOT BY id: `state.messages` can
   *     hold a same-id pair of different kinds (`case "history"`'s cross-kind
   *     fresh insert), and each member keeps its OWN overlay. This sentence was
   *     false while `prev` was indexed by id alone — see the two kind-scoped
   *     maps below for what went wrong and how;
   *  2. `id`, `role`, `text` and `turnId` come from the view (`turnId` falls back
   *     to `prev`'s), EXCEPT that a still-`draftOnly` entry keeps `prev.text` —
   *     its durable text is `""` by construction and the rendered text is the
   *     client-local draft, so taking the view's `""` would blank a live draft
   *     whenever an unrelated frame triggers an apply;
   *  3. an OWN `local[id]` is applied LAST and wins. Prototype properties are
   *     never overlays. A key set to `undefined` DELETES it (that is how
   *     `draftOnly` is cleared), rather than leaving an `undefined`-valued key
   *     that would defeat the identity reuse below;
   *  4. a spent draft (see `isSpentDraft`) is OMITTED;
   *  5. an id in `prev` but absent from the view is dropped — that is `seal`'s
   *     `remove` working as designed.
   *
   * ⚠️ RULES 1-4 ARE ABOUT BUBBLES. A `kind: "reasoning"` entry takes the short
   * branch at the top of the loop: it has no overlay to lay on (rule 1/3), no
   * `draftOnly` carve-out (rule 2) and no spent-draft state (rule 4). Rule 5 and
   * the reference-reuse guarantee below apply to it unchanged. #242 half 2.
   *
   * Entries whose emitted fields are unchanged are returned BY REFERENCE. That
   * is required, not an optimization: `nats-client-wrapper.test.ts` asserts
   * `.toBe` identity for untouched user/notice/history bubbles across a
   * `turn_snapshot`. It is also the reducer's own structural-sharing discipline
   * — `DurableMessage` being `readonly` forbids writing THROUGH a shared entry,
   * not handing an unchanged one back. Note this is entry identity only: do NOT
   * build an ARRAY-identity no-op signal on top (the reducer's header is
   * explicit that array identity is a partial property).
   */
  private mergeDurable(
    prev: ChatMessage[],
    view: DurableView,
    local?: DurableLocalOverlay,
  ): ChatMessage[] {
    // `base` is looked up in the PRE-`remove` `prev`, so an id appearing in BOTH
    // `seal.remove` and `seal.answers` would inherit the removed bubble's
    // client-local fields rather than starting clean. Unreachable by construction
    // rather than by a guard here: `emitTurnSnapshot` builds `answers` from lane
    // ids and `remove` from `supersededAnswerBubbleIds`, which are disjoint sets.
    // Recorded rather than branched on — an unreachable branch with no test is
    // worse than a stated invariant.
    // ⚠️ TWO KIND-SCOPED INDEXES, NEVER ONE KEYED BY ID. The two id spaces
    // (answer/user bubbles and reasoning blocks) are not provably disjoint — the
    // reducer's `findTextIndex` docblock retracts the id-shape argument that used
    // to claim they were — and `case "history"` now DELIBERATELY produces a
    // same-id pair of different kinds when a snapshot row collides with a local
    // entry of the other kind.
    //
    // ⚠️ A SINGLE `Map<string, ChatMessage>` WITH A KIND GUARD ON THE LOOKUP WAS
    // TRIED AND WAS WRONG, in exactly the way `case "history"`'s id-keyed index
    // was wrong: a Map is LAST-WINS, so `get(id)` on such a pair returned
    // whichever member sat later in the array and the guard turned that into
    // `undefined` for the EARLIER one — dropping its WHOLE overlay (rule 1), not
    // one field. Measured: a hydrated bubble lost its `ts` on the next unrelated
    // durable frame; the same loss takes `receiptKey` (after which
    // `patchBubbleByReceiptKey` can never find that bubble), `wireId` (breaking
    // `promoteAnchor`) and `pending` (making `retract()` return false for a
    // bubble still in `this.held[]`). Scoping the INDEX makes each member find
    // its own `prev`, and the guards disappear because the key does the work.
    const prevBubbleById = new Map<string, ChatBubble>();
    const prevReasoningById = new Map<string, ChatReasoningMessage>();
    for (const m of prev) {
      if (m.kind === "reasoning") prevReasoningById.set(m.id, m);
      else prevBubbleById.set(m.id, m);
    }
    const out: ChatMessage[] = [];
    for (const entry of view) {
      // ⚠️ #242 half 2: A REASONING ENTRY IS CARRIED, NOT SKIPPED. Half 1 had a
      // `continue` here because `state.messages` was the chat-BUBBLE list and
      // the client rendered reasoning from a separate `state.reasoning` array.
      // Half 2 made `ChatMessage` a tagged union and moved reasoning into this
      // array, so the entry maps across as itself.
      //
      // It carries NO overlay and NO `role` — see `ChatReasoningMessage` for why
      // neither can apply. The one client-local field it can hold is `ts`
      // (hydration metadata off a `history` row), and it is inherited from the
      // previous entry exactly the way rule 1 inherits the bubble overlay.
      //
      // ⚠️ THE `ts` INHERITANCE IS WHY THIS BRANCH CANNOT BE A BARE `push`. A
      // reload hydrates the block with a `ts`; the very next durable frame
      // re-projects and re-merges the whole view, and building a fresh
      // `{kind,id,turnId,text}` would silently drop it.
      //
      // ⚠️ THAT REASONING WAS RIGHT AND THE CODE STILL LOST THE `ts` — measured,
      // and worth recording because the paragraph above reads as a guarantee.
      // The inheritance only ever held for the LAST-WINS member of a same-id
      // pair: `prev` was indexed by id alone, so a reasoning entry sharing an id
      // with a bubble later in the array looked up as `undefined` and this
      // branch built exactly the fresh `{kind,id,turnId,text}` it says it
      // avoids. Keying the index by kind is what made the paragraph true.
      if (entry.kind === "reasoning") {
        const prevEntry = prevReasoningById.get(entry.id);
        const nextReasoning: ChatReasoningMessage = {
          kind: "reasoning",
          id: entry.id,
          turnId: entry.turnId,
          text: entry.text,
        };
        // Assigned rather than written in the literal for the same reason the
        // bubble branch assigns `turnId`: an own `ts: undefined` key would fail
        // `sameChatMessage`'s key-count check and defeat the identity reuse.
        if (prevEntry?.ts !== undefined) nextReasoning.ts = prevEntry.ts;
        out.push(
          prevEntry !== undefined && sameChatMessage(prevEntry, nextReasoning)
            ? prevEntry
            : nextReasoning,
        );
        continue;
      }
      const base = prevBubbleById.get(entry.id);
      const overlay = local !== undefined && Object.hasOwn(local, entry.id)
        ? local[entry.id]
        : undefined;
      const overlaySetsText = overlay !== undefined && "text" in overlay;
      const overlaySetsDraftOnly = overlay !== undefined && "draftOnly" in overlay;
      const draftOnly = overlaySetsDraftOnly ? overlay.draftOnly : base?.draftOnly;
      const turnId = entry.turnId ?? base?.turnId;
      const next: ChatBubble = {
        ...base,
        id: entry.id,
        role: entry.role,
        // Rule 2's carve-out: while the bubble holds only a draft, `text` is the
        // client's, not the view's.
        text: draftOnly === true && !overlaySetsText && base !== undefined
          ? base.text
          : entry.text,
      };
      // Assigned rather than written in the literal so an ABSENT turnId does not
      // become an own `turnId: undefined` key. A history-hydrated bubble is
      // created without one (`case "history"`'s fresh-insert for a TEXT row that
      // matched no tier — the `inserts` push in the `m.role` branch, not the
      // reasoning one above it — emits exactly `{id, role, text, ts, working}`),
      // and adding the key fails
      // `sameChatMessage`'s key-count check on the very first durable event —
      // silently re-creating a bubble the `.toBe` guarantee says must be reused.
      if (turnId !== undefined) next.turnId = turnId;
      if (overlay !== undefined) {
        for (const [key, value] of Object.entries(overlay)) {
          if (value === undefined) delete (next as Record<string, unknown>)[key];
          else (next as Record<string, unknown>)[key] = value;
        }
      }
      if (this.isSpentDraft(next)) continue;
      out.push(base !== undefined && sameChatMessage(base, next) ? base : next);
    }
    return out;
  }

  /**
   * Compute the next `state.messages` for ONE durable event, without committing
   * it. Receipt-bound user publication uses the specialized sibling below;
   * inbound durable frames use this form through `applyDurable`.
   */
  private nextDurableMessages(
    event: DurableEvent,
    local?: DurableLocalOverlay,
  ): ChatMessage[] {
    const before = this.durableProjection();
    const after = applyDurableEvent(before, event);
    return this.mergeDurable(this.state.messages, after, local);
  }

  /**
   * Materialize one successfully published user echo through the shared reducer.
   * A held/deferred bubble is only local staging until its wire id is reserved:
   * remove that one row from the reducer input so `user` appends its FINAL
   * durable identity/content/turnId at the tail, then merge against the full
   * client view so the staging row's receipt/UI fields survive. `local` applies
   * the path-specific publication changes (`pending:false` for held release,
   * absent for deferred publication). A caller whose staging row disappeared
   * deliberately skips this helper, so publication never resurrects a bubble.
   */
  private nextPublishedUserMessages(
    bubbleId: string,
    text: string,
    wireId: string,
    local: Partial<ChatBubble>,
    stagedBubble?: ChatMessage,
  ): ChatMessage[] {
    let reducerInput = this.state.messages;
    if (stagedBubble !== undefined) {
      const stagedIndex = reducerInput.indexOf(stagedBubble);
      if (stagedIndex !== -1) {
        reducerInput = [
          ...reducerInput.slice(0, stagedIndex),
          ...reducerInput.slice(stagedIndex + 1),
        ];
      }
    }
    const before = projectDurableFromClient(reducerInput);
    const after = applyDurableEvent(before, {
      kind: "user",
      id: bubbleId,
      text,
      turnId: wireId,
    });
    return this.mergeDurable(this.state.messages, after, { [bubbleId]: local });
  }

  /** Apply ONE durable event to `state.messages`, optionally folding in a
   *  sibling state patch the same frame owes (e.g. `turn_snapshot`'s
   *  `isTyping: false`) so it lands in a single notification. */
  private applyDurable(
    event: DurableEvent,
    local?: DurableLocalOverlay,
    // ⚠️ `StatePatch`, NOT `Partial<InitializedWebChannelState>` — this was the
    // ONE door left unnarrowed in #242 half 2, and a spread hole is still a
    // hole: `setState({ messages, ...extra })` does not error on a `reasoning`
    // key arriving through the spread, so `StatePatch`'s claim that assigning
    // `reasoning` is "a compile error, not a convention" was true of every
    // caller except this one. Closed rather than weakened, because a guarantee
    // with a documented exception is the shape nobody checks.
    extra?: StatePatch,
  ): void {
    this.setState({ messages: this.nextDurableMessages(event, local), ...extra });
  }

  // #97: upsert a tool-activity item by turn-scoped `(turnId, id)`. A later
  // sparse lifecycle frame refines the same call without erasing name/argKeys
  // learned at start. Ephemeral, NOT cleared on turn_settled (a live-not-durable
  // surface), and bounded at 100 by the `.slice(-100)` below.
  //
  // ⚠️ "BOUNDED LIKE `reasoning`" IS NO LONGER TRUE — #242 half 2 DELETED that
  // bound. Reasoning is a DURABLE message now: it lives in `state.messages`, is
  // uncapped there to match the durable view, and `state.reasoning` is derived
  // from it. Tool activity is still a live-only side array with no durable twin
  // to disagree with, so its cap costs nothing and stays. When half 3 makes tool
  // activity durable this cap has to go the same way, for the same reason — a
  // live cap over an uncapped durable view IS a live≠history divergence.
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

  /** Mint a viewer-local bubble id without colliding with hydrated transcript ids. */
  private mintLocalBubbleId(prefix: "u" | "a"): string {
    let id: string;
    do {
      id = `${prefix}-${this.uid()}`;
    } while (this.state.messages.some((message) => message.id === id));
    return id;
  }

  private seq = 0;

  /** One-shot latch: the id-less durable `agent_message` warning is per client
   *  instance, not per frame — a legacy plugin emits one per reply. */
  private warnedIdlessDurableFrame = false;

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
    extraBubblePatch?: Partial<ChatBubble>,
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
    patch: Partial<ChatBubble>,
    extraState?: StatePatch,
  ): void {
    // ⚠️ `m.kind === undefined` IS PART OF THE PREDICATE, not decoration.
    // `receiptKey` is a bubble-only field — a reasoning block is never SENT by
    // this client, so it has no receipt — which makes a match a bubble by
    // construction. The conjunct is here anyway because "cannot happen" is not a
    // reason to spread a bubble patch over an entry of another kind. The cast
    // below records what this predicate already decided; TS cannot carry a
    // `findIndex` callback's narrowing to the element (the same limitation the
    // reducer's `applyPlacement` documents).
    const idx = this.state.messages.findIndex(
      (m) => m.kind === undefined && m.receiptKey === receiptKey,
    );
    if (idx === -1) {
      if (extraState) this.setState(extraState);
      return;
    }
    const messages = this.state.messages.slice();
    messages[idx] = { ...(messages[idx] as ChatBubble), ...patch };
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
        const rawIncoming = Array.isArray(msg.messages) ? msg.messages : [];
        /**
         * ⚠️ DROP EMPTY-TEXT AGENT ROWS BEFORE ANYTHING ELSE LOOKS AT THEM.
         *
         * A lane that got a `progress` and then neither a `bubble` nor a
         * `seal.answers` entry — an aborted turn, or a connection dropped before
         * the drain — leaves a PLACEMENT whose text is never authored. The
         * server's replay emits it as `{role:"agent", text:""}` because
         * `applyPlacement` appends one and nothing in the journal removes it
         * (`journal-history.ts`'s header documents this as N8-by-omission), and
         * the server CANNOT drop it: the rule that hides it live keys on
         * `draftOnly`, a client-local flag §15.9 deliberately never journals.
         *
         * ⚠️ WHY IT STILL EXISTS NOW THAT AGENT ROWS CANNOT ADOPT. It was added
         * because the row DESTROYED a delivered answer: matching no local text it
         * fell through to the positional probe, which took the next real agent
         * bubble and overwrote it with `{id: P, text: ""}` (N10). That probe is
         * deleted, so the row can no longer damage anything — it would simply
         * fresh-insert. The filter is retained for the ORIGINAL, smaller reason,
         * which the damage had overshadowed: live renders nothing for such a
         * lane, so a history that renders an empty bubble diverges from live for
         * no benefit (N8). Deriving the row away server-side is #251/#264.
         *
         * ⚠️ THIS IS NOT A NEW RULE — IT IS THE ONE THIS CLIENT ALREADY APPLIES
         * LIVE, moved to the only other door the same lane can arrive through.
         * `isSpentDraft`/`dropSpentDrafts` delete a spent draft at turn end
         * (#251, settled against core's built-in Telegram extension, which
         * deletes an unfinalized preview rather than keeping it). An empty agent
         * bubble renders nothing either way, so this converges history to live
         * instead of inventing a third behaviour.
         *
         * ⚠️ A `history` FRAME IS NOT "ALWAYS AFTER TURN END" — an earlier
         * revision of this paragraph said so, and the Phase-6 note below
         * contradicts it: a snapshot arrives at every device MID-SESSION. The
         * justification does not need that claim. A lane still in flight
         * projects `{agent, ""}` and is filtered — same outcome as the live
         * draft it mirrors, which also renders nothing. A lane that already
         * published a bubble carries its text, so it tier-1 matches its own
         * `working:true` draft by id and is left alone (tier 1 is a no-op; a
         * working draft is never an adoption target either).
         *
         * Keeping it client-local is also where
         * **#264** says the derivation belongs — a server-side "placement whose
         * answerId never reappears" fold would be a supersession rule invented
         * in the projection, which is the N8 the store exists to prevent.
         *
         * ⚠️ RESIDUAL, STATED BECAUSE `isSpentDraft`'s OWN DOCBLOCK NAMES IT:
         * this keys on `text === ""`, which `isSpentDraft` deliberately does NOT,
         * so it also drops a LEGITIMATELY empty durable message. Those are not
         * structurally impossible — every answer/final path guards non-empty
         * text, but the generic outbound seam (`channel.ts:311`) forwards core's
         * `ctx.text` unchecked. The consequence is invisible: an empty bubble
         * renders nothing whether it is dropped or kept. We cannot do better
         * here, because `draftOnly` is exactly the discriminator the wire does
         * not carry.
         *
         * ⚠️ IT CANNOT EAT A REASONING ROW, AND THE REASON IS THE `role` TEST,
         * NOT THE TEXT TEST (#242 half 2 — checked, because "empty text" would
         * be the tempting thing to blame). A reasoning row carries NO `role`, so
         * the first conjunct is already false and the row is kept whatever its
         * text says.
         *
         * ⚠️ THAT IS WHY AN EMPTY REASONING ROW IS REFUSED IN THE REASONING
         * BRANCH INSTEAD, and it is a different rule with a different reason.
         * Live, `case "reasoning"` drops a frame whose `text` is empty
         * (`msg.text.length === 0`). Without a matching admission rule here the
         * same content would be DROPPED live and KEPT from history — an empty
         * `<details>` the live path would never draw, which is an N8 divergence
         * this door introduced. It is not enough that the plugin's
         * `closeLiveBurst` only emits a burst frame when
         * `lastDeliveredText.length > 0`: that makes such a row unreachable FROM
         * OUR PLUGIN, not absent, and this reducer's standing policy is that a
         * history row is validated on its own rather than on trust in the
         * server. (Contrast the empty USER row below, which is deliberately
         * KEPT: nothing drops an empty user bubble live either, so keeping it is
         * what agrees.)
         */
        const incoming = rawIncoming.filter(
          (m) =>
            !(
              m &&
              typeof m === "object" &&
              (m as { role?: unknown }).role === "agent" &&
              (m as { text?: unknown }).text === ""
            ),
        );
        if (incoming.length === 0) return;

        const existing = this.state.messages;
        /**
         * The tier-1 key: (KIND, id), never the id alone.
         *
         * ⚠️ `state.messages` MIXES BOTH KINDS SINCE #242 half 2, and the two id
         * spaces are NOT provably disjoint — `durable-view-reducer.ts`'s
         * `findTextIndex` docblock retracts the id-shape argument outright
         * (agent answer ids come from the same `nextMessageId()` as reasoning
         * ids, and USER ids are client-supplied, validated only as a non-empty
         * string within `MAX_INBOUND_USER_ID_LENGTH`, so a peer can send
         * `webchannel-…` verbatim). Indexing a mixed array by id alone is
         * therefore the whole defect class; keying it is the fix, and it is one
         * property rather than a rule each site has to remember.
         *
         * NUL separates, so no id can spell another kind's key.
         */
        const kindKey = (kind: string | undefined, id: string): string =>
          `${kind === "reasoning" ? "r" : "t"}\0${id}`;
        const seen = new Set(existing.map((m) => kindKey(m.kind, m.id)));

        // Phase 6 (stateless register, shared conversation key): a snapshot
        // triggered by ANY device's register — this device's reconnect or a
        // second device joining — arrives at every device mid-session on the
        // shared `.out`. Messages already rendered LIVE on this device sit in
        // state under LOCAL id namespaces, so plain id-dedup could duplicate
        // them.
        //
        // ⚠️ #240 HALF 2 CHANGED WHERE THE SNAPSHOT'S IDS COME FROM, AND THE
        // AGENT-SIDE GUESSING TIERS WERE DELETED BECAUSE OF IT. History is no
        // longer core's transcript; it is a projection of the plugin's own
        // delivery journal, whose ids ARE the ids minted at the delivery act —
        // the same `webchannel-…` values the live frames carried. So:
        //   - AGENT rows: if this device rendered the answer, its bubble carries
        //     that id and TIER 1 matches. Therefore an agent row that MISSES tier
        //     1 has no local counterpart, and any text- or position-based
        //     adoption of one is guaranteed to overwrite a different message.
        //     Tiers 2 and 3 are closed to agent rows for that reason.
        //   - USER rows: the local echo is `u-<n>` (`mintLocalBubbleId`) while
        //     the journal stores the inbound WIRE id, so a user row legitimately
        //     misses tier 1 and TIER 2 is how it is recovered. Removing tier 2
        //     here would fresh-insert every user row on every snapshot and
        //     duplicate everything this device sent. **#302** owns removing it,
        //     and is blocked on **#243** giving a user message one shared id.
        //
        // ⚠️ THE HONEST COST, STATED WHERE IT IS PAID: text matching is the
        // ordinal/text inference NOT-list N5 forbids, and it still runs on the
        // user path. That is not an oversight — it is unremovable until #243.
        //
        // ⚠️ WHY DELETION RATHER THAN MORE RULES. Four data-loss defects were
        // found in this block across four consecutive review rounds, each fixed
        // by adding a rule, and each new rule failed to cover the next instance:
        // a tier-1 match that did not claim its bubble; the unauthored placement
        // row firing the positional probe; `adoptAt` not retiring the id it
        // displaced; and a hydrated bubble being treated as live because the old
        // `isLocalLiveId` was a bare `webchannel-` prefix test. All four were on
        // the agent path. Do not reintroduce a tier here to "restore coverage" —
        // the coverage it restores is the coverage that lost the messages.
        //
        // Matching happens in two tiers, in snapshot order:
        //   1. id — a message whose canonical id we already hold is a no-op.
        //      This is where every AGENT row either matches or falls through to
        //      a fresh insert;
        //   2. exact text+role — USER ROWS ONLY. Adopt the server id onto the
        //      first text-matching local echo.
        // ⚠️ A REASONING ROW USES TIER 1 AND THE FRESH INSERT, AND NOTHING ELSE
        // (#242 half 2). It is handled in its own branch below, ahead of the
        // `role` validation, for a reason worth stating here too: reasoning ids
        // are PLUGIN-minted and identical live and in the snapshot, so tier 1 is
        // the normal outcome — and tier 2 is closed to it twice over (the
        // incoming row's `if (m.role === "user")` and the pool's
        // `isAdoptableUserEcho`).
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
        // ⚠️ USER ROWS ONLY — the agent branch of this predicate was DELETED, and
        // its NAME is why. It used to be `isLocalLiveId`, and it read
        // `!m.working && (id.startsWith("a-") || id.startsWith("webchannel-"))`.
        // Post-cutover a history-HYDRATED agent bubble also carries
        // `webchannel-`, so the prefix stopped discriminating "rendered live on
        // this device" from "handed to us by the server" — and an older page
        // then adopted onto a bubble a previous snapshot had hydrated, destroying
        // the newer answer. The predicate is now named for what it actually
        // tests.
        //
        // P1-9 §6.3, still load-bearing: a held (pending) or /stop-retracted user
        // bubble is LOCAL-ONLY (never on the wire, never in the journal). It must
        // NEVER be an adoption target — a snapshot row with identical text (the
        // same text sent from another device) would otherwise steal its server id
        // onto our UNSENT bubble, and the later release would run/duplicate it.
        // ⚠️ A TYPE PREDICATE, not a `boolean` — #242 half 2. `m.role === "user"`
        // already excludes a reasoning entry at RUNTIME (it has no role), and
        // the predicate makes tsc carry that fact to the `adoptKey(m.role, …)`
        // below instead of leaving `role` possibly-undefined there. It is also
        // the second of the two independent guards that keep tier 2 off a
        // reasoning row; the other is the `if (m.role === "user")` on the
        // incoming row.
        const isAdoptableUserEcho = (m: ChatMessage): m is ChatBubble =>
          m.role === "user" &&
          m.id.startsWith("u-") &&
          m.pending !== true &&
          m.retracted !== true;
        const adoptKey = (role: string, text: string): string => `${role} ${text}`;

        const next = existing.slice();
        // Last-wins on a duplicate key, exactly as before — the change is the
        // KEY, not the policy, so the non-collision case is unaffected.
        const localIndexByKey = new Map<string, number>();
        next.forEach((m, i) => localIndexByKey.set(kindKey(m.kind, m.id), i));
        const claimed = new Set<number>();
        const adoptable = new Map<string, number[]>();
        next.forEach((m, i) => {
          if (isAdoptableUserEcho(m)) {
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
         * `localIndexByKey`/`claimed`/`adoptable`), so the placement is deferred
         * to a single rebuild after the loop. Multiple fresh messages sharing a
         * cursor keep their snapshot order (appended to the same array).
         */
        const inserts = new Map<number, ChatMessage[]>();
        /**
         * Index into `next` before which the NEXT fresh message is inserted.
         * Advances to `matchedIndex + 1` past every matched (tier 1) or adopted
         * (tier 2/3) message, so a snapshot's unseen tail lands chronologically
         * AFTER the overlapping matched prefix instead of being prepended (#16).
         */
        let cursor = 0;

        const adoptAt = (idx: number, m: { id: string; text: string; ts?: number }): void => {
          // INVARIANT: `seen` and `localIndexByKey` describe `next` exactly.
          // `adoptAt` is the only thing that mutates `next` inside the loop, so
          // it is the only place that can break them.
          //
          // ⚠️ EVERY KEY BELOW IS A BUBBLE KEY, AND THAT IS CHECKED, NOT
          // ASSUMED. This closure has ONE call site — the tier-2 branch, gated
          // `if (m.role === "user")` — so the incoming row is a user bubble; and
          // `idx` comes only from the `adoptable` pool, seeded solely from
          // `isAdoptableUserEcho`, a type predicate that narrows to
          // `ChatBubble`. So the displaced entry is a bubble too, and a
          // reasoning key can never be the right one here.
          //
          // ⚠️ THE REACHABLE TRIGGER IS GONE and the earlier version of this
          // comment claiming "MEASURED DATA LOSS WITHOUT THIS LINE" no longer
          // describes this tree. It was true while AGENT rows could adopt: the
          // snapshot carried the very id being displaced as its own later row,
          // which then tier-1 "matched" a bubble it no longer occupied and was
          // dropped. Only user echoes adopt now, and the sole id a user adoption
          // can displace is a local `u-<n>` that no snapshot row ever carries.
          // Kept anyway: two lines that keep the bookkeeping unconditionally true
          // beat a live premise about what ids can appear.
          const displacedId = next[idx].id;
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
          // `displacedId !== m.id` always here (equality is a tier-1 hit, which
          // never reaches an adoption), so this cannot erase what we just set.
          seen.delete(kindKey(undefined, displacedId));
          localIndexByKey.delete(kindKey(undefined, displacedId));
          claimed.add(idx);
          localIndexByKey.set(kindKey(undefined, m.id), idx);
          adopted = true;
          cursor = idx + 1;
        };

        for (const m of incoming) {
          if (!m || typeof m !== "object") continue;
          if (typeof m.id !== "string" || m.id.length === 0) continue;
          if (typeof m.text !== "string") continue;
          /**
           * ⚠️ #242 half 2: A REASONING ROW TAKES TIER 1 OR A FRESH INSERT, AND
           * NOTHING ELSE. Four properties make that safe, and all four were
           * checked rather than assumed:
           *
           *  1. TIER 1 IS THE NORMAL OUTCOME. A reasoning id is minted by the
           *     PLUGIN (`nextMessageId()` inside the reasoning controller) and
           *     travels on the live `reasoning` frame; `journalEventForOutbound`
           *     copies that same `frame.id` into the journal row. So the id this
           *     device rendered live IS the id the snapshot carries, and
           *     `seen.has(kindKey("reasoning", m.id))` matches it — no
           *     adoption, no duplicate.
           *  2. TIER 2 CANNOT REACH IT, TWICE OVER. The adoption branch is
           *     gated `if (m.role === "user")`, which a role-less row fails; and
           *     the pool itself is seeded only from `isAdoptableUserEcho`, which
           *     tests `m.role === "user"`. So no reasoning row can adopt, and no
           *     reasoning bubble can BE adopted onto.
           *  3. A MISS FRESH-INSERTS AT THE CURSOR, exactly like an agent row
           *     that misses tier 1 — which is the right answer for the same
           *     reason: with plugin-minted ids, a miss means this device has no
           *     local counterpart at all.
           *  4. TIER 1 CAN ONLY MATCH AN ENTRY OF THE ROW'S OWN KIND, because
           *     `seen`/`localIndexByKey` are keyed by (KIND, id) rather than by
           *     id — see `kindKey` at the top of this case for why the two id
           *     spaces cannot be assumed disjoint. This was the fourth outcome
           *     the first revision of this list did not enumerate, and it was
           *     the defect: a kind-blind tier 1 counted a collision with an
           *     entry of the OTHER kind as a match and DROPPED the row — never
           *     inserted, never rendered, though it renders fine on a fresh
           *     load (N10, live≠history content loss). A miss now falls to the
           *     fresh insert, which is already the right answer for "this device
           *     has no local counterpart" (property 3).
           *
           *     ⚠️ KEYING THE INDEX IS THE FIX; A CONJUNCT ON TOP OF AN ID-KEYED
           *     INDEX WAS TRIED FIRST AND WAS WRONG. That version left the map
           *     keyed by id and guarded tier 1 with `kindAgrees`. Page 1
           *     fresh-inserted correctly — and then, because the map is
           *     LAST-WINS, `get(id)` on the resulting same-id pair resolved to
           *     the OTHER kind's entry forever, `kindAgrees` never became true
           *     again, and the row inserted AGAIN on every subsequent page.
           *     Measured: three identical pages yielded three text entries
           *     beside the one reasoning entry. A snapshot lands on every
           *     register, so unbounded duplicate growth per reconnect is worse
           *     than the drop it replaced. Keyed, page 2 is an ordinary tier-1
           *     match and the whole thing is idempotent — which is why the
           *     conjunct is gone rather than repaired.
           *
           * `turnId` is REQUIRED on this variant (the wire types it `string`),
           * so a row without one is dropped rather than inserted with a
           * fabricated correlation.
           */
          if (m.kind === "reasoning") {
            if (typeof m.turnId !== "string" || m.turnId.length === 0) continue;
            // ⚠️ THE SAME ADMISSION RULE `case "reasoning"` APPLIES LIVE. Its
            // guard is `msg.text.length === 0`, and a history row must meet it
            // too or the identical content renders from one door and not the
            // other — see the empty-row note at the top of this case.
            if (m.text.length === 0) continue;
            // Keyed, so this can only ever meet a REASONING entry (property 4).
            const key = kindKey("reasoning", m.id);
            if (seen.has(key)) {
              const li = localIndexByKey.get(key);
              if (li !== undefined) {
                cursor = li + 1;
                claimed.add(li);
              }
              continue;
            }
            seen.add(key);
            const atCursorReasoning = inserts.get(cursor) ?? [];
            atCursorReasoning.push({
              kind: "reasoning",
              id: m.id,
              turnId: m.turnId,
              text: m.text,
              ...(typeof m.ts === "number" ? { ts: m.ts } : {}),
            });
            inserts.set(cursor, atCursorReasoning);
            continue;
          }
          if (m.role !== "user" && m.role !== "agent") continue;
          // Keyed, so this can only ever meet a BUBBLE — see property 4 in the
          // reasoning branch's docblock above for the whole argument.
          const key = kindKey(undefined, m.id);
          if (seen.has(key)) {
            const li = localIndexByKey.get(key);
            // Tier-1 match: walk the cursor past this already-held message so
            // later fresh messages insert after it. A key we cannot locate
            // locally leaves the cursor untouched.
            //
            // ⚠️ THAT CASE IS REACHABLE, AND THE PARENTHETICAL THAT USED TO SIT
            // HERE DENIED IT — it read "should not happen — `seen` is seeded
            // from `next`". `seen` is ALSO added to by the fresh-insert paths
            // below, which do not touch `localIndexByKey`, so a key in `seen`
            // with no local index is the ordinary within-page repeat: still a
            // match, still a drop. It was already wrong before #242 half 2, and
            // it is cut now because keying the index makes that state the ONLY
            // way the two can disagree.
            if (li !== undefined) {
              cursor = li + 1;
              // ⚠️ CLAIM IT. A bubble already identified BY ID must not stay a
              // later row's tier-2 adoption target. Like the retirement in
              // `adoptAt`, this is now bookkeeping rather than a live fix — the
              // pool holds only unadopted `u-<n>` echoes, which cannot be
              // tier-1 matched (the journal never serves that id). The measured
              // loss it was added for was on the AGENT path, which no longer
              // adopts at all.
              //
              // `claimed` alone is sufficient: tier 2 shifts claimed indices off
              // the front of each pool before using one, so this entry is purged
              // when it is reached. No pool surgery, no loop restructuring.
              claimed.add(li);
            }
            continue;
          }

          seen.add(key);
          // Tier 2: exact text+role — ⚠️ USER ROWS ONLY, and the role test is
          // EXPLICIT rather than left to the pool being empty for agent keys.
          // Implicit-by-empty-pool is exactly the kind of coupling that produced
          // the four defects this deletion closes: it reads as "agent rows may
          // adopt, there just happens to be nothing to adopt onto", which is one
          // pool-seeding edit away from being wrong again.
          if (m.role === "user") {
            const idxs = adoptable.get(adoptKey(m.role, m.text));
            while (idxs && idxs.length > 0 && claimed.has(idxs[0])) idxs.shift();
            if (idxs && idxs.length > 0) {
              adoptAt(idxs.shift()!, m);
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
        // NULLISH, not truthy: `""` survives as a real id here, and the reducer's
        // `placement` mirrors that (BOUNDARY 1 — it is the `bubble` site below
        // that treats `""` as id-less, and the two genuinely differ).
        const answerId = id ?? "";
        // `draftOnly` is only ever CLAIMED, never ADDED to a bubble that already
        // exists without it. The bit is what makes a bubble droppable at turn end
        // (`isSpentDraft`), so adding it to a bubble that already holds authored
        // durable text would let a single stray `progress` frame turn a delivered
        // answer into a DELETED one:
        //
        //   agent_message A "FINAL ANSWER"  → [A "FINAL ANSWER"]
        //   progress      A "Working…"      → [A "Working…", draftOnly]
        //   turn_settled                    → []            ← answer destroyed
        //
        // Such a frame should never arrive (see the UNGUARDED INVARIANT note on
        // `applyPlacement`), but "should never" is not a reason to make the
        // failure unrecoverable. This project's own ordering says so:
        // `message-adapter.ts:1760-1761` — a visible duplicate is recoverable
        // where a deletion is not (M212g). So a plugin-guard regression stays a
        // wrong-text bug, repairable by the turn's `turn_snapshot`, exactly as it
        // was before the reducer rewiring.
        //
        // A bubble that is ALREADY `draftOnly` keeps the bit (idempotent
        // re-claim), and an absent one claims it — that is the normal path, and
        // it is what keeps the rolling draft out of the durable projection
        // (§15.9) while it still renders.
        // ⚠️ `m.kind === undefined` IS PART OF THE PREDICATE, exactly as in
        // `patchBubbleByReceiptKey` — the two id spaces are not provably
        // disjoint (`durable-view-reducer.ts`'s `findTextIndex` docblock), and a
        // reasoning entry found here reads as a bubble with `draftOnly`
        // undefined, so `claimsDraft` goes false, the overlay omits `draftOnly`,
        // and the rolling draft never becomes droppable at turn end — it freezes
        // as durable text.
        const heldBubble = this.state.messages.find(
          (m) => m.kind === undefined && m.id === answerId,
        );
        const claimsDraft = heldBubble === undefined || heldBubble.draftOnly === true;
        this.applyDurable(
          {
            kind: "placement",
            answerId,
            ...(msg.turnId === undefined ? {} : { turnId: msg.turnId }),
          },
          { [answerId]: { working: true, text, ...(claimsDraft ? { draftOnly: true } : {}) } },
        );
        this.setState({ isTyping: false });
        // P1-9 §3.6.2: a progress upsert on a watched draft proves the turn is
        // still alive — disarm its staleness entry.
        this.staleDraftWatch.delete(answerId);
        return;
      }

      case "reasoning": {
        if (!msg.id || !msg.turnId || typeof msg.text !== "string" || msg.text.length === 0) return;
        // ⚠️ #242 half 2: THROUGH THE SHARED REDUCER, like every other durable
        // frame. Half 1 called a private `upsertReasoning` over a side array;
        // that method is deleted, and with it the second implementation the v6
        // bet cannot afford (N8). The event is byte-identical to the one
        // `journalEventForOutbound` records for this burst's `final` frame, so a
        // replay folds the same transition this line does.
        //
        // ⚠️ EVERY FRAME, NOT JUST `final`. `msg.final` is deliberately not read
        // here: the lane streams cumulative FULL text and `applyReasoning` is an
        // upsert by id, so applying each frame renders the burst live and
        // converges on exactly the text the `final` frame carries — which is the
        // text that gets journaled. Gating on `final` would leave the live lane
        // blank until the burst closed.
        //
        // ⚠️ WHAT THIS COSTS. A reasoning frame arrives per cumulative token
        // update with no throttle, and each one now projects and re-merges the
        // WHOLE transcript instead of walking a ≤100-entry side array. It is the
        // same per-frame O(messages) the other durable frames already pay, and
        // taking a cheaper private path would be the second implementation
        // again — so the cost is accepted here and tracked as **#310**, not
        // worked around. (Named rather than left as "its own issue": every other
        // deferral in this slice cites a number, and an uncited one is a claim
        // the next reader cannot check.)
        this.applyDurable({
          kind: "reasoning",
          id: msg.id,
          turnId: msg.turnId,
          text: msg.text,
        });
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

      case "turn_snapshot": {
        this.applyTurnSnapshot(msg);
        return;
      }

      case "agent_message": {
        const { text, id } = msg;
        const assistantMessageIndex = normalizeAssistantMessageIndex(
          msg.assistantMessageIndex,
        );

        if (id) {
          this.applyDurable(
            {
              kind: "bubble",
              answerId: id,
              text: text ?? "",
              ...(msg.turnId === undefined ? {} : { turnId: msg.turnId }),
            },
            {
              [id]: {
                working: false,
                // Durable text has been authored, so the bubble is no longer a
                // draft — this is what makes it survive the turn end.
                draftOnly: undefined,
                ...(assistantMessageIndex !== undefined ? { assistantMessageIndex } : {}),
              },
            },
            { isTyping: false },
          );
          // P1-9 §3.6.2: the final upsert also proves liveness — disarm.
          this.staleDraftWatch.delete(id);
          return;
        }

        // Preserve the legacy id-less path's existing two public transitions:
        // typing clears before the client-local bubble id is minted/applied.
        this.setState({ isTyping: false });

        // LEGACY-PLUGIN PATH ONLY. Since #238 every durable egress site mints an
        // id at the delivery act, so a durable frame reaching here means an older
        // plugin build. The text is never dropped (NOT-list N10): it still gets a
        // bubble, via a client-local `a-<n>`.
        //
        // Minting that id and feeding it to the reducer is admissible precisely
        // because it NEVER LEAVES THE CLIENT. What BOUNDARY 1 forbids (N4/N5) is
        // a viewer-minted id entering the SHARED EVENT STREAM, where it would
        // write viewer-side identity into the SSOT. Kept inside this local view
        // it does the opposite of harm: routing it through the reducer is what
        // removes the N8 divergence the old `appendMessage` branch created, where
        // the live view held a bubble the reducer's view did not.
        const mintedId = this.mintLocalBubbleId("a");
        if (!this.warnedIdlessDurableFrame) {
          this.warnedIdlessDurableFrame = true;
          console.warn(
            "[nats-wrapper] durable agent_message arrived without an id; " +
              "rendering it under a client-local id. This is a legacy-plugin " +
              "path — since #238 the plugin mints the id at the delivery act.",
          );
        }
        this.applyDurable(
          {
            kind: "bubble",
            answerId: mintedId,
            text: text ?? "",
            ...(msg.turnId === undefined ? {} : { turnId: msg.turnId }),
          },
          assistantMessageIndex !== undefined
            ? { [mintedId]: { assistantMessageIndex } }
            : undefined,
        );
        return;
      }
    }
  }
}
