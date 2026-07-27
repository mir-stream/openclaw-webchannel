// 가-1 Cycle 3 — 2-account routing-isolation driver (AC6, the completion gate).
//
// Parameterized by env so one driver covers positive round-trips and the
// cross-account live-subject rejection. It drives the
// PRODUCTION WebChannelNatsClient through the JWT + PoP register hop into TWO
// account-bound runtimes in one gateway process (acctA→agentA, acctB→agentB),
// and asserts ROUTING ISOLATION:
//
//   - the reply MUST carry the echo prefix of the agent bound to THIS account
//     (EXPECT_PREFIX), proving the inbound reached the right agent, AND
//   - it MUST NOT carry the OTHER agent's prefix (FORBID_PREFIX), proving the
//     inbound did NOT leak to the other account's agent.
//
// This exercises the REAL stack end-to-end: the host starts both configured
// accounts through the coordinator, each builds one account-bound NatsChannel,
// its verifier checks that account's aud membership, and binding.account routing
// (resolveAgentRoute(accountId) → the agent bound via webchannel:<account>). No unit mocks.
import { webcrypto } from "node:crypto";
import {
  NatsClient,
  WebChannelNatsClient,
} from "../../packages/client/src/nats-client.js";
import { signPop, generateClientNonce } from "../../packages/client/src/pop-register.js";
import { WEBCHANNEL_PROTOCOL_VERSION } from "../../packages/client/src/protocol.js";

const NATS = process.env.WEBCHANNEL_NATS_URL ?? "ws://127.0.0.1:18222";
const ISSUER = process.env.WEBCHANNEL_ISSUER_URL ?? "http://127.0.0.1:3971";
const PEER_ID = process.env.WEBCHANNEL_PEER_ID ?? "web-acctA-peer";
const ACCOUNT_ID = process.env.WEBCHANNEL_ACCOUNT_ID ?? "accta";
const TOKEN_ACCOUNT_ID = process.env.WEBCHANNEL_TOKEN_ACCOUNT_ID ?? ACCOUNT_ID;
const TENANT = process.env.WEBCHANNEL_TENANT ?? "default-tenant";
const MODE = process.env.WEBCHANNEL_TEST_MODE ?? "roundtrip";

const EXPECT_PREFIX = process.env.EXPECT_PREFIX ?? "";
const FORBID_PREFIX = process.env.FORBID_PREFIX ?? "";
const MESSAGE = process.env.SEND_MESSAGE ?? `hello ${ACCOUNT_ID}`;
const EXPECT_HISTORY_TEXT = process.env.EXPECT_HISTORY_TEXT ?? "";

if (MODE === "roundtrip" && (!EXPECT_PREFIX || !FORBID_PREFIX)) {
  console.error("[FAIL] EXPECT_PREFIX and FORBID_PREFIX env are required");
  process.exit(5);
}

const b64url = (b: ArrayBuffer | Uint8Array) =>
  Buffer.from(b instanceof Uint8Array ? b : new Uint8Array(b)).toString("base64url");

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

const post = async <T>(path: string, body: unknown): Promise<T> => {
  const response = await fetch(`${ISSUER}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${path} failed: ${response.status} ${await response.text()}`);
  return response.json() as Promise<T>;
};

// The same enrolled trust chain mints browser NATS credentials and the signed
// bootstrap token, including the per-account attested agent identity pin.
const natsCredentials = await post<{ userJwt: string; userSeedRaw: string }>("/test/nats-user", {
  tenant: TENANT,
  role: "browser",
  peerId: PEER_ID,
});
const bootstrap = await post<{ jwt: string; agentPublicKey: string }>("/test/bootstrap-jwt", {
  tenant: TENANT,
  accountId: TOKEN_ACCOUNT_ID,
  peerId: PEER_ID,
  deviceX25519PublicKey,
  devicePopPublicKey: edPubJwk.x,
});

