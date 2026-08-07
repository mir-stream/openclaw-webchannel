// Driver for the #87 turn-outcome E2E — does a turn that FAILED at the provider
// settle as failed on the wire?
//
// WHAT THIS GUARDS: `turn_settled{outcome}` is the signal the browser client
// promotes a user message's `sendState` from. `outcome:"ok"` becomes
// `completed` (a ✓) and `outcome:"error"` becomes `failed{reason:"turn-failed",
// retryable:true}` — which is also what gates the retry affordance. Issue #87:
// a turn rejected by the PROVIDER settled `ok`, so the widget showed a ✓ and
// offered no retry for a turn that produced no answer.
//
// WHY A LIVE HARNESS: the bug lives in a core behavior no unit test can assert
// — core does NOT throw on a provider rejection. It absorbs the failure and
// returns its terminal message as an ordinary reply payload flagged `isError`,
// so the plugin's turn resolves cleanly and its `catch` never runs. Proving the
// fix needs a real gateway running a real agent turn against a provider that
// really rejects. The unit tests in packages/plugin/src/inbound.test.ts pin the
// plugin-side logic; this pins the core behavior the logic depends on.
//
// Runs both directions in ONE gateway boot: a rejected turn (must settle
// `error`) and an ordinary turn (must still settle `ok`, so an unconditional
// "always error" fix cannot pass).
//
// Exit codes: 0 ok · 2 setup/HTTP failure · 3 timeout · 5 decrypt/mismatch ·
// 6 turn-outcome assertion failed.

import { randomBytes, webcrypto } from "node:crypto";

import { fromSeed } from "@nats-io/nkeys";

import { NatsTransport } from "../../packages/plugin/src/nats-transport.js";
import type { NatsMessage } from "../../packages/plugin/src/nats-transport.js";
import {
  unwrapConversationKey,
  sealMessage,
  openMessage,
} from "../../packages/client/src/e2e-crypto-browser.js";
import { generateDevicePopKeyPair, registerWithPop } from "../../packages/client/src/pop-register.js";

const NATS_WS = process.env.WEBCHANNEL_NATS_URL ?? "ws://127.0.0.1:18422";
const ISSUER = process.env.WEBCHANNEL_ISSUER_URL ?? "http://127.0.0.1:3921";
const TENANT = process.env.WEBCHANNEL_TENANT ?? "default-tenant";
const ACCOUNT_ID = process.env.WEBCHANNEL_ACCOUNT_ID ?? "default-agent";
const PEER_ID = process.env.WEBCHANNEL_PEER_ID ?? "enrolled-driver-peer";

// Must match ECHO_FAIL_MARKER passed to echo-openai-server.mjs by the runner.
const FAIL_MARKER = process.env.ECHO_FAIL_MARKER ?? "ISSUE87_ALWAYS_ERROR";
const FAIL_MESSAGE = `please fail this turn ${FAIL_MARKER}`;
const OK_MESSAGE = "hello via enrolled transport";

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
//    the conversation key K to this key (Phase 6 — no handshake). Generated with
//    WebCrypto directly (the production browser client's key model), matching the
//    other enrolled drivers now that the legacy handshake keygen helper is gone.
const deviceX25519 = (await webcrypto.subtle.generateKey({ name: "X25519" }, true, [
  "deriveBits",
])) as CryptoKeyPair;
const deviceKp = {
  privateKey: deviceX25519.privateKey,
  publicKeyB64url: Buffer.from(
    await webcrypto.subtle.exportKey("raw", deviceX25519.publicKey),
  ).toString("base64url"),
};

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
// F2: the SaaS delivers the enrolled agent's attested identity public key (from
// the durable registry, populated at approval) so we can authenticate the
// register-delivered K against it — never against the wire.
const agentPublicKey: string | undefined = boot.json.agentPublicKey;
if (!agentPublicKey) {
  fail(2, "bootstrap-jwt response carried no agentPublicKey (F2 register-hop pin)");
}
console.log(`[driver] minted bootstrap JWT (kid=${boot.json.kid}, pop_jwk) for peerId=${PEER_ID}`);

