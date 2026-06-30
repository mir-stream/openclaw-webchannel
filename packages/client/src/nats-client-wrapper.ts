/**
 * WebChannel NATS Client Wrapper — Adapter for existing client.ts.
 *
 * This module wraps the WebChannelNatsClient to provide the same API
 * as the original WebSocket-based WebChannelClient, enabling a drop-in
 * replacement for AC 5's NATS cutover.
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
  Listener,
  ApprovalDecision,
  ApprovalOption,
  ChatMessage,
  ApprovalRequest,
} from "./types.js";
import {
  WebChannelNatsClient,
  type NatsClientOptions,
  type InboundMessage,
} from "./nats-client.js";

// ---------------------------------------------------------------------------
// WebChannel NATS Client
// ---------------------------------------------------------------------------

/**
 * NATS-based WebChannel client.
 *
 * Drop-in replacement for WebSocket-based WebChannelClient.
 * Uses NATS subjects for per-peer messaging instead of gateway-WS relay.
 */
export class WebChannelNATSClient {
  private readonly natsOptions: NatsClientOptions;
  private readonly client: WebChannelNatsClient;

  private state: WebChannelState = {
    messages: [],
    approvals: [],
    status: "connecting",
    connected: false,
  };

  private readonly listeners = new Set<Listener>();

  constructor(options: WebChannelOptions & NatsClientOptions) {
    this.natsOptions = {
      url: options.natsUrl ?? "wss://nats.example.com",
      jwt: options.bootstrapJwt ?? "",
      agentId: options.agentId ?? "default-agent",
      tenant: options.tenant ?? "default-tenant",
      peerId: options.peerId ?? "anonymous-peer",
      registration: options.registration,
    };

    this.client = new WebChannelNatsClient(this.natsOptions);

    // Wire up message listener
    this.client.onMessage((msg: InboundMessage) => this.handleMessage(msg));

    // Wire up state listener
    this.client.onState((connected: boolean) => {
      this.setState({
        status: connected ? "connected" : "reconnecting",
        connected,
      });
    });

    // Surface a failed PoP registration. The underlying client tears the
    // connection fully down (registration failure is terminal — see
    // nats-client.ts onConnected), so nothing is reconnecting. ConnectionStatus
    // has no terminal/disconnected value, so we do NOT claim "reconnecting"
    // here: the matching `onState(false)` from the teardown already moves status
    // out of "connected", and we just log the error.
    this.client.onError((err: Error) => {
      console.error("[nats-wrapper] registration error:", err);
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
    this.client.connect();
  }

  /** Disconnect from NATS */
  close(): void {
    this.client.disconnect();
  }

  /** Send user message */
  send(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;

    this.appendMessage({
      id: `u-${this.uid()}`,
      role: "user",
      text: trimmed,
    });

    this.client.sendUserMessage(trimmed);
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

  // ---------------------------------------------------------------------------
  // State management
  // ---------------------------------------------------------------------------

  private setState(patch: Partial<WebChannelState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener(this.state);
  }

  private appendMessage(message: ChatMessage): void {
    this.setState({ messages: [...this.state.messages, message] });
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
  // Message handling
  // ---------------------------------------------------------------------------

  private handleMessage(msg: InboundMessage): void {
    switch (msg.type) {
      case "history": {
        const incoming = Array.isArray(msg.messages) ? msg.messages : [];
        if (incoming.length === 0) return;

        const existing = this.state.messages;
        const seen = new Set(existing.map((m) => m.id));
        const fresh: ChatMessage[] = [];

        for (const m of incoming) {
          if (!m || typeof m !== "object") continue;
          if (typeof m.id !== "string" || m.id.length === 0) continue;
          if (m.role !== "user" && m.role !== "agent") continue;
          if (typeof m.text !== "string") continue;
          if (seen.has(m.id)) continue;

          seen.add(m.id);
          fresh.push({
            id: m.id,
            role: m.role,
            text: m.text,
            ts: m.ts,
            working: false,
          });
        }

        if (fresh.length === 0) return;

        this.setState({ messages: [...fresh, ...existing] });
        return;
      }

      case "typing": {
        this.setState({ isTyping: true });
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
          const next = approvals.slice();
          next[idx] = req;
          this.setState({ approvals: next, isTyping: false });
        }
        return;
      }

      case "approval_resolved": {
        const id = msg.id ?? "";
        const decision = msg.decision as ApprovalDecision | undefined;
        this.patchApproval(id, (a) => ({ ...a, resolvedDecision: decision }));
        return;
      }

      case "progress": {
        const { id } = msg;
        const text = msg.text ?? "";
        this.upsertMessage(
          id ?? "",
          (prev) => ({ ...prev, text, working: true }),
          { id: id ?? "", role: "agent", text, working: true },
        );
        this.setState({ isTyping: false });
        return;
      }

      case "agent_message": {
        const { text, id } = msg;
        this.setState({ isTyping: false });

        if (id) {
          this.upsertMessage(
            id,
            (prev) => ({ ...prev, text: text ?? "", working: false }),
            { id, role: "agent", text: text ?? "", working: false },
          );
          return;
        }

        this.appendMessage({
          id: `a-${this.uid()}`,
          role: "agent",
          text: text ?? "",
        });
        return;
      }
    }
  }
}

