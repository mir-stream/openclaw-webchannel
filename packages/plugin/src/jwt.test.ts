import { describe, it, expect, vi } from "vitest";
import { webcrypto } from "node:crypto";

import { verifyJwt, peekUnverifiedJwtAudiences, type JwtIdentity } from "./jwt.js";
import { JWKSCache, type JsonWebKeySet } from "./jwks.js";

/**
 * Tests for the RS256 JWT verifier (src/jwt.ts).
 *
 * Mirrors the style of ticket.test.ts (vitest + zero-dep setup). The verifier
 * is exercised against real RS256 tokens minted via `webcrypto.subtle.sign` so
 * the test fixtures are byte-compatible with what a real IdP would issue.
 *
 * Coverage (per AC3):
 *  - Happy path: a valid RS256 token returns `{ peerId: sub, displayName? }`.
 *  - 7 rejection cases (alg mismatch, signature tamper, kid miss, kid unknown,
 *    iss mismatch, aud mismatch, exp expired) — each test asserts verifyJwt
 *    returns `null` or throws as specified.
 *  - Additional rejection cases: 2-segment token, bad base64url, malformed JSON.
 */

const ISSUER = "https://idp.test/";
const AUDIENCE = "webchannel-test";

let privateKey: webcrypto.CryptoKey;
let publicJwk: JsonWebKeySet["keys"][number];
let jwks: JsonWebKeySet;

async function ensureKeypair(): Promise<void> {
  if (privateKey) return;
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
  privateKey = pair.privateKey;
  const jwk = await webcrypto.subtle.exportKey("jwk", pair.publicKey);
  publicJwk = { ...jwk, kid: "test-kid", alg: "RS256", use: "sig" };
  jwks = { keys: [publicJwk] };
}

function b64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj), "utf8").toString("base64url");
}

