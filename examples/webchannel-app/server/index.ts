/**
 * Reference WebChannel SaaS backend — PUBLIC API ONLY.
 *
 * Every library import below is the published package name
 * `@mir-stream/webchannel-saas`; there are ZERO relative `../packages/` or deep
 * subpath imports. This file shows the full production trust flow a third-party
 * SaaS would build:
 *
 *   loadOrCreateTrustChain → boot nats-server (server/nats.ts) →
 *   createBootstrapIssuer + DeviceFlowEnrollment → HTTP routes.
 *
 * The two bootstrap crypto operations (RS256 bootstrap-JWT signing, browser NATS
 * cred minting) go through the 0.1.2 public API — no hand-rolled webcrypto, no
 * internal mint helper.
 *
 * SECURITY (N1): POST /bootstrap and POST /nats-user are SESSION-GATED. The
 * peerId is ALWAYS the authenticated session uuid — a body `peerId` is ignored —
 * and the accountId is authorized server-side (canAccess). Without this gate the
 * server would be an unauthenticated oracle minting SaaS-signed bootstrap JWTs
 * for any attacker-chosen accountId/victim peerId.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  loadOrCreateTrustChain,
  createBootstrapIssuer,
  issueBrowserCredentials,
  buildBootstrapClaims,
  DeviceFlowEnrollment,
  type EnrollmentRequest,
  type PollRequest,
} from "@mir-stream/webchannel-saas";
import esbuild from "esbuild";

import { bootNatsServer } from "./nats.js";
import { login, canAccess, newSessionToken, type AppUser } from "./users.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = join(__dirname, "..", "web");

// ---------------------------------------------------------------------------
// Config (env-overridable, sensible local defaults).
// ---------------------------------------------------------------------------
const PORT = parseInt(process.env.PORT || "4000", 10);
const NATS_WS = parseInt(process.env.NATS_WS || "18790", 10);
const NATS_TCP = parseInt(process.env.NATS_TCP || "14790", 10);
const TENANT = process.env.APP_TENANT || "app-tenant";
// Single-account demo: the accountId is a SERVER CONSTANT, never client-trusted.
// A multi-account app would look this up per-user and call canAccess() below.
const ACCOUNT_ID = process.env.APP_ACCOUNT || "agent-dev";
const SAAS_BASE_URL = process.env.SAAS_BASE_URL || `http://127.0.0.1:${PORT}`;
// The bootstrap-JWT `iss`. Defaults to the base URL (the plugin derives the
// expected issuer from the SaaS anchor), so a zero-config boot self-matches.
const SAAS_ISSUER = process.env.SAAS_ISSUER || SAAS_BASE_URL;
const TRUST_CHAIN_PATH =
  process.env.TRUST_CHAIN_PATH || join(tmpdir(), `webchannel-app-trust-${process.pid}.json`);
const CONFIG_DIR = process.env.NATS_CONFIG_OUT || join(tmpdir(), `webchannel-app-nats-${process.pid}`);
// Admin token gating /admin/enrollments/:code/approve (the ONLY route that hands
// back tenant-wide agent creds). If unset we auto-generate one and print it at
// boot so the openclaw walkthrough still works zero-config.
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || randomBytes(24).toString("hex");
const ADMIN_TOKEN_GENERATED = !process.env.ADMIN_TOKEN;

// ---------------------------------------------------------------------------
// 1. Trust chain (persistent) + NATS relay + bootstrap issuer + enrollment.
// ---------------------------------------------------------------------------
const trustChain = await loadOrCreateTrustChain(TRUST_CHAIN_PATH, {
  operatorName: "example-operator",
  accountName: "example-account",
});
const privateChain = trustChain.private;
const natsConfig = trustChain.natsConfig; // NatsSelfContainedAccountConfig

const nats = bootNatsServer({
  natsConfig,
  configDir: CONFIG_DIR,
  wsPort: NATS_WS,
  tcpPort: NATS_TCP,
});
const NATS_URL = nats.natsUrl;
await nats.ready;
console.log(`[app] nats-server ready → ${NATS_URL}`);

const issuer = await createBootstrapIssuer({
  rsaPrivateKeyPem: privateChain.rsaPrivateKeyPem,
  kid: trustChain.kid,
});

const enrollment = new DeviceFlowEnrollment({
  saasTrustChain: privateChain,
  natsAccountConfig: natsConfig,
  saasBaseUrl: SAAS_BASE_URL,
  jwksUrl: `${SAAS_BASE_URL}/.well-known/jwks.json`,
  bootstrapUrl: `${SAAS_BASE_URL}/bootstrap`,
  natsUrl: NATS_URL,
});

// Bundle the browser client (web/app.ts → IIFE) once at boot from dist exports.
async function bundleApp(): Promise<string> {
  const out = await esbuild.build({
    entryPoints: [join(WEB_DIR, "app.ts")],
    bundle: true,
    format: "iife",
    globalName: "WebChannelApp",
    write: false,
    platform: "browser",
  });
  return out.outputFiles[0].text;
}
const appBundle = await bundleApp();

// ---------------------------------------------------------------------------
// Sessions (in-memory; production = signed cookie / session store).
// ---------------------------------------------------------------------------
const sessions = new Map<string, AppUser>();

function sessionUser(req: IncomingMessage): AppUser | null {
  const auth = req.headers["authorization"];
  if (!auth || Array.isArray(auth)) return null;
  const token = auth.replace(/^Bearer\s+/i, "");
  return sessions.get(token) ?? null;
}

// Admin gate for the creds-returning approve route. Accepts either an
// `x-admin-token: <token>` header or `Authorization: Bearer <token>`.
function isAdmin(req: IncomingMessage): boolean {
  const header = req.headers["x-admin-token"];
  const supplied =
    typeof header === "string" && header.length > 0
      ? header
      : (() => {
          const auth = req.headers["authorization"];
          if (!auth || Array.isArray(auth)) return "";
          return auth.replace(/^Bearer\s+/i, "");
        })();
  return supplied.length > 0 && supplied === ADMIN_TOKEN;
}

// ---------------------------------------------------------------------------
// HTTP helpers.
// ---------------------------------------------------------------------------
function sendJson(res: ServerResponse, body: unknown, status = 200): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(payload);
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      if (!raw) return resolve(undefined);
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve(null); // signal malformed JSON
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Router.
// ---------------------------------------------------------------------------
const server = createServer((req, res) => {
  void handle(req, res).catch((err) => {
    console.error("[app] unhandled route error:", err);
    if (!res.headersSent) sendJson(res, { error: "Internal server error" }, 500);
  });
});

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url || "/", SAAS_BASE_URL);
  const path = url.pathname;
  const method = req.method || "GET";

  // ── Static web surface ──────────────────────────────────────────────────
  if (method === "GET" && (path === "/" || path === "/index.html")) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(readFileSync(join(WEB_DIR, "index.html")));
    return;
  }
  if (method === "GET" && path === "/app.js") {
    res.writeHead(200, { "content-type": "application/javascript; charset=utf-8" });
    res.end(appBundle);
    return;
  }
  if (method === "GET" && path === "/.well-known/jwks.json") {
    return sendJson(res, trustChain.jwks);
  }
  if (method === "GET" && path === "/me") {
    // Rendezvous: the shared relay URL travels with the SaaS, not page config.
    return sendJson(res, { natsUrl: NATS_URL, tenant: TENANT, accountId: ACCOUNT_ID });
  }

  // ── POST /login ─────────────────────────────────────────────────────────
  if (method === "POST" && path === "/login") {
    const body = await readBody(req);
    if (!body || typeof body !== "object") return sendJson(res, { error: "Invalid JSON body" }, 400);
    const { username, password } = body as { username?: string; password?: string };
    const user = login(username ?? "", password ?? "");
    if (!user) return sendJson(res, { error: "invalid credentials" }, 401);
    const token = newSessionToken();
    sessions.set(token, user);
    // peerId = the server-derived stable uuid; the browser never chooses it.
    return sendJson(res, { token, peerId: user.uuid, accountId: ACCOUNT_ID, tenant: TENANT });
  }

  // ── POST /nats-user — session-gated browser NATS creds ────────────────────
  if (method === "POST" && path === "/nats-user") {
    const user = sessionUser(req);
    if (!user) return sendJson(res, { error: "not authenticated" }, 401);
    // No client-selectable role/ttl — the server mints a plain browser cred
    // scoped to THIS session's peerId.
    const creds = await issueBrowserCredentials({
      accountSeed: privateChain.natsAccountSeed,
      tenant: TENANT,
      peerId: user.uuid,
    });
    return sendJson(res, { ...creds, natsUrl: NATS_URL });
  }

  // ── POST /bootstrap — session-gated bootstrap JWT (N1) ────────────────────
  if (method === "POST" && path === "/bootstrap") {
    const user = sessionUser(req);
    if (!user) return sendJson(res, { error: "not authenticated" }, 401);
    const body = await readBody(req);
    if (!body || typeof body !== "object") return sendJson(res, { error: "Invalid JSON body" }, 400);
    const { accountId, deviceX25519PublicKey, devicePopPublicKey } = body as {
      accountId?: string;
      deviceX25519PublicKey?: string;
      devicePopPublicKey?: string;
    };
    if (!accountId || !deviceX25519PublicKey) {
      return sendJson(res, { error: "Missing required fields: accountId, deviceX25519PublicKey" }, 400);
    }
    // accountId is authorized server-side; peerId is the session uuid (body
    // peerId, if any, is IGNORED). This closes the signing-oracle vector.
    if (!canAccess(user, accountId)) {
      console.warn(`[bootstrap] ${user.username} DENIED for account "${accountId}"`);
      return sendJson(res, { error: `user not authorized for account "${accountId}"` }, 403);
    }
    let claims;
    try {
      claims = buildBootstrapClaims({
        iss: SAAS_ISSUER,
        peerId: user.uuid, // server-pinned, NOT from body
        accountId,
        tenant: TENANT,
        deviceX25519PublicKey,
        devicePopPublicKey,
      });
    } catch (err) {
      // buildBootstrapClaims asserts 32-byte keys → surface a 400, not a 500.
      return sendJson(res, { error: `Invalid claims: ${(err as Error).message}` }, 400);
    }
    const jwt = await issuer.sign(claims);
    return sendJson(res, { jwt, peerId: user.uuid, natsUrl: NATS_URL });
  }

  // ── Plugin-facing device-flow enrollment (openclaw gateway) ───────────────
  // Intentionally OPEN: /api/enroll only CREATES a pending user_code (it hands
  // back no creds), and /api/poll only polls one. Add a rate-limit in production.
  if (method === "POST" && path === "/api/enroll") {
    const body = await readBody(req);
    if (!body) return sendJson(res, { error: "Invalid JSON body" }, 400);
    const enrollRequest = body as EnrollmentRequest;
    if (!enrollRequest.agentPublicKey || !enrollRequest.tenant) {
      return sendJson(res, { error: "Missing required fields: agentPublicKey, tenant" }, 400);
    }
    const resp = await enrollment.enroll(enrollRequest);
    console.log(`[enroll] created ${resp.user_code} (account=${enrollRequest.accountId})`);
    return sendJson(res, resp);
  }
  if (method === "POST" && path === "/api/poll") {
    const body = await readBody(req);
    if (!body) return sendJson(res, { error: "Invalid JSON body" }, 400);
    const pollRequest = body as PollRequest;
    if (!pollRequest.device_code) return sendJson(res, { error: "Missing device_code" }, 400);
    const result = await enrollment.poll(pollRequest);
    return sendJson(res, result, "error" in result ? 400 : 200);
  }
  // Admin-approve an enrollment. This route returns TENANT-WIDE agent
  // credentials. It MUST be admin-gated — without a gate ANY anonymous caller
  // obtains creds to impersonate the agent for every peer in the tenant. Here it
  // requires ADMIN_TOKEN (x-admin-token header or Authorization: Bearer).
  const approveMatch = path.match(/^\/admin\/enrollments\/([^/]+)\/approve$/);
  if (method === "POST" && approveMatch) {
    if (!isAdmin(req)) return sendJson(res, { error: "admin token required" }, 401);
    const userCode = decodeURIComponent(approveMatch[1]);
    const approved = await enrollment.approve(userCode);
    return sendJson(res, { approved }, approved ? 200 : 404);
  }

  sendJson(res, { error: "not found" }, 404);
}

server.listen(PORT, () => {
  console.log(`[app] SaaS backend on ${SAAS_BASE_URL}`);
  console.log(`[app] tenant=${TENANT} account=${ACCOUNT_ID}`);
  if (ADMIN_TOKEN_GENERATED) {
    console.log(`[app] admin token (for approving enrollments): ${ADMIN_TOKEN}`);
  }
});

// Best-effort teardown of the child nats-server. `killChild` is idempotent.
function killChild(): void {
  try {
    nats.proc.kill();
  } catch {
    /* ignore */
  }
}
function shutdown(): void {
  killChild();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
// Defense-in-depth: reap the child on ANY exit (e.g. an unexpected throw after
// bootNatsServer), so the nats-server is never orphaned. `exit` handlers must be
// synchronous — kill() is.
process.on("exit", killChild);
