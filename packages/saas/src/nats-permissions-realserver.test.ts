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
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import {
  createUser,
  fromPublic,
  fromSeed,
} from "@nats-io/nkeys";
import {
  decode,
  encodeAccount,
  encodeUser,
  parseCreds,
  type Account,
} from "@nats-io/jwt";

import { setupTrustChain } from "./setup-trust-chain.js";
import { addRevocation } from "./account-revocation.js";
import {
  prepareFullResolverNatsConfig,
  renderFullResolverNatsConfig,
} from "./nats-server-config.js";
import type { SetupTrustChainResult, NatsSelfContainedAccountConfig } from "./types.js";
import { DeviceFlowEnrollment } from "./device-flow-enrollment.js";
import { MemoryEnrollmentRepository } from "./enrollment-repository.js";
import type { NatsUserCredentials } from "./device-flow-types.js";
import { mintNatsUserCreds } from "./nats-user-creds.js";
import { makeNkeySigningCallback } from "../../plugin/src/nkey-sign.js";
import { NatsTransport } from "../../plugin/src/nats-transport.js";
import { dialRelayForPreflight } from "../../plugin/src/preflight.js";
import { resolveWebchannelAppStatePaths } from "../../../examples/webchannel-app/server/runtime-paths.js";

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

// PATH is searched too, not just the well-known absolute locations: CI installs
// the pinned binary under $RUNNER_TOOL_CACHE and exports it via $GITHUB_PATH
// (the publish lane has no passwordless sudo, so it cannot write /usr/local/bin).
// Without this, the binary is present and on PATH yet invisible here.
const NATS_SERVER_CANDIDATES = [
  "/opt/homebrew/bin/nats-server",
  "/usr/local/bin/nats-server",
  "/usr/bin/nats-server",
  ...(process.env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)
    .map((dir) => join(dir, "nats-server")),
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

// `-1` delegates allocation to the OS inside nats-server's bind, so independent
// test processes cannot race between a free-port probe and the real listener.
let server: ChildProcess | null = null;
let testDir: string | null = null;
let wsUrl = "";

/** Read a listener selected atomically by nats-server from its ports file. */
function natsListenerPort(
  portsDir: string,
  listener: "nats" | "monitoring" | "websocket",
): number {
  const portsFile = readdirSync(portsDir).find((name) => name.endsWith(".ports"));
  if (!portsFile) {
    throw new Error(`nats-server wrote no .ports file in ${portsDir}`);
  }
  const ports = JSON.parse(readFileSync(join(portsDir, portsFile), "utf8")) as
    Partial<Record<typeof listener, string[]>>;
  const address = ports[listener]?.[0];
  const port = address ? Number(new URL(address).port) : Number.NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      `nats-server ports file has no valid ${listener} listener: ${JSON.stringify(ports)}`,
    );
  }
  return port;
}

/**
 * Readiness is not a publication barrier for `--ports_file_dir`: nats-server
 * may log "Server is ready" just before the file appears. Treat both signals as
 * one bounded startup condition, and also retry a file observed mid-write.
 */
