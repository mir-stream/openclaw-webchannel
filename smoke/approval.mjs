import { WebSocket } from "ws";

const URL = process.env.WS_URL || "ws://127.0.0.1:18789/clawchannel/ws";
const TEXT =
  process.env.MSG ||
  "Use your tools to list the files in your workspace directory, then tell me how many there are.";
const DECISION = process.env.DECISION || "allow-once";
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 120000);

const t0 = Date.now();
const ms = () => `${String(Date.now() - t0).padStart(6)}ms`;
const ws = new WebSocket(URL);
let done = false;
const seen = { approval_request: 0, approval_resolved: 0, agent_message: 0, progress: 0 };
let approvedId = null;

const finish = (label) => {
  if (done) return;
  done = true;
  console.log(`\n[smoke] ${label}`);
  console.log(`[smoke] counts: ${JSON.stringify(seen)}`);
  const pass =
    seen.approval_request > 0 && seen.approval_resolved > 0 && seen.agent_message > 0;
  console.log(
    `[smoke] VERDICT: ${pass ? "PASS — approval requested, decided, resolved, run completed" : "FAIL/PARTIAL — see counts above"}`,
  );
  try { ws.close(); } catch {}
  process.exit(pass ? 0 : 2);
};

const timer = setTimeout(() => finish("TIMEOUT"), TIMEOUT_MS);

ws.on("open", () => {
  console.log(`[${ms()}] connected ${URL}`);
  console.log(`[${ms()}] -> user_message: ${JSON.stringify(TEXT)}`);
  ws.send(JSON.stringify({ type: "user_message", text: TEXT }));
});

ws.on("message", (data) => {
  const raw = typeof data === "string" ? data : data.toString();
  let m;
  try { m = JSON.parse(raw); } catch { return; }
  if (m.type in seen) seen[m.type]++;
  const text = typeof m.text === "string" ? JSON.stringify(m.text.slice(0, 70)) : "";
  const opts = m.options ? ` options=${JSON.stringify(m.options.map((o) => o.decision))}` : "";
  console.log(`[${ms()}] <- ${m.type} id=${m.id ?? "-"}${opts} ${m.title ?? ""} ${text}`);

  if (m.type === "approval_request" && !approvedId) {
    approvedId = m.id;
    console.log(`[${ms()}] -> approval_decision id=${m.id} decision=${DECISION}`);
    ws.send(JSON.stringify({ type: "approval_decision", id: m.id, decision: DECISION }));
  }
  if (m.type === "agent_message") {
    clearTimeout(timer);
    setTimeout(() => finish("run completed"), 2000);
  }
});

ws.on("error", (e) => { clearTimeout(timer); finish(`WS ERROR: ${e?.message || e}`); });
ws.on("close", (c) => { if (!done) { clearTimeout(timer); finish(`CLOSED code=${c}`); } });
