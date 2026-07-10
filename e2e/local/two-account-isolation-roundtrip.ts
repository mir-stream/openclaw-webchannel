// 가-1 Cycle 3 — 2-account routing-isolation driver (AC6, the completion gate).
//
// Parameterized by env so ONE driver covers BOTH accounts. It drives the
// PRODUCTION WebChannelNatsClient through the JWT + PoP register hop into a
// SINGLE multiplex gateway serving TWO accounts (acctA→agentA, acctB→agentB),
// and asserts ROUTING ISOLATION:
//
//   - the reply MUST carry the echo prefix of the agent bound to THIS account
//     (EXPECT_PREFIX), proving the inbound reached the right agent, AND
//   - it MUST NOT carry the OTHER agent's prefix (FORBID_PREFIX), proving the
//     inbound did NOT leak to the other account's agent.
//
// This exercises the REAL stack end-to-end: registerFull multiplex (two NatsChannels),
// the single register route's JWT-aud→account dispatch (aud=accta routes to
// acctA's channel — the aud IS the accountId), and binding.account routing
// (resolveAgentRoute(accountId) → the agent bound via webchannel:<account>). No unit mocks.
import { webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import { WebChannelNatsClient } from "../../packages/client/src/nats-client.js";
import { buildBootstrapClaims } from "../../packages/saas/src/bootstrap-claims.js";
// F2: dev-open register-hop agent wraps K under the well-known dev identity key.
// CAVEAT: both accounts here pin the SAME dev key (the dev fallback is process-wide),
// so this e2e does NOT exercise the per-account identity-key property — that a wrap
// from account A cannot be authenticated as account B. That property is covered by
// the plugin unit negative controls (nats-channel-keystore.test.ts: relay/non-pinned
// key rejected) and the client conformance tests; here we only assert subject-scope
// isolation on the same pinned key.
import { devOpenAgentIdentityPublicB64url } from "../../packages/plugin/src/dev-identity.js";

const NATS = process.env.WEBCHANNEL_NATS_URL ?? "ws://127.0.0.1:18222";
const PRIV_PATH = process.env.WEBCHANNEL_RS256_PRIVATE ?? "/tmp/oc-two-acct-e2e/rs256-private.jwk.json";

const ISS = process.env.WEBCHANNEL_ISSUER ?? "https://e2e-issuer.test";
const PEER_ID = process.env.WEBCHANNEL_PEER_ID ?? "web-acctA-peer";
const ACCOUNT_ID = process.env.WEBCHANNEL_ACCOUNT_ID ?? "accta";
const TENANT = process.env.WEBCHANNEL_TENANT ?? "default-tenant";
const KID = "webchannel-e2e-rs256";

const EXPECT_PREFIX = process.env.EXPECT_PREFIX ?? "";
const FORBID_PREFIX = process.env.FORBID_PREFIX ?? "";
const MESSAGE = process.env.SEND_MESSAGE ?? `hello ${ACCOUNT_ID}`;

if (!EXPECT_PREFIX || !FORBID_PREFIX) {
  console.error("[FAIL] EXPECT_PREFIX and FORBID_PREFIX env are required");
  process.exit(5);
}

const b64url = (b: ArrayBuffer | Uint8Array) =>
  Buffer.from(b instanceof Uint8Array ? b : new Uint8Array(b)).toString("base64url");
const b64urlStr = (s: string) => Buffer.from(s).toString("base64url");

// 1. RS256 private key (shared issuer key; only `aud` distinguishes accounts).
const privJwk = JSON.parse(readFileSync(PRIV_PATH, "utf8"));
const rsaKey = await webcrypto.subtle.importKey(
  "jwk",
  privJwk,
  { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
  false,
  ["sign"],
);

// 2. Device X25519 key → cnf.jwk.
const x25519 = (await webcrypto.subtle.generateKey({ name: "X25519" }, true, [
  "deriveBits",
])) as CryptoKeyPair;
const deviceX25519PublicKey = b64url(await webcrypto.subtle.exportKey("raw", x25519.publicKey));

// 3. Device Ed25519 PoP key → pop_jwk + private signer.
const ed25519 = (await webcrypto.subtle.generateKey({ name: "Ed25519" }, false, [
  "sign",
  "verify",
])) as CryptoKeyPair;
const edPubJwk = (await webcrypto.subtle.exportKey("jwk", ed25519.publicKey)) as { x?: string };
if (!edPubJwk.x) throw new Error("Ed25519 public JWK missing 'x'");

// 4. Bootstrap JWT with aud=ACCOUNT_ID (this account's accountId → register dispatch).
const claims = buildBootstrapClaims({
  iss: ISS,
  peerId: PEER_ID,
  accountId: ACCOUNT_ID,
  tenant: TENANT,
  deviceX25519PublicKey,
  devicePopPublicKey: edPubJwk.x,
});
const header = { alg: "RS256", typ: "JWT", kid: KID };
const signingInput = `${b64urlStr(JSON.stringify(header))}.${b64urlStr(JSON.stringify(claims))}`;
const sig = await webcrypto.subtle.sign(
  { name: "RSASSA-PKCS1-v1_5" },
  rsaKey,
  new TextEncoder().encode(signingInput),
);
const jwt = `${signingInput}.${b64url(sig)}`;

// 5. Production client through the PoP register path.
const client = new WebChannelNatsClient({
  url: NATS,
  jwt,
  accountId: ACCOUNT_ID,
  tenant: TENANT,
  peerId: PEER_ID,
  registration: {
    // The client derives the register subject from tenant/accountId/peerId and
    // drives challenge→register over NATS request/reply (no gateway URL).
    devicePrivateKey: ed25519.privateKey,
    // Phase 6: register-delivered conversation key (no handshake).
    deviceX25519PrivateKey: x25519.privateKey,
    // F2: authenticate the delivered K against the dev-open agent's identity key.
    pinnedAgentPublicKey: devOpenAgentIdentityPublicB64url(),
  },
});

client.onError((e) => {
  console.error(`[register-FAIL:${ACCOUNT_ID}]`, e.message);
  process.exit(4);
});

const reply = new Promise<{ type: string; text?: string }>((resolve) => {
  client.onMessage((m) => { if (m.type === "agent_message") resolve(m); });
});

client.connect();
console.log(`[send:${ACCOUNT_ID}] ${JSON.stringify(MESSAGE)} (peer=${PEER_ID})`);
client.sendUserMessage(MESSAGE);

const result = (await Promise.race([
  reply,
  new Promise<never>((_, rej) =>
    setTimeout(() => rej(new Error("TIMEOUT waiting for agent reply")), 25000),
  ),
]).catch((e) => {
  console.error(`[FAIL:${ACCOUNT_ID}]`, e.message);
  process.exit(3);
})) as { type: string; text?: string };

const text = result.text ?? "";
console.log(`[REPLY:${ACCOUNT_ID}] ${JSON.stringify(text)}`);

// ── Isolation assertions ──────────────────────────────────────────────────
if (!text.includes(EXPECT_PREFIX)) {
  console.error(
    `[ISOLATION-FAIL] account "${ACCOUNT_ID}" reply did NOT carry the expected ` +
      `agent prefix ${JSON.stringify(EXPECT_PREFIX)} — routing reached the wrong agent.`,
  );
  client.disconnect();
  process.exit(6);
}
if (text.includes(FORBID_PREFIX)) {
  console.error(
    `[ISOLATION-FAIL] account "${ACCOUNT_ID}" reply LEAKED the other agent's prefix ` +
      `${JSON.stringify(FORBID_PREFIX)} — inbound crossed account boundaries.`,
  );
  client.disconnect();
  process.exit(7);
}

console.log(
  `[PROOF:${ACCOUNT_ID}] inbound routed to the bound agent (prefix ${JSON.stringify(EXPECT_PREFIX)}) ` +
    `and did NOT reach the other account's agent — multiplex + JWT-aud dispatch + binding.account isolation OK`,
);
client.disconnect();
process.exit(0);
