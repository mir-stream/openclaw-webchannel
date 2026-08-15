/**
 * Unified-demo server-surface smoke (ENABLE_DEMO_UI=1).
 *
 * `run-demo.sh` / `mac-demo.sh` turn the reference SaaS server into the SINGLE
 * web origin for the demo: it serves the two-panel page, esbuild-bundles the
 * browser client into `/widget.js`, tracks enrollment requests for the admin
 * panel. That
 * whole surface is exercised ONLY by the manual `run-demo.sh` (real browser +
 * human approval + real model), so nothing in CI catches it breaking.
 *
 * The single most fragile piece is `/widget.js`: it is esbuilt fresh at boot
 * from `packages/client/src/browser-demo-entry.ts`'s import graph. A browser-
 * unsafe `node:` import sneaking into that graph, or a moved entry/`nats-client`,
 * breaks `run-demo.sh` at boot with nothing to notice. This hermetic smoke boots
 * the server with `ENABLE_DEMO_UI=1` and asserts the three demo behaviors over
 * plain HTTP — no browser, no NATS, no model, no human.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const HERE = dirname(fileURLToPath(import.meta.url)); // packages/saas/src
const REPO_ROOT = join(HERE, "..", "..", "..");
const SERVER_PATH = join(HERE, "..", "reference", "enrollment-server.ts");
const DEMO_APP_HTML = join(REPO_ROOT, "e2e", "local", "ci-smoke.html");
const DEMO_CLIENT_ENTRY = join(REPO_ROOT, "packages", "client", "src", "browser-demo-entry.ts");
const PORTS = JSON.parse(
  readFileSync(join(REPO_ROOT, "e2e", "local", "ports.json"), "utf8"),
) as {
  harnesses: Record<string, Record<string, number>>;
  vitest: Record<string, Record<string, number>>;
};
const SUITE_PORTS = PORTS.vitest["packages/saas/src/demo-ui-smoke.test.ts"];
const AC6_PORTS = PORTS.vitest["packages/saas/src/ac6-device-flow-e2e.test.ts"];
const TWO_ACCOUNT_PORTS = PORTS.harnesses["run-two-account-isolation"];

// Unique port (avoid the other saas HTTP-server tests: 3456/3457 etc.).
const PORT = SUITE_PORTS.PORT;
const NATS_CLIENT_PORT = AC6_PORTS.NATS_CLIENT_PORT;
const GW_PORT = TWO_ACCOUNT_PORTS.GW_PORT;
const BASE = `http://localhost:${PORT}`;

const TENANT = "smoke-tenant";
const ACCOUNT_ID = "smoke-agent";

// Resolve tsx from node_modules (bare `npx tsx` is flaky under a spawned shell).
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
      return; // any HTTP response means the server is listening (bundle already built)
    } catch (err) {
      lastErr = err;
      await sleep(150);
    }
  }
  throw new Error(`Timed out waiting for ${url}: ${String(lastErr)}`);
}

async function enroll(accountId: string): Promise<string> {
  const res = await fetch(`${BASE}/api/enroll`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // agentPublicKey must be the 43-char base64url X25519 wire format (#13);
    // tenant is the other required field.
    body: JSON.stringify({
      agentPublicKey: "EpK8GJc3BntN3yEwx5GtfQFyIilwIXaKsrWiqYNkzSo",
      tenant: TENANT,
      accountId,
    }),
  });
  expect(res.ok, `enroll failed: ${res.status}`).toBe(true);
  const body = (await res.json()) as { user_code?: string };
  expect(body.user_code, "enroll response missing user_code").toBeTruthy();
  return body.user_code!;
}

async function enrollments(): Promise<Array<{ userCode: string; status: string; tenant?: string; accountId?: string }>> {
  const res = await fetch(`${BASE}/demo/enrollments`);
  expect(res.ok).toBe(true);
  return (await res.json()) as Array<{ userCode: string; status: string; tenant?: string; accountId?: string }>;
}

describe("unified-demo server surface (ENABLE_DEMO_UI)", () => {
  beforeAll(async () => {
    server = spawn(TSX_BIN, [SERVER_PATH], {
      cwd: dirname(SERVER_PATH),
      env: {
        ...process.env,
        PORT: String(PORT),
        SAAS_BASE_URL: BASE,
        SAAS_ISSUER: "https://saas.local/smoke-issuer",
        NATS_URL: `ws://localhost:${NATS_CLIENT_PORT}`,
        POLL_INTERVAL_SECONDS: "0",
        ENABLE_DEMO_UI: "1",
        DEMO_APP_HTML,
        DEMO_CLIENT_ENTRY,
        DEMO_GW_URL: `http://127.0.0.1:${GW_PORT}`,
        DEMO_ACCOUNT_ID: ACCOUNT_ID,
        DEMO_TENANT: TENANT,
        DEMO_PEER_ID: "smoke-peer",
        ENROLLMENT_ADMIN_TOKEN: "test-admin-token",
      },
      stdio: "pipe",
    });
    // Only listens AFTER the trust chain + the /widget.js esbuild bundle are built.
    await waitForHttp(`${BASE}/demo/enrollments`, 60_000);
  }, 70_000);

  afterAll(() => {
    server?.kill("SIGTERM");
    server = null;
  });

  it("bundles the browser client into /widget.js (boot-time esbuild of browser-demo-entry)", async () => {
    const res = await fetch(`${BASE}/widget.js`);
    expect(res.ok).toBe(true);
    expect(res.headers.get("content-type")).toContain("javascript");
    const js = await res.text();
    expect(js.length).toBeGreaterThan(1000);
    // The IIFE footer pins the global the page calls: globalThis.WebDemo.runDemo.
    expect(js).toContain("WebDemo");
    expect(js).toContain("runDemo");
  });

  it("serves the two-panel page with injected __DEMO_CONFIG__ before the bundle", async () => {
    const res = await fetch(`${BASE}/`);
    expect(res.ok).toBe(true);
    const html = await res.text();
    expect(html).toContain("__DEMO_CONFIG__");
    expect(html).toContain('src="/widget.js"');
    // Config JSON carries the coordinates the client needs; issuerUrl is self.
    const m = html.match(/__DEMO_CONFIG__\s*=\s*(\{.*?\})\s*;/s);
    expect(m, "no __DEMO_CONFIG__ assignment found").toBeTruthy();
    const cfg = JSON.parse(m![1]) as Record<string, string>;
    expect(cfg.issuerUrl).toBe(BASE);
    expect(cfg.accountId).toBe(ACCOUNT_ID);
    expect(cfg.tenant).toBe(TENANT);
    expect(cfg.peerId).toBe("smoke-peer");
    expect(cfg.natsUrl).toBeTruthy();
  });

  it("tracks enrollment requests pending -> approved for the admin panel", async () => {
    const code = await enroll(ACCOUNT_ID);
    const pending = (await enrollments()).find((e) => e.userCode === code);
    expect(pending, "enrolled code not listed").toBeTruthy();
    expect(pending!.status).toBe("pending");
    expect(pending!.tenant).toBe(TENANT);
    expect(pending!.accountId).toBe(ACCOUNT_ID);

    const approve = await fetch(`${BASE}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer test-admin-token" },
      body: JSON.stringify({ user_code: code }),
    });
    expect(approve.ok).toBe(true);
    const approved = (await enrollments()).find((e) => e.userCode === code);
    expect(approved!.status).toBe("approved");

    const cookie = await loginCookie("alice", "demo");
    const bootstrap = async (body: Record<string, unknown>) => {
      const response = await fetch(`${BASE}/bootstrap`, {
        method: "POST",
        headers: { "Content-Type": "application/json", cookie },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() as Record<string, unknown> };
    };
    const deviceKey = "EpK8GJc3BntN3yEwx5GtfQFyIilwIXaKsrWiqYNkzSo";
    const valid = await bootstrap({
      tenant: TENANT,
      accountId: ACCOUNT_ID,
      deviceX25519PublicKey: deviceKey,
    });
    expect(valid.status).toBe(200);
    expect(valid.body.agentPublicKey).toBe(deviceKey);
    const claims = JSON.parse(
      Buffer.from(String(valid.body.jwt).split(".")[1], "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    expect(claims.aud).toBe(ACCOUNT_ID);
    expect(claims.tenant).toBe(TENANT);
    expect(claims.sub).toBe(ALICE_UUID);
    expect(claims).not.toHaveProperty("accountId");

    expect((await bootstrap({
      tenant: "foreign-tenant",
      accountId: ACCOUNT_ID,
      deviceX25519PublicKey: deviceKey,
    })).status).toBe(403);
    expect((await bootstrap({
      tenant: TENANT,
      accountId: "foreign-account",
      deviceX25519PublicKey: deviceKey,
    })).status).toBe(403);
  });

  it("tracks a denied enrollment as denied", async () => {
    const code = await enroll("smoke-agent-2");
    const deny = await fetch(`${BASE}/deny`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer test-admin-token" },
      body: JSON.stringify({ user_code: code }),
    });
    expect(deny.ok).toBe(true);
    const denied = (await enrollments()).find((e) => e.userCode === code);
    expect(denied!.status).toBe("denied");
  });

  // --- F6 role-escalation guard on the browser-facing /nats-user route -------
  // alice is a seeded demo user (password "demo"); her uuid is the pinned peerId.
  const ALICE_UUID = "11111111-1111-4111-8111-111111111111";
  type Creds = { permissions?: { pub: string[]; sub: string[] }; userJwt?: string; error?: string };

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

  async function natsUser(cookie: string, body: Record<string, unknown>): Promise<{ status: number; data: Creds }> {
    const res = await fetch(`${BASE}/nats-user`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify(body),
    });
    return { status: res.status, data: (await res.json()) as Creds };
  }

  it("mints browser-scoped creds even when a session asks for role:agent (no escalation)", async () => {
    const cookie = await loginCookie("alice", "demo");
    const { status, data } = await natsUser(cookie, { tenant: TENANT, role: "agent" });
    expect(status).toBe(200);
    const perPeer = `webchannel.${TENANT}.*.${ALICE_UUID}.>`;
    const tenantWide = `webchannel.${TENANT}.>`;
    // Pinned to alice's own peer subtree — NOT the tenant-wide agent grant.
    expect(data.permissions?.pub).toEqual([perPeer]);
    expect(data.permissions?.sub).toEqual([perPeer]);
    expect(data.permissions?.pub).not.toContain(tenantWide);
    expect(data.permissions?.sub).not.toContain(tenantWide);
  });

  it("mints browser-scoped creds even when a session asks for role:observer (no escalation)", async () => {
    const cookie = await loginCookie("alice", "demo");
    const { status, data } = await natsUser(cookie, { tenant: TENANT, role: "observer" });
    expect(status).toBe(200);
    const perPeer = `webchannel.${TENANT}.*.${ALICE_UUID}.>`;
    // observer would be sub-only tenant-wide; the browser route must ignore it.
    expect(data.permissions?.pub).toEqual([perPeer]);
    expect(data.permissions?.sub).toEqual([perPeer]);
  });

  it("rejects /nats-user for a tenant other than the server's own (403)", async () => {
    const cookie = await loginCookie("alice", "demo");
    const { status } = await natsUser(cookie, { tenant: "some-other-tenant" });
    expect(status).toBe(403);
  });
});
