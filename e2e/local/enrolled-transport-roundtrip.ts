// Driver for the enrolled-NATS-transport E2E (#18 — agent-side).
//
// WHAT THE AGENT PROVED ALREADY (by the time this driver runs): the PLUGIN, with
// devOpen OFF, obtained tenant-scoped NATS user creds via the REAL device-flow
// enrollment-server (enroll → auto-approve → poll) through the PRODUCTION
// createEnrolledNatsConnection path, and connected (NKEY-authenticated) to a
// JWT-auth nats-server whose operator/account come from the SAME setupTrustChain
// the issuer uses. The gateway log line "[webchannel] ✓ NATS mode plugin
// registered" gates this driver.
//
// WHAT THIS DRIVER PROVES: a NKEY-authenticated peer can complete an encrypted
// MessageEnvelope round-trip with that enrolled agent. It:
//   1. mints a bootstrap JWT (RS256, this issuer's trust chain) and drives the
//      real HTTP register hop so the agent subscribes to this peer's subjects
//      (the wildcard is OFF on the enrolled/jwt path — registration is the only
//      admission path);
//   2. fetches a NATS user cred for itself and connects to the JWT-auth
//      nats-server using the production NatsTransport's NKEY challenge-response;
//   3. unwraps the register-delivered conversation key K (Phase 6 — the
//      register-hop path has NO X25519 handshake; K arrives wrapped to the
//      device cnf key in the register HTTP response) and runs the
//      ChaCha20-Poly1305 round-trip (same wire as the production browser
//      client), asserting the decrypted echo.
//
// Exit codes: 0 ok · 2 setup/HTTP failure · 3 timeout · 5 decrypt/mismatch.

import { fromSeed } from "@nats-io/nkeys";

import { NatsTransport } from "../../packages/plugin/src/nats-transport.js";
import type { NatsMessage } from "../../packages/plugin/src/nats-transport.js";
import {
  generateX25519KeyPair,
  unwrapConversationKey,
  sealMessage,
  openMessage,
} from "../../packages/client/src/e2e-crypto-browser.js";
import { generateDevicePopKeyPair, registerWithPop } from "../../packages/client/src/pop-register.js";

const NATS_WS = process.env.WEBCHANNEL_NATS_URL ?? "ws://127.0.0.1:18422";
const GW_URL = process.env.WEBCHANNEL_GW_URL ?? "http://127.0.0.1:18999";
const ISSUER = process.env.WEBCHANNEL_ISSUER_URL ?? "http://127.0.0.1:3921";
const TENANT = process.env.WEBCHANNEL_TENANT ?? "default-tenant";
const ACCOUNT_ID = process.env.WEBCHANNEL_ACCOUNT_ID ?? "default-agent";
const PEER_ID = process.env.WEBCHANNEL_PEER_ID ?? "enrolled-driver-peer";

const MESSAGE = "hello via enrolled transport";

const inboundSubj = `webchannel.${TENANT}.${ACCOUNT_ID}.${PEER_ID}.in`;
const outboundSubj = `webchannel.${TENANT}.${ACCOUNT_ID}.${PEER_ID}.out`;

function fail(code: number, msg: string): never {
  console.error(`[FAIL] ${msg}`);
  process.exit(code);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function postJson(url: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: any; text: string }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, json, text };
}

// 1. Device X25519 key → cnf.jwk in the bootstrap JWT; the register hop wraps
//    the conversation key K to this key (Phase 6 — no handshake).
const deviceKp = await generateX25519KeyPair();

// 1b. Device Ed25519 PoP key → pop_jwk. The gateway now requires PoP by default
//     (auth.requirePoP defaults true), so the bootstrap JWT MUST carry pop_jwk and
//     the register hop MUST present a signed-nonce proof. Mirrors how
//     jwt-register-roundtrip.ts / runAllReal drive the production PoP path.
const popKeyPair = await generateDevicePopKeyPair();

// 2. Mint a bootstrap JWT from THIS issuer's trust chain, INCLUDING pop_jwk.
const boot = await postJson(`${ISSUER}/test/bootstrap-jwt`, {
  tenant: TENANT,
  accountId: ACCOUNT_ID,
  peerId: PEER_ID,
  deviceX25519PublicKey: deviceKp.publicKeyB64url,
  devicePopPublicKey: popKeyPair.publicJwk.x,
});
if (boot.status !== 200 || !boot.json?.jwt) {
  fail(2, `bootstrap-jwt mint failed: HTTP ${boot.status} ${boot.text}`);
}
const bootstrapJwt: string = boot.json.jwt;
console.log(`[driver] minted bootstrap JWT (kid=${boot.json.kid}, pop_jwk) for peerId=${PEER_ID}`);

