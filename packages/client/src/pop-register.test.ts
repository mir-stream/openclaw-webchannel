/**
 * PoP producer ↔ consumer interop tests.
 *
 * The fake agent verifies the device's signature with node:crypto EXACTLY as the
 * real plugin does (`pop-challenge.ts` →
 * `edVerify(null, popSignedMessage(peerId, nonce), pubFromJwk, sig)`), so a green
 * `registerWithPop` here proves the browser producer satisfies the real verifier.
 * The HTTP transport is gone — registration now rides a `request(payload)` NATS
 * request/reply seam, so the fake is a request handler, not a fetch mock.
 */

import { describe, it, expect } from "vitest";
import { createPublicKey, verify as edVerify } from "node:crypto";

import {
  generateDevicePopKeyPair,
  popSignedMessage,
  signPop,
  registerWithPop,
  isTerminalRegisterError,
  PopCapacityError,
  PopRejectedError,
  ProtocolMismatchError,
  type DevicePopJwk,
  type RegisterRequestFn,
} from "./pop-register.js";
import { WEBCHANNEL_PROTOCOL_VERSION } from "./protocol.js";

/**
 * Faithful replica of the plugin's register handler over the request/reply seam:
 * `{op:"challenge"}` issues a single-use nonce, `{op:"register"}` verifies the
 * Ed25519 signature over `webchannel-pop:<peerId>:<nonce>` against `serverPopJwk`
 * — the same check `PopChallengeStore.verify` runs. A used nonce is single-use.
 */
function makeFakeAgent(opts: { peerId: string; serverPopJwk: DevicePopJwk }) {
  let issuedNonce: string | null = null;
  const calls = { challenge: 0, register: 0 };
  const seen: { token?: string; nonce?: string; signature?: string } = {};

  const request: RegisterRequestFn = async (payload) => {
    const body = payload as { op?: string; token?: string; nonce?: string; signature?: string };
    if (body.op === "challenge") {
      calls.challenge++;
      seen.token = body.token;
      issuedNonce = `nonce-${calls.challenge}-${Buffer.from([calls.challenge, 7, 42]).toString("hex")}`;
      return { nonce: issuedNonce };
    }
    if (body.op === "register") {
      calls.register++;
      seen.nonce = body.nonce;
      seen.signature = body.signature;
      // single-use nonce
      if (!issuedNonce || body.nonce !== issuedNonce) return { error: "unauthorized", code: 401 };
      const nonce = issuedNonce;
      issuedNonce = null;
      const pub = createPublicKey({ key: opts.serverPopJwk, format: "jwk" });
      const ok = edVerify(
        null,
        Buffer.from(popSignedMessage(opts.peerId, nonce), "utf8"),
        pub,
        Buffer.from(String(body.signature), "base64url"),
      );
      return ok
        ? { peerId: opts.peerId, registered: true, protocolVersion: WEBCHANNEL_PROTOCOL_VERSION }
        : { error: "unauthorized", code: 401 };
    }
    return { error: "unauthorized", code: 401 };
  };

  return { request, calls, seen };
}

const PEER = "user-42";