// 3. Fetch this driver's NATS user creds (browser role) and connect to the
//    JWT-auth nats-server via NKEY challenge-response FIRST — the register hop
//    now rides NATS request/reply, so the transport must be up to drive it.
const cred = await postJson(`${ISSUER}/test/nats-user`, { tenant: TENANT, role: "browser", peerId: PEER_ID });
if (cred.status !== 200 || !cred.json?.userJwt || !cred.json?.userSeed) {
  fail(2, `nats-user mint failed: HTTP ${cred.status} ${cred.text}`);
}
const userJwt: string = cred.json.userJwt;
const userSeed: string = cred.json.userSeed;
console.log("[driver] obtained NATS user creds (browser role)");

const userKp = fromSeed(new TextEncoder().encode(userSeed));
const transport = new NatsTransport({
  url: NATS_WS,
  jwtCredential: userJwt,
  nkeySigningCallback: (nonce: string) =>
    Promise.resolve(Buffer.from(userKp.sign(new TextEncoder().encode(nonce))).toString("base64url")),
  clientName: "turn-outcome-driver",
});
transport.on("error", (e: Error) => console.error("[driver][nats-error]", e.message));
await transport.connect().catch((e) => fail(2, `NATS connect failed: ${(e as Error).message}`));
console.log("[driver] NKEY-authenticated to JWT-auth nats-server");

// 4. Drive the REAL register hop with PoP over NATS request/reply (challenge →
//    sign nonce → register) so the agent subscribes to this peer. Uses the same
//    production producer-side helper the browser client uses; a bad/missing proof
//    replies a generic `unauthorized`. Phase 6: the reply carries the conversation
//    key K wrapped to our cnf X25519 key. The reply-to inbox is in-namespace
//    (covered by the per-peer creds `webchannel.{tenant}.*.{peerId}.>` — no `_INBOX` grant).
const registerSubj = `webchannel.${TENANT}.${ACCOUNT_ID}.${PEER_ID}.register`;
const replyPrefix = `webchannel.${TENANT}.${ACCOUNT_ID}.${PEER_ID}.reginbox`;
const natsRegisterRequest = (body: unknown): Promise<unknown> =>
  new Promise((resolve, reject) => {
    const replySubject = `${replyPrefix}.${randomBytes(12).toString("hex")}`;
    const sid = transport.subscribe(replySubject);
    const onMsg = (msg: NatsMessage): void => {
      if (msg.subject !== replySubject) return;
      clearTimeout(timer);
      transport.off("message", onMsg);
      transport.unsubscribe(sid);
      resolve(JSON.parse(msg.payload.toString("utf8")));
    };
    const timer = setTimeout(() => {
      transport.off("message", onMsg);
      transport.unsubscribe(sid);
      reject(new Error("[driver] register request timeout"));
    }, 5000);
    transport.on("message", onMsg);
    transport.publishWithReply(registerSubj, replySubject, JSON.stringify(body));
  });

