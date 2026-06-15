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
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
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

  return { messages, approvals, connected, send, decide };
}
