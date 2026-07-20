// P0-3 S4 — N3 active-relay key-swap (2-phase SIGSTOP-MITM). Node/tsx driver.
//
// The gateway is SIGSTOPped by the runner (sole responder removed), so a MITM
// holding the VICTIM peerId's OWN browser creds becomes the only live answerer on
// the victim's `.register` subject. The MITM answers the challenge (valid nonce
// shape) AND forges a register reply whose wrappedConversationKey is wrapped under
// an ATTACKER identity key. The production WebChannelNatsClient (victim) unwraps
// against the SaaS-PINNED agent key: the forged reply carries the attacker's wire
// key, which fails the F2 pinned-key comparison (wire key ≠ pinned agent key,
// e2e-crypto-browser.ts:169) BEFORE any ECDH/Poly1305 — so the client surfaces the
// EXACT cause `secure-channel-failed` (nats-client.ts:1265), distinct from a
// timeout. Recovery (SIGCONT + a FRESH client, no MITM) then registers cleanly
// against the real gateway.
//
// Node v24 exposes global WebSocket + webcrypto, so the whole client runs here
// alongside the MITM in one process — no browser coordination.
//
// Usage: node --import tsx n3-key-swap.ts --phase=attack|recovery
// Exit: 0 pass · 4 assertion failed · 2 setup error.

import { webcrypto } from "node:crypto";

import { WebChannelNatsClient } from "../../packages/client/src/nats-client.js";
import type { WebChannelErrorCause } from "../../packages/client/src/types.js";
import { WEBCHANNEL_PROTOCOL_VERSION } from "../../packages/client/src/protocol.js";
import {
  mintNatsUser,
  mintBootstrapJwt,
  connectRawTransport,
  subscribe,
  deviceKeyFromBootstrapJwt,
  forgeWrappedConversationKey,
} from "./raw-probe.js";
import type { NatsMessage } from "../../packages/plugin/src/nats-transport.js";

const ISSUER = reqEnv("WEBCHANNEL_ISSUER_URL");
const NATS_WS = reqEnv("WEBCHANNEL_NATS_URL");
const TENANT = reqEnv("WEBCHANNEL_TENANT");
// The N3 target account. lib-negative-legs.sh feeds this env the OPEN account
// (semantically ACCT_B, dmSecurity:"open") so the recovery's fresh random peer can
// echo — an allowlist account would deny it. The env NAME is generic; the value is
// whatever the lib passes, not necessarily "account A".
const ACCOUNT = reqEnv("WEBCHANNEL_ACCOUNT_A");
const PEER_ID = process.env.WEBCHANNEL_N3_PEER ?? "n3-victim-peer";
const PHASE = (process.argv.find((a) => a.startsWith("--phase="))?.split("=")[1] ?? "attack") as
  | "attack"
  | "recovery";
const TEXT = "n3 recovery round-trip";

function reqEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`[n3] missing required env ${name}`);
    process.exit(2);
  }
  return v;
}

function b64url(buf: ArrayBuffer | Uint8Array): string {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return Buffer.from(b).toString("base64url");
}

