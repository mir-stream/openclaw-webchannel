/**
 * Plugin enrollment client — RFC 8628 device flow enrollment.
 *
 * This module enables secure, secret-free plugin onboarding:
 *  - Generates plugin's X25519 identity key on first boot
 *  - Initiates RFC 8628 device flow enrollment
 *  - Polls for operator approval
 *  - Receives and stores NATS user credentials
 *  - Auto-reconnects using stored credentials (no re-pairing)
 *
 * SECURITY PROPERTIES:
 *  - Plugin is ingress-free (outbound-only)
 *  - No secret pasting (operator approval via web UI)
 *  - X25519 identity key persisted locally
 *  - NATS credentials stored securely
 *  - Reconnection without re-pairing
 */

import { generateKeyPair } from "./e2e-crypto.js";
import type { KeyPair } from "./e2e-crypto.js";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { accountCredentialPath } from "./account-config.js";
import {
  CREDENTIAL_BINDING_IDENTITY_FIELD,
  CredentialDocumentBindingError,
  assertValidCredentialBindingExpectation,
  createCredentialIdentityForEnrollment,
  loadBoundCredentialDocument,
  loadBoundCredentialDocumentJson,
  type PluginCredentialDocument,
} from "./credential-document.js";
import { WEBCHANNEL_PROTOCOL_VERSION, readPluginVersion } from "./protocol.js";

// ---------------------------------------------------------------------------
// Import SaaS types for type safety
// ---------------------------------------------------------------------------

/**
 * SaaS enrollment request (matches server-side type).
 * Re-declared here to keep plugin SDK-free.
 */
type EnrollmentRequest = {
  agentPublicKey: string;
  accountId: string;
  tenant: string;
  /** Plugin package version (diagnostics only; OPTIONAL for pre-reporting plugins). */
  pluginVersion?: string;
  /** Mandatory wire-protocol version reported by the shipped v2 plugin. */
  protocolVersion: number;
};

/**
 * SaaS enrollment response (matches server-side type).
 */
type EnrollmentResponse = {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
};

/**
 * SaaS poll request (matches server-side type).
 */
type PollRequest = {
  device_code: string;
};

/**
 * SaaS enrollment result (matches server-side type).
 */
type EnrollmentResult = {
  creds: NatsUserCredentials;
  peerId: string;
  jwksUrl: string;
  bootstrapUrl: string;
  /**
   * NATS WebSocket URL delivered by the SaaS. The relay location travels with
   * the minted creds (the SaaS is the rendezvous authority); the enrolled plugin
   * dials THIS rather than a local `nats.url` / `WEBCHANNEL_NATS_URL`.
   */
  natsUrl: string;
  /**
   * The exact `iss` the SaaS puts in the bootstrap JWTs it mints (same
   * rendezvous-authority principle as `natsUrl`). OPTIONAL here (unlike the
   * server-side type, where it is required) because a pre-issuer SaaS omits
   * it — the runtime then falls back to deriving issuer = saas.baseUrl.
   * Precedence at verify time: operator pin > this delivered value > derived.
   * Used VERBATIM — never canonicalized.
   */
  issuer?: string;
};

/**
 * Public alias for the enrollment result, exported for callers (e.g.
 * `acquireCredentials`) that need to name the resolved shape without depending
 * on the internal `EnrollmentResult` declaration.
 */
export type EnrollmentResultLike = EnrollmentResult;

export type EnrollmentEndpoints = Readonly<{
  saasEnrollUrl: string;
  saasPollUrl: string;
}>;

/**
 * Derive the only enrollment endpoints valid for a SaaS binding authority.
 * Only trailing slashes on the configured base are normalized.
 */
export function deriveEnrollmentEndpoints(
  saasBaseUrl: string,
): EnrollmentEndpoints {
  const normalizedBase = saasBaseUrl.replace(/\/+$/, "");
  if (normalizedBase.length === 0) {
    throw new Error(
      "webchannel: invalid SaaS enrollment authority fields=saasBaseUrl",
    );
  }
  return Object.freeze({
    saasEnrollUrl: `${normalizedBase}/api/enroll`,
    saasPollUrl: `${normalizedBase}/api/poll`,
  });
}

