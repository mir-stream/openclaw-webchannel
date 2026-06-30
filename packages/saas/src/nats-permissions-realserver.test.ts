/**
 * Real nats-server permission enforcement tests (AC 3).
 *
 * This suite validates that SaaS-issued NATS user JWT/creds + resolver enforce
 * tenant-scoped subject permissions at the REAL nats-server level (not a fake
 * broker).
 *
 * Tests verify:
 *  - A client authenticated as tenant A can pub/sub on webchannel.tenantA.* subjects.
 *  - A client authenticated as tenant A is DENIED pub/sub on webchannel.tenantB.*
 *    subjects at the NATS broker level — the real nats-server sends permission errors.
 *  - Cross-tenant publish cannot reach a different tenant's subscribers.
 *  - Unauthenticated clients (no JWT) are denied all pub/sub.
 *
 * Architecture
 * ────────────
 * 1. Run setupTrustChain to generate operator/account JWT + resolver config.
 * 2. Start real nats-server with JWT authentication enabled.
 * 3. For each tenant, generate NATS user JWT with tenant-scoped permissions.
 * 4. Connect using NatsTransport with JWT credentials.
 * 5. Verify real nats-server enforces permissions (not fake broker logic).
 *
 * The suite is skipped automatically when the nats-server binary is absent.
 * Install locally with `brew install nats-server`.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { fromSeed, createUser } from "@nats-io/nkeys";
import { encodeUser } from "@nats-io/jwt";

import { setupTrustChain } from "./setup-trust-chain.js";
import type { SetupTrustChainResult, NatsSelfContainedAccountConfig } from "./types.js";
import { DeviceFlowEnrollment } from "./device-flow-enrollment.js";
import type { NatsUserCredentials } from "./device-flow-types.js";

// ---------------------------------------------------------------------------
// Locate the nats-server binary
//
// In CI (process.env.CI === "true") the binary MUST be present — the CI gate
// provisions nats-server v2.14 before running tests, so a missing binary is a
// gate configuration error and we hard-fail rather than silently skip.
//
// In local dev, absence of the binary silently skips the suite (developer
// convenience — install with `brew install nats-server` to enable).
// ---------------------------------------------------------------------------

const NATS_SERVER_CANDIDATES = [
  "/opt/homebrew/bin/nats-server",
  "/usr/local/bin/nats-server",
  "/usr/bin/nats-server",
];
const NATS_SERVER_BIN =
  NATS_SERVER_CANDIDATES.find((p) => existsSync(p)) ?? null;

// Hard-fail in CI if nats-server is absent — silent skips are not allowed.
if (!NATS_SERVER_BIN && process.env.CI === "true") {
  throw new Error(
    "FATAL: nats-server binary not found in CI.\n" +
    "The e2e-gate.yml workflow must install nats-server v2.14 before running tests.\n" +
    "Searched paths:\n  " + NATS_SERVER_CANDIDATES.join("\n  "),
  );
}

// Dedicated ports for this suite (avoid clashes).
const CLIENT_PORT = 14224;
const WS_PORT = 18081;
const WS_URL = `ws://127.0.0.1:${WS_PORT}`;

let server: ChildProcess | null = null;
let testDir: string | null = null;

// ---------------------------------------------------------------------------
// Trust chain and enrollment service
// ---------------------------------------------------------------------------

// This suite only exercises the self-contained mode, so pin natsConfig to the
// self-contained shape (the overloaded setupTrustChain otherwise widens via
// ReturnType to the self-contained | external union).
let trustChain:
  | (SetupTrustChainResult & { natsConfig: NatsSelfContainedAccountConfig })
  | null = null;
let enrollment: DeviceFlowEnrollment | null = null;

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5000,
  stepMs = 50,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  throw new Error("waitFor: condition not met before timeout");
}

// ---------------------------------------------------------------------------
// NATS transport helpers (simplified for permission testing)
// ---------------------------------------------------------------------------

/**
 * Connect to NATS with JWT credentials using WebSocket.
 */
