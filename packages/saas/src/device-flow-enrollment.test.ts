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
import {
  DeviceFlowEnrollment,
  MemoryEnrollmentStore,
  UserCodeCollisionError,
  type EnrollmentStore,
} from "./device-flow-enrollment.js";
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

const createEnrollment = (store?: EnrollmentStore) => {
  return new DeviceFlowEnrollment({
    saasTrustChain: mockTrustChain,
    natsAccountConfig: mockNatsConfig,
    saasBaseUrl: "https://saas.com",
    jwksUrl: "https://saas.com/.well-known/jwks.json",
    bootstrapUrl: "https://saas.com/bootstrap",
    natsUrl: "wss://nats.saas.com",
    expirationSeconds: 600,
    pollIntervalSeconds: 5,
    ...(store ? { store } : {}),
  });
};

// A real 43-char base64url string (base64url of a 32-byte X25519 public key) —
// the exact wire format enroll() now enforces at ingress (#13).
const VALID_AGENT_PUBLIC_KEY = "EpK8GJc3BntN3yEwx5GtfQFyIilwIXaKsrWiqYNkzSo";

const validEnrollmentRequest: EnrollmentRequest = {
  agentPublicKey: VALID_AGENT_PUBLIC_KEY,
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

    // #13: agentPublicKey is the one enroll() field whose content AND size a
    // hostile (unauthenticated) caller controls; it is pinned to the exact
    // 43-char base64url X25519 wire format at ingress, before anything persists.
    describe("agentPublicKey ingress validation", () => {
      const enrollWithKey = (agentPublicKey: string) =>
        enrollment.enroll({ ...validEnrollmentRequest, agentPublicKey });

      const expectRejectedAndUnpersisted = async (agentPublicKey: string) => {
        await expect(enrollWithKey(agentPublicKey)).rejects.toThrow(
          /agentPublicKey must be base64url of a 32-byte X25519 public key/,
        );
        // Nothing was persisted — the guard runs before saveEnrollment.
        const store = enrollment["store"] as MemoryEnrollmentStore;
        expect((store["enrollments"] as Map<string, unknown>).size).toBe(0);
      };

      it("accepts a valid 43-char base64url key", async () => {
        const response = await enrollWithKey("EpK8GJc3BntN3yEwx5GtfQFyIilwIXaKsrWiqYNkzSo");
        expect(response.user_code).toMatch(/^[A-Z]{4}-[A-Z]{4}$/);
      });

      it("rejects a 44-char (too-long) key", async () => {
        await expectRejectedAndUnpersisted("EpK8GJc3BntN3yEwx5GtfQFyIilwIXaKsrWiqYNkzSoX");
      });

      it("rejects a multi-KB key", async () => {
        await expectRejectedAndUnpersisted("A".repeat(4096));
      });

      it("rejects standard-base64 charset (+ / =)", async () => {
        // 43-char length but with non-base64url characters.
        await expectRejectedAndUnpersisted("EpK8GJc3BntN3yEwx5Gtf+FyIilwIXaKsrWiqYNkz/o");
        await expectRejectedAndUnpersisted("EpK8GJc3BntN3yEwx5GtfQFyIilwIXaKsrWiqYNkzS=");
      });

      it("rejects a 42-char (too-short) key", async () => {
        await expectRejectedAndUnpersisted("EpK8GJc3BntN3yEwx5GtfQFyIilwIXaKsrWiqYNkzS");
      });

      it("rejects an empty string", async () => {
        await expectRejectedAndUnpersisted("");
      });
    });

    // #8: a persistent store with UNIQUE(user_code) surfaces a rare collision as
    // UserCodeCollisionError; enroll() re-mints and retries (bounded), and treats
    // ONLY that error as retryable.
    describe("user_code collision retry", () => {
      // A store that delegates to a real MemoryEnrollmentStore but runs a hook on
      // each save (which may throw), and records every attempted enrollment.
      const trackingStore = (saveHook: (e: PendingEnrollment, attempt: number) => void) => {
        const inner = new MemoryEnrollmentStore({ autoSweep: false });
        const saveCalls: PendingEnrollment[] = [];
        const store: EnrollmentStore = {
          async saveEnrollment(e) {
            saveCalls.push(e);
            saveHook(e, saveCalls.length); // may throw
            return inner.saveEnrollment(e);
          },
          getEnrollment: (d) => inner.getEnrollment(d),
          getEnrollmentByUserCode: (u) => inner.getEnrollmentByUserCode(u),
          updateEnrollment: (d, u) => inner.updateEnrollment(d, u),
          deleteEnrollment: (d) => inner.deleteEnrollment(d),
        };
        return { store, saveCalls };
      };

      it("re-mints a fresh user_code and succeeds after one collision", async () => {
        const { store, saveCalls } = trackingStore((_e, attempt) => {
          if (attempt === 1) throw new UserCodeCollisionError("collide");
        });
        const response = await createEnrollment(store).enroll(validEnrollmentRequest);

        expect(response.user_code).toMatch(/^[A-Z]{4}-[A-Z]{4}$/);
        expect(saveCalls).toHaveLength(2);
        // The retry used a DIFFERENT user_code (re-minted, not reused).
        expect(saveCalls[1].user_code).not.toBe(saveCalls[0].user_code);
      });

      it("rejects with UserCodeCollisionError after exactly 5 attempts when it never clears", async () => {
        const { store, saveCalls } = trackingStore(() => {
          throw new UserCodeCollisionError("always");
        });
        await expect(createEnrollment(store).enroll(validEnrollmentRequest)).rejects.toBeInstanceOf(
          UserCodeCollisionError,
        );
        expect(saveCalls).toHaveLength(5);
      });

      it("does NOT retry a non-collision store error — rethrows on the first attempt", async () => {
        const { store, saveCalls } = trackingStore(() => {
          throw new Error("store outage");
        });
        await expect(createEnrollment(store).enroll(validEnrollmentRequest)).rejects.toThrow(
          "store outage",
        );
        expect(saveCalls).toHaveLength(1);
      });

      it("retries a duck-typed collision (plain Error with name = UserCodeCollisionError)", async () => {
        const { store, saveCalls } = trackingStore((_e, attempt) => {
          if (attempt === 1) {
            const err = new Error("duplicate key");
            err.name = "UserCodeCollisionError"; // a different class copy across pkg dup
            throw err;
          }
        });
        await createEnrollment(store).enroll(validEnrollmentRequest);
        expect(saveCalls).toHaveLength(2);
      });
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
        // Delivered issuer: unset in options → derived from saasBaseUrl.
        issuer: "https://saas.com",
      });
    });

    it("delivers an explicit issuer VERBATIM (proxy / logical-issuer deployments)", async () => {
      const customIssuerEnrollment = new DeviceFlowEnrollment({
        saasTrustChain: mockTrustChain,
        natsAccountConfig: mockNatsConfig,
        saasBaseUrl: "https://saas.com",
        jwksUrl: "https://saas.com/.well-known/jwks.json",
        bootstrapUrl: "https://saas.com/bootstrap",
        natsUrl: "wss://nats.saas.com",
        issuer: "https://id.example.com/logical-issuer/",
      });

      const enrollResponse = await customIssuerEnrollment.enroll(validEnrollmentRequest);
      await customIssuerEnrollment.approve(enrollResponse.user_code);
      const pollResult = await customIssuerEnrollment.poll({
        device_code: enrollResponse.device_code,
      });

      // VERBATIM — including the trailing slash. The SaaS declares the exact
      // string it mints; nobody canonicalizes it in transit.
      expect(pollResult).toMatchObject({
        issuer: "https://id.example.com/logical-issuer/",
      });
    });

    it("derives the default issuer with trailing slashes stripped (matches the plugin's deriveIssuer)", async () => {
      const slashEnrollment = new DeviceFlowEnrollment({
        saasTrustChain: mockTrustChain,
        natsAccountConfig: mockNatsConfig,
        saasBaseUrl: "https://saas.com///",
        jwksUrl: "https://saas.com/.well-known/jwks.json",
        bootstrapUrl: "https://saas.com/bootstrap",
        natsUrl: "wss://nats.saas.com",
      });

      const enrollResponse = await slashEnrollment.enroll(validEnrollmentRequest);
      await slashEnrollment.approve(enrollResponse.user_code);
      const pollResult = await slashEnrollment.poll({
        device_code: enrollResponse.device_code,
      });

      expect(pollResult).toMatchObject({ issuer: "https://saas.com" });
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

    // #11: a denied enrollment is terminal — approve must NOT mint creds and
    // flip it back to approved. The operator's deny stands.
    it("returns null and mints nothing when approving a denied enrollment", async () => {
      const enrollResponse = await enrollment.enroll(validEnrollmentRequest);
      await enrollment.deny(enrollResponse.user_code);

      const result = await enrollment.approve(enrollResponse.user_code);
      expect(result).toBeNull();

      const store = enrollment["store"] as MemoryEnrollmentStore;
      const persisted = await store.getEnrollment(enrollResponse.device_code);
      expect(persisted?.status).toBe("denied");
      expect(persisted?.natsCreds).toBeUndefined();
      expect(persisted?.peerId).toBeUndefined();

      // The plugin still sees access_denied on its next poll — no creds leaked.
      const polled = await enrollment.poll({ device_code: enrollResponse.device_code });
      expect("error" in polled && polled.error).toBe("access_denied");
    });

    // #11: the new status guard (not the clock) catches a record already marked
    // `expired` even while its expiresAt still lies in the future.
    it("returns null when approving a record whose status is already expired", async () => {
      const enrollResponse = await enrollment.enroll(validEnrollmentRequest);

      const store = enrollment["store"] as MemoryEnrollmentStore;
      await store.updateEnrollment(enrollResponse.device_code, { status: "expired" });

      const result = await enrollment.approve(enrollResponse.user_code);
      expect(result).toBeNull();

      const persisted = await store.getEnrollment(enrollResponse.device_code);
      expect(persisted?.status).toBe("expired");
      expect(persisted?.natsCreds).toBeUndefined();
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

    // #11: an approved enrollment has live minted credentials — deny must not
    // flip it to denied and make the record lie about a working identity.
    it("returns false and leaves an approved enrollment untouched", async () => {
      const enrollResponse = await enrollment.enroll(validEnrollmentRequest);
      const approved = await enrollment.approve(enrollResponse.user_code);

      const result = await enrollment.deny(enrollResponse.user_code);
      expect(result).toBe(false);

      const store = enrollment["store"] as MemoryEnrollmentStore;
      const persisted = await store.getEnrollment(enrollResponse.device_code);
      expect(persisted?.status).toBe("approved");

      // The originally minted credentials still poll through.
      const polled = await enrollment.poll({ device_code: enrollResponse.device_code });
      expect("peerId" in polled! && polled.peerId).toBe(approved!.peerId);
      expect("creds" in polled! && polled.creds).toEqual(approved!.creds);
    });

    // #11: deny of an already-denied record is a terminal no-op → false.
    it("returns false when denying an already-denied enrollment", async () => {
      const enrollResponse = await enrollment.enroll(validEnrollmentRequest);
      await enrollment.deny(enrollResponse.user_code);

      const result = await enrollment.deny(enrollResponse.user_code);
      expect(result).toBe(false);

      const store = enrollment["store"] as MemoryEnrollmentStore;
      const persisted = await store.getEnrollment(enrollResponse.device_code);
      expect(persisted?.status).toBe("denied");
    });

    // #11: deny of an expired record marks it expired (matching poll()) → false.
    it("returns false and marks an expired enrollment expired", async () => {
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

      const result = await shortLivedEnrollment.deny(enrollResponse.user_code);
      expect(result).toBe(false);

      const store = shortLivedEnrollment["store"] as MemoryEnrollmentStore;
      const persisted = await store.getEnrollment(enrollResponse.device_code);
      expect(persisted?.status).toBe("expired");
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
          userPubkey: "MOCK_PUBKEY",
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

    // #8: saveEnrollment now REFUSES a user_code already held by a different live
    // record (replaces the old silent last-writer-wins that orphaned the loser).
    it("saveEnrollment throws UserCodeCollisionError on a live user_code collision", async () => {
      const store = new MemoryEnrollmentStore({ autoSweep: false });
      const a = makePending({ device_code: "dev-a", user_code: "SAME-CODE" });
      await store.saveEnrollment(a);

      const b = makePending({ device_code: "dev-b", user_code: "SAME-CODE" });
      await expect(store.saveEnrollment(b)).rejects.toBeInstanceOf(UserCodeCollisionError);

      // The holder and its index entry are untouched; the loser was not stored.
      expect((await store.getEnrollmentByUserCode("SAME-CODE"))?.device_code).toBe("dev-a");
      expect(await store.getEnrollment("dev-b")).toBeNull();

      // Re-saving the SAME device_code is idempotent (not a collision).
      await expect(store.saveEnrollment(a)).resolves.toBeUndefined();

      // Once the holder is deleted, the code is free to reuse.
      await store.deleteEnrollment("dev-a");
      await expect(store.saveEnrollment(b)).resolves.toBeUndefined();
      expect((await store.getEnrollmentByUserCode("SAME-CODE"))?.device_code).toBe("dev-b");
    });

    // The sweep-does-not-orphan invariant, under the new no-collision semantics:
    // a swept user_code is free to reuse, and a later sweep must not drop the
    // reusing record's index entry.
    it("a swept user_code is reusable and the reuse survives a later sweep", async () => {
      const store = new MemoryEnrollmentStore({ autoSweep: false });
      const old = makePending({
        device_code: "old",
        user_code: "SAME-CODE",
        expiresAt: 100, // stale — evicted below (100 + 300_000 retention)
      });
      await store.saveEnrollment(old);
      expect(store.sweep(901_001)).toBe(1); // evicts "old" and clears its index

      // The code is free now, so a fresh enrollment may take it (no collision).
      const fresh = makePending({ device_code: "fresh", user_code: "SAME-CODE" });
      await store.saveEnrollment(fresh);

      // A later sweep while "fresh" is still within its window must NOT orphan
      // fresh's index entry (its expiresAt 601_000 + retention → eligible >901_000).
      expect(store.sweep(602_000)).toBe(0);
      expect((await store.getEnrollmentByUserCode("SAME-CODE"))?.device_code).toBe("fresh");
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

    // #8: user codes must be CSPRNG (crypto.getRandomValues), not Math.random,
    // and rejection-sample away the modulo bias.
    it("draws from crypto.getRandomValues and rejects bytes ≥ 252 (rejection sampling)", () => {
      const spy = vi.spyOn(globalThis.crypto, "getRandomValues");
      // First two bytes (252, 253) are in the biased region (≥ 14*18) and MUST be
      // skipped; the code then consumes 0 → alphabet[0] ("B"), 17 → alphabet[17]
      // ("Z"), then 1..6 → C,D,E,G,H,K, with a hyphen after the 4th letter.
      spy.mockImplementation(((arr: Uint8Array): Uint8Array => {
        const seq = [252, 253, 0, 17, 1, 2, 3, 4, 5, 6];
        for (let i = 0; i < arr.length; i++) arr[i] = seq[i] ?? 0;
        return arr;
      }) as typeof globalThis.crypto.getRandomValues);

      const code = (enrollment as unknown as { generateUserCode(): string }).generateUserCode();

      expect(spy).toHaveBeenCalled();
      expect(code).toBe("BZCD-EGHK");
      // Sanity: no ambiguous chars, correct shape.
      expect(code).toMatch(/^[A-Z]{4}-[A-Z]{4}$/);
      spy.mockRestore();
    });

    it("keeps the ABCD-WXYZ format from the CSPRNG path", () => {
      // Real (unmocked) crypto — format invariant must hold.
      const code = (enrollment as unknown as { generateUserCode(): string }).generateUserCode();
      expect(code).toMatch(/^[A-Z]{4}-[A-Z]{4}$/);
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
