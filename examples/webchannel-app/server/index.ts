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
  EnrollmentValidationError,
  MemoryEnrollmentRepository,
  type AgentKeyRegistry,
  type EnrollmentRequest,
  type PollRequest,
  type SetupTrustChainResult,
} from "@mir-stream/webchannel-saas";
import esbuild from "esbuild";

import { bootNatsServer, type NatsHandle } from "./nats.js";
import { login, canAccess, newSessionToken, type AppUser } from "./users.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = join(__dirname, "..", "web");

// ---------------------------------------------------------------------------
// Config (env-overridable, sensible local defaults).
// ---------------------------------------------------------------------------
const PORT = parseInt(process.env.PORT || "4000", 10);
// Relay mode. Unset or "self-contained" (DEFAULT) → boot a LOCAL nats-server and
// mint creds signed by the trust chain's own account (zero-setup). "synadia" →
// the relay is Synadia Cloud / NGS: NO local nats-server is booted, and creds are
// signed by an operator-supplied managed-account SIGNING key. In BOTH modes the
// browser and the openclaw agent connect OUTBOUND to the relay (zero-inbound).
const RELAY = (process.env.RELAY || "self-contained").toLowerCase();
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
// Admin token gating for approve/deny/revoke. It deliberately fails closed when
// unset because approval hands back tenant-wide agent credentials.
const ENROLLMENT_ADMIN_TOKEN = process.env.ENROLLMENT_ADMIN_TOKEN;

// ---------------------------------------------------------------------------
// 1. Trust chain (persistent) + NATS relay + bootstrap issuer + enrollment.
//
// Two relay modes, gated on RELAY:
//   self-contained (default) → build a local account, boot a local nats-server
//     (server/nats.ts), and mint browser/agent creds signed by that account.
//   synadia → the relay is an externally-managed NGS account. loadOrCreateTrustChain
//     is called with `externalNatsAccount` so trustChain.natsConfig.mode ===
//     "external" (no operator/account/resolver to write, NO local nats-server to
//     boot); NATS_URL is the env NGS wss; creds carry the managed accountId as
//     `issuerAccountId` / `natsIssuerAccountId`.
// ---------------------------------------------------------------------------
type RelaySetup = {
  trustChain: SetupTrustChainResult;
  natsUrl: string;
  /** Child nats-server handle — self-contained only; null in synadia mode. */
  natsHandle: NatsHandle | null;
  /** Managed account identity (A…) — external mode only; undefined otherwise. */
  natsIssuerAccountId: string | undefined;
};

async function setupRelay(): Promise<RelaySetup> {
  if (RELAY === "synadia") {
    // External NGS mode: browser + agent both connect OUTBOUND to the managed
    // relay; the SaaS mints creds signed by the account SIGNING key. All three
    // vars are REQUIRED — fail fast, naming exactly what is missing.
    const missing = ["NATS_URL", "NATS_ACCOUNT_ID", "NATS_ACCOUNT_SIGNING_SEED"].filter(
      (n) => !process.env[n],
    );
    if (missing.length > 0) {
      throw new Error(
        `RELAY=synadia requires ${missing.join(", ")} to be set ` +
          `(NATS_URL = NGS wss URL, NATS_ACCOUNT_ID = managed account A…, ` +
          `NATS_ACCOUNT_SIGNING_SEED = account signing seed SA… [SECRET]).`,
      );
    }
    const natsUrl = process.env.NATS_URL as string;
    const accountId = process.env.NATS_ACCOUNT_ID as string;
    const signingSeed = process.env.NATS_ACCOUNT_SIGNING_SEED as string;
    const trustChain = await loadOrCreateTrustChain(TRUST_CHAIN_PATH, {
      operatorName: "example-operator",
      accountName: "example-account",
      // The signing seed is SECRET — never persisted, never logged in full.
      externalNatsAccount: { signingSeed, accountId },
    });
    // No local nats-server: the managed NGS relay runs its own server.
    console.log(`[app] relay mode: synadia (account ${accountId.slice(0, 6)}…) → ${natsUrl}`);
    return { trustChain, natsUrl, natsHandle: null, natsIssuerAccountId: accountId };
  }

  // self-contained (default): local account + local nats-server.
  const trustChain = await loadOrCreateTrustChain(TRUST_CHAIN_PATH, {
    operatorName: "example-operator",
    accountName: "example-account",
  });
  if (!trustChain.private.systemAccountCredentials) {
    throw new Error("self-contained trust chain is missing its system-account credential");
  }
  // Overload without `externalNatsAccount` narrows natsConfig to the
  // self-contained shape bootNatsServer needs.
  const natsHandle = bootNatsServer({
    natsConfig: trustChain.natsConfig,
    systemAccountCredentials: trustChain.private.systemAccountCredentials,
    configDir: CONFIG_DIR,
    wsPort: NATS_WS,
    tcpPort: NATS_TCP,
  });
  await natsHandle.ready;
  console.log(`[app] relay mode: self-contained (local nats-server ${natsHandle.natsUrl})`);
  return { trustChain, natsUrl: natsHandle.natsUrl, natsHandle, natsIssuerAccountId: undefined };
}

