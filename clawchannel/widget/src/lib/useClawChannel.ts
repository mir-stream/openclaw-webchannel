import { useCallback, useEffect, useRef, useState } from "react";

export type ChatRole = "user" | "agent";
/**
 * `working: true` marks a live progress-draft bubble (rolling "Working…" + tool
 * lines). It flips to false when the same id is finalized into the answer.
 */
export type ChatMessage = {
  id: string;
  role: ChatRole;
  text: string;
  working?: boolean;
};

/** Native HITL approval decision; mirrors the plugin/SDK union. */
export type ApprovalDecision = "allow-once" | "allow-always" | "deny";

/** One offered approval button. */
export type ApprovalOption = {
  decision: ApprovalDecision;
  label: string;
  style: string;
};

/**
 * A pending (or just-resolved) native approval prompt rendered as a distinct
 * card in the transcript. `resolvedDecision` flips set once `approval_resolved`
 * arrives (or we optimistically record the click), disabling the buttons.
 */
export type ApprovalRequest = {
  id: string;
  kind: "exec" | "plugin";
  title: string;
  description?: string;
  prompt: string;
  options: ApprovalOption[];
  expiresAtMs?: number;
  resolvedDecision?: ApprovalDecision;
};

/** Mirrors src/transport.ts envelopes on the plugin side. */
type InboundWsMessage =
  | { type: "user_message"; text: string }
  | { type: "approval_decision"; id: string; decision: ApprovalDecision };
type OutboundWsMessage =
  | { type: "agent_message"; text: string; id?: string }
  | { type: "progress"; id: string; text: string }
  | {
      type: "approval_request";
      id: string;
      kind: "exec" | "plugin";
      title: string;
      description?: string;
      prompt: string;
      options: ApprovalOption[];
      expiresAtMs?: number;
    }
  | { type: "approval_resolved"; id: string; decision: ApprovalDecision };

