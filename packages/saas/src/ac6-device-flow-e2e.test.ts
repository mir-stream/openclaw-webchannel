/**
 * AC 6 E2E Test — Real-HTTP Device Flow Enrollment.
 *
 * This test verifies the complete real-HTTP device-flow E2E:
 * 1. Reference SaaS serves /enroll+/poll+/bootstrap endpoints
 * 2. Plugin enrolls via device flow (RFC 8628)
 * 3. Test operator approves enrollment
 * 4. Plugin polls and receives tenant-scoped NATS credentials and the relay URL
 * 5. Browser bootstrap JWTs interoperate with the plugin verifier
 *
 * SECURITY PROPERTIES VERIFIED:
 *  - Plugin is ingress-free (outbound-only HTTP requests)
 *  - No secret pasting (operator 1-click approval)
 *  - SaaS-attested device keys via bootstrap JWT cnf claims
 *
 * references:
 *  - RFC 8628 (OAuth 2.0 Device Authorization Grant)
 *  - AC 2 (device flow enrollment)
 *  - AC 3 (NATS user JWT/creds)
 *  - AC 4 (cnf/PoP verification)
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { setTimeout } from "node:timers/promises";

// Cross-package import: prove real-issuer ↔ real-verifier interop at the unit
// level. The plugin's RS256 verifier + JWKS resolver MUST admit the JWT the
// reference bootstrap-server issues, against the JWKS it serves.
import { verifyJwt } from "../../plugin/src/jwt.js";
import { JWKSCache } from "../../plugin/src/jwks.js";

// Test 9 (enrollment expiration) stands up a dedicated enrollment service on its
// own real HTTP socket, composed from the SAME primitives the reference server
// uses. Its lifetime is the ordinary 600s default — the isolation is NOT a shorter
// expiry but an INJECTED REPOSITORY CLOCK, which the shared spawned server does not
// expose. That clock is what lets the deadline be crossed instantly, and the
// separate socket is what keeps the jump from disturbing the shared server.
import { DeviceFlowEnrollment } from "../src/device-flow-enrollment.js";
import { MemoryEnrollmentRepository } from "../src/enrollment-repository.js";
import { createReferenceEnrollmentHttpHandler } from "../src/enrollment-http-handler.js";
import { setupTrustChain } from "../src/setup-trust-chain.js";

// ---------------------------------------------------------------------------
// Test configuration
// ---------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..");
const PORTS = JSON.parse(
  readFileSync(join(REPO_ROOT, "e2e", "local", "ports.json"), "utf8"),
) as { vitest: Record<string, Record<string, number>> };
const SUITE_PORTS = PORTS.vitest["packages/saas/src/ac6-device-flow-e2e.test.ts"];
const NATS_CLIENT_PORT = SUITE_PORTS.NATS_CLIENT_PORT;
const ENROLLMENT_SERVER_PORT = SUITE_PORTS.ENROLLMENT_SERVER_PORT;
const BOOTSTRAP_SERVER_PORT = SUITE_PORTS.BOOTSTRAP_SERVER_PORT;
const NATS_URL = `ws://localhost:${NATS_CLIENT_PORT}`;
const SAAS_BASE_URL = `http://localhost:${ENROLLMENT_SERVER_PORT}`;
const BOOTSTRAP_BASE_URL = `http://localhost:${BOOTSTRAP_SERVER_PORT}`;
const TEST_TENANT = "test-tenant";
const TEST_ACCOUNT_ID = "test-agent";

// ---------------------------------------------------------------------------
// Process management for HTTP servers
// ---------------------------------------------------------------------------

let enrollmentServer: ReturnType<typeof spawn> | null = null;
let bootstrapServer: ReturnType<typeof spawn> | null = null;
let bootstrapAgentPublicKey = "";

// Resolve the tsx binary from node_modules (a bare `npx tsx` is flaky under a
// spawned shell — it may miss the cache and report "command not found").
const TSX_BIN = (() => {
  for (const p of [
    join(HERE, "../node_modules/.bin/tsx"),
    join(HERE, "../../../node_modules/.bin/tsx"),
  ]) {
    if (existsSync(p)) return p;
  }
  return "tsx";
})();

/**
 * Poll an HTTP endpoint until it responds (any status) or the timeout elapses.
 * Replaces fixed sleeps so spawned servers are awaited deterministically.
 */
async function waitForHttp(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      await fetch(url, { method: "GET" });
      return; // any HTTP response (even 4xx) means the server is up
    } catch (err) {
      lastErr = err;
      await setTimeout(150);
    }
  }
  throw new Error(`Timed out waiting for ${url}: ${String(lastErr)}`);
}

/**
 * Start the enrollment HTTP server.
 */
