#!/usr/bin/env node
/**
 * Showcase demo SaaS — the trust authority behind the one-page demo.
 *
 * Composes packages/saas PRODUCTION primitives directly (no retired demo
 * assets): a persistent trust chain, device-flow enrollment, a seeded user
 * directory with an admin-gated grant/revoke API, and a session-gated bootstrap
 * flow that mints RS256 bootstrap JWTs (cnf.jwk X25519 + pop_jwk Ed25519).
 *
 * What this server IS (vs the reference enrollment-server):
 *   - The SINGLE web origin for the demo: serves the 3-pane app (admin · chat ·
 *     wiretap) at GET / and the esbuild widget bundle at GET /app.js.
 *   - A rendezvous authority: every credential/bootstrap response carries the
 *     relay URL and (per account) the gateway register URL, so the browser never
 *     learns the relay/gateway from page-local config. GET /me returns the
 *     per-account rendezvous map for the agent switcher.
 *   - Admin-gated: /admin/* requires an admin session (seeded `admin` login).
 *
 * Everything here is demo-side; it changes NO product code. Passwords are
 * demo-grade (bare sha256, see demo-users). Sessions/enrollment tracking are
 * in-memory. Do NOT copy this to production.
 *
 * Boot env (set by run.sh):
 *   PORT                 demo SaaS port (default 3961)
 *   SAAS_ISSUER          `iss` claim for bootstrap JWTs (gateway checks this)
 *   NATS_URL             relay ws:// URL delivered WITH minted creds
 *   NATS_CONFIG_OUT      dir to write operator.jwt + resolver.json (for nats-server)
 *   TRUST_CHAIN_PATH     persist the trust chain here (stable across restarts)
 *   DEMO_TENANT          tenant scope (default demo-tenant)
 *   DEMO_ACCOUNTS        JSON: { "<accountId>": { "registerBaseUrl": "http://…" } }
 *                        the per-account rendezvous map (gateway URLs). Phase 1
 *                        seeds a single account; phase 2 grows the list.
 *   DEMO_LLM_MODE        "echo" | "real" — surfaced to the UI as a badge
 *   DEMO_APP_HTML        path to web/index.html (the 3-pane shell)
 *   DEMO_CLIENT_ENTRY    path to web/src/app.ts (esbuild → /app.js IIFE)
 */

import { DeviceFlowEnrollment, MemoryEnrollmentStore } from "../packages/saas/src/device-flow-enrollment.js";
import { loadOrCreateTrustChain } from "../packages/saas/src/persistent-trust-chain.js";
import { generateRsaKeypair } from "../packages/saas/src/setup-trust-chain.js";
import type { JwkRsaPublicKey } from "../packages/saas/src/types.js";
import { buildBootstrapClaims } from "../packages/saas/src/bootstrap-claims.js";
import {
  DemoUserDirectory,
  seedDemoUsers,
  sha256hex,
  type DemoUser,
} from "../packages/saas/src/demo-users.js";
import { mintNatsUserCreds, type NatsUserRole } from "../packages/saas/src/nats-user-creds.js";
import { assertValidSubjectToken } from "../packages/saas/src/subject-token.js";
import type { EnrollmentRequest, PollRequest } from "../packages/saas/src/device-flow-types.js";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { webcrypto } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const PORT = parseInt(process.env.PORT || "3961", 10);
const SAAS_BASE_URL = process.env.SAAS_BASE_URL || `http://127.0.0.1:${PORT}`;
const SAAS_ISSUER = process.env.SAAS_ISSUER || SAAS_BASE_URL;
const NATS_URL = process.env.NATS_URL || "ws://127.0.0.1:18722";
const NATS_CONFIG_OUT = process.env.NATS_CONFIG_OUT || "";
const TRUST_CHAIN_PATH = process.env.TRUST_CHAIN_PATH || "";
const DEMO_TENANT = process.env.DEMO_TENANT || "demo-tenant";
const DEMO_LLM_MODE = process.env.DEMO_LLM_MODE === "real" ? "real" : "echo";
const DEMO_APP_HTML = process.env.DEMO_APP_HTML || join(__dirname, "web", "index.html");
const DEMO_CLIENT_ENTRY = process.env.DEMO_CLIENT_ENTRY || join(__dirname, "web", "src", "app.ts");

