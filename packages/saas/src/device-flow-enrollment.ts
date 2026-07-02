/**
 * RFC 8628 Device Authorization Grant implementation for WebChannel plugin enrollment.
 *
 * This module provides the core enrollment logic:
 *  - Enrollment request handling (/enroll endpoint)
 *  - Poll request handling (/poll endpoint)
 *  - Approval workflow
 *  - NATS user credential generation
 *  - Enrollment state management
 *
 * SECURITY PROPERTIES:
 *  - Plugin is ingress-free (outbound-only)
 *  - No secret pasting (operator approval via web UI)
 *  - Short-lived device codes (configurable expiration)
 *  - Cryptographically random user codes
 *  - TLS-only transmission
 *  - Agent public key binding (cnf in bootstrap JWT)
 */

import type {
  EnrollmentRequest,
  EnrollmentResponse,
  PollRequest,
  PendingEnrollment,
  NatsUserCredentials,
  EnrollmentResult,
  DeviceFlowError,
} from "./device-flow-types.js";
import type { SaasTrustChainPrivate, NatsAccountConfig } from "./types.js";
import { assertValidSubjectToken } from "./subject-token.js";
import { mintNatsUserCreds } from "./nats-user-creds.js";

// ---------------------------------------------------------------------------
// Configuration constants
// ---------------------------------------------------------------------------

/**
 * Default enrollment expiration time (10 minutes).
 * Configurable via DeviceFlowOptions.expirationSeconds.
 */
const DEFAULT_EXPIRATION_SECONDS = 600;

/**
 * Minimum polling interval (RFC 8628).
 * Prevents plugins from overwhelming the server with too-frequent polls.
 */
const MIN_POLL_INTERVAL_SECONDS = 5;

/**
 * User code alphabet (ambiguous characters removed).
 * Excludes: 0/O, 1/I/L to avoid confusion.
 */
const USER_CODE_ALPHABET = "BCDEGHKMNPQRSTVWXZ";

/**
 * User code format (2 groups of 4 characters: "ABCD-WXYZ").
 * 8 characters provide ~1.2B combinations (sufficient for security).
 */
const USER_CODE_FORMAT = "XXXX-XXXX";

/**
 * Device code entropy (256 bits = 32 bytes).
 * Cryptographically random, base64url-encoded.
 */
const DEVICE_CODE_BYTES = 32;

/**
 * How often the in-memory store's background sweeper runs (default 60s).
 */
const DEFAULT_SWEEP_INTERVAL_MS = 60_000;

/**
 * How long past `expiresAt` an enrollment is retained before eviction
 * (default 5 min). A grace window so a plugin polling shortly after expiry
 * still observes the correct `expired_token` error rather than the confusing
 * `invalid_device_code` ("not found"). After the window the record is reclaimed.
 */
const DEFAULT_RETENTION_MS = 300_000;

// ---------------------------------------------------------------------------
// Enrollment store interface
// ---------------------------------------------------------------------------

/**
 * Enrollment store interface.
 *
 * Implementations can be in-memory (for testing) or persistent (Redis, DB, etc.)
 */
export interface EnrollmentStore {
  /**
   * Store a pending enrollment.
   */
  saveEnrollment(enrollment: PendingEnrollment): Promise<void>;

  /**
   * Retrieve enrollment by device code.
   */
  getEnrollment(deviceCode: string): Promise<PendingEnrollment | null>;

  /**
   * Retrieve enrollment by user code (for approval UI).
   */
  getEnrollmentByUserCode(userCode: string): Promise<PendingEnrollment | null>;

  /**
   * Update enrollment (status, credentials, etc.).
   */
  updateEnrollment(deviceCode: string, updates: Partial<PendingEnrollment>): Promise<void>;

  /**
   * Clean up expired enrollments.
   */
  deleteEnrollment(deviceCode: string): Promise<void>;
}

/**
 * Options for {@link MemoryEnrollmentStore}.
 */
