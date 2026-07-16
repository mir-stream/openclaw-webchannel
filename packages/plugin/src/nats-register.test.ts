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

import { generateKeyPairSync, sign as edSign, randomBytes } from "node:crypto";
import { describe, it, expect } from "vitest";

import {
  handleRegisterRequest,
  REGISTER_UNAUTHORIZED,
  REGISTER_FAILED,
  REGISTER_UNAVAILABLE,
  type RegisterHandlerDeps,
} from "./nats-register.js";
import { PopChallengeStore, popSignedMessage } from "./pop-challenge.js";
import { TransientVerifyError } from "./auth.js";
import type { JwtIdentity } from "./jwt.js";
import type { WrappedConversationKey } from "./late-join-decryptor.js";
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
  auth?: unknown;
  verifyIdentity?: RegisterHandlerDeps["verifyIdentity"];
  registerPeer?: (peerId: string) => void;
}): Harness {
  const replies: string[] = [];
  const registered: string[] = [];
  const unregistered: string[] = [];
  const snapshots: string[] = [];
  const approvalSnapshots: string[] = [];
  const wrapCalls: Array<{ peerId: string; key: Uint8Array }> = [];
  const identity =
    opts && "identity" in opts
      ? opts.identity
      : ({ peerId: PEER, devicePublicKey: randomBytes(32).toString("base64url") } as JwtIdentity);

  const deps: RegisterHandlerDeps = {
    auth: (opts?.auth ?? { strategy: "jwt" }) as RegisterHandlerDeps["auth"],
    tenant: TENANT,
    subjectPeerId: opts?.subjectPeerId ?? PEER,
    payload: "",
    reply: (r) => replies.push(r),
    verifyIdentity: opts?.verifyIdentity ?? (async () => identity ?? null),
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
      auth: { strategy: "jwt", requirePoP: false },
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

  it("unregister with a VALID token tears down the verified peer, no reply", async () => {
    const h = makeHarness(); // default verifyIdentity returns identity{peerId:PEER}
    await h.run({ op: "unregister", token: "jwt" });
    expect(h.unregistered).toEqual([PEER]);
    expect(h.replies).toEqual([]); // fire-and-forget
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
      auth: { strategy: "jwt", jwt: { issuer: "iss", audience: "account-B" } },
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