export function assertEnrollmentEndpointsMatchBase(
  options: Pick<
    EnrollmentOptions,
    "saasBaseUrl" | "saasEnrollUrl" | "saasPollUrl"
  >,
): void {
  const expected = deriveEnrollmentEndpoints(options.saasBaseUrl);
  const fields: string[] = [];
  if (options.saasEnrollUrl !== expected.saasEnrollUrl) {
    fields.push("saasEnrollUrl");
  }
  if (options.saasPollUrl !== expected.saasPollUrl) {
    fields.push("saasPollUrl");
  }
  if (fields.length > 0) {
    throw new Error(
      `webchannel: enrollment endpoints do not match saasBaseUrl fields=${fields.join(",")}`,
    );
  }
}

/**
 * SaaS NATS user credentials (matches server-side type).
 */
type NatsUserCredentials = {
  userJwt: string;
  userSeed: string;
  permissions?: {
    pub?: string[];
    sub?: string[];
  };
};

/**
 * Device flow error response (matches server-side type).
 */
type DeviceFlowError = {
  error: string;
  error_description?: string;
};

/**
 * Poll response wrapper (matches server-side type).
 */
type PollResponse = EnrollmentResult | DeviceFlowError;

// ---------------------------------------------------------------------------
// Persistent credential store types
// ---------------------------------------------------------------------------

/**
 * Plugin identity credentials (persisted locally).
 *
 * Stored on disk and used for reconnection. Contains everything needed
 * to reconnect to NATS and identify the plugin.
 */
export type PluginCredentials = PluginCredentialDocument;

// ---------------------------------------------------------------------------
// Configuration types
// ---------------------------------------------------------------------------

/**
 * Plugin enrollment options.
 */
export type EnrollmentOptions = {
  /** Effective SaaS base used for this acquisition and credential binding. */
  saasBaseUrl: string;

  /**
   * SaaS enrollment endpoint URL.
   * Example: "https://saas.com/api/enroll"
   */
  saasEnrollUrl: string;

  /**
   * SaaS poll endpoint URL.
   * Example: "https://saas.com/api/poll"
   */
  saasPollUrl: string;

  /**
   * Tenant identifier.
   */
  tenant: string;

  /**
   * Account (deployment) id — the wire identity (JWT aud / NATS subject key)
   * sent to the SaaS enrollment. Also scopes the default credential path:
   * `~/.openclaw-webchannel/<account>/credentials.json` (가-1). When
   * `credentialPath` is omitted the path is derived from this. Defaults to
   * `"default"`.
   */
  accountId: string;

  /**
   * Local credential storage path.
   * Defaults to the account-scoped path
   * `~/.openclaw-webchannel/<account>/credentials.json`. Obsolete single-file
   * credentials are intentionally ignored.
   */
  credentialPath?: string;

  /**
   * Whether to display enrollment instructions to console.
   * Defaults to true for operator convenience.
   */
  displayInstructions?: boolean;

  /**
   * @internal Test-only: floor (ms) for the poll interval. Production keeps the
   * RFC 8628 minimum of 5000ms; tests inject a small value to poll without
   * waiting real seconds. Never set this in production.
   */
  _minPollIntervalMs?: number;

  /** @internal Test-only home-directory seam for default path resolution. */
  _home?: string;
};

// ---------------------------------------------------------------------------
// Enrollment client
// ---------------------------------------------------------------------------

/**
 * Plugin enrollment client.
 *
 * Manages the complete enrollment lifecycle:
 *  - First boot: generate identity key, initiate enrollment
 *  - Polling: wait for operator approval
 *  - Credential storage: persist credentials locally
 *  - Reconnection: use stored credentials to reconnect
 */
