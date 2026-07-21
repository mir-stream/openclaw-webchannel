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
import { createHash, randomBytes } from "node:crypto";
import type { ActivationId, AgentKeyRecord } from "./agent-key-registry.js";
import { DeviceCodeCollisionError, UserCodeCollisionError, type EnrollmentRepository } from "./enrollment-repository.js";

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
 * How many times `enroll()` re-mints on a `user_code` collision before giving
 * up. With a ~1.2B code space a single collision is already rare; 5 attempts
 * make an enroll-failing collision run astronomically unlikely while bounding
 * the work under a hostile/degenerate store.
 */
const MAX_ENROLL_ATTEMPTS = 5;

/**
 * Exact wire format of `agentPublicKey`: base64url (no padding) of a 32-byte
 * X25519 public key = exactly 43 characters. The plugin is the only legitimate
 * caller (`enrollment-client.ts`) and always sends precisely this, so the form
 * is pinned strictly — no length range, no padding, no standard-base64 chars.
 */
const AGENT_PUBLIC_KEY_FORMAT = /^[A-Za-z0-9_-]{43}$/;

/**
 * A request-validation failure that is safe for an unauthenticated enrollment
 * endpoint to return to its caller. Backend/store/runtime errors intentionally
 * use their original types and must be handled by a sanitized 500 boundary.
 */
export class EnrollmentValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnrollmentValidationError";
  }
}

/**
 * Throw unless `key` is the exact `agentPublicKey` wire format.
 *
 * `/enroll` is unauthenticated and `agentPublicKey` is the one field whose
 * content AND size a hostile caller fully controls. Validating it at ingress
 * caps store/approval-UI bloat from a multi-megabyte string and fails a
 * malformed key HERE rather than late at browser-side cnf binding.
 */
function assertValidAgentPublicKey(key: unknown): void {
  if (typeof key !== "string" || !AGENT_PUBLIC_KEY_FORMAT.test(key)) {
    throw new EnrollmentValidationError(
      "webchannel: agentPublicKey must be base64url of a 32-byte X25519 public key",
    );
  }
}

// Advisory version fields ride the same unauthenticated /enroll ingress as
// agentPublicKey, but they are diagnostics-only (never gate approval, never part
// of the trust chain). So unlike agentPublicKey — which is REJECTED — a malformed
// version is SANITIZED-AWAY: we drop it and let enrollment succeed. The bounds
// exist purely to cap store/approval-UI bloat and keep a control-character string
// out of an admin listing; 64 chars comfortably fits any real semver + build tag.
const PLUGIN_VERSION_MAX_LEN = 64;
const PLUGIN_VERSION_FORMAT = /^[\w.+-]+$/;

/** A reported `pluginVersion` for storage, or undefined if it fails the bound. */
function sanitizePluginVersion(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 && v.length <= PLUGIN_VERSION_MAX_LEN && PLUGIN_VERSION_FORMAT.test(v)
    ? v
    : undefined;
}

/** A reported `protocolVersion` for storage, or undefined if not a non-negative safe int. */
function sanitizeProtocolVersion(v: unknown): number | undefined {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : undefined;
}

/**
 * Is `err` a user_code collision `enroll()` should retry on? Matches both an
 * `instanceof` of our class AND any error whose `name` is
 * `"UserCodeCollisionError"` — a consumer's store may carry a different copy of
 * the class across package duplication, so the name is the durable signal.
 */
function isUserCodeCollisionError(err: unknown): boolean {
  return (
    err instanceof UserCodeCollisionError ||
    (typeof err === "object" && err !== null && (err as { name?: unknown }).name === "UserCodeCollisionError")
  );
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
   * The exact `iss` this SaaS puts in the bootstrap JWTs it mints, delivered
   * to the plugin in the `EnrollmentResult` (same rendezvous-authority
   * principle as `natsUrl`). Defaults to the trailing-slash-stripped
   * `saasBaseUrl` — which matches the plugin's derivation, so a SaaS whose
   * minted `iss` is its base URL needs no config here.
   *
   * CONTRACT: this MUST equal the `iss` you pass to `buildBootstrapClaims`.
   * The library cannot enforce that (minting is a separate per-call
   * parameter), so derive BOTH from one variable in your server — otherwise
   * enrollment delivers a promise the mint breaks, and every agent rejects
   * every bootstrap JWT with an opaque `unauthorized`.
   */
  issuer?: string;

  /** Atomic enrollment/key repository. There is deliberately no memory default. */
  repository: EnrollmentRepository;

  /** Maximum mint duration before the repository fence rejects the commit. */
  approvalLeaseMs?: number;
};

