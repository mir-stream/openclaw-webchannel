import { useState } from "react";
import { useClawChannel } from "./useClawChannel";

export function Chat() {
  const { messages, connected, send } = useClawChannel();
  const [input, setInput] = useState("");

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
          title={connected ? "connected" : "disconnected"}
          style={{
            width: 10,
            height: 10,
            borderRadius: "50%",
            background: connected ? "#2ecc71" : "#bbb",
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
              background: m.role === "user" ? "#0a84ff" : "#eee",
              color: m.role === "user" ? "white" : "black",
              padding: "6px 10px",
              borderRadius: 12,
              maxWidth: "80%",
              whiteSpace: "pre-wrap",
            }}
          >
            {m.text}
          </div>
        ))}
      </div>

      <form onSubmit={onSubmit} style={{ display: "flex", gap: 8, marginTop: 8 }}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Type a message…"
          style={{ flex: 1, padding: 8, borderRadius: 8, border: "1px solid #ccc" }}
        />
        <button type="submit" disabled={!connected} style={{ padding: "8px 16px" }}>
          Send
        </button>
      </form>
    </div>
  );
}