// 3. Drive the REAL HTTP register hop with PoP (challenge → sign nonce → register)
//    so the agent subscribes to this peer. Uses the same production producer-side
//    helper the browser client uses; a bad/missing proof would 401. Phase 6: the
//    response carries the conversation key K wrapped to our cnf X25519 key.
let registerResult: Awaited<ReturnType<typeof registerWithPop>>;
try {
  registerResult = await registerWithPop({
    registerBaseUrl: GW_URL,
    jwt: bootstrapJwt,
    peerId: PEER_ID,
    devicePrivateKey: popKeyPair.privateKey,
  });
} catch (err) {
  fail(2, `register hop (PoP) failed: ${(err as Error).message}`);
}
if (!registerResult.wrappedConversationKey) {
  fail(2, "register response carried no wrappedConversationKey (Phase 6 key delivery)");
}
const sessionKey = await unwrapConversationKey(
  registerResult.wrappedConversationKey,
  deviceKp.privateKey,
).catch((e: Error) => fail(5, `conversation-key unwrap failed: ${e.message}`));
console.log(`[driver] PoP register hop OK → agent subscribed to ${PEER_ID}, K unwrapped`);

// 4. Fetch this driver's NATS user creds (browser role) from the issuer.
const cred = await postJson(`${ISSUER}/test/nats-user`, { tenant: TENANT, role: "browser" });
if (cred.status !== 200 || !cred.json?.userJwt || !cred.json?.userSeed) {
  fail(2, `nats-user mint failed: HTTP ${cred.status} ${cred.text}`);
}
const userJwt: string = cred.json.userJwt;
const userSeed: string = cred.json.userSeed;
console.log("[driver] obtained NATS user creds (browser role)");

// 5. Connect to the JWT-auth nats-server via NKEY challenge-response.
const userKp = fromSeed(new TextEncoder().encode(userSeed));
const transport = new NatsTransport({
  url: NATS_WS,
  jwtCredential: userJwt,
  nkeySigningCallback: (nonce: string) =>
    Promise.resolve(Buffer.from(userKp.sign(new TextEncoder().encode(nonce))).toString("base64url")),
  clientName: "enrolled-driver",
});
transport.on("error", (e: Error) => console.error("[driver][nats-error]", e.message));
await transport.connect().catch((e) => fail(2, `NATS connect failed: ${(e as Error).message}`));
console.log("[driver] NKEY-authenticated to JWT-auth nats-server");

// 6. Encrypted round-trip sealed with the register-delivered K — NO handshake
//    frame is published (and the register-hop agent would not answer one).
const replyText = new Promise<string>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("TIMEOUT waiting for agent reply")), 30000);
  transport.on("message", (msg: NatsMessage) => {
    if (msg.subject !== outboundSubj) return;
    const payload = msg.payload.toString("utf8");
    const decoded = openMessage(payload, sessionKey) as { type?: string; text?: string } | null;
    if (!decoded) return;
    if (decoded.type === "agent_message" && typeof decoded.text === "string") {
      clearTimeout(timer);
      resolve(decoded.text);
    }
  });
});

transport.subscribe(outboundSubj);

// The agent's SUB for .in is sent during the register hop; give it a moment to
// flush server-side, then publish our sealed message.
await sleep(300);
transport.publish(
  inboundSubj,
  sealMessage({ accountId: ACCOUNT_ID, tenant: TENANT, sub: PEER_ID }, sessionKey, {
    type: "user_message",
    text: MESSAGE,
  }),
);
console.log(`[driver] sent "${MESSAGE}" sealed with the register-delivered K`);

const text = await replyText.catch((e: Error) => fail(3, e.message));

// The agent runs the message through the real openclaw inbound pipeline + echo
// model, which prepends conversation metadata to the prompt — so the echo is
// `echo: <metadata>…<our text>`. The round-trip is proven by our exact plaintext
// surviving the encrypted hop and coming back inside the echoed reply.
if (!text.startsWith("echo:") || !text.includes(MESSAGE)) {
  fail(5, `decrypted reply did not echo our plaintext: got ${JSON.stringify(text)}`);
}

console.log(`[REPLY] ${JSON.stringify(text)}`);
console.log(
  "[PROOF] plugin connected via REAL device-flow enrolled NATS creds to JWT-auth nats-server; encrypted round-trip OK",
);
transport.disconnect();
process.exit(0);