async function waitForNatsListenerPort(
  portsDir: string,
  listener: "nats" | "monitoring" | "websocket",
  serverReady: () => boolean,
  timeoutMs: number,
  stepMs: number,
): Promise<number> {
  let port: number | null = null;
  let lastPortsError = "server readiness not observed";
  await waitFor(
    () => {
      if (!serverReady()) return false;
      try {
        port = natsListenerPort(portsDir, listener);
        return true;
      } catch (error) {
        lastPortsError = error instanceof Error ? error.message : String(error);
        return false;
      }
    },
    timeoutMs,
    stepMs,
  ).catch(() => {
    throw new Error(
      `nats-server did not publish a valid ${listener} listener in ${portsDir}: ${lastPortsError}`,
    );
  });
  if (port === null) {
    throw new Error(`nats-server listener wait completed without ${listener}`);
  }
  return port;
}

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
  url = wsUrl,
): Promise<{ ws: WebSocket; ready: Promise<void> }> {
  const ws = new WebSocket(url);
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

/** Send one NATS request over the already-tested raw WebSocket protocol. */
async function requestWithJwt(
  jwt: string,
  seed: string,
  subject: string,
  payload: string,
  url = wsUrl,
): Promise<string> {
  const { ws, ready } = await connectWithJwt(jwt, seed, "system-request", url);
  await ready;

  const inbox = `_INBOX.claims_update.${randomUUID().replaceAll("-", "")}`;
  const response = new Promise<string>((resolve, reject) => {
    let protocol = "";
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("claims request timed out without a reply"));
    }, 4000);

    const cleanup = () => {
      clearTimeout(timeout);
      ws.off("message", onMessage);
    };
    const onMessage = (data: Buffer) => {
      protocol += data.toString();
      if (protocol.includes("-ERR")) {
        cleanup();
        reject(new Error(protocol.trim()));
        return;
      }

      const marker = `MSG ${inbox} 1 `;
      const headerStart = protocol.indexOf(marker);
      if (headerStart < 0) return;
      const headerEnd = protocol.indexOf("\r\n", headerStart);
      if (headerEnd < 0) return;
      const size = Number(protocol.slice(headerStart + marker.length, headerEnd));
      if (!Number.isInteger(size) || size < 0) {
        cleanup();
        reject(new Error("claims reply has an invalid NATS MSG size"));
        return;
      }
      const bodyStart = headerEnd + 2;
      if (protocol.length < bodyStart + size + 2) return;
      cleanup();
      resolve(protocol.slice(bodyStart, bodyStart + size));
    };
    ws.on("message", onMessage);
  });

  ws.send(`SUB ${inbox} 1\r\n`);
  ws.send(
    `PUB ${subject} ${inbox} ${Buffer.byteLength(payload)}\r\n${payload}\r\nPING\r\n`,
  );
  try {
    return await response;
  } finally {
    ws.close();
  }
}

type RestartProbeServer = {
  proc: ChildProcess;
  wsUrl: string;
  resolverDir: string;
  config: string;
};

