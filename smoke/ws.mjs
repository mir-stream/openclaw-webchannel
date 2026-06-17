import { WebSocket } from "ws";

const URL = process.env.WS_URL || "ws://127.0.0.1:18789/webchannel/ws";
const TEXT = process.env.MSG || "Reply with exactly: PONG-WEBCHANNEL";
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 120000);

const t0 = Date.now();
const ws = new WebSocket(URL);
let done = false;

const finish = (code, label, extra) => {
  if (done) return;
  done = true;
  const ms = Date.now() - t0;
  console.log(`\n[smoke] ${label} (${ms}ms)`);
  if (extra) console.log(extra);
  try { ws.close(); } catch {}
  process.exit(code);
};

const timer = setTimeout(
  () => finish(2, "TIMEOUT — no agent_message received"),
  TIMEOUT_MS,
);

ws.on("open", () => {
  console.log(`[smoke] connected: ${URL}`);
  console.log(`[smoke] sending user_message: ${JSON.stringify(TEXT)}`);
  ws.send(JSON.stringify({ type: "user_message", text: TEXT }));
});

ws.on("message", (data) => {
  const raw = typeof data === "string" ? data : data.toString();
  console.log(`[smoke] <- frame: ${raw}`);
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }
  if (msg && msg.type === "agent_message" && typeof msg.text === "string") {
    clearTimeout(timer);
    finish(0, "PASS — agent reply received", `agent text: ${JSON.stringify(msg.text)}`);
  }
});

ws.on("error", (err) => {
  clearTimeout(timer);
  finish(3, `WS ERROR: ${err?.message || err}`);
});

ws.on("close", (code, reason) => {
  if (!done) {
    clearTimeout(timer);
    finish(4, `CLOSED before reply: code=${code} reason=${reason?.toString() || ""}`);
  }
});
