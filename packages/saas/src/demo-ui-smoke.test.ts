/**
 * Unified-demo server-surface smoke (ENABLE_DEMO_UI=1).
 *
 * `run-demo.sh` / `mac-demo.sh` turn the reference SaaS server into the SINGLE
 * web origin for the demo: it serves the two-panel page, esbuild-bundles the
 * browser client into `/widget.js`, tracks enrollment requests for the admin
 * panel, and gates chat-unlock via `/demo/status` + `/demo/agent-ready`. That
 * whole surface is exercised ONLY by the manual `run-demo.sh` (real browser +
 * human approval + real model), so nothing in CI catches it breaking.
 *
 * The single most fragile piece is `/widget.js`: it is esbuilt fresh at boot
 * from `packages/client/src/browser-demo-entry.ts`'s import graph. A browser-
 * unsafe `node:` import sneaking into that graph, or a moved entry/`nats-client`,
 * breaks `run-demo.sh` at boot with nothing to notice. This hermetic smoke boots
 * the server with `ENABLE_DEMO_UI=1` and asserts the four demo behaviors over
 * plain HTTP — no browser, no NATS, no model, no human.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const HERE = dirname(fileURLToPath(import.meta.url)); // packages/saas/src
const REPO_ROOT = join(HERE, "..", "..", "..");
const SERVER_PATH = join(HERE, "..", "reference", "enrollment-server.ts");
const DEMO_APP_HTML = join(REPO_ROOT, "e2e", "local", "demo-app.html");
const DEMO_CLIENT_ENTRY = join(REPO_ROOT, "packages", "client", "src", "browser-demo-entry.ts");

// Unique port (avoid the other saas HTTP-server tests: 3456/3457 etc.).
const PORT = 3468;
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
    // agentPublicKey + tenant are the required fields; content is opaque here.
    body: JSON.stringify({ agentPublicKey: "smoke-agent-pubkey", tenant: TENANT, accountId }),
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
        NATS_URL: "ws://localhost:4222",
        POLL_INTERVAL_SECONDS: "0",
        ENABLE_DEMO_UI: "1",
        DEMO_APP_HTML,
        DEMO_CLIENT_ENTRY,
        DEMO_GW_URL: "http://127.0.0.1:19299",
        DEMO_ACCOUNT_ID: ACCOUNT_ID,
        DEMO_TENANT: TENANT,
        DEMO_PEER_ID: "smoke-peer",
      },
      stdio: "pipe",
    });
    // Only listens AFTER the trust chain + the /widget.js esbuild bundle are built.
    await waitForHttp(`${BASE}/demo/status`, 60_000);
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
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_code: code }),
    });
    expect(approve.ok).toBe(true);
    const approved = (await enrollments()).find((e) => e.userCode === code);
    expect(approved!.status).toBe("approved");
  });

  it("tracks a denied enrollment as denied", async () => {
    const code = await enroll("smoke-agent-2");
    const deny = await fetch(`${BASE}/deny`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_code: code }),
    });
    expect(deny.ok).toBe(true);
    const denied = (await enrollments()).find((e) => e.userCode === code);
    expect(denied!.status).toBe("denied");
  });

  it("gates chat-unlock via /demo/status + /demo/agent-ready", async () => {
    const before = (await (await fetch(`${BASE}/demo/status`)).json()) as { agentReady: boolean };
    expect(before.agentReady).toBe(false);

    const post = await fetch(`${BASE}/demo/agent-ready`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(post.ok).toBe(true);

    const after = (await (await fetch(`${BASE}/demo/status`)).json()) as { agentReady: boolean };
    expect(after.agentReady).toBe(true);
  });
});
