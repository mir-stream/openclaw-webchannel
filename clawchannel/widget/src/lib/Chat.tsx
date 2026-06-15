import { useState } from "react";
import { useClawChannel } from "./useClawChannel.js";
import type { ApprovalDecision, UseClawChannelOptions } from "./useClawChannel.js";

/** Map an approval option style hint to a button background color. */
function approvalButtonColor(style: string, disabled: boolean): string {
  if (disabled) return "#ccc";
  switch (style) {
    case "success":
      return "#2ecc71";
    case "danger":
      return "#e74c3c";
    case "primary":
      return "#0a84ff";
    default:
      return "#888";
  }
}

const DECISION_LABEL: Record<ApprovalDecision, string> = {
  "allow-once": "Allowed once",
  "allow-always": "Allowed always",
  deny: "Denied",
};

/**
 * `options` are forwarded straight to the connection hook (e.g. a host-supplied
 * `getTicket` for the hmac-ticket auth strategy). Omitting them keeps the
 * anonymous dev path: connect with no ticket.
 */
export function Chat({ options }: { options?: UseClawChannelOptions } = {}) {
  const { messages, approvals, connected, status, send, decide } =
    useClawChannel(options);
  const [input, setInput] = useState("");

  // Connection dot: green when connected, amber while (re)connecting, grey when
  // disconnected with no reconnect in flight.
  const dotColor =
    status === "connected"
      ? "#2ecc71"
      : status === "reconnecting" || status === "connecting"
        ? "#f0ad4e"
        : "#bbb";

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    send(input);
    setInput("");
  };

  return (
    <div style={{ maxWidth: 480, margin: "2rem auto", fontFamily: "system-ui" }}>
      <h2 style={{ display: "flex", alignItems: "center", gap: 8 }}>
        ClawChannel
        <span
          title={status}
          style={{
            width: 10,
            height: 10,
            borderRadius: "50%",
            background: dotColor,
          }}
        />
      </h2>

      <div
        style={{
          border: "1px solid #ddd",
          borderRadius: 8,
          padding: 12,
          height: 360,
          overflowY: "auto",
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}
      >
        {messages.map((m) => (
          <div
            key={m.id}
            style={{
              alignSelf: m.role === "user" ? "flex-end" : "flex-start",
              // A live progress draft renders in a distinct muted/italic style;
              // it transitions to the normal agent bubble once finalized.
              background: m.role === "user" ? "#0a84ff" : m.working ? "#f4f0e6" : "#eee",
              color: m.role === "user" ? "white" : m.working ? "#7a6f57" : "black",
              fontStyle: m.working ? "italic" : "normal",
              border: m.working ? "1px dashed #d8cfb8" : "none",
              padding: "6px 10px",
              borderRadius: 12,
              maxWidth: "80%",
              whiteSpace: "pre-wrap",
            }}
          >
            {m.text}
          </div>
        ))}

        {approvals.map((a) => {
          const resolved = a.resolvedDecision !== undefined;
          return (
            <div
              key={`approval-${a.id}`}
              style={{
                alignSelf: "flex-start",
                background: "#fff8e1",
                border: "1px solid #f0d98c",
                borderRadius: 12,
                padding: "10px 12px",
                maxWidth: "90%",
                display: "flex",
                flexDirection: "column",
                gap: 8,
              }}
            >
              <div style={{ fontWeight: 600 }}>
                {a.kind === "exec" ? "Approval required" : "Plugin approval"}
              </div>
              <div style={{ whiteSpace: "pre-wrap", color: "#5a4b1f" }}>
                {a.prompt}
              </div>
              {resolved ? (
                <div style={{ fontStyle: "italic", color: "#7a6f57" }}>
                  {DECISION_LABEL[a.resolvedDecision!]}
                </div>
              ) : (
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {a.options.map((opt) => (
                    <button
                      key={opt.decision}
                      type="button"
                      disabled={resolved}
                      onClick={() => decide(a.id, opt.decision)}
                      style={{
                        padding: "6px 12px",
                        borderRadius: 8,
                        border: "none",
                        color: "white",
                        cursor: resolved ? "default" : "pointer",
                        background: approvalButtonColor(opt.style, resolved),
                      }}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <form onSubmit={onSubmit} style={{ display: "flex", gap: 8, marginTop: 8 }}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          disabled={!connected}
          placeholder={connected ? "Type a message…" : "Connecting…"}
          style={{ flex: 1, padding: 8, borderRadius: 8, border: "1px solid #ccc" }}
        />
        <button type="submit" disabled={!connected} style={{ padding: "8px 16px" }}>
          Send
        </button>
      </form>
    </div>
  );
}
