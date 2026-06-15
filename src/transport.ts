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
 * Phase 0 only needs plain text both directions.
 */
export type InboundWsMessage = { type: "user_message"; text: string };
export type OutboundWsMessage = { type: "agent_message"; text: string };

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

  /** Push a text message to the browser bound to `sessionKey`. Returns true if delivered. */
  sendText(sessionKey: string, text: string): boolean {
    const ws = this.sockets.get(sessionKey);
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    const payload: OutboundWsMessage = { type: "agent_message", text };
    ws.send(JSON.stringify(payload));
    return true;
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
