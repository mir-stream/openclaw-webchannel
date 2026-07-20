import { describe, it, expect } from "vitest";
import { generateKeyPairSync, sign as edSign, type JsonWebKey } from "node:crypto";
import { popRequirementUnmet } from "./register-pop-gate.js";
import { resolveWebchannelAccountConfig } from "./account-config.js";
import { PopChallengeStore, popSignedMessage, type PopPublicJwk } from "./pop-challenge.js";

/**
 * These tests model the register route's admission decision (index-nats.ts):
 *
 *   if (popRequirementUnmet(Boolean(identity.popPublicJwk))) -> 401
 *   else if (identity.popPublicJwk) { verify signed nonce or 401 }
 *   // otherwise register the peer
 *
 * P0-3 D6-5: PoP is now UNCONDITIONALLY required — the `auth.requirePoP` opt-out
 * was removed (a present value reaches a fatal migration error at config load).
 * So the gate reduces to "reject any verified JWT that carries no pop_jwk", and
 * the former opt-out scenarios are migration-error tests below.
 */

function makeDevice(): { popPublicJwk: PopPublicJwk; sign: (msg: string) => string } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" }) as JsonWebKey & { x: string };
  return {
    popPublicJwk: { kty: jwk.kty!, crv: (jwk as { crv: string }).crv, x: jwk.x },
    sign: (msg: string) => edSign(null, Buffer.from(msg, "utf8"), privateKey).toString("base64url"),
  };
}

describe("popRequirementUnmet — PoP is unconditionally required (P0-3 D6-5)", () => {
  it("a verified JWT with NO pop_jwk is REJECTED (401)", () => {
    // identity.popPublicJwk absent → hasPopJwk=false → route responds 401.
    expect(popRequirementUnmet(false)).toBe(true);
  });

  it("a JWT WITH pop_jwk + valid PoP is accepted", () => {
    const dev = makeDevice();
    // The gate does not reject (pop_jwk present) …
    expect(popRequirementUnmet(true)).toBe(false);
    // … and the existing signed-nonce verification then succeeds → peer registered.
    const store = new PopChallengeStore();
    const nonce = store.issue("alice");
    const sig = dev.sign(popSignedMessage("alice", nonce));
    expect(
      store.verify({ peerId: "alice", nonce, signatureB64Url: sig, popPublicJwk: dev.popPublicJwk }),
    ).toEqual({ ok: true, reason: "verified" });
  });
});

describe("auth.requirePoP opt-out is REMOVED → fatal migration error (P0-3 D6-5)", () => {
  const migration = /removed config auth\.requirePoP.*Proof-of-Possession is now ALWAYS required/s;

  it("a present requirePoP:false (the legacy opt-out) is a fatal migration error", () => {
    const cfg = { channels: { webchannel: { auth: { strategy: "jwt", requirePoP: false } } } };
    expect(() => resolveWebchannelAccountConfig(cfg)).toThrow(migration);
  });

  it("a present requirePoP:true is ALSO rejected (no stale toggle may linger)", () => {
    const cfg = { channels: { webchannel: { auth: { strategy: "jwt", requirePoP: true } } } };
    expect(() => resolveWebchannelAccountConfig(cfg)).toThrow(migration);
  });

  it("an account with NO requirePoP resolves cleanly", () => {
    const cfg = { channels: { webchannel: { auth: { strategy: "jwt" } } } };
    expect(() => resolveWebchannelAccountConfig(cfg)).not.toThrow();
  });
});
