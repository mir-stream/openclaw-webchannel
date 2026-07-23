/**
 * Register-hop admission handler (register over NATS) — verify-and-admit core.
 *
 * Exercises the extracted `handleRegisterRequest` end-to-end over the injected
 * seams (real `PopChallengeStore`, real Ed25519 PoP signing) so the security
 * checks the deleted HTTP route used to enforce are locked in on the NATS path:
 * challenge+register happy path incl. wrappedConversationKey delivery, single-use
 * nonce (a replayed register is rejected), subject/JWT peerId spoof rejection,
 * JWT failure → generic reply, missing/absent PoP handling, and unregister.
 */

import { generateKeyPairSync, sign as edSign, randomBytes, webcrypto } from "node:crypto";
import { describe, it, expect } from "vitest";

import {
  handleRegisterRequest,
  REGISTER_UNAUTHORIZED,
  REGISTER_FAILED,
  REGISTER_UNAVAILABLE,
  type RegisterHandlerDeps,
} from "./nats-register.js";
import { PopChallengeStore, popSignedMessage } from "./pop-challenge.js";
import {
  createAccountJwtVerifier,
  resolveVerifierConfig,
  TransientVerifyError,
} from "./auth.js";
import type { JwtIdentity } from "./jwt.js";
import {
  unwrapConversationKey,
  wrapConversationKey,
  type WrappedConversationKey,
} from "./late-join-decryptor.js";
import { generateKeyPair as generateX25519KeyPair } from "./e2e-crypto.js";
import type { JsonWebKeySet } from "./jwks.js";
import { WEBCHANNEL_PROTOCOL_VERSION } from "./protocol.js";

const PEER = "user-42";
const TENANT = "tenant-1";
const FAKE_WRAPPED: WrappedConversationKey = {
  ephemeralPublicKey: "ephemeral",
  nonce: "nonce",
  ciphertext: "ciphertext",
  tag: "tag",
};

/** A real Ed25519 device key: exposes its `pop_jwk` and a nonce signer. */
function makeDevice() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" }) as { x: string };
  const popPublicJwk = { kty: "OKP", crv: "Ed25519", x: jwk.x };
  const sign = (msg: string) =>
    Buffer.from(edSign(null, Buffer.from(msg, "utf8"), privateKey)).toString("base64url");
  return { popPublicJwk, sign };
}

const REAL_ISSUER = "https://issuer.example/register-matrix";
const ACCOUNT_A = "account-a";
const ACCOUNT_B = "account-b";
let realRsaPrivateKey: webcrypto.CryptoKey | undefined;
let realRsaJwks: JsonWebKeySet | undefined;

async function ensureRealRsa(): Promise<void> {
  if (realRsaPrivateKey && realRsaJwks) return;
  const pair = await webcrypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  realRsaPrivateKey = pair.privateKey;
  const publicJwk = await webcrypto.subtle.exportKey("jwk", pair.publicKey);
  realRsaJwks = { keys: [{ ...publicJwk, kid: "register-matrix", alg: "RS256", use: "sig" }] };
}

function b64urlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