let registerResult: Awaited<ReturnType<typeof registerWithPop>>;
try {
  registerResult = await registerWithPop({
    request: natsRegisterRequest,
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
// v3: the wrap AAD is bound to the freshness anchor THIS driver generated for the
// successful register attempt — `registerWithPop` carries it out on its result.
// Never source it from the register reply (the agent does not echo it, and an
// echoed anchor would be relay-chosen).
const sessionKey = await unwrapConversationKey(
  registerResult.wrappedConversationKey,
  deviceKp.privateKey,
  agentPublicKey!,
  PEER_ID,
  registerResult.clientNonce,
).catch((e: Error) => fail(5, `conversation-key unwrap failed: ${e.message}`));
console.log(`[driver] PoP register hop (NATS) OK → agent subscribed to ${PEER_ID}, K unwrapped`);

// ---------------------------------------------------------------------------
// 5. #87 — the turn-outcome assertions.
//
// Two sequential turns over the SAME registered peer and conversation key:
//
//   (a) a turn whose text carries FAIL_MARKER, which makes the echo provider
//       answer HTTP 500. Core does NOT throw on a provider rejection — it
//       absorbs the failure and hands the plugin its terminal message as an
//       ordinary reply payload flagged `isError`. The turn therefore resolves
//       cleanly, and before the #87 fix it settled `ok`, which the client
//       promotes to `sendState:"completed"` (a ✓ on a turn that never answered,
//       with no retry affordance). It must settle `error`.
//
//   (b) an ordinary turn, which must still settle `ok`. Without this control a
//       naive fix that settles `error` unconditionally would pass (a).
//
// Both assert on the `turn_settled` frame itself, which is the contract the
// browser client keys its send-state promotion off.
// ---------------------------------------------------------------------------
type Frame = { type?: string; text?: string; turnId?: string; outcome?: string };

const frames: Frame[] = [];
transport.on("message", (msg: NatsMessage) => {
  if (msg.subject !== outboundSubj) return;
  const decoded = openMessage(msg.payload.toString("utf8"), sessionKey) as Frame | null;
  if (decoded) frames.push(decoded);
});
transport.subscribe(outboundSubj);

// The agent's SUB for .in is sent during the register hop; give it a moment to
// flush server-side before the first publish.
await sleep(300);

/** Sends one message and resolves the `outcome` of its `turn_settled` frame. */
async function runTurn(label: string, text: string): Promise<{ outcome: string; answer?: string }> {
  const before = frames.length;
  transport.publish(
    inboundSubj,
    sealMessage({ accountId: ACCOUNT_ID, tenant: TENANT, sub: PEER_ID }, sessionKey, {
      type: "user_message",
      text,
    }),
  );
  console.log(`[driver] ${label}: sent ${JSON.stringify(text)}`);

  const deadline = Date.now() + 60_000;
  for (;;) {
    const settled = frames.slice(before).find((f) => f.type === "turn_settled");
    if (settled) {
      const answer = frames.slice(before).find((f) => f.type === "agent_message")?.text;
      return { outcome: String(settled.outcome ?? ""), answer };
    }
    if (Date.now() > deadline) {
      fail(3, `${label}: TIMEOUT waiting for turn_settled (frames: ${JSON.stringify(frames.slice(before))})`);
    }
    await sleep(100);
  }
}

// (a) provider-rejected turn → must settle `error`.
const rejected = await runTurn("rejected-turn", FAIL_MESSAGE);
console.log(`[driver] rejected-turn settled outcome=${JSON.stringify(rejected.outcome)}`);
if (rejected.outcome !== "error") {
  fail(
    6,
    `#87 REGRESSION: a provider-rejected turn settled ${JSON.stringify(rejected.outcome)}, expected "error". ` +
      `The widget renders this as a completed send with no retry affordance.`,
  );
}
// The rejection must still be VISIBLE to the user — core's terminal message is
// what tells them what happened, and #87 must not silence it.
if (!rejected.answer) {
  fail(6, "#87: the rejected turn delivered no agent_message at all (the user would see nothing)");
}

// (b) ordinary turn → must still settle `ok` (no false-failure regression).
const ok = await runTurn("ordinary-turn", OK_MESSAGE);
console.log(`[driver] ordinary-turn settled outcome=${JSON.stringify(ok.outcome)}`);
if (ok.outcome !== "ok") {
  fail(6, `an ordinary answered turn settled ${JSON.stringify(ok.outcome)}, expected "ok"`);
}
if (!ok.answer?.includes(OK_MESSAGE)) {
  fail(5, `ordinary turn did not echo our plaintext: got ${JSON.stringify(ok.answer)}`);
}

console.log("[PROOF] #87: provider-rejected turn settles error; ordinary turn still settles ok");
transport.disconnect();
process.exit(0);
