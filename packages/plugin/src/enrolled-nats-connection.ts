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
   * Agent ID (optional, for debugging).
   */
  agentId?: string;

  /**
   * Account id (가-1). Threaded into the credential-path resolution so the
   * connection reads the account-scoped creds. Defaults to `"default"`.
   */
  accountId?: string;

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
): Promise<EnrolledNatsConnection> {
  // Step 1: Enroll (or load existing enrollment)
  console.log("[connection] Starting enrollment...");
  const enrollmentClient = new EnrollmentClient({
    saasEnrollUrl: options.saasEnrollUrl,
    saasPollUrl: options.saasPollUrl,
    tenant: options.tenant,
    agentId: options.agentId,
    accountId: options.accountId,
    credentialPath: options.credentialPath,
    displayInstructions: options.displayInstructions,
  });

  const enrollment = await enrollmentClient.enroll();

  // Step 2: Get identity key
  console.log("[connection] Getting identity key...");
  const identityKey = enrollmentClient.getIdentityKey();

  // Step 3: Connect to NATS with user credentials.
  //
  // A JWT-auth nats-server challenges the client with a nonce in INFO; the client
  // must return an Ed25519 signature over that nonce (signed with the user NKEY
  // seed) in CONNECT, or the server rejects the connection. We derive that signing
  // callback from the enrolled user seed so the production enrolled path
  // authenticates against a real JWT-auth nats-server (not only an open dev one).
  console.log("[connection] Connecting to NATS...");
  const transport = new NatsTransport({
    url: options.natsUrl,
    jwtCredential: enrollment.creds.userJwt,
    nkeySigningCallback: makeNkeySigningCallback(enrollment.creds.userSeed),
    clientName: options.natsClientName ?? "openclaw-webchannel-agent",
  });

  await transport.connect();
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
  natsUrl: string,
  saasBaseUrl: string,
): Promise<EnrolledNatsConnection> {
  return createEnrolledNatsConnection({
    saasEnrollUrl: `${saasBaseUrl}/api/enroll`,
    saasPollUrl: `${saasBaseUrl}/api/poll`,
    natsUrl,
    tenant,
  });
}