function wsUrl(path: string): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}${path}`;
}

/** Default WebSocket path on the gateway (same origin / Vite proxy). */
const DEFAULT_WS_PATH = "/clawchannel/ws";

/**
 * Hook options (all optional — the zero-arg call keeps the anonymous dev path).
 *
 *  - `getTicket`: the host (e.g. a SaaS embed) supplies a short-lived signed
 *    ticket for the `hmac-ticket` server strategy. Called on EVERY (re)connect
 *    so a reconnect always gets a FRESH ticket (the SaaS session is long-lived;
 *    the ticket is short-lived — see AUTH.md §5/§6). Returning null/empty (or a
 *    no-op for cookie/trusted-header auth) connects with no ticket.
 *  - `path`: override the WS path (defaults to `/clawchannel/ws`).
 */
export type UseClawChannelOptions = {
  getTicket?: () => Promise<string | null>;
  path?: string;
};

/** Connection status, richer than a bool, for the UI dot. */
export type ConnectionStatus = "connecting" | "connected" | "reconnecting";

/** Reconnect backoff: base delay, growth factor, and a hard cap. */
const RECONNECT_BASE_MS = 500;
const RECONNECT_FACTOR = 2;
const RECONNECT_CAP_MS = 10_000;

/**
 * WebSocket client hook (Phase 1: reconnect-hardened).
 *  - connects to /clawchannel/ws on the gateway (same origin / Vite proxy)
 *  - exposes send(text) / decide(id, decision) for user input
 *  - dispatches incoming frames into the message / approval lists
 *  - on a dropped socket, reconnects with exponential backoff + jitter
 *
 * No message replay / outbound queue this slice (see send path TODO).
 *
 * Auth: when `options.getTicket` is provided it is awaited on every (re)connect
 * and, if it yields a non-empty token, attached as the `?ticket=` query param
 * the `hmac-ticket` server strategy reads. With no options the socket opens with
 * no ticket exactly as before (the anonymous server strategy).
 */
export function useClawChannel(options?: UseClawChannelOptions) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const [connected, setConnected] = useState(false);
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const wsRef = useRef<WebSocket | null>(null);

  // Reconnect bookkeeping kept in refs so the connect closure stays stable and
  // the effect cleanup can cancel an in-flight reconnect without re-running.
  const unmountedRef = useRef(false);
  const attemptsRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // SYNCHRONOUS in-flight sentinel. `connect()` is async and `await`s
  // getTicket() before it ever assigns wsRef.current, so the wsRef readyState
  // guard alone can't stop two concurrent connect() calls (StrictMode
  // mount→unmount→mount with getTicket set) from BOTH passing the post-await
  // guard and opening two sockets. We set this true at the very top of connect()
  // before any await and bail synchronously if it's already set; it is reset to
  // false on EVERY terminal outcome so a reconnect is never permanently blocked.
  const connectingRef = useRef(false);

  // Keep the latest options in a ref so the connect closure (stable across the
  // effect's lifetime) always reads the current getTicket/path without needing
  // them in the effect deps (which would tear down + reconnect on every render).
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    unmountedRef.current = false;

    const clearReconnectTimer = () => {
      if (reconnectTimerRef.current !== null) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
    };

    const scheduleReconnect = () => {
      if (unmountedRef.current) return;
      if (reconnectTimerRef.current !== null) return; // already scheduled
      setConnected(false);
      setStatus("reconnecting");
      // Exponential backoff with full jitter, capped. Jitter avoids a
      // thundering herd if the gateway restarts and many tabs reconnect at once.
      const exp = Math.min(
        RECONNECT_CAP_MS,
        RECONNECT_BASE_MS * RECONNECT_FACTOR ** attemptsRef.current,
      );
      const delay = Math.random() * exp;
      attemptsRef.current += 1;
      reconnectTimerRef.current = setTimeout(() => {
        reconnectTimerRef.current = null;
        // connect() is async (it may await getTicket); it handles its own
        // failures internally, so a rejection here would be a bug — swallow
        // defensively so it never surfaces as an unhandled rejection.
        void connect().catch(() => scheduleReconnect());
      }, delay);
    };

    const onOpen = () => {
      // Successful (re)connect: socket is no longer "connecting", so release the
      // sentinel; reset backoff and settle any orphaned drafts.
      connectingRef.current = false;
      attemptsRef.current = 0;
      setConnected(true);
      setStatus("connected");
      // A working-draft bubble from a PRIOR socket will never finalize on this
      // new socket (its progress id is owned by the old turn). Settle them to
      // working:false so the UI shows no perpetual spinner. We keep the text
      // (the last partial) rather than dropping it, since it's the most recent
      // thing the user saw.
      setMessages((prev) =>
        prev.some((m) => m.working)
          ? prev.map((m) => (m.working ? { ...m, working: false } : m))
          : prev,
      );
    };

    async function connect() {
      if (unmountedRef.current) return;
      // SYNCHRONOUS double-connect guard: bail if a connect() is already
      // in-flight (set before any await, so a second concurrent call sees it
      // even while the first is mid-`await getTicket()`). This is the only guard
      // that survives the await window; the wsRef readyState checks below are a
      // belt-and-suspenders backstop for an already-open/connecting socket.
      if (connectingRef.current) return;
      // Guard against double-connect (StrictMode double-invoke / overlap): if a
      // live or connecting socket already exists, don't open a second one.
      const existing = wsRef.current;
      if (
        existing &&
        (existing.readyState === WebSocket.OPEN ||
          existing.readyState === WebSocket.CONNECTING)
      ) {
        return;
      }
      // Claim the in-flight slot before any await.
      connectingRef.current = true;

      setStatus(attemptsRef.current === 0 ? "connecting" : "reconnecting");

      const opts = optionsRef.current;
      const path = opts?.path ?? DEFAULT_WS_PATH;

      // Fetch a fresh ticket on EVERY (re)connect (AUTH.md §5: short-lived
      // ticket vs long-lived SaaS session). A null/empty result connects with
      // no ticket (anonymous / cookie / trusted-header auth). A throw or a
      // hard auth failure is treated like a failed connection below.
      let url = wsUrl(path);
      if (opts?.getTicket) {
        let token: string | null;
        try {
          token = await opts.getTicket();
        } catch {
          // getTicket failed (network/session error). Don't crash — schedule a
          // reconnect via the normal backoff path. NOTE: a hard auth failure
          // (e.g. expired SaaS session) currently just retries forever; a real
          // login-redirect/give-up policy is out of scope for this slice.
          // Terminal outcome: release the sentinel so the scheduled reconnect
          // isn't permanently blocked.
          connectingRef.current = false;
          scheduleReconnect();
          return;
        }
        // The component may have unmounted while we awaited getTicket; if so,
        // abort without opening a socket. The effect cleanup also clears the
        // sentinel, but release it here too so we never leave it dangling.
        if (unmountedRef.current) {
          connectingRef.current = false;
          return;
        }
        // Re-check the readyState guard: an OPEN/CONNECTING socket already
        // exists, so this attempt abandons without opening another. (The
        // synchronous sentinel makes a true second concurrent connect()
        // impossible to reach here; this backstops a stale wsRef left CONNECTING
        // by a prior attempt.) Release the sentinel: THIS attempt set it and is
        // bailing, and the existing socket drives its own onopen/onclose.
        const live = wsRef.current;
        if (
          live &&
          (live.readyState === WebSocket.OPEN ||
            live.readyState === WebSocket.CONNECTING)
        ) {
          connectingRef.current = false;
          return;
        }
        if (!token) {
          // No ticket available — for hmac-ticket the server rejects the
          // upgrade, so treat it as a failed connection and back off. Terminal
          // outcome: release the sentinel before scheduling the reconnect.
          connectingRef.current = false;
          scheduleReconnect();
          return;
        }
        url = `${url}?ticket=${encodeURIComponent(token)}`;
      }

      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = onOpen;
      ws.onclose = () => {
        if (wsRef.current === ws) wsRef.current = null;
        // Socket left the connecting state (it may never have reached onopen, so
        // release the sentinel here too); this is a terminal outcome for THIS
        // connect() attempt. onerror routes through here via ws.close().
        connectingRef.current = false;
        if (unmountedRef.current) return;
        scheduleReconnect();
      };
      ws.onerror = () => {
        // An error is followed by close in browsers, but close `ws` defensively
        // so the socket can't linger; the close handler drives the reconnect.
        try {
          ws.close();
        } catch {
          /* ignore */
        }
      };
      ws.onmessage = onMessage;
    }

    const onMessage = (event: MessageEvent) => {
      let parsed: OutboundWsMessage;
      try {
        parsed = JSON.parse(event.data);
      } catch {
        return;
      }

      if (parsed.type === "approval_request") {
        // Store/replace the pending approval card keyed by id.
        const req: ApprovalRequest = {
          id: parsed.id,
          kind: parsed.kind,
          title: parsed.title,
          description: parsed.description,
          prompt: parsed.prompt,
          options: parsed.options,
          expiresAtMs: parsed.expiresAtMs,
        };
        setApprovals((prev) => {
          const idx = prev.findIndex((a) => a.id === req.id);
          if (idx === -1) return [...prev, req];
          const next = prev.slice();
          next[idx] = req;
          return next;
        });
        return;
      }

      if (parsed.type === "approval_resolved") {
        // Mark the card resolved: buttons disable, outcome shown.
        const { id, decision } = parsed;
        setApprovals((prev) =>
          prev.map((a) =>
            a.id === id ? { ...a, resolvedDecision: decision } : a,
          ),
        );
        return;
      }

      if (parsed.type === "progress") {
        // Render/replace a SINGLE working bubble keyed by the draft id.
        const { id, text } = parsed;
        setMessages((prev) => {
          const idx = prev.findIndex((m) => m.id === id);
          if (idx === -1) {
            return [...prev, { id, role: "agent", text, working: true }];
          }
          const next = prev.slice();
          next[idx] = { ...next[idx], text, working: true };
          return next;
        });
        return;
      }

      if (parsed.type === "agent_message") {
        const { text } = parsed;
        // With an id, finalize the matching draft bubble in place (working ->
        // final answer). Without an id (legacy/no-draft), append a fresh bubble.
        if (parsed.id) {
          const id = parsed.id;
          setMessages((prev) => {
            const idx = prev.findIndex((m) => m.id === id);
            if (idx === -1) {
              return [...prev, { id, role: "agent", text, working: false }];
            }
            const next = prev.slice();
            next[idx] = { ...next[idx], text, working: false };
            return next;
          });
          return;
        }
        setMessages((prev) => [
          ...prev,
          { id: `a-${Date.now()}-${prev.length}`, role: "agent", text },
        ]);
      }
    };

    void connect().catch(() => scheduleReconnect());

    return () => {
      // (a) prevent any reconnect-after-unmount, (b) clear a pending timer,
      // (c) close the live socket. Null its handlers so the close we trigger
      // here doesn't re-enter scheduleReconnect.
      unmountedRef.current = true;
      // Release the in-flight sentinel so a remount (StrictMode) can connect()
      // again — a connect() still mid-`await getTicket()` will see unmountedRef
      // and bail, but it must not leave the sentinel latched for the next mount.
      connectingRef.current = false;
      clearReconnectTimer();
      const ws = wsRef.current;
      wsRef.current = null;
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
    };
  }, []);

  const send = useCallback((text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const ws = wsRef.current;
    // TODO(reconnect): message replay + idempotency dedupe deferred
    // Drop if not OPEN (no queue/replay this slice).
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    setMessages((prev) => [
      ...prev,
      { id: `u-${Date.now()}-${prev.length}`, role: "user", text: trimmed },
    ]);
    const payload: InboundWsMessage = { type: "user_message", text: trimmed };
    ws.send(JSON.stringify(payload));
  }, []);

  /**
   * Send an approval decision for `id`. Optimistically marks the card resolved
   * so the buttons disable immediately; the authoritative `approval_resolved`
   * frame from the plugin confirms/overwrites the outcome.
   */
  const decide = useCallback((id: string, decision: ApprovalDecision) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    setApprovals((prev) =>
      prev.map((a) =>
        a.id === id && a.resolvedDecision === undefined
          ? { ...a, resolvedDecision: decision }
          : a,
      ),
    );
    const payload: InboundWsMessage = {
      type: "approval_decision",
      id,
      decision,
    };
    ws.send(JSON.stringify(payload));
  }, []);

  return { messages, approvals, connected, status, send, decide };
}
