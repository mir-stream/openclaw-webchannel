/**
 * Device flow enrollment tests.
 *
 * Tests the RFC 8628 device authorization grant implementation:
 *  - Enrollment request handling
 *  - Poll request handling
 *  - Approval workflow
 *  - Error handling (expired, denied, invalid)
 *  - User code generation
 *  - Device code generation
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { createAccount } from "@nats-io/nkeys";
import { DeviceFlowEnrollment, MemoryEnrollmentStore } from "./device-flow-enrollment.js";
import type { SaasTrustChainPrivate, NatsAccountConfig } from "./types.js";
import type { EnrollmentRequest, PollRequest, PendingEnrollment } from "./device-flow-types.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

// A real account NKEY seed — generateNatsUserCredentials signs user JWTs with
// it via @nats-io/nkeys, which rejects non-NKEY strings ("invalid checksum").
const mockAccountKp = createAccount();
const mockTrustChain: SaasTrustChainPrivate = {
  rsaPrivateKeyPem: "-----BEGIN PRIVATE KEY-----\nMOCK_PRIVATE_KEY\n-----END PRIVATE KEY-----",
  natsAccountSeed: new TextDecoder().decode(mockAccountKp.getSeed()),
};

const mockNatsConfig: NatsAccountConfig = {
  operatorJwt: "MOCK_OPERATOR_JWT",
  accountJwt: "MOCK_ACCOUNT_JWT",
  resolverConfig: {},
  accountPublicKey: "MOCK_ACCOUNT_PUBLIC_KEY",
};

const createEnrollment = () => {
  return new DeviceFlowEnrollment({
    saasTrustChain: mockTrustChain,
    natsAccountConfig: mockNatsConfig,
    saasBaseUrl: "https://saas.com",
    jwksUrl: "https://saas.com/.well-known/jwks.json",
    bootstrapUrl: "https://saas.com/bootstrap",
    natsUrl: "wss://nats.saas.com",
    expirationSeconds: 600,
    pollIntervalSeconds: 5,
  });
};

const validEnrollmentRequest: EnrollmentRequest = {
  agentPublicKey: "mock_public_key_base64url",
  tenant: "test-tenant",
  accountId: "test-agent",
};

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("DeviceFlowEnrollment", () => {
  let enrollment: DeviceFlowEnrollment;

  beforeEach(() => {
    enrollment = createEnrollment();
  });

  describe("enroll()", () => {
    it("should create a pending enrollment", async () => {
      const response = await enrollment.enroll(validEnrollmentRequest);

      expect(response).toMatchObject({
        device_code: expect.any(String),
        user_code: expect.any(String),
        verification_uri: "https://saas.com/enroll",
        verification_uri_complete: expect.stringMatching(/^https:\/\/saas\.com\/enroll\?user_code=/),
        expires_in: 600,
        interval: 5,
      });

      // Verify device code format (base64url)
      expect(response.device_code).toMatch(/^[A-Za-z0-9_-]+$/);

      // Verify user code format (XXXX-XXXX)
      expect(response.user_code).toMatch(/^[A-Z]{4}-[A-Z]{4}$/);
    });

    it("should store pending enrollment with correct metadata", async () => {
      const response = await enrollment.enroll(validEnrollmentRequest);

      const store = enrollment["store"] as MemoryEnrollmentStore;
      const pending = await store.getEnrollment(response.device_code);

      expect(pending).toMatchObject({
        device_code: response.device_code,
        user_code: response.user_code,
        agentPublicKey: validEnrollmentRequest.agentPublicKey,
        tenant: validEnrollmentRequest.tenant,
        status: "pending",
        createdAt: expect.any(Number),
        expiresAt: expect.any(Number),
      });
    });

    it("should generate unique device codes for each enrollment", async () => {
      const response1 = await enrollment.enroll(validEnrollmentRequest);
      const response2 = await enrollment.enroll(validEnrollmentRequest);

      expect(response1.device_code).not.toBe(response2.device_code);
      expect(response1.user_code).not.toBe(response2.user_code);
    });

    it("should use custom expiration and interval when provided", async () => {
      const customEnrollment = new DeviceFlowEnrollment({
        saasTrustChain: mockTrustChain,
        natsAccountConfig: mockNatsConfig,
        saasBaseUrl: "https://saas.com",
        jwksUrl: "https://saas.com/.well-known/jwks.json",
        bootstrapUrl: "https://saas.com/bootstrap",
        natsUrl: "wss://nats.saas.com",
        expirationSeconds: 300, // 5 minutes
        pollIntervalSeconds: 10,
      });

      const response = await customEnrollment.enroll(validEnrollmentRequest);

      expect(response.expires_in).toBe(300);
      expect(response.interval).toBe(10);
    });
  });

  describe("poll()", () => {
    it("should return authorization_pending for new enrollment", async () => {
      const enrollResponse = await enrollment.enroll(validEnrollmentRequest);

      const pollRequest: PollRequest = {
        device_code: enrollResponse.device_code,
      };

      const pollResult = await enrollment.poll(pollRequest);

      expect(pollResult).toEqual({
        error: "authorization_pending",
        error_description: expect.any(String),
      });
    });

    it("should return credentials after approval", async () => {
      const enrollResponse = await enrollment.enroll(validEnrollmentRequest);

      // Approve the enrollment
      await enrollment.approve(enrollResponse.user_code);

      // Poll again
      const pollRequest: PollRequest = {
        device_code: enrollResponse.device_code,
      };

      const pollResult = await enrollment.poll(pollRequest);

      expect(pollResult).toMatchObject({
        creds: {
          userJwt: expect.any(String),
          userSeed: expect.any(String),
          permissions: expect.any(Object),
        },
        peerId: expect.any(String),
        jwksUrl: "https://saas.com/.well-known/jwks.json",
        bootstrapUrl: "https://saas.com/bootstrap",
        natsUrl: "wss://nats.saas.com",
      });
    });

    it("should return invalid_device_code for non-existent enrollment", async () => {
      const pollRequest: PollRequest = {
        device_code: "non_existent_device_code",
      };

      const pollResult = await enrollment.poll(pollRequest);

      expect(pollResult).toEqual({
        error: "invalid_device_code",
        error_description: expect.any(String),
      });
    });

    it("should return expired_token for expired enrollment", async () => {
      // Create enrollment with very short expiration
      const shortLivedEnrollment = new DeviceFlowEnrollment({
        saasTrustChain: mockTrustChain,
        natsAccountConfig: mockNatsConfig,
        saasBaseUrl: "https://saas.com",
        jwksUrl: "https://saas.com/.well-known/jwks.json",
        bootstrapUrl: "https://saas.com/bootstrap",
        natsUrl: "wss://nats.saas.com",
        expirationSeconds: 0, // Expire immediately
        pollIntervalSeconds: 5,
      });

      const enrollResponse = await shortLivedEnrollment.enroll(validEnrollmentRequest);

      // Wait for expiration
      await new Promise((resolve) => setTimeout(resolve, 100));

      const pollRequest: PollRequest = {
        device_code: enrollResponse.device_code,
      };

      const pollResult = await shortLivedEnrollment.poll(pollRequest);

      expect(pollResult).toEqual({
        error: "expired_token",
        error_description: expect.any(String),
      });
    });

    it("should return access_denied for denied enrollment", async () => {
      const enrollResponse = await enrollment.enroll(validEnrollmentRequest);

      // Deny the enrollment
      await enrollment.deny(enrollResponse.user_code);

      // Poll
      const pollRequest: PollRequest = {
        device_code: enrollResponse.device_code,
      };

      const pollResult = await enrollment.poll(pollRequest);

      expect(pollResult).toEqual({
        error: "access_denied",
        error_description: expect.any(String),
      });
    });
  });

  describe("approve()", () => {
    it("should approve pending enrollment and generate credentials", async () => {
      const enrollResponse = await enrollment.enroll(validEnrollmentRequest);

      const approvalResult = await enrollment.approve(enrollResponse.user_code);

      expect(approvalResult).toMatchObject({
        creds: {
          userJwt: expect.any(String),
          userSeed: expect.any(String),
        },
        peerId: expect.any(String),
        jwksUrl: "https://saas.com/.well-known/jwks.json",
        bootstrapUrl: "https://saas.com/bootstrap",
        natsUrl: "wss://nats.saas.com",
      });
    });

    it("should update enrollment status to approved", async () => {
      const enrollResponse = await enrollment.enroll(validEnrollmentRequest);

      await enrollment.approve(enrollResponse.user_code);

      const store = enrollment["store"] as MemoryEnrollmentStore;
      const pending = await store.getEnrollment(enrollResponse.device_code);

      expect(pending?.status).toBe("approved");
      expect(pending?.natsCreds).toBeDefined();
      expect(pending?.peerId).toBeDefined();
    });

    it("should return null for non-existent user code", async () => {
      const result = await enrollment.approve("NON_EXISTENT");
      expect(result).toBeNull();
    });

    it("should return null for expired enrollment", async () => {
      const shortLivedEnrollment = new DeviceFlowEnrollment({
        saasTrustChain: mockTrustChain,
        natsAccountConfig: mockNatsConfig,
        saasBaseUrl: "https://saas.com",
        jwksUrl: "https://saas.com/.well-known/jwks.json",
        bootstrapUrl: "https://saas.com/bootstrap",
        natsUrl: "wss://nats.saas.com",
        expirationSeconds: 0,
        pollIntervalSeconds: 5,
      });

      const enrollResponse = await shortLivedEnrollment.enroll(validEnrollmentRequest);

      // Wait for expiration
      await new Promise((resolve) => setTimeout(resolve, 100));

      const result = await shortLivedEnrollment.approve(enrollResponse.user_code);
      expect(result).toBeNull();
    });

    // A2: approve must be idempotent — a repeat click/retry/replay must NOT
    // re-mint a new identity that would break the plugin's already-live session.
    it("is idempotent: a second approve returns the SAME creds/peerId", async () => {
      const enrollResponse = await enrollment.enroll(validEnrollmentRequest);

      const first = await enrollment.approve(enrollResponse.user_code);
      const second = await enrollment.approve(enrollResponse.user_code);

      expect(first).not.toBeNull();
      expect(second).not.toBeNull();
      expect(second!.peerId).toBe(first!.peerId);
      expect(second!.creds).toEqual(first!.creds);

      // And the persisted record was not overwritten with a fresh identity.
      const store = enrollment["store"] as MemoryEnrollmentStore;
      const persisted = await store.getEnrollment(enrollResponse.device_code);
      expect(persisted?.peerId).toBe(first!.peerId);
      expect(persisted?.natsCreds).toEqual(first!.creds);
    });

    // A2: two CONCURRENT approvals of the same enrollment (double-click race)
    // must coalesce onto one identity, not mint two and last-writer-win.
    it("coalesces concurrent approvals onto a single identity", async () => {
      const enrollResponse = await enrollment.enroll(validEnrollmentRequest);

      const [a, b] = await Promise.all([
        enrollment.approve(enrollResponse.user_code),
        enrollment.approve(enrollResponse.user_code),
      ]);

      expect(a).not.toBeNull();
      expect(b).not.toBeNull();
      expect(a!.peerId).toBe(b!.peerId);
      expect(a!.creds).toEqual(b!.creds);

      // The persisted identity matches what both callers received.
      const store = enrollment["store"] as MemoryEnrollmentStore;
      const persisted = await store.getEnrollment(enrollResponse.device_code);
      expect(persisted?.peerId).toBe(a!.peerId);
    });

    // A2: the plugin's next poll after approval must see the SAME identity the
    // approver returned (this is the invariant a re-mint would violate).
    it("poll after a repeat approve returns the first-minted identity", async () => {
      const enrollResponse = await enrollment.enroll(validEnrollmentRequest);

      const approved = await enrollment.approve(enrollResponse.user_code);
      await enrollment.approve(enrollResponse.user_code); // repeat
      const polled = await enrollment.poll({ device_code: enrollResponse.device_code });

      expect("peerId" in polled! && polled.peerId).toBe(approved!.peerId);
      expect("creds" in polled! && polled.creds).toEqual(approved!.creds);
    });
  });

  describe("deny()", () => {
    it("should deny pending enrollment", async () => {
      const enrollResponse = await enrollment.enroll(validEnrollmentRequest);

      const denied = await enrollment.deny(enrollResponse.user_code);

      expect(denied).toBe(true);
    });

    it("should update enrollment status to denied", async () => {
      const enrollResponse = await enrollment.enroll(validEnrollmentRequest);

      await enrollment.deny(enrollResponse.user_code);

      const store = enrollment["store"] as MemoryEnrollmentStore;
      const pending = await store.getEnrollment(enrollResponse.device_code);

      expect(pending?.status).toBe("denied");
    });

    it("should return false for non-existent user code", async () => {
      const result = await enrollment.deny("NON_EXISTENT");
      expect(result).toBe(false);
    });
  });

  describe("MemoryEnrollmentStore", () => {
    const makePending = (overrides: Partial<PendingEnrollment> = {}): PendingEnrollment => ({
      device_code: "test-device-code",
      user_code: "TEST-CODE",
      agentPublicKey: validEnrollmentRequest.agentPublicKey,
      tenant: validEnrollmentRequest.tenant,
      createdAt: 1_000,
      expiresAt: 601_000,
      status: "pending",
      ...overrides,
    });

    it("should store and retrieve enrollments", async () => {
      const store = new MemoryEnrollmentStore();
      const pending = makePending();
      await store.saveEnrollment(pending);

      const retrieved = await store.getEnrollment(pending.device_code);

      expect(retrieved).toMatchObject({
        device_code: pending.device_code,
        user_code: pending.user_code,
        agentPublicKey: validEnrollmentRequest.agentPublicKey,
      });
    });

    it("should retrieve enrollment by user code", async () => {
      const store = new MemoryEnrollmentStore();
      const pending = makePending();
      await store.saveEnrollment(pending);

      const retrieved = await store.getEnrollmentByUserCode(pending.user_code);

      expect(retrieved?.device_code).toBe(pending.device_code);
    });

    it("should update enrollment", async () => {
      const store = new MemoryEnrollmentStore();
      const pending = makePending();
      await store.saveEnrollment(pending);

      await store.updateEnrollment(pending.device_code, {
        status: "approved",
        natsCreds: {
          userJwt: "MOCK_JWT",
          userSeed: "MOCK_SEED",
        },
      });

      const updated = await store.getEnrollment(pending.device_code);

      expect(updated?.status).toBe("approved");
      expect(updated?.natsCreds).toBeDefined();
    });

    it("should delete enrollment", async () => {
      const store = new MemoryEnrollmentStore();
      const pending = makePending();
      await store.saveEnrollment(pending);

      await store.deleteEnrollment(pending.device_code);

      const deleted = await store.getEnrollment(pending.device_code);
      expect(deleted).toBeNull();
    });

    // ── A1: TTL sweeper bounds memory (review 2026-07-02) ──────────────────
    // makePending() has expiresAt = 601_000; default retention = 300_000, so a
    // record is eligible for eviction once now > 901_000.

    it("sweep() evicts records past expiresAt + retention from BOTH maps", async () => {
      const store = new MemoryEnrollmentStore({ autoSweep: false });
      const pending = makePending();
      await store.saveEnrollment(pending);

      // Just past expiry but INSIDE the grace window — retained so a late poll
      // still sees `expired_token`.
      expect(store.sweep(601_001)).toBe(0);
      expect(await store.getEnrollment(pending.device_code)).not.toBeNull();

      // Past the retention window — evicted from both the device-code map and
      // the user-code index.
      expect(store.sweep(901_001)).toBe(1);
      expect(await store.getEnrollment(pending.device_code)).toBeNull();
      expect(await store.getEnrollmentByUserCode(pending.user_code)).toBeNull();
    });

    it("sweep() leaves not-yet-stale records untouched", async () => {
      const store = new MemoryEnrollmentStore({ autoSweep: false });
      const fresh = makePending({ device_code: "fresh", user_code: "FRESH" });
      const stale = makePending({
        device_code: "stale",
        user_code: "STALE",
        expiresAt: 100, // long past; 100 + 300_000 < now below
      });
      await store.saveEnrollment(fresh);
      await store.saveEnrollment(stale);

      const evicted = store.sweep(601_000); // stale eligible, fresh not
      expect(evicted).toBe(1);
      expect(await store.getEnrollment("stale")).toBeNull();
      expect(await store.getEnrollment("fresh")).not.toBeNull();
    });

    it("sweep() does not orphan a newer enrollment that reuses a swept user_code", async () => {
      const store = new MemoryEnrollmentStore({ autoSweep: false });
      const old = makePending({
        device_code: "old",
        user_code: "SAME-CODE",
        expiresAt: 100, // stale — eligible for eviction below
      });
      await store.saveEnrollment(old);
      // A later enrollment collides on user_code: the index now points at
      // "fresh". Sweeping "old" must NOT delete that index entry.
      const fresh = makePending({ device_code: "fresh", user_code: "SAME-CODE" });
      await store.saveEnrollment(fresh);

      expect(store.sweep(601_000)).toBe(1); // evicts only "old"
      expect(await store.getEnrollment("old")).toBeNull();
      const byUserCode = await store.getEnrollmentByUserCode("SAME-CODE");
      expect(byUserCode?.device_code).toBe("fresh");
    });

    it("close() is idempotent and stops the sweeper", () => {
      const store = new MemoryEnrollmentStore(); // autoSweep on by default
      expect(() => {
        store.close();
        store.close();
      }).not.toThrow();
    });
  });

  describe("User code generation", () => {
    it("should generate unambiguous user codes", async () => {
      const enrollResponse = await enrollment.enroll(validEnrollmentRequest);

      // Check that user code excludes ambiguous characters
      const userCode = enrollResponse.user_code;
      const ambiguousChars = ["0", "O", "1", "I", "L"];

      for (const char of ambiguousChars) {
        expect(userCode).not.toContain(char);
      }
    });

    it("should generate different user codes for each enrollment", async () => {
      const codes = new Set<string>();

      for (let i = 0; i < 100; i++) {
        const response = await enrollment.enroll(validEnrollmentRequest);
        codes.add(response.user_code);
      }

      // With 1.2B possible combinations, 100 should be unique
      expect(codes.size).toBe(100);
    });
  });

  describe("Device code generation", () => {
    it("should generate cryptographically random device codes", async () => {
      const codes = new Set<string>();

      for (let i = 0; i < 100; i++) {
        const response = await enrollment.enroll(validEnrollmentRequest);
        codes.add(response.device_code);
      }

      // All device codes should be unique (256 bits entropy)
      expect(codes.size).toBe(100);
    });

    it("should use base64url encoding for device codes", async () => {
      const response = await enrollment.enroll(validEnrollmentRequest);

      // Base64url uses A-Z, a-z, 0-9, -, _ (no padding)
      expect(response.device_code).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(response.device_code).not.toContain("=");
    });
  });
});