export class EnrollmentClient {
  private readonly options: Required<
    Omit<EnrollmentOptions, "displayInstructions" | "accountId" | "_minPollIntervalMs" | "_home">
  > & {
    displayInstructions: boolean;
    accountId: string;
    _minPollIntervalMs?: number;
    _home?: string;
  };
  private credentials?: PluginCredentials;

  constructor(options: EnrollmentOptions) {
    // Validate the complete v2 binding expectation before even resolving a
    // credential path. An explicit credentialPath must never bypass
    // tenant/account/SaaS validation and reach filesystem or network work.
    assertValidCredentialBindingExpectation({
      tenant: options.tenant,
      accountId: options.accountId,
      saasBaseUrl: options.saasBaseUrl,
    });
    // Reject a split acquisition/binding authority before any request, key
    // generation, or persistence. The public options retain explicit endpoints
    // for compatibility, but they must be mechanically derived from the base.
    assertEnrollmentEndpointsMatchBase(options);
    // Spread FIRST, then apply defaults with nullish-coalescing: an explicit
    // `credentialPath: undefined` / `displayInstructions: undefined` in `options`
    // (the common case from createEnrolledNatsConnection) must NOT clobber the
    // default to `undefined` — that previously crashed saveCredentials with
    // `dirname(undefined)`.
    this.options = {
      ...options,
      credentialPath:
        options.credentialPath ?? this.defaultCredentialPath(options.accountId, options._home),
      displayInstructions: options.displayInstructions ?? true,
    };
  }

  /**
   * Perform enrollment (first boot or reconnection).
   *
   * If credentials exist locally, loads them and returns enrollment result.
   * Otherwise, initiates device flow enrollment and waits for approval.
   */
  async enroll(): Promise<EnrollmentResult> {
    // Try to load existing credentials
    if (this.loadCredentials()) {
      if (this.credentials?.enrollment) {
        console.log("[enrollment] Found existing credentials, skipping enrollment");
        return this.credentials.enrollment;
      }
    }

    // First boot: generate identity key and initiate enrollment
    console.log("[enrollment] First boot: generating identity key and initiating enrollment");
    return await this.performEnrollment();
  }

  /**
   * Get the plugin's X25519 identity key pair.
   *
   * Returns the cached key pair if available, otherwise generates a new one.
   */
  getIdentityKey(): KeyPair {
    if (this.credentials?.identityKey) {
      return {
        publicKey: this.base64UrlToBuffer(this.credentials.identityKey.publicKey),
        privateKey: this.base64UrlToBuffer(this.credentials.identityKey.privateKey),
      };
    }

    // Generate new key pair
    const keyPair = generateKeyPair();
    return keyPair;
  }

  /**
   * Get stored NATS user credentials (if enrolled).
   */
  getNatsCredentials(): NatsUserCredentials | undefined {
    return this.credentials?.enrollment?.creds;
  }

  /**
   * Get stored peer ID (if enrolled).
   */
  getPeerId(): string | undefined {
    return this.credentials?.enrollment?.peerId;
  }

  // ---------------------------------------------------------------------------
  // Internal enrollment logic
  // ---------------------------------------------------------------------------