/** Mint the full victim-client inputs (device keys + bootstrap JWT + NATS creds). */
async function buildVictimInputs(): Promise<{
  natsUrl: string;
  jwt: string;
  userJwt: string;
  userSeedRaw: string;
  devicePrivateKey: CryptoKey;
  deviceX25519PrivateKey: CryptoKey;
  pinnedAgentPublicKey: string;
}> {
  // Device X25519 (cnf) — extractable to export the raw public key.
  const x = (await webcrypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"])) as CryptoKeyPair;
  const deviceX25519PublicKey = b64url(await webcrypto.subtle.exportKey("raw", x.publicKey));
  // Device Ed25519 (PoP) — non-extractable signer.
  const ed = (await webcrypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"])) as CryptoKeyPair;
  const edJwk = (await webcrypto.subtle.exportKey("jwk", ed.publicKey)) as { x?: string };
  if (!edJwk.x) throw new Error("Ed25519 jwk missing x");

  const creds = await mintNatsUser(ISSUER, { tenant: TENANT, role: "browser", peerId: PEER_ID });
  const boot = await mintBootstrapJwt(ISSUER, {
    tenant: TENANT,
    accountId: ACCOUNT,
    peerId: PEER_ID,
    deviceX25519PublicKey,
    devicePopPublicKey: edJwk.x,
  });
  if (!boot.agentPublicKey) throw new Error("bootstrap-jwt carried no agentPublicKey (F2 pin)");
  return {
    natsUrl: creds.natsUrl ?? NATS_WS,
    jwt: boot.jwt,
    userJwt: creds.userJwt,
    userSeedRaw: creds.userSeedRaw,
    devicePrivateKey: ed.privateKey,
    deviceX25519PrivateKey: x.privateKey,
    pinnedAgentPublicKey: boot.agentPublicKey,
  };
}

function makeClient(inp: Awaited<ReturnType<typeof buildVictimInputs>>): WebChannelNatsClient {
  return new WebChannelNatsClient({
    url: inp.natsUrl,
    jwt: inp.jwt,
    accountId: ACCOUNT,
    tenant: TENANT,
    peerId: PEER_ID,
    natsCredentials: { userJwt: inp.userJwt, userSeedRaw: inp.userSeedRaw },
    registration: {
      devicePrivateKey: inp.devicePrivateKey,
      deviceX25519PrivateKey: inp.deviceX25519PrivateKey,
      pinnedAgentPublicKey: inp.pinnedAgentPublicKey,
    },
  });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ── Attack: MITM forges the register reply; assert secure-channel-failed ─────
async function attack(): Promise<void> {
  // 1. MITM on the victim's own creds — subscribe the victim's `.register`.
  const mitmCreds = await mintNatsUser(ISSUER, { tenant: TENANT, role: "browser", peerId: PEER_ID });
  const mitm = await connectRawTransport({
    url: mitmCreds.natsUrl ?? NATS_WS,
    userJwt: mitmCreds.userJwt,
    userSeed: mitmCreds.userSeed,
    clientName: "n3-mitm",
  });
  const registerSubj = `webchannel.${TENANT}.${ACCOUNT}.${PEER_ID}.register`;
  let forgedReplies = 0;
  subscribe(mitm, registerSubj, (msg: NatsMessage) => {
    if (!msg.replyTo) return;
    let parsed: { op?: string; token?: string };
    try {
      parsed = JSON.parse(msg.payload.toString("utf8"));
    } catch {
      return;
    }
    if (parsed.op === "challenge") {
      // Valid nonce SHAPE — without this the victim never reaches register phase
      // and would fail for the WRONG reason (challenge timeout).
      mitm.publish(msg.replyTo, JSON.stringify({ nonce: b64url(webcrypto.getRandomValues(new Uint8Array(24))) }));
    } else if (parsed.op === "register" && parsed.token) {
      // Forge a wrappedConversationKey under an ATTACKER identity key. The victim
      // rejects it at the F2 pinned-key comparison (attacker wire key ≠ pinned
      // agent key) before ECDH/Poly1305 → secure-channel-failed.
      let victimDevice: Uint8Array;
      try {
        victimDevice = deviceKeyFromBootstrapJwt(parsed.token);
      } catch {
        victimDevice = webcrypto.getRandomValues(new Uint8Array(32));
      }
      const wrapped = forgeWrappedConversationKey({ victimDevicePublicKey: victimDevice, peerId: PEER_ID });
      forgedReplies++;
      mitm.publish(
        msg.replyTo,
        JSON.stringify({
          peerId: PEER_ID,
          registered: true,
          wrappedConversationKey: wrapped,
          protocolVersion: WEBCHANNEL_PROTOCOL_VERSION,
        }),
      );
    }
  });
  // Let the MITM subscription register server-side before the victim registers.
  await sleep(400);

  // 2. Victim — the production client. Capture the onError CAUSE.
  const inp = await buildVictimInputs();
  const client = makeClient(inp);
  const cause = await new Promise<WebChannelErrorCause | undefined>((resolve) => {
    const timer = setTimeout(() => resolve(undefined), 20000);
    client.onError((_e, c) => {
      clearTimeout(timer);
      resolve(c);
    });
    client.onMessage(() => {
      // A real message would mean the MITM's swap was accepted — that is a FAIL.
      clearTimeout(timer);
      resolve("UNEXPECTED_MESSAGE" as WebChannelErrorCause);
    });
    client.connect();
    client.sendUserMessage("n3 attack probe");
  });
  try {
    client.disconnect();
  } catch {
    /* terminal already */
  }
  mitm.disconnect();

  if (forgedReplies === 0) {
    console.error("[n3] ✗ attack: MITM never forged a register reply (victim never reached register phase)");
    process.exit(4);
  }
  if (cause !== "secure-channel-failed") {
    console.error(
      `[n3] ✗ attack: expected cause "secure-channel-failed", got ${JSON.stringify(cause)} ` +
        `(a timeout or loose failure must be distinguishable from a key rejection)`,
    );
    process.exit(4);
  }
  console.log("[n3] ✓ attack: forged key-swap rejected with cause=secure-channel-failed (pinned-key unwrap failed)");
}

// ── Recovery: fresh client, live gateway (SIGCONT), no MITM → clean round-trip ─
async function recovery(): Promise<void> {
  const inp = await buildVictimInputs();
  const client = makeClient(inp);
  const reply = await new Promise<string | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), 25000);
    client.onError((e, c) => {
      clearTimeout(timer);
      console.error(`[n3] recovery onError: ${e.message} (cause=${c})`);
      resolve(null);
    });
    client.onMessage((m) => {
      if (m.type === "agent_message") {
        clearTimeout(timer);
        resolve(m.text ?? "");
      }
    });
    client.connect();
    client.sendUserMessage(TEXT);
  });
  try {
    client.disconnect();
  } catch {
    /* ignore */
  }
  if (!reply || !reply.includes(TEXT)) {
    console.error(`[n3] ✗ recovery: fresh client did NOT complete a clean round-trip (reply=${JSON.stringify(reply)})`);
    process.exit(4);
  }
  console.log("[n3] ✓ recovery: fresh client registered + round-tripped against the live gateway");
}

async function main(): Promise<void> {
  console.log(`[n3] phase=${PHASE} peer=${PEER_ID} account=${ACCOUNT}`);
  if (PHASE === "attack") await attack();
  else await recovery();
  process.exit(0);
}

main().catch((err) => {
  console.error("[n3] setup error:", err instanceof Error ? err.message : err);
  process.exit(2);
});
