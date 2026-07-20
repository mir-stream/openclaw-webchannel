// P0-3 S4 — raw NATS probe primitives for the adversarial negative legs (N1-N3).
//
// This module gives the negative-leg drivers the LOW-LEVEL capabilities a
// production WebChannelNatsClient hides: publish an arbitrary subject, drive a
// register request/reply by hand, subscribe a reginbox, and forge a
// wrappedConversationKey under an ATTACKER identity key. It imports the RAW
// plugin `NatsTransport` (via tsx — the precedent is enrolled-transport-roundtrip.ts
// run with `node --import tsx`) and mints creds from the reference SaaS
// `/test/nats-user` test route. `@nats-io/*` is allowed here (e2e), never in the
// plugin.
//
// The MITM (N3) needs NO new mint authority: it reuses the VICTIM peerId's own
// browser creds (grant `webchannel.{tenant}.*.{peerId}.>` already covers the
// victim's `.register` subscribe + `.reginbox` publish), exactly modeling a
// relay that can see a peer's subtree yet still cannot key-swap.

import { randomBytes } from "node:crypto";

import { fromSeed } from "@nats-io/nkeys";

import { NatsTransport } from "../../packages/plugin/src/nats-transport.js";
import type { NatsMessage } from "../../packages/plugin/src/nats-transport.js";
import { wrapConversationKey } from "../../packages/plugin/src/late-join-decryptor.js";
import type { WrappedConversationKey } from "../../packages/plugin/src/late-join-decryptor.js";
import { generateKeyPair } from "../../packages/plugin/src/e2e-crypto.js";

export type MintedNatsUser = {
  userJwt: string;
  userSeed: string;
  userSeedRaw: string;
  natsUrl?: string;
};

export async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: any; text: string }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON */
  }
  return { status: res.status, json, text };
}

/** Mint NATS user creds from the reference `/test/nats-user` route (TTL-bounded). */
export async function mintNatsUser(
  issuerUrl: string,
  opts: { tenant: string; role: "agent" | "browser" | "observer"; peerId?: string },
): Promise<MintedNatsUser> {
  const res = await postJson(`${issuerUrl}/test/nats-user`, {
    tenant: opts.tenant,
    role: opts.role,
    ...(opts.peerId ? { peerId: opts.peerId } : {}),
  });
  if (res.status !== 200 || !res.json?.userJwt || !res.json?.userSeed) {
    throw new Error(`mintNatsUser(${opts.role}) failed: HTTP ${res.status} ${res.text}`);
  }
  return {
    userJwt: res.json.userJwt,
    userSeed: res.json.userSeed,
    userSeedRaw: res.json.userSeedRaw,
    ...(res.json.natsUrl ? { natsUrl: res.json.natsUrl } : {}),
  };
}

/** Mint a bootstrap JWT (RS256) from `/test/bootstrap-jwt` — carries cnf + pop_jwk. */
export async function mintBootstrapJwt(
  issuerUrl: string,
  opts: {
    tenant: string;
    accountId: string;
    peerId: string;
    deviceX25519PublicKey: string;
    devicePopPublicKey: string;
  },
): Promise<{ jwt: string; agentPublicKey?: string; kid?: string }> {
  const res = await postJson(`${issuerUrl}/test/bootstrap-jwt`, opts);
  if (res.status !== 200 || !res.json?.jwt) {
    throw new Error(`mintBootstrapJwt failed: HTTP ${res.status} ${res.text}`);
  }
  return { jwt: res.json.jwt, agentPublicKey: res.json.agentPublicKey, kid: res.json.kid };
}

/** Open a RAW NKEY-authenticated transport (the production challenge-response). */
export async function connectRawTransport(opts: {
  url: string;
  userJwt: string;
  userSeed: string;
  clientName: string;
}): Promise<NatsTransport> {
  const userKp = fromSeed(new TextEncoder().encode(opts.userSeed));
  const transport = new NatsTransport({
    url: opts.url,
    jwtCredential: opts.userJwt,
    nkeySigningCallback: (nonce: string) =>
      Promise.resolve(Buffer.from(userKp.sign(new TextEncoder().encode(nonce))).toString("base64url")),
    clientName: opts.clientName,
  });
  transport.on("error", (e: Error) => console.error(`[raw-probe:${opts.clientName}][nats-error]`, e.message));
  await transport.connect();
  return transport;
}

/** A single NATS request/reply on `subject`, reply routed to a fresh reginbox token. */
export function natsRequest(
  transport: NatsTransport,
  opts: { subject: string; replyPrefix: string; body: unknown; timeoutMs?: number },
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const replySubject = `${opts.replyPrefix}.${randomBytes(12).toString("hex")}`;
    const sid = transport.subscribe(replySubject);
    const onMsg = (msg: NatsMessage): void => {
      if (msg.subject !== replySubject) return;
      clearTimeout(timer);
      transport.off("message", onMsg);
      transport.unsubscribe(sid);
      try {
        resolve(JSON.parse(msg.payload.toString("utf8")));
      } catch (err) {
        reject(err as Error);
      }
    };
    const timer = setTimeout(() => {
      transport.off("message", onMsg);
      transport.unsubscribe(sid);
      reject(new Error(`natsRequest timeout on ${opts.subject}`));
    }, opts.timeoutMs ?? 5000);
    transport.on("message", onMsg);
    transport.publishWithReply(opts.subject, replySubject, JSON.stringify(opts.body));
  });
}

/** Subscribe a subject and route matching messages to `onMsg`; returns the sid. */
export function subscribe(
  transport: NatsTransport,
  subject: string,
  onMsg: (msg: NatsMessage) => void,
): number {
  const handler = (msg: NatsMessage): void => {
    if (msg.subject === subject) onMsg(msg);
  };
  transport.on("message", handler);
  return transport.subscribe(subject);
}

/** Decode a JWT payload (no verification — for the MITM to read cnf/claims). */
export function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const parts = jwt.split(".");
  if (parts.length < 2) throw new Error("decodeJwtPayload: malformed JWT");
  return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<string, unknown>;
}

/** Extract the device X25519 public key (raw 32B) from a bootstrap JWT's cnf.jwk. */
export function deviceKeyFromBootstrapJwt(jwt: string): Uint8Array {
  const claims = decodeJwtPayload(jwt) as { cnf?: { jwk?: { x?: string } } };
  const x = claims.cnf?.jwk?.x;
  if (typeof x !== "string") throw new Error("bootstrap JWT has no cnf.jwk.x device key");
  return new Uint8Array(Buffer.from(x, "base64url"));
}

/**
 * Forge a wrappedConversationKey the way an ACTIVE RELAY would: wrap a random K
 * under an ATTACKER identity keypair (never the SaaS-pinned agent key). The reply
 * carries the attacker's wire key, so the victim rejects it at the F2 pinned-key
 * comparison (wire key ≠ pinned agent key, e2e-crypto-browser.ts:169) BEFORE any
 * ECDH/Poly1305 — `secure-channel-failed`, NOT a signature check. Returns the wire
 * shape a genuine register reply carries.
 */
export function forgeWrappedConversationKey(opts: {
  victimDevicePublicKey: Uint8Array;
  peerId: string;
}): WrappedConversationKey {
  const attackerIdentity = generateKeyPair();
  const forgedK = new Uint8Array(randomBytes(32));
  return wrapConversationKey(forgedK, opts.victimDevicePublicKey, {
    agentIdentityKeyPair: attackerIdentity,
    peerId: opts.peerId,
  });
}
