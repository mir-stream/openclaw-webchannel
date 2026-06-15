import type {
  ApprovalDecision,
  ApprovalRequest,
  ChatMessage,
  ClawChannelOptions,
  ClawChannelState,
  ConnectionStatus,
  InboundWsMessage,
  Listener,
  OutboundWsMessage,
} from "./types.js";

/** Default WebSocket path on the gateway (same origin). */
const DEFAULT_WS_PATH = "/clawchannel/ws";

/** Reconnect backoff: base delay, growth factor, and a hard cap. */
const RECONNECT_BASE_MS = 500;
const RECONNECT_FACTOR = 2;
const RECONNECT_CAP_MS = 10_000;

/**
 * Headless ClawChannel client: owns the WebSocket, the reconnect policy, the
 * wire-protocol parsing, AND the transcript/approval state. It is framework- and
 * DOM-render-free — consumers `subscribe` to immutable state snapshots and call
 * `send` / `decide`. The React widget and any vanilla/Vue UI are thin views on
 * top of this single source of truth.
 *
 * Lifecycle: construct → `connect()` → … → `close()`. `connect()`/`close()` are
 * the only lifecycle calls; everything else is driven by socket events.
 *
 *   const client = new ClawChannelClient({ getTicket });
 *   const unsub = client.subscribe((state) => render(state));
 *   client.connect();
 *   client.send("hello");
 *   // later: unsub(); client.close();
 */
export class ClawChannelClient {
  private readonly options: ClawChannelOptions;

  private state: ClawChannelState = {
    messages: [],
    approvals: [],
    status: "connecting",
    connected: false,
  };

  private readonly listeners = new Set<Listener>();

  private ws: WebSocket | null = null;

  /** Set by `close()`; blocks any further (re)connect and silences handlers. */
  private closed = false;

  /** Reconnect bookkeeping (backoff attempt count + the pending timer). */
  private attempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * SYNCHRONOUS in-flight sentinel. `connect()` is async (it awaits getTicket
   * before assigning `this.ws`), so the readyState guard alone can't stop two
   * overlapping `connect()` calls from both opening a socket. We set this true
   * at the top of `connect()` before any await and bail synchronously if it's
   * already set; it is reset on EVERY terminal outcome so a reconnect is never
   * permanently blocked.
   */
  private connecting = false;

  constructor(options: ClawChannelOptions = {}) {
    this.options = options;
  }

  /** The current immutable state snapshot. */
  getState(): ClawChannelState {
    return this.state;
  }

  /**
   * Subscribe to state changes. The listener fires on every change with the
   * latest snapshot; returns an unsubscribe function. (Does not fire
   * immediately — read `getState()` for the initial value.)
   */
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Start (or resume) connecting. Idempotent: a no-op if already live. */
  connect(): void {
    this.closed = false;
    void this.open().catch(() => this.scheduleReconnect());
  }

  /**
   * Tear down: stop reconnecting, clear any pending timer, and close the live
   * socket (handlers nulled so our own close doesn't re-arm the reconnect).
   * Idempotent.
   */
  close(): void {
    this.closed = true;
    this.connecting = false;
    this.clearReconnectTimer();
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onopen = null;
      ws.onclose = null;
      ws.onerror = null;
      ws.onmessage = null;
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
  }

  /** Send a user message. Dropped if not connected (no queue/replay). */
  send(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    const ws = this.ws;
    // TODO(reconnect): message replay + idempotency dedupe deferred.
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    this.appendMessage({
      id: `u-${this.uid()}`,
      role: "user",
      text: trimmed,
    });
    const payload: InboundWsMessage = { type: "user_message", text: trimmed };
    ws.send(JSON.stringify(payload));
  }