const { trustChain, natsUrl: NATS_URL, natsHandle, natsIssuerAccountId } = await setupRelay();
const privateChain = trustChain.private;

const issuer = await createBootstrapIssuer({
  rsaPrivateKeyPem: privateChain.rsaPrivateKeyPem,
  kid: trustChain.kid,
});

// F2: durable agent identity-key registry — approval records the attested agent
// key so /bootstrap can pin it for the browser's register-delivered-K auth.
const enrollmentRepository = new MemoryEnrollmentRepository();
const agentKeyRegistry = enrollmentRepository;
const enrollment = new DeviceFlowEnrollment({
  saasTrustChain: privateChain,
  natsAccountConfig: trustChain.natsConfig,
  // In external mode this stamps `nats.issuer_account` on the agent's minted
  // creds so the managed resolver maps them to the NGS account; undefined
  // (omitted) in self-contained mode.
  natsIssuerAccountId,
  saasBaseUrl: SAAS_BASE_URL,
  jwksUrl: `${SAAS_BASE_URL}/.well-known/jwks.json`,
  bootstrapUrl: `${SAAS_BASE_URL}/bootstrap`,
  natsUrl: NATS_URL,
  // CONTRACT (DeviceFlowOptions.issuer): the issuer DELIVERED to the agent at
  // enrollment must equal the `iss` minted into bootstrap JWTs below — both
  // read the single SAAS_ISSUER variable, so they cannot disagree.
  issuer: SAAS_ISSUER,
  repository: agentKeyRegistry,
});
type ExampleEnrollmentHandlerOptions = {
  enrollment: Pick<DeviceFlowEnrollment, "approve" | "deny">;
  registry: Pick<AgentKeyRegistry, "revokeActive">;
  adminToken?: string;
};

