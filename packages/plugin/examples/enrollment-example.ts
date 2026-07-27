#!/usr/bin/env node
/**
 * Example plugin enrollment flow.
 *
 * This script demonstrates how to use the EnrollmentClient to perform
 * RFC 8628 device flow enrollment and connect to NATS.
 *
 * USAGE:
 *   node dist/examples/enrollment-example.ts
 *
 * ENVIRONMENT VARIABLES:
 *   SAAS_BASE_URL     - SaaS identity base (default: http://localhost:3000)
 *   SAAS_ENROLL_URL   - SaaS enrollment endpoint (default: http://localhost:3000/api/enroll)
 *   SAAS_POLL_URL     - SaaS poll endpoint (default: http://localhost:3000/api/poll)
 *   NATS_URL          - NATS WebSocket URL (default: wss://nats.example.com)
 *   TENANT            - Tenant identifier (default: demo-tenant)
 *   ACCOUNT_ID        - Account (deployment) id — the wire identity (optional, default: demo-account)
 *
 * DEMO FLOW:
 *   1. Check for existing credentials
 *   2. If missing, generate X25519 identity key and initiate enrollment
 *   3. Display user code and verification URI to operator
 *   4. Poll for approval
 *   5. Store credentials locally
 *   6. Connect to NATS
 *   7. Handle reconnection on restart
 */

import { EnrollmentClient } from "../src/enrollment-client.js";
import { createEnrolledNatsConnection } from "../src/enrolled-nats-connection.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const SAAS_BASE_URL = process.env.SAAS_BASE_URL || "http://localhost:3000";
const SAAS_ENROLL_URL = process.env.SAAS_ENROLL_URL || `${SAAS_BASE_URL}/api/enroll`;
const SAAS_POLL_URL = process.env.SAAS_POLL_URL || `${SAAS_BASE_URL}/api/poll`;
const NATS_URL = process.env.NATS_URL || "wss://nats.example.com";
const TENANT = process.env.TENANT || "demo-tenant";
const ACCOUNT_ID = process.env.ACCOUNT_ID || "demo-account";

// ---------------------------------------------------------------------------
// Main enrollment flow
// ---------------------------------------------------------------------------