async function signJwt(
  payload: Record<string, unknown>,
  opts: { kid?: string; alg?: string } = {},
): Promise<string> {
  await ensureKeypair();
  const header = { alg: opts.alg ?? "RS256", typ: "JWT", kid: opts.kid ?? "test-kid" };
  const h = b64url(header);
  const p = b64url(payload);
  const signingInput = `${h}.${p}`;
  const sig = await webcrypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    privateKey,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${Buffer.from(sig).toString("base64url")}`;
}

function resolver(): JWKSCache {
  return JWKSCache.create({ jwks }, {});
}

describe("verifyJwt happy path (AC2)", () => {
  it("returns {peerId: sub} for a valid token", async () => {
    await ensureKeypair();
    const now = Math.floor(Date.now() / 1000);
    const token = await signJwt({
      iss: ISSUER,
      aud: AUDIENCE,
      sub: "user-42",
      iat: now,
      exp: now + 60,
    });
    const id = await verifyJwt(token, {
      jwks: resolver(),
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    expect(id).toEqual<JwtIdentity>({ peerId: "user-42" });
  });

  it("returns {peerId: sub, displayName: name} when name claim is present", async () => {
    await ensureKeypair();
    const now = Math.floor(Date.now() / 1000);
    const token = await signJwt({
      iss: ISSUER,
      aud: AUDIENCE,
      sub: "user-42",
      name: "Ada",
      iat: now,
      exp: now + 60,
    });
    const id = await verifyJwt(token, {
      jwks: resolver(),
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    expect(id).toEqual<JwtIdentity>({ peerId: "user-42", displayName: "Ada" });
  });

  it("falls back to preferred_username when name is absent", async () => {
    await ensureKeypair();
    const now = Math.floor(Date.now() / 1000);
    const token = await signJwt({
      iss: ISSUER,
      aud: AUDIENCE,
      sub: "user-42",
      preferred_username: "ada42",
      iat: now,
      exp: now + 60,
    });
    const id = await verifyJwt(token, {
      jwks: resolver(),
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    expect(id).toEqual<JwtIdentity>({ peerId: "user-42", displayName: "ada42" });
  });

  it("accepts a token whose aud is an array containing the expected audience", async () => {
    await ensureKeypair();
    const now = Math.floor(Date.now() / 1000);
    const token = await signJwt({
      iss: ISSUER,
      aud: ["other-aud", AUDIENCE, "third"],
      sub: "user-42",
      iat: now,
      exp: now + 60,
    });
    const id = await verifyJwt(token, {
      jwks: resolver(),
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    expect(id).toEqual<JwtIdentity>({ peerId: "user-42" });
  });

  it("accepts an exp within the default 60s clock skew", async () => {
    await ensureKeypair();
    const now = Math.floor(Date.now() / 1000);
    const token = await signJwt({
      iss: ISSUER,
      aud: AUDIENCE,
      sub: "user-42",
      iat: now - 60,
      exp: now - 30, // 30s past, within 60s skew → accept
    });
    const id = await verifyJwt(token, {
      jwks: resolver(),
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    expect(id).toEqual<JwtIdentity>({ peerId: "user-42" });
  });

  it("accepts an exp within a custom clock skew", async () => {
    await ensureKeypair();
    const now = Math.floor(Date.now() / 1000);
    const token = await signJwt({
      iss: ISSUER,
      aud: AUDIENCE,
      sub: "user-42",
      iat: now - 200,
      exp: now - 100, // 100s past; within custom 120s skew
    });
    const id = await verifyJwt(token, {
      jwks: resolver(),
      issuer: ISSUER,
      audience: AUDIENCE,
      clockSkewSec: 120,
    });
    expect(id).toEqual<JwtIdentity>({ peerId: "user-42" });
  });
});

describe("verifyJwt algorithm pinning (AC3 / defense-in-depth)", () => {
  it("rejects alg=none (algorithm confusion)", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await signJwt({
      iss: ISSUER,
      aud: AUDIENCE,
      sub: "attacker",
      iat: now,
      exp: now + 60,
    });
    // Re-mint the same payload but with alg=none in the header. Web Crypto
    // doesn't expose a "none" algorithm, so the test hand-builds the segments.
    const header = b64url({ alg: "none", typ: "JWT", kid: "test-kid" });
    const payload = b64url({
      iss: ISSUER,
      aud: AUDIENCE,
      sub: "attacker",
      iat: now,
      exp: now + 60,
    });
    const forged = `${header}.${payload}.`;
    void token;
    expect(
      await verifyJwt(forged, {
        jwks: resolver(),
        issuer: ISSUER,
        audience: AUDIENCE,
      }),
    ).toBeNull();
  });

  it("rejects alg=HS256 (forged with HMAC of the public key — algorithm confusion)", async () => {
    // Construct an HS256 token whose secret is the RSA public key (the classic
    // algorithm-confusion attack). We can't get a keypair HMAC secret out of
    // the public JWK without bespoke code; instead we hand-build a token with
    // a placeholder HMAC signature and assert the alg pin rejects it.
    const now = Math.floor(Date.now() / 1000);
    const header = b64url({ alg: "HS256", typ: "JWT", kid: "test-kid" });
    const payload = b64url({
      iss: ISSUER,
      aud: AUDIENCE,
      sub: "attacker",
      iat: now,
      exp: now + 60,
    });
    const forged = `${header}.${payload}.${"A".repeat(43)}`;
    expect(
      await verifyJwt(forged, {
        jwks: resolver(),
        issuer: ISSUER,
        audience: AUDIENCE,
      }),
    ).toBeNull();
  });

  it("rejects alg=ES256 (asymmetric but wrong family)", async () => {
    const now = Math.floor(Date.now() / 1000);
    const header = b64url({ alg: "ES256", typ: "JWT", kid: "test-kid" });
    const payload = b64url({
      iss: ISSUER,
      aud: AUDIENCE,
      sub: "attacker",
      iat: now,
      exp: now + 60,
    });
    const forged = `${header}.${payload}.${"A".repeat(86)}`;
    expect(
      await verifyJwt(forged, {
        jwks: resolver(),
        issuer: ISSUER,
        audience: AUDIENCE,
      }),
    ).toBeNull();
  });
});

describe("verifyJwt signature integrity (AC3)", () => {
  it("rejects a tampered payload (signature no longer matches)", async () => {
    await ensureKeypair();
    const now = Math.floor(Date.now() / 1000);
    const token = await signJwt({
      iss: ISSUER,
      aud: AUDIENCE,
      sub: "user-42",
      iat: now,
      exp: now + 60,
    });
    const [h, , sig] = token.split(".");
    const forgedPayload = b64url({
      iss: ISSUER,
      aud: AUDIENCE,
      sub: "attacker",
      iat: now,
      exp: now + 60,
    });
    expect(
      await verifyJwt(`${h}.${forgedPayload}.${sig}`, {
        jwks: resolver(),
        issuer: ISSUER,
        audience: AUDIENCE,
      }),
    ).toBeNull();
  });

  it("rejects a token signed with a DIFFERENT private key", async () => {
    await ensureKeypair();
    const otherPair = await webcrypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"],
    );
    const now = Math.floor(Date.now() / 1000);
    const header = b64url({ alg: "RS256", typ: "JWT", kid: "test-kid" });
    const payload = b64url({
      iss: ISSUER,
      aud: AUDIENCE,
      sub: "attacker",
      iat: now,
      exp: now + 60,
    });
    const signingInput = `${header}.${payload}`;
    const sig = await webcrypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      otherPair.privateKey,
      new TextEncoder().encode(signingInput),
    );
    const forged = `${signingInput}.${Buffer.from(sig).toString("base64url")}`;
    expect(
      await verifyJwt(forged, {
        jwks: resolver(),
        issuer: ISSUER,
        audience: AUDIENCE,
      }),
    ).toBeNull();
  });
});

describe("verifyJwt kid handling (AC3)", () => {
  it("rejects a token with no kid header (kids are required)", async () => {
    await ensureKeypair();
    const now = Math.floor(Date.now() / 1000);
    const header = b64url({ alg: "RS256", typ: "JWT" });
    const payload = b64url({
      iss: ISSUER,
      aud: AUDIENCE,
      sub: "user-42",
      iat: now,
      exp: now + 60,
    });
    const signingInput = `${header}.${payload}`;
    const sig = await webcrypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      privateKey,
      new TextEncoder().encode(signingInput),
    );
    const token = `${signingInput}.${Buffer.from(sig).toString("base64url")}`;
    expect(
      await verifyJwt(token, {
        jwks: resolver(),
        issuer: ISSUER,
        audience: AUDIENCE,
      }),
    ).toBeNull();
  });

  it("rejects (throws) when the kid is unknown to the JWKS", async () => {
    await ensureKeypair();
    const now = Math.floor(Date.now() / 1000);
    const token = await signJwt({
      iss: ISSUER,
      aud: AUDIENCE,
      sub: "user-42",
      iat: now,
      exp: now + 60,
    }, { kid: "unknown-kid" });
    await expect(
      verifyJwt(token, {
        jwks: resolver(),
        issuer: ISSUER,
        audience: AUDIENCE,
      }),
    ).rejects.toThrow(/not found in JWKS/);
  });
});

describe("verifyJwt claim validation (AC3)", () => {
  it("rejects iss mismatch", async () => {
    await ensureKeypair();
    const now = Math.floor(Date.now() / 1000);
    const token = await signJwt({
      iss: "https://other-idp.example/",
      aud: AUDIENCE,
      sub: "user-42",
      iat: now,
      exp: now + 60,
    });
    expect(
      await verifyJwt(token, {
        jwks: resolver(),
        issuer: ISSUER,
        audience: AUDIENCE,
      }),
    ).toBeNull();
  });

  it("rejects aud mismatch (string)", async () => {
    await ensureKeypair();
    const now = Math.floor(Date.now() / 1000);
    const token = await signJwt({
      iss: ISSUER,
      aud: "other-audience",
      sub: "user-42",
      iat: now,
      exp: now + 60,
    });
    expect(
      await verifyJwt(token, {
        jwks: resolver(),
        issuer: ISSUER,
        audience: AUDIENCE,
      }),
    ).toBeNull();
  });

  it("rejects aud mismatch (array — no overlap)", async () => {
    await ensureKeypair();
    const now = Math.floor(Date.now() / 1000);
    const token = await signJwt({
      iss: ISSUER,
      aud: ["other1", "other2"],
      sub: "user-42",
      iat: now,
      exp: now + 60,
    });
    expect(
      await verifyJwt(token, {
        jwks: resolver(),
        issuer: ISSUER,
        audience: AUDIENCE,
      }),
    ).toBeNull();
  });

  it("rejects an exp expired beyond 60s", async () => {
    await ensureKeypair();
    const now = Math.floor(Date.now() / 1000);
    const token = await signJwt({
      iss: ISSUER,
      aud: AUDIENCE,
      sub: "user-42",
      iat: now - 200,
      exp: now - 120, // 120s past, beyond default 60s skew
    });
    expect(
      await verifyJwt(token, {
        jwks: resolver(),
        issuer: ISSUER,
        audience: AUDIENCE,
      }),
    ).toBeNull();
  });

  it("rejects a missing exp claim", async () => {
    await ensureKeypair();
    const now = Math.floor(Date.now() / 1000);
    const token = await signJwt({
      iss: ISSUER,
      aud: AUDIENCE,
      sub: "user-42",
      iat: now,
    });
    expect(
      await verifyJwt(token, {
        jwks: resolver(),
        issuer: ISSUER,
        audience: AUDIENCE,
      }),
    ).toBeNull();
  });

  it("rejects a non-numeric exp claim", async () => {
    await ensureKeypair();
    const now = Math.floor(Date.now() / 1000);
    const token = await signJwt({
      iss: ISSUER,
      aud: AUDIENCE,
      sub: "user-42",
      iat: now,
      exp: "never" as unknown as number,
    });
    expect(
      await verifyJwt(token, {
        jwks: resolver(),
        issuer: ISSUER,
        audience: AUDIENCE,
      }),
    ).toBeNull();
  });

  it("rejects a missing sub claim", async () => {
    await ensureKeypair();
    const now = Math.floor(Date.now() / 1000);
    const token = await signJwt({
      iss: ISSUER,
      aud: AUDIENCE,
      iat: now,
      exp: now + 60,
    });
    expect(
      await verifyJwt(token, {
        jwks: resolver(),
        issuer: ISSUER,
        audience: AUDIENCE,
      }),
    ).toBeNull();
  });

  it("rejects an empty sub claim", async () => {
    await ensureKeypair();
    const now = Math.floor(Date.now() / 1000);
    const token = await signJwt({
      iss: ISSUER,
      aud: AUDIENCE,
      sub: "",
      iat: now,
      exp: now + 60,
    });
    expect(
      await verifyJwt(token, {
        jwks: resolver(),
        issuer: ISSUER,
        audience: AUDIENCE,
      }),
    ).toBeNull();
  });
});

describe("verifyJwt token-shape rejections (AC3)", () => {
  it("rejects a 2-segment token", async () => {
    await ensureKeypair();
    expect(
      await verifyJwt("only.two", {
        jwks: resolver(),
        issuer: ISSUER,
        audience: AUDIENCE,
      }),
    ).toBeNull();
  });

  it("rejects a 4-segment token", async () => {
    await ensureKeypair();
    expect(
      await verifyJwt("a.b.c.d", {
        jwks: resolver(),
        issuer: ISSUER,
        audience: AUDIENCE,
      }),
    ).toBeNull();
  });

  it("rejects an empty token", async () => {
    await ensureKeypair();
    expect(
      await verifyJwt("", {
        jwks: resolver(),
        issuer: ISSUER,
        audience: AUDIENCE,
      }),
    ).toBeNull();
  });

  it("rejects a non-string token", async () => {
    await ensureKeypair();
    expect(
      await verifyJwt(123 as unknown as string, {
        jwks: resolver(),
        issuer: ISSUER,
        audience: AUDIENCE,
      }),
    ).toBeNull();
  });

  it("rejects a token whose header base64url is invalid", async () => {
    await ensureKeypair();
    expect(
      await verifyJwt("!!!!.eyJzdWIiOiJ4In0.AAAA", {
        jwks: resolver(),
        issuer: ISSUER,
        audience: AUDIENCE,
      }),
    ).toBeNull();
  });

  it("rejects a token whose payload base64url is invalid", async () => {
    await ensureKeypair();
    // Valid header to get past the alg/kid checks if we ever loosen them;
    // invalid payload must reject at JSON-parse.
    const header = b64url({ alg: "RS256", typ: "JWT", kid: "test-kid" });
    expect(
      await verifyJwt(`${header}.!!!!.AAAA`, {
        jwks: resolver(),
        issuer: ISSUER,
        audience: AUDIENCE,
      }),
    ).toBeNull();
  });

  it("rejects a token whose payload is not JSON", async () => {
    await ensureKeypair();
    const header = b64url({ alg: "RS256", typ: "JWT", kid: "test-kid" });
    const payload = b64url("not json at all");
    expect(
      await verifyJwt(`${header}.${payload}.${"A".repeat(342)}`, {
        jwks: resolver(),
        issuer: ISSUER,
        audience: AUDIENCE,
      }),
    ).toBeNull();
  });

  it("rejects a token whose header is not JSON", async () => {
    await ensureKeypair();
    const header = b64url("not json at all");
    const payload = b64url({ sub: "x" });
    expect(
      await verifyJwt(`${header}.${payload}.AAAA`, {
        jwks: resolver(),
        issuer: ISSUER,
        audience: AUDIENCE,
      }),
    ).toBeNull();
  });

  it("rejects a token whose header is not an object (string JSON)", async () => {
    await ensureKeypair();
    const header = b64url("just a string");
    const payload = b64url({ sub: "x" });
    expect(
      await verifyJwt(`${header}.${payload}.AAAA`, {
        jwks: resolver(),
        issuer: ISSUER,
        audience: AUDIENCE,
      }),
    ).toBeNull();
  });

  it("rejects a token whose aud is neither string nor array", async () => {
    await ensureKeypair();
    const now = Math.floor(Date.now() / 1000);
    const token = await signJwt({
      iss: ISSUER,
      aud: 42 as unknown as string,
      sub: "user-42",
      iat: now,
      exp: now + 60,
    });
    expect(
      await verifyJwt(token, {
        jwks: resolver(),
        issuer: ISSUER,
        audience: AUDIENCE,
      }),
    ).toBeNull();
  });

  it("rejects a token whose iss is missing", async () => {
    await ensureKeypair();
    const now = Math.floor(Date.now() / 1000);
    const token = await signJwt({
      aud: AUDIENCE,
      sub: "user-42",
      iat: now,
      exp: now + 60,
    });
    expect(
      await verifyJwt(token, {
        jwks: resolver(),
        issuer: ISSUER,
        audience: AUDIENCE,
      }),
    ).toBeNull();
  });
});

describe("verifyJwt resolver error propagation (AC5)", () => {
  it("propagates a resolver throw (fail-closed — never silently bypasses)", async () => {
    await ensureKeypair();
    const now = Math.floor(Date.now() / 1000);
    const token = await signJwt({
      iss: ISSUER,
      aud: AUDIENCE,
      sub: "user-42",
      iat: now,
      exp: now + 60,
    });
    const failingResolver = {
      getKey: vi.fn(async (_kid: string) => {
        throw new Error("JWKS endpoint is down");
      }),
    };
    await expect(
      verifyJwt(token, {
        jwks: failingResolver,
        issuer: ISSUER,
        audience: AUDIENCE,
      }),
    ).rejects.toThrow(/JWKS endpoint is down/);
  });
});
describe("peekUnverifiedJwtAudiences (가-2 aud → account routing)", () => {
  const b64u = (obj: unknown) =>
    Buffer.from(JSON.stringify(obj))
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  const token = (payload: unknown) =>
    `${b64u({ alg: "RS256", typ: "JWT", kid: "k1" })}.${b64u(payload)}.sig`;

  it("returns a single string aud as a one-element array", () => {
    expect(peekUnverifiedJwtAudiences(token({ sub: "p", aud: "agentA" }))).toEqual(["agentA"]);
  });

  it("returns an array aud filtered to non-empty strings", () => {
    expect(
      peekUnverifiedJwtAudiences(token({ sub: "p", aud: ["agentA", "", "agentB", 5] })),
    ).toEqual(["agentA", "agentB"]);
  });

  it("returns [] for a missing/empty/malformed aud", () => {
    expect(peekUnverifiedJwtAudiences(token({ sub: "p" }))).toEqual([]);
    expect(peekUnverifiedJwtAudiences(token({ sub: "p", aud: "" }))).toEqual([]);
    expect(peekUnverifiedJwtAudiences(token({ sub: "p", aud: 42 }))).toEqual([]);
  });

  it("returns [] for non-token input (no throw)", () => {
    expect(peekUnverifiedJwtAudiences(undefined)).toEqual([]);
    expect(peekUnverifiedJwtAudiences("")).toEqual([]);
    expect(peekUnverifiedJwtAudiences("a.b")).toEqual([]);
    expect(peekUnverifiedJwtAudiences("a.@@@.c")).toEqual([]);
  });
});