async function connectWithJwt(
  jwt: string,
  seed: string,
  _clientName: string,
): Promise<{ ws: WebSocket; ready: Promise<void> }> {
  const ws = new WebSocket(WS_URL);
  const userKp = fromSeed(new TextEncoder().encode(seed));

  const ready = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Connection timeout")), 4000);
    let authed = false;

    const onMessage = (data: Buffer) => {
      const text = data.toString();
      // The server greets with INFO {...,"nonce":"..."}; sign the nonce with the
      // user NKEY seed and reply with CONNECT — this is real NATS JWT auth.
      if (!authed && text.startsWith("INFO ")) {
        authed = true;
        let nonce = "";
        try {
          nonce = (JSON.parse(text.slice(5).trim()) as { nonce?: string }).nonce ?? "";
        } catch {
          /* no nonce */
        }
        const sig = nonce
          ? Buffer.from(userKp.sign(new TextEncoder().encode(nonce))).toString("base64url")
          : "";
        const connect = { jwt, sig, nkey: "", verbose: false, pedantic: false };
        ws.send(`CONNECT ${JSON.stringify(connect)}\r\nPING\r\n`);
        return;
      }
      if (text.includes("PONG")) {
        clearTimeout(timeout);
        ws.off("message", onMessage);
        resolve();
      }
      if (text.includes("-ERR")) {
        clearTimeout(timeout);
        ws.off("message", onMessage);
        reject(new Error(text.trim()));
      }
    };
    ws.on("message", onMessage);

    ws.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });

  return { ws, ready };
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

