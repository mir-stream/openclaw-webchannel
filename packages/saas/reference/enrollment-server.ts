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
 *   NATS_URL          - NATS WebSocket URL (default: wss://nats.example.com)
 *
 * SECURITY NOTES:
 *   - This reference uses HTTP for demonstration. Use TLS in production.
 *   - Enrollment store is in-memory. Use persistent storage in production.
 *   - No authentication on the approval UI. Add operator auth in production.
 *   - CORS is enabled for all origins. Restrict in production.
 */

import { DeviceFlowEnrollment, MemoryEnrollmentStore } from "../src/device-flow-enrollment.js";
import type { EnrollmentRequest, PollRequest } from "../src/device-flow-types.js";
import type { SaasTrustChainPrivate, NatsAccountConfig } from "../src/types.js";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const PORT = parseInt(process.env.PORT || "3000", 10);
const SAAS_BASE_URL = process.env.SAAS_BASE_URL || `http://localhost:${PORT}`;
const NATS_URL = process.env.NATS_URL || "wss://nats.example.com";

// ---------------------------------------------------------------------------
// Mock trust chain (for demonstration)
// ---------------------------------------------------------------------------

const mockTrustChain: SaasTrustChainPrivate = {
  rsaPrivateKeyPem: "-----BEGIN PRIVATE KEY-----\nMOCK_PRIVATE_KEY_FOR_DEMO_ONLY\n-----END PRIVATE KEY-----",
  natsAccountSeed: "SAMOCKACCOUNTSEEDFORDEMONSTRATION",
};

const mockNatsConfig: NatsAccountConfig = {
  operatorJwt: "MOCK_OPERATOR_JWT_FOR_DEMO",
  accountJwt: "MOCK_ACCOUNT_JWT_FOR_DEMO",
  resolverConfig: {},
  accountPublicKey: "AAACCOUNTMOCKPUBLICKEY",
};

// ---------------------------------------------------------------------------
// Enrollment service
// ---------------------------------------------------------------------------

const enrollmentStore = new MemoryEnrollmentStore();
const enrollment = new DeviceFlowEnrollment({
  saasTrustChain: mockTrustChain,
  natsAccountConfig: mockNatsConfig,
  saasBaseUrl: SAAS_BASE_URL,
  jwksUrl: `${SAAS_BASE_URL}/.well-known/jwks.json`,
  bootstrapUrl: `${SAAS_BASE_URL}/bootstrap`,
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
      return template.replace("{{USER_CODE}}", userCode);
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
            "Plugin: " + result.agentId + "<br>" +
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
                  agentId: enrollment?.agentId,
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
});

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("\n\nShutting down server...");
  server.close(() => {
    console.log("Server stopped");
    process.exit(0);
  });
});
