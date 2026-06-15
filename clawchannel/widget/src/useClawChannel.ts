import { useCallback, useEffect, useRef, useState } from "react";

export type ChatRole = "user" | "agent";
export type ChatMessage = { id: string; role: ChatRole; text: string };

/** Mirrors src/transport.ts envelopes on the plugin side. */
type InboundWsMessage = { type: "user_message"; text: string };
type OutboundWsMessage = { type: "agent_message"; text: string };

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
      if (parsed.type === "agent_message") {
        setMessages((prev) => [
          ...prev,
          { id: `a-${Date.now()}-${prev.length}`, role: "agent", text: parsed.text },
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
