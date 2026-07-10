/**
 * Showcase-demo SaaS server-surface smoke — /nats-user role-escalation guard (F6).
 *
 * `demo/run.sh` boots `demo/saas-server.ts` as the single web origin behind the
 * one-page demo. Its browser-facing POST /nats-user MUST only ever mint per-peer
 * BROWSER creds — a logged-in browser session must NOT be able to escalate to
 * tenant-wide "agent"/"observer" creds by passing a body `role` (that would let it
 * forge any peer's register reply or read every peer's frames). The tenant-wide
 * observer (wiretap) + agent roles live behind the admin-gated POST /admin/nats-user.
 *
 * This hermetic smoke boots the demo server (local relay mode — no nats-server
 * needed to MINT creds, minting is pure crypto) and asserts the scopes over plain
 * HTTP: no browser, no NATS, no model, no human.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const HERE = dirname(fileURLToPath(import.meta.url)); // packages/saas/src
const REPO_ROOT = join(HERE, "..", "..", "..");
const SERVER_PATH = join(REPO_ROOT, "demo", "saas-server.ts");

// Unique port (avoid the reference-server smoke on 3468 + the saas HTTP tests).
const PORT = 3471;
const BASE = `http://127.0.0.1:${PORT}`;

const TENANT = "smoke-demo-tenant";
// Seeded demo users (password "demo"); their uuids are the pinned peerIds.
const ALICE_UUID = "11111111-1111-4111-8111-111111111111";

const TSX_BIN = (() => {
  for (const p of [
    join(HERE, "../node_modules/.bin/tsx"),
    join(REPO_ROOT, "node_modules/.bin/tsx"),
  ]) {
    if (existsSync(p)) return p;
  }
  return "tsx";
})();

let server: ReturnType<typeof spawn> | null = null;

async function waitForHttp(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      await fetch(url, { method: "GET" });
      return; // any HTTP response means the server is listening
    } catch (err) {
      lastErr = err;
      await sleep(150);
    }
  }
  throw new Error(`Timed out waiting for ${url}: ${String(lastErr)}`);
}

type Creds = { permissions?: { pub: string[]; sub: string[] }; userJwt?: string; userSeedRaw?: string; error?: string };

async function loginCookie(username: string, password: string): Promise<string> {
  const res = await fetch(`${BASE}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  expect(res.ok, `login failed: ${res.status}`).toBe(true);
  const cookie = res.headers.get("set-cookie")?.split(";")[0];
  expect(cookie, "login response missing sid cookie").toBeTruthy();
  return cookie!;
}

async function post(path: string, cookie: string, body: Record<string, unknown>): Promise<{ status: number; data: Creds }> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: (await res.json()) as Creds };
}

/** Decode a compact JWT's payload and return its `exp` (unix seconds) if present. */
function jwtExp(jwt: string): number | undefined {
  const payload = JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString("utf8")) as { exp?: number };
  return payload.exp;
}

describe("demo SaaS /nats-user role-escalation guard (F6)", () => {
  beforeAll(async () => {
    server = spawn(TSX_BIN, [SERVER_PATH], {
      cwd: dirname(SERVER_PATH),
      env: {
        ...process.env,
        PORT: String(PORT),
        SAAS_BASE_URL: BASE,
        DEMO_TENANT: TENANT,
        DEMO_LLM_MODE: "echo",
        NATS_URL: "ws://127.0.0.1:18722",
        // The demo server persists its trust chain here (run.sh always sets this);
        // a per-run temp file keeps the smoke hermetic.
        TRUST_CHAIN_PATH: join(tmpdir(), `demo-role-smoke-${process.pid}-${Date.now()}.json`),
      },
      stdio: "pipe",
    });
    // Only listens AFTER the trust chain + the demo app bundle are built.
    await waitForHttp(`${BASE}/`, 60_000);
  }, 70_000);

  afterAll(() => {
    server?.kill("SIGTERM");
    server = null;
  });

  const perPeer = `webchannel.${TENANT}.*.${ALICE_UUID}.>`;
  const tenantWide = `webchannel.${TENANT}.>`;

  it("mints browser-scoped creds even when a session asks for role:agent (no escalation)", async () => {
    const cookie = await loginCookie("alice", "demo");
    const { status, data } = await post("/nats-user", cookie, { role: "agent" });
    expect(status).toBe(200);
    expect(data.permissions?.pub).toEqual([perPeer]);
    expect(data.permissions?.sub).toEqual([perPeer]);
    expect(data.permissions?.pub).not.toContain(tenantWide);
    expect(data.permissions?.sub).not.toContain(tenantWide);
  });

  it("mints browser-scoped creds even when a session asks for role:observer (no escalation)", async () => {
    const cookie = await loginCookie("alice", "demo");
    const { status, data } = await post("/nats-user", cookie, { role: "observer" });
    expect(status).toBe(200);
    expect(data.permissions?.pub).toEqual([perPeer]);
    expect(data.permissions?.sub).toEqual([perPeer]);
  });

  it("returns usable browser creds (userJwt + userSeedRaw) for the chat lane", async () => {
    const cookie = await loginCookie("alice", "demo");
    const { status, data } = await post("/nats-user", cookie, {});
    expect(status).toBe(200);
    expect(typeof data.userJwt).toBe("string");
    expect(typeof data.userSeedRaw).toBe("string");
  });

  it("honors ttlSeconds on the browser route (scene ⑤ short-TTL)", async () => {
    const cookie = await loginCookie("alice", "demo");
    const { status, data } = await post("/nats-user", cookie, { ttlSeconds: 60 });
    expect(status).toBe(200);
    const exp = jwtExp(data.userJwt!);
    const now = Math.floor(Date.now() / 1000);
    expect(exp, "ttlSeconds must produce a JWT exp").toBeTruthy();
    expect(exp!).toBeGreaterThan(now);
    expect(exp!).toBeLessThanOrEqual(now + 120);
  });

  it("lets an ADMIN session mint tenant-wide observer creds via /admin/nats-user", async () => {
    const cookie = await loginCookie("admin", "demo");
    const { status, data } = await post("/admin/nats-user", cookie, { role: "observer" });
    expect(status).toBe(200);
    // observer: sub-only tenant-wide (empty pub allow-list, deny-all under the hood).
    expect(data.permissions?.sub).toEqual([tenantWide]);
    expect(data.permissions?.pub).toEqual([]);
  });

  it("lets an ADMIN session mint tenant-wide agent creds via /admin/nats-user", async () => {
    const cookie = await loginCookie("admin", "demo");
    const { status, data } = await post("/admin/nats-user", cookie, { role: "agent" });
    expect(status).toBe(200);
    expect(data.permissions?.pub).toEqual([tenantWide]);
    expect(data.permissions?.sub).toEqual([tenantWide]);
  });

  it("refuses /admin/nats-user for a NON-admin session (403)", async () => {
    const cookie = await loginCookie("alice", "demo");
    const { status } = await post("/admin/nats-user", cookie, { role: "agent" });
    expect(status).toBe(403);
  });
});
