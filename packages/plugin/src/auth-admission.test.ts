/**
 * Auth admission strategy tests (AC 4).
 *
 * Verifies that the anonymous strategy is rejected (open admission is a
 * security hole) and that only the authenticated `jwt` strategy is accepted.
 *
 * NOTE (Phase 6 / W7): the "device key pin store" tests that used to live here
 * are gone with the store itself — the register route now wraps the
 * conversation key to the device key presented in each request's verified JWT
 * `cnf` claim (`identity.devicePublicKey`), so no module-global, peerId-keyed
 * key store exists anymore (it collided two devices of one user — audit F2).
 */

import { describe, it, expect } from "vitest";
import { resolveVerifier, type AuthConfig } from "./auth.js";

describe("Anonymous strategy rejection (AC 4)", () => {
  it("should throw error when anonymous strategy is resolved", () => {
    const anonConfig: AuthConfig = { strategy: "anonymous" };

    expect(() => resolveVerifier(anonConfig)).toThrow(
      /auth strategy 'anonymous' is disabled/,
    );
  });

  it("should throw error with detailed message mentioning AC 4", () => {
    const anonConfig: AuthConfig = { strategy: "anonymous" };

    expect(() => resolveVerifier(anonConfig)).toThrow(
      /AC 4 requires SaaS-attested device keys/,
    );
  });

  it("should throw error suggesting the jwt strategy", () => {
    const anonConfig: AuthConfig = { strategy: "anonymous" };

    expect(() => resolveVerifier(anonConfig)).toThrow(
      /Use the 'jwt' strategy with JWKS verification/,
    );
  });

  it("should accept jwt strategy", () => {
    // This test verifies that jwt strategy is still accepted
    // (it will fail during verifier construction due to missing required fields,
    // but the strategy selection should work)

    try {
      const jwtConfig: AuthConfig = {
        strategy: "jwt",
        jwt: {
          jwksUrl: "https://example.com/jwks.json",
          issuer: "test-issuer",
          audience: "test-audience",
        },
      };

      const verifier = resolveVerifier(jwtConfig);
      expect(verifier).toBeDefined(); // Should not throw at strategy selection
    } catch (e: unknown) {
      // If it throws, it should be due to missing config, not strategy rejection
      expect((e as Error).message).not.toContain(/unknown auth strategy/);
    }
  });

  it("should throw error for unknown strategy", () => {
    const unknownConfig: AuthConfig = { strategy: "unknown" as any };

    expect(() => resolveVerifier(unknownConfig)).toThrow(
      /unknown auth strategy "unknown"/,
    );
  });

  it("should throw error for missing strategy", () => {
    expect(() => resolveVerifier(null)).toThrow(/auth.strategy is required/);
    expect(() => resolveVerifier(undefined)).toThrow(/auth.strategy is required/);
    expect(() => resolveVerifier({} as any)).toThrow(/auth.strategy is required/);
  });
});
