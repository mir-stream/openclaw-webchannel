import { WebSocket } from "ws";
import { requireWsUrl } from "./_ws-url.mjs";

const URL = requireWsUrl();
const TEXT =
  process.env.MSG ||
  "Count slowly from 1 to 5, one number per line, with a short pause of thought before each.";
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 120000);

const t0 = Date.now();
const ms = () => `${String(Date.now() - t0).padStart(6)}ms`;
const ws = new WebSocket(URL);
let done = false;
const frames = [];

const finish = (code, label) => {
  if (done) return;
  done = true;
  const progress = frames.filter((f) => f.type === "progress");
  const finals = frames.filter((f) => f.type === "agent_message");
  console.log(`\n[smoke] ${label}`);
  console.log(`[smoke] progress frames: ${progress.length}, agent_message frames: ${finals.length}`);
  const progIds = new Set(progress.map((f) => f.id));
  const finalIds = new Set(finals.map((f) => f.id));
  const shared = [...finalIds].filter((id) => id && progIds.has(id));
  console.log(`[smoke] progress ids: ${JSON.stringify([...progIds])}`);
  console.log(`[smoke] final ids: ${JSON.stringify([...finalIds])}`);
  console.log(`[smoke] progress->final share same id: ${shared.length > 0 ? "YES " + JSON.stringify(shared) : "NO"}`);
  const verdict =
    progress.length > 0 && finals.length > 0 && shared.length > 0
      ? "PASS — draft updated then finalized in place (same id)"
      : progress.length > 0
        ? "PARTIAL — progress frames seen but no shared-id finalize"
        : "FAIL — no progress frames (draft never fired)";
  console.log(`[smoke] VERDICT: ${verdict}`);
  try { ws.close(); } catch {}
  process.exit(progress.length > 0 && finals.length > 0 ? 0 : 2);
};

const timer = setTimeout(() => finish(2, "TIMEOUT"), TIMEOUT_MS);

ws.on("open", () => {
  console.log(`[${ms()}] connected ${URL}`);
  console.log(`[${ms()}] -> user_message: ${JSON.stringify(TEXT)}`);
  ws.send(JSON.stringify({ type: "user_message", text: TEXT }));
});

ws.on("message", (data) => {
  const raw = typeof data === "string" ? data : data.toString();
  let msg;
  try { msg = JSON.parse(raw); } catch { console.log(`[${ms()}] <- (unparseable) ${raw}`); return; }
  frames.push(msg);
  const preview = typeof msg.text === "string" ? JSON.stringify(msg.text.slice(0, 80)) : "";
  console.log(`[${ms()}] <- ${msg.type} id=${msg.id ?? "-"} ${preview}`);
  if (msg.type === "agent_message") {
    // give a brief grace window in case more frames follow, then finish
    clearTimeout(timer);
    setTimeout(() => finish(0, "reply finalized"), 1500);
  }
});

ws.on("error", (err) => { clearTimeout(timer); finish(3, `WS ERROR: ${err?.message || err}`); });
ws.on("close", (code) => { if (!done) { clearTimeout(timer); finish(4, `CLOSED code=${code}`); } });