async function startRestartProbeServer(options: {
  configDir: string;
  operatorJwtPath: string;
  systemAccountPublicKey: string;
  resolverConfig: Record<string, string>;
  bootName: string;
}): Promise<RestartProbeServer> {
  const portsDir = join(options.configDir, `ports-${options.bootName}`);
  mkdirSync(portsDir, { recursive: true });
  const prepared = prepareFullResolverNatsConfig({
    configDir: options.configDir,
    operatorJwtPath: options.operatorJwtPath,
    systemAccountPublicKey: options.systemAccountPublicKey,
    resolverConfig: options.resolverConfig,
    tcpPort: -1,
    websocketPort: -1,
    host: "127.0.0.1",
  });
  const confPath = join(options.configDir, `nats-${options.bootName}.conf`);
  writeFileSync(confPath, prepared.config);

  const proc = spawn(
    NATS_SERVER_BIN!,
    ["-c", confPath, "--ports_file_dir", portsDir],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let ready = false;
  let serverLog = "";
  const onData = (buf: Buffer) => {
    serverLog += buf.toString();
    if (buf.toString().includes("Server is ready")) ready = true;
  };
  proc.stdout?.on("data", onData);
  proc.stderr?.on("data", onData);

  try {
    const websocketPort = await waitForNatsListenerPort(
      portsDir,
      "websocket",
      () => ready,
      10000,
      100,
    );
    return {
      proc,
      wsUrl: `ws://127.0.0.1:${websocketPort}`,
      resolverDir: prepared.resolverDir,
      config: prepared.config,
    };
  } catch (error) {
    proc.kill("SIGKILL");
    throw new Error(
      `restart-probe nats-server did not become ready:\n${serverLog}\n${String(error)}`,
    );
  }
}

async function stopNatsServer(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => proc.once("exit", () => resolve()));
  proc.kill("SIGTERM");
  const stopped = await Promise.race([
    exited.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 5000)),
  ]);
  if (!stopped) {
    proc.kill("SIGKILL");
    await exited;
  }
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
    returnOperatorSeed: true,
  });

  // Write operator JWT
  const operatorJwtPath = join(testDir, "operator.jwt");
  writeFileSync(operatorJwtPath, trustChain.natsConfig.operatorJwt);
  const systemCredentialsPath = join(testDir, "system-account.creds");
  if (!trustChain.private.systemAccountCredentials) {
    throw new Error("self-contained trust chain is missing its system-account credential");
  }
  writeFileSync(systemCredentialsPath, trustChain.private.systemAccountCredentials, {
    mode: 0o600,
  });
  chmodSync(systemCredentialsPath, 0o600);
  if ((statSync(systemCredentialsPath).mode & 0o777) !== 0o600) {
    throw new Error("system-account credential file is not owner-readable only");
  }

  // Configure enrollment service
  enrollment = new DeviceFlowEnrollment({
    repository: new MemoryEnrollmentRepository(),
    saasTrustChain: trustChain.private,
    natsAccountConfig: trustChain.natsConfig,
    saasBaseUrl: "https://saas.test.com",
    jwksUrl: "https://saas.test.com/.well-known/jwks.json",
    bootstrapUrl: "https://saas.test.com/bootstrap",
    natsUrl: "wss://nats.test.com",
  });

  // Create nats-server config with JWT authentication and a writable full/Dir
  // resolver. The directory is unique to this run, so no prior JWT can seed a
  // false-positive test result.
  const resolverDir = mkdtempSync(join(testDir, "resolver-jwt-"));
  const confPath = join(testDir, "nats.conf");
  writeFileSync(
    confPath,
    renderFullResolverNatsConfig({
      operatorJwtPath,
      resolverDir,
      systemAccountPublicKey: trustChain.natsConfig.systemAccountPublicKey,
      resolverConfig: trustChain.natsConfig.resolverConfig,
      tcpPort: -1,
      websocketPort: -1,
      host: "127.0.0.1",
    }),
  );

  // Start nats-server
  server = spawn(NATS_SERVER_BIN, [
    "-c",
    confPath,
    "--ports_file_dir",
    testDir,
  ], {
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

  let websocketPort: number;
  try {
    websocketPort = await waitForNatsListenerPort(
      testDir,
      "websocket",
      () => ready,
      10000,
      100,
    );
  } catch (error) {
    throw new Error(
      `nats-server did not become ready with a published listener:\n${serverLog}\n${String(error)}`,
    );
  }
  wsUrl = `ws://127.0.0.1:${websocketPort}`;
}, 20000);