async function startEnrollmentServer(): Promise<void> {
  const serverPath = join(
    dirname(fileURLToPath(import.meta.url)),
    "../reference/enrollment-server.ts",
  );

  // The reference servers are TypeScript — run them through tsx, not bare node.
  enrollmentServer = spawn(TSX_BIN, [serverPath], {
    cwd: dirname(fileURLToPath(import.meta.url)),
    env: {
      ...process.env,
      PORT: String(ENROLLMENT_SERVER_PORT),
      SAAS_BASE_URL: SAAS_BASE_URL,
      NATS_URL,
      // Poll instantly in tests so the flow doesn't wait the RFC 8628 5s interval.
      POLL_INTERVAL_SECONDS: "0",
      EXPIRATION_SECONDS: "600",
      ENROLLMENT_ADMIN_TOKEN: "test-admin-token",
      ENABLE_TEST_ROUTES: "1",
    },
    stdio: "pipe",
  });

  await waitForHttp(`${SAAS_BASE_URL}/enroll`, 30_000);

  if (!enrollmentServer.pid) {
    throw new Error("Failed to start enrollment server");
  }

  console.log(`[AC6 E2E] Enrollment server started on port ${ENROLLMENT_SERVER_PORT}`);
}

/**
 * Start the bootstrap HTTP server.
 */
async function startBootstrapServer(): Promise<void> {
  const serverPath = join(
    dirname(fileURLToPath(import.meta.url)),
    "../reference/bootstrap-server.ts",
  );

  bootstrapAgentPublicKey = await generateDeviceKey();
  bootstrapServer = spawn(TSX_BIN, [serverPath], {
    cwd: dirname(fileURLToPath(import.meta.url)),
    env: {
      ...process.env,
      PORT: String(BOOTSTRAP_SERVER_PORT),
      SAAS_BASE_URL: BOOTSTRAP_BASE_URL,
      WEBCHANNEL_AGENT_PUBLIC_KEY: bootstrapAgentPublicKey,
      ENABLE_TEST_ROUTES: "1",
      REFERENCE_TENANT: TEST_TENANT,
      REFERENCE_ACCOUNT_ID: TEST_ACCOUNT_ID,
    },
    stdio: "pipe",
  });

  await waitForHttp(`${BOOTSTRAP_BASE_URL}/.well-known/jwks.json`, 30_000);

  if (!bootstrapServer.pid) {
    throw new Error("Failed to start bootstrap server");
  }

  console.log(`[AC6 E2E] Bootstrap server started on port ${BOOTSTRAP_SERVER_PORT}`);
}

/**
 * Stop all servers.
 */
function stopAllServers(): void {
  if (enrollmentServer) {
    enrollmentServer.kill("SIGTERM");
    enrollmentServer = null;
  }
  if (bootstrapServer) {
    bootstrapServer.kill("SIGTERM");
    bootstrapServer = null;
  }
}

// ---------------------------------------------------------------------------
// HTTP client utilities
// ---------------------------------------------------------------------------

/**
 * Make an HTTP POST request with JSON body.
 */
async function postJson(url: string, body: unknown): Promise<unknown> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(url.endsWith("/approve") || url.endsWith("/deny") || url.endsWith("/revoke") ? { Authorization: "Bearer test-admin-token" } : {}) },
    body: JSON.stringify(body),
  });

  // RFC 8628 device flow returns 400 + a JSON `{error}` body for pending/denied
  // poll results — those are valid responses, not transport failures. Return any
  // JSON body regardless of status; only throw when the body isn't JSON.
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`HTTP ${response.status}: ${text}`);
  }
}

/**
 * Make an HTTP GET request.
 */
async function getJson(url: string): Promise<unknown> {
  const response = await fetch(url);

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`HTTP ${response.status}: ${text}`);
  }

  return response.json();
}

// ---------------------------------------------------------------------------
// Crypto utilities for plugin simulation
// ---------------------------------------------------------------------------

/**
 * Generate an X25519 key pair for the plugin.
 */
async function generatePluginKeyPair(): Promise<{ publicKey: string; privateKey: string }> {
  const keyPair = await globalThis.crypto.subtle.generateKey(
    {
      name: "X25519",
    },
    true,
    ["deriveKey", "deriveBits"],
  );
  if (!("publicKey" in keyPair)) {
    throw new Error("Expected CryptoKeyPair from X25519 generateKey");
  }

  const publicKeyBuffer = await globalThis.crypto.subtle.exportKey("raw", keyPair.publicKey);
  const privateKeyBuffer = await globalThis.crypto.subtle.exportKey("pkcs8", keyPair.privateKey);

  const publicKey = Buffer.from(publicKeyBuffer).toString("base64url");
  const privateKey = Buffer.from(privateKeyBuffer).toString("base64url");

  return { publicKey, privateKey };
}