export type ApproveOutcome =
  | { kind: "approved"; result: EnrollmentResult }
  | { kind: "in_progress" }
  | { kind: "conflict"; existing: { activationId: ActivationId; keyIdFingerprint: string; enrolledAt: number } | null; incoming: { keyIdFingerprint: string } }
  | { kind: "revoked_key" }
  | { kind: "rejected" };

/**
 * The delivered-issuer default: trailing-slash-stripped base URL. MUST mirror
 * the plugin's `deriveIssuer` (packages/plugin/src/preflight.ts) so the
 * default-configured SaaS delivers exactly what a default-configured plugin
 * would have derived.
 */
function defaultIssuer(saasBaseUrl: string): string {
  return saasBaseUrl.replace(/\/+$/, "");
}

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
  private readonly options: Required<
    Omit<DeviceFlowOptions, "repository" | "natsIssuerAccountId">
  > &
    Pick<DeviceFlowOptions, "natsIssuerAccountId">;
  private readonly repository: EnrollmentRepository;
  /**
   * #22: per-userCode serialization gate shared by approve() AND deny(). Maps a
   * userCode to the tail of its running critical-section chain so the next
   * operator action on the same userCode runs strictly after the previous one
   * fully settles. This closes the check-then-act race where approve's slow
   * NATS mint sits between its read and write and a concurrent deny (or a second
   * approve) interleaves — the #11 status guards alone can't stop it because
   * both sides read `pending` before either writes. It supersedes the old
   * approve-only in-flight dedup (`approvalsInFlight`): a second approve no
   * longer reuses the first's promise, it re-reads and hits the A2
   * approved-with-creds re-return path, which yields the same creds.
   */
  private readonly userCodeLocks = new Map<string, Promise<unknown>>();
  constructor(options: DeviceFlowOptions) {
    if (!options.repository) throw new Error("repository is required");
    this.options = {
      expirationSeconds: DEFAULT_EXPIRATION_SECONDS,
      pollIntervalSeconds: MIN_POLL_INTERVAL_SECONDS,
      approvalLeaseMs: 30_000,
      ...options,
      // After the spread so an absent (or explicitly-undefined) `issuer` gets
      // the derivation, keeping the `Required<>` cast honest. An explicit
      // issuer is kept VERBATIM (no canonicalization — the SaaS declares the
      // exact string it mints).
      issuer: options.issuer ?? defaultIssuer(options.saasBaseUrl),
    };
    this.repository = options.repository;
  }

  /**
   * Handle an enrollment request from a plugin.
   *
   * Creates a pending enrollment and returns a device code and user code.
   * The plugin polls /poll until the operator approves the enrollment.
   *
   * `/enroll` is unauthenticated, so all three attacker-controllable ingress
   * fields are validated up front before anything is persisted: `tenant` and
   * `accountId` for NATS-subject safety, and `agentPublicKey` for its exact
   * X25519-base64url wire format.
   */
  async enroll(request: EnrollmentRequest): Promise<EnrollmentResponse> {
    // Reject tenant/accountId tokens that would break the NATS subject hierarchy
    // or cross tenant boundaries before they are persisted or used in a grant.
    try {
      assertValidSubjectToken(request.tenant, "tenant");
      assertValidSubjectToken(request.accountId, "accountId");
    } catch (error) {
      throw new EnrollmentValidationError(
        error instanceof Error ? error.message : "webchannel: invalid enrollment subject",
      );
    }
    // Reject a malformed/oversized agentPublicKey at ingress rather than late at
    // browser-side cnf binding (and cap store/approval-UI bloat from a huge string).
    assertValidAgentPublicKey(request.agentPublicKey);
    // Sanitize the advisory version fields ONCE before the mint/retry loop.
    // Undefined (absent or malformed) → the key is omitted entirely below so it
    // "stays absent" in the store record rather than persisting an empty slot.
    const pluginVersion = sanitizePluginVersion(request.pluginVersion);
    const protocolVersion = sanitizeProtocolVersion(request.protocolVersion);
    const now = await this.repository.now();
    const expiresAt = now + this.options.expirationSeconds * 1000;

    // Bounded collision-retry: a persistent store with UNIQUE(user_code) can
    // reject a save on a rare code collision (surfaced as UserCodeCollisionError,
    // per the EnrollmentRepository contract). Re-mint BOTH codes and retry — a
    // device_code collision is negligible, but re-minting both keeps the loop
    // trivially correct. ONLY a collision is retried; any other store error is a
    // real fault and propagates immediately (no retry).
    let device_code = "";
    let user_code = "";
    let lastCollision: unknown;
    let persisted = false;
    for (let attempt = 0; attempt < MAX_ENROLL_ATTEMPTS; attempt++) {
      device_code = await this.generateDeviceCode();
      user_code = this.generateUserCode();
      const enrollment: PendingEnrollment = {
        device_code,
        user_code,
        agentPublicKey: request.agentPublicKey,
        accountId: request.accountId,
        tenant: request.tenant,
        createdAt: now,
        expiresAt,
        status: "pending",
        ...(pluginVersion !== undefined ? { pluginVersion } : {}),
        ...(protocolVersion !== undefined ? { protocolVersion } : {}),
      };
      try {
        await this.repository.createEnrollment(enrollment);
        persisted = true;
        break;
      } catch (err) {
        if (!isUserCodeCollisionError(err) && !(err instanceof DeviceCodeCollisionError) &&
          !(typeof err === "object" && err !== null && (err as { name?: unknown }).name === "DeviceCodeCollisionError")) throw err;
        lastCollision = err;
      }
    }
    if (!persisted) throw lastCollision;

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
    const { enrollment } = await this.repository.tryExpire(request.device_code);
    if (!enrollment) {
      return { error: "invalid_device_code", error_description: "Device code not found" };
    }

    // Check if denied
    if (enrollment.status === "denied") {
      return { error: "access_denied", error_description: "Enrollment was denied by operator" };
    }
    if (enrollment.status === "expired") {
      return { error: "expired_token", error_description: "Device code has expired" };
    }

    // Still pending
    if (enrollment.status === "pending" || enrollment.status === "approving") {
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
        issuer: this.options.issuer,
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
   *
   * Approval is serialized by the repository's atomic claim/commit operations.
   * `/approve` is an unauthenticated, repeatable action (double-click, retry,
   * replay). Re-minting creds/peerId on a repeat would hand the already-connected
   * plugin a DIFFERENT identity on its next poll and break the live session, so:
   *  - a repeat AFTER the first approval returns the SAME credentials (status
   *    guard on the persisted enrollment), and
   * The process-local per-userCode lock only avoids duplicate work; correctness
   * comes from repository-clock lease fencing and the atomic commit. Approved
   * results remain recoverable after expiresAt for the configured retention
   * horizon. An operator may deny an approving record, invalidating its claim so
   * a late commit is fenced (deny does not join this lock — see `deny()`).
   *
   * Transition rules: pending→approving→approved, with approved idempotently
   * returning the persisted result; denied and expired remain terminal.
   */
  async approve(userCode: string, opts?: { replaceActivationId?: ActivationId }): Promise<ApproveOutcome> {
    return this.withUserCodeLock(userCode, () => this.approveInner(userCode, opts));
  }

  /**
   * Approve-only double-submit guard: run `fn` as the sole holder of
   * `userCode`'s critical section, serialized against every OTHER approve on the
   * same userCode. Only `approve()` uses this lock; `deny()` deliberately does
   * not (it must be able to preempt an in-flight approve — see `deny()`). Its
   * sole remaining job is de-duplicating concurrent approves so a double-click or
   * retry does not race a second NATS mint. It is a UX/latency optimization, NOT
   * a correctness mechanism: correctness — including deny preempting an approving
   * record — comes entirely from the repository's atomic claim/commit/tryDeny
   * fencing, not from this queue.
   *
   * The work is chained onto the userCode's running tail so it starts only after
   * the prior holder fully settles (success OR failure), and the whole read→write
   * span — including approve's async NATS mint — is protected.
   *
   * The stored tail node swallows `fn`'s outcome, so a thrown mint/store error
   * propagates to THIS caller (via the returned promise) yet never wedges the
   * queue: the next waiter still runs. When the node is still the tail after it
   * settles, it removes itself so the map stays bounded.
   */
  private withUserCodeLock<T>(userCode: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.userCodeLocks.get(userCode) ?? Promise.resolve();
    // Run `fn` after `prev` settles regardless of whether prev resolved or
    // rejected — a prior failure must not skip our turn.
    const result = prev.then(fn, fn);
    // The tail used purely as a sequencing gate: swallow the result so a
    // rejection can't leave the chain unhandled or block the next holder, and
    // self-evict once nobody has chained behind us.
    let node: Promise<void>;
    node = result.then(
      () => {},
      () => {},
    ).finally(() => {
      if (this.userCodeLocks.get(userCode) === node) {
        this.userCodeLocks.delete(userCode);
      }
    });
    this.userCodeLocks.set(userCode, node);
    return result;
  }

  private result(natsCreds: NatsUserCredentials, peerId: string): EnrollmentResult {
    return { creds: natsCreds, peerId, jwksUrl: this.options.jwksUrl, bootstrapUrl: this.options.bootstrapUrl, natsUrl: this.options.natsUrl, issuer: this.options.issuer };
  }

  private conflict(active: AgentKeyRecord | null, incomingKeyId: string): ApproveOutcome {
    return {
      kind: "conflict",
      existing: active ? { activationId: active.activationId, keyIdFingerprint: active.keyId.slice(0, 12), enrolledAt: active.enrolledAt } : null,
      incoming: { keyIdFingerprint: incomingKeyId.slice(0, 12) },
    };
  }

  private async approveInner(userCode: string, opts?: { replaceActivationId?: ActivationId }): Promise<ApproveOutcome> {
    // Operation identity is exactly 128 random bits encoded without padding;
    // UUID formatting would expose only 122 random bits and violate the SPI.
    const opId = randomBytes(16).toString("base64url");
    const claim = await this.repository.claimApproval(userCode, opId, this.options.approvalLeaseMs);
    if (claim.kind === "in_progress") return { kind: "in_progress" };
    if (claim.kind === "already_approved") {
      const enrollment = claim.enrollment;
      const reconciled = await this.repository.reconcileApprovedRegistration(enrollment.device_code);
      const active = await this.repository.getActive(enrollment.tenant, enrollment.accountId);
      if (reconciled.kind === "noop" && reconciled.reason === "active_present" && active?.publicKey !== enrollment.agentPublicKey)
        console.warn("approved enrollment registry active key differs from enrollment", active?.activationId);
      else if (reconciled.kind === "noop" && reconciled.reason !== "active_present")
        console.warn("approved enrollment registry reconciliation unchanged", reconciled.reason);
      if (!enrollment.natsCreds || !enrollment.peerId) return { kind: "rejected" };
      return { kind: "approved", result: this.result(enrollment.natsCreds, enrollment.peerId) };
    }
    if (claim.kind !== "claimed") return { kind: "rejected" };
    const enrollment = claim.enrollment;

    const incomingKeyId = createHash("sha256").update(Buffer.from(enrollment.agentPublicKey, "base64url")).digest("base64url");
    const history = await this.repository.listHistory(enrollment.tenant, enrollment.accountId);
    if (history.some((record) => record.status === "revoked" && record.keyId === incomingKeyId)) {
      try { await this.repository.releaseClaim(opId); }
      catch (releaseError) { console.warn("revoked-key claim release failed; lease expiry will recover", releaseError); }
      return { kind: "revoked_key" };
    }
    const active = await this.repository.getActive(enrollment.tenant, enrollment.accountId);
    let expect: ActivationId | null;
    if (!active && opts?.replaceActivationId === undefined) expect = null;
    else if (active?.publicKey === enrollment.agentPublicKey) expect = active.activationId;
    else if (active && opts?.replaceActivationId === active.activationId) expect = active.activationId;
    else {
      try { await this.repository.releaseClaim(opId); }
      catch (releaseError) { console.warn("conflict claim release failed; lease expiry will recover", releaseError); }
      return this.conflict(active, incomingKeyId);
    }

    // Generate NATS user credentials
    let natsCreds: NatsUserCredentials;
    try { natsCreds = await this.generateNatsUserCredentials(enrollment); }
    catch (error) {
      // Best-effort release: the MINT failure is the root cause the caller must
      // see. If releaseClaim itself rejects, log it and still rethrow the mint
      // error — the lease expiry recovers the claim either way (plan §2.2).
      try { await this.repository.releaseClaim(opId); }
      catch (releaseError) { console.warn("mint-failure claim release failed; lease expiry will recover", releaseError); }
      throw error;
    }

    // Generate peer ID (bootstrap JWT subject)
    const peerId = this.generatePeerId();

    const payload = { creds: natsCreds, peerId, agentPublicKey: enrollment.agentPublicKey, expect };
    let committed;
    try { committed = await this.repository.commitApproval(opId, payload); }
    catch (error) {
      console.warn("approval commit failed; evaluating idempotent retry", error);
      if (error instanceof Error && error.name === "CommitPayloadMismatchError") throw error;
      committed = await this.repository.commitApproval(opId, payload);
    }
    if (committed.kind === "committed") return { kind: "approved", result: this.result(natsCreds, peerId) };
    if (committed.kind === "revoked") return { kind: "revoked_key" };
    if (committed.kind === "conflict") return this.conflict(committed.current, incomingKeyId);
    return { kind: "rejected" };
  }

  /**
   * Deny a pending enrollment (operator action).
   *
   * Called by the SaaS approval UI when the operator clicks "Deny".
   *
   * Transition rules: deny is a `pending|approving`→`denied` transition. An already
   * `approved` enrollment has live minted credentials, so flipping it to
   * `denied` would make the record lie about an identity that still works →
   * false, no state change. An expired record is marked `expired` (matching
   * `poll()`), and any other terminal status (including already `denied`)
   * returns false without change.
   *
   * Deny deliberately BYPASSES approve's per-userCode lock (`withUserCodeLock`).
   * It must be able to preempt an approve that is still in flight on this same
   * instance — an operator who clicks Approve then Deny needs the Deny to land
   * while the async NATS mint is running, not queue behind it. `tryDeny` is an
   * atomic repository transition to `denied` that deletes the claim, so a late
   * `commitApproval` from the in-flight approve is fenced (`claim_lost` →
   * rejected) with no minted identity ever activated. No orchestrator-side
   * serialization is needed; the repository supplies all the fencing.
   */
  async deny(userCode: string): Promise<boolean> {
    return this.repository.tryDeny(userCode);
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
   *
   * CSPRNG (`crypto.getRandomValues`) with rejection sampling so the code the
   * banner calls "cryptographically random" actually is. The 18-char alphabet
   * does not divide 256, so a plain `byte % 18` would bias the first
   * `256 % 18 = 4` letters. We keep only bytes below the largest multiple of 18
   * that fits a byte (`14 * 18 = 252`) and reject the rest, giving a uniform
   * index. Bytes are drawn in one batch (with a small margin for rejections)
   * and refilled only if that batch runs dry, so this is not one syscall/char.
   */
  private generateUserCode(): string {
    const alphabetLen = USER_CODE_ALPHABET.length; // 18
    const rejectAtOrAbove = 256 - (256 % alphabetLen); // 252 — largest 18-multiple ≤ 256
    const chars: string[] = [];

    let pool = new Uint8Array(0);
    let poolPos = 0;
    const nextUniformIndex = (): number => {
      for (;;) {
        if (poolPos >= pool.length) {
          // 8 letters needed; oversize the draw so rejections rarely refill.
          pool = new Uint8Array(16);
          globalThis.crypto.getRandomValues(pool);
          poolPos = 0;
        }
        const byte = pool[poolPos++];
        if (byte < rejectAtOrAbove) return byte % alphabetLen;
        // else: biased region — reject and draw the next byte.
      }
    };

    for (let i = 0; i < 8; i++) {
      if (i === 4) chars.push("-"); // Insert hyphen
      chars.push(USER_CODE_ALPHABET[nextUniformIndex()]);
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
    // subjects `webchannel.{tenant}.{accountId}.{peerId}.{in,out}` plus the
    // `.register`/`.reginbox` admission subjects (see
    // packages/plugin/src/nats-channel.ts) while preserving cross-tenant isolation.
    const minted = await mintNatsUserCreds({
      accountSeed: this.options.saasTrustChain.natsAccountSeed,
      tenant: enrollment.tenant,
      role: "agent",
      issuerAccountId: this.options.natsIssuerAccountId,
    });

    return {
      userJwt: minted.userJwt,
      userSeed: minted.userSeed,
      userPubkey: minted.userPubkey,
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
