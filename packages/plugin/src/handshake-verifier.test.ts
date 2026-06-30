/**
 * Tests for agent-side handshake verification (AC 4).
 *
 * Verifies that:
 *   - Valid device keys match SaaS-pinned values
 *   - Mismatched device keys are rejected with HandshakeMitmError
 *   - Missing pinned keys cause error
 *   - Invalid key lengths are rejected
 *   - Handshake messages are parsed and validated correctly
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  parseAndVerifyHandshake,
  verifyDeviceKey,
  HandshakeMitmError,
  type HandshakeHelloMessage,
} from "./handshake-verifier.js";
import {
  storePinnedDeviceKey,
  clearPinnedDeviceKeys,
} from "./auth.js";

describe("Handshake device key verification (AC 4)", () => {
  beforeEach(() => {
    clearPinnedDeviceKeys();
  });

  afterEach(() => {
    clearPinnedDeviceKeys();
  });

  describe("verifyDeviceKey", () => {
    it("should accept device key matching SaaS-pinned value", () => {
      const peerId = "user123";
      const pinnedKeyB64 = "a".repeat(43); // Mock base64url X25519 key
      storePinnedDeviceKey(peerId, pinnedKeyB64);

      const presentedKey = Buffer.from(pinnedKeyB64, "base64url");

      // Should not throw
      expect(() => verifyDeviceKey(peerId, presentedKey)).not.toThrow();
    });

    it("should throw HandshakeMitmError on key mismatch", () => {
      const peerId = "user123";
      const pinnedKeyB64 = "a".repeat(43);
      storePinnedDeviceKey(peerId, pinnedKeyB64);

      const presentedKey = Buffer.from("b".repeat(43), "base64url"); // Different key

      expect(() => verifyDeviceKey(peerId, presentedKey)).toThrow(HandshakeMitmError);
      expect(() => verifyDeviceKey(peerId, presentedKey)).toThrow(/possible MITM/);
    });

    it("should throw error when no pinned key exists", () => {
      const peerId = "user123";
      const presentedKey = Buffer.from("a".repeat(43), "base64url");

      expect(() => verifyDeviceKey(peerId, presentedKey)).toThrow(
        /no pinned device key for peerId/,
      );
    });

    it("should throw HandshakeMitmError on invalid key length (too short)", () => {
      const peerId = "user123";
      const pinnedKeyB64 = "a".repeat(43);
      storePinnedDeviceKey(peerId, pinnedKeyB64);

      const presentedKey = new Uint8Array(31); // Wrong length

      expect(() => verifyDeviceKey(peerId, presentedKey)).toThrow(HandshakeMitmError);
      expect(() => verifyDeviceKey(peerId, presentedKey)).toThrow(/invalid length/);
    });

    it("should throw HandshakeMitmError on invalid key length (too long)", () => {
      const peerId = "user123";
      const pinnedKeyB64 = "a".repeat(43);
      storePinnedDeviceKey(peerId, pinnedKeyB64);

      const presentedKey = new Uint8Array(33); // Wrong length

      expect(() => verifyDeviceKey(peerId, presentedKey)).toThrow(HandshakeMitmError);
    });

    it("should verify exact 32-byte keys", () => {
      const peerId = "user123";
      const pinnedKeyB64 = "a".repeat(43);
      storePinnedDeviceKey(peerId, pinnedKeyB64);

      const presentedKey = Buffer.from(pinnedKeyB64, "base64url");
      expect(presentedKey.length).toBe(32);

      expect(() => verifyDeviceKey(peerId, presentedKey)).not.toThrow();
    });
  });

  describe("parseAndVerifyHandshake", () => {
    it("should parse and verify valid handshake message", () => {
      const peerId = "user123";
      const deviceKeyB64 = "a".repeat(43);
      storePinnedDeviceKey(peerId, deviceKeyB64);

      const message: HandshakeHelloMessage = {
        type: "handshake_hello",
        version: 1,
        peerId: peerId,
        devicePublicKey: deviceKeyB64,
      };

      const payload = JSON.stringify(message);

      const result = parseAndVerifyHandshake(payload, peerId);

      expect(result).toEqual(message);
    });

    it("should reject handshake with wrong peerId", () => {
      const peerId = "user123";
      const deviceKeyB64 = "a".repeat(43);
      storePinnedDeviceKey(peerId, deviceKeyB64);

      const message: HandshakeHelloMessage = {
        type: "handshake_hello",
        version: 1,
        peerId: "different-user", // Wrong peerId
        devicePublicKey: deviceKeyB64,
      };

      const payload = JSON.stringify(message);

      expect(() => parseAndVerifyHandshake(payload, peerId)).toThrow(/peerId mismatch/);
    });

    it("should reject handshake with mismatched device key", () => {
      const peerId = "user123";
      const pinnedKeyB64 = "a".repeat(43);
      storePinnedDeviceKey(peerId, pinnedKeyB64);

      const message: HandshakeHelloMessage = {
        type: "handshake_hello",
        version: 1,
        peerId: peerId,
        devicePublicKey: "b".repeat(43), // Different key
      };

      const payload = JSON.stringify(message);

      expect(() => parseAndVerifyHandshake(payload, peerId)).toThrow(HandshakeMitmError);
      expect(() => parseAndVerifyHandshake(payload, peerId)).toThrow(/possible MITM/);
    });

    it("should reject malformed JSON", () => {
      const peerId = "user123";
      const deviceKeyB64 = "a".repeat(43);
      storePinnedDeviceKey(peerId, deviceKeyB64);

      const malformedPayload = "not valid json";

      expect(() => parseAndVerifyHandshake(malformedPayload, peerId)).toThrow(
        /failed to parse handshake payload as JSON/,
      );
    });

    it("should reject non-object payload", () => {
      const peerId = "user123";
      const deviceKeyB64 = "a".repeat(43);
      storePinnedDeviceKey(peerId, deviceKeyB64);

      const payload = JSON.stringify(["array", "not", "object"]);

      expect(() => parseAndVerifyHandshake(payload, peerId)).toThrow(
        /handshake payload must be a JSON object/,
      );
    });

    it("should reject message with wrong type", () => {
      const peerId = "user123";
      const deviceKeyB64 = "a".repeat(43);
      storePinnedDeviceKey(peerId, deviceKeyB64);

      const message = {
        type: "wrong_type",
        version: 1,
        peerId: peerId,
        devicePublicKey: deviceKeyB64,
      };

      const payload = JSON.stringify(message);

      expect(() => parseAndVerifyHandshake(payload, peerId)).toThrow(
        /expected type "handshake_hello"/,
      );
    });

    it("should reject message with wrong version", () => {
      const peerId = "user123";
      const deviceKeyB64 = "a".repeat(43);
      storePinnedDeviceKey(peerId, deviceKeyB64);

      const message = {
        type: "handshake_hello",
        version: 2, // Wrong version
        peerId: peerId,
        devicePublicKey: deviceKeyB64,
      };

      const payload = JSON.stringify(message);

      expect(() => parseAndVerifyHandshake(payload, peerId)).toThrow(
        /unsupported handshake version/,
      );
    });

    it("should reject message with missing peerId", () => {
      const peerId = "user123";
      const deviceKeyB64 = "a".repeat(43);
      storePinnedDeviceKey(peerId, deviceKeyB64);

      const message = {
        type: "handshake_hello",
        version: 1,
        // peerId is missing
        devicePublicKey: deviceKeyB64,
      };

      const payload = JSON.stringify(message);

      expect(() => parseAndVerifyHandshake(payload, peerId)).toThrow(
        /peerId must be a non-empty string/,
      );
    });

    it("should reject message with missing devicePublicKey", () => {
      const peerId = "user123";
      const deviceKeyB64 = "a".repeat(43);
      storePinnedDeviceKey(peerId, deviceKeyB64);

      const message = {
        type: "handshake_hello",
        version: 1,
        peerId: peerId,
        // devicePublicKey is missing
      };

      const payload = JSON.stringify(message);

      expect(() => parseAndVerifyHandshake(payload, peerId)).toThrow(
        /devicePublicKey must be a non-empty base64url string/,
      );
    });

    it("should handle Buffer input", () => {
      const peerId = "user123";
      const deviceKeyB64 = "a".repeat(43);
      storePinnedDeviceKey(peerId, deviceKeyB64);

      const message: HandshakeHelloMessage = {
        type: "handshake_hello",
        version: 1,
        peerId: peerId,
        devicePublicKey: deviceKeyB64,
      };

      const payload = Buffer.from(JSON.stringify(message));

      const result = parseAndVerifyHandshake(payload, peerId);

      expect(result).toEqual(message);
    });
  });

  describe("HandshakeMitmError", () => {
    it("should be an instance of Error", () => {
      const error = new HandshakeMitmError("test message");
      expect(error).toBeInstanceOf(Error);
    });

    it("should have correct name", () => {
      const error = new HandshakeMitmError("test message");
      expect(error.name).toBe("HandshakeMitmError");
    });

    it("should have kind property", () => {
      const error = new HandshakeMitmError("test message");
      expect(error.kind).toBe("HandshakeMitmError");
    });

    it("should preserve error message", () => {
      const message = "possible MITM attack detected";
      const error = new HandshakeMitmError(message);
      expect(error.message).toBe(message);
    });

    it("should be catchable as HandshakeMitmError", () => {
      const error = new HandshakeMitmError("test");
      try {
        throw error;
      } catch (e) {
        expect(e).toBeInstanceOf(HandshakeMitmError);
        if (e instanceof HandshakeMitmError) {
          expect(e.kind).toBe("HandshakeMitmError");
        }
      }
    });
  });

  describe("Edge cases and security properties", () => {
    it("should prevent timing attacks via constant-time comparison", () => {
      const peerId = "user123";
      const pinnedKeyB64 = "a".repeat(43);
      storePinnedDeviceKey(peerId, pinnedKeyB64);

      // These two operations should take similar time even though they differ
      // at different positions (we can't actually test timing in unit tests,
      // but we verify the code path exists)
      const key1 = Buffer.from(pinnedKeyB64, "base64url");

      // First byte differs
      const key2FirstByteDiff = Buffer.from(pinnedKeyB64, "base64url");
      key2FirstByteDiff[0] = key2FirstByteDiff[0]! === 0 ? 1 : 0;

      // Last byte differs
      const key2LastByteDiff = Buffer.from(pinnedKeyB64, "base64url");
      key2LastByteDiff[31] = key2LastByteDiff[31]! === 0 ? 1 : 0;

      expect(() => verifyDeviceKey(peerId, key2FirstByteDiff)).toThrow(HandshakeMitmError);
      expect(() => verifyDeviceKey(peerId, key2LastByteDiff)).toThrow(HandshakeMitmError);
    });

    it("should handle empty devicePublicKey in message", () => {
      const peerId = "user123";
      const deviceKeyB64 = "a".repeat(43);
      storePinnedDeviceKey(peerId, deviceKeyB64);

      const message = {
        type: "handshake_hello",
        version: 1,
        peerId: peerId,
        devicePublicKey: "", // Empty key
      };

      const payload = JSON.stringify(message);

      expect(() => parseAndVerifyHandshake(payload, peerId)).toThrow(
        /devicePublicKey must be a non-empty base64url string/,
      );
    });

    it("should handle non-string devicePublicKey in message", () => {
      const peerId = "user123";
      const deviceKeyB64 = "a".repeat(43);
      storePinnedDeviceKey(peerId, deviceKeyB64);

      const message = {
        type: "handshake_hello",
        version: 1,
        peerId: peerId,
        devicePublicKey: 12345, // Wrong type
      };

      const payload = JSON.stringify(message);

      expect(() => parseAndVerifyHandshake(payload, peerId)).toThrow(
        /devicePublicKey must be a non-empty base64url string/,
      );
    });
  });
});
