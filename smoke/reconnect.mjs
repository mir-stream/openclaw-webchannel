import { WebSocket } from "ws";

// Mirrors the widget's reconnect logic (exponential backoff + jitter) to prove
// the reconnect path live: round-trip, survive a gateway restart, round-trip again.
const URL = process.env.WS_URL || "ws://127.0.0.1:18789/webchannel/ws";
const t0 = Date.now();
const ms = () => `${String(Date.now() - t0).padStart(6)}ms`;

let ws;
let attempts = 0;
let phase = 1; // 1 = before restart, 2 = after reconnect
let got1 = false;
let got2 = false;
let reconnectedAfterDrop = false;

const log = (s) => console.log(`[${ms()}] ${s}`);

function connect() {
  ws = new WebSocket(URL);
  ws.on("open", () => {
    attempts = 0;
    log(`open (phase ${phase})`);
    if (phase === 1) {
      log(`-> ping1`);
      ws.send(JSON.stringify({ type: "user_message", text: "Reply with exactly: RT1" }));
    } else {
      reconnectedAfterDrop = true;
      // Wait briefly after reopen before sending — mirrors a human typing after
      // seeing the "connected" dot (and lets a just-restarted gateway settle).
      log(`RECONNECTED — waiting 3s then -> ping2`);
      setTimeout(() => {
        if (ws.readyState === WebSocket.OPEN) {
          log(`-> ping2`);
          ws.send(JSON.stringify({ type: "user_message", text: "Reply with exactly: RT2" }));
        }
      }, 3000);
    }
  });
  ws.on("message", (data) => {
    let m;
    try { m = JSON.parse(data.toString()); } catch { return; }
    if (m.type !== "agent_message") return;
    log(`<- agent_message ${JSON.stringify((m.text || "").slice(0, 40))}`);
    if (phase === 1) {
      got1 = true;
      phase = 2;
      log(`round-trip 1 OK — now waiting for gateway restart to drop the socket...`);
    } else {
      got2 = true;
      finish();
    }
  });
  ws.on("close", () => {
    log(`close (phase ${phase})`);
    if (got2) return;
    // Reconnect with exponential backoff + jitter (base 500ms, cap 10s).
    const delay = Math.min(10000, 500 * 2 ** attempts) * Math.random();
    attempts++;
    log(`scheduling reconnect #${attempts} in ${Math.round(delay)}ms`);
    setTimeout(connect, delay);
  });
  ws.on("error", (e) => log(`error: ${e?.message || e}`));
}

function finish() {
  const pass = got1 && reconnectedAfterDrop && got2;
  console.log(`\n[smoke] round-trip1=${got1} reconnected=${reconnectedAfterDrop} round-trip2=${got2}`);
  console.log(`[smoke] VERDICT: ${pass ? "PASS — auto-reconnected across gateway restart and resumed round-trips" : "FAIL"}`);
  try { ws.close(); } catch {}
  process.exit(pass ? 0 : 2);
}

setTimeout(() => { log("TIMEOUT"); finish(); }, 90000);
connect();
