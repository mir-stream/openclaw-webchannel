#!/usr/bin/env node
/**
 * Reference HTTP server harness for DeviceFlowEnrollment.
 *
 * This script demonstrates how to expose the device flow enrollment
 * endpoints as HTTP API endpoints. It's intended as a reference implementation,
 * not a production server.
 *
 * USAGE:
 *   node dist/reference/enrollment-server.js
 *
 * ENDPOINTS:
 *   POST /api/enroll - Initiate enrollment (plugin → SaaS)
 *   POST /api/poll   - Poll for approval (plugin → SaaS)
 *   GET  /enroll     - Approval UI (operator → browser)
 *   POST /approve    - Approve enrollment (operator → SaaS)
 *   POST /deny       - Deny enrollment (operator → SaaS)
 *
 * ENVIRONMENT VARIABLES:
 *   PORT              - Server port (default: 3000)
 *   SAAS_BASE_URL     - SaaS base URL (default: http://localhost:3000)
 *   NATS_URL          - NATS WebSocket URL (default: wss://nats.example.com).
 *                       In external mode, point this at the Synadia wss:// URL.
 *   NATS_ACCOUNT_SIGNING_SEED - (external mode) account signing-key seed ("SA…").
 *                       SECRET. When set together with NATS_ACCOUNT_ID, the
 *                       issuer runs in EXTERNAL mode: it mints Synadia-valid
 *                       user creds and emits NO operator/account/resolver config.
 *   NATS_ACCOUNT_ID   - (external mode) account identity public key ("A…").
 *
 * SECURITY NOTES:
 *   - This reference uses HTTP for demonstration. Use TLS in production.
 *   - Enrollment store is in-memory. Use persistent storage in production.
 *   - No authentication on the approval UI. Add operator auth in production.
 *   - CORS is enabled for all origins. Restrict in production.
 */

import { DeviceFlowEnrollment, MemoryEnrollmentStore } from "../src/device-flow-enrollment.js";
import { setupTrustChain } from "../src/setup-trust-chain.js";
import { loadOrCreateTrustChain } from "../src/persistent-trust-chain.js";
import { buildBootstrapClaims } from "../src/bootstrap-claims.js";
import { mintNatsUserCreds, type NatsUserRole } from "../src/nats-user-creds.js";
import { assertValidSubjectToken } from "../src/subject-token.js";
import type { EnrollmentRequest, PollRequest } from "../src/device-flow-types.js";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { webcrypto } from "node:crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const PORT = parseInt(process.env.PORT || "3000", 10);
const SAAS_BASE_URL = process.env.SAAS_BASE_URL || `http://localhost:${PORT}`;
const NATS_URL = process.env.NATS_URL || "wss://nats.example.com";
// `iss` claim for bootstrap JWTs (the gateway checks this against
// channels.webchannel.auth.jwt.issuer). Defaults to the base URL.
const SAAS_ISSUER = process.env.SAAS_ISSUER || SAAS_BASE_URL;
// When set, TEST-ONLY routes (/test/nats-user, /test/bootstrap-jwt) are served.
// Leave unset in any real deployment.
const ENABLE_TEST_ROUTES = process.env.ENABLE_TEST_ROUTES === "1";
// When set, the operator JWT + memory-resolver config are written here at boot so
// a harness can build a JWT-auth nats.conf from the SAME trust chain this issuer
// uses. Only public NATS config is written — never the RSA key or account seed.
const NATS_CONFIG_OUT = process.env.NATS_CONFIG_OUT || "";
// When set, the trust chain is PERSISTED here (generated once, reloaded verbatim
// on every later boot) instead of regenerated each start. A long-lived / launchd
// issuer MUST set this: a regenerated chain would invalidate every already-enrolled
// agent's cached NATS creds and every issued bootstrap JWT on restart. Unset keeps
// the original ephemeral behavior (fresh chain each boot) for hermetic harnesses.
const TRUST_CHAIN_PATH = process.env.TRUST_CHAIN_PATH || "";
// External (managed) NATS account (Synadia Cloud / NGS). When BOTH are set the
// issuer mints user creds on behalf of this account and writes NO
// operator/account/resolver config. The signing seed is a SECRET — never logged.
const NATS_ACCOUNT_SIGNING_SEED = process.env.NATS_ACCOUNT_SIGNING_SEED || "";
const NATS_ACCOUNT_ID = process.env.NATS_ACCOUNT_ID || "";
const EXTERNAL_NATS_ACCOUNT =
  NATS_ACCOUNT_SIGNING_SEED && NATS_ACCOUNT_ID
    ? { signingSeed: NATS_ACCOUNT_SIGNING_SEED, accountId: NATS_ACCOUNT_ID }
    : undefined;

