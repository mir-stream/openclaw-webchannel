/**
 * Bootstrap claim builder tests — the SaaS PoP producer side.
 */

import { describe, it, expect } from "vitest";

import { buildBootstrapClaims } from "./bootstrap-claims.js";

const X25519 = Buffer.alloc(32, 1).toString("base64url");
const ED25519 = Buffer.alloc(32, 2).toString("base64url");

const base = {
  iss: "https://saas.example",
  peerId: "user-7",
  accountId: "agent-1",
  tenant: "acme",
  deviceX25519PublicKey: X25519,
  nowSeconds: 1_000_000,
};

describe("buildBootstrapClaims", () => {
  it("emits cnf.jwk (X25519) and pop_jwk (Ed25519) when both keys are given", () => {
    const claims = buildBootstrapClaims({ ...base, devicePopPublicKey: ED25519 });
    expect(claims.cnf).toEqual({ jwk: { kty: "OKP", crv: "X25519", x: X25519 } });
    expect(claims.pop_jwk).toEqual({ kty: "OKP", crv: "Ed25519", x: ED25519 });
    expect(claims.sub).toBe("user-7");
    expect(claims.aud).toBe("agent-1");
    expect(claims.iat).toBe(1_000_000);
    expect(claims.exp).toBe(1_000_300); // default 300s ttl
  });

  it("omits pop_jwk when no PoP key is supplied (legacy bootstrap)", () => {
    const claims = buildBootstrapClaims(base);
    expect(claims.cnf.jwk.crv).toBe("X25519");
    expect(claims.pop_jwk).toBeUndefined();
  });

  it("honours an explicit ttl", () => {
    const claims = buildBootstrapClaims({ ...base, ttlSeconds: 60 });
    expect(claims.exp).toBe(1_000_060);
  });

  it("rejects keys that do not decode to 32 bytes", () => {
    expect(() => buildBootstrapClaims({ ...base, deviceX25519PublicKey: "short" })).toThrow(/32-byte/);
    expect(() =>
      buildBootstrapClaims({ ...base, devicePopPublicKey: Buffer.alloc(16).toString("base64url") }),
    ).toThrow(/devicePopPublicKey/);
  });

  it("requires a peerId", () => {
    expect(() => buildBootstrapClaims({ ...base, peerId: "" })).toThrow(/peerId/);
  });

  it("scalar accountId keeps the byte-for-byte behaviour: aud === accountId === id", () => {
    const claims = buildBootstrapClaims(base);
    expect(claims.aud).toBe("agent-1");
    expect(claims.accountId).toBe("agent-1");
  });

  it("array accountId mints a multi-audience token with a dead (empty) top-level accountId", () => {
    const claims = buildBootstrapClaims({ ...base, accountId: ["agent-dev", "agent-ops"] });
    expect(claims.aud).toEqual(["agent-dev", "agent-ops"]);
    // The top-level accountId is a dead claim; multi-aud has no single primary → "".
    expect(claims.accountId).toBe("");
  });

  it("a single-element array still yields an array aud (multi form), not a scalar", () => {
    const claims = buildBootstrapClaims({ ...base, accountId: ["agent-dev"] });
    expect(claims.aud).toEqual(["agent-dev"]);
    expect(claims.accountId).toBe("");
  });

  it("rejects an empty accountId array", () => {
    expect(() => buildBootstrapClaims({ ...base, accountId: [] })).toThrow(/non-empty/);
  });
});
