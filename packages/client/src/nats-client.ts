/**
 * WebChannel NATS Client — Browser-side NATS connection.
 *
 * This module provides a browser-compatible NATS WebSocket client that:
 * - Connects to NATS server with bootstrap JWT authentication
 * - Subscribes to inbound message subjects
 * - Publishes to outbound message subjects
 * - Handles reconnection with exponential backoff
 * - Integrates with Phase A crypto (handshake + E2E encryption)
 *
 * Architecture:
 * - Outbound-only connection (browser dials NATS)
 * - JWT-based authentication (bootstrap JWT from SaaS)
 * - Per-peer NATS subjects (tenant-keyed routing)
 * - E2E encryption via CryptoNatsChannel (Phase A data plane)
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type NatsClientOptions = {
  /** NATS WebSocket URL */
  url: string;
  /** Bootstrap JWT (RS256-signed, contains cnf.jwk claim) */
  jwt: string;
  /** Agent ID (from JWT) */
  agentId: string;
  /** Tenant ID (from JWT) */
  tenant: string;
  /** Peer ID (JWT sub claim) */
  peerId: string;
  /** Reconnect backoff base delay (ms) */
  reconnectBaseMs?: number;
  /** Reconnect backoff cap (ms) */
  reconnectCapMs?: number;
};

export type InboundMessage = {
  type: "agent_message" | "progress" | "approval_request" | "approval_resolved" | "typing" | "history";
  id?: string;
  text?: string;
  kind?: "exec" | "plugin";
  title?: string;
  description?: string;
  prompt?: string;
  options?: Array<{ decision: string; label: string; style: string }>;
  expiresAtMs?: number;
  decision?: string;
  messages?: Array<{ id: string; role: string; text: string; ts?: number }>;
  before?: string;
  limit?: number;
};

export type OutboundMessage =
  | { type: "user_message"; text: string }
  | { type: "approval_decision"; id: string; decision: string }
  | { type: "load_history"; before?: string; limit?: number };

/** Message listener callback */
export type MessageListener = (msg: InboundMessage) => void;

/** Connection state listener callback */
export type StateListener = (connected: boolean) => void;

// ---------------------------------------------------------------------------
// WebSocket-based NATS client (browser-compatible)
// -----------------------------------------------------------------

/**
 * Browser-compatible NATS WebSocket client.
 *
 * This is a simplified NATS client that implements the wire protocol
 * over WebSocket in the browser. It supports:
 * - JWT authentication in CONNECT
 * - PUB/SUB commands
 * - Automatic reconnection
 * - Per-peer subject routing
 */
export class NatsClient {
  private readonly options: NatsClientOptions;
  private ws: WebSocket | null = null;
  private connected = false;
  private messageListeners = new Set<MessageListener>();
  private stateListeners = new Set<StateListener>();
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private subscriptions = new Map<number, string>(); // sid -> subject
  private sidCounter = 0;
  private buffer = "";

  constructor(options: NatsClientOptions) {
    this.options = options;
  }

  /** Connect to NATS server */
  connect(): void {
    this.connectInternal();
  }

  /** Disconnect and cleanup */
  disconnect(): void {
    this.clearReconnectTimer();
    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onerror = null;
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
    this.notifyStateListeners();
  }

  /** Publish message to NATS subject */
  publish(subject: string, payload: string): void {
    if (!this.connected || !this.ws) {
      console.warn("[nats-client] Not connected, cannot publish");
      return;
    }

    // Use TextEncoder for byte-length (browser-compatible; Node.js ≥18 also
    // has globalThis.TextEncoder). NATS PUB requires the UTF-8 byte count.
    const byteLen = new TextEncoder().encode(payload).length;
    this.ws.send(`PUB ${subject} ${byteLen}\r\n${payload}\r\n`);
  }

  /** Subscribe to NATS subject */
  subscribe(subject: string): number {
    if (!this.connected || !this.ws) {
      console.warn("[nats-client] Not connected, cannot subscribe");
      return -1;
    }

    const sid = ++this.sidCounter;
    this.subscriptions.set(sid, subject);
    this.ws.send(`SUB ${subject} ${sid}\r\n`);
    return sid;
  }

  /** Unsubscribe from subject */
  unsubscribe(sid: number): void {
    this.subscriptions.delete(sid);
    if (this.connected && this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(`UNSUB ${sid}\r\n`);
    }
  }

  /** Add message listener */
  onMessage(listener: MessageListener): () => void {
    this.messageListeners.add(listener);
    return () => { this.messageListeners.delete(listener); };
  }

  /** Add connection state listener */
  onState(listener: StateListener): () => void {
    this.stateListeners.add(listener);
    return () => { this.stateListeners.delete(listener); };
  }

  // ---------------------------------------------------------------------------
  // Internal implementation
  // ---------------------------------------------------------------------------

  private connectInternal(): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    const ws = new WebSocket(this.options.url);
    this.ws = ws;

    ws.onopen = () => {
      console.log("[nats-client] WebSocket connected");
      this.sendConnect();
    };

    ws.onmessage = (event) => {
      const chunk = event.data;
      this.buffer += chunk;
      this.drainBuffer();
    };

    ws.onerror = (err) => {
      console.error("[nats-client] WebSocket error:", err);
    };