async function main() {
  console.log("");
  console.log("==============================================");
  console.log("  WebChannel Plugin Enrollment Example");
  console.log("==============================================");
  console.log("");
  console.log("Configuration:");
  console.log(`  SaaS Base URL:   ${SAAS_BASE_URL}`);
  console.log(`  SaaS Enroll URL: ${SAAS_ENROLL_URL}`);
  console.log(`  SaaS Poll URL:   ${SAAS_POLL_URL}`);
  console.log(`  NATS URL:        ${NATS_URL}`);
  console.log(`  Tenant:          ${TENANT}`);
  console.log(`  Account ID:      ${ACCOUNT_ID}`);
  console.log("");
  console.log("==============================================");
  console.log("");

  try {
    // -----------------------------------------------------------------------
    // Step 1: Check existing credentials
    // -----------------------------------------------------------------------

    console.log("[1] Checking for existing credentials...");

    const enrollmentClient = new EnrollmentClient({
      saasBaseUrl: SAAS_BASE_URL,
      saasEnrollUrl: SAAS_ENROLL_URL,
      saasPollUrl: SAAS_POLL_URL,
      tenant: TENANT,
      accountId: ACCOUNT_ID,
      displayInstructions: true,
    });

    // Check if we have existing credentials
    const hasExistingCreds = enrollmentClient["loadCredentials"]();

    if (hasExistingCreds) {
      console.log("[1] ✓ Found existing credentials");
      console.log("[1]   Skipping enrollment, will use stored credentials");
      console.log("");
    } else {
      console.log("[1] ✗ No existing credentials found");
      console.log("[1]   Will perform first-boot enrollment");
      console.log("");
    }

    // -----------------------------------------------------------------------
    // Step 2: Perform enrollment (or load existing)
    // -----------------------------------------------------------------------

    console.log("[2] Performing enrollment...");

    const enrollment = await enrollmentClient.enroll();

    console.log("[2] ✓ Enrollment complete");
    console.log(`[2]   Peer ID:    ${enrollment.peerId}`);
    console.log(`[2]   JWKS URL:   ${enrollment.jwksUrl}`);
    console.log(`[2]   Bootstrap:  ${enrollment.bootstrapUrl}`);
    console.log("");

    // -----------------------------------------------------------------------
    // Step 3: Get identity key
    // -----------------------------------------------------------------------

    console.log("[3] Retrieving identity key...");

    const identityKey = enrollmentClient.getIdentityKey();

    console.log("[3] ✓ Identity key retrieved");
    console.log(`[3]   Public key:  ${bufferToBase64Url(identityKey.publicKey).slice(0, 20)}...`);
    console.log(`[3]   Private key: ${bufferToBase64Url(identityKey.privateKey).slice(0, 20)}...`);
    console.log("");

    // -----------------------------------------------------------------------
    // Step 4: Get NATS credentials
    // -----------------------------------------------------------------------

    console.log("[4] Retrieving NATS credentials...");

    const natsCreds = enrollmentClient.getNatsCredentials();

    if (natsCreds) {
      console.log("[4] ✓ NATS credentials retrieved");
      console.log(`[4]   User JWT:  ${natsCreds.userJwt.slice(0, 50)}...`);
      console.log(`[4]   User Seed: ${natsCreds.userSeed.slice(0, 20)}...`);
      console.log("");

      if (natsCreds.permissions) {
        console.log("[4]   NATS Permissions:");
        console.log("[4]     Publish:");
        natsCreds.permissions.pub?.forEach((sub) => console.log(`[4]       - ${sub}`));
        console.log("[4]     Subscribe:");
        natsCreds.permissions.sub?.forEach((sub) => console.log(`[4]       - ${sub}`));
        console.log("");
      }
    }

    // -----------------------------------------------------------------------
    // Step 5: Connect to NATS (optional - demonstrates full flow)
    // -----------------------------------------------------------------------

    console.log("[5] Connecting to NATS...");
    console.log("[5]   (Skipping actual connection in this example)");
    console.log("[5]   In production, would connect with:");
    console.log("[5]     - URL: " + NATS_URL);
    console.log("[5]     - JWT: " + (natsCreds?.userJwt.slice(0, 30) || "N/A") + "...");
    console.log("");

    // -----------------------------------------------------------------------
    // Step 6: Demonstrate reconnection
    // -----------------------------------------------------------------------

    console.log("[6] Reconnection demonstration");
    console.log("[6]   Restart this script to see credential reuse");
    console.log("[6]   Existing credentials will be loaded automatically");
    console.log("[6]   No need to repeat enrollment process");
    console.log("");

    // -----------------------------------------------------------------------
    // Summary
    // -----------------------------------------------------------------------

    console.log("==============================================");
    console.log("  ✅ Enrollment Complete");
    console.log("==============================================");
    console.log("");
    console.log("What happened:");
    console.log("  1. Generated X25519 identity key pair");
    console.log("  2. Called /enroll with public key");
    console.log("  3. Operator approved via web UI");
    console.log("  4. Received NATS user credentials");
    console.log("  5. Stored credentials locally");
    console.log("  6. Ready to connect to NATS");
    console.log("");
    console.log("Security properties:");
    console.log("  ✓ Ingress-free (outbound-only HTTPS)");
    console.log("  ✓ No secret pasting (operator approval via web)");
    console.log("  ✓ X25519 encryption for E2E messaging");
    console.log("  ✓ Local credential persistence (0o600 perms)");
    console.log("  ✓ Reconnection without re-pairing");
    console.log("");
    console.log("Credential storage:");
    console.log(
      "  Location: ~/.openclaw-webchannel-v2/<v2_namespace>/credentials.json",
    );
    console.log("  Permissions: 0o600 (owner read/write only)");
    console.log("  Contains: Identity key + NATS creds + metadata");
    console.log("");
    console.log("Next steps:");
    console.log("  1. Connect to NATS with credentials");
    console.log("  2. Handle browser requests");
    console.log("  3. Send/receive encrypted messages");
    console.log("  4. Restart to test auto-reconnection");
    console.log("");
    console.log("==============================================");
    console.log("");

  } catch (error) {
    console.error("");
    console.error("❌ Enrollment failed:", error);
    console.error("");
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Utility functions
// ---------------------------------------------------------------------------

function bufferToBase64Url(buffer: Uint8Array): string {
  const base64 = btoa(String.fromCharCode(...buffer));
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