/** Consumer-owned operator routes, implemented exclusively with the public SaaS API. */
export function createExampleEnrollmentHandler(options: ExampleEnrollmentHandlerOptions) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
      if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

      const path = new URL(req.url ?? "/", "http://example.invalid").pathname;
      const actionMatch = path.match(/^\/admin\/enrollments\/([^/]+)\/(approve|deny)$/);
      const isRevoke = path === "/revoke";
      if (req.method !== "POST" || (!actionMatch && !isRevoke)) return sendJson(res, { error: "not found" }, 404);
      if (!options.adminToken) return sendJson(res, { error: "enrollment admin token is not configured" }, 503);
      if (req.headers.authorization !== `Bearer ${options.adminToken}`) return sendJson(res, { error: "unauthorized" }, 401);

      const payload = await readBody(req);
      if (payload === null || (payload !== undefined && (typeof payload !== "object" || Array.isArray(payload)))) {
        return sendJson(res, { error: "invalid JSON body" }, 400);
      }
      const body = (payload ?? {}) as Record<string, unknown>;
      if (actionMatch) {
        let userCode: string;
        try { userCode = decodeURIComponent(actionMatch[1]); }
        catch { return sendJson(res, { error: "malformed URL encoding" }, 400); }
        if (actionMatch[2] === "deny") {
          const denied = await options.enrollment.deny(userCode);
          return sendJson(res, { denied }, denied ? 200 : 404);
        }
        const replaceActivationId = typeof body.replaceActivationId === "string" ? body.replaceActivationId : undefined;
        const outcome = await options.enrollment.approve(userCode, replaceActivationId ? { replaceActivationId } : {});
        switch (outcome.kind) {
          case "conflict": return sendJson(res, { error: "conflict", activationId: outcome.existing?.activationId ?? null, fingerprint: outcome.existing?.keyIdFingerprint ?? null, enrolledAt: outcome.existing?.enrolledAt ?? null }, 409);
          case "in_progress": return sendJson(res, { error: "approval_in_progress", error_description: "Approval in progress, retry shortly" }, 409);
          case "revoked_key": return sendJson(res, { error: "revoked_key" }, 410);
          case "rejected": return sendJson(res, { error: "rejected" }, 404);
          case "approved": return sendJson(res, { approved: true, peerId: outcome.result.peerId });
          default: { const exhaustive: never = outcome; return exhaustive; }
        }
      }
      const revoked = await options.registry.revokeActive(String(body.tenant ?? ""), String(body.accountId ?? ""));
      return sendJson(res, { revoked }, revoked ? 200 : 404);
    } catch (error) {
      console.error("[app] enrollment operator route error:", error);
      if (!res.headersSent) return sendJson(res, { error: "internal server error" }, 500);
      if (!res.writableEnded) res.end();
    }
  };
}

