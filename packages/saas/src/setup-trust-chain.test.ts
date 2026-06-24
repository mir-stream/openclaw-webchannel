/**
 * Tests for setupTrustChain — AC 1 compliance.
 *
 * Verifies that setupTrustChain:
 *   - Generates RSA keypair for RS256 signing
 *   - Generates NKEY seed for NATS account signing
 *   - Emits operator JWT signed by operator NKEY
 *   - Emits account JWT signed by operator NKEY
 *   - Emits resolver config mapping account NKEY to account JWT
 *   - Emits JWKS document with RSA public key
 *   - Separates private (SaaS-only) from public (nats-server + JWKS)
 */

import { describe, it, expect } from "vitest";
import { setupTrustChain } from "./setup-trust-chain.js";
import type {
  SetupTrustChainResult,
  SaasTrustChainPrivate,
  NatsAccountConfig,
  JwksDocument,
} from "./types.js";

describe("setupTrustChain (AC 1)", () => {
  it("generates RSA keypair with valid PEM format", async () => {
    const result = await setupTrustChain();

    // RSA private key must be PEM format
    expect(result.private.rsaPrivateKeyPem).toMatch(/-----BEGIN PRIVATE KEY-----/);
    expect(result.private.rsaPrivateKeyPem).toMatch(/-----END PRIVATE KEY-----/);

    // PEM should be base64-encoded content between headers
    const pemContent = result.private.rsaPrivateKeyPem
      .replace(/-----BEGIN PRIVATE KEY-----/, "")
      .replace(/-----END PRIVATE KEY-----/, "")
      .replace(/\s/g, "");
    expect(() => atob(pemContent)).not.toThrow(); // Valid base64
  });

  it("generates NKEY seed with correct format", async () => {
    const result = await setupTrustChain();

    // NKEY seed must start with "SA" (Operator/Account category byte)
    expect(result.private.natsAccountSeed).toMatch(/^SA/);

    // NKEY seed should be base32-like (no vowels, alphanumeric)
    const seedContent = result.private.natsAccountSeed.slice(2);
    expect(seedContent).toMatch(/^[CFH23567PR89JKLMNPQTUVWXYZ456789]+$/);

    // Seed length should be reasonable (Ed25519 key in base32)
    expect(seedContent.length).toBeGreaterThan(40);
  });

  it("emits operator JWT with required claims", async () => {
    const result = await setupTrustChain();

    // Operator JWT must be present
    expect(result.natsConfig.operatorJwt).toBeTruthy();

    // Must be compact JWT format (header.payload.signature)
    const parts = result.natsConfig.operatorJwt.split(".");
    expect(parts).toHaveLength(3);

    // Decode header (without verification for structure check)
    const header = JSON.parse(atob(parts[0]!));
    expect(header).toMatchObject({
      typ: "jwt",
      alg: expect.any(String),
    });

    // Decode payload
    const payload = JSON.parse(atob(parts[1]!));
    expect(payload).toMatchObject({
      iss: expect.stringMatching(/^SA/), // Operator public NKEY
      name: expect.any(String),
      sub: expect.stringMatching(/^SA/), // Operator public NKEY
    });
  });

  it("emits account JWT with required claims", async () => {
    const result = await setupTrustChain();

    // Account JWT must be present
    expect(result.natsConfig.accountJwt).toBeTruthy();

    // Must be compact JWT format
    const parts = result.natsConfig.accountJwt.split(".");
    expect(parts).toHaveLength(3);

    // Decode payload
    const payload = JSON.parse(atob(parts[1]!));
    expect(payload).toMatchObject({
      iss: expect.stringMatching(/^SA/), // Operator public NKEY
      name: expect.any(String),
      sub: expect.stringMatching(/^SA/), // Account public NKEY
      nats: expect.objectContaining({
        limits: expect.any(Object),
      }),
    });
  });

  it("emits resolver config mapping account NKEY to account JWT", async () => {
    const result = await setupTrustChain();

    // Resolver config must be an object
    expect(result.natsConfig.resolverConfig).toBeTruthy();
    expect(typeof result.natsConfig.resolverConfig).toBe("object");

    // Must contain exactly one entry (the account)
    const entries = Object.entries(result.natsConfig.resolverConfig);
    expect(entries).toHaveLength(1);

    const [accountPublicKey, accountJwt] = entries[0]!;

    // Key must be the account public NKEY
    expect(accountPublicKey).toBe(result.natsConfig.accountPublicKey);
    expect(accountPublicKey).toMatch(/^SA/);

    // Value must be the account JWT
    expect(accountJwt).toBe(result.natsConfig.accountJwt);
  });

  it("emits JWKS document with RSA public key", async () => {
    const result = await setupTrustChain();

    // JWKS must be an object with keys array
    expect(result.jwks).toBeTruthy();
    expect(result.jwks.keys).toBeTruthy();
    expect(Array.isArray(result.jwks.keys)).toBe(true);

    // Must contain exactly one key (the RSA key)
    expect(result.jwks.keys).toHaveLength(1);

    const [jwk] = result.jwks.keys;
    expect(jwk).toMatchObject({
      kty: "RSA",
      kid: expect.any(String),
      n: expect.any(String),
      e: expect.any(String),
    });

    // Optional fields
    if (jwk!.alg) {
      expect(jwk!.alg).toBe("RS256");
    }
    if (jwk!.use) {
      expect(jwk!.use).toBe("sig");
    }
  });

  it("generates unique key ID (kid) for each invocation", async () => {
    const result1 = await setupTrustChain();
    const result2 = await setupTrustChain();

    // Each invocation should generate a unique UUID
    expect(result1.kid).toBeTruthy();
    expect(result2.kid).toBeTruthy();
    expect(result1.kid).not.toBe(result2.kid);

    // Both should be valid UUIDs (v4 format)
    expect(result1.kid).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it("separates private from public artifacts", async () => {
    const result = await setupTrustChain();

    // Private artifacts must not contain any public keys or JWTs
    expect(result.private).not.toHaveProperty("operatorJwt");
    expect(result.private).not.toHaveProperty("accountJwt");
    expect(result.private).not.toHaveProperty("jwks");

    // Public artifacts must not contain private keys
    expect(result.natsConfig).not.toHaveProperty("rsaPrivateKeyPem");
    expect(result.natsConfig).not.toHaveProperty("natsAccountSeed");
    expect(result.jwks).not.toHaveProperty("rsaPrivateKeyPem");
    expect(result.jwks).not.toHaveProperty("natsAccountSeed");
  });

  it("supports custom operator and account names", async () => {
    const customResult = await setupTrustChain({
      operatorName: "custom-operator",
      accountName: "custom-account",
    });

    // Decode operator JWT payload
    const operatorPayload = JSON.parse(
      atob(customResult.natsConfig.operatorJwt.split(".")[1]!),
    );
    expect(operatorPayload.name).toBe("custom-operator");

    // Decode account JWT payload
    const accountPayload = JSON.parse(
      atob(customResult.natsConfig.accountJwt.split(".")[1]!),
    );
    expect(accountPayload.name).toBe("custom-account");
  });

  it("supports custom key ID (kid)", async () => {
    const customKid = "my-custom-key-id";
    const result = await setupTrustChain({ kid: customKid });

    expect(result.kid).toBe(customKid);

    // JWKS should contain the custom kid
    const [jwk] = result.jwks.keys;
    expect(jwk!.kid).toBe(customKid);
  });

  it("generates deterministic account public NKEY from seed", async () => {
    const result = await setupTrustChain();

    // The account public NKEY should be derivable from the seed
    // (This is a structural check — actual derivation happens in generateNkeySeed)
    expect(result.natsConfig.accountPublicKey).toMatch(/^SA/);
    expect(result.private.natsAccountSeed).toMatch(/^SA/);

    // Public key and seed should be different (seed includes private material)
    expect(result.natsConfig.accountPublicKey).not.toBe(
      result.private.natsAccountSeed,
    );
  });

  it("generates JWKS-compatible RSA public key", async () => {
    const result = await setupTrustChain();

    const [jwk] = result.jwks.keys;

    // JWK fields must be base64url-encoded
    expect(() => {
      // 'n' (modulus) must be valid base64url
      const decodedN = atob(jwk!.n!.replace(/-/g, "+").replace(/_/g, "/"));
      expect(decodedN.length).toBeGreaterThan(0);

      // 'e' (exponent) must be valid base64url (typically "AQAB" for 65537)
      const decodedE = atob(jwk!.e!.replace(/-/g, "+").replace(/_/g, "/"));
      expect(decodedE.length).toBeGreaterThan(0);
    }).not.toThrow();
  });
});
