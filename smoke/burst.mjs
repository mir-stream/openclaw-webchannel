import { WebSocket } from "ws";
import crypto from "node:crypto";

// E2E burst test: prove the channel survives rapid back-to-back messages on a
// SINGLE session ("다다다닥"). We open one authenticated WebSocket, fire N
// user_messages with no gap between them, then count how many of them the agent
// actually finalizes (one `agent_message` final per completed turn).
//
// RED (pre-fix, fire-and-forget inbound): the N turns run concurrently on the
// same session and collide on core's per-session reply-operation admission gate,
// so FEWER than N finals come back (the channel wedges — progress bubbles that
// never settle, dropped replies). GREEN (per-session FIFO serialization): all N
// messages are answered, in order.
//
// Run with WEBCHANNEL_TICKET_SECRET set to the gateway's secret
// (source ~/.openclaw/.env). Exits 0 only if finals === N.

const SECRET = process.env.WEBCHANNEL_TICKET_SECRET;
if (!SECRET) {
  console.error("WEBCHANNEL_TICKET_SECRET not set (source ~/.openclaw/.env)");
  process.exit(3);
}

const BASE = "ws://127.0.0.1:18789/webchannel/ws";
const SUB = process.env.BURST_SUB || "web-anon"; // must be in allowFrom
const N = Number(process.env.BURST_N || 5);
const HARD_TIMEOUT_MS = Number(process.env.BURST_TIMEOUT_MS || 180000);
// If nothing arrives for this long after the last frame, assume the channel has
// wedged and stop early (keeps the RED run from always burning the hard cap).
const IDLE_MS = Number(process.env.BURST_IDLE_MS || 45000);

const b64 = (s) => Buffer.from(s).toString("base64url");
function mint(secret, sub, ttl = 120) {
  const header = b64(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const iat = Math.floor(Date.now() / 1000);
  const payload = b64(JSON.stringify({ sub, iat, exp: iat + ttl }));
  const si = `${header}.${payload}`;
  const sig = crypto.createHmac("sha256", secret).update(si).digest("base64url");
  return `${si}.${sig}`;
}

const url = `${BASE}?ticket=${encodeURIComponent(mint(SECRET, SUB))}`;
const ws = new WebSocket(url);

const t0 = Date.now();
let done = false;
let finals = 0;
const frameHistogram = Object.create(null);
const finalTexts = [];
let idleTimer = null;

const finish = (code, label) => {
  if (done) return;
  done = true;
  if (idleTimer) clearTimeout(idleTimer);
  clearTimeout(hardTimer);
  const ms = Date.now() - t0;
  console.log(`\n[burst] ${label} (${ms}ms)`);
  console.log(`[burst] sent=${N} finals=${finals}`);
  console.log(`[burst] frame histogram: ${JSON.stringify(frameHistogram)}`);
  console.log(`[burst] final texts: ${JSON.stringify(finalTexts)}`);
  console.log(
    finals === N
      ? `[burst] PASS — all ${N} messages answered`
      : `[burst] FAIL — only ${finals}/${N} answered (channel wedged)`,
  );
  try { ws.close(); } catch {}
  process.exit(code);
};

const hardTimer = setTimeout(
  () => finish(finals === N ? 0 : 1, "HARD TIMEOUT"),
  HARD_TIMEOUT_MS,
);

const armIdle = () => {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(
    () => finish(finals === N ? 0 : 1, "IDLE — no frames, assuming wedged"),
    IDLE_MS,
  );
};

ws.on("open", () => {
  console.log(`[burst] connected as sub=${SUB}; firing ${N} messages back-to-back`);
  for (let k = 1; k <= N; k++) {
    ws.send(
      JSON.stringify({
        type: "user_message",
        text: `This is burst message number ${k}. Reply with only the number ${k} and nothing else.`,
      }),
    );
  }
  console.log(`[burst] all ${N} messages sent at +${Date.now() - t0}ms`);
  armIdle();
});

ws.on("message", (d) => {
  let m;
  try { m = JSON.parse(d.toString()); } catch { return; }
  frameHistogram[m.type] = (frameHistogram[m.type] || 0) + 1;
  armIdle();
  // A finalized turn is an `agent_message` (progress mode finalizes the draft
  // into an agent_message carrying the same id; non-progress sends a plain one).
  if (m.type === "agent_message") {
    finals++;
    finalTexts.push((m.text || "").replace(/\s+/g, " ").slice(0, 40));
    console.log(`[burst] <- final #${finals} at +${Date.now() - t0}ms`);
    if (finals >= N) finish(0, "ALL ANSWERED");
  }
});

ws.on("unexpected-response", (_req, res) =>
  finish(3, `WS REJECTED status=${res.statusCode}`),
);
ws.on("error", (err) => finish(3, `WS ERROR: ${err?.message || err}`));
ws.on("close", () => { if (!done) finish(finals === N ? 0 : 1, "CLOSED"); });