  /**
   * Perform first-boot enrollment.
   *
   * 1. Generate X25519 identity key
   * 2. Call /enroll to get device code and user code
   * 3. Display enrollment instructions to operator
   * 4. Poll /poll until approval
   * 5. Store credentials locally
   */
  private async performEnrollment(): Promise<EnrollmentResult> {
    // Generate identity key
    const identityKey = generateKeyPair();

    // Initialize credentials structure
    this.credentials = {
      identityKey: {
        publicKey: this.bufferToBase64Url(identityKey.publicKey),
        privateKey: this.bufferToBase64Url(identityKey.privateKey),
      },
      accountId: this.options.accountId,
      tenant: this.options.tenant,
      saasEnrollUrl: this.options.saasEnrollUrl,
      saasPollUrl: this.options.saasPollUrl,
    };

    // Initiate enrollment
    const enrollRequest: EnrollmentRequest = {
      agentPublicKey: this.bufferToBase64Url(identityKey.publicKey),
      accountId: this.options.accountId,
      tenant: this.options.tenant,
      // Report the plugin's build + wire-protocol version at enrollment so the
      // SaaS/admin can record which plugin generation a device paired with.
      pluginVersion: readPluginVersion() ?? undefined,
      protocolVersion: WEBCHANNEL_PROTOCOL_VERSION,
    };

    console.log(`[enrollment] Calling ${this.options.saasEnrollUrl}...`);
    const enrollResponse = await this.httpPost<EnrollmentResponse>(
      this.options.saasEnrollUrl,
      enrollRequest,
    );

    console.log("[enrollment] Enrollment initiated");
    console.log(`[enrollment] User code: ${enrollResponse.user_code}`);
    console.log(`[enrollment] Verification URI: ${enrollResponse.verification_uri_complete}`);

    if (this.options.displayInstructions) {
      console.log("");
      console.log("==============================================");
      console.log("  PLUGIN ENROLLMENT - OPERATOR ACTION REQUIRED");
      console.log("==============================================");
      console.log("");
      console.log(`1. Visit: ${enrollResponse.verification_uri_complete}`);
      console.log(`2. Enter user code: ${enrollResponse.user_code}`);
      console.log("3. Click 'Approve' to complete enrollment");
      console.log("");
      console.log("Waiting for approval...");
      console.log("==============================================");
      console.log("");
    }

    // Poll for approval
    const pollRequest: PollRequest = {
      device_code: enrollResponse.device_code,
    };

    // Test-only override: when set, it REPLACES the computed interval (tests
    // inject 0 to poll instantly). Production uses the RFC 8628 5s floor.
    const intervalMs =
      this.options._minPollIntervalMs !== undefined
        ? this.options._minPollIntervalMs
        : Math.max(enrollResponse.interval * 1000, 5000);
    const expiresAt = Date.now() + enrollResponse.expires_in * 1000;

    while (Date.now() < expiresAt) {
      await this.sleep(intervalMs);

      console.log("[enrollment] Polling for approval...");
      const pollResult = await this.httpPost<PollResponse>(
        this.options.saasPollUrl,
        pollRequest,
      );

      if ("error" in pollResult) {
        if (pollResult.error === "authorization_pending") {
          // Continue polling
          continue;
        } else {
          throw new Error(`Enrollment failed: ${pollResult.error} (${pollResult.error_description})`);
        }
      }

      // Success! Store credentials
      this.credentials.enrollment = pollResult;
      this.credentials[CREDENTIAL_BINDING_IDENTITY_FIELD] =
        createCredentialIdentityForEnrollment({
          tenant: this.options.tenant,
          accountId: this.options.accountId,
          saasBaseUrl: this.options.saasBaseUrl,
          ...(pollResult.issuer !== undefined
            ? { deliveredIssuer: pollResult.issuer }
            : {}),
          ...(pollResult.natsUrl !== undefined
            ? { relayUrl: pollResult.natsUrl }
            : {}),
          agentPublicKey: this.credentials.identityKey.publicKey,
        });
      const validated = loadBoundCredentialDocument(
        {
          tenant: this.options.tenant,
          accountId: this.options.accountId,
          saasBaseUrl: this.options.saasBaseUrl,
        },
        this.credentials,
      );
      if (validated.status !== "match") {
        throw new CredentialDocumentBindingError(validated);
      }
      this.credentials = validated.document;
      this.saveCredentials();

      console.log("[enrollment] ✓ Enrollment complete!");
      console.log(`[enrollment]   Peer ID: ${pollResult.peerId}`);
      console.log(`[enrollment]   JWKS URL: ${pollResult.jwksUrl}`);
      console.log(`[enrollment]   Bootstrap URL: ${pollResult.bootstrapUrl}`);

      return pollResult;
    }

    throw new Error("Enrollment expired");
  }

