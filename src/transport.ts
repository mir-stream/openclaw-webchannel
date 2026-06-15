import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, WebSocket } from "ws";

/**
 * The channel id is the fixed key the rest of OpenClaw uses to route to us.
 */
export const CLAWCHANNEL_ID = "clawchannel";

/**
 * Phase 0: single anonymous session. Every browser connection is mapped to the
 * same sessionKey peer id. Real multi-tab / per-user session-key mapping is
 * deferred (see PLAN.md §12 "session grammar").
 *
 * TODO(session): Phase 1 — derive a per-user/per-tab peer id from an issued
 * token or cookie instead of a single anonymous peer.
 */
export const ANON_PEER_ID = "web-anon";

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
  | { type: "user_message"; text: string }
  | { type: "approval_decision"; id: string; decision: ApprovalDecision };
export type OutboundWsMessage =
  | { type: "agent_message"; text: string; id?: string }
  | { type: "progress"; id: string; text: string }
  | ({ type: "approval_request" } & ApprovalRequestPayload)
  | { type: "approval_resolved"; id: string; decision: ApprovalDecision };

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
type Liveness = { alive: boolean };

/**
 * Owns the (noServer) WebSocketServer and the live connection map.
 *
 * The gateway owns the listening socket; we never call `.listen()`. We only
 * handle upgrade requests the gateway hands us via `handleUpgrade`.
 */
export class ClawChannelTransport {
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

  /** Liveness tracking for the ping/pong heartbeat, keyed by socket. */
  private readonly liveness = new WeakMap<WebSocket, Liveness>();

  /** The single heartbeat interval; started lazily on first connection. */
  private heartbeat?: ReturnType<typeof setInterval>;

  private readonly heartbeatMs: number;

  /** Set once we've logged a backpressure drop, so we don't spam the log. */
  private warnedBackpressure = false;

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
          "[clawchannel] dropping outbound frame: socket buffer over backpressure cap",
        );
      }
      // A progress frame is superseded by the next update/finalize, so dropping
      // it is harmless. But dropping a TERMINAL frame (finalize / legacy answer /
      // approval) on a socket the heartbeat won't rescue — it still pongs, so it
      // is never evicted — would wedge the widget (a "working" bubble that never
      // settles, or an approval prompt the user never sees). Terminate such a
      // socket so the client reconnects (settling orphaned drafts) and retries.
      if (payload.type !== "progress") {
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

  /** Wire a raw Node upgrade request (handed over by the gateway) into `ws`. */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.registerConnection(ws);
    });
  }

  private registerConnection(ws: WebSocket): void {
    // Phase 0: single anonymous session for every connection.
    const sessionKey = ANON_PEER_ID;
    this.sockets.set(sessionKey, ws);

    // Start the heartbeat lazily and seed this socket as alive; each pong
    // re-arms it for the next tick.
    this.liveness.set(ws, { alive: true });
    ws.on("pong", () => {
      const state = this.liveness.get(ws);
      if (state) state.alive = true;
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
   * Push a final text message to the browser bound to `sessionKey`.
   *
   * If `id` is provided this finalizes an in-flight progress draft (the widget
   * replaces the draft bubble `id` with the final text). Without `id` it is the
   * legacy no-draft path: the widget appends a fresh bubble. Returns true if
   * delivered.
   */
  sendText(sessionKey: string, text: string, id?: string): boolean {
    const ws = this.openSocket(sessionKey);
    if (!ws) return false;
    const payload: OutboundWsMessage = id
      ? { type: "agent_message", text, id }
      : { type: "agent_message", text };
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
  sendProgress(sessionKey: string, id: string, text: string): boolean {
    const ws = this.openSocket(sessionKey);
    if (!ws) return false;
    const payload: OutboundWsMessage = { type: "progress", id, text };
    return this.safeSend(ws, payload);
  }

  /**
   * Finalize the progress draft `id` for `sessionKey` into the final answer,
   * reusing the id so the widget transitions the same bubble. Thin wrapper over
   * `sendText(..., id)` for call-site clarity.
   */
  finalizeDraft(sessionKey: string, id: string, text: string): boolean {
    return this.sendText(sessionKey, text, id);
  }

  /**
   * Phase 0 fallback for core-initiated outbound sends whose `ctx.to` does not
   * exactly match a mapped session key. Since there is exactly one anonymous
   * connection in Phase 0, deliver to the single open socket.
   *
   * TODO(session): Phase 1 — remove this fallback once `outbound.sendText`
   * receives a real per-peer `ctx.to` that always matches a mapped session.
   */
  sendTextToAnyOpen(text: string): boolean {
    const payload: OutboundWsMessage = { type: "agent_message", text };
    for (const ws of this.sockets.values()) {
      if (ws.readyState === WebSocket.OPEN) {
        return this.safeSend(ws, payload);
      }
    }
    return false;
  }

  /**
   * Push a native approval prompt to the browser bound to `sessionKey`. The
   * widget renders a distinct approval card with one button per offered option;
   * clicking sends `{type:"approval_decision", id, decision}` back. Returns true
   * if delivered. Falls back to the single open socket (Phase 0 single anon
   * peer), mirroring `sendTextToAnyOpen`, so an approval reaches the live tab
   * even when the captured target key does not line up exactly.
   */
  sendApprovalRequest(
    sessionKey: string,
    payload: ApprovalRequestPayload,
  ): boolean {
    const frame: OutboundWsMessage = { type: "approval_request", ...payload };
    const ws = this.openSocket(sessionKey);
    if (ws) {
      return this.safeSend(ws, frame);
    }
    for (const candidate of this.sockets.values()) {
      if (candidate.readyState === WebSocket.OPEN) {
        return this.safeSend(candidate, frame);
      }
    }
    return false;
  }

  /**
   * Finalize a delivered approval `id` for `sessionKey`: the widget disables the
   * buttons and reflects the recorded `decision`. Broadcasts to the single open
   * socket as a fallback (same rationale as `sendApprovalRequest`).
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
    const ws = this.openSocket(sessionKey);
    if (ws) {
      return this.safeSend(ws, frame);
    }
    for (const candidate of this.sockets.values()) {
      if (candidate.readyState === WebSocket.OPEN) {
        return this.safeSend(candidate, frame);
      }
    }
    return false;
  }
}
