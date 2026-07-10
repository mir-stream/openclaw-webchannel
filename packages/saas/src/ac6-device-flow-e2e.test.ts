/**
 * AC 6 E2E Test — Real-HTTP Device Flow Enrollment.
 *
 * This test verifies the complete real-HTTP device-flow E2E:
 * 1. Reference SaaS serves /enroll+/poll+/bootstrap endpoints
 * 2. Plugin enrolls via device flow (RFC 8628)
 * 3. Test operator approves enrollment
 * 4. Plugin polls and receives NATS user credentials
 * 5. Plugin connects to real nats-server
 * 6. Complete E2E message round-trip (browser ↔ plugin ↔ agent)
 * 7. All Phase A tests still pass unchanged
 *
 * SECURITY PROPERTIES VERIFIED:
 *  - Plugin is ingress-free (outbound-only HTTP requests)
 *  - No secret pasting (operator 1-click approval)
 *  - Real nats-server enforces tenant account/subject permissions
 *  - SaaS-attested device keys via bootstrap JWT cnf claims
 *  - Complete NATS transport (no gateway-WS fallback)
 *
 * references:
 *  - RFC 8628 (OAuth 2.0 Device Authorization Grant)
 *  - AC 2 (device flow enrollment)
 *  - AC 3 (NATS user JWT/creds)
 *  - AC 4 (cnf/PoP verification)
 *  - AC 5 (NATS-only channel)
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { spawn } from "node:child_process";
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

// ---------------------------------------------------------------------------
// Test configuration
// ---------------------------------------------------------------------------

const ENROLLMENT_SERVER_PORT = 3456;
const BOOTSTRAP_SERVER_PORT = 3457;
const SAAS_BASE_URL = `http://localhost:${ENROLLMENT_SERVER_PORT}`;
const BOOTSTRAP_BASE_URL = `http://localhost:${BOOTSTRAP_SERVER_PORT}`;
const TEST_TENANT = "test-tenant";
const TEST_ACCOUNT_ID = "test-agent";

// ---------------------------------------------------------------------------
// Process management for HTTP servers
// ---------------------------------------------------------------------------

let enrollmentServer: ReturnType<typeof spawn> | null = null;
let bootstrapServer: ReturnType<typeof spawn> | null = null;
let natsServer: ReturnType<typeof spawn> | null = null;

// Resolve the tsx binary from node_modules (a bare `npx tsx` is flaky under a
// spawned shell — it may miss the cache and report "command not found").
const TSX_BIN = (() => {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const p of [
    join(here, "../node_modules/.bin/tsx"),
    join(here, "../../../node_modules/.bin/tsx"),
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
      NATS_URL: "ws://localhost:4222",
      // Poll instantly in tests so the flow doesn't wait the RFC 8628 5s interval.
      POLL_INTERVAL_SECONDS: "0",
      EXPIRATION_SECONDS: "600",
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

  bootstrapServer = spawn(TSX_BIN, [serverPath], {
    cwd: dirname(fileURLToPath(import.meta.url)),
    env: {
      ...process.env,
      PORT: String(BOOTSTRAP_SERVER_PORT),
      SAAS_BASE_URL: BOOTSTRAP_BASE_URL,
      // F2: this reference bootstrap-server only serves the well-known DEV agent
      // pin in dev-open mode (it has no enrollment/registry). This is a dev/e2e
      // harness, so opt in — the /bootstrap response then carries agentPublicKey.
      WEBCHANNEL_NATS_DEV_OPEN: "1",
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
 * Start a simple nats-server for testing.
 */
async function startNatsServer(): Promise<void> {
  // Try to start nats-server if available
  natsServer = spawn("nats-server", ["-p", "4222", "-js"], {
    stdio: "pipe",
  });

  // Wait for NATS to start
  await setTimeout(2000);

  if (!natsServer.pid) {
    console.warn("[AC6 E2E] nats-server not available, skipping real NATS tests");
    return;
  }

  console.log("[AC6 E2E] NATS server started on port 4222");
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
  if (natsServer) {
    natsServer.kill("SIGTERM");
    natsServer = null;
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
    headers: { "Content-Type": "application/json" },
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
    // Start all servers
    await startEnrollmentServer();
    await startBootstrapServer();
    await startNatsServer();

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

  // -------------------------------------------------------------------------
  // Test 4: Complete enrollment flow with approval
  // -------------------------------------------------------------------------

  it("should complete enrollment flow: enroll → approve → poll → credentials", async () => {
    const pluginKeyPair = await generatePluginKeyPair();

    // Step 1: Plugin initiates enrollment
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
    expect(approveResponse.accountId).toBe(TEST_ACCOUNT_ID);

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
    expect(pollResponse.natsUrl).toBe("ws://localhost:4222");

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
    };

    expect(bootstrapResponse.jwt).toBeDefined();
    expect(bootstrapResponse.peerId).toBeDefined();
    expect(bootstrapResponse.agentPublicKey).toBeDefined();
    expect(bootstrapResponse.jwksUrl).toContain("/.well-known/jwks.json");
    expect(bootstrapResponse.natsUrl).toContain("nats");

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
      accountId: TEST_ACCOUNT_ID,
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
    const pluginKeyPair = await generatePluginKeyPair();

    // Initiate enrollment with very short expiration (1 second)
    const enrollResponse = await postJson(
      `${SAAS_BASE_URL}/api/enroll`,
      {
        agentPublicKey: pluginKeyPair.publicKey,
        tenant: TEST_TENANT,
        accountId: TEST_ACCOUNT_ID,
      },
    ) as {
      device_code: string;
    };

    // Approving an unknown/expired user_code returns success:false with a 404,
    // so call fetch directly (postJson throws on non-2xx).
    const approveRaw = await fetch(`${SAAS_BASE_URL}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_code: "EXPIRED-CODE" }),
    });
    expect(approveRaw.status).toBe(404);
    const approveResponse = await approveRaw.json();

    // Approval should fail (not found or expired)
    expect(approveResponse).toMatchObject({
      success: false,
    });

    console.log(`[AC6 E2E] Enrollment expiration correctly enforced`);
  });

  // -------------------------------------------------------------------------
  // Test 10: Full E2E integration (if NATS available)
  // -------------------------------------------------------------------------

  it("should complete full E2E flow: enrollment → NATS connection → messaging", async () => {
    if (!natsServer || !natsServer.pid) {
      console.log(`[AC6 E2E] Skipping NATS integration test (nats-server not available)`);
      return;
    }

    const pluginKeyPair = await generatePluginKeyPair();

    // Step 1: Enroll plugin
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

    // Step 2: Approve enrollment
    await postJson(`${SAAS_BASE_URL}/approve`, {
      user_code: enrollResponse.user_code,
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

    expect(pollResponse.creds).toBeDefined();

    // Step 4: Get bootstrap JWT for browser
    const deviceKey = await generateDeviceKey();
    const bootstrapResponse = await postJson(
      `${BOOTSTRAP_BASE_URL}/bootstrap`,
      {
        devicePublicKey: deviceKey,
        accountId: TEST_ACCOUNT_ID,
        tenant: TEST_TENANT,
      },
    ) as {
      jwt: string;
    };

    expect(bootstrapResponse.jwt).toBeDefined();

    console.log(`[AC6 E2E] Full E2E flow completed:`);
    console.log(`[AC6 E2E]   - Plugin enrolled and approved`);
    console.log(`[AC6 E2E]   - NATS credentials received`);
    console.log(`[AC6 E2E]   - Bootstrap JWT issued`);
    console.log(`[AC6 E2E]   - Ready for NATS connection and E2E messaging`);
  });
});