afterAll(async () => {
  if (server) {
    server.kill("SIGKILL");
    server = null;
  }
  if (testDir) rmSync(testDir, { recursive: true, force: true });
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
  return { userJwt, userSeed, userPubkey: userKp.getPublicKey(), permissions: { pub, sub } };
}

/**
 * Agent-like credentials whose ordinary inbound subscription is allowed but
 * whose mandatory register-admission wildcard is intentionally absent.
 */
async function generateRegisterDeniedCredentials(
  tenant: string,
  accountId: string,
): Promise<NatsUserCredentials> {
  if (!trustChain) throw new Error("Trust chain not initialized");
  const accountSigner = fromSeed(
    new TextEncoder().encode(trustChain.private.natsAccountSeed),
  );
  const userKp = createUser();
  const userSeed = new TextDecoder().decode(userKp.getSeed());
  const pub = [`webchannel.${tenant}.${accountId}.>`];
  const sub = [`webchannel.${tenant}.${accountId}.*.in`];
  const userJwt = await encodeUser(
    `register-denied-${tenant}-${accountId}`,
    userKp,
    accountSigner,
    {
      pub: { allow: pub },
      sub: { allow: sub },
    },
  );
  return {
    userJwt,
    userSeed,
    userPubkey: userKp.getPublicKey(),
    permissions: { pub, sub },
  };
}

/** Credentials that would fool the historical synthetic readiness probes. */
async function generateSyntheticProbeOnlyCredentials(
  tenant: string,
  accountId: string,
): Promise<NatsUserCredentials> {
  if (!trustChain) throw new Error("Trust chain not initialized");
  const accountSigner = fromSeed(
    new TextEncoder().encode(trustChain.private.natsAccountSeed),
  );
  const userKp = createUser();
  const userSeed = new TextDecoder().decode(userKp.getSeed());
  const pub = [`webchannel.${tenant}.${accountId}.>`];
  const sub = [
    `webchannel.${tenant}.${accountId}._preflight`,
    `webchannel.${tenant}.${accountId}._doctor`,
  ];
  const userJwt = await encodeUser(
    `synthetic-probe-only-${tenant}-${accountId}`,
    userKp,
    accountSigner,
    {
      pub: { allow: pub },
      sub: { allow: sub },
    },
  );
  return {
    userJwt,
    userSeed,
    userPubkey: userKp.getPublicKey(),
    permissions: { pub, sub },
  };
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

    it("updates and reads back two sequential revocation floors with the generated credential", async () => {
      const chain = trustChain!;
      const operatorSeed = chain.private.operatorSeed;
      const systemCredentials = chain.private.systemAccountCredentials;
      expect(operatorSeed).toMatch(/^SO/);
      expect(systemCredentials).toBeTruthy();
      const credentials = await parseCreds(new TextEncoder().encode(systemCredentials!));
      const lookupSubject =
        `$SYS.REQ.ACCOUNT.${chain.natsConfig.accountPublicKey}.CLAIMS.LOOKUP`;
      const firstUser = createUser().getPublicKey();
      const secondUser = createUser().getPublicKey();
      const firstFloor = 1_700_000_001;
      const secondFloor = 1_700_000_002;

      // Load the resolver's accepted claim before every mutation. Starting a
      // later incident from natsConfig.accountJwt would erase earlier floors.
      let acceptedJwt = await requestWithJwt(
        credentials.jwt,
        credentials.key,
        lookupSubject,
        "",
      );
      expect(decode(acceptedJwt).sub).toBe(chain.natsConfig.accountPublicKey);

      for (const [userPubkey, floor] of [
        [firstUser, firstFloor],
        [secondUser, secondFloor],
      ] as const) {
        while (Math.floor(Date.now() / 1000) <= decode(acceptedJwt).iat) {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        const candidate = await addRevocation(
          acceptedJwt,
          operatorSeed!,
          userPubkey,
          floor,
        );
        const rawReply = await requestWithJwt(
          credentials.jwt,
          credentials.key,
          "$SYS.REQ.CLAIMS.UPDATE",
          candidate,
        );
        const reply = JSON.parse(rawReply) as {
          data?: { account?: string; code?: number; message?: string };
        };
        expect(reply.data).toMatchObject({
          account: chain.natsConfig.accountPublicKey,
          code: 200,
          message: expect.stringMatching(/updated/i),
        });
        acceptedJwt = await requestWithJwt(
          credentials.jwt,
          credentials.key,
          lookupSubject,
          "",
        );
        expect(acceptedJwt).toBe(candidate);
      }

      const acceptedRevocations = decode<Account>(acceptedJwt).nats.revocations;
      expect(acceptedRevocations?.[firstUser]).toBe(firstFloor);
      expect(acceptedRevocations?.[secondUser]).toBe(secondFloor);
    });

    it("preserves an accepted account claim across config regeneration and restart", async () => {
      // Mirror two full example-app boots: a persisted trust chain with no
      // explicit NATS_CONFIG_OUT must resolve to the same state root each time.
      const explicitTrustChainPath = join(testDir!, "example-trust-chain.json");
      const firstAppPaths = resolveWebchannelAppStatePaths(
        { TRUST_CHAIN_PATH: explicitTrustChainPath },
        testDir!,
      );
      expect(firstAppPaths.natsConfigDir).toBe(`${explicitTrustChainPath}.nats`);
      const callerOwnedConfigDir = join(testDir!, "caller-owned-nats-config");
      expect(
        resolveWebchannelAppStatePaths(
          {
            TRUST_CHAIN_PATH: explicitTrustChainPath,
            NATS_CONFIG_OUT: callerOwnedConfigDir,
          },
          testDir!,
        ).natsConfigDir,
      ).toBe(callerOwnedConfigDir);
      const configDir = firstAppPaths.natsConfigDir;
      mkdirSync(configDir, { recursive: true });

      const ephemeralFirst = resolveWebchannelAppStatePaths({}, testDir!);
      const ephemeralSecond = resolveWebchannelAppStatePaths({}, testDir!);
      expect(ephemeralFirst.ephemeralRoot).not.toBe(ephemeralSecond.ephemeralRoot);
      expect(statSync(ephemeralFirst.ephemeralRoot!).mode & 0o777).toBe(0o700);
      expect(statSync(ephemeralSecond.ephemeralRoot!).mode & 0o777).toBe(0o700);

      // Exercise the actual generated credential, including its exact-account
      // lookup permission. No broader test-only system user is minted here.
      const restartChain = await setupTrustChain({
        operatorName: "restart-probe-operator",
        accountName: "restart-probe-account",
        returnOperatorSeed: true,
      });
      const accountPublicKey = restartChain.natsConfig.accountPublicKey;
      const systemAccountPublicKey =
        restartChain.natsConfig.systemAccountPublicKey;
      const operatorJwt = restartChain.natsConfig.operatorJwt;
      const originalAccountJwt = restartChain.natsConfig.accountJwt;
      const systemAccountJwt =
        restartChain.natsConfig.resolverConfig[systemAccountPublicKey] as string;
      const lookupSubject =
        `$SYS.REQ.ACCOUNT.${accountPublicKey}.CLAIMS.LOOKUP`;
      const generatedSystemCredentials = await parseCreds(
        new TextEncoder().encode(
          restartChain.private.systemAccountCredentials as string,
        ),
      );
      const systemUserJwt = generatedSystemCredentials.jwt;
      const systemUserSeed = generatedSystemCredentials.key;
      const operatorKp = fromSeed(
        new TextEncoder().encode(restartChain.private.operatorSeed as string),
      );
      const accountLimits = decode<Account>(originalAccountJwt).nats.limits;
      const operatorJwtPath = join(configDir, "operator.jwt");
      writeFileSync(operatorJwtPath, operatorJwt);
      const resolverConfig = {
        [accountPublicKey]: originalAccountJwt,
        [systemAccountPublicKey]: systemAccountJwt,
      };

      let firstBoot: RestartProbeServer | null = null;
      let secondBoot: RestartProbeServer | null = null;
      try {
        firstBoot = await startRestartProbeServer({
          configDir,
          operatorJwtPath,
          systemAccountPublicKey,
          resolverConfig,
          bootName: "first",
        });
        expect(statSync(firstBoot.resolverDir).mode & 0o777).toBe(0o700);

        const original = decode(originalAccountJwt);
        while (Math.floor(Date.now() / 1000) <= original.iat) {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        const updatedAccountJwt = await encodeAccount(
          "restart-probe-account",
          fromPublic(accountPublicKey),
          {
            description: "restart persistence probe",
            limits: accountLimits,
          },
          { signer: operatorKp },
        );
        expect(updatedAccountJwt).not.toBe(originalAccountJwt);

        const rawUpdateReply = await requestWithJwt(
          systemUserJwt,
          systemUserSeed,
          "$SYS.REQ.CLAIMS.UPDATE",
          updatedAccountJwt,
          firstBoot.wsUrl,
        );
        const updateReply = JSON.parse(rawUpdateReply) as {
          data?: { account?: string; code?: number; message?: string };
        };
        expect(updateReply.data).toMatchObject({
          account: accountPublicKey,
          code: 200,
          message: expect.stringMatching(/updated/i),
        });

        const persistedAccountJwtPath = join(
          firstBoot.resolverDir,
          `${accountPublicKey}.jwt`,
        );
        await waitFor(
          () =>
            existsSync(persistedAccountJwtPath) &&
            readFileSync(persistedAccountJwtPath, "utf8").trim() === updatedAccountJwt,
          5000,
          50,
        );
        await stopNatsServer(firstBoot.proc);

        // Regenerate the config exactly as a caller restart does. The helper
        // must reuse the resolver directory and omit stale bootstrap preloads.
        // Simulate an interrupted first boot by removing only the system-account
        // file: missing accounts should still be seeded without replaying the
        // older tenant claim that remains present.
        rmSync(join(firstBoot.resolverDir, `${systemAccountPublicKey}.jwt`));
        const secondAppPaths = resolveWebchannelAppStatePaths(
          { TRUST_CHAIN_PATH: explicitTrustChainPath },
          testDir!,
        );
        expect(secondAppPaths.natsConfigDir).toBe(firstAppPaths.natsConfigDir);
        secondBoot = await startRestartProbeServer({
          configDir: secondAppPaths.natsConfigDir,
          operatorJwtPath,
          systemAccountPublicKey,
          resolverConfig,
          bootName: "second",
        });
        expect(secondBoot.resolverDir).toBe(firstBoot.resolverDir);
        expect(secondBoot.config).toContain(systemAccountJwt);
        expect(secondBoot.config).not.toContain(originalAccountJwt);
        expect(secondBoot.config).not.toContain(updatedAccountJwt);

        const readBackJwt = await requestWithJwt(
          systemUserJwt,
          systemUserSeed,
          lookupSubject,
          "",
          secondBoot.wsUrl,
        );
        expect(readBackJwt).toBe(updatedAccountJwt);
        expect(decode(readBackJwt).jti).toBe(decode(updatedAccountJwt).jti);
      } finally {
        if (secondBoot) await stopNatsServer(secondBoot.proc);
        if (firstBoot) await stopNatsServer(firstBoot.proc);
      }
    }, 30000);

    it("a connection WITHOUT NATS credentials is refused by the JWT-auth server", async () => {
      // authN invariant (previously covered by the deleted e2e/enrolled-jwt-roundtrip.test.ts):
      // the operator + full-resolver server grants NO anonymous access, so a CONNECT carrying
      // no JWT and no signature must be rejected — never flipped to connected.
      const ws = new WebSocket(wsUrl);
      const outcome = await new Promise<"refused" | "connected">((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("no server response")), 4000);
        const settle = (v: "refused" | "connected") => {
          clearTimeout(timeout);
          resolve(v);
        };
        ws.on("message", (data: Buffer) => {
          const text = data.toString();
          if (text.startsWith("INFO ")) {
            // Reply with an empty CONNECT — no jwt, no sig (an unauthenticated client).
            ws.send(`CONNECT ${JSON.stringify({ verbose: false, pedantic: false })}\r\nPING\r\n`);
            return;
          }
          if (text.includes("-ERR")) settle("refused");
          else if (text.includes("PONG")) settle("connected");
        });
        // A hard socket close before any PONG is also a refusal (server drops bad auth).
        ws.on("close", () => settle("refused"));
        ws.on("error", () => settle("refused"));
      });
      ws.close();
      expect(outcome).toBe("refused");
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

    it("production SUB/PING barrier rejects a denied register subscription before serving publication", async () => {
      const accountId = "test-agent";
      const creds = await generateRegisterDeniedCredentials(TENANT_A, accountId);
      const transport = new NatsTransport({
        url: wsUrl,
        jwtCredential: creds.userJwt,
        nkeySigningCallback: makeNkeySigningCallback(creds.userSeed),
        clientName: "register-denied-readiness",
      });
      const errors: Error[] = [];
      transport.on("error", (error) => errors.push(error));

      await transport.connect();
      let servingPublished = false;
      transport.subscribe(
        `webchannel.${TENANT_A}.${accountId}.*.register`,
      );

      await expect(
        transport.flush().then(() => {
          // Mirrors the production publication fence: this callback must remain
          // unreachable when the real server rejects the required SUB.
          servingPublished = true;
        }),
      ).rejects.toMatchObject({ code: "authorization-violation" });

      expect(servingPublished).toBe(false);
      expect(errors).toContainEqual(
        expect.objectContaining({ code: "authorization-violation" }),
      );
      await transport.closeGracefully();
    });

    it("the readiness helper rejects creds that allow only old synthetic probes", async () => {
      const accountId = "synthetic-only";
      const creds = await generateSyntheticProbeOnlyCredentials(
        TENANT_A,
        accountId,
      );

      await expect(
        dialRelayForPreflight({
          url: wsUrl,
          userJwt: creds.userJwt,
          userSeed: creds.userSeed,
          subject: `webchannel.${TENANT_A}.${accountId}._preflight`,
          timeoutMs: 2000,
        }),
      ).resolves.toEqual({ ok: true });

      await expect(
        dialRelayForPreflight({
          url: wsUrl,
          userJwt: creds.userJwt,
          userSeed: creds.userSeed,
          subject: `webchannel.${TENANT_A}.${accountId}._doctor`,
          timeoutMs: 2000,
        }),
      ).resolves.toEqual({ ok: true });

      await expect(
        dialRelayForPreflight({
          url: wsUrl,
          userJwt: creds.userJwt,
          userSeed: creds.userSeed,
          subject: `webchannel.${TENANT_A}.${accountId}.*.register`,
          timeoutMs: 2000,
        }),
      ).resolves.toEqual({ error: "relay subscription rejected" });
    });

    it("production enrollment agent credentials pass the register wildcard probe", async () => {
      const creds = await generateTestCredentials(TENANT_A);
      await expect(
        dialRelayForPreflight({
          url: wsUrl,
          userJwt: creds.userJwt,
          userSeed: creds.userSeed,
          subject: `webchannel.${TENANT_A}.test-agent.*.register`,
          timeoutMs: 2000,
        }),
      ).resolves.toEqual({ ok: true });
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

// ---------------------------------------------------------------------------
// Per-peer browser scoping + observer role (register-reply forgery defense).
//
// Browser creds are scoped to `webchannel.{tenant}.*.{peerId}.>` so a browser
// can only touch its OWN peer subtree — it cannot publish a forged register
// reply to (or subscribe) another peerId's reginbox/register. Observer creds are
// sub-only (tenant-wide read, no publish). Agent creds stay tenant-wide.
// ---------------------------------------------------------------------------

const T = "tenant-a";
const ACCT = "acct-x";
const SELF = "peer-self";
const OTHER = "peer-other";

/** Connect, drive one command, and report whether the server rejected it. */
async function probe(
  creds: { userJwt: string; userSeed: string },
  command: string,
): Promise<{ denied: boolean; errors: string[] }> {
  const { ws, ready } = await connectWithJwt(creds.userJwt, creds.userSeed, "probe");
  await ready;
  const errors: string[] = [];
  ws.on("message", (data: Buffer) => {
    const msg = data.toString();
    if (msg.includes("-ERR")) errors.push(msg.trim());
  });
  ws.send(command);
  // Round-trip a PING so the server has processed the command by the time PONG
  // returns (and any Permissions Violation has been delivered).
  ws.send("PING\r\n");
  await new Promise((r) => setTimeout(r, 300));
  ws.close();
  return { denied: errors.some((e) => /Permissions Violation/i.test(e)), errors };
}

describe.skipIf(!NATS_SERVER_BIN)("Per-peer browser + observer scoping", () => {
  async function browserCreds(peerId: string) {
    return mintNatsUserCreds({
      accountSeed: trustChain!.private.natsAccountSeed,
      tenant: T,
      role: "browser",
      peerId,
    });
  }

  it("browser P can publish to its OWN register subject", async () => {
    const creds = await browserCreds(SELF);
    const { denied } = await probe(creds, `PUB webchannel.${T}.${ACCT}.${SELF}.register 2\r\nhi\r\n`);
    expect(denied).toBe(false);
  });

  it("browser P can subscribe its OWN reginbox subtree", async () => {
    const creds = await browserCreds(SELF);
    const { denied } = await probe(creds, `SUB webchannel.${T}.${ACCT}.${SELF}.reginbox.> 1\r\n`);
    expect(denied).toBe(false);
  });

  it("browser P CANNOT publish a forged reply to another peer's register", async () => {
    const creds = await browserCreds(SELF);
    const { denied } = await probe(creds, `PUB webchannel.${T}.${ACCT}.${OTHER}.register 2\r\nhi\r\n`);
    expect(denied).toBe(true);
  });

  it("browser P CANNOT subscribe another peer's reginbox subtree", async () => {
    const creds = await browserCreds(SELF);
    const { denied } = await probe(creds, `SUB webchannel.${T}.${ACCT}.${OTHER}.reginbox.> 1\r\n`);
    expect(denied).toBe(true);
  });

  it("browser P scope spans all accounts of the tenant (multi-account grant)", async () => {
    // One peerId is the same across every account the user is granted, so the
    // `*` (accountId) wildcard must cover a SECOND account's own-peer subtree.
    const creds = await browserCreds(SELF);
    const { denied } = await probe(creds, `PUB webchannel.${T}.acct-y.${SELF}.register 2\r\nhi\r\n`);
    expect(denied).toBe(false);
  });

  it("observer can subscribe tenant-wide", async () => {
    const creds = await mintNatsUserCreds({
      accountSeed: trustChain!.private.natsAccountSeed,
      tenant: T,
      role: "observer",
    });
    const { denied } = await probe(creds, `SUB webchannel.${T}.> 1\r\n`);
    expect(denied).toBe(false);
  });

  it("observer CANNOT publish anything", async () => {
    const creds = await mintNatsUserCreds({
      accountSeed: trustChain!.private.natsAccountSeed,
      tenant: T,
      role: "observer",
    });
    const { denied } = await probe(creds, `PUB webchannel.${T}.${ACCT}.${SELF}.out 2\r\nhi\r\n`);
    expect(denied).toBe(true);
  });

  it("agent creds remain tenant-wide (pub + sub)", async () => {
    const creds = await mintNatsUserCreds({
      accountSeed: trustChain!.private.natsAccountSeed,
      tenant: T,
      role: "agent",
    });
    const pub = await probe(creds, `PUB webchannel.${T}.${ACCT}.${OTHER}.out 2\r\nhi\r\n`);
    expect(pub.denied).toBe(false);
    const sub = await probe(creds, `SUB webchannel.${T}.> 1\r\n`);
    expect(sub.denied).toBe(false);
  });

  it("mintNatsUserCreds throws for role 'browser' without a peerId", async () => {
    await expect(
      mintNatsUserCreds({ accountSeed: trustChain!.private.natsAccountSeed, tenant: T, role: "browser" }),
    ).rejects.toThrow(/peerId/);
  });
});
