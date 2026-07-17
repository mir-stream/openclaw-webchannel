/**
 * Reference enrollment-server /test/nats-user TTL enforcement (P0-3 D6-5 R5-2).
 *
 * The unauthenticated test-mint route now injects a SERVER-FORCED ttlSeconds (900)
 * into every mintNatsUserCreds call — a hard constant, not a request-body field —
 * so it can only ever emit SHORT-LIVED creds (all roles). This spawns the real
 * reference server (tsx) with ENABLE_TEST_ROUTES=1, mints each role, and DECODES
 * the returned user JWT's `exp` to assert it is set to ~now+900.
 *
 * This is the mechanism Mode B (run-byo-static.sh) uses to obtain the enrolled
 * agent's static NATS creds from OUTSIDE the enrollment bundle without exporting
 * the account seed — bounded so a misconfigured gate can't leak a non-expiring
 * tenant-wide agent credential.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { decode, type User } from "@nats-io/jwt";

const PORT = 3466;
const BASE_URL = `http://localhost:${PORT}`;
const TTL = 900;

const TSX_BIN = (() => {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const p of [join(here, "../node_modules/.bin/tsx"), join(here, "../../../node_modules/.bin/tsx")]) {
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
      return;
    } catch (err) {
      lastErr = err;
      await delay(150);
    }
  }
  throw new Error(`Timed out waiting for ${url}: ${String(lastErr)}`);
}

beforeAll(async () => {
  const serverPath = join(dirname(fileURLToPath(import.meta.url)), "../reference/enrollment-server.ts");
  server = spawn(TSX_BIN, [serverPath], {
    cwd: dirname(fileURLToPath(import.meta.url)),
    env: {
      ...process.env,
      PORT: String(PORT),
      SAAS_BASE_URL: BASE_URL,
      NATS_URL: "ws://localhost:4222",
      POLL_INTERVAL_SECONDS: "0",
      EXPIRATION_SECONDS: "600",
      ENROLLMENT_ADMIN_TOKEN: "test-admin-token",
      ENABLE_TEST_ROUTES: "1",
    },
    stdio: "pipe",
  });
  await waitForHttp(`${BASE_URL}/enroll`, 30_000);
}, 40_000);

afterAll(() => {
  server?.kill("SIGTERM");
  server = null;
});

async function mint(
  role: string,
  peerId?: string,
  extraBody: Record<string, unknown> = {},
): Promise<{ userJwt: string }> {
  const res = await fetch(`${BASE_URL}/test/nats-user`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tenant: "t1", role, ...(peerId ? { peerId } : {}), ...extraBody }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { userJwt: string };
}

describe("/test/nats-user — server-forced credential TTL (P0-3 R5-2)", () => {
  it.each([
    ["agent", undefined],
    ["observer", undefined],
    ["browser", "p1"],
  ])("role %s: minted JWT carries exp ≈ now+900 (short-lived, not perpetual)", async (role, peerId) => {
    const nowSec = Math.floor(Date.now() / 1000);
    const { userJwt } = await mint(role, peerId);
    const claims = decode<User>(userJwt);
    // exp MUST be present (the pre-P0-3 route minted non-expiring creds → exp undefined).
    expect(claims.exp, `role ${role} must have an exp`).toBeTypeOf("number");
    const exp = claims.exp as number;
    // Bounded near now+TTL (generous window absorbs spawn + mint latency).
    expect(exp).toBeGreaterThan(nowSec + TTL - 120);
    expect(exp).toBeLessThanOrEqual(nowSec + TTL + 30);
  });

  it("a caller-supplied ttlSeconds in the body is IGNORED (TTL is server-forced)", async () => {
    // The route destructures only {tenant, role, peerId}; a body ttlSeconds must
    // NOT widen the lifetime — otherwise an unauthenticated caller could mint a
    // near-perpetual tenant-wide agent credential.
    const nowSec = Math.floor(Date.now() / 1000);
    const { userJwt } = await mint("agent", undefined, { ttlSeconds: 99999 });
    const claims = decode<User>(userJwt);
    expect(claims.exp, "exp must still be present").toBeTypeOf("number");
    const exp = claims.exp as number;
    // Still bounded to the server-forced ~now+900, NOT the requested now+99999.
    expect(exp).toBeGreaterThan(nowSec + TTL - 120);
    expect(exp).toBeLessThanOrEqual(nowSec + TTL + 30);
  });
});
