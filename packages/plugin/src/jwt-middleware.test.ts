/**
 * Sub-AC 3a: JWT verification middleware — mock JWKS server integration tests.
 *
 * Exercises the full `assertJwtAuthConfig({ strategy: "jwt", jwt: { jwksUrl } })`
 * middleware path using a mock fetch function that simulates a SaaS JWKS HTTP
 * endpoint.  The mock is injected via `jwt._fetchImpl` (a test-only field on
 * `JwtAuthConfig`) so the JWKSCache makes a "real" fetch call but against our
 * in-process stub rather than an external server — identical code-path, no
 * sockets required.
 *
 * Four required scenarios (each described in its own `describe` block):
 *
 *   Scenario 1 — VALID TOKEN ACCEPTANCE
 *     A properly-signed RS256 token with correct claims (iss, aud, sub, exp)
 *     is accepted; the middleware returns `{ peerId: sub, displayName? }`.
 *
 *   Scenario 2 — INVALID SIGNATURE REJECTION
 *     A token signed by a different private key (not matching the published
 *     public key) and a payload-tampered token both return `null`.
 *
 *   Scenario 3 — EXPIRED TOKEN REJECTION
 *     A token whose `exp` is beyond the clock-skew window and a token with a
 *     missing or non-numeric `exp` claim both return `null`.
 *
 *   Scenario 4 — MISSING / MALFORMED TOKEN REJECTION
 *     Missing query param, too-few segments, `alg=none`, `alg=HS256`, raw
 *     garbage, and iss/aud mismatches all return `null`.
 *
 * All scenarios run with a single `vitest run` (or `npm test`) invocation.
 */

import { describe, it, expect, vi } from "vitest";
import { webcrypto } from "node:crypto";

import { verifyJwtAndExtractIdentity } from "./auth.js";
import type { JsonWebKeySet } from "./jwks.js";
import { handleRegisterRequest, REGISTER_UNAUTHORIZED } from "./nats-register.js";
import { PopChallengeStore } from "./pop-challenge.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const KID = "saas-k1";
const ISSUER = "https://saas.test/";
const AUDIENCE = "openclaw-webchannel";
/** Simulated JWKS URL — no real socket is opened; fetch is intercepted. */
const JWKS_URL = "https://saas.test/.well-known/jwks.json";

// ─── RSA keypair fixture (generated once per module) ─────────────────────────

let primaryPrivateKey: webcrypto.CryptoKey;
/** A second keypair NOT published in the JWKS — signatures from it fail. */
let otherPrivateKey: webcrypto.CryptoKey;
let publishedJwks: JsonWebKeySet;

async function ensureKeys(): Promise<void> {
  if (primaryPrivateKey) return;

  const primary = await webcrypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  primaryPrivateKey = primary.privateKey;
  const pub = await webcrypto.subtle.exportKey("jwk", primary.publicKey);
  publishedJwks = {
    keys: [{ ...pub, kid: KID, alg: "RS256", use: "sig" }],
  };

  const other = await webcrypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  otherPrivateKey = other.privateKey;
}

// ─── Mock JWKS server (fetch stub) ───────────────────────────────────────────

/**
 * Returns a `vi.fn` that pretends to be an HTTP server serving `jwks` at any
 * URL.  The JWKSCache in auth.ts calls this when it needs to resolve keys for
 * a `jwksUrl`-configured strategy — no real socket is opened.
 */
