import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, WebSocket } from "ws";

import type { ConnectionVerifier } from "./auth.js";
// `ANON_PEER_ID` is owned by the auth module (the anonymous peer is an auth
// decision). Re-export it here so existing importers (transport.test.ts,
// inbound.ts) keep their import path. This file stays SDK-free.
import { ANON_PEER_ID } from "./auth.js";
import type { HistoryMessage } from "./history.js";

/**
 * The channel id is the fixed key the rest of OpenClaw uses to route to us.
 */
export const WEBCHANNEL_ID = "webchannel";

export { ANON_PEER_ID };

/**
 * Message envelope exchanged with the browser widget.
 *
 * Inbound stays plain text. Outbound now has three shapes:
 *  - `agent_message` WITHOUT id  : legacy/no-draft final reply (appended).
 *  - `progress`     WITH id      : a rolling "working…" draft; same id ⇒ replace.
 *  - `agent_message` WITH id     : finalize the draft `id` into the final answer.
 *
 * The `id` correlates a progress draft with its eventual finalization so the
 * widget can render a SINGLE bubble that updates in place, then transitions to
 * the final text (Phase 1 progress-draft slice).
 */
/**
 * The three approval decisions the gateway accepts. Matches the SDK's
 * `ExecApprovalDecision` exactly (verified:
 * dist/plugin-sdk/exec-approvals-SqmRBcMF.d.ts:484
 * `"allow-once" | "allow-always" | "deny"`). We re-declare it locally so the
 * transport has no SDK import; `src/approvals.ts` asserts it stays in sync.
 */
export type ApprovalDecision = "allow-once" | "allow-always" | "deny";

/** One offered approval button, projected from `ApprovalActionView`. */
export type ApprovalOption = {
  decision: ApprovalDecision;
  label: string;
  /** Visual hint; mirrors InteractiveButtonStyle (success|primary|danger|...). */
  style: string;
};

/**
 * Payload for an `approval_request` outbound frame. Built from a
 * `PendingApprovalView` in src/approvals.ts. `prompt` is a short human-readable
 * one-liner (title + command/tool) for accessibility / non-button fallback.
 */
export type ApprovalRequestPayload = {
  id: string;
  kind: "exec" | "plugin";
  title: string;
  description?: string;
  prompt: string;
  options: ApprovalOption[];
  expiresAtMs?: number;
};

export type InboundWsMessage =
  | { type: "user_message"; text: string; id?: string }
  | { type: "approval_decision"; id: string; decision: ApprovalDecision }
  /**
   * History pagination request. Emitted by the widget when the user scrolls up
   * past the hydrated bubble list and asks for more. The server replies with
   * the same `{type:"history", messages:[...]}` frame used for the initial
   * snapshot — the client deduplicates by id so an overlapping window is a
   * no-op. `before` is the oldest message id currently in the widget; omit to
   * fetch the oldest page available (the widget never does this in this seed
   * — the trigger is always user-initiated).
   */
  | { type: "load_history"; before?: string; limit?: number };
export type OutboundWsMessage =
  | { type: "agent_message"; text: string; id?: string; turnId?: string }
  | { type: "progress"; id: string; text: string; turnId?: string }
  | { type: "reasoning"; id: string; turnId: string; text: string }
  | { type: "turn_settled"; turnId: string }
  | ({ type: "approval_request" } & ApprovalRequestPayload)
  | { type: "approval_resolved"; id: string; decision: ApprovalDecision }
  /**
   * Authoritative pending-approval snapshot (#15). Emitted on every successful
   * register alongside the history snapshot, carrying the peer's COMPLETE set of
   * still-pending approvals for that account. An empty `approvals` array is a
   * meaningful signal — it tells a reconnecting client that nothing is pending,
   * so a card left actionable by a missed `approval_resolved` is retired. The
   * client reconciles its approval state against this set (see the client
   * wrapper's `approval_snapshot` handler).
   *
   * `resolved` (#19, OPTIONAL) carries recently-RESOLVED outcomes so the client's
   * Leg B can show the actual decision rather than a neutral "resolved
   * (elsewhere)". Optional so an older client that ignores the field, and an
   * older plugin that never sends it, both stay compatible.
   */
  | {
      type: "approval_snapshot";
      approvals: ApprovalRequestPayload[];
      resolved?: Array<{ id: string; decision: ApprovalDecision }>;
    }
  /**
   * Native "agent is typing" affordance. The server pushes exactly one of these
   * at the start of a turn; the client flips `isTyping:true` and lets the first
   * `progress` / `agent_message` (or `approval_*`) frame clear it automatically.
   * No payload — keeping it constant makes the wire envelope trivially diff-able
   * against the existing `OutboundWsMessage` union.
   */
  | { type: "typing" }
  /**
   * History snapshot / pagination response. Emitted exactly ONCE per
   * connection after the first heartbeat proves the socket is alive, AND in
   * response to a `load_history` request. `messages` are the
   * normalized `{id, role, text, ts}` bubbles the widget prepends to its
   * transcript (dedup by id).
   */
  | { type: "history"; messages: HistoryMessage[] };

