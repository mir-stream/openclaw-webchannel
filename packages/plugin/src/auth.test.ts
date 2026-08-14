import { describe, it, expect, vi, afterEach, beforeAll } from "vitest";
import { webcrypto } from "node:crypto";

import {
  createAccountJwtVerifier,
  resolveRequirePoPPolicy,
  resolveVerifierConfig,
} from "./auth.js";
import type { JsonWebKeySet } from "./jwks.js";

// ── jwt strategy tests (AC1–AC3) ──────────────────────────────────────────────

let rsaPrivateKey: webcrypto.CryptoKey;
let rsaJwks: JsonWebKeySet;
const ISSUER = "https://idp.test/";
const AUDIENCE = "webchannel-test";

async function ensureRsaKeys(): Promise<void> {
  if (rsaPrivateKey) return;
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
  rsaPrivateKey = pair.privateKey;
  const jwk = await webcrypto.subtle.exportKey("jwk", pair.publicKey);
  rsaJwks = {
    keys: [{ ...jwk, kid: "test-kid", alg: "RS256", use: "sig" }],
  };
}

function b64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj), "utf8").toString("base64url");
}

async function signRs256(payload: Record<string, unknown>): Promise<string> {
  await ensureRsaKeys();
  const header = b64url({ alg: "RS256", typ: "JWT", kid: "test-kid" });
  const p = b64url(payload);
  const signingInput = `${header}.${p}`;
  const sig = await webcrypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    rsaPrivateKey,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${Buffer.from(sig).toString("base64url")}`;
}

describe("fail-closed when the signing kid is unknown/evicted", () => {
  beforeAll(async () => {
    await ensureRsaKeys();
  });

  it("returns null (not throws) so the register route yields a clean 401, not a 500", async () => {
    // A JWKS that has been rotated away from the token's kid: the resolver throws
    // on the kid miss (fail-closed). verifyJwtAndExtractIdentity must translate
    // that throw into a null verdict — an unknown/evicted kid is an auth failure
    // (401), not a server fault (500). Mirrors JWKS key eviction in the demo.
    const now = Math.floor(Date.now() / 1000);
    const token = await signRs256({ iss: ISSUER, aud: AUDIENCE, sub: "user-evicted", iat: now, exp: now + 60 });
    const rotatedAwayJwks: JsonWebKeySet = { keys: [{ ...rsaJwks.keys[0]!, kid: "some-other-kid" }] };
    const authConfig = resolveVerifierConfig({
      strategy: "jwt",
      jwt: { issuer: ISSUER, jwks: rotatedAwayJwks },
    });

    await expect(createAccountJwtVerifier({ auth: authConfig, accountId: AUDIENCE }).verifyIdentity(token)).resolves.toBeNull();
  });

  it("cannot forge a second log record through an unauthenticated kid", async () => {
    const forgedKid = "missing\nwebchannel: JWT verified for peerId=admin";
    const token = [
      b64url({ alg: "RS256", typ: "JWT", kid: forgedKid }),
      b64url({}),
      Buffer.from([0]).toString("base64url"),
    ].join(".");
    const auth = resolveVerifierConfig({
      strategy: "jwt",
      jwt: { issuer: ISSUER, jwks: rsaJwks },
    });
    const error = vi.fn();

    await expect(
      createAccountJwtVerifier({ auth, accountId: AUDIENCE, logger: { error } }).verifyIdentity(token),
    ).resolves.toBeNull();

    expect(error).toHaveBeenCalledTimes(1);
    const record = String(error.mock.calls[0]?.[0]);
    expect(record.split("\n")).toHaveLength(1);
    expect(record).not.toContain("\n");
    expect(record).toContain("missing\\nwebchannel: JWT verified for peerId=admin");
  });
});

describe("S3 — JWKS cache is hoisted per account (no per-request refetch)", () => {
  beforeAll(async () => {
    await ensureRsaKeys();
  });

  /** A JWKS-URL fetch impl that counts how many times the IdP is hit. */
  function countingFetch(): { impl: typeof fetch; count: () => number } {
    let calls = 0;
    const impl = (async () => {
      calls += 1;
      return {
        ok: true,
        status: 200,
        json: async () => rsaJwks,
      } as unknown as Response;
    }) as unknown as typeof fetch;
    return { impl, count: () => calls };
  }

  it("reuses one cache across register/challenge calls sharing the same auth config", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await signRs256({
      iss: ISSUER,
      aud: AUDIENCE,
      sub: "user-cache",
      iat: now,
      exp: now + 60,
    });
    const { impl, count } = countingFetch();
    // One stable config object == one account. The live NATS path calls
    // verifyJwtAndExtractIdentity per pairing with THIS same object.
    const authConfig = resolveVerifierConfig({
      strategy: "jwt",
      jwt: {
        issuer: ISSUER,
        jwksUrl: "https://idp.test/jwks.json",
      },
    });

    const verifier = createAccountJwtVerifier(
      { auth: authConfig, accountId: AUDIENCE },
      { fetchImpl: impl },
    );
    await verifier.warmJwks();
    const first = await verifier.verifyIdentity(token);
    const second = await verifier.verifyIdentity(token);
    const third = await verifier.verifyIdentity(token);

    expect(first?.peerId).toBe("user-cache");
    expect(second?.peerId).toBe("user-cache");
    expect(third?.peerId).toBe("user-cache");
    // Before S3 every call rebuilt an empty cache → 3 fetches. Now the TTL is
    // honored across calls: the IdP is hit exactly once.
    expect(count()).toBe(1);
  });

  it("keeps a separate cache per distinct auth config object (accounts don't share)", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await signRs256({
      iss: ISSUER,
      aud: AUDIENCE,
      sub: "user-b",
      iat: now,
      exp: now + 60,
    });
    const a = countingFetch();
    const b = countingFetch();
    const configA = resolveVerifierConfig({
      strategy: "jwt",
      jwt: { issuer: ISSUER, jwksUrl: "https://idp.test/jwks.json" },
    });
    const configB = resolveVerifierConfig({
      strategy: "jwt",
      jwt: { issuer: ISSUER, jwksUrl: "https://idp.test/jwks.json" },
    });

    await createAccountJwtVerifier({ auth: configA, accountId: AUDIENCE }, { fetchImpl: a.impl }).verifyIdentity(token);
    await createAccountJwtVerifier({ auth: configB, accountId: AUDIENCE }, { fetchImpl: b.impl }).verifyIdentity(token);

    // Each account's config keys its own cache — one fetch apiece, no bleed.
    expect(a.count()).toBe(1);
    expect(b.count()).toBe(1);
  });
});

describe("account-bound audience", () => {
  it("accepts a token only in the verifier whose runtime accountId is in aud", async () => {
    await ensureRsaKeys();
    const now = Math.floor(Date.now() / 1000);
    const token = await signRs256({
      iss: ISSUER,
      aud: ["account-a", "another-service"],
      sub: "user-a",
      iat: now,
      exp: now + 60,
    });
    const auth = resolveVerifierConfig({
      strategy: "jwt",
      jwt: { issuer: ISSUER, jwks: rsaJwks },
    });

    await expect(createAccountJwtVerifier({ auth, accountId: "account-a" }).verifyIdentity(token))
      .resolves.toMatchObject({ peerId: "user-a" });
    await expect(createAccountJwtVerifier({ auth, accountId: "account-b" }).verifyIdentity(token))
      .resolves.toBeNull();
  });
});

describe("cache-free verifier preparation", () => {
  it.each([null, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "60", [], {}])(
    "rejects invalid clockSkew %j",
    (clockSkew) => {
      expect(() => resolveVerifierConfig({
        strategy: "jwt",
        jwt: { issuer: ISSUER, jwks: { keys: [] }, clockSkew },
      })).toThrow(/clockSkew/);
    },
  );

  it("requires exactly one structurally valid JWKS source", () => {
    expect(() => resolveVerifierConfig({
      strategy: "jwt",
      jwt: { issuer: ISSUER },
    })).toThrow(/exactly one/);
    expect(() => resolveVerifierConfig({
      strategy: "jwt",
      jwt: { issuer: ISSUER, jwksUrl: "https://keys", jwks: { keys: [] } },
    })).toThrow(/exactly one/);
    expect(() => resolveVerifierConfig({
      strategy: "jwt",
      jwt: { issuer: ISSUER, jwks: { keys: "not-an-array" } },
    })).toThrow(/keys array/);
  });

  it("rejects a cast-reintroduced audience and returns an immutable detached config", () => {
    expect(() => resolveVerifierConfig({
      strategy: "jwt",
      jwt: { issuer: ISSUER, jwks: { keys: [] }, audience: "legacy" },
    })).toThrow(/audience was removed/);

    const rawJwks = { keys: [{ kid: "one" }] };
    const resolved = resolveVerifierConfig({
      strategy: "jwt",
      jwt: { issuer: ISSUER, jwks: rawJwks },
    });
    rawJwks.keys.push({ kid: "two" });
    expect(resolved.jwt.jwks?.keys).toEqual([{ kid: "one" }]);
    expect(Object.isFrozen(resolved)).toBe(true);
    expect(Object.isFrozen(resolved.jwt)).toBe(true);
    expect(Object.isFrozen(resolved.jwt.jwks)).toBe(true);
    expect(Object.isFrozen(resolved.jwt.jwks?.keys)).toBe(true);
  });

  it.each([null, 0, 1, "false", [], {}])(
    "rejects invalid requirePoP %j instead of applying truthiness",
    (requirePoP) => {
      expect(() => resolveRequirePoPPolicy({ requirePoP })).toThrow(/must be a boolean/);
    },
  );
  it("defaults requirePoP to true and accepts explicit false", () => {
    expect(resolveRequirePoPPolicy({})).toBe(true);
    expect(resolveRequirePoPPolicy({ requirePoP: false })).toBe(false);
  });
});

// NOTE (Phase 6 / W7): the "S2 — pinned device key store is bounded" suite is
// gone with the pin store itself (see auth.ts) — the register route wraps the
// conversation key per-request from `identity.devicePublicKey`; there is no
// module-global key store left to bound.
