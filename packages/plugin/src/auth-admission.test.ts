/**
 * Tests for device key storage and anonymous strategy rejection (AC 4).
 *
 * Verifies that:
 *   - Device public keys are stored correctly during admission
 *   - Pinned keys can be retrieved by peerId
 *   - Anonymous strategy is rejected with error
 *   - Device key storage functions work correctly
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  storePinnedDeviceKey,
  getPinnedDeviceKey,
  clearPinnedDeviceKeys,
  clearPinnedDeviceKeyForPeer,
  resolveVerifier,
  type AuthConfig,
} from "./auth.js";

describe("Device key storage (AC 4)", () => {
  beforeEach(() => {
    // Clear all pinned keys before each test
    clearPinnedDeviceKeys();
  });

  afterEach(() => {
    // Clean up after each test
    clearPinnedDeviceKeys();
  });

  it("should store a device public key for a peerId", () => {
    const peerId = "user123";
    const deviceKey = "a".repeat(43); // Mock base64url X25519 key

    storePinnedDeviceKey(peerId, deviceKey);

    const retrieved = getPinnedDeviceKey(peerId);
    expect(retrieved).toBe(deviceKey);
  });

  it("should return null for non-existent peerId", () => {
    const retrieved = getPinnedDeviceKey("nonexistent");
    expect(retrieved).toBeNull();
  });

  it("should replace existing key when storing again for same peerId", () => {
    const peerId = "user123";
    const deviceKey1 = "a".repeat(43);
    const deviceKey2 = "b".repeat(43);

    storePinnedDeviceKey(peerId, deviceKey1);
    expect(getPinnedDeviceKey(peerId)).toBe(deviceKey1);

    storePinnedDeviceKey(peerId, deviceKey2);
    expect(getPinnedDeviceKey(peerId)).toBe(deviceKey2);
  });

  it("should store separate keys for different peerIds", () => {
    const peerId1 = "user1";
    const peerId2 = "user2";
    const deviceKey1 = "a".repeat(43);
    const deviceKey2 = "b".repeat(43);

    storePinnedDeviceKey(peerId1, deviceKey1);
    storePinnedDeviceKey(peerId2, deviceKey2);

    expect(getPinnedDeviceKey(peerId1)).toBe(deviceKey1);
    expect(getPinnedDeviceKey(peerId2)).toBe(deviceKey2);
  });

  it("should clear all pinned device keys", () => {
    storePinnedDeviceKey("user1", "a".repeat(43));
    storePinnedDeviceKey("user2", "b".repeat(43));

    expect(getPinnedDeviceKey("user1")).toBeTruthy();
    expect(getPinnedDeviceKey("user2")).toBeTruthy();

    clearPinnedDeviceKeys();

    expect(getPinnedDeviceKey("user1")).toBeNull();
    expect(getPinnedDeviceKey("user2")).toBeNull();
  });

  it("should clear pinned device key for specific peer", () => {
    const peerId1 = "user1";
    const peerId2 = "user2";

    storePinnedDeviceKey(peerId1, "a".repeat(43));
    storePinnedDeviceKey(peerId2, "b".repeat(43));

    clearPinnedDeviceKeyForPeer(peerId1);

    expect(getPinnedDeviceKey(peerId1)).toBeNull();
    expect(getPinnedDeviceKey(peerId2)).toBeTruthy();
  });

  it("should throw on invalid peerId when storing", () => {
    expect(() => storePinnedDeviceKey("", "key")).toThrow("peerId must be a non-empty string");
    expect(() => storePinnedDeviceKey("valid", "")).toThrow("devicePublicKey must be a non-empty base64url string");
  });
});

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

  it("should throw error suggesting jwt or hmac-ticket strategies", () => {
    const anonConfig: AuthConfig = { strategy: "anonymous" };

    expect(() => resolveVerifier(anonConfig)).toThrow(
      /Use 'jwt' strategy with JWKS verification or 'hmac-ticket' strategy/,
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

  it("should accept hmac-ticket strategy", () => {
    // This test verifies that hmac-ticket strategy is still accepted
    try {
      const hmacConfig: AuthConfig = {
        strategy: "hmac-ticket",
        ticketSecret: "test-secret",
      };

      const verifier = resolveVerifier(hmacConfig);
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

describe("Device key storage edge cases (AC 4)", () => {
  beforeEach(() => {
    clearPinnedDeviceKeys();
  });

  afterEach(() => {
    clearPinnedDeviceKeys();
  });

  it("should handle special characters in peerId", () => {
    const specialPeerIds = [
      "user-with-dashes",
      "user_with_underscores",
      "user.with.dots",
      "user@with@special",
      "user123",
      "123numeric",
    ];

    for (const peerId of specialPeerIds) {
      const deviceKey = `${peerId}-key-${"a".repeat(30)}`;
      storePinnedDeviceKey(peerId, deviceKey);
      expect(getPinnedDeviceKey(peerId)).toBe(deviceKey);
    }
  });

  it("should handle very long peerIds", () => {
    const longPeerId = "a".repeat(1000);
    const deviceKey = "b".repeat(43);

    storePinnedDeviceKey(longPeerId, deviceKey);
    expect(getPinnedDeviceKey(longPeerId)).toBe(deviceKey);
  });

  it("should handle realistic X25519 base64url key format", () => {
    // Real X25519 public keys are 32 bytes, which encode to 43 base64url chars
    const realisticKey = "dGhpcy1pcy1hLXRlc3QteDI1NTE5LWtleQ"; // 43 chars
    const peerId = "user123";

    storePinnedDeviceKey(peerId, realisticKey);
    expect(getPinnedDeviceKey(peerId)).toBe(realisticKey);
  });

  it("should allow clearing non-existent peer without error", () => {
    // Should not throw when clearing a peer that doesn't exist
    expect(() => clearPinnedDeviceKeyForPeer("nonexistent")).not.toThrow();
  });

  it("should handle multiple clear operations safely", () => {
    storePinnedDeviceKey("user1", "key1");
    storePinnedDeviceKey("user2", "key2");

    clearPinnedDeviceKeys();

    // Clearing again should be safe (no-op)
    expect(() => clearPinnedDeviceKeys()).not.toThrow();

    expect(getPinnedDeviceKey("user1")).toBeNull();
    expect(getPinnedDeviceKey("user2")).toBeNull();
  });
});