const APPROVAL_DECISIONS: readonly ApprovalDecision[] = [
  "allow-once",
  "allow-always",
  "deny",
];

function isApprovalDecision(value: unknown): value is ApprovalDecision {
  return (
    typeof value === "string" &&
    (APPROVAL_DECISIONS as readonly string[]).includes(value)
  );
}

/**
 * Heartbeat period. Every tick we evict any socket that did not answer the
 * previous tick's ping (half-open TCP), then ping the survivors. Overridable
 * via the constructor so tests can drive it with fake timers on a short period.
 */
const DEFAULT_HEARTBEAT_MS = 30_000;

/**
 * Backpressure cap. If a socket's outbound buffer is already above this many
 * bytes we DROP the frame rather than pile on (a slow/stalled client must not
 * make us buffer unboundedly → OOM). 1 MB tolerates a healthy burst of progress
 * frames while still bounding worst-case memory per socket.
 */
const MAX_BUFFERED_BYTES = 1_000_000;

/** Per-connection heartbeat liveness, kept off the (untyped) ws object. */
type Liveness = {
  alive: boolean;
  /**
   * History-snapshot dedupe flag. The transport fires the initial snapshot
   * once per connection (on the first pong — proof the socket is alive); the
   * flag prevents a re-fire on subsequent pongs. A fresh upgrade gets a fresh
   * Liveness, so a reconnect naturally re-sends.
   */
  historySent?: boolean;
};

/**
 * Owns the (noServer) WebSocketServer and the live connection map.
 *
 * The gateway owns the listening socket; we never call `.listen()`. We only
 * handle upgrade requests the gateway hands us via `handleUpgrade`.
 */
export class WebChannelTransport {
  private readonly wss: WebSocketServer;

  /**
   * sessionKey -> live socket. Phase 0 maps everything to one anon peer, so this
   * holds at most one entry per anon connection. The structure already supports
   * multi-session for Phase 1.
   */
  private readonly sockets = new Map<string, WebSocket>();

  /** Called when the browser sends a user message on a given sessionKey. */
  private onMessage?: (sessionKey: string, message: InboundWsMessage) => void;

  /**
   * Called when the browser clicks an approval button (`approval_decision`).
   * Distinct from the user-message handler so the channel can route the
   * decision to `resolveApprovalOverGateway` instead of the agent turn path.
   */
  private onApprovalDecision?: (
    sessionKey: string,
    id: string,
    decision: ApprovalDecision,
  ) => void;

  /**
   * Verifies each upgrade request and yields the connection identity, or null to
   * reject. Injected at startup (see `setVerifier`); until set, every upgrade is
   * rejected — we never accept an unauthenticated connection by accident.
   */
  private verifier?: ConnectionVerifier;

  /** Liveness tracking for the ping/pong heartbeat, keyed by socket. */
  private readonly liveness = new WeakMap<WebSocket, Liveness>();

  /** The single heartbeat interval; started lazily on first connection. */
  private heartbeat?: ReturnType<typeof setInterval>;

  private readonly heartbeatMs: number;

  /** Set once we've logged a backpressure drop, so we don't spam the log. */
  private warnedBackpressure = false;

