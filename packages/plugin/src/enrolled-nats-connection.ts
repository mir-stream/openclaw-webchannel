/**
 * Enrolled NATS connection — plugin startup with enrollment integration.
 *
 * This module integrates the enrollment client with NATS transport to provide:
 *  - First-boot enrollment (if credentials missing)
 *  - Credential persistence and loading
 *  - Auto-reconnection using stored credentials
 *  - NATS connection with user JWT authentication
 *
 * USAGE:
 *   const connection = await createEnrolledNatsConnection({
 *     saasEnrollUrl: 'https://saas.com/api/enroll',
 *     saasPollUrl: 'https://saas.com/api/poll',
 *     natsUrl: 'wss://nats.example.com',
 *     tenant: 'tenant-123',
 *   });
 *
 *   // Use connection.transport for pub/sub
 *   connection.transport.publish('webchannel.tenant-123.outbound.test', payload);
 */

import { EnrollmentClient, type EnrollmentOptions, type PluginCredentials } from "./enrollment-client.js";
import { NatsTransport } from "./nats-transport.js";
import { makeNkeySigningCallback } from "./nkey-sign.js";
import type { KeyPair } from "./e2e-crypto.js";

// ---------------------------------------------------------------------------
// Configuration types
// ---------------------------------------------------------------------------

/**
 * Enrolled NATS connection options.
 */
export type EnrolledNatsConnectionOptions = {
  /**
   * SaaS enrollment endpoint URL.
   */
  saasEnrollUrl: string;

  /**
   * SaaS poll endpoint URL.
   */
  saasPollUrl: string;

  /**
   * NATS WebSocket URL.
   */
  natsUrl: string;

  /**
   * Tenant identifier.
   */
  tenant: string;

  /**
   * Account (deployment) id — the wire identity (가-1/가-2). Sent to the SaaS
   * enrollment AND threaded into credential-path resolution so the connection
   * reads the account-scoped creds. Defaults to `"default"`.
   */
  accountId: string;

  /**
   * Local credential storage path. Overrides the account-scoped default.
   */
  credentialPath?: string;

  /**
   * Whether to display enrollment instructions to console.
   */
  displayInstructions?: boolean;

  /**
   * NATS client name (for debugging).
   */
  natsClientName?: string;
};

/**
 * Enrolled NATS connection result.
 */
export type EnrolledNatsConnection = {
  /**
   * Connected NATS transport.
   */
  transport: NatsTransport;

  /**
   * Plugin enrollment result (populated after enrollment).
   */
  enrollment: {
    creds: {
      userJwt: string;
      userSeed: string;
      permissions?: {
        pub?: string[];
        sub?: string[];
      };
    };
    peerId: string;
    jwksUrl: string;
    bootstrapUrl: string;
    natsUrl: string;
  };

  /**
   * Plugin identity key (X25519).
   */
  identityKey: KeyPair;

  /**
   * Plugin credentials (persisted locally).
   */
  credentials: PluginCredentials;
};

export type EnrolledNatsConnectionDeps = {
  enrollmentClientFactory?: (options: EnrollmentOptions) => EnrollmentClient;
  transportFactory?: (options: ConstructorParameters<typeof NatsTransport>[0]) => NatsTransport;
  makeSigner?: typeof makeNkeySigningCallback;
};

// ---------------------------------------------------------------------------
// Connection factory
// ---------------------------------------------------------------------------

/**
 * Create an enrolled NATS connection.
 *
 * Handles the complete startup sequence:
 *  1. Load or perform enrollment
 *  2. Connect to NATS with user credentials
 *  3. Return connected transport + metadata
 */
export async function createEnrolledNatsConnection(
  options: EnrolledNatsConnectionOptions,
  deps: EnrolledNatsConnectionDeps = {},
): Promise<EnrolledNatsConnection> {
  // Step 1: Enroll (or load existing enrollment)
  console.log("[connection] Starting enrollment...");
  const enrollmentOptions: EnrollmentOptions = {
    saasEnrollUrl: options.saasEnrollUrl,
    saasPollUrl: options.saasPollUrl,
    tenant: options.tenant,
    accountId: options.accountId,
    credentialPath: options.credentialPath,
    displayInstructions: options.displayInstructions,
  };
  const enrollmentClient = deps.enrollmentClientFactory?.(enrollmentOptions) ??
    new EnrollmentClient(enrollmentOptions);

  const enrollment = await enrollmentClient.enroll();

  // Step 2: Get identity key
  console.log("[connection] Getting identity key...");
  const identityKey = enrollmentClient.getIdentityKey();

  // Step 3: Connect to NATS with user credentials.
  //
  // The SaaS is the rendezvous authority: the enrollment response carries the
  // relay URL alongside the minted creds, so the two never drift. We dial that
  // SaaS-delivered `enrollment.natsUrl` in preference to any locally-configured
  // `options.natsUrl` (which the resolver derives from `nats.url` /
  // `WEBCHANNEL_NATS_URL` — now a dev-only override / back-compat fallback for an
  // older issuer that does not yet return a URL).
  //
  // A JWT-auth nats-server challenges the client with a nonce in INFO; the client
  // must return an Ed25519 signature over that nonce (signed with the user NKEY
  // seed) in CONNECT, or the server rejects the connection. We derive that signing
  // callback from the enrolled user seed so the production enrolled path
  // authenticates against a real JWT-auth nats-server (not only an open dev one).
  const natsUrl = enrollment.natsUrl ?? options.natsUrl;
  console.log(`[connection] Connecting to NATS at ${natsUrl}...`);
  const transport = (deps.transportFactory ?? ((transportOptions) => new NatsTransport(transportOptions)))({
    url: natsUrl,
    jwtCredential: enrollment.creds.userJwt,
    nkeySigningCallback: (deps.makeSigner ?? makeNkeySigningCallback)(enrollment.creds.userSeed),
    clientName: options.natsClientName ?? "openclaw-webchannel-agent",
    // S1: survive a NATS blip (server restart / TCP reset) — re-dial with
    // backoff and replay subscriptions instead of wedging until gateway restart.
    reconnect: true,
  });

  try {
    await transport.connect();
  } catch (err) {
    try { transport.disconnect(); } catch { /* preserve the original rejection */ }
    throw err;
  }
  console.log("[connection] ✓ Connected to NATS");

  // Step 4: Get stored credentials for reference
  const credentials = enrollmentClient["credentials"] as PluginCredentials;

  return {
    transport,
    enrollment,
    identityKey,
    credentials,
  };
}

/**
 * Create an enrolled NATS connection with default options.
 *
 * Convenience function for common configurations.
 */
export function createDefaultNatsConnection(
  tenant: string,
  accountId: string,
  natsUrl: string,
  saasBaseUrl: string,
): Promise<EnrolledNatsConnection> {
  return createEnrolledNatsConnection({
    saasEnrollUrl: `${saasBaseUrl}/api/enroll`,
    saasPollUrl: `${saasBaseUrl}/api/poll`,
    natsUrl,
    tenant,
    accountId,
  });
}