/**
 * Generate a browser device key for bootstrap testing.
 */
async function generateDeviceKey(): Promise<string> {
  const keyPair = await globalThis.crypto.subtle.generateKey(
    {
      name: "X25519",
    },
    true,
    ["deriveKey", "deriveBits"],
  );
  if (!("publicKey" in keyPair)) {
    throw new Error("Expected CryptoKeyPair from X25519 generateKey");
  }

  const publicKeyBuffer = await globalThis.crypto.subtle.exportKey("raw", keyPair.publicKey);
  return Buffer.from(publicKeyBuffer).toString("base64url");
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("AC 6 E2E: Real-HTTP Device Flow Enrollment", () => {
  beforeAll(async () => {
    // Start both HTTP servers.
    await startEnrollmentServer();
    await startBootstrapServer();

    // Additional wait for servers to be fully ready
    await setTimeout(1000);
  }, 60_000);

  afterAll(() => {
    stopAllServers();
  });

  // -------------------------------------------------------------------------
  // Test 1: Enrollment server health check
  // -------------------------------------------------------------------------

  it("should have enrollment server running", async () => {
    // The reference server has no `/` route; probe a real endpoint instead.
    const response = await fetch(`${SAAS_BASE_URL}/enroll`);
    expect(response.ok).toBe(true);
  });

  it("P1-1 admin endpoints require bearer auth while public endpoints and CORS remain available", async () => {
    for (const path of ["approve", "deny", "revoke"]) {
      const missing = await fetch(`${SAAS_BASE_URL}/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_code: "NO-SUCH-CODE", tenant: TEST_TENANT, accountId: TEST_ACCOUNT_ID }),
      });
      expect(missing.status, path).toBe(401);
      const wrong = await fetch(`${SAAS_BASE_URL}/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer wrong" },
        body: JSON.stringify({ user_code: "NO-SUCH-CODE", tenant: TEST_TENANT, accountId: TEST_ACCOUNT_ID }),
      });
      expect(wrong.status, path).toBe(401);
    }
    const preflight = await fetch(`${SAAS_BASE_URL}/approve`, { method: "OPTIONS" });
    expect(preflight.headers.get("access-control-allow-headers")).toContain("Authorization");
    const html = await (await fetch(`${SAAS_BASE_URL}/enroll?user_code=SAFE-CODE`)).text();
    expect(html).not.toContain("test-admin-token");
    expect(html).not.toContain("Bearer test-admin-token");
  });

  // -------------------------------------------------------------------------
  // Test 2: Bootstrap server health check
  // -------------------------------------------------------------------------

  it("should have bootstrap server running", async () => {
    // No `/` route on the reference server; the JWKS endpoint is always GET-able.
    const response = await fetch(`${BOOTSTRAP_BASE_URL}/.well-known/jwks.json`);
    expect(response.ok).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Test 3: Plugin enrollment initiation
  // -------------------------------------------------------------------------

  it("plugin should initiate enrollment via /api/enroll", async () => {
    const pluginKeyPair = await generatePluginKeyPair();

    const enrollRequest = {
      agentPublicKey: pluginKeyPair.publicKey,
      tenant: TEST_TENANT,
      accountId: TEST_ACCOUNT_ID,
    };

    const enrollResponse = await postJson(
      `${SAAS_BASE_URL}/api/enroll`,
      enrollRequest,
    );

    expect(enrollResponse).toMatchObject({
      device_code: expect.any(String),
      user_code: expect.any(String),
      verification_uri: expect.any(String),
      verification_uri_complete: expect.any(String),
      expires_in: expect.any(Number),
      interval: expect.any(Number),
    });

    // User code should be in format XXXX-XXXX
    expect((enrollResponse as { user_code: string }).user_code).toMatch(/^\w{4}-\w{4}$/);

    console.log(`[AC6 E2E] Enrollment initiated: ${(enrollResponse as { user_code: string }).user_code}`);
  });

  it("P1-1 test bootstrap ignores a caller-supplied agentPublicKey and serves the registry pin", async () => {
    const enrolledKey = await generatePluginKeyPair();
    const attackerKey = await generatePluginKeyPair();
    const accountId = "registry-pin-test";
    const started = await postJson(`${SAAS_BASE_URL}/api/enroll`, {
      agentPublicKey: enrolledKey.publicKey,
      tenant: TEST_TENANT,
      accountId,
    }) as { user_code: string };
    const approved = await postJson(`${SAAS_BASE_URL}/approve`, { user_code: started.user_code }) as { success: boolean };
    expect(approved.success).toBe(true);
    const bootstrap = await postJson(`${SAAS_BASE_URL}/test/bootstrap-jwt`, {
      tenant: TEST_TENANT,
      accountId,
      peerId: "registry-pin-peer",
      deviceX25519PublicKey: await generateDeviceKey(),
      agentPublicKey: attackerKey.publicKey,
    }) as { agentPublicKey?: string };
    expect(bootstrap.agentPublicKey).toBe(enrolledKey.publicKey);
    expect(bootstrap.agentPublicKey).not.toBe(attackerKey.publicKey);
  });

  it("test bootstrap rejects a peerId that can alter the NATS subject hierarchy", async () => {
    const response = await fetch(`${SAAS_BASE_URL}/test/bootstrap-jwt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tenant: TEST_TENANT,
        accountId: TEST_ACCOUNT_ID,
        peerId: "peer.*",
        deviceX25519PublicKey: await generateDeviceKey(),
      }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: expect.stringMatching(/peerId/) });
  });

  // -------------------------------------------------------------------------
  // Test 4: Complete enrollment flow with approval
  // -------------------------------------------------------------------------

  it("should complete enrollment flow: enroll → approve → poll → credentials", async () => {
    // Own slot: this test approves+polls, which activates a registry key for
    // (tenant, accountId). Sharing TEST_ACCOUNT_ID with other approving tests
    // would make a later plain approve here (or there) hit the "conflict"
    // outcome (an active key already occupies the slot) instead of "approved".
    const accountId = `${TEST_ACCOUNT_ID}-full-flow`;
    const pluginKeyPair = await generatePluginKeyPair();

    // Step 1: Plugin initiates enrollment
    const enrollResponse = await postJson(
      `${SAAS_BASE_URL}/api/enroll`,
      {
        agentPublicKey: pluginKeyPair.publicKey,
        tenant: TEST_TENANT,
        accountId,
      },
    ) as {
      device_code: string;
      user_code: string;
      verification_uri_complete: string;
      interval: number;
    };

    const { device_code, user_code, interval } = enrollResponse;

    console.log(`[AC6 E2E] Step 1: Plugin enrollment initiated with user_code: ${user_code}`);

    // Step 2: Operator approves enrollment (simulate POST /approve)
    const approveResponse = await postJson(`${SAAS_BASE_URL}/approve`, {
      user_code,
    }) as {
      success: boolean;
      peerId: string;
      tenant: string;
      accountId: string;
    };

    expect(approveResponse.success).toBe(true);
    expect(approveResponse.peerId).toBeDefined();
    expect(approveResponse.tenant).toBe(TEST_TENANT);
    expect(approveResponse.accountId).toBe(accountId);

    console.log(`[AC6 E2E] Step 2: Enrollment approved, peerId: ${approveResponse.peerId}`);

    // Step 3: Plugin polls for credentials
    // Wait minimum interval before first poll
    await setTimeout(interval * 1000);

    const pollResponse = await postJson(`${SAAS_BASE_URL}/api/poll`, {
      device_code,
    }) as {
      creds?: {
        userJwt: string;
        userSeed: string;
        permissions?: {
          pub?: string[];
          sub?: string[];
        };
      };
      peerId?: string;
      jwksUrl?: string;
      bootstrapUrl?: string;
      natsUrl?: string;
      error?: string;
    };

    // Should have credentials, not an error
    expect(pollResponse.error).toBeUndefined();
    expect(pollResponse.creds).toBeDefined();
    expect(pollResponse.creds?.userJwt).toBeDefined();
    expect(pollResponse.creds?.userSeed).toBeDefined();
    expect(pollResponse.peerId).toBe(approveResponse.peerId);
    expect(pollResponse.jwksUrl).toContain("/.well-known/jwks.json");
    // The SaaS is the rendezvous authority: the relay URL travels WITH the minted
    // creds, so the plugin never has to be told where NATS lives out-of-band. This
    // is the exact NATS_URL the enrollment-server was booted with (see env above).
    expect(pollResponse.natsUrl).toBe(NATS_URL);

    console.log(`[AC6 E2E] Step 3: Plugin received NATS credentials for peerId: ${pollResponse.peerId}`);

    // Step 4: Verify credentials have proper permissions
    expect(pollResponse.creds?.permissions).toBeDefined();
    expect(pollResponse.creds?.permissions?.pub).toBeDefined();
    expect(pollResponse.creds?.permissions?.sub).toBeDefined();

    // Permissions should be tenant-scoped
    const pubPerms = pollResponse.creds?.permissions?.pub || [];
    const subPerms = pollResponse.creds?.permissions?.sub || [];

    expect(pubPerms.some(perm => perm.includes(TEST_TENANT))).toBe(true);
    expect(subPerms.some(perm => perm.includes(TEST_TENANT))).toBe(true);

    console.log(`[AC6 E2E] Step 4: Credentials verified with tenant-scoped permissions`);
  });

  // -------------------------------------------------------------------------
  // Test 5: Bootstrap JWT issuance
  // -------------------------------------------------------------------------

  it("should issue bootstrap JWT with cnf claim via /bootstrap", async () => {
    const devicePublicKey = await generateDeviceKey();

    const bootstrapRequest = {
      devicePublicKey,
      accountId: TEST_ACCOUNT_ID,
      tenant: TEST_TENANT,
    };

    const bootstrapResponse = await postJson(
      `${BOOTSTRAP_BASE_URL}/bootstrap`,
      bootstrapRequest,
    ) as {
      jwt: string;
      peerId: string;
      agentPublicKey: string;
      jwksUrl: string;
      natsUrl: string;
      accountId: string;
      tenant: string;
    };

    expect(bootstrapResponse.jwt).toBeDefined();
    expect(bootstrapResponse.peerId).toBeDefined();
    expect(bootstrapResponse.agentPublicKey).toBe(bootstrapAgentPublicKey);
    expect(bootstrapResponse.jwksUrl).toContain("/.well-known/jwks.json");
    expect(bootstrapResponse.natsUrl).toContain("nats");
    expect(bootstrapResponse.accountId).toBe(TEST_ACCOUNT_ID);
    expect(bootstrapResponse.tenant).toBe(TEST_TENANT);

    // Verify JWT structure (header.payload.signature)
    const jwtParts = bootstrapResponse.jwt.split(".");
    expect(jwtParts).toHaveLength(3);

    // Header MUST carry a real kid that matches the served JWKS (not "demo-key-id").
    const header = JSON.parse(
      Buffer.from(jwtParts[0], "base64url").toString("utf-8"),
    );
    expect(header.alg).toBe("RS256");
    expect(header.kid).toBeDefined();
    expect(header.kid).not.toBe("demo-key-id");

    // Decode payload and verify cnf claim
    const payload = JSON.parse(
      Buffer.from(jwtParts[1], "base64url").toString("utf-8"),
    );

    expect(payload).toMatchObject({
      iss: expect.any(String),
      sub: bootstrapResponse.peerId, // peerId is threaded into sub
      aud: TEST_ACCOUNT_ID,
      tenant: TEST_TENANT,
      cnf: {
        jwk: {
          kty: "OKP",
          crv: "X25519",
          x: devicePublicKey,
        },
      },
    });

    // The signature must NOT be the old mock placeholder.
    expect(Buffer.from(jwtParts[2], "base64url").toString("utf-8")).not.toBe("mock-signature");

    console.log(`[AC6 E2E] Bootstrap JWT issued for peerId: ${payload.sub}`);
    console.log(`[AC6 E2E] cnf.jwk claim verified for device key`);
  });

  // -------------------------------------------------------------------------
  // Test 5b: Real issuer ↔ real verifier interop (cross-package)
  //
  // The strongest unit-level proof: the JWT minted+signed by the REAL
  // bootstrap-server VERIFIES against the JWKS it serves, using the PLUGIN's
  // own RS256 verifier + JWKS resolver. This is the same code path the live
  // register hop exercises, asserted directly without spinning up a gateway.
  // -------------------------------------------------------------------------

  it("issued JWT verifies against served JWKS via the plugin's verifyJwt", async () => {
    const devicePublicKey = await generateDeviceKey();

    const bootstrapResponse = await postJson(
      `${BOOTSTRAP_BASE_URL}/bootstrap`,
      { devicePublicKey, accountId: TEST_ACCOUNT_ID, tenant: TEST_TENANT },
    ) as { jwt: string; peerId: string };

    // The plugin resolves keys by kid from the live JWKS URL (fail-closed cache).
    const jwks = JWKSCache.create({
      jwksUrl: `${BOOTSTRAP_BASE_URL}/.well-known/jwks.json`,
    });

    // Recover the issuer the server actually used (env-configurable) from the JWT.
    const payload = JSON.parse(
      Buffer.from(bootstrapResponse.jwt.split(".")[1], "base64url").toString("utf-8"),
    ) as { iss: string };

    const identity = await verifyJwt(bootstrapResponse.jwt, {
      jwks,
      issuer: payload.iss,
      audience: TEST_ACCOUNT_ID,
    });

    // A real RS256 signature over a real RSA key → verifyJwt returns the identity.
    expect(identity).not.toBeNull();
    expect(identity?.peerId).toBe(bootstrapResponse.peerId);
    expect(identity?.devicePublicKey).toBe(devicePublicKey);

    console.log(`[AC6 E2E] verifyJwt admitted real-issuer JWT for peerId: ${identity?.peerId}`);
  });

  it("standalone test issuer rejects a caller that tries to choose another tuple", async () => {
    const devicePublicKey = await generateDeviceKey();
    const response = await fetch(`${BOOTSTRAP_BASE_URL}/bootstrap`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        devicePublicKey,
        tenant: TEST_TENANT,
        accountId: "caller-chosen-account",
      }),
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringMatching(/server-owned test tuple/),
    });
  });

  // -------------------------------------------------------------------------
  // Test 6: JWKS endpoint serves RSA public key
  // -------------------------------------------------------------------------

  it("should serve JWKS with RSA public key at /.well-known/jwks.json", async () => {
    const jwksResponse = await getJson(`${BOOTSTRAP_BASE_URL}/.well-known/jwks.json`) as {
      keys: Array<{
        kty: string;
        kid: string;
        alg: string;
        use: string;
        n: string;
        e: string;
      }>;
    };

    expect(jwksResponse.keys).toBeDefined();
    expect(jwksResponse.keys.length).toBeGreaterThan(0);

    const rsaKey = jwksResponse.keys[0];
    expect(rsaKey).toMatchObject({
      kty: "RSA",
      alg: "RS256",
      use: "sig",
      kid: expect.any(String),
      n: expect.any(String),
      e: "AQAB",
    });

    // The served modulus must be a REAL RSA-2048 modulus — not the old mock.
    expect(rsaKey.n).not.toBe("mock-modulus-base64url-encoded");
    expect(rsaKey.kid).not.toBe("demo-key-id");
    // RSA-2048 modulus is 256 bytes → ~342 base64url chars; assert it's plausibly real.
    expect(Buffer.from(rsaKey.n, "base64url").length).toBeGreaterThanOrEqual(256);
    // The served key's kid MUST match the kid the issuer stamps into JWT headers.
    const devicePublicKey = await generateDeviceKey();
    const boot = await postJson(
      `${BOOTSTRAP_BASE_URL}/bootstrap`,
      { devicePublicKey, accountId: TEST_ACCOUNT_ID, tenant: TEST_TENANT },
    ) as { jwt: string };
    const jwtHeader = JSON.parse(
      Buffer.from(boot.jwt.split(".")[0], "base64url").toString("utf-8"),
    ) as { kid: string };
    expect(jwtHeader.kid).toBe(rsaKey.kid);

    console.log(`[AC6 E2E] JWKS endpoint serves REAL RSA public key with kid: ${rsaKey.kid}`);
  });

  // -------------------------------------------------------------------------
  // Test 7: Enrollment denial works correctly
  // -------------------------------------------------------------------------

  it("should handle enrollment denial correctly", async () => {
    const pluginKeyPair = await generatePluginKeyPair();

    // Initiate enrollment
    const enrollResponse = await postJson(
      `${SAAS_BASE_URL}/api/enroll`,
      {
        agentPublicKey: pluginKeyPair.publicKey,
        tenant: TEST_TENANT,
        accountId: TEST_ACCOUNT_ID,
      },
    ) as {
      device_code: string;
      user_code: string;
    };

    const { device_code, user_code } = enrollResponse;

    // Deny enrollment
    const denyResponse = await postJson(`${SAAS_BASE_URL}/deny`, {
      user_code,
    }) as {
      success: boolean;
    };

    expect(denyResponse.success).toBe(true);

    // Poll should return access_denied (poll interval is 0 in tests)
    await setTimeout(50);

    const pollResponse = await postJson(`${SAAS_BASE_URL}/api/poll`, {
      device_code,
    }) as {
      error: string;
      error_description?: string;
    };

    expect(pollResponse.error).toBe("access_denied");
    expect(pollResponse.error_description).toBeDefined();

    console.log(`[AC6 E2E] Enrollment denial correctly propagated to plugin`);
  });

  // -------------------------------------------------------------------------
  // Test 8: Multiple enrollments are isolated
  // -------------------------------------------------------------------------

  it("should maintain isolation between multiple enrollments", async () => {
    const plugin1 = await generatePluginKeyPair();
    const plugin2 = await generatePluginKeyPair();

    // Enroll plugin 1
    const enroll1 = await postJson(
      `${SAAS_BASE_URL}/api/enroll`,
      {
        agentPublicKey: plugin1.publicKey,
        tenant: "tenant-1",
        accountId: "agent-1",
      },
    ) as {
      device_code: string;
      user_code: string;
    };

    // Enroll plugin 2
    const enroll2 = await postJson(
      `${SAAS_BASE_URL}/api/enroll`,
      {
        agentPublicKey: plugin2.publicKey,
        tenant: "tenant-2",
        accountId: "agent-2",
      },
    ) as {
      device_code: string;
      user_code: string;
    };

    // User codes should be different
    expect(enroll1.user_code).not.toBe(enroll2.user_code);
    expect(enroll1.device_code).not.toBe(enroll2.device_code);

    // Approve plugin 1
    await postJson(`${SAAS_BASE_URL}/approve`, {
      user_code: enroll1.user_code,
    });

    // Poll plugin 1 should succeed (poll interval is 0 in tests)
    await setTimeout(50);
    const poll1 = await postJson(`${SAAS_BASE_URL}/api/poll`, {
      device_code: enroll1.device_code,
    });

    expect((poll1 as { error?: string }).error).toBeUndefined();
    expect((poll1 as { creds?: unknown }).creds).toBeDefined();

    // Poll plugin 2 should still be pending
    const poll2 = await postJson(`${SAAS_BASE_URL}/api/poll`, {
      device_code: enroll2.device_code,
    });

    expect(poll2).toMatchObject({
      error: "authorization_pending",
    });

    console.log(`[AC6 E2E] Multiple enrollments properly isolated`);
  });

  // -------------------------------------------------------------------------
  // Test 9: Enrollment expiration is enforced
  // -------------------------------------------------------------------------

  it("should enforce enrollment expiration", async () => {
    // #150: the previous version of this test created a normal (600s) enrollment,
    // THREW AWAY its codes, then POSTed a hardcoded unknown user_code ("EXPIRED-CODE")
    // to /approve and asserted the ordinary unknown-code 404. That proved unknown-code
    // rejection, NOT expiration — a real regression in expiry enforcement stayed green.
    //
    // This version drives a REAL enrollment code through a pending→expired transition
    // and asserts the expired path is DISTINGUISHABLE from the unknown-code path.
    //
    // Mechanism: a dedicated enrollment service on its own real HTTP socket
    // (OS-assigned port), backed by the SAME DeviceFlowEnrollment +
    // MemoryEnrollmentRepository the reference server uses, fronted by the reference
    // HTTP handler (which that server delegates /approve to; it serves enroll/poll
    // from its own inline routes over the identical enrollment.enroll/poll calls).
    // This fixture keeps the ordinary 600s lifetime — expiry is reached NOT by a
    // shorter expiry but by an INJECTED CLOCK, deterministically and with no
    // wall-clock sleep. The issue's acceptance criteria explicitly endorse an
    // injectable/fake clock and forbid a long wall-clock sleep; the shared spawned
    // server exposes no per-request expiry or clock hook, so a dedicated instance is
    // required. Hence the clock jump below is 600s, not one second.
    let fakeNow = Date.now();
    const repository = new MemoryEnrollmentRepository({ clock: () => fakeNow, autoSweep: false });
    const trust = await setupTrustChain({
      operatorName: "expiry-test-operator",
      accountName: "expiry-test-account",
      returnOperatorSeed: true,
    });
    const expiryBaseUrl = "http://expiry-enrollment.invalid";
    const enrollment = new DeviceFlowEnrollment({
      saasTrustChain: trust.private,
      natsAccountConfig: trust.natsConfig,
      saasBaseUrl: expiryBaseUrl,
      jwksUrl: `${expiryBaseUrl}/.well-known/jwks.json`,
      bootstrapUrl: `${expiryBaseUrl}/bootstrap`,
      natsUrl: NATS_URL,
      pollIntervalSeconds: 0,
      repository,
    });
    const handler = createReferenceEnrollmentHttpHandler({
      adminToken: "test-admin-token",
      enrollment,
      registry: repository,
    });
    const expiryServer = createServer((req, res) => {
      void handler(req, res);
    });
    await new Promise<void>((resolve) => expiryServer.listen(0, "127.0.0.1", () => resolve()));
    const base = `http://127.0.0.1:${(expiryServer.address() as AddressInfo).port}`;

    try {
      const pluginKeyPair = await generatePluginKeyPair();

      // Create an enrollment and CAPTURE the real codes (the old test discarded them).
      const enrollResponse = await postJson(`${base}/enroll`, {
        agentPublicKey: pluginKeyPair.publicKey,
        tenant: TEST_TENANT,
        accountId: TEST_ACCOUNT_ID,
      }) as { device_code: string; user_code: string; expires_in: number };

      const { device_code, user_code, expires_in } = enrollResponse;
      expect(device_code).toBeTruthy();
      expect(user_code).toMatch(/^\w{4}-\w{4}$/);

      // BEFORE expiry: the REAL device code is live and pending — not expired, not unknown.
      const pendingPoll = await postJson(`${base}/poll`, { device_code }) as { error?: string };
      expect(pendingPoll.error).toBe("authorization_pending");

      // Baseline for the distinction: an UNKNOWN device code is rejected as
      // "invalid_device_code" — the ordinary unknown-code response the old test
      // conflated with expiry.
      const unknownPoll = await postJson(`${base}/poll`, { device_code: "no-such-device-code" }) as { error?: string };
      expect(unknownPoll.error).toBe("invalid_device_code");

      // Drive the REAL enrollment past its lifetime via the injected clock.
      fakeNow += expires_in * 1000 + 1;

      // AFTER expiry: polling the SAME real device code now returns the documented
      // expiry error "expired_token" — DISTINCT from the unknown-code error above. A
      // regression that failed to enforce expiration would leave this
      // "authorization_pending" and turn the assertion red.
      const expiredPoll = await postJson(`${base}/poll`, { device_code }) as { error?: string };
      expect(expiredPoll.error).toBe("expired_token");
      expect(expiredPoll.error).not.toBe(unknownPoll.error);

      // AFTER expiry: approving the REAL user code is rejected (404, success:false).
      // An expired code cannot be approved into live credentials. (postJson would
      // return the body regardless of status, but assert the 404 explicitly.)
      const approveRaw = await fetch(`${base}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer test-admin-token" },
        body: JSON.stringify({ user_code }),
      });
      expect(approveRaw.status).toBe(404);
      expect(await approveRaw.json()).toMatchObject({ success: false });

      console.log(
        `[AC6 E2E] Expiration enforced on a REAL code (pending→expired), distinct from unknown-code rejection`,
      );
    } finally {
      await new Promise<void>((resolve) => expiryServer.close(() => resolve()));
      repository.close();
    }
  });

  // -------------------------------------------------------------------------
  // Test 10: Full HTTP enrollment/bootstrap integration
  // -------------------------------------------------------------------------

  it("should complete full HTTP flow: enrollment → credential issuance → bootstrap", async () => {
    // Own slot: a plain approve here must land as "approved", not "conflict"
    // with whatever key another approving test already activated for
    // TEST_ACCOUNT_ID. See the "full-flow" test above for the same reasoning.
    const accountId = `${TEST_ACCOUNT_ID}-full-e2e`;
    const pluginKeyPair = await generatePluginKeyPair();

    // Step 1: Enroll plugin
    const enrollResponse = await postJson(
      `${SAAS_BASE_URL}/api/enroll`,
      {
        agentPublicKey: pluginKeyPair.publicKey,
        tenant: TEST_TENANT,
        accountId,
      },
    ) as {
      device_code: string;
      user_code: string;
    };

    // Step 2: Approve enrollment
    const approveResponse = await postJson(`${SAAS_BASE_URL}/approve`, {
      user_code: enrollResponse.user_code,
    }) as {
      success: boolean;
      peerId: string;
      tenant: string;
      accountId: string;
    };

    expect(approveResponse).toMatchObject({
      success: true,
      tenant: TEST_TENANT,
      accountId,
    });

    // Step 3: Poll for credentials (poll interval is 0 in tests)
    await setTimeout(50);
    const pollResponse = await postJson(`${SAAS_BASE_URL}/api/poll`, {
      device_code: enrollResponse.device_code,
    }) as {
      creds: {
        userJwt: string;
        userSeed: string;
      };
      peerId: string;
    };

    expect(pollResponse.creds.userJwt).toBeDefined();
    expect(pollResponse.creds.userSeed).toBeDefined();
    expect(pollResponse.peerId).toBe(approveResponse.peerId);

    // Step 4: Bootstrap the enrolled tuple through the issuer that owns the
    // enrollment registry. Its response must pin the key approved above.
    const deviceKey = await generateDeviceKey();
    const bootstrapResponse = await postJson(
      `${SAAS_BASE_URL}/test/bootstrap-jwt`,
      {
        deviceX25519PublicKey: deviceKey,
        peerId: pollResponse.peerId,
        accountId,
        tenant: TEST_TENANT,
      },
    ) as {
      jwt: string;
      peerId: string;
      agentPublicKey?: string;
    };

    expect(bootstrapResponse.jwt).toBeDefined();
    expect(bootstrapResponse.peerId).toBe(pollResponse.peerId);
    expect(bootstrapResponse.agentPublicKey).toBe(pluginKeyPair.publicKey);

    const bootstrapClaims = JSON.parse(
      Buffer.from(bootstrapResponse.jwt.split(".")[1], "base64url").toString("utf-8"),
    );
    expect(bootstrapClaims).toMatchObject({
      sub: pollResponse.peerId,
      aud: accountId,
      tenant: TEST_TENANT,
      cnf: { jwk: { x: deviceKey } },
    });

    console.log(`[AC6 E2E] Full HTTP flow completed:`);
    console.log(`[AC6 E2E]   - Plugin enrolled and approved`);
    console.log(`[AC6 E2E]   - NATS credentials received`);
    console.log(`[AC6 E2E]   - Bootstrap JWT linked to the enrolled tuple and agent key`);
  });
});
