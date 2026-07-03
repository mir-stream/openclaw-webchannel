// Drives the PRODUCTION WebChannelNatsClient through the JWT + Proof-of-Possession
// HTTP register hop against the live local openclaw gateway (index-nats plugin) +
// nats-server + echo provider.
//
// WHAT THIS PROVES: the gateway is booted with channels.webchannel.auth.strategy
// = "jwt", which (see index-nats.ts wildcard gate) means the agent does NOT call
// subscribeWildcard() even under dev/open-NATS. So the agent is subscribed to NO
// peer subjects until something calls channel.registerPeer(peerId) — and the only
// thing that does so is the live HTTP POST /webchannel/nats/register route. The
// production client's `registration` path drives that route (challenge → sign the
// nonce with the device Ed25519 PoP key → register with Bearer JWT). Therefore a
// successful round-trip means registerPeer happened ONLY through the live HTTP
// register hop. If registration fails, onError fires and we exit non-zero loudly.
import { webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import { WebChannelNatsClient } from "../../packages/client/src/nats-client.js";
import { buildBootstrapClaims } from "../../packages/saas/src/bootstrap-claims.js";

const NATS = "ws://127.0.0.1:18222";
const GW_URL = process.env.WEBCHANNEL_GW_URL ?? "http://127.0.0.1:18799";
const PRIV_PATH = process.env.WEBCHANNEL_RS256_PRIVATE ?? "/tmp/oc-e2e/rs256-private.jwk.json";

const ISS = "https://e2e-issuer.test";
const PEER_ID = "web-jwt-peer";
const ACCOUNT_ID = "default";
const TENANT = "default-tenant";
const KID = "webchannel-e2e-rs256";

const b64url = (b: ArrayBuffer | Uint8Array) =>
  Buffer.from(b instanceof Uint8Array ? b : new Uint8Array(b)).toString("base64url");
const b64urlStr = (s: string) => Buffer.from(s).toString("base64url");

// 1. Import the RS256 private key (from gen-jwt-fixtures.mjs) as a signing key.
const privJwk = JSON.parse(readFileSync(PRIV_PATH, "utf8"));
const rsaKey = await webcrypto.subtle.importKey(
  "jwk",
  privJwk,
  { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
  false,
  ["sign"],
);

// 2. Device X25519 key → cnf.jwk (independent of the client's own handshake key;
//    handleHandshake does not pin against cnf, so only structural validity matters).
const x25519 = (await webcrypto.subtle.generateKey({ name: "X25519" }, true, [
  "deriveBits",
])) as CryptoKeyPair;
const x25519Raw = await webcrypto.subtle.exportKey("raw", x25519.publicKey);
const deviceX25519PublicKey = b64url(x25519Raw);

// 3. Device Ed25519 PoP key → pop_jwk + the private CryptoKey for registration.
const ed25519 = (await webcrypto.subtle.generateKey({ name: "Ed25519" }, false, [
  "sign",
  "verify",
])) as CryptoKeyPair;
const edPubJwk = (await webcrypto.subtle.exportKey("jwk", ed25519.publicKey)) as { x?: string };
if (!edPubJwk.x) throw new Error("Ed25519 public JWK missing 'x'");
const devicePopPublicKey = edPubJwk.x;

// 4. Build + RS256-sign the bootstrap JWT (header.kid MUST match the JWKS kid).
const claims = buildBootstrapClaims({
  iss: ISS,
  peerId: PEER_ID,
  accountId: ACCOUNT_ID,
  tenant: TENANT,
  deviceX25519PublicKey,
  devicePopPublicKey,
});
const header = { alg: "RS256", typ: "JWT", kid: KID };
const signingInput = `${b64urlStr(JSON.stringify(header))}.${b64urlStr(JSON.stringify(claims))}`;
const sig = await webcrypto.subtle.sign(
  { name: "RSASSA-PKCS1-v1_5" },
  rsaKey,
  new TextEncoder().encode(signingInput),
);
const jwt = `${signingInput}.${b64url(sig)}`;

// 5. Production client with the `registration` path enabled (PoP HTTP register).
const client = new WebChannelNatsClient({
  url: NATS,
  jwt,
  accountId: ACCOUNT_ID,
  tenant: TENANT,
  peerId: PEER_ID,
  registration: {
    registerBaseUrl: GW_URL,
    devicePrivateKey: ed25519.privateKey,
    // Phase 6: register-delivered conversation key (no handshake).
    deviceX25519PrivateKey: x25519.privateKey,
  },
});

client.onError((e) => {
  console.error("[register-FAIL]", e.message);
  process.exit(4);
});

const reply = new Promise<{ type: string; text?: string }>((resolve) => {
  client.onMessage((m) => { if (m.type === "agent_message") resolve(m); });
});

client.connect();
// No sleep before sending: timing-robustness comes from the production client's
// send-buffering, not a magic delay. WebChannelNatsClient.sendUserMessage →
// enqueue() pushes onto outboundQueue while sessionKey === null (pre-handshake),
// and flushQueue() seals + publishes the whole queue the moment the X25519
// handshake derives the session key (handleRaw → flushQueue). So sending
// immediately after connect() is safe — the message rides the buffer through
// NATS connect + HTTP PoP register + handshake and is never lost on a slow runner.
// (A registration failure still fires onError → exit(4) below; the reply still
// times out → exit(3). This only removes the fragile fixed sleep.)
console.log("[send] 'hello via jwt register'");
client.sendUserMessage("hello via jwt register");

const result = await Promise.race([
  reply,
  new Promise<never>((_, rej) => setTimeout(() => rej(new Error("TIMEOUT waiting for agent reply")), 25000)),
]).catch((e) => { console.error("[FAIL]", e.message); process.exit(3); });

console.log("[REPLY]", JSON.stringify(result));
console.log("[PROOF] agent registered peer via HTTP hop (wildcard OFF)");
client.disconnect();
process.exit(0);