  // ---------------------------------------------------------------------------
  // Credential persistence
  // ---------------------------------------------------------------------------

  /**
   * Load credentials from disk.
   * Returns true if successful, false otherwise.
   */
  private loadCredentials(): boolean {
    try {
      if (!existsSync(this.options.credentialPath)) {
        return false;
      }

      const data = readFileSync(this.options.credentialPath, "utf-8");
      const loaded = loadBoundCredentialDocumentJson(
        {
          tenant: this.options.tenant,
          accountId: this.options.accountId,
          saasBaseUrl: this.options.saasBaseUrl,
        },
        data,
      );
      if (loaded.status !== "match") {
        throw new CredentialDocumentBindingError(loaded);
      }
      this.credentials = loaded.document;
      return true;
    } catch (error) {
      if (error instanceof CredentialDocumentBindingError) throw error;
      throw new CredentialDocumentBindingError({
        status: "invalid",
        code: "read-failed",
        fields: Object.freeze([]),
      });
    }
  }

  /**
   * Save credentials to disk.
   */
  private saveCredentials(): void {
    try {
      const dir = dirname(this.options.credentialPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      const data = JSON.stringify(this.credentials, null, 2);
      // Enrollment is intentionally create-only. Another process may finish an
      // enrollment after our initial absence check while this process polls;
      // O_EXCL preserves that credential file instead of silently replacing it.
      writeFileSync(this.options.credentialPath, data, {
        mode: 0o600,
        flag: "wx",
      }); // rw-------

      console.log(`[enrollment] Credentials saved to ${this.options.credentialPath}`);
    } catch (error) {
      console.error("[enrollment] Failed to save credentials:", error);
      throw error;
    }
  }

  /**
   * Get the default credential path for an account (가-1).
   *
   * Account-scoped: `~/.openclaw-webchannel/<account>/credentials.json`.
   * Obsolete single-file credentials are never read.
   */
  private defaultCredentialPath(accountId: string, home?: string): string {
    return accountCredentialPath(accountId, home);
  }

  // ---------------------------------------------------------------------------
  // HTTP utilities
  // ---------------------------------------------------------------------------

  /**
   * Perform HTTP POST request with JSON body.
   */
  private async httpPost<T>(url: string, body: unknown): Promise<T> {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      // RFC 8628 device-flow poll responses use HTTP 400 with a JSON `error`
      // code (authorization_pending / slow_down / access_denied / expired_token)
      // as NORMAL control flow, not a transport failure. Surface such a body to
      // the caller so the poll loop can branch on `pollResult.error`; only a
      // non-JSON or error-less body is a genuine failure worth throwing.
      try {
        const parsed = JSON.parse(text) as unknown;
        if (
          parsed &&
          typeof parsed === "object" &&
          typeof (parsed as { error?: unknown }).error === "string"
        ) {
          return parsed as T;
        }
      } catch {
        // not JSON — fall through to throw
      }
      throw new Error(`HTTP ${response.status}: ${text}`);
    }

    return await response.json() as T;
  }

  // ---------------------------------------------------------------------------
  // Encoding utilities
  // ---------------------------------------------------------------------------

  /**
   * Convert Uint8Array to base64url string (no padding).
   */
  private bufferToBase64Url(buffer: Uint8Array): string {
    const base64 = btoa(String.fromCharCode(...buffer));
    return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
  }

  /**
   * Convert base64url string to Uint8Array.
   */
  private base64UrlToBuffer(base64url: string): Uint8Array {
    const base64 = base64url.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  /**
   * Sleep for specified milliseconds.
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// ---------------------------------------------------------------------------
// Utility functions
// ---------------------------------------------------------------------------

/**
 * Create an enrollment client with standard configuration.
 *
 * Convenience function for creating an enrollment client with common options.
 */
export function createEnrollmentClient(options: EnrollmentOptions): EnrollmentClient {
  return new EnrollmentClient(options);
}