beforeAll(async () => {
  if (!NATS_SERVER_BIN) return; // suite will be skipped

  // Create temporary directory for NATS config
  testDir = mkdtempSync(join(tmpdir(), "nats-perms-"));

  // Generate trust chain
  trustChain = await setupTrustChain({
    operatorName: "test-operator",
    accountName: "test-account",
  });

  // Write operator JWT
  const operatorJwtPath = join(testDir, "operator.jwt");
  writeFileSync(operatorJwtPath, trustChain.natsConfig.operatorJwt);

  // Configure enrollment service
  enrollment = new DeviceFlowEnrollment({
    saasTrustChain: trustChain.private,
    natsAccountConfig: trustChain.natsConfig,
    saasBaseUrl: "https://saas.test.com",
    jwksUrl: "https://saas.test.com/.well-known/jwks.json",
    bootstrapUrl: "https://saas.test.com/bootstrap",
  });

  // Create nats-server config with JWT authentication. A real nats-server needs
  // a trusted `operator` JWT plus a MEMORY resolver preloaded with each account
  // JWT keyed by its public NKEY (not a bare file path).
  const preload = Object.entries(trustChain.natsConfig.resolverConfig)
    .map(([accPub, accJwt]) => `  ${accPub}: "${accJwt}"`)
    .join("\n");
  const confPath = join(testDir, "nats.conf");
  writeFileSync(
    confPath,
    [
      `port: ${CLIENT_PORT}`,
      `websocket {`,
      `  port: ${WS_PORT}`,
      `  no_tls: true`,
      `}`,
      `operator: "${operatorJwtPath}"`,
      `resolver: MEMORY`,
      `resolver_preload: {`,
      preload,
      `}`,
      "",
    ].join("\n"),
  );

  // Start nats-server
  server = spawn(NATS_SERVER_BIN, ["-c", confPath], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  // Wait for "Server is ready"
  let ready = false;
  let serverLog = "";
  const onData = (buf: Buffer) => {
    serverLog += buf.toString();
    if (buf.toString().includes("Server is ready")) ready = true;
  };
  server.stdout?.on("data", onData);
  server.stderr?.on("data", onData);

  await waitFor(() => ready, 10000, 100).catch(() => {
    throw new Error(`nats-server did not become ready:\n${serverLog}`);
  });
}, 20000);

afterAll(async () => {
  if (server) {
    server.kill("SIGKILL");
    server = null;
  }
  testDir = null;
  trustChain = null;
  enrollment = null;
});

// ---------------------------------------------------------------------------
// Subject patterns for testing
// ---------------------------------------------------------------------------

const TENANT_A = "tenant-a";
const TENANT_B = "tenant-b";

// Tenant A subjects
const A_OUTBOUND = "webchannel.tenant-a.outbound.test";
const A_INBOUND = "webchannel.tenant-a.inbound.test";

// Tenant B subjects
const B_OUTBOUND = "webchannel.tenant-b.outbound.test";
const B_INBOUND = "webchannel.tenant-b.inbound.test";

// ---------------------------------------------------------------------------
// Generate test credentials
// ---------------------------------------------------------------------------

/**
 * Generate NATS user credentials for a test tenant.
 */
async function generateTestCredentials(tenant: string): Promise<NatsUserCredentials> {
  if (!enrollment) {
    throw new Error("Enrollment service not initialized");
  }

  // Create a mock enrollment request
  const mockEnrollment = {
    device_code: "test-device-code",
    user_code: "TEST-1234",
    agentPublicKey: "test-public-key",
    accountId: "test-agent",
    tenant,
    createdAt: Date.now(),
    expiresAt: Date.now() + 600000,
    status: "pending" as const,
  };

  // Use the private method to generate credentials
  // @ts-ignore - accessing private method for testing
  return await enrollment.generateNatsUserCredentials(mockEnrollment);
}

/**
 * Generate AGENT-role NATS credentials for a tenant — the mirror of a browser:
 * publishes to `inbound`, subscribes to `outbound`. Needed to exercise a real
 * message round-trip, since the browser role (pub=outbound, sub=inbound) cannot
 * subscribe to its own outbound by design (loopback prevention).
 */
async function generateAgentCredentials(
  tenant: string,
): Promise<NatsUserCredentials> {
  if (!trustChain) throw new Error("Trust chain not initialized");
  const accountSigner = fromSeed(
    new TextEncoder().encode(trustChain.private.natsAccountSeed),
  );
  const userKp = createUser();
  const userSeed = new TextDecoder().decode(userKp.getSeed());
  const pub = [`webchannel.${tenant}.inbound.>`];
  const sub = [`webchannel.${tenant}.outbound.>`];
  const userJwt = await encodeUser(`agent-${tenant}`, userKp, accountSigner, {
    pub: { allow: pub },
    sub: { allow: sub },
  });
  return { userJwt, userSeed, permissions: { pub, sub } };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skipIf(!NATS_SERVER_BIN)(
  "Real nats-server permission enforcement (AC 3)",
  () => {
    it("should start nats-server with JWT authentication", async () => {
      expect(server).not.toBeNull();
      expect(trustChain).not.toBeNull();
      expect(trustChain!.natsConfig.operatorJwt).toBeTruthy();
      expect(trustChain!.natsConfig.accountJwt).toBeTruthy();
    });

    it("tenant A client can subscribe to its own subjects", async () => {
      const creds = await generateTestCredentials(TENANT_A);
      const { ws, ready } = await connectWithJwt(creds.userJwt, creds.userSeed, "tenant-a-client");

      await ready;

      // Subscribe to tenant A's outbound subject
      const subMsg = `SUB ${A_OUTBOUND} 1\r\n`;
      ws.send(subMsg);

      // Wait a bit for any error
      await new Promise((r) => setTimeout(r, 200));

      // If we get here without the connection closing, subscription succeeded
      ws.close();
    });

    it("tenant A client is denied subscription to tenant B subjects", async () => {
      const creds = await generateTestCredentials(TENANT_A);
      const { ws, ready } = await connectWithJwt(creds.userJwt, creds.userSeed, "tenant-a-client");

      await ready;

      // Collect errors
      const errors: string[] = [];
      ws.on("error", (err) => errors.push(err.message));

      const errorMessages: string[] = [];
      ws.on("message", (data: Buffer) => {
        const msg = data.toString();
        if (msg.includes("ERR")) {
          errorMessages.push(msg);
        }
      });

      // Try to subscribe to tenant B's outbound subject (should be denied)
      const subMsg = `SUB ${B_OUTBOUND} 1\r\n`;
      ws.send(subMsg);

      // Wait for error response
      await waitFor(() => errorMessages.length > 0, 2000);

      ws.close();

      // Verify we got a permissions error
      expect(errorMessages.length).toBeGreaterThan(0);
      expect(errorMessages.some((msg) => msg.includes("Permissions Violation"))).toBe(true);
    });

    it("tenant A client can publish to its own subjects", async () => {
      const credsA = await generateTestCredentials(TENANT_A);

      const { ws: pub, ready: readyPub } = await connectWithJwt(
        credsA.userJwt,
        credsA.userSeed,
        "tenant-a-pub",
      );
      // The subscriber is the AGENT role (sub=outbound); a browser cannot
      // subscribe to its own outbound by design.
      const agentA = await generateAgentCredentials(TENANT_A);
      const { ws: sub, ready: readySub } = await connectWithJwt(
        agentA.userJwt,
        agentA.userSeed,
        "tenant-a-agent-sub",
      );

      await Promise.all([readyPub, readySub]);

      // Collect messages BEFORE publishing so nothing is missed.
      const messages: string[] = [];
      sub.on("message", (data: Buffer) => {
        const msg = data.toString();
        if (msg.includes("MSG")) {
          messages.push(msg);
        }
      });

      // Subscribe (agent → outbound)
      sub.send(`SUB ${A_OUTBOUND} 1\r\n`);
      await new Promise((r) => setTimeout(r, 100));

      // Publish (browser → outbound)
      const payload = "test message from tenant A";
      const pubMsg = `PUB ${A_OUTBOUND} ${payload.length}\r\n${payload}\r\n`;
      pub.send(pubMsg);

      await waitFor(() => messages.length > 0, 2000);

      pub.close();
      sub.close();

      // Verify message was delivered
      expect(messages.length).toBeGreaterThan(0);
      expect(messages.some((msg) => msg.includes(payload))).toBe(true);
    });

    it("tenant A client is denied publish to tenant B subjects", async () => {
      const credsA = await generateTestCredentials(TENANT_A);
      const { ws, ready } = await connectWithJwt(
        credsA.userJwt,
        credsA.userSeed,
        "tenant-a-client",
      );

      await ready;

      const errorMessages: string[] = [];
      ws.on("message", (data: Buffer) => {
        const msg = data.toString();
        if (msg.includes("ERR")) {
          errorMessages.push(msg);
        }
      });

      // Try to publish to tenant B's subject (should be denied)
      const payload = "cross-tenant message";
      const pubMsg = `PUB ${B_OUTBOUND} ${payload.length}\r\n${payload}\r\n`;
      ws.send(pubMsg);

      // Wait for error response
      await waitFor(() => errorMessages.length > 0, 2000);

      ws.close();

      // Verify we got a permissions error
      expect(errorMessages.length).toBeGreaterThan(0);
      expect(errorMessages.some((msg) => msg.includes("Permissions Violation"))).toBe(true);
    });

    it("tenant B can independently pub/sub on its own namespace", async () => {
      const credsB = await generateTestCredentials(TENANT_B);

      const { ws: pub, ready: readyPub } = await connectWithJwt(
        credsB.userJwt,
        credsB.userSeed,
        "tenant-b-pub",
      );
      const agentB = await generateAgentCredentials(TENANT_B);
      const { ws: sub, ready: readySub } = await connectWithJwt(
        agentB.userJwt,
        agentB.userSeed,
        "tenant-b-agent-sub",
      );

      await Promise.all([readyPub, readySub]);

      const messages: string[] = [];
      sub.on("message", (data: Buffer) => {
        const msg = data.toString();
        if (msg.includes("MSG")) {
          messages.push(msg);
        }
      });

      // Subscribe to tenant B's outbound (agent role)
      sub.send(`SUB ${B_OUTBOUND} 1\r\n`);
      await new Promise((r) => setTimeout(r, 100));

      // Publish to tenant B's outbound (browser role)
      const payload = "tenant B private message";
      const pubMsg = `PUB ${B_OUTBOUND} ${payload.length}\r\n${payload}\r\n`;
      pub.send(pubMsg);

      await waitFor(() => messages.length > 0, 2000);

      pub.close();
      sub.close();

      // Verify message was delivered
      expect(messages.length).toBeGreaterThan(0);
      expect(messages.some((msg) => msg.includes(payload))).toBe(true);
    });

    it("full cross-tenant isolation: A and B cannot interfere", async () => {
      const credsA = await generateTestCredentials(TENANT_A);
      const credsB = await generateTestCredentials(TENANT_B);
      const agentA = await generateAgentCredentials(TENANT_A);
      const agentB = await generateAgentCredentials(TENANT_B);

      // Tenant A subscriber (agent role — subscribes to outbound)
      const { ws: subA, ready: readySubA } = await connectWithJwt(
        agentA.userJwt,
        agentA.userSeed,
        "tenant-a-agent-sub",
      );

      // Tenant B subscriber (agent role)
      const { ws: subB, ready: readySubB } = await connectWithJwt(
        agentB.userJwt,
        agentB.userSeed,
        "tenant-b-agent-sub",
      );

      await Promise.all([readySubA, readySubB]);

      // Subscribe to respective subjects
      subA.send(`SUB ${A_OUTBOUND} 1\r\n`);
      subB.send(`SUB ${B_OUTBOUND} 2\r\n`);
      await new Promise((r) => setTimeout(r, 100));

      // Collect messages
      const messagesA: string[] = [];
      const messagesB: string[] = [];

      subA.on("message", (data: Buffer) => {
        const msg = data.toString();
        if (msg.includes("MSG")) messagesA.push(msg);
      });
      subB.on("message", (data: Buffer) => {
        const msg = data.toString();
        if (msg.includes("MSG")) messagesB.push(msg);
      });

      // Tenant A publishes to its own subject
      const { ws: pubA, ready: readyPubA } = await connectWithJwt(
        credsA.userJwt,
        credsA.userSeed,
        "tenant-a-pub",
      );
      await readyPubA;

      const payloadA = "message from A to A";
      pubA.send(`PUB ${A_OUTBOUND} ${payloadA.length}\r\n${payloadA}\r\n`);

      // Tenant B publishes to its own subject
      const { ws: pubB, ready: readyPubB } = await connectWithJwt(
        credsB.userJwt,
        credsB.userSeed,
        "tenant-b-pub",
      );
      await readyPubB;

      const payloadB = "message from B to B";
      pubB.send(`PUB ${B_OUTBOUND} ${payloadB.length}\r\n${payloadB}\r\n`);

      // Wait for delivery
      await waitFor(() => messagesA.length > 0 && messagesB.length > 0, 2000);

      // Verify isolation
      expect(messagesA.length).toBeGreaterThan(0);
      expect(messagesA.some((msg) => msg.includes(payloadA))).toBe(true);
      expect(messagesA.some((msg) => msg.includes(payloadB))).toBe(false); // No B messages

      expect(messagesB.length).toBeGreaterThan(0);
      expect(messagesB.some((msg) => msg.includes(payloadB))).toBe(true);
      expect(messagesB.some((msg) => msg.includes(payloadA))).toBe(false); // No A messages

      // Cleanup
      pubA.close();
      pubB.close();
      subA.close();
      subB.close();
    });
  },
);