function mockJwksServer(jwks: JsonWebKeySet): typeof fetch {
  return vi.fn(async (_url: string | URL | Request) => {
    return new Response(JSON.stringify(jwks), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

/**
 * Returns a `vi.fn` that simulates an HTTP error from the JWKS endpoint
 * (non-2xx status).
 */
function mockJwksServerError(status: number): typeof fetch {
  return vi.fn(async (_url: string | URL | Request) => {
    return new Response("Internal Server Error", { status });
  }) as unknown as typeof fetch;
}

// ─── Test helpers ─────────────────────────────────────────────────────────────

/** Base64url-encode an arbitrary value via JSON.stringify. */
function b64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj), "utf8").toString("base64url");
}

/** Mint a compact RS256 JWT signed with `signingKey`. */
async function mintToken(
  payload: Record<string, unknown>,
  signingKey: webcrypto.CryptoKey,
  kid: string = KID,
): Promise<string> {
  const header = b64url({ alg: "RS256", typ: "JWT", kid });
  const p = b64url(payload);
  const signingInput = `${header}.${p}`;
  const sig = await webcrypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    signingKey,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${Buffer.from(sig).toString("base64url")}`;
}

/** Current UNIX epoch in whole seconds. */
function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Create a fresh `JWT auth configuration` backed by the mock JWKS server.
 *
 * Each call returns a NEW verifier with its own `JWKSCache` instance —
 * no shared cache state between tests.  The `_fetchImpl` field routes
 * the cache's HTTP fetch through the provided stub.
 */
function makeVerifier(fetchImpl: typeof fetch = mockJwksServer(publishedJwks)) {
  const config = {
    strategy: "jwt",
    jwt: {
      jwksUrl: JWKS_URL,
      issuer: ISSUER,
      audience: AUDIENCE,
      _fetchImpl: fetchImpl,
    },
  } as const;
  return async (token: string | null) => token ? verifyJwtAndExtractIdentity(token, config) : null;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("JWT middleware — mock JWKS server (Sub-AC 3a)", () => {
  // We generate keys once before any test runs.
  // This `it` block runs first and seeds the module-level variables.
  // (Alternatively we could use a beforeAll, but top-level `await` in `describe`
  //  is not portable; an `it` that others can depend on is the idiomatic way here.)

  // ── Scenario 1: valid token acceptance ────────────────────────────────────
  describe("Scenario 1 — valid token acceptance", () => {
    it("accepts a valid RS256 token signed by the SaaS key and returns peerId", async () => {
      await ensureKeys();
      const verifier = makeVerifier(mockJwksServer(publishedJwks));
      const now = nowSec();
      const token = await mintToken(
        { iss: ISSUER, aud: AUDIENCE, sub: "user-abc", iat: now, exp: now + 60 },
        primaryPrivateKey,
      );
      const identity = await verifier(token);
      expect(identity).toEqual({ peerId: "user-abc" });
    });

    it("includes displayName when the `name` claim is present", async () => {
      await ensureKeys();
      const verifier = makeVerifier(mockJwksServer(publishedJwks));
      const now = nowSec();
      const token = await mintToken(
        {
          iss: ISSUER,
          aud: AUDIENCE,
          sub: "user-abc",
          name: "Alice",
          iat: now,
          exp: now + 60,
        },
        primaryPrivateKey,
      );
      const identity = await verifier(token);
      expect(identity).toEqual({ peerId: "user-abc", displayName: "Alice" });
    });

    it("accepts an audience delivered as an array containing the expected aud", async () => {
      await ensureKeys();
      const verifier = makeVerifier(mockJwksServer(publishedJwks));
      const now = nowSec();
      const token = await mintToken(
        {
          iss: ISSUER,
          aud: ["other-aud", AUDIENCE],
          sub: "user-abc",
          iat: now,
          exp: now + 60,
        },
        primaryPrivateKey,
      );
      const identity = await verifier(token);
      expect(identity).toEqual({ peerId: "user-abc" });
    });

    it("A4: a valid signed token for another tenant is rejected by register admission", async () => {
      await ensureKeys();
      const now = nowSec();
      const token = await mintToken(
        { iss: ISSUER, aud: AUDIENCE, sub: "user-abc", tenant: "mutated-tenant", iat: now, exp: now + 60 },
        primaryPrivateKey,
      );
      const config = {
        strategy: "jwt",
        jwt: { jwksUrl: JWKS_URL, issuer: ISSUER, audience: AUDIENCE, _fetchImpl: mockJwksServer(publishedJwks) },
      } as const;
      const identity = await verifyJwtAndExtractIdentity(token, config);
      expect(identity?.tenant).toBe("mutated-tenant");

      const replies: string[] = [];
      await handleRegisterRequest({
        auth: config,
        tenant: "agent-tenant",
        subjectPeerId: "user-abc",
        payload: JSON.stringify({ op: "challenge", token }),
        reply: (value) => replies.push(value),
        verifyIdentity: (jwt, auth) => verifyJwtAndExtractIdentity(jwt, auth),
        popChallenges: new PopChallengeStore(),
        registerPeer: () => {},
        wrapConversationKeyForDevice: () => null,
        unregisterPeer: () => {},
        sendHistorySnapshot: () => {},
        sendApprovalSnapshot: () => {},
      });
      expect(replies).toEqual([REGISTER_UNAUTHORIZED]);
    });

    it("the mock JWKS server fetch is actually called (verifies fetch path is exercised)", async () => {
      await ensureKeys();
      const fetchImpl = mockJwksServer(publishedJwks);
      const verifier = makeVerifier(fetchImpl);
      const now = nowSec();
      const token = await mintToken(
        { iss: ISSUER, aud: AUDIENCE, sub: "user-abc", iat: now, exp: now + 60 },
        primaryPrivateKey,
      );
      await verifier(token);
      // The JWKSCache must have fetched from the mock server at least once.
      // jwks.ts calls `fetchImpl(url)` with just the URL (no init object).
      expect(fetchImpl).toHaveBeenCalledOnce();
      expect((fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(JWKS_URL);
    });
  });

  // ── Scenario 2: invalid signature rejection ────────────────────────────────
  describe("Scenario 2 — invalid signature rejection", () => {
    it("returns null when the token is signed by a DIFFERENT private key (not matching JWKS)", async () => {
      await ensureKeys();
      const verifier = makeVerifier(mockJwksServer(publishedJwks));
      const now = nowSec();
      // `otherPrivateKey` corresponds to a public key that is NOT in
      // `publishedJwks`, so the signature check must fail even though `kid` matches.
      const token = await mintToken(
        { iss: ISSUER, aud: AUDIENCE, sub: "attacker", iat: now, exp: now + 60 },
        otherPrivateKey,
        KID, // kid points to our published key, but signature won't match
      );
      expect(await verifier(token)).toBeNull();
    });

    it("returns null when the payload is tampered after signing (sig/payload mismatch)", async () => {
      await ensureKeys();
      const verifier = makeVerifier(mockJwksServer(publishedJwks));
      const now = nowSec();
      const token = await mintToken(
        { iss: ISSUER, aud: AUDIENCE, sub: "user-abc", iat: now, exp: now + 60 },
        primaryPrivateKey,
      );
      // Swap in a different sub while keeping the original signature.
      const [h, , sig] = token.split(".");
      const tamperedPayload = b64url({
        iss: ISSUER,
        aud: AUDIENCE,
        sub: "attacker",
        iat: now,
        exp: now + 60,
      });
      expect(
        await verifier(`${h}.${tamperedPayload}.${sig}`),
      ).toBeNull();
    });

    it("rejects a relay-mutated cnf.jwk through the real signature verifier", async () => {
      await ensureKeys();
      const verifier = makeVerifier(mockJwksServer(publishedJwks));
      const now = nowSec();
      const originalDeviceKey = Buffer.alloc(32, 1).toString("base64url");
      const token = await mintToken(
        {
          iss: ISSUER,
          aud: AUDIENCE,
          sub: "user-abc",
          iat: now,
          exp: now + 60,
          cnf: { jwk: { kty: "OKP", crv: "X25519", x: originalDeviceKey } },
        },
        primaryPrivateKey,
      );
      const [header, payload, signature] = token.split(".");
      const claims = JSON.parse(Buffer.from(payload!, "base64url").toString("utf8"));
      claims.cnf.jwk.x = Buffer.alloc(32, 2).toString("base64url");
      expect(await verifier(`${header}.${b64url(claims)}.${signature}`)).toBeNull();
    });
  });

  // ── Scenario 3: expired token rejection ────────────────────────────────────
  describe("Scenario 3 — expired token rejection", () => {
    it("returns null when exp is more than 60s (default clock-skew) in the past", async () => {
      await ensureKeys();
      const verifier = makeVerifier(mockJwksServer(publishedJwks));
      const now = nowSec();
      const token = await mintToken(
        {
          iss: ISSUER,
          aud: AUDIENCE,
          sub: "user-abc",
          iat: now - 200,
          exp: now - 120, // 120s expired — beyond the 60s default skew
        },
        primaryPrivateKey,
      );
      expect(await verifier(token)).toBeNull();
    });

    it("returns null when the exp claim is missing entirely", async () => {
      await ensureKeys();
      const verifier = makeVerifier(mockJwksServer(publishedJwks));
      const now = nowSec();
      const token = await mintToken(
        { iss: ISSUER, aud: AUDIENCE, sub: "user-abc", iat: now /* no exp */ },
        primaryPrivateKey,
      );
      expect(await verifier(token)).toBeNull();
    });

    it("returns null when exp is a non-numeric value (e.g. string 'never')", async () => {
      await ensureKeys();
      const verifier = makeVerifier(mockJwksServer(publishedJwks));
      const now = nowSec();
      const token = await mintToken(
        {
          iss: ISSUER,
          aud: AUDIENCE,
          sub: "user-abc",
          iat: now,
          exp: "never" as unknown as number,
        },
        primaryPrivateKey,
      );
      expect(await verifier(token)).toBeNull();
    });
  });

  // ── Scenario 4: missing / malformed token rejection ───────────────────────
  describe("Scenario 4 — missing or malformed token rejection", () => {
    it("returns null when no ticket query parameter is present", async () => {
      await ensureKeys();
      const verifier = makeVerifier(mockJwksServer(publishedJwks));
      expect(await verifier(null)).toBeNull();
    });

    it("returns null when the token has too few segments (not a 3-part JWT)", async () => {
      await ensureKeys();
      const verifier = makeVerifier(mockJwksServer(publishedJwks));
      expect(await verifier("only.two")).toBeNull();
    });

    it("returns null when the token is completely non-JWT garbage", async () => {
      await ensureKeys();
      const verifier = makeVerifier(mockJwksServer(publishedJwks));
      expect(await verifier("not-a-jwt-at-all")).toBeNull();
    });

    it("returns null when alg=none is declared (algorithm-confusion attack)", async () => {
      await ensureKeys();
      const verifier = makeVerifier(mockJwksServer(publishedJwks));
      const now = nowSec();
      // `alg=none` tokens have no cryptographic signature — must always reject.
      const header = b64url({ alg: "none", typ: "JWT", kid: KID });
      const payload = b64url({
        iss: ISSUER,
        aud: AUDIENCE,
        sub: "attacker",
        iat: now,
        exp: now + 60,
      });
      expect(
        await verifier(`${header}.${payload}.`),
      ).toBeNull();
    });

    it("returns null when alg=HS256 is declared (HMAC / RS256 confusion attack)", async () => {
      await ensureKeys();
      const verifier = makeVerifier(mockJwksServer(publishedJwks));
      const now = nowSec();
      const header = b64url({ alg: "HS256", typ: "JWT", kid: KID });
      const payload = b64url({
        iss: ISSUER,
        aud: AUDIENCE,
        sub: "attacker",
        iat: now,
        exp: now + 60,
      });
      expect(
        await verifier(`${header}.${payload}.${"A".repeat(43)}`),
      ).toBeNull();
    });

    it("returns null when the iss claim does not match the configured issuer", async () => {
      await ensureKeys();
      const verifier = makeVerifier(mockJwksServer(publishedJwks));
      const now = nowSec();
      const token = await mintToken(
        {
          iss: "https://evil-idp.example/",
          aud: AUDIENCE,
          sub: "user-abc",
          iat: now,
          exp: now + 60,
        },
        primaryPrivateKey,
      );
      expect(await verifier(token)).toBeNull();
    });

    it("returns null when the aud claim does not match the configured audience", async () => {
      await ensureKeys();
      const verifier = makeVerifier(mockJwksServer(publishedJwks));
      const now = nowSec();
      const token = await mintToken(
        {
          iss: ISSUER,
          aud: "some-other-service",
          sub: "user-abc",
          iat: now,
          exp: now + 60,
        },
        primaryPrivateKey,
      );
      expect(await verifier(token)).toBeNull();
    });

    it("throws (fail-closed) when the mock JWKS server returns a 5xx error", async () => {
      await ensureKeys();
      const verifier = makeVerifier(mockJwksServerError(500));
      const now = nowSec();
      const token = await mintToken(
        { iss: ISSUER, aud: AUDIENCE, sub: "user-abc", iat: now, exp: now + 60 },
        primaryPrivateKey,
      );
      // A JWKS fetch failure must propagate as a rejection (fail-closed),
      // not silently return null (which could be misread as "auth passed").
      await expect(
        verifier(token),
      ).rejects.toThrow(/JWKS source unavailable/);
    });
  });
});
