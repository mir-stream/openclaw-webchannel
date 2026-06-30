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
    expirationSeconds: 600,
    pollIntervalSeconds: 5,
  });
};

const validEnrollmentRequest: EnrollmentRequest = {
  agentPublicKey: "mock_public_key_base64url",
  tenant: "test-tenant",
  agentId: "test-agent",
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
        expirationSeconds: 0,
        pollIntervalSeconds: 5,
      });

      const enrollResponse = await shortLivedEnrollment.enroll(validEnrollmentRequest);

      // Wait for expiration
      await new Promise((resolve) => setTimeout(resolve, 100));

      const result = await shortLivedEnrollment.approve(enrollResponse.user_code);
      expect(result).toBeNull();
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
