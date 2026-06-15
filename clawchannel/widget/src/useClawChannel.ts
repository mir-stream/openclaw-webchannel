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
 */
export function useClawChannel() {
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
        connect();
      }, delay);
    };

    const onOpen = () => {
      // Successful (re)connect: reset backoff and settle any orphaned drafts.
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

    function connect() {
      if (unmountedRef.current) return;
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

      setStatus(attemptsRef.current === 0 ? "connecting" : "reconnecting");
      const ws = new WebSocket(wsUrl("/clawchannel/ws"));
      wsRef.current = ws;

      ws.onopen = onOpen;
      ws.onclose = () => {
        if (wsRef.current === ws) wsRef.current = null;
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

    connect();

    return () => {
      // (a) prevent any reconnect-after-unmount, (b) clear a pending timer,
      // (c) close the live socket. Null its handlers so the close we trigger
      // here doesn't re-enter scheduleReconnect.
      unmountedRef.current = true;
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