// ---------------------------------------------------------------------------
// Trust chain (real — issues genuine NATS user creds). Persisted when
// TRUST_CHAIN_PATH is set, else generated fresh at boot (harness default).
// External mode is selected by NATS_ACCOUNT_SIGNING_SEED + NATS_ACCOUNT_ID.
// ---------------------------------------------------------------------------

const trustChainOptions = {
  operatorName: "reference-operator",
  accountName: "reference-account",
  externalNatsAccount: EXTERNAL_NATS_ACCOUNT,
};
const trustChain = TRUST_CHAIN_PATH
  ? await loadOrCreateTrustChain(TRUST_CHAIN_PATH, trustChainOptions)
  : await setupTrustChain(trustChainOptions);
const mockTrustChain = trustChain.private;
const mockNatsConfig = trustChain.natsConfig;
// In external mode every minted user JWT must carry issuer_account = the managed
// account id (so Synadia's resolver accepts it). Undefined → self-signed mode.
const natsIssuerAccountId =
  mockNatsConfig.mode === "external" ? mockNatsConfig.accountPublicKey : undefined;

// ---------------------------------------------------------------------------
// Publish public NATS config (operator JWT + memory resolver) for a harness
// ---------------------------------------------------------------------------
//
// A JWT-auth nats-server must trust the SAME operator/account this issuer mints
// user creds for. When NATS_CONFIG_OUT is set we write the two PUBLIC artifacts
// the server needs — never any private material.
if (NATS_CONFIG_OUT) {
  if (mockNatsConfig.mode === "external") {
    // Synadia hosts the nats-server and already trusts the account — there is no
    // operator JWT / resolver to emit. Writing one would be meaningless.
    console.log(
      "[nats-config] external mode — skipping operator/resolver output (Synadia hosts the server)",
    );
  } else {
    mkdirSync(NATS_CONFIG_OUT, { recursive: true });
    const operatorJwtPath = join(NATS_CONFIG_OUT, "operator.jwt");
    const resolverPath = join(NATS_CONFIG_OUT, "resolver.json");
    writeFileSync(operatorJwtPath, mockNatsConfig.operatorJwt);
    writeFileSync(resolverPath, JSON.stringify(mockNatsConfig.resolverConfig, null, 2));
    console.log(`[nats-config] wrote operator JWT → ${operatorJwtPath}`);
    console.log(`[nats-config] wrote memory resolver (${Object.keys(mockNatsConfig.resolverConfig).length} account) → ${resolverPath}`);
  }
}

// ---------------------------------------------------------------------------
// RS256 bootstrap-JWT signing (TEST-ONLY) — reuses THIS issuer's trust chain
// ---------------------------------------------------------------------------
//
// The reference register hop (`/webchannel/nats/register`) verifies a bootstrap
// JWT against the gateway's configured JWKS — which is THIS issuer's
// `/.well-known/jwks.json`. So a harness that drives the register hop needs a
// bootstrap JWT signed by the SAME RSA key. We import it once at boot (held in
// memory; never served/logged).
const bootstrapRsaPrivateKey: webcrypto.CryptoKey | null = ENABLE_TEST_ROUTES
  ? await importRsaPrivateKeyFromPem(trustChain.private.rsaPrivateKeyPem)
  : null;