  /**
   * Whether `sendTyping(...)` is allowed to emit a `typing` frame. Defaults to
   * enabled so the standard "Bot is typing…" affordance works out of the box
   * (PLAN §US2: no extra config needed); an operator can disable it via
   * `channels.webchannel.capabilities.typing = "off"`, in which case
   * `sendTyping` is a no-op. Toggled by `setTypingEnabled` during plugin init.
   */
  private typingEnabled = true;

  /**
   * Whether `sendHistory(...)` is allowed to emit a `history` frame. Mirrors
   * the typing gate (PLAN §US3: operators tune on/off); the seed default is
   * "on" so a returning user sees the prior conversation. Toggled by
   * `setHistoryEnabled` during plugin init.
   */
  private historyEnabled = true;

  /**
   * Called when the browser asks for older messages
   * (`{type:"load_history", before?, limit?}`). The handler resolves the
   * page via `history.ts` (sessionKey-scoped) and calls back into the
   * transport via `sendHistory`. Distinct from the user-message handler so
   * it never enters the agent turn pipeline.
   */
  private onLoadHistory?: (
    sessionKey: string,
    request: { before?: string; limit?: number },
  ) => void;

  /**
   * Called the FIRST time the server receives a pong from a given socket
   * (i.e. after the heartbeat proves the connection is alive). The inbound
   * path uses this as the trigger to push the initial history snapshot via
   * `history.recent(...)` + `sendHistory(...)`. Late pongs do NOT re-fire.
   */
  private onFirstLiveness?: (sessionKey: string) => void;

  constructor(options?: { heartbeatMs?: number }) {
    this.wss = new WebSocketServer({ noServer: true });
    this.heartbeatMs = options?.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  }

  /**
   * Heartbeat: detect & evict half-open sockets. On each tick, any socket that
   * did NOT answer last tick's ping with a pong is `terminate()`d (which fires
   * `close` → existing cleanup removes it from the map); survivors are marked
   * not-alive and pinged again. The timer is `unref()`d so it never keeps the
   * process alive, and is a no-op when there are no sockets.
   */
  private ensureHeartbeat(): void {
    if (this.heartbeat) return;
    this.heartbeat = setInterval(() => {
      for (const ws of this.sockets.values()) {
        // A throw here must never escape the interval callback (that would crash
        // the gateway process). Guard the whole per-socket body; on any failure
        // drop the offending socket and move on.
        try {
          const state = this.liveness.get(ws);
          if (state && !state.alive) {
            // Missed the previous round-trip → assume half-open, evict it.
            ws.terminate();
            continue;
          }
          if (state) state.alive = false;
          ws.ping();
        } catch {
          try {
            ws.terminate();
          } catch {
            // already dead — nothing to do.
          }
        }
      }
    }, this.heartbeatMs);
    // Never let the heartbeat hold the event loop open on its own.
    this.heartbeat.unref?.();
  }

