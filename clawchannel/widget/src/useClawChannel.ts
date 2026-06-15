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

/** Mirrors src/transport.ts envelopes on the plugin side. */
type InboundWsMessage = { type: "user_message"; text: string };
type OutboundWsMessage =
  | { type: "agent_message"; text: string; id?: string }
  | { type: "progress"; id: string; text: string };

function wsUrl(path: string): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}${path}`;
}

/**
 * Minimal WebSocket client hook for Phase 0:
 *  - connects to /clawchannel/ws on the gateway (same origin / Vite proxy)
 *  - exposes send(text) for the user input
 *  - dispatches incoming agent_message frames into the message list
 *
 * No reconnect/backoff logic in Phase 0 (deferred to Phase 1).
 */
export function useClawChannel() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    const ws = new WebSocket(wsUrl("/clawchannel/ws"));
    wsRef.current = ws;

    ws.onopen = () => setConnected(true);
    ws.onclose = () => setConnected(false);
    ws.onmessage = (event) => {
      let parsed: OutboundWsMessage;
      try {
        parsed = JSON.parse(event.data);
      } catch {
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

    return () => ws.close();
  }, []);

  const send = useCallback((text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    setMessages((prev) => [
      ...prev,
      { id: `u-${Date.now()}-${prev.length}`, role: "user", text: trimmed },
    ]);
    const payload: InboundWsMessage = { type: "user_message", text: trimmed };
    ws.send(JSON.stringify(payload));
  }, []);

  return { messages, connected, send };
}
