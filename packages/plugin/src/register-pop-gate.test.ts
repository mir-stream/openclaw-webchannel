import { describe, it, expect } from "vitest";
import { generateKeyPairSync, sign as edSign, type JsonWebKey } from "node:crypto";
import { resolveRequirePoP, popRequirementUnmet } from "./register-pop-gate.js";
import { PopChallengeStore, popSignedMessage, type PopPublicJwk } from "./pop-challenge.js";

/**
 * These tests model the register route's admission decision (index-nats.ts):
 *
 *   const requirePoP = resolveRequirePoP(live.auth);
 *   if (popRequirementUnmet(requirePoP, Boolean(identity.popPublicJwk))) -> 401
 *   else if (identity.popPublicJwk) { verify signed nonce or 401 }
 *   // otherwise register the peer
 *
 * They prove the three Item-1d scenarios: default rejects a no-pop_jwk JWT,
 * a pop_jwk JWT with a valid PoP is accepted, and requirePoP:false restores the
 * legacy "no-pop is accepted" behavior.
 */

function makeDevice(): { popPublicJwk: PopPublicJwk; sign: (msg: string) => string } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" }) as JsonWebKey & { x: string };
  return {
    popPublicJwk: { kty: jwk.kty!, crv: (jwk as { crv: string }).crv, x: jwk.x },
    sign: (msg: string) => edSign(null, Buffer.from(msg, "utf8"), privateKey).toString("base64url"),
  };
}

describe("resolveRequirePoP — secure-by-default", () => {
  it("defaults to TRUE when auth is undefined", () => {
    expect(resolveRequirePoP(undefined)).toBe(true);
  });
  it("defaults to TRUE when requirePoP is unset", () => {
    expect(resolveRequirePoP({})).toBe(true);
  });
  it("honors an explicit false", () => {
    expect(resolveRequirePoP({ requirePoP: false })).toBe(false);
  });
  it("honors an explicit true", () => {
    expect(resolveRequirePoP({ requirePoP: true })).toBe(true);
  });
});

describe("register PoP gate (Item 1)", () => {
  it("requirePoP default → a verified JWT with NO pop_jwk is REJECTED (401)", () => {
    const requirePoP = resolveRequirePoP(undefined); // default true
    // identity.popPublicJwk is undefined → hasPopJwk=false
    expect(popRequirementUnmet(requirePoP, false)).toBe(true); // → route responds 401
  });

  it("requirePoP default → a JWT WITH pop_jwk + valid PoP is accepted", () => {
    const requirePoP = resolveRequirePoP(undefined); // default true
    const dev = makeDevice();
    // The gate does not reject (pop_jwk present) …
    expect(popRequirementUnmet(requirePoP, true)).toBe(false);
    // … and the existing signed-nonce verification then succeeds → peer registered.
    const store = new PopChallengeStore();
    const nonce = store.issue("alice");
    const sig = dev.sign(popSignedMessage("alice", nonce));
    expect(
      store.verify({ peerId: "alice", nonce, signatureB64Url: sig, popPublicJwk: dev.popPublicJwk }),
    ).toEqual({ ok: true, reason: "verified" });
  });

  it("requirePoP:false → a JWT with NO pop_jwk is accepted (legacy back-compat)", () => {
    const requirePoP = resolveRequirePoP({ requirePoP: false }); // explicit opt-out
    expect(popRequirementUnmet(requirePoP, false)).toBe(false); // → not rejected, peer registered
  });
});