describe("registerWithPop (producer ↔ consumer interop)", () => {
  it("registers when the device signs with the key pinned in pop_jwk", async () => {
    const device = await generateDevicePopKeyPair();
    const agent = makeFakeAgent({ peerId: PEER, serverPopJwk: device.publicJwk });

    const result = await registerWithPop({
      request: agent.request,
      jwt: "bootstrap.jwt.token",
      peerId: PEER,
      devicePrivateKey: device.privateKey,
    });

    expect(result).toEqual({ peerId: PEER, registered: true, protocolVersion: WEBCHANNEL_PROTOCOL_VERSION });
    expect(agent.calls).toEqual({ challenge: 1, register: 1 });
    expect(agent.seen.token).toBe("bootstrap.jwt.token");
    expect(typeof agent.seen.signature).toBe("string");
  });

  it("is rejected (401 → PopRejectedError) when signing with the wrong device key", async () => {
    const pinned = await generateDevicePopKeyPair();
    const attacker = await generateDevicePopKeyPair();
    // Server pins `pinned`'s public key, but the caller signs with `attacker`.
    const agent = makeFakeAgent({ peerId: PEER, serverPopJwk: pinned.publicJwk });

    await expect(
      registerWithPop({
        request: agent.request,
        jwt: "jwt",
        peerId: PEER,
        devicePrivateKey: attacker.privateKey,
      }),
    ).rejects.toBeInstanceOf(PopRejectedError);
  });

  it("throws PopRejectedError when the challenge returns an error reply (bad JWT)", async () => {
    const device = await generateDevicePopKeyPair();
    const request: RegisterRequestFn = async () => ({ error: "unauthorized", code: 401 });
    await expect(
      registerWithPop({
        request,
        jwt: "jwt",
        peerId: PEER,
        devicePrivateKey: device.privateKey,
      }),
    ).rejects.toBeInstanceOf(PopRejectedError);
  });

  it("classifies an authenticated protocol-mismatch 426 as a typed terminal error", async () => {
    const device = await generateDevicePopKeyPair();
    const request: RegisterRequestFn = async (payload) =>
      (payload as { op?: string }).op === "challenge"
        ? { nonce: "nonce" }
        : {
            error: "protocol_mismatch",
            code: 426,
            protocolVersion: WEBCHANNEL_PROTOCOL_VERSION,
          };
    const error = await registerWithPop({
      request,
      jwt: "jwt",
      peerId: PEER,
      devicePrivateKey: device.privateKey,
      retries: 0,
    }).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ProtocolMismatchError);
    expect((error as ProtocolMismatchError).advertisedVersion).toBe(WEBCHANNEL_PROTOCOL_VERSION);
  });

  it("retries the whole unit on a lost reply (request timeout) and recovers", async () => {
    // Model a dropped register reply: the FIRST register round-trip times out
    // (throws), so registerWithPop must restart from a fresh challenge and
    // succeed on the second attempt (server register is idempotent).
    const device = await generateDevicePopKeyPair();
    const agent = makeFakeAgent({ peerId: PEER, serverPopJwk: device.publicJwk });
    let registerAttempts = 0;
    const request: RegisterRequestFn = async (payload) => {
      const body = payload as { op?: string };
      if (body.op === "register") {
        registerAttempts++;
        if (registerAttempts === 1) throw new Error("[nats-client] request timeout");
      }
      return agent.request(payload);
    };

    const result = await registerWithPop({
      request,
      jwt: "jwt",
      peerId: PEER,
      devicePrivateKey: device.privateKey,
    });

    expect(result).toEqual({ peerId: PEER, registered: true, protocolVersion: WEBCHANNEL_PROTOCOL_VERSION });
    // Two challenges (fresh nonce per attempt), two register round-trips.
    expect(agent.calls.challenge).toBe(2);
    expect(registerAttempts).toBe(2);
  });

  it("retries a transient 503 at register (like a timeout) and recovers", async () => {
    // A transient infra fault (agent's JWKS unreachable) replies 503; the client
    // must RETRY it (not treat it as terminal) and succeed once it clears.
    const device = await generateDevicePopKeyPair();
    const agent = makeFakeAgent({ peerId: PEER, serverPopJwk: device.publicJwk });
    let registerAttempts = 0;
    const request: RegisterRequestFn = async (payload) => {
      const body = payload as { op?: string };
      if (body.op === "register") {
        registerAttempts++;
        if (registerAttempts === 1) return { error: "unavailable", code: 503 };
      }
      return agent.request(payload);
    };

    const result = await registerWithPop({
      request,
      jwt: "jwt",
      peerId: PEER,
      devicePrivateKey: device.privateKey,
    });

    expect(result).toEqual({ peerId: PEER, registered: true, protocolVersion: WEBCHANNEL_PROTOCOL_VERSION });
    expect(registerAttempts).toBe(2); // first 503 retried, second succeeds
  });

  it("retries a transient 503 at challenge (like a timeout) and recovers", async () => {
    const device = await generateDevicePopKeyPair();
    const agent = makeFakeAgent({ peerId: PEER, serverPopJwk: device.publicJwk });
    let challengeAttempts = 0;
    const request: RegisterRequestFn = async (payload) => {
      const body = payload as { op?: string };
      if (body.op === "challenge") {
        challengeAttempts++;
        if (challengeAttempts === 1) return { error: "unavailable", code: 503 };
      }
      return agent.request(payload);
    };

    const result = await registerWithPop({
      request,
      jwt: "jwt",
      peerId: PEER,
      devicePrivateKey: device.privateKey,
    });

    expect(result).toEqual({ peerId: PEER, registered: true, protocolVersion: WEBCHANNEL_PROTOCOL_VERSION });
    expect(challengeAttempts).toBe(2);
  });

  it("a 503 at register that never clears exhausts retries and throws (not PopRejected)", async () => {
    const device = await generateDevicePopKeyPair();
    const agent = makeFakeAgent({ peerId: PEER, serverPopJwk: device.publicJwk });
    const request: RegisterRequestFn = async (payload) => {
      const body = payload as { op?: string };
      if (body.op === "register") return { error: "unavailable", code: 503 };
      return agent.request(payload);
    };
    await expect(
      registerWithPop({
        request,
        jwt: "jwt",
        peerId: PEER,
        devicePrivateKey: device.privateKey,
        retries: 1,
      }),
    ).rejects.not.toBeInstanceOf(PopRejectedError);
  });

  it("classifies the exact 507 capacity reply as terminal without retrying", async () => {
    const device = await generateDevicePopKeyPair();
    const agent = makeFakeAgent({ peerId: PEER, serverPopJwk: device.publicJwk });
    let registerAttempts = 0;
    const request: RegisterRequestFn = async (payload) => {
      const body = payload as { op?: string };
      if (body.op === "register") {
        registerAttempts++;
        return { error: "capacity_exceeded", code: 507 };
      }
      return agent.request(payload);
    };

    const error = await registerWithPop({
      request,
      jwt: "jwt",
      peerId: PEER,
      devicePrivateKey: device.privateKey,
      retries: 5,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PopCapacityError);
    expect(isTerminalRegisterError(error)).toBe(true);
    expect(agent.calls.challenge).toBe(1);
    expect(registerAttempts).toBe(1);
  });

  it("throws after exhausting retries when every round-trip times out", async () => {
    const device = await generateDevicePopKeyPair();
    const request: RegisterRequestFn = async () => {
      throw new Error("[nats-client] request timeout");
    };
    await expect(
      registerWithPop({
        request,
        jwt: "jwt",
        peerId: PEER,
        devicePrivateKey: device.privateKey,
        retries: 1,
      }),
    ).rejects.toThrow(/timeout/);
  });
});

