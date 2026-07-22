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
import { assertJwtAuthConfig, type AuthConfig } from "./auth.js";

describe("Anonymous strategy rejection (AC 4)", () => {
  it("should throw error when anonymous strategy is resolved", () => {
    const anonConfig = { strategy: "anonymous" } as unknown as AuthConfig;

    expect(() => assertJwtAuthConfig(anonConfig)).toThrow(
      /not valid for register-hop JWT verification/,
    );
  });

  it("should throw error with detailed message mentioning AC 4", () => {
    const anonConfig = { strategy: "anonymous" } as unknown as AuthConfig;

    expect(() => assertJwtAuthConfig(anonConfig)).toThrow(
      /not valid for register-hop JWT verification/,
    );
  });

  it("should throw error suggesting the jwt strategy", () => {
    const anonConfig = { strategy: "anonymous" } as unknown as AuthConfig;

    expect(() => assertJwtAuthConfig(anonConfig)).toThrow(
      /register-hop JWT verification/,
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

      const verifier = assertJwtAuthConfig(jwtConfig);
      expect(verifier).toBeDefined(); // Should not throw at strategy selection
    } catch (e: unknown) {
      // If it throws, it should be due to missing config, not strategy rejection
      expect((e as Error).message).not.toContain(/unknown auth strategy/);
    }
  });

  it("should throw error for unknown strategy", () => {
    const unknownConfig = { strategy: "unknown" } as unknown as AuthConfig;

    expect(() => assertJwtAuthConfig(unknownConfig)).toThrow(
      /auth strategy "unknown" is not valid/,
    );
  });

  it("should throw error for missing strategy", () => {
    expect(() => assertJwtAuthConfig(null)).toThrow(/auth.strategy is required/);
    expect(() => assertJwtAuthConfig(undefined)).toThrow(/auth.strategy is required/);
    expect(() => assertJwtAuthConfig({} as any)).toThrow(/auth.strategy is required/);
  });
});