const exampleEnrollmentAdminHandler = createExampleEnrollmentHandler({
  adminToken: ENROLLMENT_ADMIN_TOKEN, enrollment, registry: agentKeyRegistry,
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
export const exampleAppRequestHandler = (req: IncomingMessage, res: ServerResponse) => {
  const delegatedPath = new URL(req.url ?? "/", "http://example.invalid").pathname;
  if (/^\/admin\/enrollments\/[^/]+\/(?:approve|deny)$/.test(delegatedPath) || delegatedPath === "/revoke") {
    void exampleEnrollmentAdminHandler(req, res);
    return;
  }
  void handle(req, res).catch((err) => {
    console.error("[app] unhandled route error:", err);
    if (!res.headersSent) sendJson(res, { error: "Internal server error" }, 500);
  });
};
const server = createServer(exampleAppRequestHandler);

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
      // External (synadia) mode only — signs the browser creds under the managed
      // NGS account. Undefined (omitted) in self-contained mode.
      issuerAccountId: natsIssuerAccountId,
    });
    return sendJson(res, { ...creds, natsUrl: NATS_URL });
  }

  // ── POST /bootstrap — session-gated bootstrap JWT (N1) ────────────────────
  if (method === "POST" && path === "/bootstrap") {
    const user = sessionUser(req);
    if (!user) return sendJson(res, { error: "not authenticated" }, 401);
    const body = await readBody(req);
    if (!body || typeof body !== "object") return sendJson(res, { error: "Invalid JSON body" }, 400);
    const { tenant, accountId, deviceX25519PublicKey, devicePopPublicKey } = body as {
      tenant?: string;
      accountId?: string;
      deviceX25519PublicKey?: string;
      devicePopPublicKey?: string;
    };
    if (!accountId || !deviceX25519PublicKey) {
      return sendJson(res, { error: "Missing required fields: accountId, deviceX25519PublicKey" }, 400);
    }
    if (tenant !== undefined && tenant !== TENANT) {
      return sendJson(res, { error: `user not authorized for tenant "${tenant}"` }, 403);
    }
    // This canonical example serves one fixed scalar target. The caller may
    // echo the session-provided value, but cannot choose another signing tuple;
    // peerId is likewise the session uuid (body peerId, if any, is ignored).
    if (accountId !== ACCOUNT_ID || !canAccess(user, ACCOUNT_ID)) {
      console.warn(`[bootstrap] ${user.username} DENIED for account "${accountId}"`);
      return sendJson(res, { error: `user not authorized for account "${accountId}"` }, 403);
    }
    let claims;
    try {
      claims = buildBootstrapClaims({
        iss: SAAS_ISSUER,
        peerId: user.uuid, // server-pinned, NOT from body
        accountId: ACCOUNT_ID,
        tenant: TENANT,
        deviceX25519PublicKey,
        devicePopPublicKey,
      });
    } catch (err) {
      // buildBootstrapClaims asserts 32-byte keys → surface a 400, not a 500.
      return sendJson(res, { error: `Invalid claims: ${(err as Error).message}` }, 400);
    }
    const jwt = await issuer.sign(claims);
    // F2: pin the SaaS-attested agent key so the browser can authenticate the
    // register-delivered K. Present once the account's agent has enrolled.
    const agentPublicKey = (await agentKeyRegistry.getActive(TENANT, ACCOUNT_ID))?.publicKey ?? null;
    return sendJson(res, {
      jwt,
      peerId: user.uuid,
      natsUrl: NATS_URL,
      ...(agentPublicKey ? { agentPublicKey } : {}),
    });
  }

  // ── Plugin-facing device-flow enrollment (openclaw gateway) ───────────────
  // Intentionally OPEN: /api/enroll only CREATES a pending user_code (it hands
  // back no creds), and /api/poll only polls one. Add a rate-limit in production.
  if (method === "POST" && path === "/api/enroll") {
    const body = await readBody(req);
    if (!body) return sendJson(res, { error: "Invalid JSON body" }, 400);
    const enrollRequest = body as EnrollmentRequest;
    if (!enrollRequest.agentPublicKey || !enrollRequest.tenant || !enrollRequest.accountId) {
      return sendJson(res, { error: "Missing required fields: agentPublicKey, tenant, accountId" }, 400);
    }
    let resp;
    try {
      resp = await enrollment.enroll(enrollRequest);
    } catch (err) {
      if (err instanceof EnrollmentValidationError) {
        return sendJson(res, { error: err.message }, 400);
      }
      throw err;
    }
    console.log(`[enroll] created ${resp.user_code} (account=${enrollRequest.accountId})`);
    return sendJson(res, {
      device_code: resp.device_code,
      user_code: resp.user_code,
      verification_uri: resp.verification_uri,
      verification_uri_complete: resp.verification_uri_complete,
      expires_in: resp.expires_in,
      interval: resp.interval,
    });
  }
  if (method === "POST" && path === "/api/poll") {
    const body = await readBody(req);
    if (!body) return sendJson(res, { error: "Invalid JSON body" }, 400);
    const pollRequest = body as PollRequest;
    if (!pollRequest.device_code) return sendJson(res, { error: "Missing device_code" }, 400);
    const result = await enrollment.poll(pollRequest);
    return sendJson(res, result, "error" in result ? 400 : 200);
  }
  sendJson(res, { error: "not found" }, 404);
}

export function startExampleAppServer(): void { server.listen(PORT, () => {
  console.log(`[app] SaaS backend on ${SAAS_BASE_URL}`);
  console.log(`[app] tenant=${TENANT} account=${ACCOUNT_ID}`);
}); }

if (process.argv[1] === fileURLToPath(import.meta.url)) startExampleAppServer();

// Best-effort teardown of the child nats-server. Only registered in
// self-contained mode — in synadia mode no child is spawned (the relay is the
// managed NGS server), so there is nothing to reap.
if (natsHandle) {
  const child = natsHandle;
  const killChild = (): void => {
    try {
      child.proc.kill();
    } catch {
      /* ignore */
    }
  };
  const shutdown = (): void => {
    killChild();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  // Defense-in-depth: reap the child on ANY exit (e.g. an unexpected throw after
  // bootNatsServer), so the nats-server is never orphaned. `exit` handlers must
  // be synchronous — kill() is.
  process.on("exit", killChild);
}
