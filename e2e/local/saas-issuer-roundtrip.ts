// Drives the PRODUCTION WebChannelNatsClient through the JWT + Proof-of-Possession
// register hop (NATS request/reply) — but unlike jwt-register-roundtrip.ts, the
// bootstrap JWT is NOT self-minted from a static fixture. It is minted +
// RS256-signed by the REAL reference bootstrap-server
// (packages/saas/reference/bootstrap-server.ts), which derives a real RSA keypair
// via setupTrustChain() and serves the matching public JWKS at
// /.well-known/jwks.json.
//
// WHAT THIS PROVES: the gateway boots with channels.webchannel.auth.strategy="jwt"
// and auth.jwt.jwksUrl pointing AT the bootstrap-server's live JWKS endpoint. So
// the plugin's verifyJwt resolves the signing key (by header kid) over HTTP from
// the real issuer and admits the token. With auth.strategy="jwt" the wildcard is
// gated OFF (see index-nats.ts / nats-admission.ts), so the agent subscribes to NO
// peer subjects until channel.registerPeer(peerId) runs — and the only thing that
// does so is a register request on the account's `…{peerId}.register` NATS subject,
// driven by the production client's `registration` (PoP) path. Therefore a
// successful encrypted round-trip means: real bootstrap-server RS256 issuance →
// real JWKS-over-HTTP verification → live NATS register hop → encrypted echo,
// end-to-end. Not a fixture.
import { webcrypto } from "node:crypto";
import { WebChannelNatsClient } from "../../packages/client/src/nats-client.js";

const NATS = process.env.WEBCHANNEL_NATS_URL ?? "ws://127.0.0.1:18322";
const BOOTSTRAP_URL = process.env.WEBCHANNEL_BOOTSTRAP_URL ?? "http://127.0.0.1:3911";

// "default" = the account key a flat (single-account) channels.webchannel
// config resolves to since the accounts refactor — the wire subject uses the
// account key, so this must match the gateway side (see run-jwt-register.sh,
// which uses the same flat-config + "default" pattern).
const ACCOUNT_ID = "default";
const TENANT = "default-tenant";
// Fixed peerId so the gateway's dmSecurity allowlist can name it. The real
// bootstrap-server accepts an optional peerId and threads it into the JWT `sub`.
const PEER_ID = process.env.WEBCHANNEL_PEER_ID ?? "web-saas-peer";

const b64url = (b: ArrayBuffer | Uint8Array) =>
  Buffer.from(b instanceof Uint8Array ? b : new Uint8Array(b)).toString("base64url");

// 1. Device X25519 key → devicePublicKey (b64url raw) → server stamps it as cnf.jwk.
const x25519 = (await webcrypto.subtle.generateKey({ name: "X25519" }, true, [
  "deriveBits",
])) as CryptoKeyPair;
const x25519Raw = await webcrypto.subtle.exportKey("raw", x25519.publicKey);
const devicePublicKey = b64url(x25519Raw);

// 2. Device Ed25519 PoP key → devicePopPublicKey (jwk.x) → server stamps it as
//    pop_jwk; the PRIVATE CryptoKey signs the register-nonce challenge.
const ed25519 = (await webcrypto.subtle.generateKey({ name: "Ed25519" }, false, [
  "sign",
  "verify",
])) as CryptoKeyPair;
const edPubJwk = (await webcrypto.subtle.exportKey("jwk", ed25519.publicKey)) as { x?: string };
if (!edPubJwk.x) throw new Error("Ed25519 public JWK missing 'x'");
const devicePopPublicKey = edPubJwk.x;

// 3. Ask the REAL bootstrap-server to mint + RS256-sign the JWT.
const bootstrapRes = await fetch(`${BOOTSTRAP_URL}/bootstrap`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ devicePublicKey, devicePopPublicKey, accountId: ACCOUNT_ID, tenant: TENANT, peerId: PEER_ID }),
});
if (!bootstrapRes.ok) {
  console.error("[FAIL] bootstrap-server returned", bootstrapRes.status, await bootstrapRes.text());
  process.exit(5);
}
const { jwt, peerId, agentPublicKey } = (await bootstrapRes.json()) as {
  jwt: string;
  peerId: string;
  agentPublicKey?: string;
};
if (!jwt || !peerId) {
  console.error("[FAIL] bootstrap-server response missing jwt/peerId");
  process.exit(5);
}
if (!agentPublicKey) {
  console.error("[FAIL] bootstrap-server response missing agentPublicKey (F2 register-hop pin)");
  process.exit(5);
}

// 4. Confirm the JWT's sub equals the returned peerId (sub=peerId is the contract).
const subFromJwt = JSON.parse(
  Buffer.from(jwt.split(".")[1], "base64url").toString("utf-8"),
).sub as string;
if (subFromJwt !== peerId) {
  console.error(`[FAIL] JWT sub (${subFromJwt}) != returned peerId (${peerId})`);
  process.exit(5);
}
console.log(`[bootstrap] real SaaS issuer minted JWT for peerId=${peerId} (sub matches)`);

// 5. Production client with the `registration` path enabled (PoP register over NATS).
const client = new WebChannelNatsClient({
  url: NATS,
  jwt,
  accountId: ACCOUNT_ID,
  tenant: TENANT,
  peerId,
  registration: {
    // The client derives the register subject from tenant/accountId/peerId and
    // drives challenge→register over NATS request/reply (no gateway URL).
    devicePrivateKey: ed25519.privateKey,
    // Phase 6: register-delivered conversation key (no handshake).
    deviceX25519PrivateKey: x25519.privateKey,
    // F2: pin the SaaS-delivered agent identity key to authenticate K.
    pinnedAgentPublicKey: agentPublicKey,
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
// No fixed sleep: the production client's send-buffering carries the message
// through NATS connect + the NATS PoP register hop + key delivery (see jwt-register-roundtrip.ts).
console.log("[send] 'hello via real saas issuer'");
client.sendUserMessage("hello via real saas issuer");

const result = await Promise.race([
  reply,
  new Promise<never>((_, rej) => setTimeout(() => rej(new Error("TIMEOUT waiting for agent reply")), 25000)),
]).catch((e) => { console.error("[FAIL]", e.message); process.exit(3); });

console.log("[REPLY]", JSON.stringify(result));
console.log("[PROOF] real-SaaS-issued JWT (RS256, real JWKS) admitted via live register hop");
client.disconnect();
process.exit(0);