export type MemoryEnrollmentStoreOptions = {
  /** Background sweep cadence in ms. Default 60_000. */
  sweepIntervalMs?: number;
  /**
   * Retention past `expiresAt` before an enrollment is evicted, in ms.
   * Default 300_000 (5 min grace window). See {@link DEFAULT_RETENTION_MS}.
   */
  retentionMs?: number;
  /**
   * Start the background interval sweeper automatically (default `true`).
   * Set `false` in tests that want to drive {@link MemoryEnrollmentStore.sweep}
   * deterministically without a live timer.
   */
  autoSweep?: boolean;
};

/**
 * In-memory enrollment store implementation.
 *
 * Suitable for single-process deployments. For multi-process, use a persistent
 * store (Redis, database, etc.) that implements the EnrollmentStore interface.
 *
 * Review 2026-07-02 (A1): a background TTL sweeper bounds memory. Without it the
 * `enrollments`/`userCodeIndex` maps grew forever — expired, denied, and consumed
 * records were never removed and `deleteEnrollment` had no caller — so an
 * UNAUTHENTICATED `/enroll` endpoint was an OOM vector (each request added an
 * entry that never left). The sweeper evicts every record once its `expiresAt`
 * plus a grace window has elapsed, regardless of status, so a long-lived issuer's
 * footprint stays bounded even under sustained (or hostile) enrollment traffic.
 */
export class MemoryEnrollmentStore implements EnrollmentStore {
  private readonly enrollments = new Map<string, PendingEnrollment>();
  private readonly userCodeIndex = new Map<string, string>(); // user_code -> device_code
  private readonly retentionMs: number;
  private readonly sweepIntervalMs: number;
  private sweepTimer: ReturnType<typeof setInterval> | undefined;

  constructor(options: MemoryEnrollmentStoreOptions = {}) {
    this.retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS;
    this.sweepIntervalMs = options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    if (options.autoSweep ?? true) this.startSweeper();
  }

  /**
   * Evict every enrollment whose retention window (`expiresAt + retentionMs`)
   * has fully elapsed, in BOTH maps. Pure and deterministic — pass `now` in
   * tests. Returns the number of records evicted. Deleting from a Map during
   * its own iteration is well-defined in JS.
   */
  sweep(now: number = Date.now()): number {
    let evicted = 0;
    for (const [deviceCode, enrollment] of this.enrollments) {
      if (now > enrollment.expiresAt + this.retentionMs) {
        this.userCodeIndex.delete(enrollment.user_code);
        this.enrollments.delete(deviceCode);
        evicted++;
      }
    }
    return evicted;
  }

  /**
   * Start the background sweeper. The timer is `unref`'d so it NEVER keeps the
   * process alive on its own (a long-lived issuer exits cleanly on SIGINT).
   * Idempotent.
   */
  startSweeper(): void {
    if (this.sweepTimer) return;
    const timer = setInterval(() => {
      this.sweep();
    }, this.sweepIntervalMs);
    if (typeof timer.unref === "function") timer.unref();
    this.sweepTimer = timer;
  }

  /**
   * Stop the background sweeper. Call on shutdown (or in tests that started it).
   * Idempotent.
   */
  close(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }
  }

  async saveEnrollment(enrollment: PendingEnrollment): Promise<void> {
    this.enrollments.set(enrollment.device_code, enrollment);
    this.userCodeIndex.set(enrollment.user_code, enrollment.device_code);
  }

  async getEnrollment(deviceCode: string): Promise<PendingEnrollment | null> {
    return this.enrollments.get(deviceCode) ?? null;
  }

  async getEnrollmentByUserCode(userCode: string): Promise<PendingEnrollment | null> {
    const deviceCode = this.userCodeIndex.get(userCode);
    if (!deviceCode) return null;
    return this.enrollments.get(deviceCode) ?? null;
  }

  async updateEnrollment(deviceCode: string, updates: Partial<PendingEnrollment>): Promise<void> {
    const existing = this.enrollments.get(deviceCode);
    if (!existing) return;
    const updated = { ...existing, ...updates };
    this.enrollments.set(deviceCode, updated);
  }

  async deleteEnrollment(deviceCode: string): Promise<void> {
    const enrollment = this.enrollments.get(deviceCode);
    if (enrollment) {
      this.userCodeIndex.delete(enrollment.user_code);
    }
    this.enrollments.delete(deviceCode);
  }
}

