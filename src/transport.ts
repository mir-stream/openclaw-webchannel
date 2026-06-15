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
export type InboundWsMessage = { type: "user_message"; text: string };
export type OutboundWsMessage =
  | { type: "agent_message"; text: string; id?: string }
  | { type: "progress"; id: string; text: string };

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

  constructor() {
    this.wss = new WebSocketServer({ noServer: true });
  }

  setMessageHandler(
    handler: (sessionKey: string, message: InboundWsMessage) => void,
  ): void {
    this.onMessage = handler;
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

    ws.on("message", (data) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(typeof data === "string" ? data : data.toString());
      } catch {
        return; // ignore malformed frames in Phase 0
      }
      if (
        parsed &&
        typeof parsed === "object" &&
        (parsed as InboundWsMessage).type === "user_message" &&
        typeof (parsed as InboundWsMessage).text === "string"
      ) {
        this.onMessage?.(sessionKey, parsed as InboundWsMessage);
      }
    });

    const cleanup = () => {
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
    ws.send(JSON.stringify(payload));
    return true;
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
    ws.send(JSON.stringify(payload));
    return true;
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
    for (const ws of this.sockets.values()) {
      if (ws.readyState === WebSocket.OPEN) {
        const payload: OutboundWsMessage = { type: "agent_message", text };
        ws.send(JSON.stringify(payload));
        return true;
      }
    }
    return false;
  }
}
