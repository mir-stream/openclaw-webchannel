// Smoke for the BUILT headless client (dist/) against a live gateway with
// channels.webchannel.auth = hmac-ticket. Proves the framework-agnostic
// WebChannelClient connects (via getTicket), round-trips a user_message, and
// surfaces the agent reply in its subscribed state — all with no DOM, no React.
// Run with WEBCHANNEL_TICKET_SECRET set (source ~/.openclaw/.env).
import crypto from "node:crypto";
import { WebChannelClient } from "./dist/index.js";

const SECRET = process.env.WEBCHANNEL_TICKET_SECRET;
if (!SECRET) {
  console.error("WEBCHANNEL_TICKET_SECRET not set");
  process.exit(3);
}

const b64 = (s) => Buffer.from(s).toString("base64url");
function mint(sub, ttl = 60) {
  const header = b64(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const iat = Math.floor(Date.now() / 1000);
  const payload = b64(JSON.stringify({ sub, iat, exp: iat + ttl }));
  const si = `${header}.${payload}`;
  const sig = crypto.createHmac("sha256", SECRET).update(si).digest("base64url");
  return `${si}.${sig}`;
}

const client = new WebChannelClient({
  url: "ws://127.0.0.1:18789/webchannel/ws",
  getTicket: async () => mint("web-anon"),
});

const TIMEOUT_MS = 90_000;
const result = await new Promise((resolve) => {
  let sent = false;
  const to = setTimeout(() => resolve({ verdict: "TIMEOUT", state: client.getState() }), TIMEOUT_MS);
  client.subscribe((state) => {
    if (state.connected && !sent) {
      sent = true;
      client.send("Reply with exactly: E2E-OK");
    }
    const finalized = state.messages.find((m) => m.role === "agent" && !m.working && m.text);
    if (finalized) {
      clearTimeout(to);
      resolve({ verdict: "REPLY_OK", reply: finalized.text.slice(0, 120), state });
    }
  });
  client.connect();
});

client.close();
console.log(JSON.stringify({
  verdict: result.verdict,
  reply: result.reply,
  status: result.state.status,
  messages: result.state.messages.map((m) => ({ role: m.role, working: !!m.working, text: m.text.slice(0, 60) })),
}, null, 2));
process.exit(result.verdict === "REPLY_OK" ? 0 : 1);