    ws.onclose = () => {
      this.connected = false;
      this.notifyStateListeners();
      this.scheduleReconnect();
    };
  }

  private sendConnect(): void {
    if (!this.ws) return;

    const connectPayload = {
      verbose: false,
      pedantic: false,
      lang: "typescript",
      version: "1.0.0",
      protocol: 1,
      echo: false,
      jwt: this.options.jwt,
    };

    this.ws.send(`CONNECT ${JSON.stringify(connectPayload)}\r\n`);
    this.ws.send("PING\r\n");
  }

  private drainBuffer(): void {
    let crlfPos: number;
    while ((crlfPos = this.buffer.indexOf("\r\n")) !== -1) {
      const line = this.buffer.slice(0, crlfPos);
      this.buffer = this.buffer.slice(crlfPos + 2);

      if (!line) continue;

      if (line.startsWith("INFO ")) {
        continue;
      }

      if (line === "PONG") {
        if (!this.connected) {
          this.connected = true;
          this.reconnectAttempts = 0;
          console.log("[nats-client] Connected to NATS");
          this.notifyStateListeners();
          this.resubscribeAll();
        }
        continue;
      }

      if (line === "PING") {
        this.ws?.send("PONG\r\n");
        continue;
      }

      if (line.startsWith("MSG ")) {
        this.handleMessage(line);
        continue;
      }

      if (line.startsWith("-ERR ")) {
        console.error("[nats-client] NATS error:", line);
        continue;
      }
    }
  }

  private handleMessage(line: string): void {
    const parts = line.split(" ");
    const hasReplyTo = parts.length === 5;
    const byteCount = parseInt(parts[hasReplyTo ? 4 : 3] ?? "0", 10);

    if (isNaN(byteCount) || byteCount < 0) return;

    if (this.buffer.length < byteCount + 2) {
      this.buffer = `${line}\r\n${this.buffer}`;
      return;
    }

    const payload = this.buffer.slice(0, byteCount);
    this.buffer = this.buffer.slice(byteCount + 2);

    try {
      const message = JSON.parse(payload);
      this.notifyMessageListeners(message);
    } catch (err) {
      console.error("[nats-client] Failed to parse message:", err);
    }
  }

  private resubscribeAll(): void {
    this.subscriptions.forEach((subject, sid) => {
      if (this.connected && this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(`SUB ${subject} ${sid}\r\n`);
      }
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;

    const baseMs = this.options.reconnectBaseMs ?? 500;
    const capMs = this.options.reconnectCapMs ?? 10000;
    const exp = Math.min(capMs, baseMs * Math.pow(2, this.reconnectAttempts));
    const delay = Math.random() * exp;

    this.reconnectAttempts++;
    console.log(`[nats-client] Reconnecting in ${Math.round(delay)}ms (attempt ${this.reconnectAttempts})`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connectInternal();
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private notifyMessageListeners(msg: InboundMessage): void {
    this.messageListeners.forEach((listener) => {
      try {
        listener(msg);
      } catch (err) {
        console.error("[nats-client] Listener error:", err);
      }
    });
  }

  private notifyStateListeners(): void {
    this.stateListeners.forEach((listener) => {
      try {
        listener(this.connected);
      } catch (err) {
        console.error("[nats-client] State listener error:", err);
      }
    });
  }
}

// ---------------------------------------------------------------------------
// Subject helpers
// ---------------------------------------------------------------------------

/**
 * Derive inbound NATS subject for a peer.
 * Format: webchannel.{tenant}.{agentId}.{peerId}.in
 */
export function inboundSubject(tenant: string, agentId: string, peerId: string): string {
  return `webchannel.${tenant}.${agentId}.${peerId}.in`;
}

/**
 * Derive outbound NATS subject for a peer.
 * Format: webchannel.{tenant}.{agentId}.{peerId}.out
 */
export function outboundSubject(tenant: string, agentId: string, peerId: string): string {
  return `webchannel.${tenant}.${agentId}.${peerId}.out`;
}

/**
 * Derive handshake NATS subject for a peer.
 * Format: webchannel.{tenant}.{agentId}.{peerId}.handshake
 */
export function handshakeSubject(tenant: string, agentId: string, peerId: string): string {
  return `webchannel.${tenant}.${agentId}.${peerId}.handshake`;
}

// ---------------------------------------------------------------------------
// WebChannel NATS client (high-level API)
// ---------------------------------------------------------------------------

/**
 * High-level WebChannel NATS client.
 *
 * Wraps NatsClient with WebChannel-specific message handling.
 */
export class WebChannelNatsClient {
  private readonly client: NatsClient;
  private readonly inboundSub: number;
  private readonly options: NatsClientOptions;

  constructor(options: NatsClientOptions) {
    this.options = options;
    this.client = new NatsClient(options);

    // Subscribe to inbound messages
    const inSubject = inboundSubject(options.tenant, options.agentId, options.peerId);
    this.inboundSub = this.client.subscribe(inSubject);
  }

  /** Connect to NATS */
  connect(): void {
    this.client.connect();
  }

  /** Disconnect from NATS */
  disconnect(): void {
    this.client.unsubscribe(this.inboundSub);
    this.client.disconnect();
  }

  /** Send user message */
  sendUserMessage(text: string): void {
    const outSubject = outboundSubject(this.options.tenant, this.options.agentId, this.options.peerId);
    const payload = JSON.stringify({ type: "user_message", text });
    this.client.publish(outSubject, payload);
  }

  /** Send approval decision */
  sendApprovalDecision(id: string, decision: string): void {
    const outSubject = outboundSubject(this.options.tenant, this.options.agentId, this.options.peerId);
    const payload = JSON.stringify({ type: "approval_decision", id, decision });
    this.client.publish(outSubject, payload);
  }

  /** Request history page */
  loadHistory(before?: string, limit?: number): void {
    const outSubject = outboundSubject(this.options.tenant, this.options.agentId, this.options.peerId);
    const payload = JSON.stringify({ type: "load_history", before, limit });
    this.client.publish(outSubject, payload);
  }

  /** Add message listener */
  onMessage(listener: MessageListener): () => void {
    return this.client.onMessage(listener);
  }

  /** Add connection state listener */
  onState(listener: StateListener): () => void {
    return this.client.onState(listener);
  }
}