const bootstrapKid = trustChain.kid;

/** Import a PKCS#8 PEM RSA private key into a webcrypto signing key. */
async function importRsaPrivateKeyFromPem(pem: string): Promise<webcrypto.CryptoKey> {
  const body = pem
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/\s/g, "");
  const der = Buffer.from(body, "base64");
  return webcrypto.subtle.importKey(
    "pkcs8",
    new Uint8Array(der),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

/** RS256-sign a claims payload with this issuer's RSA key (header.kid = trust kid). */
async function signBootstrapJwt(payload: Record<string, unknown>): Promise<string> {
  if (!bootstrapRsaPrivateKey) throw new Error("bootstrap signing disabled (set ENABLE_TEST_ROUTES=1)");
  const header = { alg: "RS256", typ: "JWT", kid: bootstrapKid };
  const b64urlJson = (obj: unknown): string => Buffer.from(JSON.stringify(obj)).toString("base64url");
  const signingInput = `${b64urlJson(header)}.${b64urlJson(payload)}`;
  const sig = await webcrypto.subtle.sign(
    { name: "RSASSA-PKCS1-v1_5" },
    bootstrapRsaPrivateKey,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${Buffer.from(new Uint8Array(sig)).toString("base64url")}`;
}

// ---------------------------------------------------------------------------
// Enrollment service
// ---------------------------------------------------------------------------

const enrollmentStore = new MemoryEnrollmentStore();
const enrollment = new DeviceFlowEnrollment({
  saasTrustChain: mockTrustChain,
  natsAccountConfig: mockNatsConfig,
  natsIssuerAccountId,
  saasBaseUrl: SAAS_BASE_URL,
  jwksUrl: `${SAAS_BASE_URL}/.well-known/jwks.json`,
  bootstrapUrl: `${SAAS_BASE_URL}/bootstrap`,
  natsUrl: NATS_URL,
  expirationSeconds: Number(process.env.EXPIRATION_SECONDS ?? 600),
  pollIntervalSeconds: Number(process.env.POLL_INTERVAL_SECONDS ?? 5),
  store: enrollmentStore,
});

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function setCorsHeaders(res: any): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function sendJson(res: any, data: unknown, status = 200): void {
  res.setHeader("Content-Type", "application/json");
  res.writeHead(status);
  res.end(JSON.stringify(data, null, 2));
}

function sendHtml(res: any, html: string): void {
  res.setHeader("Content-Type", "text/html");
  res.writeHead(200);
  res.end(html);
}

function parseJsonBody(req: any, callback: (body: unknown) => void): void {
  let body = "";
  req.on("data", (chunk: string) => {
    body += chunk.toString();
  });
  req.on("end", () => {
    try {
      const parsed = JSON.parse(body);
      callback(parsed);
    } catch (err) {
      callback(null);
    }
  });
}

// ---------------------------------------------------------------------------
// HTML templates
// ---------------------------------------------------------------------------

async function renderApprovalPage(userCode?: string): Promise<string> {
  const templatePath = join(__dirname, "enrollment-ui.html");
  try {
    const template = await readFile(templatePath, "utf-8");
    if (userCode) {
      return template.replaceAll("{{USER_CODE}}", userCode);
    }
    return template;
  } catch (err) {
    // Fallback inline template if file not found
    return fallbackApprovalTemplate(userCode);
  }
}

function fallbackApprovalTemplate(userCode?: string): string {
  const displayCode = userCode || "{{USER_CODE}}";
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>WebChannel Plugin Enrollment</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      max-width: 600px;
      margin: 50px auto;
      padding: 20px;
      text-align: center;
    }
    .user-code {
      font-size: 32px;
      font-weight: bold;
      letter-spacing: 4px;
      background: #f5f5f5;
      padding: 20px;
      border-radius: 8px;
      margin: 20px 0;
    }
    .button-group {
      margin: 30px 0;
    }
    button {
      font-size: 18px;
      padding: 12px 24px;
      margin: 0 10px;
      border: none;
      border-radius: 6px;
      cursor: pointer;
    }
    .approve {
      background: #4CAF50;
      color: white;
    }
    .deny {
      background: #f44336;
      color: white;
    }
    button:hover {
      opacity: 0.9;
    }
    .info {
      background: #e3f2fd;
      padding: 15px;
      border-radius: 6px;
      margin: 20px 0;
      text-align: left;
    }
    .pending {
      color: #ff9800;
      font-weight: bold;
    }
    .approved {
      color: #4CAF50;
      font-weight: bold;
    }
    .denied {
      color: #f44336;
      font-weight: bold;
    }
  </style>
</head>
<body>
  <h1>🔐 WebChannel Plugin Enrollment</h1>

  <div class="info">
    <p><strong>Plugin Enrollment Request</strong></p>
    <p>A WebChannel plugin is requesting enrollment. Review the details below and approve or deny the request.</p>
  </div>

  <div class="user-code">${displayCode}</div>

  <div class="button-group">
    <button class="approve" onclick="approveEnrollment()">✓ Approve</button>
    <button class="deny" onclick="denyEnrollment()">✗ Deny</button>
  </div>

  <div id="status"></div>

  <script>
    const userCode = "${displayCode}";
    const statusEl = document.getElementById("status");

    async function approveEnrollment() {
      statusEl.className = "pending";
      statusEl.textContent = "Processing approval...";

      try {
        const res = await fetch("/approve", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ user_code: userCode })
        });

        const result = await res.json();

        if (result.success) {
          statusEl.className = "approved";
          statusEl.innerHTML = "✓ Enrollment Approved!<br><br>" +
            "Plugin: " + result.accountId + "<br>" +
            "Tenant: " + result.tenant + "<br>" +
            "Peer ID: " + result.peerId;
        } else {
          statusEl.className = "denied";
          statusEl.textContent = "✗ Approval failed: " + (result.error || "Unknown error");
        }
      } catch (err) {
        statusEl.className = "denied";
        statusEl.textContent = "✗ Network error: " + err.message;
      }
    }

    async function denyEnrollment() {
      statusEl.className = "pending";
      statusEl.textContent = "Processing denial...";

      try {
        const res = await fetch("/deny", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ user_code: userCode })
        });

        const result = await res.json();

        if (result.success) {
          statusEl.className = "denied";
          statusEl.textContent = "✗ Enrollment Denied";
        } else {
          statusEl.className = "denied";
          statusEl.textContent = "✗ Denial failed: " + (result.error || "Unknown error");
        }
      } catch (err) {
        statusEl.className = "denied";
        statusEl.textContent = "✗ Network error: " + err.message;
      }
    }
  </script>

  <div class="info">
    <p><strong>What happens when you approve?</strong></p>
    <ul style="text-align: left;">
      <li>Plugin receives NATS user credentials</li>
      <li>Plugin's X25519 public key is registered with SaaS</li>
      <li>Peer ID is generated for session routing</li>
      <li>Plugin can now connect to NATS and handle browser requests</li>
    </ul>
  </div>
</body>
</html>
  `;
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const server = createServer(async (req, res) => {
  // Enable CORS
  setCorsHeaders(res);

  // Handle OPTIONS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(200);
    res.end();
    return;
  }

  // Parse URL path
  const url = new URL(req.url!, `http://${req.headers.host}`);
  const path = url.pathname;

  console.log(`[${req.method}] ${path}`);

  try {
    // ---------------------------------------------------------------------
    // POST /api/enroll - Initiate enrollment (plugin → SaaS)
    // ---------------------------------------------------------------------
    if (path === "/api/enroll" && req.method === "POST") {
      parseJsonBody(req, (body) => {
        if (!body) {
          sendJson(res, { error: "Invalid JSON body" }, 400);
          return;
        }

        const enrollRequest = body as EnrollmentRequest;

        // Validate request
        if (!enrollRequest.agentPublicKey || !enrollRequest.tenant) {
          sendJson(res, { error: "Missing required fields: agentPublicKey, tenant" }, 400);
          return;
        }

        // Reject tenant/accountId that would break the NATS subject hierarchy or
        // cross tenant boundaries (subject-injection guard) — 400, not 500.
        try {
          assertValidSubjectToken(enrollRequest.tenant, "tenant");
          if (enrollRequest.accountId !== undefined) {
            assertValidSubjectToken(enrollRequest.accountId, "accountId");
          }
        } catch (err) {
          sendJson(res, { error: (err as Error).message }, 400);
          return;
        }

        // Create enrollment
        enrollment
          .enroll(enrollRequest)
          .then((enrollResponse) => {
            console.log(`[enroll] Created enrollment: ${enrollResponse.user_code}`);
            sendJson(res, enrollResponse);
          })
          .catch((err) => {
            console.error("[enroll] Error:", err);
            sendJson(res, { error: "Internal server error" }, 500);
          });
      });
      return;
    }

    // ---------------------------------------------------------------------
    // POST /api/poll - Poll for approval (plugin → SaaS)
    // ---------------------------------------------------------------------
    if (path === "/api/poll" && req.method === "POST") {
      parseJsonBody(req, (body) => {
        if (!body) {
          sendJson(res, { error: "Invalid JSON body" }, 400);
          return;
        }

        const pollRequest = body as PollRequest;

        if (!pollRequest.device_code) {
          sendJson(res, { error: "Missing device_code" }, 400);
          return;
        }

        // Poll enrollment status
        enrollment
          .poll(pollRequest)
          .then((pollResult) => {
            if ("error" in pollResult) {
              console.log(`[poll] Device code ${pollRequest.device_code}: ${pollResult.error}`);
              sendJson(res, pollResult, 400);
            } else {
              console.log(`[poll] Device code ${pollRequest.device_code}: approved`);
              sendJson(res, pollResult);
            }
          })
          .catch((err) => {
            console.error("[poll] Error:", err);
            sendJson(res, { error: "Internal server error" }, 500);
          });
      });
      return;
    }

    // ---------------------------------------------------------------------
    // GET /enroll - Approval UI (operator → browser)
    // ---------------------------------------------------------------------
    if (path === "/enroll" && req.method === "GET") {
      const userCode = url.searchParams.get("user_code") || undefined;
      const html = await renderApprovalPage(userCode);
      sendHtml(res, html);
      return;
    }

    // ---------------------------------------------------------------------
    // POST /approve - Approve enrollment (operator → SaaS)
    // ---------------------------------------------------------------------
    if (path === "/approve" && req.method === "POST") {
      parseJsonBody(req, (body) => {
        if (!body || typeof body !== "object") {
          sendJson(res, { success: false, error: "Invalid JSON body" }, 400);
          return;
        }

        const { user_code } = body as { user_code?: string };

        if (!user_code) {
          sendJson(res, { success: false, error: "Missing user_code" }, 400);
          return;
        }

        // Approve enrollment
        enrollment
          .approve(user_code)
          .then((result) => {
            if (result) {
              console.log(`[approve] Approved enrollment: ${user_code}`);

              // Get enrollment details for response
              enrollmentStore.getEnrollmentByUserCode(user_code).then((enrollment) => {
                sendJson(res, {
                  success: true,
                  peerId: result.peerId,
                  tenant: enrollment?.tenant,
                  accountId: enrollment?.accountId,
                });
              });
            } else {
              console.log(`[approve] Enrollment not found or expired: ${user_code}`);
              sendJson(res, { success: false, error: "Enrollment not found or expired" }, 404);
            }
          })
          .catch((err) => {
            console.error("[approve] Error:", err);
            sendJson(res, { success: false, error: "Internal server error" }, 500);
          });
      });
      return;
    }

    // ---------------------------------------------------------------------
    // POST /deny - Deny enrollment (operator → SaaS)
    // ---------------------------------------------------------------------
    if (path === "/deny" && req.method === "POST") {
      parseJsonBody(req, (body) => {
        if (!body || typeof body !== "object") {
          sendJson(res, { success: false, error: "Invalid JSON body" }, 400);
          return;
        }

        const { user_code } = body as { user_code?: string };

        if (!user_code) {
          sendJson(res, { success: false, error: "Missing user_code" }, 400);
          return;
        }

        // Deny enrollment
        enrollment
          .deny(user_code)
          .then((success) => {
            if (success) {
              console.log(`[deny] Denied enrollment: ${user_code}`);
              sendJson(res, { success: true });
            } else {
              console.log(`[deny] Enrollment not found: ${user_code}`);
              sendJson(res, { success: false, error: "Enrollment not found" }, 404);
            }
          })
          .catch((err) => {
            console.error("[deny] Error:", err);
            sendJson(res, { success: false, error: "Internal server error" }, 500);
          });
      });
      return;
    }

    // ---------------------------------------------------------------------
    // GET /.well-known/jwks.json - Public RSA JWKS (for JWT verifiers)
    // ---------------------------------------------------------------------
    if (path === "/.well-known/jwks.json" && req.method === "GET") {
      sendJson(res, trustChain.jwks);
      return;
    }

    // ---------------------------------------------------------------------
    // POST /test/nats-user - TEST-ONLY NATS user creds for a driver/browser peer
    // ---------------------------------------------------------------------
    if (path === "/test/nats-user" && req.method === "POST") {
      if (!ENABLE_TEST_ROUTES) {
        sendJson(res, { error: "Not found" }, 404);
        return;
      }
      parseJsonBody(req, (body) => {
        if (!body || typeof body !== "object") {
          sendJson(res, { error: "Invalid JSON body" }, 400);
          return;
        }
        const { tenant, role } = body as { tenant?: string; role?: NatsUserRole };
        if (!tenant) {
          sendJson(res, { error: "Missing tenant" }, 400);
          return;
        }
        mintNatsUserCreds({
          accountSeed: mockTrustChain.natsAccountSeed,
          tenant,
          role: role === "agent" ? "agent" : "browser",
          issuerAccountId: natsIssuerAccountId,
        })
          .then((creds) => {
            console.log(`[test/nats-user] minted ${role ?? "browser"} creds for tenant=${tenant}`);
            // The relay URL travels WITH the minted creds (SaaS = rendezvous
            // authority) so the browser dials where the SaaS says, not a
            // page-configured URL. Mirrors the enrolled plugin's EnrollmentResult.
            sendJson(res, { ...creds, natsUrl: NATS_URL });
          })
          .catch((err) => {
            console.error("[test/nats-user] Error:", err);
            sendJson(res, { error: "Internal server error" }, 500);
          });
      });
      return;
    }

    // ---------------------------------------------------------------------
    // POST /test/bootstrap-jwt - TEST-ONLY RS256 bootstrap JWT for the register hop
    // ---------------------------------------------------------------------
    if (path === "/test/bootstrap-jwt" && req.method === "POST") {
      if (!ENABLE_TEST_ROUTES) {
        sendJson(res, { error: "Not found" }, 404);
        return;
      }
      parseJsonBody(req, (body) => {
        if (!body || typeof body !== "object") {
          sendJson(res, { error: "Invalid JSON body" }, 400);
          return;
        }
        const { tenant, accountId, peerId, deviceX25519PublicKey, devicePopPublicKey } = body as {
          tenant?: string;
          accountId?: string;
          peerId?: string;
          deviceX25519PublicKey?: string;
          devicePopPublicKey?: string;
        };
        if (!tenant || !accountId || !peerId || !deviceX25519PublicKey) {
          sendJson(
            res,
            { error: "Missing required fields: tenant, accountId, peerId, deviceX25519PublicKey" },
            400,
          );
          return;
        }
        let claims;
        try {
          claims = buildBootstrapClaims({
            iss: SAAS_ISSUER,
            peerId,
            accountId,
            tenant,
            deviceX25519PublicKey,
            devicePopPublicKey,
          });
        } catch (err) {
          sendJson(res, { error: `Invalid claims: ${(err as Error).message}` }, 400);
          return;
        }
        signBootstrapJwt(claims as unknown as Record<string, unknown>)
          .then((jwt) => {
            console.log(`[test/bootstrap-jwt] issued JWT (kid=${bootstrapKid}) for peerId=${peerId}, tenant=${tenant}`);
            sendJson(res, { jwt, peerId, kid: bootstrapKid });
          })
          .catch((err) => {
            console.error("[test/bootstrap-jwt] Error:", err);
            sendJson(res, { error: "Internal server error" }, 500);
          });
      });
      return;
    }

    // ---------------------------------------------------------------------
    // 404 - Not found
    // ---------------------------------------------------------------------
    sendJson(res, { error: "Not found" }, 404);
  } catch (err) {
    console.error("[server] Error:", err);
    sendJson(res, { error: "Internal server error" }, 500);
  }
});

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------

server.listen(PORT, () => {
  console.log("");
  console.log("==============================================");
  console.log("  WebChannel SaaS Enrollment Server");
  console.log("==============================================");
  console.log("");
  console.log(`Server running at: ${SAAS_BASE_URL}`);
  console.log("");
  console.log("Endpoints:");
  console.log(`  POST ${SAAS_BASE_URL}/api/enroll  - Initiate enrollment (plugin)`);
  console.log(`  POST ${SAAS_BASE_URL}/api/poll    - Poll for approval (plugin)`);
  console.log(`  GET  ${SAAS_BASE_URL}/enroll      - Approval UI (operator)`);
  console.log(`  POST ${SAAS_BASE_URL}/approve    - Approve enrollment (operator)`);
  console.log(`  POST ${SAAS_BASE_URL}/deny       - Deny enrollment (operator)`);
  console.log("");
  console.log("Configuration:");
  console.log(`  NATS account mode: ${mockNatsConfig.mode}${mockNatsConfig.mode === "external" ? ` (account ${mockNatsConfig.accountPublicKey})` : ""}`);
  console.log(`  NATS URL: ${NATS_URL}`);
  console.log(`  Enrollment expiration: 600 seconds`);
  console.log(`  Poll interval: 5 seconds`);
  console.log("");
  console.log("⚠️  SECURITY NOTES:");
  console.log("  - This is a reference implementation using HTTP");
  console.log("  - Use TLS in production");
  console.log("  - Enrollment store is in-memory (use Redis/DB in production)");
  console.log("  - No operator authentication (add in production)");
  console.log("  - CORS enabled for all origins (restrict in production)");
  console.log("");
  console.log("Press Ctrl+C to stop");
  console.log("==============================================");
  console.log("");

  if (ENABLE_TEST_ROUTES) {
    console.warn("");
    console.warn("################################################################");
    console.warn("# ⚠️  ENABLE_TEST_ROUTES=1 — UNAUTHENTICATED TEST ROUTES ENABLED");
    console.warn("################################################################");
    console.warn("#   POST /test/nats-user      — mints tenant-scoped NATS user creds");
    console.warn("#   POST /test/bootstrap-jwt   — mints RS256 bootstrap JWTs");
    console.warn("#");
    console.warn("#   These routes have NO authentication and will mint credentials");
    console.warn("#   for ANY tenant on request — a cross-tenant credential-minting");
    console.warn("#   oracle. They exist ONLY for hermetic E2E harnesses.");
    console.warn("#");
    console.warn("#   NEVER set ENABLE_TEST_ROUTES=1 in a real deployment.");
    console.warn("################################################################");
    console.warn("");
  }
});

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("\n\nShutting down server...");
  server.close(() => {
    console.log("Server stopped");
    process.exit(0);
  });
});
