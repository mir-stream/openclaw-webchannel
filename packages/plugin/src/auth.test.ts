import { describe, it, expect, vi, afterEach, beforeAll } from "vitest";
import type { IncomingMessage } from "node:http";
import { webcrypto } from "node:crypto";

import {
  resolveVerifier,
  ANON_PEER_ID,
  type AuthConfig,
  type AuthLogger,
} from "./auth.js";
import { issueWebChannelTicket } from "./ticket.js";
import type { JsonWebKeySet } from "./jwks.js";

/** Build a minimal IncomingMessage-like object with just a `url`. */
function fakeReq(url: string): IncomingMessage {
  return { url } as IncomingMessage;
}

const ENV_VAR = "WEBCHANNEL_TEST_TICKET_SECRET";
const SECRET = "shared-hmac-secret";

afterEach(() => {
  delete process.env[ENV_VAR];
  vi.restoreAllMocks();
});

describe("resolveVerifier safe default", () => {
  it("throws on missing auth config", () => {
    expect(() => resolveVerifier(undefined)).toThrow(/strategy is required/);
    expect(() => resolveVerifier(null)).toThrow(/strategy is required/);
  });

  it("throws on unknown strategy", () => {
    expect(() =>
      resolveVerifier({ strategy: "totally-bogus" } as unknown as AuthConfig),
    ).toThrow(/unknown auth strategy/);
  });
});

describe("anonymous strategy", () => {
  it("is rejected (AC4): refuses to start and logs an error", () => {
    const error = vi.fn();
    const logger: AuthLogger = { error };

    // AC 4: anonymous admission is a security hole — resolving the verifier
    // must throw rather than hand back an open-admission peer.
    expect(() => resolveVerifier({ strategy: "anonymous" }, logger)).toThrow(/anonymous/i);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0][0]).toMatch(/anonymous/i);
  });
});

describe("hmac-ticket strategy", () => {
  it("accepts a freshly issued ticket and maps sub -> peerId", async () => {
    const verifier = resolveVerifier({
      strategy: "hmac-ticket",
      ticketSecret: SECRET,
    });
    const token = issueWebChannelTicket({
      sub: "user-7",
      secret: SECRET,
      ttlSeconds: 60,
      displayName: "Grace",
    });
    const identity = await verifier(fakeReq(`/webchannel/ws?ticket=${token}`));
    expect(identity).toEqual({ peerId: "user-7", displayName: "Grace" });
  });

  it("honors a custom ticketParam", async () => {
    const verifier = resolveVerifier({
      strategy: "hmac-ticket",
      ticketSecret: SECRET,
      ticketParam: "t",
    });
    const token = issueWebChannelTicket({
      sub: "user-7",
      secret: SECRET,
      ttlSeconds: 60,
    });
    expect(await verifier(fakeReq(`/webchannel/ws?t=${token}`))).toEqual({
      peerId: "user-7",
    });
    // Wrong param name => no ticket => reject.
    expect(
      await verifier(fakeReq(`/webchannel/ws?ticket=${token}`)),
    ).toBeNull();
  });

  it("rejects a missing ticket", async () => {
    const verifier = resolveVerifier({
      strategy: "hmac-ticket",
      ticketSecret: SECRET,
    });
    expect(await verifier(fakeReq("/webchannel/ws"))).toBeNull();
  });

  it("rejects an expired ticket", async () => {
    const verifier = resolveVerifier({
      strategy: "hmac-ticket",
      ticketSecret: SECRET,
    });
    const token = issueWebChannelTicket({
      sub: "user-7",
      secret: SECRET,
      ttlSeconds: -1,
    });
    expect(await verifier(fakeReq(`/webchannel/ws?ticket=${token}`))).toBeNull();
  });

  it("rejects a tampered ticket", async () => {
    const verifier = resolveVerifier({
      strategy: "hmac-ticket",
      ticketSecret: SECRET,
    });
    const token = issueWebChannelTicket({
      sub: "user-7",
      secret: SECRET,
      ttlSeconds: 60,
    });
    const tampered = `${token}tampered`;
    expect(
      await verifier(fakeReq(`/webchannel/ws?ticket=${tampered}`)),
    ).toBeNull();
  });

  it("resolves the secret from an env SecretRef", async () => {
    process.env[ENV_VAR] = SECRET;
    const verifier = resolveVerifier({
      strategy: "hmac-ticket",
      ticketSecret: { env: ENV_VAR },
    });
    const token = issueWebChannelTicket({
      sub: "user-7",
      secret: SECRET,
      ttlSeconds: 60,
    });
    expect(await verifier(fakeReq(`/webchannel/ws?ticket=${token}`))).toEqual({
      peerId: "user-7",
    });
  });

  it("throws when the env SecretRef is missing", () => {
    expect(() =>
      resolveVerifier({
        strategy: "hmac-ticket",
        ticketSecret: { env: ENV_VAR },
      }),
    ).toThrow(/is unset or empty/);
  });

  it("throws on an empty inline secret", () => {
    expect(() =>
      resolveVerifier({ strategy: "hmac-ticket", ticketSecret: "" }),
    ).toThrow(/empty string/);
  });
});

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

