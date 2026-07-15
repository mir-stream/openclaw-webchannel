import { describe, it, expect, vi, afterEach, beforeAll } from "vitest";
import { webcrypto } from "node:crypto";

import {
  assertJwtAuthConfig,
  preflightResolveJwks,
  verifyJwtAndExtractIdentity,
  type AuthConfig,
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
    const authConfig: AuthConfig = {
      strategy: "jwt",
      jwt: { issuer: ISSUER, audience: AUDIENCE, jwks: rotatedAwayJwks },
    };

    await expect(verifyJwtAndExtractIdentity(token, authConfig)).resolves.toBeNull();
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
    const authConfig: AuthConfig = {
      strategy: "jwt",
      jwt: {
        issuer: ISSUER,
        audience: AUDIENCE,
        jwksUrl: "https://idp.test/jwks.json",
        _fetchImpl: impl,
      },
    };

    assertJwtAuthConfig(authConfig);
    await preflightResolveJwks(authConfig);
    const first = await verifyJwtAndExtractIdentity(token, authConfig);
    const second = await verifyJwtAndExtractIdentity(token, authConfig);
    const third = await verifyJwtAndExtractIdentity(token, authConfig);

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
    const configA: AuthConfig = {
      strategy: "jwt",
      jwt: { issuer: ISSUER, audience: AUDIENCE, jwksUrl: "https://idp.test/jwks.json", _fetchImpl: a.impl },
    };
    const configB: AuthConfig = {
      strategy: "jwt",
      jwt: { issuer: ISSUER, audience: AUDIENCE, jwksUrl: "https://idp.test/jwks.json", _fetchImpl: b.impl },
    };

    await verifyJwtAndExtractIdentity(token, configA);
    await verifyJwtAndExtractIdentity(token, configB);

    // Each account's config keys its own cache — one fetch apiece, no bleed.
    expect(a.count()).toBe(1);
    expect(b.count()).toBe(1);
  });
});

// NOTE (Phase 6 / W7): the "S2 — pinned device key store is bounded" suite is
// gone with the pin store itself (see auth.ts) — the register route wraps the
// conversation key per-request from `identity.devicePublicKey`; there is no
// module-global key store left to bound.
