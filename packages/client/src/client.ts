import type {
  ApprovalDecision,
  ApprovalRequest,
  ChatMessage,
  WebChannelOptions,
  WebChannelState,
  ConnectionStatus,
  InboundWsMessage,
  Listener,
  OutboundWsMessage,
} from "./types.js";

/** Default WebSocket path on the gateway (same origin). */
const DEFAULT_WS_PATH = "/webchannel/ws";

/** Reconnect backoff: base delay, growth factor, and a hard cap. */
const RECONNECT_BASE_MS = 500;
const RECONNECT_FACTOR = 2;
const RECONNECT_CAP_MS = 10_000;

/**
 * Headless WebChannel client: owns the WebSocket, the reconnect policy, the
 * wire-protocol parsing, AND the transcript/approval state. It is framework- and
 * DOM-render-free — consumers `subscribe` to immutable state snapshots and call
 * `send` / `decide`. The React widget and any vanilla/Vue UI are thin views on
 * top of this single source of truth.
 *
 * Lifecycle: construct → `connect()` → … → `close()`. `connect()`/`close()` are
 * the only lifecycle calls; everything else is driven by socket events.
 *
 *   const client = new WebChannelClient({ getTicket });
 *   const unsub = client.subscribe((state) => render(state));
 *   client.connect();
 *   client.send("hello");
 *   // later: unsub(); client.close();
 */
export class WebChannelClient {
  private readonly options: WebChannelOptions;

  private state: WebChannelState = {
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

  constructor(options: WebChannelOptions = {}) {
    this.options = options;
  }

  /** The current immutable state snapshot. */
  getState(): WebChannelState {
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

  /**
   * Ask the server for older messages (history pagination). The server
   * replies with a `history` frame carrying the page; the client prepends
   * the messages and deduplicates by id.
   *
   * Per the seed this method is UI-triggered (scroll-to-top, "Load more"
   * button). The client does NOT auto-fire it on its own; the host app
   * decides when the user has asked for more context. When the socket is
   * not OPEN the call is a no-op (history is best-effort — the user can
   * retry once the connection is back).
   */
  loadHistory(request?: { before?: string; limit?: number }): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const payload: InboundWsMessage = {
      type: "load_history",
      ...(request?.before !== undefined ? { before: request.before } : {}),
      ...(request?.limit !== undefined ? { limit: request.limit } : {}),
    };
    ws.send(JSON.stringify(payload));
  }

  // ── state plumbing ────────────────────────────────────────────────────────

  private setState(patch: Partial<WebChannelState>): void {
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
      case "history": {
        // Initial on-connect snapshot OR a `load_history` response. We PREPEND
        // messages to the transcript (the server returns oldest-first within
        // a page; prepending keeps each page in the right slot relative to
        // existing newer bubbles already on screen) and DEDUPLICATE by id —
        // overlapping windows between the snapshot and a later page (or a
        // duplicate frame after a reconnect) become a no-op.
        //
        // We never clobber `isTyping` or the user's draft: history is a
        // transcript-only update. `working:false` is forced on every hydrated
        // message — a stale "working" flag from a prior session would render
        // a spinner forever.
        const incoming = Array.isArray(parsed.messages) ? parsed.messages : [];
        if (incoming.length === 0) return;
        const existing = this.state.messages;
        const seen = new Set(existing.map((m) => m.id));
        // Dedup + coerce: keep only messages whose id is new (and not the
        // pending draft id we currently own client-side), and force `working`
        // to false — history snapshots are settled bubbles, not live drafts.
        const fresh: ChatMessage[] = [];
        for (const m of incoming) {
          if (!m || typeof m !== "object") continue;
          if (typeof m.id !== "string" || m.id.length === 0) continue;
          if (m.role !== "user" && m.role !== "agent") continue;
          if (typeof m.text !== "string") continue;
          if (seen.has(m.id)) continue;
          seen.add(m.id);
          fresh.push({ id: m.id, role: m.role, text: m.text, ts: m.ts, working: false });
        }
        if (fresh.length === 0) return;
        // Prepend in arrival order — the server returns oldest-first within a
        // page, so `[...fresh, ...existing]` puts each page in its correct
        // slot above the newer bubbles.
        this.setState({ messages: [...fresh, ...existing] });
        return;
      }

      case "typing": {
        // Native "Bot is typing…" affordance. The server pushes this once at
        // the START of a turn (after route resolution, before agent dispatch);
        // the first real frame from the agent (progress / agent_message /
        // approval_*) clears it via the per-case `isTyping: false` patch below.
        // We always flip to true on a fresh typing frame (idempotent — even if
        // a duplicate arrives after progress has already settled, the next
        // incoming frame simply re-clears it). This keeps the logic tiny and
        // matches Telegram/Discord semantics: best-effort, no ack, no stop.
        this.setState({ isTyping: true });
        return;
      }

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
          this.setState({
            approvals: [...approvals, req],
            // The agent is no longer "typing" — it is BLOCKED on the user, not
            // still working. Clear the indicator so a UI doesn't show both a
            // spinner and an approval card at once.
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
        const { id, decision } = parsed;
        this.patchApproval(id, (a) => ({ ...a, resolvedDecision: decision }));
        return;
      }

      case "progress": {
        // Render/replace a SINGLE working bubble keyed by the draft id. The
        // first `progress` frame settles the typing indicator: a working
        // bubble supersedes "Bot is typing…", and a duplicate typing frame
        // arriving afterwards will just re-arm it (no harm — the next real
        // frame clears it again).
        const { id, text } = parsed;
        this.upsertMessage(
          id,
          (prev) => ({ ...prev, text, working: true }),
          { id, role: "agent", text, working: true },
        );
        this.setState({ isTyping: false });
        return;
      }

      case "agent_message": {
        const { text } = parsed;
        // With an id, finalize the matching draft (working → final answer).
        // Without an id (legacy/no-draft), append a fresh bubble. The first
        // `agent_message` (with or without id) settles the typing indicator
        // — the final answer is here, the agent is done working.
        this.setState({ isTyping: false });
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
