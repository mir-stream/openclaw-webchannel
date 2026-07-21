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
  state: NonNullable<ChatMessage["sendState"]>;
  failure?: SendFailure;
  subscribers: Set<(s: { state: ChatMessage["sendState"]; failure?: SendFailure }) => void>;
};
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

export class WebChannelNATSClient {
  private readonly natsOptions: DirectClientOptions;
  private readonly client: WebChannelNatsClient;

  private state: WebChannelState = {
    messages: [],
    reasoning: [],
    approvals: [],
    status: "connecting",
    connected: false,
    // Learned from the register handshake; null until a register completes.
    agentProtocolVersion: null,
    agentPluginVersion: null,
  };

  private readonly listeners = new Set<Listener>();

  /**
   * P1-9: user messages HELD locally because a turn was in flight at send time
   * (the local twin of the server-side coalesce buffer). Insertion-ordered;
   * released FIFO once the turn settles AND the session key exists. Each entry's
   * `localId` is the id of its `pending: true` transcript bubble.
   */
  private readonly held: Array<{ localId: string; text: string; receiptKey: string }> = [];

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
    };

    this.client = new WebChannelNatsClient(this.natsOptions);

    // Wire up message listener
    this.client.onMessage((msg: InboundMessage) => this.handleMessage(msg));

    // Wire up state listener.
    this.client.onState((connected: boolean) => {
      if (!connected) {
        // P1-9: the conversation key is gone on ANY disconnect — close the
        // release gate and clear the connection-scoped staleness valve. Done
        // BEFORE the terminal early-return below so neither depends on that
        // branch; the valve re-arms fresh on the next onSession (§3.6.2).
        this.sessionEstablished = false;
        this.clearStaleDraftWatch();
      }
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
      this.setState({
        status: connected ? "connected" : "reconnecting",
        connected,
        ...(connected ? { error: undefined, errorCause: undefined } : { isTyping: false }),
      });
      // P1-9: a connection flip is a state transition — re-evaluate the release
      // gate (a no-op unless the key is up and nothing is in flight).
      this.maybeRelease();
    });

    // P1-9 §3.2/§3.6.2: session KEY established (both register-unwrap and legacy
    // handshake paths, strictly AFTER flushQueue). Open the release gate, arm the
    // staleness valve fresh, and try to release — ordered behind the ledger replay.
    this.client.onSession(() => {
      // P0-4 (R4): defense in depth — a retired instance must never open the
      // release gate, arm the staleness valve, or release, even if a stray
      // onSession somehow fired. The mid-level `onConnected` terminal guard is the
      // root fix; this makes the wrapper safe regardless.
      if (this.terminal) return;
      this.sessionEstablished = true;
      this.armStaleDraftWatch();
      this.maybeRelease();
    });

    // P0-4: the authoritative tracker drives every send-state transition. Route
    // it through the wireId → receiptKey alias to the receipt record + render
    // bubble. A wireId with no local receipt (a direct/internal send) is ignored.
    this.client.onSendState((wireId: string, state: SendState, failure?: SendFailure) => {
      const receiptKey = this.wireIdToReceiptKey.get(wireId);
      if (receiptKey) this.receiptTransition(receiptKey, state, failure);
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
      // P0-4 (D5 held/terminal): the queued/ledgered sends were already swept to
      // failed{terminal} by the low-level terminal sequence BEFORE this listener
      // ran; fail the wrapper-owned held[] here (they have no wireId, so the sweep
      // could not reach them). Retracted bubbles are preserved by failHeld.
      this.failHeld({ reason: "terminal", cause: cause ?? "unknown", retryable: false });
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
      // P1-7: carry the machine-readable cause onto state so the embedder picks
      // truthful wording + the right recovery affordance. A classified emit site
      // supplies its cause; an unclassified failure falls back to "unknown".
      this.setState({
        status: "error",
        connected: false,
        error: err.message,
        errorCause: cause ?? "unknown",
        isTyping: false,
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
    if (!this.terminal) this.closed = false;
    this.client.connect();
  }

  /** Disconnect from NATS */
  close(): void {
    // P0-4 (review): gate holding FIRST — a send arriving after this close (or
    // re-entrantly, from a listener the sweep below fires) must publish and
    // resolve to failed{closed} via the low-level `disconnected` gate, never land
    // in `held[]` whose only drain (onSession) this instance will never fire.
    this.closed = true;
    // P1-9: tear down the connection-scoped staleness valve (§3.6.2).
    this.clearStaleDraftWatch();
    this.client.disconnect();
    // P0-4 (D5): fail the wrapper-owned held[] (no wireId → invisible to the
    // low-level fail-all).
    //
    // P0-4 (review R3): this runs LAST, after the teardown, because it NOTIFIES
    // (receiptTransition → setState → embedder state subscribers) and the
    // mutate-before-notify discipline requires the teardown to be COMPLETE before
    // anything observes it. It used to run first, so an embedder reacting to a
    // failed send by calling `connect()` — an ordinary auto-reconnect reflex —
    // dialed from inside this sweep and the trailing `client.disconnect()` then
    // killed that dial: `closed` was back to false with no socket and no reconnect
    // armed, `close()` deliberately leaves `working` drafts live so turnInFlight()
    // stayed true forever, and the next send() was held with no possible drain
    // (onSession never fires again) — permanently `queued`. The old comment
    // justified the old order as "held transitions land before the queue/ledger
    // sweep"; that notification order between two independent receipt groups is
    // cosmetic (nothing in the tests or the D5 contract depends on it), and a
    // consistent post-teardown state is worth more than it.
    this.failHeld({ reason: "closed", retryable: false });
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
        this.markHeldRetracted();
        // §3.4: /stop means "stop everything". Also locally finalize the live
        // turn-in-flight state (working drafts AND the typing indicator) so the
        // composer unwedges even when a turn dies WITHOUT a disconnect (agent
        // dies with the socket alive) — the staleness valve only arms on
        // reconnect, so without this /stop cannot rescue a socket-alive wedge.
        // Covers both a working-draft hang and a pre-first-token typing-only
        // hang. NL abort words do NOT call this.
        this.finalizeLocalTurnState();
      }
      // Control-lane text is a real published user message → a normal receipt.
      return this.publish(trimmed);
    }

    // P1-9 §3.1: hold while a turn is in flight OR anything is already held. The
    // `held.length > 0` latch preserves FIFO across a disconnect (onState(false)
    // forces isTyping:false, so without the latch a send during the reconnect
    // window would publish ahead of an earlier held message).
    if (this.shouldHold()) {
      const receiptKey = this.newReceiptKey();
      const localId = `u-${this.uid()}`;
      this.held.push({ localId, text: trimmed, receiptKey });
      // P0-4: a held send has a receipt (queued) but NO wireId yet — the wireId
      // is minted at release (2-phase). The receiptKey is the stable handle.
      this.receipts.set(receiptKey, { id: receiptKey, state: "queued", subscribers: new Set() });
      this.appendMessage({
        id: localId, role: "user", text: trimmed, pending: true, receiptKey, sendState: "queued",
      });
      return this.makeReceipt(receiptKey);
    }

    return this.publish(trimmed);
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
    if (hi !== -1) this.held.splice(hi, 1);
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
   * alias + render bubble, THEN call `sendUserMessage(text, wireId)`. The old code
   * called sendUserMessage FIRST, so its synchronous `queued`/`sent`/immediate-
   * `failed` transitions fired before the bubble existed and were lost. Reserving
   * up front guarantees every transition lands on the already-registered receipt.
   */
  private publish(trimmed: string): SendReceipt {
    const receiptKey = this.newReceiptKey();
    const wireId = this.client.reserveWireId();
    this.wireIdToReceiptKey.set(wireId, receiptKey);
    this.receipts.set(receiptKey, { id: receiptKey, state: "queued", subscribers: new Set() });
    this.appendMessage({
      id: `u-${this.uid()}`,
      role: "user",
      text: trimmed,
      wireId,
      turnId: wireId,
      receiptKey,
      sendState: "queued",
    });
    this.client.sendUserMessage(trimmed, wireId);
    return this.makeReceipt(receiptKey);
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
    // P0-4 (review): never hold after an explicit close() either — held[] drains
    // only on onSession, which a closed instance never fires, so a hold here is a
    // permanent `queued`. Publish instead → immediate failed{closed}.
    if (this.closed) return false;
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
   * than snapshot-and-clear before the loop. Each per-bubble `setState()` fires
   * listeners synchronously mid-loop; a listener calling `send()` re-entrantly
   * must NOT jump the queue. With a live drain the still-unreleased entries are
   * genuinely present in `held[]`, so `shouldHold()` (`held.length > 0`) still
   * holds that new message and the continuing `while` loop picks it up in FIFO
   * order — a snapshot-and-clear would leave `held[]` empty mid-loop and let the
   * re-entrant send publish AHEAD of the not-yet-released entries (M1, M3, M2).
   * Two behaviors this preserves: (a) a re-entrant `retract()` of a not-yet-
   * released held item splices it out of the live array, so `shift()` never
   * reaches it — its publish is cancelled; (b) the last entry's listener calling
   * `send()` runs only AFTER that entry's `sendUserMessage` already fired, so
   * order stays correct.
   */
  private maybeRelease(): void {
    if (
      this.held.length === 0 ||
      this.turnInFlight() ||
      !this.state.connected ||
      !this.sessionEstablished
    ) {
      return;
    }
    while (this.held.length > 0) {
      const { localId, text, receiptKey } = this.held.shift()!;
      // P0-4 commit order: reserve the wireId, register the alias, MOVE the bubble
      // to the tail (with wireId), THEN publish — so the synchronous `sent`
      // transition patches an already-present, correctly-keyed bubble.
      const wireId = this.client.reserveWireId();
      this.wireIdToReceiptKey.set(wireId, receiptKey);
      const bubble = this.state.messages.find((m) => m.id === localId);
      // A re-entrant listener may have already removed the bubble; the text is
      // still published (correct — release is a commit), so just skip the patch.
      if (bubble) {
        const messages = this.state.messages.filter((m) => m.id !== localId);
        messages.push({ ...bubble, pending: false, wireId, turnId: wireId });
        this.setState({ messages });
      }
      this.client.sendUserMessage(text, wireId);
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
    if (this.held.length === 0) return;
    const entries = this.held.splice(0);
    for (const e of entries) {
      this.receiptTransition(e.receiptKey, "failed", failure, { pending: false });
    }
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
    if (!changed && !clearTyping) return;
    this.setState({
      ...(changed ? { messages } : {}),
      ...(clearTyping ? { isTyping: false } : {}),
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
    this.staleDraftWatch.clear();
    if (changed) this.setState({ messages });
    this.maybeRelease();
  }

  /** Send approval decision */
  decide(id: string, decision: ApprovalDecision): void {
    this.patchApproval(id, (a) =>
      a.resolvedDecision === undefined
        ? { ...a, resolvedDecision: decision }
        : a,
    );
    this.client.sendApprovalDecision(id, decision);
  }

  /** Request history page */
  loadHistory(request?: { before?: string; limit?: number }): void {
    this.client.loadHistory(request?.before, request?.limit);
  }

  /**
   * Request the slash-command discovery catalog (P0-3). The agent answers with
   * a `commands` frame that lands in `state.commands`. UI calls this the first
   * time the user types `/` (lazy discovery); repeat calls are cheap and simply
   * refresh the catalog.
   */
  loadCommands(): void {
    this.client.loadCommands();
  }

  // ---------------------------------------------------------------------------
  // State management
  // ---------------------------------------------------------------------------

  /**
   * P0-4: the try/catch is load-bearing, not defensive politeness. Under the D4
   * commit order the actual `sendUserMessage` runs AFTER the bubble is rendered
   * (`publish()`, and per-entry inside the `maybeRelease()` drain loop), so an
   * embedder listener that throws here would abort the caller BEFORE the frame
   * is ever published — leaving the receipt stuck at `queued` forever (the exact
   * invariant P0-4 exists to forbid), leaking the reserved wireId + its alias,
   * and in the release case stranding every remaining `held[]` entry behind the
   * aborted `while` loop. An embedder's render bug must never cost a send.
   */
  private setState(patch: Partial<WebChannelState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) {
      try {
        listener(this.state);
      } catch (e) {
        console.error("[nats-wrapper] state listener threw:", e);
      }
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
      snapshot: () => {
        const rec = this.receipts.get(receiptKey);
        // A record always exists for a receipt we handed out; the fallback keeps
        // the type total. `failed` would only surface if a record were ever
        // dropped, which never happens (records are never deleted).
        return rec ? { state: rec.state, failure: rec.failure } : { state: "failed" as const };
      },
      subscribe: (cb) => {
        const rec = this.receipts.get(receiptKey);
        if (!rec) return () => {};
        rec.subscribers.add(cb);
        return () => { rec.subscribers.delete(cb); };
      },
    };
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
   * (which alone knows `completed`). Order is mutate-before-notify: update the
   * record, patch the bubble (fires state listeners), THEN notify receipt
   * subscribers. A rejected transition (guard) touches nothing.
   */
  private receiptTransition(
    receiptKey: string,
    state: NonNullable<ChatMessage["sendState"]>,
    failure?: SendFailure,
    extraBubblePatch?: Partial<ChatMessage>,
  ): void {
    const rec = this.receipts.get(receiptKey);
    if (!rec || !this.receiptAdvances(rec.state, state)) return;
    rec.state = state;
    rec.failure = failure;
    this.patchBubbleByReceiptKey(receiptKey, { sendState: state, sendFailure: failure, ...(extraBubblePatch ?? {}) });
    for (const cb of [...rec.subscribers]) {
      try {
        cb({ state, failure });
      } catch (e) {
        console.error("[nats-wrapper] receipt subscriber threw:", e);
      }
    }
  }

  /** Patch the render bubble carrying `receiptKey` (a no-op if it was retracted). */
  private patchBubbleByReceiptKey(receiptKey: string, patch: Partial<ChatMessage>): void {
    const idx = this.state.messages.findIndex((m) => m.receiptKey === receiptKey);
    if (idx === -1) return;
    const messages = this.state.messages.slice();
    messages[idx] = { ...messages[idx], ...patch };
    this.setState({ messages });
  }

  /**
   * P0-4 (§1 coalesce anchor): promote the ANCHOR user bubble of `turnId` — the
   * one whose wireId === turnId — to `completed` (outcome ok) or fail it
   * `turn-failed` (outcome error). A coalesced non-anchor send (wireId ≠ turnId)
   * is intentionally left at `accepted`: admission is guaranteed, turn outcome is
   * observed per turn.
   */
  private promoteAnchor(turnId: string, state: "completed" | "failed", failure?: SendFailure): void {
    const anchor = this.state.messages.find((m) => m.role === "user" && m.wireId === turnId);
    if (anchor?.receiptKey) this.receiptTransition(anchor.receiptKey, state, failure);
  }

  // ---------------------------------------------------------------------------
  // Message handling
  // ---------------------------------------------------------------------------

  private handleMessage(msg: InboundMessage): void {
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
          // converges to exactly what a reloading device would render.
          next[idx] = { ...next[idx], id: m.id, text: m.text, ts: m.ts };
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
              this.client.sendApprovalDecision(a.id, a.resolvedDecision);
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

      case "turn_settled": {
        this.setState({ isTyping: false });
        // P1-9 §3.6.1: settled ⇒ no more upserts — finalize any lingering working
        // draft whose turnId matches (in the normal flow the final agent_message
        // already did this, a no-op). Never swaps the id.
        this.finalizeDraftsForTurn(msg.turnId);
        // P0-4 (§1): promote the send only on an EXPLICIT outcome. `"ok"` →
        // `accepted → completed` on the anchor (turnId === wireId); `"error"` →
        // `failed{turn-failed, retryable:true}`. ABSENT `outcome` = legacy plugin
        // (fires turn_settled from a finally regardless of success): the UI still
        // settles above, but the send honestly stays `accepted` — never a
        // fabricated `completed`. A turn_settled that beats the ack promotes
        // straight past `sent` (the receipt guard allows the monotonic upgrade).
        if (msg.turnId && msg.outcome === "ok") {
          this.promoteAnchor(msg.turnId, "completed");
        } else if (msg.turnId && msg.outcome === "error") {
          this.promoteAnchor(msg.turnId, "failed", { reason: "turn-failed", retryable: true });
        }
        return;
      }

      case "agent_message": {
        const { text, id } = msg;
        this.setState({ isTyping: false });

        if (id) {
          this.upsertMessage(
            id,
            (prev) => ({ ...prev, text: text ?? "", working: false, turnId: msg.turnId ?? prev.turnId }),
            { id, role: "agent", text: text ?? "", working: false, turnId: msg.turnId },
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
        });
        return;
      }
    }
  }
}
