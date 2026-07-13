/**
 * Plugin enrollment client tests.
 *
 * Tests the plugin-side enrollment flow:
 *  - Identity key generation
 *  - Enrollment initiation
 *  - Polling for approval
 *  - Credential persistence
 *  - Credential loading
 *  - Auto-reconnection
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EnrollmentClient } from "./enrollment-client.js";
import type { EnrollmentOptions } from "./enrollment-client.js";
import { WEBCHANNEL_PROTOCOL_VERSION } from "./protocol.js";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ---------------------------------------------------------------------------
// Test utilities
// ---------------------------------------------------------------------------

const mockFetch = vi.fn();

global.fetch = mockFetch;

const createTestOptions = (override?: Partial<EnrollmentOptions>): EnrollmentOptions => ({
  saasEnrollUrl: "https://saas.com/api/enroll",
  saasPollUrl: "https://saas.com/api/poll",
  tenant: "test-tenant",
  accountId: "test-agent",
  credentialPath: join(tmpdir(), `openclaw-test-${Date.now()}`, "credentials.json"),
  displayInstructions: false,
  _minPollIntervalMs: 0,
  ...override,
});

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("EnrollmentClient", () => {
  let client: EnrollmentClient;
  let credentialPath: string;

  beforeEach(() => {
    // mockReset (not clearAllMocks) also drains any leftover mockResolvedValueOnce
    // queue so an unconsumed response can't leak into the next test's enroll call.
    mockFetch.mockReset();
    global.fetch = mockFetch;

    const options = createTestOptions();
    credentialPath = options.credentialPath!;
    client = new EnrollmentClient(options);

    // Ensure credential directory exists
    const dir = require("node:path").dirname(credentialPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  });

  afterEach(() => {
    // Clean up test credentials
    const dir = require("node:path").dirname(credentialPath);
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  describe("enroll() - first boot", () => {
    it("should generate identity key and initiate enrollment", async () => {
      // Mock enrollment response
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          device_code: "test_device_code",
          user_code: "ABCD-1234",
          verification_uri: "https://saas.com/enroll",
          verification_uri_complete: "https://saas.com/enroll?user_code=ABCD-1234",
          expires_in: 600,
          interval: 5,
        }),
      });

      // Mock poll responses (pending, then success)
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          error: "authorization_pending",
        }),
      }).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          creds: {
            userJwt: "mock_user_jwt",
            userSeed: "mock_user_seed",
            permissions: {
              pub: ["webchannel.test-tenant.outbound.>"],
              sub: ["webchannel.test-tenant.inbound.>"],
            },
          },
          peerId: "mock-peer-id",
          jwksUrl: "https://saas.com/.well-known/jwks.json",
          bootstrapUrl: "https://saas.com/bootstrap",
        }),
      });

      const result = await client.enroll();

      expect(result).toMatchObject({
        creds: {
          userJwt: "mock_user_jwt",
          userSeed: "mock_user_seed",
        },
        peerId: "mock-peer-id",
      });

      // Verify enrollment was called
      expect(mockFetch).toHaveBeenCalledWith(
        "https://saas.com/api/enroll",
        expect.objectContaining({
          method: "POST",
          headers: { "Content-Type": "application/json" },
        }),
      );
    });

    it("should report plugin + protocol version in the enroll POST body", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          device_code: "test_device_code",
          user_code: "ABCD-1234",
          verification_uri: "https://saas.com/enroll",
          verification_uri_complete: "https://saas.com/enroll?user_code=ABCD-1234",
          expires_in: 600,
          interval: 5,
        }),
      }).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          creds: { userJwt: "j", userSeed: "s" },
          peerId: "mock-peer-id",
          jwksUrl: "https://saas.com/.well-known/jwks.json",
          bootstrapUrl: "https://saas.com/bootstrap",
        }),
      });

      await client.enroll();

      // The FIRST fetch is the /enroll POST; its body must carry both version fields.
      const [, init] = mockFetch.mock.calls[0] as [string, { body: string }];
      const body = JSON.parse(init.body) as {
        agentPublicKey: string;
        pluginVersion?: string;
        protocolVersion?: number;
      };
      expect(typeof body.agentPublicKey).toBe("string");
      expect(typeof body.pluginVersion).toBe("string");
      expect(body.protocolVersion).toBe(WEBCHANNEL_PROTOCOL_VERSION);
    });

    it("should poll for approval with correct interval", async () => {
      // This test asserts the RFC 8628 5s interval floor, so it uses the real
      // production floor (overriding the test default of 0) and fake timers to
      // advance virtual time without waiting real seconds.
      vi.useFakeTimers();
      try {
        const intervalClient = new EnrollmentClient(
          createTestOptions({ _minPollIntervalMs: 5000 }),
        );

        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            device_code: "test_device_code",
            user_code: "ABCD-1234",
            verification_uri: "https://saas.com/enroll",
            verification_uri_complete: "https://saas.com/enroll?user_code=ABCD-1234",
            expires_in: 600,
            interval: 5,
          }),
        });

        // First poll: pending
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            error: "authorization_pending",
          }),
        });

        // Second poll: success
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            creds: {
              userJwt: "mock_user_jwt",
              userSeed: "mock_user_seed",
            },
            peerId: "mock-peer-id",
            jwksUrl: "https://saas.com/.well-known/jwks.json",
            bootstrapUrl: "https://saas.com/bootstrap",
          }),
        });

        const enrollPromise = intervalClient.enroll();
        // Drain microtasks + advance past the two 5s poll intervals.
        await vi.advanceTimersByTimeAsync(11_000);
        const result = await enrollPromise;

        expect(result.peerId).toBe("mock-peer-id");
        // Two poll intervals were scheduled (pending → success).
        expect(mockFetch).toHaveBeenCalledTimes(3);
      } finally {
        vi.useRealTimers();
      }
    });

    it("should persist credentials after approval", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          device_code: "test_device_code",
          user_code: "ABCD-1234",
          verification_uri: "https://saas.com/enroll",
          verification_uri_complete: "https://saas.com/enroll?user_code=ABCD-1234",
          expires_in: 600,
          interval: 5,
        }),
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          creds: {
            userJwt: "mock_user_jwt",
            userSeed: "mock_user_seed",
          },
          peerId: "mock-peer-id",
          jwksUrl: "https://saas.com/.well-known/jwks.json",
          bootstrapUrl: "https://saas.com/bootstrap",
        }),
      });

      await client.enroll();

      // Credentials should be persisted
      expect(existsSync(credentialPath)).toBe(true);
    });
  });

  describe("enroll() - reconnection", () => {
    it("should load existing credentials and skip enrollment", async () => {
      // Create mock credentials file
      const mockCredentials = {
        identityKey: {
          publicKey: "mock_public_key",
          privateKey: "mock_private_key",
        },
        enrollment: {
          creds: {
            userJwt: "stored_user_jwt",
            userSeed: "stored_user_seed",
          },
          peerId: "stored-peer-id",
          jwksUrl: "https://saas.com/.well-known/jwks.json",
          bootstrapUrl: "https://saas.com/bootstrap",
        },
        tenant: "test-tenant",
        saasEnrollUrl: "https://saas.com/api/enroll",
        saasPollUrl: "https://saas.com/api/poll",
      };

      require("node:fs").writeFileSync(
        credentialPath,
        JSON.stringify(mockCredentials, null, 2),
      );

      // Enrollment should skip to existing credentials
      const result = await client.enroll();

      expect(result).toMatchObject({
        creds: {
          userJwt: "stored_user_jwt",
          userSeed: "stored_user_seed",
        },
        peerId: "stored-peer-id",
      });

      // Should NOT have called SaaS endpoints
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe("getIdentityKey()", () => {
    it("should return cached identity key after enrollment", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          device_code: "test_device_code",
          user_code: "ABCD-1234",
          verification_uri: "https://saas.com/enroll",
          verification_uri_complete: "https://saas.com/enroll?user_code=ABCD-1234",
          expires_in: 600,
          interval: 5,
        }),
      });

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          creds: {
            userJwt: "mock_user_jwt",
            userSeed: "mock_user_seed",
          },
          peerId: "mock-peer-id",
          jwksUrl: "https://saas.com/.well-known/jwks.json",
          bootstrapUrl: "https://saas.com/bootstrap",
        }),
      });

      await client.enroll();

      const identityKey = client.getIdentityKey();

      expect(identityKey).toMatchObject({
        publicKey: expect.any(Uint8Array),
        privateKey: expect.any(Uint8Array),
      });

      // X25519 keys are 32 bytes
      expect(identityKey.publicKey.length).toBe(32);
      expect(identityKey.privateKey.length).toBe(32);
    });

    it("should generate new identity key if not cached", () => {
      const key = client.getIdentityKey();

      expect(key).toMatchObject({
        publicKey: expect.any(Uint8Array),
        privateKey: expect.any(Uint8Array),
      });

      // X25519 keys are 32 bytes
      expect(key.publicKey.length).toBe(32);
      expect(key.privateKey.length).toBe(32);
    });
  });

  describe("getNatsCredentials()", () => {
    it("should return NATS credentials after enrollment", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          device_code: "test_device_code",
          user_code: "ABCD-1234",
          verification_uri: "https://saas.com/enroll",
          verification_uri_complete: "https://saas.com/enroll?user_code=ABCD-1234",
          expires_in: 600,
          interval: 5,
        }),
      });

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          creds: {
            userJwt: "mock_user_jwt",
            userSeed: "mock_user_seed",
            permissions: {
              pub: ["webchannel.test-tenant.outbound.>"],
              sub: ["webchannel.test-tenant.inbound.>"],
            },
          },
          peerId: "mock-peer-id",
          jwksUrl: "https://saas.com/.well-known/jwks.json",
          bootstrapUrl: "https://saas.com/bootstrap",
        }),
      });

      await client.enroll();

      const creds = client.getNatsCredentials();

      expect(creds).toMatchObject({
        userJwt: "mock_user_jwt",
        userSeed: "mock_user_seed",
        permissions: expect.any(Object),
      });
    });

    it("should return undefined before enrollment", () => {
      const creds = client.getNatsCredentials();
      expect(creds).toBeUndefined();
    });
  });

  describe("getPeerId()", () => {
    it("should return peer ID after enrollment", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          device_code: "test_device_code",
          user_code: "ABCD-1234",
          verification_uri: "https://saas.com/enroll",
          verification_uri_complete: "https://saas.com/enroll?user_code=ABCD-1234",
          expires_in: 600,
          interval: 5,
        }),
      });

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          creds: {
            userJwt: "mock_user_jwt",
            userSeed: "mock_user_seed",
          },
          peerId: "mock-peer-id",
          jwksUrl: "https://saas.com/.well-known/jwks.json",
          bootstrapUrl: "https://saas.com/bootstrap",
        }),
      });

      await client.enroll();

      const peerId = client.getPeerId();
      expect(peerId).toBe("mock-peer-id");
    });

    it("should return undefined before enrollment", () => {
      const peerId = client.getPeerId();
      expect(peerId).toBeUndefined();
    });
  });

  describe("Error handling", () => {
    it("should throw on HTTP error", async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => "Internal Server Error",
      });

      await expect(client.enroll()).rejects.toThrow("HTTP 500");
    });

    it("should throw on enrollment denial", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          device_code: "test_device_code",
          user_code: "ABCD-1234",
          verification_uri: "https://saas.com/enroll",
          verification_uri_complete: "https://saas.com/enroll?user_code=ABCD-1234",
          expires_in: 600,
          interval: 5,
        }),
      });

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          error: "access_denied",
          error_description: "Enrollment was denied by operator",
        }),
      });

      await expect(client.enroll()).rejects.toThrow("Enrollment failed");
    });

    it("should throw on enrollment expiration", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          device_code: "test_device_code",
          user_code: "ABCD-1234",
          verification_uri: "https://saas.com/enroll",
          verification_uri_complete: "https://saas.com/enroll?user_code=ABCD-1234",
          expires_in: 1, // 1 second
          interval: 5,
        }),
      });

      // Poll responses: pending, pending, expired
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          error: "authorization_pending",
        }),
      });

      // Wait for expiration
      await new Promise((resolve) => setTimeout(resolve, 2000));

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          error: "expired_token",
          error_description: "Device code has expired",
        }),
      });

      await expect(client.enroll()).rejects.toThrow("Enrollment failed");
    });
  });

  describe("Credential persistence", () => {
    it("should create credential directory if missing", async () => {
      const options = createTestOptions({
        credentialPath: join(tmpdir(), `openclaw-test-${Date.now()}-nested`, "nested", "credentials.json"),
      });

      const nestedClient = new EnrollmentClient(options);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          device_code: "test_device_code",
          user_code: "ABCD-1234",
          verification_uri: "https://saas.com/enroll",
          verification_uri_complete: "https://saas.com/enroll?user_code=ABCD-1234",
          expires_in: 600,
          interval: 5,
        }),
      });

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          creds: {
            userJwt: "mock_user_jwt",
            userSeed: "mock_user_seed",
          },
          peerId: "mock-peer-id",
          jwksUrl: "https://saas.com/.well-known/jwks.json",
          bootstrapUrl: "https://saas.com/bootstrap",
        }),
      });

      await nestedClient.enroll();

      // Should have created nested directories
      expect(existsSync(options.credentialPath!)).toBe(true);

      // Cleanup
      const dir = require("node:path").dirname(options.credentialPath!);
      require("node:fs").rmSync(dir, { recursive: true, force: true });
    });

    it("should set restrictive permissions on credential file", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          device_code: "test_device_code",
          user_code: "ABCD-1234",
          verification_uri: "https://saas.com/enroll",
          verification_uri_complete: "https://saas.com/enroll?user_code=ABCD-1234",
          expires_in: 600,
          interval: 5,
        }),
      });

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          creds: {
            userJwt: "mock_user_jwt",
            userSeed: "mock_user_seed",
          },
          peerId: "mock-peer-id",
          jwksUrl: "https://saas.com/.well-known/jwks.json",
          bootstrapUrl: "https://saas.com/bootstrap",
        }),
      });

      await client.enroll();

      // Check file permissions (0o600 = rw-------)
      const stats = require("node:fs").statSync(credentialPath);
      const mode = stats.mode & 0o777;

      expect(mode).toBe(0o600);
    });
  });
});