// Per-account rendezvous map: accountId → { registerBaseUrl }. The relay URL is
// shared (one demo-owned nats-server) so it is merged in at response time from
// NATS_URL. Phase 1 seeds a single account; run.sh grows this for the fleet.
type RendezvousEntry = { registerBaseUrl: string };
// Mutable: the fleet can grow at runtime (scene ② — add-agent.sh registers a new
// account's rendezvous via POST /admin/accounts so an open widget can reach it).
const DEMO_ACCOUNTS: Record<string, RendezvousEntry> = (() => {
  const raw = process.env.DEMO_ACCOUNTS;
  if (!raw) return { "agent-dev": { registerBaseUrl: "http://127.0.0.1:19299" } };
  try {
    return JSON.parse(raw) as Record<string, RendezvousEntry>;
  } catch (err) {
    console.error("[demo-saas] DEMO_ACCOUNTS is not valid JSON — falling back to agent-dev:", err);
    return { "agent-dev": { registerBaseUrl: "http://127.0.0.1:19299" } };
  }
})();
// Snapshot of the accounts present at boot — used only to seed alice/bob/admin.
// Runtime-added accounts (scene ②) are NOT auto-granted; an admin grants them.
const SEED_ACCOUNT_IDS = Object.keys(DEMO_ACCOUNTS);
/** All account ids known right now (boot + runtime-added). */
function accountIds(): string[] {
  return Object.keys(DEMO_ACCOUNTS);
}
// The full rendezvous map handed to the browser (relay URL merged in per entry).
function rendezvousMap(): Record<string, { natsUrl: string; registerBaseUrl: string }> {
  const out: Record<string, { natsUrl: string; registerBaseUrl: string }> = {};
  for (const [id, entry] of Object.entries(DEMO_ACCOUNTS)) {
    out[id] = { natsUrl: NATS_URL, registerBaseUrl: entry.registerBaseUrl };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Trust chain (real NATS user creds + RS256 bootstrap signing). Persisted when
// TRUST_CHAIN_PATH is set so a restart keeps every enrolled agent's creds valid.
// ---------------------------------------------------------------------------

const trustChainOptions = {
  operatorName: "demo-operator",
  accountName: "demo-account",
};
const trustChain = TRUST_CHAIN_PATH
  ? await loadOrCreateTrustChain(TRUST_CHAIN_PATH, trustChainOptions)
  : await loadOrCreateTrustChain(join(tmpdir(), `demo-trust-${process.pid}.json`), trustChainOptions);
const privateChain = trustChain.private;
// Self-contained trust chain (demo owns the relay). The account seed IS the
// account identity, so there is no external issuer_account. Synadia/external
// mode is a later option (see DEMO_PLAN "Relay: Synadia optional").
const natsConfig = trustChain.natsConfig;
const natsIssuerAccountId: string | undefined = undefined;

// Publish the public NATS config (operator JWT + memory resolver) so run.sh can
// assemble a JWT-auth nats-server that trusts the SAME account this SaaS mints for.
if (NATS_CONFIG_OUT) {
  mkdirSync(NATS_CONFIG_OUT, { recursive: true });
  writeFileSync(join(NATS_CONFIG_OUT, "operator.jwt"), natsConfig.operatorJwt);
  writeFileSync(
    join(NATS_CONFIG_OUT, "resolver.json"),
    JSON.stringify(natsConfig.resolverConfig, null, 2),
  );
  console.log(`[demo-saas] wrote operator.jwt + resolver.json → ${NATS_CONFIG_OUT}`);
}

// ---------------------------------------------------------------------------
// RS256 bootstrap-JWT signing — reuses THIS SaaS's trust chain RSA key.
// ---------------------------------------------------------------------------

// Active bootstrap-JWT signer + the served JWKS. Both are MUTABLE so the demo
// can rotate the signing key at runtime (Phase 5 aside). `jwksKeys` is what
// `/.well-known/jwks.json` serves; the active signer is always jwksKeys[0]'s
// private half. On rotation a fresh key is prepended (grace: old kids still
// verify → zero downtime) and, when evicted, older kids drop out of the JWKS so
// a JWT under them fails closed at the gateway (plugin refetch finds no kid).
let activeSigner = await importRsaPrivateKeyFromPem(privateChain.rsaPrivateKeyPem);
let activeKid = trustChain.kid;
let jwksKeys: JwkRsaPublicKey[] = [...trustChain.jwks.keys];

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

async function signBootstrapJwt(payload: Record<string, unknown>): Promise<string> {
  const header = { alg: "RS256", typ: "JWT", kid: activeKid };
  const b64urlJson = (obj: unknown): string => Buffer.from(JSON.stringify(obj)).toString("base64url");
  const signingInput = `${b64urlJson(header)}.${b64urlJson(payload)}`;
  const sig = await webcrypto.subtle.sign(
    { name: "RSASSA-PKCS1-v1_5" },
    activeSigner,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${Buffer.from(new Uint8Array(sig)).toString("base64url")}`;
}

/**
 * Rotate the RS256 bootstrap signing key. Mints a fresh RSA key + kid, makes it
 * the active signer, and republishes the JWKS.
 *
 * - grace (default): the new key is PREPENDED, prior keys stay in the JWKS, so a
 *   JWT under any still-published kid keeps verifying — zero-downtime rotation.
 * - evictPrevious: the JWKS is reduced to ONLY the new key, so a JWT signed under
 *   a now-evicted kid is rejected (the gateway's JWKS cache refetches once, still
 *   can't find the kid, and fails closed).
 *
 * Only the RS256 key rotates; the NATS account seed (and thus every enrolled
 * agent's NKEY creds) is untouched, so live NATS sessions are unaffected.
 */
async function rotateSigningKey(evictPrevious: boolean): Promise<{ kid: string; jwksKids: string[] }> {
  const fresh = await generateRsaKeypair();
  activeSigner = await importRsaPrivateKeyFromPem(fresh.privateKeyPem);
  activeKid = fresh.kid;
  jwksKeys = evictPrevious ? [fresh.publicKeyJwk] : [fresh.publicKeyJwk, ...jwksKeys];
  const jwksKids = jwksKeys.map((k) => k.kid);
  console.log(`[rotate] active kid=${activeKid} evictPrevious=${evictPrevious} jwks=[${jwksKids.join(", ")}]`);
  return { kid: activeKid, jwksKids };
}

// ---------------------------------------------------------------------------
// Enrollment service (device-flow: agent gateways enroll through this)
// ---------------------------------------------------------------------------

const enrollmentStore = new MemoryEnrollmentStore();
const enrollment = new DeviceFlowEnrollment({
  saasTrustChain: privateChain,
  natsAccountConfig: natsConfig,
  natsIssuerAccountId,
  saasBaseUrl: SAAS_BASE_URL,
  jwksUrl: `${SAAS_BASE_URL}/.well-known/jwks.json`,
  bootstrapUrl: `${SAAS_BASE_URL}/bootstrap`,
  natsUrl: NATS_URL,
  expirationSeconds: Number(process.env.EXPIRATION_SECONDS ?? 600),
  pollIntervalSeconds: Number(process.env.POLL_INTERVAL_SECONDS ?? 2),
  store: enrollmentStore,
});

// Live view of enrollment requests for the admin panel (the store has no
// "list pending" API). Keyed by user_code, insertion-ordered for stable render.
type DemoEnrollStatus = "pending" | "approved" | "denied" | "expired";
interface DemoEnroll {
  userCode: string;
  tenant?: string;
  accountId?: string;
  status: DemoEnrollStatus;
  createdAtMs: number;
  expiresAtMs: number;
}
const demoEnrollments = new Map<string, DemoEnroll>();
const ENROLL_TTL_MS = Number(process.env.EXPIRATION_SECONDS ?? 600) * 1000;

function trackEnroll(userCode: string, tenant?: string, accountId?: string): void {
  const now = nowMs();
  demoEnrollments.set(userCode, {
    userCode,
    tenant,
    accountId,
    status: "pending",
    createdAtMs: now,
    expiresAtMs: now + ENROLL_TTL_MS,
  });
}
function markEnroll(userCode: string, status: DemoEnrollStatus): void {
  const e = demoEnrollments.get(userCode);
  if (e) e.status = status;
}
/** Snapshot the enrollment list, flipping any lapsed pending entry to "expired". */
function enrollmentSnapshot(): DemoEnroll[] {
  const now = nowMs();
  const list: DemoEnroll[] = [];
  for (const e of demoEnrollments.values()) {
    if (e.status === "pending" && now > e.expiresAtMs) e.status = "expired";
    list.push({ ...e });
  }
  return list;
}

// ---------------------------------------------------------------------------
// User directory — seeded chat users (alice/bob) + a seeded admin.
// ---------------------------------------------------------------------------
//
// The admin is a normal DemoUser plus membership in ADMIN_USERS; DemoUser has no
// isAdmin field and we deliberately DON'T change that product type — admin-ness
// is a demo-server concern. The admin is granted every seeded account so it can
// also chat while it approves/grants.
const ADMIN_USERNAME = "admin";
const ADMIN_USERS = new Set<string>([ADMIN_USERNAME]);
const seededUsers: DemoUser[] = [
  ...seedDemoUsers(SEED_ACCOUNT_IDS[0] ?? "agent-dev"),
  {
    username: ADMIN_USERNAME,
    uuid: "99999999-9999-4999-8999-999999999999",
    passwordSha256: sha256hex("demo"),
    allowedAccounts: [...SEED_ACCOUNT_IDS],
  },
];
const userDir = new DemoUserDirectory(seededUsers);
const sessions = new Map<string, string>(); // sid → username

function isAdmin(user: DemoUser): boolean {
  return ADMIN_USERS.has(user.username);
}

function newSessionToken(): string {
  const bytes = new Uint8Array(32);
  webcrypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("base64url");
}

function readCookie(req: IncomingMessage, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

function sessionUser(req: IncomingMessage): DemoUser | null {
  const sid = readCookie(req, "sid");
  if (!sid) return null;
  const username = sessions.get(sid);
  if (!username) return null;
  return userDir.get(username) ?? null;
}

// ---------------------------------------------------------------------------
// Static web surface — the 3-pane app + esbuild widget bundle.
// ---------------------------------------------------------------------------

function buildAppBundle(): string {
  const root = join(__dirname, "..");
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
  const outFile = join(tmpdir(), `demo-app-${process.pid}.js`);
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

const demoConfig = {
  issuerUrl: SAAS_BASE_URL,
  tenant: DEMO_TENANT,
  accounts: rendezvousMap(),
  llmMode: DEMO_LLM_MODE,
};
let appBundle = "";
let appPageHtml = "";
try {
  appBundle = buildAppBundle();
  const rawHtml = readFileSync(DEMO_APP_HTML, "utf8");
  const configScript = `<script>globalThis.__DEMO_CONFIG__=${JSON.stringify(demoConfig)};</script>`;
  appPageHtml = rawHtml.replace(/<head[^>]*>/i, (m) => `${m}\n  ${configScript}`);
  console.log("[demo-saas] built app bundle + injected __DEMO_CONFIG__");
} catch (err) {
  console.error("[demo-saas] FAILED to build web surface:", (err as Error).message);
  process.exit(4);
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function setCors(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}
function sendJson(res: ServerResponse, data: unknown, status = 200): void {
  res.setHeader("Content-Type", "application/json");
  res.writeHead(status);
  res.end(JSON.stringify(data, null, 2));
}
function sendHtml(res: ServerResponse, html: string): void {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.writeHead(200);
  res.end(html);
}
function parseJsonBody(req: IncomingMessage, cb: (body: unknown) => void): void {
  let body = "";
  req.on("data", (chunk) => {
    body += chunk.toString();
  });
  req.on("end", () => {
    try {
      cb(JSON.parse(body));
    } catch {
      cb(null);
    }
  });
}
function nowMs(): number {
  return Date.now();
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const server = createServer(async (req, res) => {
  setCors(res);
  if (req.method === "OPTIONS") {
    res.writeHead(200);
    res.end();
    return;
  }
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const path = url.pathname;
  console.log(`[${req.method}] ${path}`);

  try {
    // ── Static web surface ────────────────────────────────────────────────
    if (req.method === "GET" && (path === "/" || path === "/index.html")) {
      sendHtml(res, appPageHtml);
      return;
    }
    if (req.method === "GET" && path === "/app.js") {
      res.setHeader("Content-Type", "text/javascript; charset=utf-8");
      res.writeHead(200);
      res.end(appBundle);
      return;
    }
    if (path === "/.well-known/jwks.json" && req.method === "GET") {
      sendJson(res, { keys: jwksKeys });
      return;
    }

    // ── Login (id/pw → sid cookie). peerId is DERIVED server-side (uuid). ──
    if (req.method === "POST" && path === "/login") {
      parseJsonBody(req, (body) => {
        if (!body || typeof body !== "object") return sendJson(res, { error: "Invalid JSON body" }, 400);
        const { username, password } = body as { username?: string; password?: string };
        if (!username || !password) return sendJson(res, { error: "Missing username or password" }, 400);
        const user = userDir.authenticate(username, password);
        if (!user) return sendJson(res, { error: "invalid credentials" }, 401);
        const sid = newSessionToken();
        sessions.set(sid, user.username);
        res.setHeader("Set-Cookie", `sid=${sid}; HttpOnly; Path=/; SameSite=Lax; Max-Age=86400`);
        console.log(`[login] ${user.username} (admin=${isAdmin(user)}) → peerId=${user.uuid}`);
        sendJson(res, {
          ok: true,
          username: user.username,
          isAdmin: isAdmin(user),
          allowedAccounts: [...user.allowedAccounts],
        });
      });
      return;
    }

    // ── /me — who am I + my rendezvous map (for the agent switcher). ──────
    if (req.method === "GET" && path === "/me") {
      const user = sessionUser(req);
      if (!user) return sendJson(res, { error: "not authenticated" }, 401);
      const map = rendezvousMap();
      // Only the accounts this login is authorized for.
      const mine: Record<string, { natsUrl: string; registerBaseUrl: string }> = {};
      for (const id of user.allowedAccounts) if (map[id]) mine[id] = map[id];
      sendJson(res, {
        username: user.username,
        isAdmin: isAdmin(user),
        tenant: DEMO_TENANT,
        llmMode: DEMO_LLM_MODE,
        accounts: mine,
      });
      return;
    }

    // ── /nats-user — session-gated NATS user creds (observer/browser). ────
    if (req.method === "POST" && path === "/nats-user") {
      const user = sessionUser(req);
      if (!user) return sendJson(res, { error: "not authenticated" }, 401);
      parseJsonBody(req, (body) => {
        if (!body || typeof body !== "object") return sendJson(res, { error: "Invalid JSON body" }, 400);
        const { role, ttlSeconds } = body as { role?: NatsUserRole; ttlSeconds?: number };
        // Optional short lifetime (scene ⑤): a bounded, positive TTL yields an
        // expiring credential; anything else mints a normal non-expiring one.
        const ttl = typeof ttlSeconds === "number" && ttlSeconds > 0 && ttlSeconds <= 3600 ? ttlSeconds : undefined;
        mintNatsUserCreds({
          accountSeed: privateChain.natsAccountSeed,
          tenant: DEMO_TENANT,
          role: role === "agent" ? "agent" : "browser",
          issuerAccountId: natsIssuerAccountId,
          ttlSeconds: ttl,
        })
          .then((creds) => {
            console.log(`[nats-user] minted ${role ?? "browser"} creds for ${user.username}${ttl ? ` (ttl=${ttl}s)` : ""}`);
            sendJson(res, { ...creds, natsUrl: NATS_URL });
          })
          .catch((err) => {
            console.error("[nats-user] Error:", err);
            sendJson(res, { error: "Internal server error" }, 500);
          });
      });
      return;
    }

    // ── /bootstrap — session-gated bootstrap JWT. peerId=session uuid; ────
    //    minted ONLY after canAccess(user, accountId). Body peerId ignored.
    if (req.method === "POST" && path === "/bootstrap") {
      const user = sessionUser(req);
      if (!user) return sendJson(res, { error: "not authenticated" }, 401);
      parseJsonBody(req, (body) => {
        if (!body || typeof body !== "object") return sendJson(res, { error: "Invalid JSON body" }, 400);
        const { accountId, deviceX25519PublicKey, devicePopPublicKey } = body as {
          accountId?: string;
          deviceX25519PublicKey?: string;
          devicePopPublicKey?: string;
        };
        if (!accountId || !deviceX25519PublicKey) {
          return sendJson(res, { error: "Missing required fields: accountId, deviceX25519PublicKey" }, 400);
        }
        if (!userDir.canAccess(user, accountId)) {
          console.warn(`[bootstrap] ${user.username} DENIED for account "${accountId}"`);
          return sendJson(res, { error: `user not authorized for account "${accountId}"` }, 403);
        }
        let claims;
        try {
          claims = buildBootstrapClaims({
            iss: SAAS_ISSUER,
            peerId: user.uuid,
            accountId,
            tenant: DEMO_TENANT,
            deviceX25519PublicKey,
            devicePopPublicKey,
          });
        } catch (err) {
          return sendJson(res, { error: `Invalid claims: ${(err as Error).message}` }, 400);
        }
        signBootstrapJwt(claims as unknown as Record<string, unknown>)
          .then((jwt) => {
            const rv = rendezvousMap()[accountId];
            console.log(`[bootstrap] issued JWT for ${user.username} peerId=${user.uuid} account=${accountId}`);
            sendJson(res, { jwt, peerId: user.uuid, natsUrl: NATS_URL, registerBaseUrl: rv?.registerBaseUrl });
          })
          .catch((err) => {
            console.error("[bootstrap] Error:", err);
            sendJson(res, { error: "Internal server error" }, 500);
          });
      });
      return;
    }

    // ── Plugin-facing device-flow: POST /api/enroll, POST /api/poll ───────
    if (path === "/api/enroll" && req.method === "POST") {
      parseJsonBody(req, (body) => {
        if (!body) return sendJson(res, { error: "Invalid JSON body" }, 400);
        const enrollRequest = body as EnrollmentRequest;
        if (!enrollRequest.agentPublicKey || !enrollRequest.tenant) {
          return sendJson(res, { error: "Missing required fields: agentPublicKey, tenant" }, 400);
        }
        try {
          assertValidSubjectToken(enrollRequest.tenant, "tenant");
          if (enrollRequest.accountId !== undefined) assertValidSubjectToken(enrollRequest.accountId, "accountId");
        } catch (err) {
          return sendJson(res, { error: (err as Error).message }, 400);
        }
        enrollment
          .enroll(enrollRequest)
          .then((resp) => {
            console.log(`[enroll] created ${resp.user_code} (account=${enrollRequest.accountId})`);
            trackEnroll(resp.user_code, enrollRequest.tenant, enrollRequest.accountId);
            sendJson(res, resp);
          })
          .catch((err) => {
            console.error("[enroll] Error:", err);
            sendJson(res, { error: "Internal server error" }, 500);
          });
      });
      return;
    }
    if (path === "/api/poll" && req.method === "POST") {
      parseJsonBody(req, (body) => {
        if (!body) return sendJson(res, { error: "Invalid JSON body" }, 400);
        const pollRequest = body as PollRequest;
        if (!pollRequest.device_code) return sendJson(res, { error: "Missing device_code" }, 400);
        enrollment
          .poll(pollRequest)
          .then((result) => {
            if ("error" in result) sendJson(res, result, 400);
            else sendJson(res, result);
          })
          .catch((err) => {
            console.error("[poll] Error:", err);
            sendJson(res, { error: "Internal server error" }, 500);
          });
      });
      return;
    }

    // ── Admin API (admin session required) ────────────────────────────────
    if (path.startsWith("/admin/")) {
      const user = sessionUser(req);
      if (!user || !isAdmin(user)) {
        return sendJson(res, { error: "admin session required" }, 403);
      }

      // GET /admin/enrollments — live enrollment requests (pending/approved/…)
      if (req.method === "GET" && path === "/admin/enrollments") {
        return sendJson(res, enrollmentSnapshot());
      }
      // POST /admin/enrollments/:code/approve | /deny
      const enrollMatch = path.match(/^\/admin\/enrollments\/([^/]+)\/(approve|deny)$/);
      if (req.method === "POST" && enrollMatch) {
        const userCode = decodeURIComponent(enrollMatch[1]);
        const action = enrollMatch[2];
        if (action === "approve") {
          enrollment
            .approve(userCode)
            .then((result) => {
              if (result) {
                markEnroll(userCode, "approved");
                console.log(`[admin] approved ${userCode} → peer ${result.peerId}`);
                sendJson(res, { ok: true, peerId: result.peerId });
              } else {
                sendJson(res, { error: "Enrollment not found or expired" }, 404);
              }
            })
            .catch((err) => {
              console.error("[admin/approve] Error:", err);
              sendJson(res, { error: "Internal server error" }, 500);
            });
        } else {
          enrollment
            .deny(userCode)
            .then((ok) => {
              if (ok) {
                markEnroll(userCode, "denied");
                console.log(`[admin] denied ${userCode}`);
                sendJson(res, { ok: true });
              } else {
                sendJson(res, { error: "Enrollment not found" }, 404);
              }
            })
            .catch((err) => {
              console.error("[admin/deny] Error:", err);
              sendJson(res, { error: "Internal server error" }, 500);
            });
        }
        return;
      }

      // GET /admin/signing-key — current active kid + the kids published in JWKS.
      if (req.method === "GET" && path === "/admin/signing-key") {
        return sendJson(res, { activeKid, jwksKids: jwksKeys.map((k) => k.kid) });
      }
      // POST /admin/rotate-key — rotate the RS256 bootstrap signing key (Phase 5
      // aside). Body { evictPrevious?: boolean }: grace (default) keeps old kids
      // in the JWKS for zero-downtime rotation; evict drops them so a JWT under an
      // old kid is rejected. Only the RS256 key rotates — NATS creds are untouched.
      if (req.method === "POST" && path === "/admin/rotate-key") {
        parseJsonBody(req, (body) => {
          const evictPrevious = Boolean((body as { evictPrevious?: unknown } | null)?.evictPrevious);
          rotateSigningKey(evictPrevious)
            .then((r) => sendJson(res, { ok: true, ...r }))
            .catch((err) => {
              console.error("[admin/rotate-key] Error:", err);
              sendJson(res, { error: "Internal server error" }, 500);
            });
        });
        return;
      }

      // POST /admin/chaos/nats-user — mint creds for an ARBITRARY tenant (chaos
      // scene ③ cross-tenant: tenant-b creds that the relay must refuse to let
      // subscribe to tenant-a). Admin-gated; demo-only. Real deployments never
      // expose an arbitrary-tenant mint oracle.
      if (req.method === "POST" && path === "/admin/chaos/nats-user") {
        parseJsonBody(req, (body) => {
          if (!body || typeof body !== "object") return sendJson(res, { error: "Invalid JSON body" }, 400);
          const { tenant, role } = body as { tenant?: string; role?: NatsUserRole };
          if (!tenant) return sendJson(res, { error: "Missing tenant" }, 400);
          try {
            assertValidSubjectToken(tenant, "tenant");
          } catch (err) {
            return sendJson(res, { error: (err as Error).message }, 400);
          }
          mintNatsUserCreds({
            accountSeed: privateChain.natsAccountSeed,
            tenant,
            role: role === "agent" ? "agent" : "browser",
            issuerAccountId: natsIssuerAccountId,
          })
            .then((creds) => {
              console.log(`[chaos] minted ${role ?? "browser"} creds for tenant=${tenant}`);
              sendJson(res, { ...creds, natsUrl: NATS_URL });
            })
            .catch((err) => {
              console.error("[chaos/nats-user] Error:", err);
              sendJson(res, { error: "Internal server error" }, 500);
            });
        });
        return;
      }

      // POST /admin/accounts — register a runtime-added account's rendezvous
      // (scene ②: add-agent.sh calls this after a new agent is approved, so an
      // open widget can dial the new gateway). In-memory, admin-gated.
      if (req.method === "POST" && path === "/admin/accounts") {
        parseJsonBody(req, (body) => {
          if (!body || typeof body !== "object") return sendJson(res, { error: "Invalid JSON body" }, 400);
          const { accountId, registerBaseUrl } = body as { accountId?: string; registerBaseUrl?: string };
          if (!accountId || !registerBaseUrl) {
            return sendJson(res, { error: "Missing accountId or registerBaseUrl" }, 400);
          }
          try {
            assertValidSubjectToken(accountId, "accountId");
          } catch (err) {
            return sendJson(res, { error: (err as Error).message }, 400);
          }
          DEMO_ACCOUNTS[accountId] = { registerBaseUrl };
          console.log(`[admin] registered account "${accountId}" → ${registerBaseUrl}`);
          sendJson(res, { ok: true, accountId, accounts: accountIds() });
        });
        return;
      }

      // GET /admin/users — non-secret directory (username + allowedAccounts)
      if (req.method === "GET" && path === "/admin/users") {
        return sendJson(res, { accounts: accountIds(), users: userDir.list() });
      }
      // POST /admin/users/:username/accounts — grant/revoke (replace the set)
      const grantMatch = path.match(/^\/admin\/users\/([^/]+)\/accounts$/);
      if (req.method === "POST" && grantMatch) {
        const username = decodeURIComponent(grantMatch[1]);
        parseJsonBody(req, (body) => {
          if (!body || typeof body !== "object") return sendJson(res, { error: "Invalid JSON body" }, 400);
          const { accounts } = body as { accounts?: unknown };
          if (!Array.isArray(accounts) || !accounts.every((a) => typeof a === "string")) {
            return sendJson(res, { error: "accounts must be an array of strings" }, 400);
          }
          if (!userDir.setAllowedAccounts(username, accounts as string[])) {
            return sendJson(res, { error: `unknown user "${username}"` }, 404);
          }
          const updated = userDir.get(username);
          console.log(`[admin] ${username} allowedAccounts → [${(updated?.allowedAccounts ?? []).join(", ")}]`);
          sendJson(res, { ok: true, username, allowedAccounts: updated?.allowedAccounts ?? [] });
        });
        return;
      }

      return sendJson(res, { error: "Not found" }, 404);
    }

    sendJson(res, { error: "Not found" }, 404);
  } catch (err) {
    console.error("[demo-saas] Error:", err);
    sendJson(res, { error: "Internal server error" }, 500);
  }
});

server.listen(PORT, () => {
  console.log("");
  console.log("==============================================");
  console.log("  WebChannel Showcase Demo — SaaS");
  console.log("==============================================");
  console.log(`  URL:        ${SAAS_BASE_URL}`);
  console.log(`  Issuer:     ${SAAS_ISSUER}`);
  console.log(`  Relay:      ${NATS_URL}`);
  console.log(`  Tenant:     ${DEMO_TENANT}`);
  console.log(`  Accounts:   ${accountIds().join(", ")}`);
  console.log(`  LLM mode:   ${DEMO_LLM_MODE}`);
  console.log(`  NATS mode:  ${natsConfig.mode}`);
  console.log("");
  console.log("  Logins (password \"demo\"):  alice, bob (chat) · admin (approve/grant)");
  console.log("==============================================");
  console.log("");
});

process.on("SIGINT", () => {
  console.log("\n[demo-saas] shutting down…");
  enrollmentStore.close();
  server.close(() => process.exit(0));
});
