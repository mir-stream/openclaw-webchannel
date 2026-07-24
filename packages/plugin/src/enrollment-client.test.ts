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
import {
  mkdirSync,
  rmSync,
  existsSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { accountCredentialPath, legacyCredentialPath } from "./account-config.js";
import { MemoryEnrollmentRepository } from "../../saas/src/enrollment-repository.js";
import { DeviceFlowEnrollment } from "../../saas/src/device-flow-enrollment.js";
import {
  CREDENTIAL_BINDING_IDENTITY_FIELD,
  createCredentialIdentityForEnrollment,
} from "./credential-document.js";

// ---------------------------------------------------------------------------
// Test utilities
// ---------------------------------------------------------------------------

const mockFetch = vi.fn();

global.fetch = mockFetch;

const createTestOptions = (override?: Partial<EnrollmentOptions>): EnrollmentOptions => ({
  saasBaseUrl: "https://saas.com",
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
    it("25: accepts a final poll that reaches the server just after expiresAt", async () => {
      let repositoryNow = 1_001;
      const repository = new MemoryEnrollmentRepository({ autoSweep: false, retentionMs: 50, clock: () => repositoryNow });
      const boundaryResult = { creds: { userJwt: "boundary-jwt", userSeed: "boundary-seed", userPubkey: "boundary-pub" }, peerId: "boundary-peer" };
      await repository.createEnrollment({
        device_code: "boundary-device", user_code: "BOUND-ARY1", agentPublicKey: "A".repeat(43), tenant: "test-tenant", accountId: "test-agent",
        createdAt: 0, expiresAt: 1_000, status: "approved", approvedAt: 999, natsCreds: boundaryResult.creds, peerId: boundaryResult.peerId,
      });
      const saas = new DeviceFlowEnrollment({
        repository,
        saasTrustChain: { rsaPrivateKeyPem: "unused", natsAccountSeed: "unused" },
        natsAccountConfig: { operatorJwt: "unused", accountJwt: "unused", resolverConfig: {}, accountPublicKey: "unused" },
        saasBaseUrl: "https://saas.com", jwksUrl: "https://saas.com/jwks", bootstrapUrl: "https://saas.com/bootstrap", natsUrl: "wss://nats.saas.com",
      });
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({
        device_code: "boundary-device", user_code: "BOUND-ARY1",
        verification_uri: "https://saas.com/enroll", verification_uri_complete: "https://saas.com/enroll?user_code=BOUND-ARY1",
        expires_in: 1, interval: 0,
      }) });
      const now = vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValueOnce(999).mockReturnValue(1_001);
      mockFetch.mockImplementationOnce(async () => {
        // This is a fixture transport, but the response itself comes from the
        // shipped DeviceFlowEnrollment + repository transition, not a canned
        // success. Repository time is already beyond expiresAt.
        expect(Date.now()).toBeGreaterThan(1_000);
        repositoryNow = 1_001;
        const response = await saas.poll({ device_code: "boundary-device" });
        return { ok: !("error" in response), json: async () => response };
      });
      await expect(client.enroll()).resolves.toMatchObject({ peerId: "boundary-peer" });
      expect(mockFetch).toHaveBeenCalledTimes(2); now.mockRestore();
    });

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
        protocolVersion: number;
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
      const persisted = JSON.parse(readFileSync(credentialPath, "utf8")) as Record<
        string,
        any
      >;
      expect(persisted[CREDENTIAL_BINDING_IDENTITY_FIELD]).toEqual(
        createCredentialIdentityForEnrollment({
          tenant: "test-tenant",
          accountId: "test-agent",
          saasBaseUrl: "https://saas.com",
          agentPublicKey: persisted.identityKey.publicKey,
        }),
      );
    });
  });

  describe("enroll() - reconnection", () => {
    it("should load existing credentials and skip enrollment", async () => {
      const key = Buffer.alloc(32, 7).toString("base64url");
      // Create mock credentials file
      const mockCredentials = {
        [CREDENTIAL_BINDING_IDENTITY_FIELD]:
          createCredentialIdentityForEnrollment({
            tenant: "test-tenant",
            accountId: "test-agent",
            saasBaseUrl: "https://saas.com",
            agentPublicKey: key,
          }),
        identityKey: {
          publicKey: key,
          privateKey: key,
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
        accountId: "test-agent",
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

    it("rejects a legacy unbound file without enrollment or overwrite", async () => {
      const key = Buffer.alloc(32, 7).toString("base64url");
      const legacy = {
        identityKey: { publicKey: key, privateKey: key },
        enrollment: {
          creds: { userJwt: "LEGACY-JWT", userSeed: "LEGACY-SEED" },
          peerId: "legacy",
          jwksUrl: "https://saas.com/jwks",
          bootstrapUrl: "https://saas.com/bootstrap",
        },
        accountId: "test-agent",
        tenant: "test-tenant",
        saasEnrollUrl: "https://saas.com/api/enroll",
        saasPollUrl: "https://saas.com/api/poll",
      };
      writeFileSync(credentialPath, JSON.stringify(legacy));
      const before = readFileSync(credentialPath, "utf8");

      await expect(client.enroll()).rejects.toMatchObject({
        code: "credentials-unbound",
      });
      expect(mockFetch).not.toHaveBeenCalled();
      expect(readFileSync(credentialPath, "utf8")).toBe(before);
    });
  });

  describe("P1-1 offline re-key", () => {
    const queueSuccessfulEnrollment = (peerId: string) => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          device_code: `device-${peerId}`,
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
          creds: { userJwt: `jwt-${peerId}`, userSeed: `seed-${peerId}` },
          peerId,
          jwksUrl: "https://saas.com/.well-known/jwks.json",
          bootstrapUrl: "https://saas.com/bootstrap",
          natsUrl: "wss://nats.saas.com",
        }),
      });
    };

    it("24: archiving an explicit credentialPath preserves old material and permits a fresh identity", async () => {
      queueSuccessfulEnrollment("first");
      await client.enroll();
      const firstKey = Buffer.from(client.getIdentityKey().publicKey).toString("hex");
      const archivePath = `${credentialPath}.archive`;
      renameSync(credentialPath, archivePath);

      const replacement = new EnrollmentClient(createTestOptions({ credentialPath }));
      queueSuccessfulEnrollment("second");
      await replacement.enroll();
      const secondKey = Buffer.from(replacement.getIdentityKey().publicKey).toString("hex");

      expect(secondKey).not.toBe(firstKey);
      expect(existsSync(archivePath)).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(4);
    });

    it("24: archive-first replacement covers every path shape without key reuse", async () => {
      const fixtureHome = join(tmpdir(), `openclaw-reset-${Date.now()}`);
      const cases = [
        { name: "default-layout", path: accountCredentialPath("acct", fixtureHome), legacy: false },
        { name: "explicit-override", path: join(fixtureHome, "override.json"), legacy: false },
        { name: "default", path: accountCredentialPath("default", fixtureHome), legacy: true },
      ];
      try {
        for (const scenario of cases) {
          mockFetch.mockReset();
          const pathOptions = scenario.legacy
            ? { credentialPath: undefined, _home: fixtureHome }
            : { credentialPath: scenario.path };
          const firstClient = new EnrollmentClient(createTestOptions({ accountId: scenario.name, ...pathOptions }));
          queueSuccessfulEnrollment(`${scenario.name}-old`);
          await firstClient.enroll();
          const oldKey = Buffer.from(firstClient.getIdentityKey().publicKey).toString("base64url");
          const registry = new MemoryEnrollmentRepository();
          expect((await registry.register("test-tenant", scenario.name, oldKey, null)).ok).toBe(true);
          expect(await registry.revokeActive("test-tenant", scenario.name)).toBe(true);

          let legacyArchive: string | undefined;
          if (scenario.legacy) {
            const legacy = legacyCredentialPath(fixtureHome);
            mkdirSync(join(fixtureHome, ".openclaw-webchannel"), { recursive: true });
            writeFileSync(legacy, JSON.stringify({
              identityKey: { publicKey: oldKey, privateKey: oldKey },
              enrollment: { creds: { userJwt: "legacy", userSeed: "legacy" } },
            }));
            legacyArchive = `${legacy}.archive-${scenario.name}`;
            renameSync(legacy, legacyArchive);
          }
          const archivePath = `${scenario.path}.archive-${scenario.name}`;
          renameSync(scenario.path, archivePath);

          let incomingKey = "";
          mockFetch.mockImplementationOnce(async (_url, init) => {
            incomingKey = (JSON.parse(String(init?.body)) as { agentPublicKey: string }).agentPublicKey;
            const registration = await registry.register("test-tenant", scenario.name, incomingKey, null);
            expect(registration.ok, scenario.name).toBe(true);
            return { ok: true, json: async () => ({ device_code: `device-${scenario.name}`, user_code: "RESET-1234", verification_uri: "https://saas.com/enroll", verification_uri_complete: "https://saas.com/enroll?user_code=RESET-1234", expires_in: 600, interval: 0 }) };
          });
          mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ creds: { userJwt: "new-jwt", userSeed: "new-seed" }, peerId: `new-${scenario.name}`, jwksUrl: "https://saas.com/jwks", bootstrapUrl: "https://saas.com/bootstrap", natsUrl: "wss://nats.saas.com" }) });
          const replacement = new EnrollmentClient(createTestOptions({ accountId: scenario.name, ...pathOptions }));
          await replacement.enroll();
          expect(incomingKey).not.toBe(oldKey);
          expect((await registry.getActive("test-tenant", scenario.name))?.publicKey).toBe(incomingKey);
          expect(existsSync(archivePath)).toBe(true);
          if (legacyArchive) expect(existsSync(legacyArchive)).toBe(true);
          expect(mockFetch).toHaveBeenCalledTimes(4);
        }
      } finally {
        rmSync(fixtureHome, { recursive: true, force: true });
      }
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

    it("does not persist a malformed successful enrollment payload", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          device_code: "test_device_code",
          user_code: "ABCD-1234",
          verification_uri: "https://saas.com/enroll",
          verification_uri_complete:
            "https://saas.com/enroll?user_code=ABCD-1234",
          expires_in: 600,
          interval: 5,
        }),
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          creds: {
            userJwt: "SECRET-JWT",
            userSeed: "SECRET-SEED",
          },
          peerId: "mock-peer-id",
          jwksUrl: "https://saas.com/.well-known/jwks.json",
          bootstrapUrl: "https://saas.com/bootstrap",
          // Untrusted JSON can violate the TypeScript response shape.
          natsUrl: null,
        }),
      });

      await expect(client.enroll()).rejects.toMatchObject({
        code: "credentials-invalid-invalid-document",
        fields: ["enrollment.natsUrl"],
      });
      expect(existsSync(credentialPath)).toBe(false);
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
