import { WebSocket } from "ws";
import crypto from "node:crypto";

// E2E against a live gateway with channels.webchannel.auth = hmac-ticket.
// Proves: valid ticket connects + round-trips with the agent; missing/wrong
// ticket is rejected at the WS upgrade. Run with WEBCHANNEL_TICKET_SECRET set
// to the same secret the gateway uses (source ~/.openclaw/.env).
const SECRET = process.env.WEBCHANNEL_TICKET_SECRET;
if (!SECRET) {
  console.error("WEBCHANNEL_TICKET_SECRET not set");
  process.exit(3);
}
const BASE = "ws://127.0.0.1:18789/webchannel/ws";
const b64 = (s) => Buffer.from(s).toString("base64url");

function mint(secret, sub, ttl = 60) {
  const header = b64(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const iat = Math.floor(Date.now() / 1000);
  const payload = b64(JSON.stringify({ sub, iat, exp: iat + ttl }));
  const si = `${header}.${payload}`;
  const sig = crypto.createHmac("sha256", secret).update(si).digest("base64url");
  return `${si}.${sig}`;
}

function attempt({ name, url, sendMsg, timeoutMs = 90000 }) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    let opened = false;
    let status = null;
    const frames = [];
    let finalText = null;
    const done = (verdict) => {
      try { ws.close(); } catch {}
      resolve({ name, verdict, httpStatus: status, opened, frames, finalText });
    };
    const to = setTimeout(() => done(opened ? "OPENED_BUT_NO_REPLY" : "TIMEOUT"), timeoutMs);
    ws.on("unexpected-response", (_req, res) => { status = res.statusCode; clearTimeout(to); done("REJECTED"); });
    ws.on("open", () => {
      opened = true;
      if (sendMsg) ws.send(JSON.stringify({ type: "user_message", text: sendMsg }));
      else { clearTimeout(to); done("OPEN_OK"); }
    });
    ws.on("message", (d) => {
      let m;
      try { m = JSON.parse(d.toString()); } catch { return; }
      frames.push(m.type);
      if (m.type === "agent_message") { finalText = (m.text || "").slice(0, 120); clearTimeout(to); done("REPLY_OK"); }
    });
    ws.on("close", () => { if (!opened && status === null) { clearTimeout(to); done("REJECTED_CLOSE"); } });
    ws.on("error", () => { /* close/unexpected-response carries the verdict */ });
  });
}

const results = [];
results.push(await attempt({ name: "valid ticket + message", url: `${BASE}?ticket=${encodeURIComponent(mint(SECRET, "web-anon"))}`, sendMsg: "Reply with exactly: E2E-OK" }));
results.push(await attempt({ name: "no ticket", url: BASE, timeoutMs: 8000 }));
results.push(await attempt({ name: "wrong-secret ticket", url: `${BASE}?ticket=${encodeURIComponent(mint("WRONG-" + SECRET, "web-anon"))}`, timeoutMs: 8000 }));
console.log(JSON.stringify(results, null, 2));
process.exit(0);