describe("jwt strategy (AC1 — fail-closed config)", () => {
  beforeAll(async () => {
    await ensureRsaKeys();
  });

  it("throws when issuer is missing", () => {
    expect(() =>
      resolveVerifier({
        strategy: "jwt",
        jwt: { audience: AUDIENCE, jwks: rsaJwks },
      } as AuthConfig),
    ).toThrow(/jwt\.issuer is required/);
  });

  it("throws when audience is missing", () => {
    expect(() =>
      resolveVerifier({
        strategy: "jwt",
        jwt: { issuer: ISSUER, jwks: rsaJwks },
      } as AuthConfig),
    ).toThrow(/jwt\.audience is required/);
  });

  it("throws when no JWKS source is provided", () => {
    expect(() =>
      resolveVerifier({
        strategy: "jwt",
        jwt: { issuer: ISSUER, audience: AUDIENCE },
      } as AuthConfig),
    ).toThrow(/exactly one of jwksUrl, jwksFile, or jwks/);
  });

  it("throws when more than one JWKS source is provided", () => {
    expect(() =>
      resolveVerifier({
        strategy: "jwt",
        jwt: {
          issuer: ISSUER,
          audience: AUDIENCE,
          jwks: rsaJwks,
          jwksUrl: "https://idp.test/jwks.json",
        },
      } as AuthConfig),
    ).toThrow(/exactly one of jwksUrl, jwksFile, or jwks/);
  });

  it("returns a verifier when all required fields are present (inline jwks)", () => {
    expect(() =>
      resolveVerifier({
        strategy: "jwt",
        jwt: { issuer: ISSUER, audience: AUDIENCE, jwks: rsaJwks },
      }),
    ).not.toThrow();
  });
});

describe("jwt strategy (AC2 — happy path)", () => {
  beforeAll(async () => {
    await ensureRsaKeys();
  });

  it("accepts a valid RS256 token and maps sub -> peerId", async () => {
    await ensureRsaKeys();
    const verifier = resolveVerifier({
      strategy: "jwt",
      jwt: { issuer: ISSUER, audience: AUDIENCE, jwks: rsaJwks },
    });
    const now = Math.floor(Date.now() / 1000);
    const token = await signRs256({
      iss: ISSUER,
      aud: AUDIENCE,
      sub: "user-7",
      name: "Grace",
      iat: now,
      exp: now + 60,
    });
    expect(await verifier(fakeReq(`/webchannel/ws?ticket=${token}`))).toEqual({
      peerId: "user-7",
      displayName: "Grace",
    });
  });

  it("honors a custom ticketParam", async () => {
    await ensureRsaKeys();
    const verifier = resolveVerifier({
      strategy: "jwt",
      jwt: { issuer: ISSUER, audience: AUDIENCE, jwks: rsaJwks },
      ticketParam: "jwt",
    });
    const now = Math.floor(Date.now() / 1000);
    const token = await signRs256({
      iss: ISSUER,
      aud: AUDIENCE,
      sub: "user-7",
      iat: now,
      exp: now + 60,
    });
    expect(await verifier(fakeReq(`/webchannel/ws?jwt=${token}`))).toEqual({
      peerId: "user-7",
    });
    // Wrong param name => no ticket => reject.
    expect(await verifier(fakeReq(`/webchannel/ws?ticket=${token}`))).toBeNull();
  });

  it("rejects when the ticket query param is missing", async () => {
    await ensureRsaKeys();
    const verifier = resolveVerifier({
      strategy: "jwt",
      jwt: { issuer: ISSUER, audience: AUDIENCE, jwks: rsaJwks },
    });
    expect(await verifier(fakeReq("/webchannel/ws"))).toBeNull();
  });
});
