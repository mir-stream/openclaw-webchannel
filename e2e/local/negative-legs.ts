// P0-3 S4 — shared adversarial negative legs N1 + N2 (run in every mode A/B/C).
//
// N1 pre-register no-turn: a valid-creds publish to account A's `…{peerId}.in`
// WITHOUT registering must create NO turn. (Mechanism note: the gateway subscribes
// a peer's `.in` ONLY at registration — nats-channel.ts:297 — and unregister drops
// the sub + key together, so pre-register the subject has NO subscriber and the
// message never reaches dispatch. That is STRONGER than the drop-line the plan
// assumed; the runner greps the gateway log for the `no registered session key`
// drop as a best-effort signal, but the PASS gate here is the no-turn assertion.)
//
// N2 wrong-binding 401: account A's bootstrap JWT presented on account B's
// `.register` subject must be rejected 401 (aud mismatch) — the live twin of the
// D6-3 negative unit test. Requires BOTH accounts served (distinct aud=accountId).
//
// Exit: 0 all legs passed · 4 a leg failed · 2 setup error.

import { randomBytes } from "node:crypto";

import {
  mintNatsUser,
  mintBootstrapJwt,
  connectRawTransport,
  natsRequest,
  subscribe,
} from "./raw-probe.js";
import type { NatsMessage } from "../../packages/plugin/src/nats-transport.js";

const ISSUER = reqEnv("WEBCHANNEL_ISSUER_URL");
const NATS_WS = reqEnv("WEBCHANNEL_NATS_URL");
const TENANT = reqEnv("WEBCHANNEL_TENANT");
const ACCOUNT_A = reqEnv("WEBCHANNEL_ACCOUNT_A");
const ACCOUNT_B = reqEnv("WEBCHANNEL_ACCOUNT_B");
const NO_TURN_WINDOW_MS = parseInt(process.env.WEBCHANNEL_NOTURN_MS ?? "3000", 10);

function reqEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`[neg] missing required env ${name}`);
    process.exit(2);
  }
  return v;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
function pass(leg: string, msg: string): void {
  console.log(`[neg] ✓ ${leg}: ${msg}`);
}
function fail(leg: string, msg: string): never {
  console.error(`[neg] ✗ ${leg}: ${msg}`);
  process.exit(4);
}

// ── N1 — pre-register publish creates no turn ────────────────────────────────
async function n1PreRegisterNoTurn(): Promise<void> {
  const peerId = `n1-noturn-${randomBytes(4).toString("hex")}`;
  const creds = await mintNatsUser(ISSUER, { tenant: TENANT, role: "browser", peerId });
  const transport = await connectRawTransport({
    url: creds.natsUrl ?? NATS_WS,
    userJwt: creds.userJwt,
    userSeed: creds.userSeed,
    clientName: "n1-probe",
  });
  try {
    const inSubj = `webchannel.${TENANT}.${ACCOUNT_A}.${peerId}.in`;
    const outSubj = `webchannel.${TENANT}.${ACCOUNT_A}.${peerId}.out`;
    let outbound = 0;
    subscribe(transport, outSubj, (_m: NatsMessage) => {
      outbound++;
    });
    // Let the SUB register server-side, then publish a ciphertext-shaped payload
    // WITHOUT ever registering. A real sealed envelope is {n,t,c} base64url; the
    // gateway never even subscribes this peer's `.in`, so it is dropped by NATS.
    //
    // DO NOT "fix" this to gate on the gateway's `no registered session key` drop
    // line (nats-channel.ts:744): that drop only fires in the subscribed-but-keyless
    // window, and pre-register the peer's `.in` has NO subscriber at all (registerPeer
    // is the only place it is subscribed — :296-297), so the broker drops the publish
    // before it reaches the gateway and the drop line CAN NEVER fire pre-register.
    // The no-turn assertion below is the load-bearing (and stronger) proof; the
    // runner greps that drop line only as a best-effort diagnostic, never a gate.
    await sleep(200);
    const fakeCiphertext = JSON.stringify({
      n: randomBytes(12).toString("base64url"),
      t: randomBytes(16).toString("base64url"),
      c: randomBytes(48).toString("base64url"),
    });
    transport.publish(inSubj, fakeCiphertext);
    await sleep(NO_TURN_WINDOW_MS);
    if (outbound > 0) {
      fail("N1", `expected NO outbound frame for an unregistered peer, saw ${outbound}`);
    }
    pass("N1", `pre-register publish to ${inSubj} created no turn (0 outbound in ${NO_TURN_WINDOW_MS}ms)`);
  } finally {
    transport.disconnect();
  }
}

// ── N2 — account A token on account B's .register is 401 ─────────────────────
async function n2WrongBinding401(): Promise<void> {
  const peerId = `n2-binding-${randomBytes(4).toString("hex")}`;
  // Browser creds for this peerId: the grant `webchannel.{tenant}.*.{peerId}.>`
  // covers `.register` on ANY account segment (the `*`), so app-layer aud
  // verification — not the broker — is exactly what is on trial.
  const creds = await mintNatsUser(ISSUER, { tenant: TENANT, role: "browser", peerId });
  // A bootstrap JWT minted for ACCOUNT A (aud=accountA), device keys are throwaway
  // (verification fails on aud before any device/PoP check).
  const boot = await mintBootstrapJwt(ISSUER, {
    tenant: TENANT,
    accountId: ACCOUNT_A,
    peerId,
    deviceX25519PublicKey: randomBytes(32).toString("base64url"),
    devicePopPublicKey: randomBytes(32).toString("base64url"),
  });
  const transport = await connectRawTransport({
    url: creds.natsUrl ?? NATS_WS,
    userJwt: creds.userJwt,
    userSeed: creds.userSeed,
    clientName: "n2-probe",
  });
  try {
    // Present account A's token on account B's `.register` subject.
    const registerSubj = `webchannel.${TENANT}.${ACCOUNT_B}.${peerId}.register`;
    const replyPrefix = `webchannel.${TENANT}.${ACCOUNT_B}.${peerId}.reginbox`;
    const reply = (await natsRequest(transport, {
      subject: registerSubj,
      replyPrefix,
      body: { op: "challenge", token: boot.jwt },
      timeoutMs: 6000,
    })) as { error?: string; code?: number };
    if (reply?.code !== 401) {
      fail("N2", `expected 401 for account-A token on account-B .register, got ${JSON.stringify(reply)}`);
    }
    pass("N2", `account-A token rejected 401 on account-B .register (aud binding enforced)`);
  } finally {
    transport.disconnect();
  }
}

async function main(): Promise<void> {
  console.log(`[neg] running N1+N2 (tenant=${TENANT} accountA=${ACCOUNT_A} accountB=${ACCOUNT_B})`);
  await n1PreRegisterNoTurn();
  await n2WrongBinding401();
  console.log("[neg] ✓ N1+N2 passed");
  process.exit(0);
}

main().catch((err) => {
  console.error("[neg] setup error:", err instanceof Error ? err.message : err);
  process.exit(2);
});
