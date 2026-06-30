// Drives the PRODUCTION WebChannelNatsClient against the live local openclaw
// gateway (index-nats plugin) + nats-server + echo provider. Proves:
// handshake → sealed user_message → real inbound.run → echo → decrypt.
// (dev/open-NATS uses wildcard auto-register; no HTTP /register hop.)
import crypto from "node:crypto";
import { WebChannelNatsClient } from "../../packages/client/src/nats-client.js";

const SECRET = process.env.WEBCHANNEL_TICKET_SECRET ?? "e2e-ticket-secret";
const NATS = "ws://127.0.0.1:18222";
const b64 = (s: string) => Buffer.from(s).toString("base64url");
function mint(sub: string): string {
  const h = b64(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const iat = Math.floor(Date.now() / 1000);
  const p = b64(JSON.stringify({ sub, iat, exp: iat + 300 }));
  const si = `${h}.${p}`;
  return `${si}.${crypto.createHmac("sha256", SECRET).update(si).digest("base64url")}`;
}
const jwt = mint("web-anon");

const client = new WebChannelNatsClient({
  url: NATS, jwt, agentId: "default-agent", tenant: "default-tenant", peerId: "web-anon",
});
const reply = new Promise<{ type: string; text?: string }>((resolve) => {
  client.onMessage((m) => { if (m.type === "agent_message") resolve(m); });
});
client.connect();
await new Promise((r) => setTimeout(r, 2500)); // NATS connect + X25519 handshake
console.log("[send] 'hello from web'");
client.sendUserMessage("hello from web");

const result = await Promise.race([
  reply,
  new Promise<never>((_, rej) => setTimeout(() => rej(new Error("TIMEOUT waiting for agent reply")), 25000)),
]).catch((e) => { console.error("[FAIL]", e.message); process.exit(3); });

console.log("[REPLY]", JSON.stringify(result));
client.disconnect();
process.exit(0);
