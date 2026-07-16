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
import { MemoryAgentKeyRegistry } from "../src/agent-key-registry.js";
import { createReferenceEnrollmentHttpHandler } from "../src/enrollment-http-handler.js";
import { serializeBootstrapResponse, serializeEnrollmentResponse } from "../src/p1-1-wire-adapter.js";
import { escapeHtmlAttribute, renderApprovalTemplate } from "./approval-page-renderer.js";
import { setupTrustChain } from "../src/setup-trust-chain.js";
import { loadOrCreateTrustChain } from "../src/persistent-trust-chain.js";
import { buildBootstrapClaims } from "../src/bootstrap-claims.js";
import { DemoUserDirectory, seedDemoUsers, type DemoUser } from "../src/demo-users.js";
import { mintNatsUserCreds, issueBrowserCredentials, type NatsUserRole } from "../src/nats-user-creds.js";
import { assertValidSubjectToken } from "../src/subject-token.js";
import type { EnrollmentRequest, PollRequest } from "../src/device-flow-types.js";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
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
// When set, the SaaS server ALSO serves the unified single-origin DEMO surface:
//   GET /                 → the two-panel demo app (operator approves + visitor chats)
//   GET /widget.js        → the browser client bundle (esbuild IIFE, global WebDemo)
//   GET /demo/enrollments → live list of enrollment requests (for the admin panel)
// This mirrors production, where the SaaS is ONE web origin hosting both the admin
// dashboard and the embeddable chat widget. Demo-only (conflates two personas onto
// one page) so it stays behind a flag; the real approval/enroll routes are unchanged.
const ENABLE_DEMO_UI = process.env.ENABLE_DEMO_UI === "1";
// Path to the unified demo HTML (served at GET /). Required when ENABLE_DEMO_UI=1.
const DEMO_APP_HTML = process.env.DEMO_APP_HTML || "";
// Path to the browser client entry esbuild bundles into /widget.js.
const DEMO_CLIENT_ENTRY = process.env.DEMO_CLIENT_ENTRY || "";
// Chat-widget config injected into the demo page as globalThis.__DEMO_CONFIG__.
// natsUrl/issuerUrl are derived (NATS_URL / SAAS_BASE_URL); the rest come from env.
const DEMO_GW_URL = process.env.DEMO_GW_URL || "";
const DEMO_ACCOUNT_ID = process.env.DEMO_ACCOUNT_ID || "default-agent";
const DEMO_TENANT = process.env.DEMO_TENANT || "default-tenant";
const DEMO_PEER_ID = process.env.DEMO_PEER_ID || "web-allreal-peer";
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
// The register hop (now over NATS request/reply on the account's
// `…{peerId}.register` subject) verifies a bootstrap JWT against the gateway's
// configured JWKS — which is THIS issuer's `/.well-known/jwks.json`. So a harness
// that drives the register hop needs a bootstrap JWT signed by the SAME RSA key.
// We import it once at boot (held in memory; never served/logged).
// Also import under ENABLE_DEMO_UI so the session-gated `/bootstrap` route can
// sign real bootstrap JWTs from the login flow (the demo replaces the
// unauthenticated `/test/bootstrap-jwt` forgery route with a login-gated one).
const bootstrapRsaPrivateKey: webcrypto.CryptoKey | null =
  ENABLE_TEST_ROUTES || ENABLE_DEMO_UI
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
// F2: durable agent identity-key registry (see the demo server for rationale).
const agentKeyRegistry = new MemoryAgentKeyRegistry();
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
  agentKeyRegistry,
});
const enrollmentAdminToken = process.env.ENROLLMENT_ADMIN_TOKEN;
export const createReferenceEnrollmentHandler = createReferenceEnrollmentHttpHandler;
const referenceAdminHandler = createReferenceEnrollmentHandler({
  adminToken: enrollmentAdminToken, enrollment,
  registry: agentKeyRegistry, bootstrap: () => ({ error: "bootstrap is handled by the session route" }),
  async onApproved(userCode) {
    markDemoEnroll(userCode, "approved");
    const record = await enrollmentStore.getEnrollmentByUserCode(userCode);
    return { tenant: record?.tenant, accountId: record?.accountId };
  },
  onDenied(userCode) { markDemoEnroll(userCode, "denied"); },
});

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function setCorsHeaders(res: any): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
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
  return renderApprovalTemplate({
    templatePath,
    userCode,
    readTemplate: readFile,
    fallback: fallbackApprovalTemplate,
  });
}