// ---------------------------------------------------------------------------
// Configuration types
// ---------------------------------------------------------------------------

/**
 * Device flow enrollment options.
 */
export type DeviceFlowOptions = {
  /**
   * SaaS trust chain private material (RS256 key + NATS account seed).
   * Used to sign NATS user JWTs.
   */
  saasTrustChain: SaasTrustChainPrivate;

  /**
   * NATS account configuration (from setupTrustChain).
   * Contains account JWT and resolver config for credential generation.
   */
  natsAccountConfig: NatsAccountConfig;

  /**
   * Account IDENTITY public NKEY (`A…`) for an externally-managed NATS account
   * (Synadia Cloud / NGS). When set, the agent's minted user JWT is signed by
   * `saasTrustChain.natsAccountSeed` (treated as a signing key) and stamped with
   * `nats.issuer_account` = this id. Unset → self-signed self-contained mode.
   *
   * In external mode this is `natsAccountConfig.accountPublicKey`.
   */
  natsIssuerAccountId?: string;

  /**
   * Enrollment expiration time in seconds (default: 600 = 10 minutes).
   */
  expirationSeconds?: number;

  /**
   * Polling interval in seconds (default: 5).
   * Minimum 5 per RFC 8628.
   */
  pollIntervalSeconds?: number;

  /**
   * SaaS base URL (for verification URI construction).
   * Example: "https://saas.com"
   */
  saasBaseUrl: string;

  /**
   * JWKS endpoint URL (for bootstrap JWT verification).
   * Example: "https://saas.com/.well-known/jwks.json"
   */
  jwksUrl: string;

  /**
   * Bootstrap endpoint URL (for browser bootstrap JWT requests).
   * Example: "https://saas.com/bootstrap"
   */
  bootstrapUrl: string;

  /**
   * NATS WebSocket URL the enrolled plugin must dial. Delivered to the plugin in
   * the `EnrollmentResult` so the relay location travels with the minted creds
   * (the SaaS is the rendezvous authority — the URL is not plugin-side config).
   * Example: "wss://nats.saas.com"
   */
  natsUrl: string;

  /**
   * Enrollment store (defaults to in-memory).
   * Use a persistent store (Redis, DB) for production deployments.
   */
  store?: EnrollmentStore;
};

// ---------------------------------------------------------------------------
// Core enrollment service
// ---------------------------------------------------------------------------

/**
 * Device flow enrollment service.
 *
 * Handles RFC 8628 device authorization grants for plugin enrollment.
 */
export class DeviceFlowEnrollment {
  // `natsIssuerAccountId` stays optional (external mode only); everything else
  // is defaulted, hence Required.
  private readonly options: Required<Omit<DeviceFlowOptions, "store" | "natsIssuerAccountId">> &
    Pick<DeviceFlowOptions, "natsIssuerAccountId">;
  private readonly store: EnrollmentStore;

  constructor(options: DeviceFlowOptions) {
    this.options = {
      expirationSeconds: DEFAULT_EXPIRATION_SECONDS,
      pollIntervalSeconds: MIN_POLL_INTERVAL_SECONDS,
      ...options,
    };
    this.store = options.store ?? new MemoryEnrollmentStore();
  }

  /**
   * Handle an enrollment request from a plugin.
   *
   * Creates a pending enrollment and returns a device code and user code.
   * The plugin polls /poll until the operator approves the enrollment.
   */
  async enroll(request: EnrollmentRequest): Promise<EnrollmentResponse> {
    // Reject tenant/accountId tokens that would break the NATS subject hierarchy
    // or cross tenant boundaries before they are persisted or used in a grant.
    assertValidSubjectToken(request.tenant, "tenant");
    if (request.accountId !== undefined) {
      assertValidSubjectToken(request.accountId, "accountId");
    }
    const device_code = await this.generateDeviceCode();
    const user_code = this.generateUserCode();
    const now = Date.now();
    const expiresAt = now + this.options.expirationSeconds * 1000;

    const enrollment: PendingEnrollment = {
      device_code,
      user_code,
      agentPublicKey: request.agentPublicKey,
      accountId: request.accountId,
      tenant: request.tenant,
      createdAt: now,
      expiresAt,
      status: "pending",
    };

    await this.store.saveEnrollment(enrollment);

    const verification_uri = `${this.options.saasBaseUrl}/enroll`;
    const verification_uri_complete = `${verification_uri}?user_code=${user_code}`;

    return {
      device_code,
      user_code,
      verification_uri,
      verification_uri_complete,
      expires_in: this.options.expirationSeconds,
      interval: this.options.pollIntervalSeconds,
    };
  }

