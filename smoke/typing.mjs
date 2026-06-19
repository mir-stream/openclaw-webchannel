import { WebSocket } from "ws";

const URL = process.env.WS_URL || "ws://127.0.0.1:18789/webchannel/ws";
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 90000);

const t0 = Date.now();
const ms = () => `${String(Date.now() - t0).padStart(6)}ms`;
const ws = new WebSocket(URL);
let done = false;
const frames = [];

const finish = (code, label) => {
  if (done) return;
  done = true;
  const typings = frames.filter((f) => f.type === "typing");
  const realFrames = frames.filter((f) => f.type !== "typing");
  console.log(`\n[smoke] ${label}`);
  console.log(`[smoke] typing frames: ${typings.length}`);
  console.log(`[smoke] non-typing frames: ${realFrames.length} (${realFrames.map((f) => f.type).join(", ")})`);
  const typingOk = typings.length >= 1;
  const typingSettled = realFrames.length > 0;
  const verdict = typingOk && typingSettled
    ? `PASS — typing emitted (${typings.length}x) and settled by ${realFrames[0].type}`
    : typingOk
      ? "PARTIAL — typing emitted but no settling frame"
      : "FAIL — no typing frame at turn start";
  console.log(`[smoke] VERDICT: ${verdict}`);
  try { ws.close(); } catch {}
  process.exit(typingOk && typingSettled ? 0 : 2);
};

const timer = setTimeout(() => finish(2, "TIMEOUT"), TIMEOUT_MS);

ws.on("open", () => {
  console.log(`[${ms()}] connected ${URL}`);
  console.log(`[${ms()}] -> user_message: "ping"`);
  ws.send(JSON.stringify({ type: "user_message", text: "ping" }));
});

ws.on("message", (data) => {
  const raw = typeof data === "string" ? data : data.toString();
  let msg;
  try { msg = JSON.parse(raw); } catch { console.log(`[${ms()}] <- (unparseable) ${raw}`); return; }
  frames.push(msg);
  const preview = typeof msg.text === "string" ? JSON.stringify(msg.text.slice(0, 80)) : "";
  console.log(`[${ms()}] <- ${msg.type} id=${msg.id ?? "-"} ${preview}`);
  if (msg.type === "agent_message") {
    // Brief grace window in case more frames follow, then finish.
    clearTimeout(timer);
    setTimeout(() => finish(0, "reply finalized"), 1500);
  }
});

ws.on("error", (err) => { clearTimeout(timer); finish(3, `WS ERROR: ${err?.message || err}`); });
ws.on("close", (code) => { if (!done) { clearTimeout(timer); finish(4, `CLOSED code=${code}`); } });