function fallbackApprovalTemplate(userCode?: string): string {
  const displayCode = escapeHtmlAttribute(userCode || "{{USER_CODE}}");
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
<body data-user-code="${displayCode}">
  <h1>🔐 WebChannel Plugin Enrollment</h1>

  <div class="info">
    <p><strong>Plugin Enrollment Request</strong></p>
    <p>A WebChannel plugin is requesting enrollment. Review the details below and approve or deny the request.</p>
  </div>

  <div class="user-code">${displayCode}</div>
  <label>Admin token <input id="admin-token" type="password" autocomplete="off"></label>

  <div class="button-group">
    <button class="approve" onclick="approveEnrollment()">✓ Approve</button>
    <button class="deny" onclick="denyEnrollment()">✗ Deny</button>
  </div>

  <div id="status"></div>

  <script>
    const userCode = document.body.dataset.userCode || "";
    let adminToken = "";
    const statusEl = document.getElementById("status");

    async function approveEnrollment(replaceActivationId) {
      statusEl.className = "pending";
      statusEl.textContent = "Processing approval...";

      try {
        const res = await fetch("/approve", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": "Bearer " + (adminToken ||= document.getElementById("admin-token").value) },
          body: JSON.stringify({ user_code: userCode, ...(replaceActivationId ? { replaceActivationId } : {}) })
        });

        const result = await res.json();

        if (result.success) {
          statusEl.className = "approved";
          statusEl.textContent = "✓ Enrollment Approved!\nPlugin: " + (result.accountId || "N/A") + "\nTenant: " + (result.tenant || "N/A") + "\nPeer ID: " + (result.peerId || "N/A");
          statusEl.style.whiteSpace = "pre-line";
        } else if (res.status === 409 && result.error === "conflict") {
          const when = result.enrolledAt ? new Date(result.enrolledAt).toISOString() : "unknown";
          const warning = "This approval replaces existing agent key " + (result.fingerprint || "unknown") + " (enrolled " + when + "). Continue?";
          statusEl.className = "denied";
          statusEl.textContent = warning;
          if (result.activationId && confirm(warning)) await approveEnrollment(result.activationId);
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
          headers: { "Content-Type": "application/json", "Authorization": "Bearer " + (adminToken ||= document.getElementById("admin-token").value) },
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
// Unified demo surface (ENABLE_DEMO_UI) — one origin serving admin + widget.
// ---------------------------------------------------------------------------
//
// Production-shaped mirror: the SaaS hosts BOTH the operator approval flow and the
// embeddable chat widget. We keep a lightweight in-server view of enrollment
// requests (the MemoryEnrollmentStore has no "list pending" API) so the admin panel
// can render live cards + Approve/Deny — a stand-in for a real SaaS dashboard.

type DemoEnrollStatus = "pending" | "approved" | "denied";
interface DemoEnroll {
  userCode: string;
  tenant?: string;
  accountId?: string;
  status: DemoEnrollStatus;
}
// Keyed by user_code, preserves insertion order for stable rendering.
const demoEnrollments = new Map<string, DemoEnroll>();

function trackDemoEnroll(userCode: string, tenant?: string, accountId?: string): void {
  if (!ENABLE_DEMO_UI) return;
  demoEnrollments.set(userCode, { userCode, tenant, accountId, status: "pending" });
}
function markDemoEnroll(userCode: string, status: DemoEnrollStatus): void {
  if (!ENABLE_DEMO_UI) return;
  const e = demoEnrollments.get(userCode);
  if (e) e.status = status;
}

// esbuild the browser client entry → IIFE bundle (global `WebDemo`), once at boot.
function buildDemoBundle(): string {
  const root = join(__dirname, "..", "..", "..");
  const candidates = [
    join(root, "node_modules/.bin/esbuild"),
    join(root, "node_modules/tsx/node_modules/esbuild/bin/esbuild"),
  ];
  const esbuildBin = candidates.find((p) => {
    try {
      readFileSync(p);
      return true;
    } catch {
      return false;
    }
  });
  if (!esbuildBin) throw new Error("esbuild binary not found under node_modules");
  const outFile = join(tmpdir(), `webchannel-widget-${process.pid}.js`);
  execFileSync(esbuildBin, [
    DEMO_CLIENT_ENTRY,
    "--bundle",
    "--platform=browser",
    "--format=iife",
    "--global-name=WebDemo",
    "--footer:js=;globalThis.WebDemo=WebDemo;",
    `--outfile=${outFile}`,
    "--log-level=warning",
  ]);
  return readFileSync(outFile, "utf8");
}

let demoBundle = "";
let demoPageHtml = "";
if (ENABLE_DEMO_UI) {
  if (!DEMO_APP_HTML || !DEMO_CLIENT_ENTRY) {
    console.error(
      "[demo-ui] ENABLE_DEMO_UI=1 requires DEMO_APP_HTML and DEMO_CLIENT_ENTRY env paths",
    );
    process.exit(4);
  }
  demoBundle = buildDemoBundle();
  const rawHtml = readFileSync(DEMO_APP_HTML, "utf8");
  const configScript = `<script>globalThis.__DEMO_CONFIG__=${JSON.stringify({
    natsUrl: NATS_URL,
    issuerUrl: SAAS_BASE_URL,
    gwUrl: DEMO_GW_URL,
    accountId: DEMO_ACCOUNT_ID,
    tenant: DEMO_TENANT,
    peerId: DEMO_PEER_ID,
  })};</script>`;
  // Inject into <head> so __DEMO_CONFIG__ exists before the /widget.js <script> (in <body>) runs.
  demoPageHtml = rawHtml.replace(/<head[^>]*>/i, (m) => `${m}\n  ${configScript}`);
  console.log("[demo-ui] unified demo surface enabled (GET / + /widget.js + /demo/enrollments)");
}

// ---------------------------------------------------------------------------
// Demo login (ENABLE_DEMO_UI) — the SaaS user-domain behind the interactive demo.
// ---------------------------------------------------------------------------
//
// A browser visitor logs in (id/pw); the SaaS derives a STABLE peerId from the
// authenticated user (its stored uuid) and mints a bootstrap JWT ONLY after a
// server-side canAccess(user, accountId) check. peerId is taken from the SESSION,
// never from the request body — so it can't be spoofed. Sessions are in-memory
// (demo-grade); a real SaaS would use a signed/DB-backed session store.
const userDir = ENABLE_DEMO_UI ? new DemoUserDirectory(seedDemoUsers(DEMO_ACCOUNT_ID)) : null;
const sessions = new Map<string, string>(); // sid → username

/** Fresh 256-bit session token, base64url. */
function newSessionToken(): string {
  const bytes = new Uint8Array(32);
  webcrypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("base64url");
}

/** Read a single cookie value from the request `Cookie` header. */
function readCookie(req: any, name: string): string | undefined {
  const header: string | undefined = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

/** Resolve the logged-in DemoUser from the request's `sid` cookie, or null. */
function sessionUser(req: any): DemoUser | null {
  if (!userDir) return null;
  const sid = readCookie(req, "sid");
  if (!sid) return null;
  const username = sessions.get(sid);
  if (!username) return null;
  return userDir.get(username) ?? null;
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

export const referenceEnrollmentRequestHandler = async (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => {
  const delegatedPath = new URL(req.url ?? "/", "http://reference.invalid").pathname;
  if (["/approve", "/deny", "/revoke"].includes(delegatedPath) || (req.method === "OPTIONS" && ["/approve", "/deny", "/revoke"].includes(delegatedPath))) {
    await referenceAdminHandler(req, res);
    return;
  }
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
    // Unified demo surface (only when ENABLE_DEMO_UI=1)
    // ---------------------------------------------------------------------
    if (ENABLE_DEMO_UI && req.method === "GET" && (path === "/" || path === "/index.html")) {
      sendHtml(res, demoPageHtml);
      return;
    }
    if (ENABLE_DEMO_UI && req.method === "GET" && path === "/widget.js") {
      res.setHeader("Content-Type", "text/javascript; charset=utf-8");
      res.writeHead(200);
      res.end(demoBundle);
      return;
    }
    if (ENABLE_DEMO_UI && req.method === "GET" && path === "/demo/enrollments") {
      sendJson(res, Array.from(demoEnrollments.values()));
      return;
    }

    // ---------------------------------------------------------------------
    // GET /demo/users - non-secret directory view for the admin panel.
    // POST /demo/users/:username/accounts - edit a user's allowedAccounts.
    //
    // These DEMONSTRATE the user↔aud (account) authorization capability at the
    // SaaS: the operator grants/revokes which accounts a login may reach, and the
    // change takes effect on that user's next bootstrap (canAccess is checked at
    // JWT-mint). In-memory + NO auth, consistent with the existing unauthenticated
    // approve/deny demo UI; production would authenticate the operator and persist.
    // ---------------------------------------------------------------------
    if (ENABLE_DEMO_UI && req.method === "GET" && path === "/demo/users") {
      sendJson(res, userDir!.list());
      return;
    }
    if (
      ENABLE_DEMO_UI &&
      req.method === "POST" &&
      path.startsWith("/demo/users/") &&
      path.endsWith("/accounts")
    ) {
      // Path shape: /demo/users/<username>/accounts
      const username = decodeURIComponent(path.slice("/demo/users/".length, -"/accounts".length));
      parseJsonBody(req, (body) => {
        if (!body || typeof body !== "object") {
          sendJson(res, { error: "Invalid JSON body" }, 400);
          return;
        }
        const { accounts } = body as { accounts?: unknown };
        if (!Array.isArray(accounts) || !accounts.every((a) => typeof a === "string")) {
          sendJson(res, { error: "accounts must be an array of strings" }, 400);
          return;
        }
        if (!userDir!.setAllowedAccounts(username, accounts as string[])) {
          sendJson(res, { error: `unknown user "${username}"` }, 404);
          return;
        }
        const updated = userDir!.get(username);
        console.log(`[demo-users] ${username} allowedAccounts → [${(updated?.allowedAccounts ?? []).join(", ")}]`);
        sendJson(res, { ok: true, username, allowedAccounts: updated?.allowedAccounts ?? [] });
      });
      return;
    }

    // ---------------------------------------------------------------------
    // POST /login - Demo user login (ENABLE_DEMO_UI) → sets the `sid` cookie.
    // The peerId is DERIVED from the authenticated user (its uuid), never from
    // the request — closing the client-supplied-peerId spoof.
    // ---------------------------------------------------------------------
    if (ENABLE_DEMO_UI && req.method === "POST" && path === "/login") {
      parseJsonBody(req, (body) => {
        if (!body || typeof body !== "object") {
          sendJson(res, { error: "Invalid JSON body" }, 400);
          return;
        }
        const { username, password } = body as { username?: string; password?: string };
        if (!username || !password) {
          sendJson(res, { error: "Missing username or password" }, 400);
          return;
        }
        const user = userDir!.authenticate(username, password);
        if (!user) {
          sendJson(res, { error: "invalid credentials" }, 401);
          return;
        }
        const sid = newSessionToken();
        sessions.set(sid, user.username);
        // HttpOnly (no JS access) + SameSite=Lax; same-origin so no `Secure`/CORS creds.
        res.setHeader("Set-Cookie", `sid=${sid}; HttpOnly; Path=/; SameSite=Lax; Max-Age=86400`);
        console.log(`[login] ${user.username} → peerId=${user.uuid}`);
        sendJson(res, { ok: true, username: user.username });
      });
      return;
    }

    // ---------------------------------------------------------------------
    // POST /nats-user - Session-gated BROWSER NATS creds (ENABLE_DEMO_UI). The
    // login-gated replacement for /test/nats-user: requires a valid session (no
    // unauthenticated cross-tenant oracle).
    //
    // SECURITY: this is a BROWSER-facing route, so it ALWAYS mints role:"browser"
    // (per-peer scoped, pinned to `webchannel.{tenant}.*.{peerId}.>`). It routes
    // through issueBrowserCredentials, which HARDCODES the browser role — a client
    // cannot escalate to tenant-wide "agent"/"observer" creds via a body `role`.
    // Operator-only observer/agent creds must be minted behind an operator-auth
    // check — the SAME operator gate that /approve + /deny require in production —
    // NEVER from this browser route.
    // ---------------------------------------------------------------------
    if (ENABLE_DEMO_UI && req.method === "POST" && path === "/nats-user") {
      const user = sessionUser(req);
      if (!user) {
        sendJson(res, { error: "not authenticated" }, 401);
        return;
      }
      parseJsonBody(req, (body) => {
        if (!body || typeof body !== "object") {
          sendJson(res, { error: "Invalid JSON body" }, 400);
          return;
        }
        const { tenant } = body as { tenant?: string };
        if (!tenant) {
          sendJson(res, { error: "Missing tenant" }, 400);
          return;
        }
        // Subject-injection guard (mirror /api/enroll): reject a tenant that would
        // break the `webchannel.{tenant}.>` hierarchy — 400, not 500.
        try {
          assertValidSubjectToken(tenant, "tenant");
        } catch (err) {
          sendJson(res, { error: (err as Error).message }, 400);
          return;
        }
        // Authorize the tenant the way /bootstrap authorizes accountId (via
        // canAccess): this single-tenant reference serves ONLY its own tenant, so a
        // session may not mint creds for an arbitrary one. (The removed cross-tenant
        // /test/nats-user oracle is exactly what this closes.)
        if (tenant !== DEMO_TENANT) {
          console.warn(`[nats-user] ${user.username} DENIED tenant "${tenant}" (server tenant is "${DEMO_TENANT}")`);
          sendJson(res, { error: `not authorized for tenant "${tenant}"` }, 403);
          return;
        }
        // browser creds are pinned to THIS session's peerId (user.uuid — the
        // authenticated subject, never client input).
        issueBrowserCredentials({
          accountSeed: mockTrustChain.natsAccountSeed,
          tenant,
          peerId: user.uuid,
          issuerAccountId: natsIssuerAccountId,
        })
          .then((creds) => {
            console.log(`[nats-user] minted browser creds for ${user.username} tenant=${tenant}`);
            // The relay URL travels WITH the minted creds (SaaS = rendezvous authority).
            sendJson(res, { ...creds, natsUrl: NATS_URL });
          })
          .catch((err) => {
            console.error("[nats-user] Error:", err);
            sendJson(res, { error: "Internal server error" }, 500);
          });
      });
      return;
    }

    // ---------------------------------------------------------------------
    // POST /bootstrap - Session-gated bootstrap JWT (ENABLE_DEMO_UI). peerId is
    // DERIVED from the session (user.uuid) and the JWT is minted ONLY after a
    // server-side canAccess(user, accountId) authorization check. Body peerId is
    // ignored. Replaces the unauthenticated /test/bootstrap-jwt forgery route.
    // ---------------------------------------------------------------------
    if (ENABLE_DEMO_UI && req.method === "POST" && path === "/bootstrap") {
      const user = sessionUser(req);
      if (!user) {
        sendJson(res, { error: "not authenticated" }, 401);
        return;
      }
      if (!bootstrapRsaPrivateKey) {
        sendJson(res, { error: "bootstrap signing disabled" }, 500);
        return;
      }
      parseJsonBody(req, (body) => {
        if (!body || typeof body !== "object") {
          sendJson(res, { error: "Invalid JSON body" }, 400);
          return;
        }
        // IGNORE any body peerId — the identity is the authenticated user's uuid.
        const { tenant, accountId, deviceX25519PublicKey, devicePopPublicKey } = body as {
          tenant?: string;
          accountId?: string;
          deviceX25519PublicKey?: string;
          devicePopPublicKey?: string;
        };
        if (!tenant || !accountId || !deviceX25519PublicKey) {
          sendJson(
            res,
            { error: "Missing required fields: tenant, accountId, deviceX25519PublicKey" },
            400,
          );
          return;
        }
        // The user↔aud (account) ownership gate — the authorization boundary.
        if (!userDir!.canAccess(user, accountId)) {
          console.warn(`[bootstrap] ${user.username} DENIED for account "${accountId}" (not authorized)`);
          sendJson(res, { error: `user not authorized for account "${accountId}"` }, 403);
          return;
        }
        let claims;
        try {
          claims = buildBootstrapClaims({
            iss: SAAS_ISSUER,
            peerId: user.uuid,
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
          .then(async (jwt) => {
            // F2: pin the SaaS-attested agent identity key so the browser can
            // authenticate the register-delivered K. Omitted when the account has
            // no enrolled agent key yet (the client only requires it on the
            // register-hop path).
            const agentPublicKey = (await agentKeyRegistry.getActive(tenant, accountId))?.publicKey ?? null;
            console.log(
              `[bootstrap] issued JWT (kid=${bootstrapKid}) for ${user.username} peerId=${user.uuid}, account=${accountId}` +
                (agentPublicKey ? " (+agentPublicKey pin)" : ""),
            );
            sendJson(res, serializeBootstrapResponse({
              jwt,
              peerId: user.uuid,
            }, agentPublicKey));
          })
          .catch((err) => {
            console.error("[bootstrap] Error:", err);
            sendJson(res, { error: "Internal server error" }, 500);
          });
      });
      return;
    }

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
        if (!enrollRequest.agentPublicKey || !enrollRequest.tenant || !enrollRequest.accountId) {
          sendJson(res, { error: "Missing required fields: agentPublicKey, tenant, accountId" }, 400);
          return;
        }

        // Reject tenant/accountId that would break the NATS subject hierarchy or
        // cross tenant boundaries (subject-injection guard) — 400, not 500.
        try {
          assertValidSubjectToken(enrollRequest.tenant, "tenant");
          assertValidSubjectToken(enrollRequest.accountId, "accountId");
        } catch (err) {
          sendJson(res, { error: (err as Error).message }, 400);
          return;
        }

        // Create enrollment
        enrollment
          .enroll(enrollRequest)
          .then((enrollResponse) => {
            console.log(`[enroll] Created enrollment: ${enrollResponse.user_code}`);
            trackDemoEnroll(enrollResponse.user_code, enrollRequest.tenant, enrollRequest.accountId);
            sendJson(res, serializeEnrollmentResponse(enrollResponse));
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
      // Disabled under ENABLE_DEMO_UI: the demo replaces this unauthenticated
      // mint oracle with the session-gated POST /nats-user below. Serving both
      // would leave the login gate bypassable.
      if (!ENABLE_TEST_ROUTES || ENABLE_DEMO_UI) {
        sendJson(res, { error: "Not found" }, 404);
        return;
      }
      parseJsonBody(req, (body) => {
        if (!body || typeof body !== "object") {
          sendJson(res, { error: "Invalid JSON body" }, 400);
          return;
        }
        const { tenant, role, peerId } = body as { tenant?: string; role?: NatsUserRole; peerId?: string };
        if (!tenant) {
          sendJson(res, { error: "Missing tenant" }, 400);
          return;
        }
        // browser creds are per-peer scoped; the TEST caller supplies the peerId
        // it will bootstrap under (mirrors the register subject it drives).
        const resolvedRole: NatsUserRole =
          role === "agent" ? "agent" : role === "observer" ? "observer" : "browser";
        if (resolvedRole === "browser" && !peerId) {
          sendJson(res, { error: "Missing peerId (required for role 'browser')" }, 400);
          return;
        }
        mintNatsUserCreds({
          accountSeed: mockTrustChain.natsAccountSeed,
          tenant,
          role: resolvedRole,
          ...(resolvedRole === "browser" ? { peerId } : {}),
          issuerAccountId: natsIssuerAccountId,
        })
          .then((creds) => {
            console.log(`[test/nats-user] minted ${resolvedRole} creds for tenant=${tenant}${peerId ? ` peerId=${peerId}` : ""}`);
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
      // Disabled under ENABLE_DEMO_UI: this route trusts a client-supplied peerId
      // (unauthenticated forgery of any identity). The demo replaces it with the
      // session-gated POST /bootstrap below, which derives peerId server-side.
      if (!ENABLE_TEST_ROUTES || ENABLE_DEMO_UI) {
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
          .then(async (jwt) => {
            // The pin is registry-only. Caller-supplied key overrides are intentionally
            // unsupported so this test route cannot produce a false-green trust path.
            const pin = (await agentKeyRegistry.getActive(tenant, accountId))?.publicKey;
            console.log(`[test/bootstrap-jwt] issued JWT (kid=${bootstrapKid}) for peerId=${peerId}, tenant=${tenant}`);
            sendJson(res, { jwt, peerId, kid: bootstrapKid, ...(pin ? { agentPublicKey: pin } : {}) });
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
};
const server = createServer(referenceEnrollmentRequestHandler);

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------

export function startReferenceEnrollmentServer(): void { server.listen(PORT, () => {
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
  if (ENABLE_DEMO_UI) {
    console.log(`  GET  ${SAAS_BASE_URL}/           - Unified demo (approve + chat, one origin)`);
    console.log(`  GET  ${SAAS_BASE_URL}/widget.js  - Browser chat widget bundle`);
  }
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
  console.log("  - Operator actions require ENROLLMENT_ADMIN_TOKEN; when unset they are unavailable (503)");
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
}); }

if (process.argv[1] === fileURLToPath(import.meta.url)) startReferenceEnrollmentServer();

// Graceful shutdown
if (process.argv[1] === fileURLToPath(import.meta.url)) process.on("SIGINT", () => {
  console.log("\n\nShutting down server...");
  enrollmentStore.close(); // stop the A1 background sweeper
  server.close(() => {
    console.log("Server stopped");
    process.exit(0);
  });
});