if (MODE === "foreign-register") {
  if (TOKEN_ACCOUNT_ID === ACCOUNT_ID) {
    throw new Error("foreign-register requires distinct token and target account ids");
  }
  if (!EXPECT_HISTORY_TEXT) {
    throw new Error("foreign-register requires EXPECT_HISTORY_TEXT from a seeded prior turn");
  }

  // Mint a SECOND token for the target account using the exact same peer,
  // X25519 cnf key, and Ed25519 PoP key as the foreign token above. First use
  // it through the production client as a positive control: the already-seeded
  // peer must receive real history + approval snapshots from B's live handler.
  const targetBootstrap = await post<{ jwt: string; agentPublicKey: string }>(
    "/test/bootstrap-jwt",
    {
      tenant: TENANT,
      accountId: ACCOUNT_ID,
      peerId: PEER_ID,
      deviceX25519PublicKey,
      devicePopPublicKey: edPubJwk.x,
    },
  );
  let historyFrames = 0;
  let approvalFrames = 0;
  let matchingHistory = false;
  let positiveSettled = false;
  const positiveClient = new WebChannelNatsClient({
    url: NATS,
    jwt: targetBootstrap.jwt,
    accountId: ACCOUNT_ID,
    tenant: TENANT,
    peerId: PEER_ID,
    registration: {
      devicePrivateKey: ed25519.privateKey,
      deviceX25519PrivateKey: x25519.privateKey,
      pinnedAgentPublicKey: targetBootstrap.agentPublicKey,
    },
    natsCredentials,
  });
  const positiveSnapshots = new Promise<void>((resolve, reject) => {
    positiveClient.onError(reject);
    positiveClient.onMessage((message) => {
      if (message.type === "history") {
        historyFrames += 1;
        matchingHistory ||= (message.messages ?? []).some(
          (entry) => entry.text === EXPECT_HISTORY_TEXT,
        );
      }
      if (message.type === "approval_snapshot") {
        approvalFrames += 1;
        if (!Array.isArray(message.approvals)) {
          reject(new Error("positive approval_snapshot did not carry an approvals array"));
          return;
        }
      }
      if (!positiveSettled && historyFrames > 0 && approvalFrames > 0 && matchingHistory) {
        positiveSettled = true;
        resolve();
      }
    });
  });
  positiveClient.connect();
  await Promise.race([
    positiveSnapshots,
    new Promise<never>((_, reject) => setTimeout(
      () => reject(new Error(
        `positive B register did not deliver seeded history + approval snapshot ` +
          `(history=${historyFrames}, approval=${approvalFrames}, matched=${matchingHistory})`,
      )),
      15_000,
    )),
  ]);
  positiveClient.disconnect();
  console.log(
    `[PROOF:positive-snapshots] target=${ACCOUNT_ID} history=${historyFrames} ` +
      `approval=${approvalFrames} contained=${JSON.stringify(EXPECT_HISTORY_TEXT)}`,
  );

  const raw = new NatsClient({
    url: NATS,
    jwt: bootstrap.jwt,
    accountId: ACCOUNT_ID,
    tenant: TENANT,
    peerId: PEER_ID,
    natsCredentials,
    heartbeatIntervalMs: 0,
  });
  const connected = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("TIMEOUT connecting foreign-request driver")), 10_000);
    raw.onState((isConnected) => {
      if (!isConnected) return;
      clearTimeout(timer);
      resolve();
    });
    raw.onError((error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  raw.connect();
  await connected;

  const targetSubject = `webchannel.${TENANT}.${ACCOUNT_ID}.${PEER_ID}.register`;
  const replyPrefix = `webchannel.${TENANT}.${ACCOUNT_ID}.${PEER_ID}.reginbox`;
  const outSubject = `webchannel.${TENANT}.${ACCOUNT_ID}.${PEER_ID}.out`;
  let targetOutMessages = 0;
  raw.subscribe(outSubject);
  raw.onRawMessage((subject) => {
    if (subject === outSubject) targetOutMessages += 1;
  });
  const request = async (payload: unknown) => JSON.parse(await raw.request(
    targetSubject,
    JSON.stringify(payload),
    { timeoutMs: 5000, replyPrefix },
  )) as Record<string, unknown>;
  const expectOpaque401 = (reply: Record<string, unknown>, op: string) => {
    if (reply.error !== "unauthorized" || reply.code !== 401 || Object.keys(reply).length !== 2) {
      throw new Error(`${op} expected exact opaque 401, got ${JSON.stringify(reply)}`);
    }
  };

  // Keep the challenge negative as a direct account-bound audience assertion.
  const challengeReply = await request({ op: "challenge", token: bootstrap.jwt });
  expectOpaque401(challengeReply, "foreign challenge");

  // Audience is the UNIQUE failing condition for register. B issues this real,
  // live nonce after accepting targetBootstrap (aud=B). The A and B tokens bind
  // the same issuer/tenant/sub/cnf/pop_jwk, and we sign the nonce with that exact
  // PoP private key. Replacing only token B with token A must therefore fail at
  // B's account-bound aud check, before PoP consumption or serving side effects.
  const liveChallenge = await request({ op: "challenge", token: targetBootstrap.jwt });
  if (typeof liveChallenge.nonce !== "string" || liveChallenge.nonce.length === 0) {
    throw new Error(`target challenge did not return a nonce: ${JSON.stringify(liveChallenge)}`);
  }
  // v3: the proof is bound to the OP it authorizes, so a `register` proof cannot
  // be relabelled as a teardown (packages/plugin/src/pop-signed-message.ts).
  const signature = await signPop(ed25519.privateKey, "register", PEER_ID, liveChallenge.nonce);
  const registerReply = await request({
    op: "register",
    token: bootstrap.jwt,
    nonce: liveChallenge.nonce,
    signature,
    protocolVersion: WEBCHANNEL_PROTOCOL_VERSION,
    // v3 mandatory freshness anchor. It must be WELL-FORMED here or this
    // assertion silently changes meaning: a malformed/absent anchor is its own
    // 401, and the thesis above is that `aud` is the UNIQUE failing condition.
    // (The anchor check happens after the audience check, so a missing one would
    // not actually mask THIS rejection — but it would make the reply's cause
    // ambiguous to a reader, and it breaks the positive register below.)
    clientNonce: generateClientNonce(),
  });
  expectOpaque401(registerReply, "foreign register");
  await new Promise((resolve) => setTimeout(resolve, 300));
  if (targetOutMessages !== 0) {
    throw new Error(`foreign rejection emitted ${targetOutMessages} target history/approval messages`);
  }

  // Reuse the exact same B-issued nonce and PoP signature with the only corrected
  // input: the B-audience token. A successful register proves the rejected A
  // token was checked before the single-use nonce was consumed.
  const nonceReuseReply = await request({
    op: "register",
    token: targetBootstrap.jwt,
    nonce: liveChallenge.nonce,
    signature,
    protocolVersion: WEBCHANNEL_PROTOCOL_VERSION,
    // A FRESH anchor: this is a separate register attempt, and the wrap it
    // receives is bound to this value. Reusing the one above would be exactly
    // the staleness v3 exists to reject.
    clientNonce: generateClientNonce(),
  });
  if (
    nonceReuseReply.registered !== true ||
    nonceReuseReply.peerId !== PEER_ID ||
    typeof nonceReuseReply.wrappedConversationKey !== "object" ||
    nonceReuseReply.wrappedConversationKey === null
  ) {
    throw new Error(
      `same nonce was not reusable with the target token: ${JSON.stringify(nonceReuseReply)}`,
    );
  }
  console.log(
    `[PROOF:foreign] same peer/cnf/PoP, live B-issued nonce, token aud=${TOKEN_ACCOUNT_ID} ` +
      `sent to target=${ACCOUNT_ID}; challenge/register both returned exact opaque 401 ` +
      "and target .out stayed silent; the same nonce then succeeded with the target token",
  );
  raw.disconnect();
  process.exit(0);
}

// 5. Production client through the PoP register path.
const client = new WebChannelNatsClient({
  url: NATS,
  jwt: bootstrap.jwt,
  accountId: ACCOUNT_ID,
  tenant: TENANT,
  peerId: PEER_ID,
  registration: {
    // The client derives the register subject from tenant/accountId/peerId and
    // drives challenge→register over NATS request/reply (no gateway URL).
    devicePrivateKey: ed25519.privateKey,
    // Phase 6: register-delivered conversation key (no handshake).
    deviceX25519PrivateKey: x25519.privateKey,
    pinnedAgentPublicKey: bootstrap.agentPublicKey,
  },
  natsCredentials,
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
    `and did NOT reach the other account's agent — account-bound verifier + binding.account isolation OK`,
);
client.disconnect();
process.exit(0);