  /**
   * Stop the heartbeat timer and drop all connections. Call on plugin/transport
   * teardown so we don't leak a timer. Idempotent.
   */
  dispose(): void {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = undefined;
    }
    for (const ws of this.sockets.values()) {
      try {
        ws.terminate();
      } catch {
        // ignore — already dead.
      }
    }
    this.sockets.clear();
  }

  /**
   * Single send chokepoint. Returns true if the frame was handed to `ws.send`.
   *
   * Guards on (1) the socket being OPEN and (2) its outbound buffer staying
   * under MAX_BUFFERED_BYTES. Under extreme backpressure we DROP the frame and
   * return false rather than buffer unboundedly. Progress frames are inherently
   * droppable (the next progress/finalize supersedes them); finalize / legacy /
   * approval frames are important, but dropping one under sustained
   * backpressure is still safer than running the process out of memory. Callers
   * that care about delivery already observe the boolean return.
   */
  private safeSend(ws: WebSocket, payload: OutboundWsMessage): boolean {
    if (ws.readyState !== WebSocket.OPEN) return false;
    if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
      if (!this.warnedBackpressure) {
        this.warnedBackpressure = true;
        console.warn(
          "[webchannel] dropping outbound frame: socket buffer over backpressure cap",
        );
      }
      // A progress frame is superseded by the next update/finalize, so dropping
      // it is harmless. `typing` and `history` are also drop-only — typing is a
      // transient affordance ("Bot is typing…") and the next progress/agent_message
      // frame already in flight (or about to be sent) will be the one the widget
      // settles on; `history` is a one-shot snapshot and the client can always
      // request a fresh page via `load_history` if it missed it. Terminating
      // the socket over a missed typing ping or a missed history snapshot would
      // be disproportionate. But dropping a TERMINAL frame (finalize / legacy
      // answer / approval) on a socket the heartbeat won't rescue — it still
      // pongs, so it is never evicted — would wedge the widget (a "working"
      // bubble that never settles, or an approval prompt the user never sees).
      // Terminate such a socket so the client reconnects (settling orphaned
      // drafts) and retries.
      if (
        payload.type !== "progress" &&
        payload.type !== "reasoning" &&
        payload.type !== "typing" &&
        payload.type !== "history"
      ) {
        try {
          ws.terminate();
        } catch {
          // already dead — nothing to do.
        }
      }
      return false;
    }
    ws.send(JSON.stringify(payload));
    return true;
  }

  setMessageHandler(
    handler: (sessionKey: string, message: InboundWsMessage) => void,
  ): void {
    this.onMessage = handler;
  }

  setApprovalDecisionHandler(
    handler: (
      sessionKey: string,
      id: string,
      decision: ApprovalDecision,
    ) => void,
  ): void {
    this.onApprovalDecision = handler;
  }

  /** Inject the connection verifier (run on every upgrade). */
  setVerifier(verifier: ConnectionVerifier): void {
    this.verifier = verifier;
  }

  /**
   * Toggle the typing-indicator wire frame. Called once at plugin init from
   * `index.ts` with the resolved `channels.webchannel.capabilities.typing`
   * value (default "on"). When disabled, `sendTyping` is a no-op and returns
   * `false` so callers don't have to gate at the call site.
   */
  setTypingEnabled(enabled: boolean): void {
    this.typingEnabled = enabled;
  }

  /**
   * Toggle the history-snapshot wire frame. Called once at plugin init from
   * `index.ts` with the resolved `channels.webchannel.history.enabled` value
   * (default `true`). When disabled, `sendHistory` is a no-op and returns
   * `false`, AND the first-pong snapshot is skipped (the Liveness flag is
   * still set so a re-enable during the same connection does NOT retro-fire —
   * "1 connection 1 snapshot" is enforced regardless of operator toggles).
   */
  setHistoryEnabled(enabled: boolean): void {
    this.historyEnabled = enabled;
  }

  /**
   * Register the handler invoked when the browser sends
   * `{type:"load_history", before?, limit?}`. The handler resolves the
   * request against the core session store (see `src/history.ts`) and calls
   * `sendHistory(...)` to push the page back. Mirrors the approval-decision
   * dispatcher: a separate handler keeps load_history out of the user-message
   * path so it never enters the agent turn pipeline.
   */
  setLoadHistoryHandler(
    handler: (
      sessionKey: string,
      request: { before?: string; limit?: number },
    ) => void,
  ): void {
    this.onLoadHistory = handler;
  }

  /**
   * Register the handler invoked the FIRST time the server sees a pong from
   * a given socket. The inbound path uses this to push the initial history
   * snapshot via `history.recent(...)` + `sendHistory(...)` — fires exactly
   * once per connection (gated by `Liveness.historySent`).
   */
  setFirstLivenessHandler(handler: (sessionKey: string) => void): void {
    this.onFirstLiveness = handler;
  }

  /**
   * Reject an upgrade by writing a 401 and destroying the raw socket. We never
   * call `wss.handleUpgrade`, so no WebSocket is ever created for the request.
   */
  private rejectUpgrade(socket: Duplex): void {
    try {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    } catch {
      // socket may already be gone — fall through to destroy.
    }
    socket.destroy();
  }

  /**
   * Wire a raw Node upgrade request (handed over by the gateway) into `ws`.
   *
   * The verifier runs BEFORE we accept: on null/throw we reject (401 + destroy)
   * and never upgrade; on success the resolved `peerId` becomes the session key.
   * This is the single auth seam (AUTH.md §3).
   */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    // Defensive: a missing verifier means startup wiring failed. Refuse rather
    // than silently accepting an unauthenticated connection.
    const verifier = this.verifier;
    if (!verifier) {
      this.rejectUpgrade(socket);
      return;
    }
    void Promise.resolve()
      .then(() => verifier(req))
      .then((identity) => {
        if (!identity) {
          this.rejectUpgrade(socket);
          return;
        }
        this.wss.handleUpgrade(req, socket, head, (ws) => {
          this.registerConnection(ws, identity.peerId);
        });
      })
      .catch(() => {
        // A throwing verifier is an auth failure, not a crash: reject the socket.
        this.rejectUpgrade(socket);
      });
  }

  private registerConnection(ws: WebSocket, peerId: string = ANON_PEER_ID): void {
    // The verified per-connection identity is the session key. (Defaults to the
    // anon peer so the existing single-arg test/usage stays valid.)
    const sessionKey = peerId;
    this.sockets.set(sessionKey, ws);

    // Start the heartbeat lazily and seed this socket as alive; each pong
    // re-arms it for the next tick. `historySent` is the once-per-connection
    // dedupe flag the first-pong snapshot fires through.
    this.liveness.set(ws, { alive: true });
    ws.on("pong", () => {
      const state = this.liveness.get(ws);
      if (state) state.alive = true;
      if (state && !state.historySent) {
        state.historySent = true;
        // Best-effort: a throwing handler MUST NOT kill the pong callback (it
        // would surface as an unhandledRejection on the event loop). The
        // handler itself is responsible for its own error swallowing; we
        // additionally defensively catch here.
        try {
          this.onFirstLiveness?.(sessionKey);
        } catch {
          /* swallow — history is best-effort, never fatal */
        }
      }
    });
    this.ensureHeartbeat();

    ws.on("message", (data) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(typeof data === "string" ? data : data.toString());
      } catch {
        return; // ignore malformed frames in Phase 0
      }
      if (!parsed || typeof parsed !== "object") return;
      const frame = parsed as Record<string, unknown>;
      if (frame.type === "user_message" && typeof frame.text === "string") {
        this.onMessage?.(sessionKey, {
          type: "user_message",
          text: frame.text,
        });
        return;
      }
      // Approval button click. Validate `decision` against the three allowed
      // strings (same defensive guard as user_message); ignore malformed frames.
      if (
        frame.type === "approval_decision" &&
        typeof frame.id === "string" &&
        isApprovalDecision(frame.decision)
      ) {
        this.onApprovalDecision?.(sessionKey, frame.id, frame.decision);
        return;
      }
      // History pagination request. Validate the optional cursor (`before`)
      // and limit; ignore malformed frames (a client that sends garbage here
      // just doesn't get a page — it doesn't crash the connection).
      if (frame.type === "load_history") {
        const before =
          typeof frame.before === "string" && frame.before.length > 0
            ? frame.before
            : undefined;
        const rawLimit = frame.limit;
        const limit =
          typeof rawLimit === "number" && Number.isFinite(rawLimit) && rawLimit > 0
            ? Math.floor(rawLimit)
            : undefined;
        this.onLoadHistory?.(sessionKey, { before, limit });
      }
    });

    const cleanup = () => {
      this.liveness.delete(ws);
      // Only delete if this exact socket is still the mapped one.
      if (this.sockets.get(sessionKey) === ws) {
        this.sockets.delete(sessionKey);
      }
    };
    ws.on("close", cleanup);
    ws.on("error", cleanup);
  }

  /** Resolve the open socket for `sessionKey`, or undefined if none/closed. */
  private openSocket(sessionKey: string): WebSocket | undefined {
    const ws = this.sockets.get(sessionKey);
    if (!ws || ws.readyState !== WebSocket.OPEN) return undefined;
    return ws;
  }

  /**
   * The "any open socket" fallback, made multi-peer safe.
   *
   * The Phase-0 fallbacks blindly delivered to whatever socket was open, which
   * was fine when every connection was the same anon peer. With real per-user
   * peers that would cross-deliver one user's content to another. So we only
   * fall back when there is EXACTLY ONE connection (effectively the anonymous
   * single-peer case); with multiple peers we refuse to guess and return
   * undefined (the caller treats this as "not delivered").
   */
  private soleOpenSocket(): WebSocket | undefined {
    if (this.sockets.size !== 1) return undefined;
    for (const ws of this.sockets.values()) {
      if (ws.readyState === WebSocket.OPEN) return ws;
    }
    return undefined;
  }

  /**
   * Push a final text message to the browser bound to `sessionKey`.
   *
   * If `id` is provided this finalizes an in-flight progress draft (the widget
   * replaces the draft bubble `id` with the final text). Without `id` it is the
   * legacy no-draft path: the widget appends a fresh bubble. Returns true if
   * delivered.
   */
  sendText(sessionKey: string, text: string, id?: string, turnId?: string): boolean {
    const ws = this.openSocket(sessionKey);
    if (!ws) return false;
    const payload: OutboundWsMessage = {
      type: "agent_message",
      text,
      ...(id ? { id } : {}),
      ...(turnId ? { turnId } : {}),
    };
    // TODO(reconnect): message replay + idempotency dedupe deferred
    return this.safeSend(ws, payload);
  }

  /**
   * Emit one progress-draft frame for `sessionKey`. The widget renders/replaces
   * a SINGLE bubble keyed by `id`. Returns true if delivered.
   *
   * The progress draft id is owned by the per-turn controller in
   * `message-adapter.ts`, which threads the SAME id through every `sendProgress`
   * and the eventual `finalizeDraft`; the transport does not track it.
   */
  sendProgress(sessionKey: string, id: string, text: string, turnId?: string): boolean {
    const ws = this.openSocket(sessionKey);
    if (!ws) return false;
    const payload: OutboundWsMessage = { type: "progress", id, text, ...(turnId ? { turnId } : {}) };
    return this.safeSend(ws, payload);
  }

  /**
   * Finalize the progress draft `id` for `sessionKey` into the final answer,
   * reusing the id so the widget transitions the same bubble. Thin wrapper over
   * `sendText(..., id)` for call-site clarity.
   */
  finalizeDraft(sessionKey: string, id: string, text: string, turnId?: string): boolean {
    return this.sendText(sessionKey, text, id, turnId);
  }

  sendReasoning(sessionKey: string, id: string, turnId: string, text: string): boolean {
    const ws = this.openSocket(sessionKey);
    if (!ws) return false;
    return this.safeSend(ws, { type: "reasoning", id, turnId, text });
  }

  sendTurnSettled(sessionKey: string, turnId: string): boolean {
    const ws = this.openSocket(sessionKey);
    if (!ws) return false;
    return this.safeSend(ws, { type: "turn_settled", turnId });
  }

  /**
   * Push the native "Bot is typing…" affordance to `sessionKey`. Called once
   * at the start of a turn (after route resolution, before agent dispatch);
   * the first `progress` / `agent_message` / `approval_*` frame that follows
   * clears the indicator client-side — no explicit stop frame is needed.
   *
   * Best-effort, no ack/retry (Telegram/Discord parity): under backpressure
   * the frame is silently dropped (it is drop-only, like `progress`).
   *
   * Returns `true` if the frame was handed to the socket; `false` if disabled,
   * the socket is not open, or the buffer is over the cap.
   */
  sendTyping(sessionKey: string): boolean {
    if (!this.typingEnabled) return false;
    const ws = this.openSocket(sessionKey);
    if (!ws) return false;
    const payload: OutboundWsMessage = { type: "typing" };
    return this.safeSend(ws, payload);
  }

  /**
   * Push a history snapshot / pagination page to `sessionKey`. Called both
   * for the initial on-connect snapshot (driven by the first-pong handler)
   * AND for `load_history` responses (driven by the load_history handler).
   *
   * Best-effort, drop-only under backpressure (same group as `progress` /
   * `typing`): a snapshot is a one-shot hydrate signal, the client can
   * always re-request via `load_history`, and terminating the socket on a
   * missed snapshot would wedge the user out of their conversation.
   *
   * Returns `true` if the frame was handed to the socket; `false` if the
   * history gate is disabled, the socket is not open, the buffer is over
   * the cap, or `messages` is empty (we never push an empty history frame
   * — the client treats it the same as "no history" and a no-op send would
   * only add noise).
   */
  sendHistory(sessionKey: string, messages: HistoryMessage[]): boolean {
    if (!this.historyEnabled) return false;
    if (!Array.isArray(messages) || messages.length === 0) return false;
    const ws = this.openSocket(sessionKey);
    if (!ws) return false;
    const payload: OutboundWsMessage = { type: "history", messages };
    return this.safeSend(ws, payload);
  }

  /**
   * Fallback for core-initiated outbound sends whose `ctx.to` does not exactly
   * match a mapped session key. Safe only when there is exactly one connection
   * (the anonymous single-peer case); with multiple real per-user peers we
   * refuse to guess a recipient to avoid cross-delivering between users.
   *
   * TODO(session): remove this fallback once `outbound.sendText` always receives
   * a real per-peer `ctx.to` that matches a mapped session.
   */
  sendTextToAnyOpen(text: string): boolean {
    const ws = this.soleOpenSocket();
    if (!ws) return false;
    return this.safeSend(ws, { type: "agent_message", text });
  }

  /**
   * Push a native approval prompt to the browser bound to `sessionKey`. The
   * widget renders a distinct approval card with one button per offered option;
   * clicking sends `{type:"approval_decision", id, decision}` back. Returns true
   * if delivered. Falls back to the single open socket ONLY when there is
   * exactly one connection (mirroring `sendTextToAnyOpen`), so an approval
   * reaches the live anon tab even when the captured target key does not line up
   * — but never cross-delivers an approval prompt between distinct users.
   */
  sendApprovalRequest(
    sessionKey: string,
    payload: ApprovalRequestPayload,
  ): boolean {
    const frame: OutboundWsMessage = { type: "approval_request", ...payload };
    const ws = this.openSocket(sessionKey) ?? this.soleOpenSocket();
    if (ws) {
      return this.safeSend(ws, frame);
    }
    return false;
  }

  /**
   * Finalize a delivered approval `id` for `sessionKey`: the widget disables the
   * buttons and reflects the recorded `decision`. Falls back to the single open
   * socket only when there is exactly one connection (same rationale as
   * `sendApprovalRequest`).
   */
  sendApprovalResolved(
    sessionKey: string,
    id: string,
    decision: ApprovalDecision,
  ): boolean {
    const frame: OutboundWsMessage = {
      type: "approval_resolved",
      id,
      decision,
    };
    const ws = this.openSocket(sessionKey) ?? this.soleOpenSocket();
    if (ws) {
      return this.safeSend(ws, frame);
    }
    return false;
  }

  /**
   * Push the authoritative pending-approval snapshot for `sessionKey` (#15).
   * Present on the legacy dev-only WS transport purely for surface parity with
   * `NatsChannel` — the legacy path has no stateless register hop, so it never
   * emits this at register time (see APPROVAL_REHYDRATION_PLAN §3.2/§3.6). Falls
   * back to the single open socket under the same one-connection rule as the
   * other approval sends. An empty `approvals` array IS delivered (it is the
   * reconciliation signal); the send only no-ops when no socket is open.
   *
   * `resolved` (#19) mirrors `NatsChannel.sendApprovalSnapshot` for surface
   * parity; the legacy dev-only WS path never emits this frame at register time
   * (no stateless register hop), so this arg is here only so the two transports
   * share one signature.
   */
  sendApprovalSnapshot(
    sessionKey: string,
    approvals: ApprovalRequestPayload[],
    resolved?: Array<{ id: string; decision: ApprovalDecision }>,
  ): boolean {
    const frame: OutboundWsMessage = {
      type: "approval_snapshot",
      approvals,
      ...(resolved && resolved.length > 0 ? { resolved } : {}),
    };
    const ws = this.openSocket(sessionKey) ?? this.soleOpenSocket();
    if (ws) {
      return this.safeSend(ws, frame);
    }
    return false;
  }
}