describe("PoP spec conformance (must match plugin pop-challenge.ts)", () => {
  it("signs the bound message `webchannel-pop:<peerId>:<nonce>`", () => {
    expect(popSignedMessage("p", "n")).toBe("webchannel-pop:p:n");
  });

  it("produces an Ed25519 signature verifiable over the bound message", async () => {
    const device = await generateDevicePopKeyPair();
    const sig = await signPop(device.privateKey, PEER, "the-nonce");
    const pub = createPublicKey({ key: device.publicJwk, format: "jwk" });
    const ok = edVerify(
      null,
      Buffer.from(popSignedMessage(PEER, "the-nonce"), "utf8"),
      pub,
      Buffer.from(sig, "base64url"),
    );
    expect(ok).toBe(true);

    // A signature over a different nonce must NOT verify (replay/tamper guard).
    const bad = edVerify(
      null,
      Buffer.from(popSignedMessage(PEER, "other-nonce"), "utf8"),
      pub,
      Buffer.from(sig, "base64url"),
    );
    expect(bad).toBe(false);
  });

  it("exports an OKP/Ed25519 public JWK with a 32-byte x", async () => {
    const device = await generateDevicePopKeyPair();
    expect(device.publicJwk.kty).toBe("OKP");
    expect(device.publicJwk.crv).toBe("Ed25519");
    expect(Buffer.from(device.publicJwk.x, "base64url").length).toBe(32);
  });
});