  /**
   * Handle a poll request from a plugin.
   *
   * Returns:
   *  - HTTP 200 + EnrollmentResult if approved
   *  - HTTP 400 + { error: "authorization_pending" } if still pending
   *  - HTTP 400 + error details if denied/expired/invalid
   */
  async poll(request: PollRequest): Promise<EnrollmentResult | DeviceFlowError> {
    const enrollment = await this.store.getEnrollment(request.device_code);
    if (!enrollment) {
      return { error: "invalid_device_code", error_description: "Device code not found" };
    }

    // Check expiration
    if (Date.now() > enrollment.expiresAt) {
      await this.store.updateEnrollment(request.device_code, { status: "expired" });
      return { error: "expired_token", error_description: "Device code has expired" };
    }

    // Check if denied
    if (enrollment.status === "denied") {
      return { error: "access_denied", error_description: "Enrollment was denied by operator" };
    }

    // Still pending
    if (enrollment.status === "pending") {
      return { error: "authorization_pending", error_description: "Enrollment is pending operator approval" };
    }

    // Approved! Return credentials
    if (enrollment.status === "approved" && enrollment.natsCreds && enrollment.peerId) {
      return {
        creds: enrollment.natsCreds,
        peerId: enrollment.peerId,
        jwksUrl: this.options.jwksUrl,
        bootstrapUrl: this.options.bootstrapUrl,
        natsUrl: this.options.natsUrl,
      };
    }

    // Should never reach here
    return { error: "invalid_device_code", error_description: "Invalid enrollment state" };
  }

  /**
   * Approve a pending enrollment (operator action).
   *
   * Called by the SaaS approval UI when the operator clicks "Approve".
   * Generates NATS user credentials and updates enrollment status.
   */
  async approve(userCode: string): Promise<EnrollmentResult | null> {
    const enrollment = await this.store.getEnrollmentByUserCode(userCode);
    if (!enrollment) return null;

    // Check expiration
    if (Date.now() > enrollment.expiresAt) {
      await this.store.updateEnrollment(enrollment.device_code, { status: "expired" });
      return null;
    }

    // Generate NATS user credentials
    const natsCreds = await this.generateNatsUserCredentials(enrollment);

    // Generate peer ID (bootstrap JWT subject)
    const peerId = this.generatePeerId();

    await this.store.updateEnrollment(enrollment.device_code, {
      status: "approved",
      natsCreds,
      peerId,
    });

    return {
      creds: natsCreds,
      peerId,
      jwksUrl: this.options.jwksUrl,
      bootstrapUrl: this.options.bootstrapUrl,
      natsUrl: this.options.natsUrl,
    };
  }