  /**
   * Send an approval decision for `id`. Optimistically marks the card resolved
   * so a view can disable the buttons immediately; the authoritative
   * `approval_resolved` frame confirms/overwrites the outcome.
   */
  decide(id: string, decision: ApprovalDecision): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    this.patchApproval(id, (a) =>
      a.resolvedDecision === undefined
        ? { ...a, resolvedDecision: decision }
        : a,
    );
    const payload: InboundWsMessage = {
      type: "approval_decision",
      id,
      decision,
    };
    ws.send(JSON.stringify(payload));
  }

  // ── state plumbing ────────────────────────────────────────────────────────

  private setState(patch: Partial<ClawChannelState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener(this.state);
  }

  private setStatus(status: ConnectionStatus): void {
    this.setState({ status, connected: status === "connected" });
  }

  private appendMessage(message: ChatMessage): void {
    this.setState({ messages: [...this.state.messages, message] });
  }

  /** Replace the message with `id` via `update`, or append `fallback` if absent. */
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

  /** Counter-based unique suffix; avoids `Date.now()` collisions in a tick. */
  private seq = 0;
  private uid(): string {
    return `${this.seq++}`;
  }

  // ── connection lifecycle ──────────────────────────────────────────────────

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    if (this.reconnectTimer !== null) return; // already scheduled
    this.setStatus("reconnecting");
    // Exponential backoff with full jitter, capped. Jitter avoids a thundering
    // herd when the gateway restarts and many tabs reconnect at once.
    const exp = Math.min(
      RECONNECT_CAP_MS,
      RECONNECT_BASE_MS * RECONNECT_FACTOR ** this.attempts,
    );
    const delay = Math.random() * exp;
    this.attempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.open().catch(() => this.scheduleReconnect());
    }, delay);
  }

  private resolveBaseUrl(): string {
    const { url, path } = this.options;
    if (url) return url;
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${window.location.host}${path ?? DEFAULT_WS_PATH}`;
  }

  private async open(): Promise<void> {
    if (this.closed) return;
    // SYNCHRONOUS double-connect guard: a second overlapping call sees this set
    // even while the first is mid-`await getTicket()`. The readyState checks
    // below are a belt-and-suspenders backstop for an already-open socket.
    if (this.connecting) return;
    const existing = this.ws;
    if (
      existing &&
      (existing.readyState === WebSocket.OPEN ||
        existing.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }
    this.connecting = true;
    this.setStatus(this.attempts === 0 ? "connecting" : "reconnecting");

    let url = this.resolveBaseUrl();
    const { getTicket } = this.options;
    if (getTicket) {
      // Fetch a fresh ticket on EVERY (re)connect (AUTH.md §5). A throw or an
      // empty result is treated like a failed connection: back off and retry.
      let token: string | null;
      try {
        token = await getTicket();
      } catch {
        this.connecting = false;
        this.scheduleReconnect();
        return;
      }
      // We may have been closed while awaiting; abort without opening.
      if (this.closed) {
        this.connecting = false;
        return;
      }
      const live = this.ws;
      if (
        live &&
        (live.readyState === WebSocket.OPEN ||
          live.readyState === WebSocket.CONNECTING)
      ) {
        this.connecting = false;
        return;
      }
      if (!token) {
        // No ticket → for hmac-ticket the server rejects the upgrade. Treat as a
        // failed connection and back off.
        this.connecting = false;
        this.scheduleReconnect();
        return;
      }
      url = `${url}?ticket=${encodeURIComponent(token)}`;
    }

    const ws = new WebSocket(url);
    this.ws = ws;

    ws.onopen = () => this.onOpen();
    ws.onclose = () => {
      if (this.ws === ws) this.ws = null;
      // Terminal outcome for THIS attempt (may never have reached onopen).
      this.connecting = false;
      if (this.closed) return;
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      // An error is followed by close in browsers; close defensively so the
      // socket can't linger, and let onclose drive the reconnect.
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    };
    ws.onmessage = (event) => this.onMessage(event);
  }

  private onOpen(): void {
    // Successful (re)connect: release the sentinel, reset backoff, and settle
    // any orphaned working-drafts (a draft from a PRIOR socket will never
    // finalize on this new socket — keep its last text, drop the spinner).
    this.connecting = false;
    this.attempts = 0;
    const hadDraft = this.state.messages.some((m) => m.working);
    this.setState({
      status: "connected",
      connected: true,
      messages: hadDraft
        ? this.state.messages.map((m) =>
            m.working ? { ...m, working: false } : m,
          )
        : this.state.messages,
    });
  }

  private onMessage(event: MessageEvent): void {
    let parsed: OutboundWsMessage;
    try {
      parsed = JSON.parse(event.data);
    } catch {
      return;
    }

    switch (parsed.type) {
      case "approval_request": {
        const req: ApprovalRequest = {
          id: parsed.id,
          kind: parsed.kind,
          title: parsed.title,
          description: parsed.description,
          prompt: parsed.prompt,
          options: parsed.options,
          expiresAtMs: parsed.expiresAtMs,
        };
        const approvals = this.state.approvals;
        const idx = approvals.findIndex((a) => a.id === req.id);
        if (idx === -1) {
          this.setState({ approvals: [...approvals, req] });
        } else {
          const next = approvals.slice();
          next[idx] = req;
          this.setState({ approvals: next });
        }
        return;
      }

      case "approval_resolved": {
        const { id, decision } = parsed;
        this.patchApproval(id, (a) => ({ ...a, resolvedDecision: decision }));
        return;
      }

      case "progress": {
        // Render/replace a SINGLE working bubble keyed by the draft id.
        const { id, text } = parsed;
        this.upsertMessage(
          id,
          (prev) => ({ ...prev, text, working: true }),
          { id, role: "agent", text, working: true },
        );
        return;
      }

      case "agent_message": {
        const { text } = parsed;
        // With an id, finalize the matching draft (working → final answer).
        // Without an id (legacy/no-draft), append a fresh bubble.
        if (parsed.id) {
          const id = parsed.id;
          this.upsertMessage(
            id,
            (prev) => ({ ...prev, text, working: false }),
            { id, role: "agent", text, working: false },
          );
          return;
        }
        this.appendMessage({
          id: `a-${this.uid()}`,
          role: "agent",
          text,
        });
        return;
      }
    }
  }
}