async function signRealToken(claims: Record<string, unknown>): Promise<string> {
  await ensureRealRsa();
  const header = b64urlJson({ alg: "RS256", typ: "JWT", kid: "register-matrix" });
  const payload = b64urlJson({
    iss: REAL_ISSUER,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 300,
    ...claims,
  });
  const signingInput = `${header}.${payload}`;
  const signature = await webcrypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    realRsaPrivateKey!,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${Buffer.from(signature).toString("base64url")}`;
}

async function realVerifier(accountId: string): Promise<RegisterHandlerDeps["verifyIdentity"]> {
  await ensureRealRsa();
  const auth = resolveVerifierConfig({
    strategy: "jwt",
    jwt: { issuer: REAL_ISSUER, jwks: realRsaJwks },
  });
  return createAccountJwtVerifier({ auth, accountId }).verifyIdentity;
}

type Harness = {
  deps: RegisterHandlerDeps;
  replies: string[];
  registered: string[];
  unregistered: string[];
  snapshots: string[];
  approvalSnapshots: string[];
  wrapCalls: Array<{ peerId: string; key: Uint8Array }>;
  run: (payload: unknown) => Promise<void>;
};

function makeHarness(opts?: {
  identity?: JwtIdentity | null;
  subjectPeerId?: string;
  wrap?: (peerId: string, key: Uint8Array) => WrappedConversationKey | null;
  requirePoP?: boolean;
  verifyIdentity?: RegisterHandlerDeps["verifyIdentity"];
  registerPeer?: (peerId: string) => void;
}): Harness {
  const replies: string[] = [];
  const registered: string[] = [];
  const unregistered: string[] = [];
  const snapshots: string[] = [];
  const approvalSnapshots: string[] = [];
  const wrapCalls: Array<{ peerId: string; key: Uint8Array }> = [];
  const rawIdentity =
    opts && "identity" in opts
      ? opts.identity
      : ({ peerId: PEER, devicePublicKey: randomBytes(32).toString("base64url") } as JwtIdentity);
  const identity = rawIdentity ? { ...rawIdentity, tenant: rawIdentity.tenant ?? TENANT } : null;

  const deps: RegisterHandlerDeps = {
    tenant: TENANT,
    subjectPeerId: opts?.subjectPeerId ?? PEER,
    payload: "",
    reply: (r) => replies.push(r),
    verifyIdentity: opts?.verifyIdentity ?? (async () => identity ?? null),
    requirePoP: opts?.requirePoP ?? true,
    popChallenges: new PopChallengeStore(),
    registerPeer: opts?.registerPeer ?? ((pid) => registered.push(pid)),
    wrapConversationKeyForDevice:
      opts?.wrap ??
      ((pid, key) => {
        wrapCalls.push({ peerId: pid, key });
        return FAKE_WRAPPED;
      }),
    unregisterPeer: (pid) => unregistered.push(pid),
    sendHistorySnapshot: (pid) => snapshots.push(pid),
    sendApprovalSnapshot: (pid) => approvalSnapshots.push(pid),
    logger: { error: () => {} },
  };

  const run = async (payload: unknown): Promise<void> => {
    deps.payload = JSON.stringify(payload);
    await handleRegisterRequest(deps);
  };

  return { deps, replies, registered, unregistered, snapshots, approvalSnapshots, wrapCalls, run };
}

describe("handleRegisterRequest (register over NATS)", () => {
  it("challenge → register happy path delivers the wrapped conversation key", async () => {
    const device = makeDevice();
    const h = makeHarness({
      identity: {
        peerId: PEER,
        popPublicJwk: device.popPublicJwk,
        devicePublicKey: randomBytes(32).toString("base64url"),
      } as JwtIdentity,
    });

    await h.run({ op: "challenge", token: "jwt" });
    const { nonce } = JSON.parse(h.replies[0]) as { nonce: string };
    expect(typeof nonce).toBe("string");

    const signature = device.sign(popSignedMessage(PEER, nonce));
    await h.run({ op: "register", token: "jwt", nonce, signature });

    expect(h.registered).toEqual([PEER]);
    expect(h.snapshots).toEqual([PEER]);
    // #15: the authoritative pending-approval snapshot fires exactly once, on the
    // verified peerId, on the same successful register.
    expect(h.approvalSnapshots).toEqual([PEER]);
    const reply = JSON.parse(h.replies[1]) as {
      peerId: string;
      registered: boolean;
      wrappedConversationKey: WrappedConversationKey;
      protocolVersion?: number;
      pluginVersion?: string;
    };
    expect(reply).toMatchObject({
      peerId: PEER,
      registered: true,
      wrappedConversationKey: FAKE_WRAPPED,
    });
    // Protocol handshake: the reply echoes the plugin's wire-protocol version
    // (enforced client-side) and its package version (diagnostics).
    expect(reply.protocolVersion).toBe(WEBCHANNEL_PROTOCOL_VERSION);
    expect(typeof reply.pluginVersion).toBe("string");
    // The wrap targeted the request's 32-byte cnf device key.
    expect(h.wrapCalls).toHaveLength(1);
    expect(h.wrapCalls[0].key.length).toBe(32);
  });

  it("single-use nonce: a second register with the same PoP is rejected", async () => {
    const device = makeDevice();
    const h = makeHarness({
      identity: {
        peerId: PEER,
        popPublicJwk: device.popPublicJwk,
        devicePublicKey: randomBytes(32).toString("base64url"),
      } as JwtIdentity,
    });

    await h.run({ op: "challenge", token: "jwt" });
    const { nonce } = JSON.parse(h.replies[0]) as { nonce: string };
    const signature = device.sign(popSignedMessage(PEER, nonce));

    await h.run({ op: "register", token: "jwt", nonce, signature });
    expect(JSON.parse(h.replies[1]).registered).toBe(true);

    // Replay the SAME nonce+signature — the nonce was consumed, so it must fail
    // with the generic unauthorized (a chaos-scene replay assertion).
    await h.run({ op: "register", token: "jwt", nonce, signature });
    expect(h.replies[2]).toBe(REGISTER_UNAUTHORIZED);
    expect(h.registered).toEqual([PEER]); // no second registration
  });

  it("subject-peerId spoof: subject peerId ≠ JWT peerId is rejected", async () => {
    const device = makeDevice();
    const h = makeHarness({
      subjectPeerId: "someone-else",
      identity: {
        peerId: PEER,
        popPublicJwk: device.popPublicJwk,
        devicePublicKey: randomBytes(32).toString("base64url"),
      } as JwtIdentity,
    });

    await h.run({ op: "challenge", token: "jwt" });
    expect(h.replies[0]).toBe(REGISTER_UNAUTHORIZED);
    // No nonce was issued to the spoofed subject.
    expect(h.deps.popChallenges.size).toBe(0);
  });

  it("JWT failure → generic unauthorized (no oracle detail)", async () => {
    const h = makeHarness({ identity: null });
    await h.run({ op: "register", token: "bad-jwt", nonce: "x", signature: "y" });
    expect(h.replies[0]).toBe(REGISTER_UNAUTHORIZED);
    expect(h.registered).toEqual([]);
  });

  it("missing/empty token → generic unauthorized", async () => {
    const h = makeHarness();
    await h.run({ op: "challenge" });
    expect(h.replies[0]).toBe(REGISTER_UNAUTHORIZED);
  });

  it("register with pop_jwk but no proof → generic unauthorized", async () => {
    const device = makeDevice();
    const h = makeHarness({
      identity: {
        peerId: PEER,
        popPublicJwk: device.popPublicJwk,
        devicePublicKey: randomBytes(32).toString("base64url"),
      } as JwtIdentity,
    });
    await h.run({ op: "register", token: "jwt" }); // no nonce/signature
    expect(h.replies[0]).toBe(REGISTER_UNAUTHORIZED);
    expect(h.registered).toEqual([]);
  });

  it("register with no cnf device key → generic unauthorized", async () => {
    // requirePoP defaults true; with no pop_jwk the PoP gate rejects first, so
    // set requirePoP:false to reach the cnf check with a no-cnf identity.
    const h = makeHarness({
      requirePoP: false,
      identity: { peerId: PEER } as JwtIdentity, // no devicePublicKey, no pop_jwk
    });
    await h.run({ op: "register", token: "jwt" });
    expect(h.replies[0]).toBe(REGISTER_UNAUTHORIZED);
    expect(h.registered).toEqual([]);
  });

  it("no conversation key established → registration_failed (internal fault)", async () => {
    const device = makeDevice();
    const h = makeHarness({
      wrap: () => null, // channel returns no wrapped key
      identity: {
        peerId: PEER,
        popPublicJwk: device.popPublicJwk,
        devicePublicKey: randomBytes(32).toString("base64url"),
      } as JwtIdentity,
    });
    await h.run({ op: "challenge", token: "jwt" });
    const { nonce } = JSON.parse(h.replies[0]) as { nonce: string };
    const signature = device.sign(popSignedMessage(PEER, nonce));
    await h.run({ op: "register", token: "jwt", nonce, signature });
    expect(h.replies[1]).toBe(REGISTER_FAILED);
    // #15: a register that FAILS before the success block must NOT emit the
    // pending-approval snapshot (the key wrap failed → no session established).
    expect(h.approvalSnapshots).toEqual([]);
  });

  it("#15: a rejected register (JWT failure) does not emit the approval snapshot", async () => {
    const h = makeHarness({ identity: null });
    await h.run({ op: "register", token: "bad-jwt", nonce: "x", signature: "y" });
    expect(h.replies[0]).toBe(REGISTER_UNAUTHORIZED);
    expect(h.approvalSnapshots).toEqual([]);
    expect(h.snapshots).toEqual([]);
  });

  it("unregister with the harness' matching signed tenant tears down the verified peer, no reply", async () => {
    const h = makeHarness();
    await h.run({ op: "unregister", token: "jwt" });
    expect(h.unregistered).toEqual([PEER]);
    expect(h.replies).toEqual([]); // fire-and-forget
  });

  it("unregister with a matching signed tenant tears down the verified peer, no reply", async () => {
    const h = makeHarness({ identity: { peerId: PEER, tenant: TENANT } as JwtIdentity });
    await h.run({ op: "unregister", token: "jwt" });
    expect(h.unregistered).toEqual([PEER]);
    expect(h.replies).toEqual([]);
  });

  it("requires a non-empty signed tenant for challenge/register and silently ignores unregister", async () => {
    const h = makeHarness({
      verifyIdentity: async () => ({ peerId: PEER }),
    });
    await h.run({ op: "challenge", token: "jwt" });
    await h.run({ op: "register", token: "jwt", nonce: "x", signature: "y" });
    await h.run({ op: "unregister", token: "jwt" });
    expect(h.replies).toEqual([REGISTER_UNAUTHORIZED, REGISTER_UNAUTHORIZED]);
    expect(h.registered).toEqual([]);
    expect(h.unregistered).toEqual([]);
  });

  it("unregister with a matching peerId but mismatched signed tenant is a silent no-op", async () => {
    const h = makeHarness({
      identity: { peerId: PEER, tenant: "other-tenant" } as JwtIdentity,
    });
    await h.run({ op: "unregister", token: "jwt" });
    expect(h.unregistered).toEqual([]);
    expect(h.replies).toEqual([]);
  });

  it("unregister WITHOUT a token is a silent no-op (does not tear down)", async () => {
    const h = makeHarness();
    await h.run({ op: "unregister" }); // no token
    expect(h.unregistered).toEqual([]);
    expect(h.replies).toEqual([]);
  });

  it("unregister with a FAILING JWT is a silent no-op", async () => {
    const h = makeHarness({ verifyIdentity: async () => null });
    await h.run({ op: "unregister", token: "bad-jwt" });
    expect(h.unregistered).toEqual([]);
    expect(h.replies).toEqual([]);
  });

  it("unregister with subject peerId ≠ JWT peerId is a silent no-op", async () => {
    // Verified identity is PEER, but the subject targets someone else — do NOT
    // tear down the subject's peer on a mismatched token.
    const h = makeHarness({ subjectPeerId: "someone-else" });
    await h.run({ op: "unregister", token: "jwt" });
    expect(h.unregistered).toEqual([]);
    expect(h.replies).toEqual([]);
  });

  it("register handler throw (registerPeer/wrap fs failure) → registration_failed, no escape", async () => {
    const device = makeDevice();
    const h = makeHarness({
      identity: {
        peerId: PEER,
        popPublicJwk: device.popPublicJwk,
        devicePublicKey: randomBytes(32).toString("base64url"),
      } as JwtIdentity,
      // Simulate ConversationKeyStore.persist() throwing (EACCES/ENOSPC).
      registerPeer: () => {
        throw new Error("EACCES: permission denied, open '~/.openclaw-webchannel/acct/key'");
      },
    });
    await h.run({ op: "challenge", token: "jwt" });
    const { nonce } = JSON.parse(h.replies[0]) as { nonce: string };
    const signature = device.sign(popSignedMessage(PEER, nonce));
    // Must reply REGISTER_FAILED (not throw / unhandledRejection).
    await expect(h.run({ op: "register", token: "jwt", nonce, signature })).resolves.toBeUndefined();
    expect(h.replies[1]).toBe(REGISTER_FAILED);
  });

  it("transient verify failure (JWKS unreachable) → retryable 503, distinct from 401", async () => {
    const h = makeHarness({
      verifyIdentity: async () => {
        throw new TransientVerifyError("JWKS source unavailable");
      },
    });
    await h.run({ op: "register", token: "jwt", nonce: "x", signature: "y" });
    expect(h.replies[0]).toBe(REGISTER_UNAVAILABLE);
    expect(h.replies[0]).not.toBe(REGISTER_UNAUTHORIZED);
    expect(h.registered).toEqual([]);
  });

  it("challenge under a transient verify failure also replies 503", async () => {
    const h = makeHarness({
      verifyIdentity: async () => {
        throw new TransientVerifyError("JWKS source unavailable");
      },
    });
    await h.run({ op: "challenge", token: "jwt" });
    expect(h.replies[0]).toBe(REGISTER_UNAVAILABLE);
  });

  it("cross-account: a token that verifies against THIS account's auth as null (wrong aud) is rejected", async () => {
    // A bootstrap JWT minted for account A, presented on account B's `.register`
    // subject, fails B's verifier (its audience check) → verifyIdentity returns
    // null → generic unauthorized. Nothing is registered under the wrong account.
    const h = makeHarness({
      verifyIdentity: async () => null, // B's verifier rejects A's aud
    });
    await h.run({ op: "register", token: "token-for-account-A", nonce: "x", signature: "y" });
    expect(h.replies[0]).toBe(REGISTER_UNAUTHORIZED);
    expect(h.registered).toEqual([]);
    expect(h.snapshots).toEqual([]);
  });

  it("malformed payload / unknown op → generic unauthorized", async () => {
    const h = makeHarness();
    h.deps.payload = "not json";
    await handleRegisterRequest(h.deps);
    expect(h.replies[0]).toBe(REGISTER_UNAUTHORIZED);

    await h.run({ op: "bogus", token: "jwt" });
    expect(h.replies[1]).toBe(REGISTER_UNAUTHORIZED);
  });
});

describe("handleRegisterRequest with a real account-bound RSA/JWKS verifier", () => {
  it("allows same-(tenant, accountId) HA runtimes to independently accept the same valid token", async () => {
    await ensureRealRsa();
    const makeRuntimeVerifier = () => createAccountJwtVerifier({
      auth: resolveVerifierConfig({
        strategy: "jwt",
        jwt: { issuer: REAL_ISSUER, jwks: realRsaJwks },
      }),
      accountId: ACCOUNT_A,
    }).verifyIdentity;
    const token = await signRealToken({
      aud: ACCOUNT_A,
      tenant: TENANT,
      sub: PEER,
      cnf: {
        jwk: {
          kty: "OKP",
          crv: "X25519",
          x: Buffer.from(generateX25519KeyPair().publicKey).toString("base64url"),
        },
      },
    });
    const runtimeA = makeHarness({ verifyIdentity: makeRuntimeVerifier(), requirePoP: false });
    const runtimeB = makeHarness({ verifyIdentity: makeRuntimeVerifier(), requirePoP: false });

    await runtimeA.run({ op: "register", token });
    await runtimeB.run({ op: "register", token });

    for (const runtime of [runtimeA, runtimeB]) {
      expect(JSON.parse(runtime.replies[0])).toMatchObject({ registered: true, peerId: PEER });
      expect(runtime.registered).toEqual([PEER]);
      expect(runtime.snapshots).toEqual([PEER]);
      expect(runtime.approvalSnapshots).toEqual([PEER]);
    }
  });

  it("applies the signed tenant/aud/sub common gate to challenge and supports multi-aud membership", async () => {
    const verifyA = await realVerifier(ACCOUNT_A);
    const verifyB = await realVerifier(ACCOUNT_B);
    const validA = await signRealToken({ aud: ACCOUNT_A, tenant: TENANT, sub: PEER });
    const multi = await signRealToken({ aud: [ACCOUNT_A, ACCOUNT_B], tenant: TENANT, sub: PEER });

    const acceptedA = makeHarness({ verifyIdentity: verifyA });
    await acceptedA.run({ op: "challenge", token: validA });
    expect(JSON.parse(acceptedA.replies[0])).toHaveProperty("nonce");

    const crossAccount = makeHarness({ verifyIdentity: verifyB });
    await crossAccount.run({ op: "challenge", token: validA });
    expect(crossAccount.replies).toEqual([REGISTER_UNAUTHORIZED]);
    expect(crossAccount.deps.popChallenges.size).toBe(0);

    for (const token of [
      await signRealToken({ aud: ACCOUNT_A, sub: PEER }),
      await signRealToken({ aud: ACCOUNT_A, tenant: "other-tenant", sub: PEER }),
    ]) {
      const rejected = makeHarness({ verifyIdentity: verifyA });
      await rejected.run({ op: "challenge", token });
      expect(rejected.replies).toEqual([REGISTER_UNAUTHORIZED]);
      expect(rejected.deps.popChallenges.size).toBe(0);
    }

    const wrongSubject = makeHarness({ verifyIdentity: verifyA, subjectPeerId: "other-peer" });
    await wrongSubject.run({ op: "challenge", token: validA });
    expect(wrongSubject.replies).toEqual([REGISTER_UNAUTHORIZED]);
    expect(wrongSubject.deps.popChallenges.size).toBe(0);

    for (const verifier of [verifyA, verifyB]) {
      const accepted = makeHarness({ verifyIdentity: verifier });
      await accepted.run({ op: "challenge", token: multi });
      expect(JSON.parse(accepted.replies[0])).toHaveProperty("nonce");
    }
    const nonMember = await signRealToken({ aud: "account-c", tenant: TENANT, sub: PEER });
    for (const verifier of [verifyA, verifyB]) {
      const rejected = makeHarness({ verifyIdentity: verifier });
      await rejected.run({ op: "challenge", token: nonMember });
      expect(rejected.replies).toEqual([REGISTER_UNAUTHORIZED]);
      expect(rejected.deps.popChallenges.size).toBe(0);
    }
  });

  it("keeps register's cnf and PoP policy after the real common gate", async () => {
    const verifyA = await realVerifier(ACCOUNT_A);
    const device = makeDevice();
    const x25519 = generateX25519KeyPair();
    const cnf = {
      jwk: { kty: "OKP", crv: "X25519", x: Buffer.from(x25519.publicKey).toString("base64url") },
    };
    const popToken = await signRealToken({
      aud: ACCOUNT_A,
      tenant: TENANT,
      sub: PEER,
      cnf,
      pop_jwk: device.popPublicJwk,
    });
    const required = makeHarness({ verifyIdentity: verifyA });
    await required.run({ op: "challenge", token: popToken });
    const nonce = (JSON.parse(required.replies[0]) as { nonce: string }).nonce;
    await required.run({
      op: "register",
      token: popToken,
      nonce,
      signature: device.sign(popSignedMessage(PEER, nonce)),
    });
    expect(JSON.parse(required.replies[1])).toMatchObject({ registered: true, peerId: PEER });
    expect(required.registered).toEqual([PEER]);
    expect(required.snapshots).toEqual([PEER]);
    expect(required.approvalSnapshots).toEqual([PEER]);

    const noPopToken = await signRealToken({ aud: ACCOUNT_A, tenant: TENANT, sub: PEER, cnf });
    const defaultReject = makeHarness({ verifyIdentity: verifyA });
    await defaultReject.run({ op: "register", token: noPopToken });
    expect(defaultReject.replies).toEqual([REGISTER_UNAUTHORIZED]);
    expect(defaultReject.registered).toEqual([]);

    const explicitlyOptional = makeHarness({ verifyIdentity: verifyA, requirePoP: false });
    await explicitlyOptional.run({ op: "register", token: noPopToken });
    expect(JSON.parse(explicitlyOptional.replies[0])).toMatchObject({ registered: true });

    const presentPopStillRequiresProof = makeHarness({ verifyIdentity: verifyA, requirePoP: false });
    await presentPopStillRequiresProof.run({ op: "register", token: popToken });
    expect(presentPopStillRequiresProof.replies).toEqual([REGISTER_UNAUTHORIZED]);
    expect(presentPopStillRequiresProof.registered).toEqual([]);

    const noCnf = await signRealToken({ aud: ACCOUNT_A, tenant: TENANT, sub: PEER });
    const noCnfHarness = makeHarness({ verifyIdentity: verifyA, requirePoP: false });
    await noCnfHarness.run({ op: "register", token: noCnf });
    expect(noCnfHarness.replies).toEqual([REGISTER_UNAUTHORIZED]);

    const malformedPresentPop = await signRealToken({
      aud: ACCOUNT_A,
      tenant: TENANT,
      sub: PEER,
      cnf,
      pop_jwk: { kty: "OKP", crv: "Ed25519", x: "malformed" },
    });
    const malformedHarness = makeHarness({ verifyIdentity: verifyA, requirePoP: false });
    await malformedHarness.run({ op: "register", token: malformedPresentPop });
    expect(malformedHarness.replies).toEqual([REGISTER_UNAUTHORIZED]);
    expect(malformedHarness.registered).toEqual([]);
  });

  it("applies the signed tenant/aud/sub common gate independently to register", async () => {
    const verifyA = await realVerifier(ACCOUNT_A);
    const verifyB = await realVerifier(ACCOUNT_B);
    const device = generateX25519KeyPair();
    const cnf = {
      jwk: { kty: "OKP", crv: "X25519", x: Buffer.from(device.publicKey).toString("base64url") },
    };
    const token = (claims: Record<string, unknown>) => signRealToken({ sub: PEER, cnf, ...claims });
    const scalarA = await token({ aud: ACCOUNT_A, tenant: TENANT });
    const multi = await token({ aud: [ACCOUNT_A, ACCOUNT_B], tenant: TENANT });

    for (const [verifyIdentity, jwt] of [
      [verifyA, scalarA],
      [verifyA, multi],
      [verifyB, multi],
    ] as const) {
      const accepted = makeHarness({ verifyIdentity, requirePoP: false });
      await accepted.run({ op: "register", token: jwt });
      expect(JSON.parse(accepted.replies[0])).toMatchObject({ registered: true, peerId: PEER });
      expect(accepted.registered).toEqual([PEER]);
      expect(accepted.wrapCalls).toHaveLength(1);
      expect(accepted.snapshots).toEqual([PEER]);
      expect(accepted.approvalSnapshots).toEqual([PEER]);
    }

    const rejectedCases: Array<{
      verifyIdentity: RegisterHandlerDeps["verifyIdentity"];
      jwt: string;
      subjectPeerId?: string;
    }> = [
      { verifyIdentity: verifyB, jwt: scalarA },
      { verifyIdentity: verifyA, jwt: await token({ aud: ACCOUNT_A }) },
      { verifyIdentity: verifyA, jwt: await token({ aud: ACCOUNT_A, tenant: "other-tenant" }) },
      { verifyIdentity: verifyA, jwt: scalarA, subjectPeerId: "other-peer" },
      { verifyIdentity: verifyA, jwt: await token({ aud: "account-c", tenant: TENANT }) },
    ];
    for (const entry of rejectedCases) {
      const rejected = makeHarness({
        verifyIdentity: entry.verifyIdentity,
        requirePoP: false,
        ...(entry.subjectPeerId ? { subjectPeerId: entry.subjectPeerId } : {}),
      });
      await rejected.run({ op: "register", token: entry.jwt });
      expect(rejected.replies).toEqual([REGISTER_UNAUTHORIZED]);
      expect(rejected.registered).toEqual([]);
      expect(rejected.wrapCalls).toEqual([]);
      expect(rejected.snapshots).toEqual([]);
      expect(rejected.approvalSnapshots).toEqual([]);
    }
  });

  it("keeps unregister token-only/no-reply while applying the same real common gate", async () => {
    const verifyA = await realVerifier(ACCOUNT_A);
    const valid = await signRealToken({ aud: ACCOUNT_A, tenant: TENANT, sub: PEER });
    const accepted = makeHarness({ verifyIdentity: verifyA });
    await accepted.run({ op: "unregister", token: valid });
    expect(accepted.unregistered).toEqual([PEER]);
    expect(accepted.replies).toEqual([]);

    for (const token of [
      await signRealToken({ aud: ACCOUNT_B, tenant: TENANT, sub: PEER }),
      await signRealToken({ aud: ACCOUNT_A, sub: PEER }),
      await signRealToken({ aud: ACCOUNT_A, tenant: "other-tenant", sub: PEER }),
    ]) {
      const rejected = makeHarness({ verifyIdentity: verifyA });
      await rejected.run({ op: "unregister", token });
      expect(rejected.unregistered).toEqual([]);
      expect(rejected.replies).toEqual([]);
    }
    const wrongSubject = makeHarness({ verifyIdentity: verifyA, subjectPeerId: "other-peer" });
    await wrongSubject.run({ op: "unregister", token: valid });
    expect(wrongSubject.unregistered).toEqual([]);
    expect(wrongSubject.replies).toEqual([]);

    for (const verifyIdentity of [
      async () => null,
      async () => { throw new TransientVerifyError("JWKS unavailable"); },
    ]) {
      const rejected = makeHarness({ verifyIdentity });
      await rejected.run({ op: "unregister", token: valid });
      expect(rejected.unregistered).toEqual([]);
      expect(rejected.replies).toEqual([]);
    }
  });

  it("maps a real verifier JWKS outage to 503, bad tokens to 401, and keeps unregister silent", async () => {
    const token = await signRealToken({ aud: ACCOUNT_A, tenant: TENANT, sub: PEER });
    const transientAuth = resolveVerifierConfig({
      strategy: "jwt",
      jwt: { issuer: REAL_ISSUER, jwksUrl: "https://issuer.example/unavailable-jwks" },
    });
    const unavailable = createAccountJwtVerifier(
      { auth: transientAuth, accountId: ACCOUNT_A },
      { fetchImpl: (async () => { throw new Error("network down"); }) as typeof fetch },
    ).verifyIdentity;
    for (const op of ["challenge", "register"] as const) {
      const h = makeHarness({ verifyIdentity: unavailable, requirePoP: false });
      await h.run({ op, token });
      expect(h.replies).toEqual([REGISTER_UNAVAILABLE]);
      expect(h.registered).toEqual([]);
    }
    const unavailableUnregister = makeHarness({ verifyIdentity: unavailable });
    await unavailableUnregister.run({ op: "unregister", token });
    expect(unavailableUnregister.replies).toEqual([]);
    expect(unavailableUnregister.unregistered).toEqual([]);

    const ordinary = await realVerifier(ACCOUNT_A);
    for (const op of ["challenge", "register"] as const) {
      const h = makeHarness({ verifyIdentity: ordinary, requirePoP: false });
      await h.run({ op, token: "ordinary-bad-token" });
      expect(h.replies).toEqual([REGISTER_UNAUTHORIZED]);
      expect(h.registered).toEqual([]);
    }
    const ordinaryUnregister = makeHarness({ verifyIdentity: ordinary });
    await ordinaryUnregister.run({ op: "unregister", token: "ordinary-bad-token" });
    expect(ordinaryUnregister.replies).toEqual([]);
    expect(ordinaryUnregister.unregistered).toEqual([]);
  });

  it("binds one multi-aud token to each target's own authenticated pin/wrap", async () => {
    const device = generateX25519KeyPair();
    const agentA = generateX25519KeyPair();
    const agentB = generateX25519KeyPair();
    const keyA = randomBytes(32);
    const keyB = randomBytes(32);
    const cnf = {
      jwk: { kty: "OKP", crv: "X25519", x: Buffer.from(device.publicKey).toString("base64url") },
    };
    const token = await signRealToken({
      aud: [ACCOUNT_A, ACCOUNT_B],
      tenant: TENANT,
      sub: PEER,
      cnf,
    });

    const target = async (
      accountId: string,
      conversationKey: Uint8Array,
      agentIdentity: ReturnType<typeof generateX25519KeyPair>,
    ) => {
      const h = makeHarness({
        verifyIdentity: await realVerifier(accountId),
        requirePoP: false,
        wrap: (_peerId, devicePublicKey) => wrapConversationKey(
          conversationKey,
          devicePublicKey,
          { agentIdentityKeyPair: agentIdentity, peerId: PEER },
        ),
      });
      await h.run({ op: "register", token });
      expect(h.registered).toEqual([PEER]);
      return (JSON.parse(h.replies[0]) as { wrappedConversationKey: WrappedConversationKey })
        .wrappedConversationKey;
    };

    const wrappedA = await target(ACCOUNT_A, keyA, agentA);
    const wrappedB = await target(ACCOUNT_B, keyB, agentB);
    expect(unwrapConversationKey(wrappedA, device.privateKey, {
      agentPublicKey: agentA.publicKey,
      peerId: PEER,
    })).toEqual(new Uint8Array(keyA));
    expect(unwrapConversationKey(wrappedB, device.privateKey, {
      agentPublicKey: agentB.publicKey,
      peerId: PEER,
    })).toEqual(new Uint8Array(keyB));
    expect(() => unwrapConversationKey(wrappedB, device.privateKey, {
      agentPublicKey: agentA.publicKey,
      peerId: PEER,
    })).toThrow();

    const nonMember = await signRealToken({ aud: "account-c", tenant: TENANT, sub: PEER, cnf });
    const rejected = makeHarness({
      verifyIdentity: await realVerifier(ACCOUNT_A),
      requirePoP: false,
    });
    await rejected.run({ op: "register", token: nonMember });
    expect(rejected.replies).toEqual([REGISTER_UNAUTHORIZED]);
    expect(rejected.registered).toEqual([]);
    expect(rejected.wrapCalls).toEqual([]);
    expect(rejected.snapshots).toEqual([]);
    expect(rejected.approvalSnapshots).toEqual([]);
  });
});