  /**
   * Deny a pending enrollment (operator action).
   *
   * Called by the SaaS approval UI when the operator clicks "Deny".
   */
  async deny(userCode: string): Promise<boolean> {
    const enrollment = await this.store.getEnrollmentByUserCode(userCode);
    if (!enrollment) return false;

    await this.store.updateEnrollment(enrollment.device_code, { status: "denied" });
    return true;
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  /**
   * Generate a cryptographically random device code.
   * 256 bits of entropy, base64url-encoded.
   */
  private async generateDeviceCode(): Promise<string> {
    const bytes = new Uint8Array(DEVICE_CODE_BYTES);
    globalThis.crypto.getRandomValues(bytes);
    return this.bufferToBase64Url(bytes);
  }

  /**
   * Generate a human-readable user code.
   * Format: "ABCD-WXYZ" using unambiguous characters.
   */
  private generateUserCode(): string {
    const chars: string[] = [];
    for (let i = 0; i < 8; i++) {
      if (i === 4) chars.push("-"); // Insert hyphen
      const randomByte = Math.floor(Math.random() * 256);
      const index = randomByte % USER_CODE_ALPHABET.length;
      chars.push(USER_CODE_ALPHABET[index]);
    }
    return chars.join("");
  }

  /**
   * Generate a unique peer ID (bootstrap JWT subject).
   * UUID v4 format.
   */
  private generatePeerId(): string {
    return crypto.randomUUID();
  }

  /**
   * Generate NATS user credentials for a plugin.
   *
   * Creates:
   *  - NATS user NKEY seed (U... category)
   *  - NATS user JWT (signed by account NKEY)
   *  - Subject permissions scoped to tenant
   *
   * The user JWT includes tenant-scoped permissions in the NATS JWT claims format:
   *  - nats.pub.allow: Publish permissions for tenant's outbound subjects
   *  - nats.sub.allow: Subscribe permissions for tenant's inbound subjects
   */
  private async generateNatsUserCredentials(
    enrollment: PendingEnrollment,
  ): Promise<NatsUserCredentials> {
    // Defense-in-depth: re-validate the tenant immediately before building the
    // `webchannel.{tenant}.>` grant (enroll() also validates at ingress).
    // mintNatsUserCreds re-validates too; this keeps the guard local & explicit.
    assertValidSubjectToken(enrollment.tenant, "tenant");

    // Single minting code path shared with the browser/`/test/nats-user` path
    // (nats-user-creds.ts). It mints a real, tenant-scoped NATS user JWT:
    //   - self-contained mode (no natsIssuerAccountId): signed by the account
    //     NKEY, `iss` = account public — accepted by a SaaS-run nats-server.
    //   - external mode (natsIssuerAccountId set): signed by the account signing
    //     key with `nats.issuer_account` = the managed account id — accepted by
    //     Synadia's nats-server.
    //
    // Tenant scope `webchannel.{tenant}.>` covers the live per-peer channel
    // subjects `webchannel.{tenant}.{accountId}.{peerId}.{in,out,handshake}` (see
    // packages/plugin/src/nats-channel.ts) while preserving cross-tenant
    // isolation. Matches e2e/enrolled-jwt-roundtrip.test.ts.
    const minted = await mintNatsUserCreds({
      accountSeed: this.options.saasTrustChain.natsAccountSeed,
      tenant: enrollment.tenant,
      role: "agent",
      issuerAccountId: this.options.natsIssuerAccountId,
    });

    return {
      userJwt: minted.userJwt,
      userSeed: minted.userSeed,
      permissions: minted.permissions,
    };
  }

  /**
   * Convert Uint8Array to base64url string (no padding).
   */
  private bufferToBase64Url(buffer: Uint8Array): string {
    const base64 = btoa(String.fromCharCode(...buffer));
    return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
  }
}

// ---------------------------------------------------------------------------
// HTTP endpoint helpers (reference implementation)
// ---------------------------------------------------------------------------

/**
 * Handle HTTP POST /enroll request.
 *
 * Reference implementation for SaaS HTTP endpoints.
 * Can be adapted to specific web frameworks (Express, Cloudflare Workers, etc.)
 */
export async function handleEnrollRequest(
  request: EnrollmentRequest,
  enrollment: DeviceFlowEnrollment,
): Promise<EnrollmentResponse> {
  return await enrollment.enroll(request);
}

/**
 * Handle HTTP POST /poll request.
 *
 * Reference implementation for SaaS HTTP endpoints.
 */
export async function handlePollRequest(
  request: PollRequest,
  enrollment: DeviceFlowEnrollment,
): Promise<{ status: number; body: EnrollmentResult | DeviceFlowError }> {
  const result = await enrollment.poll(request);

  if ("error" in result) {
    return { status: 400, body: result };
  } else {
    return { status: 200, body: result };
  }
}
