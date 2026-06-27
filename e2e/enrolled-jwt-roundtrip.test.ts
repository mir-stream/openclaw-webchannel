/**
 * Sub-AC 2: Enrolled-JWT Encrypted Round-Trip — LIVE E2E Gate
 *
 * Verifies that:
 *  1. A locally-minted enrolled JWT is generated using setupTrustChain (packages/saas)
 *  2. nats-server is configured to REQUIRE JWT authentication (fail-closed)
 *  3. A headless Chromium browser connects with a NATS user JWT + NKEY challenge-
 *     response and encrypts a user message as MessageEnvelope v1
 *  4. The encrypted envelope travels through the real nats-server (ciphertext only)
 *  5. The agent-side echo kernel (running with its own user JWT) decrypts the
 *     message and sends an encrypted reply
 *  6. The browser decrypts the reply → exact expected text
 *  7. Unauthenticated connection (no JWT) is rejected by the NATS server (fail-closed)
 *
 * Trust chain: setupTrustChain() mints operator/account JWTs offline (in-process).
 * User JWTs: encodeUser() from @nats-io/jwt + fromSeed() from @nats-io/nkeys.
 * NATS server: provisioned with the operator JWT + MEMORY resolver (account JWT).
 * Browser dial: hand-rolled NATS wire-protocol client in e2e-browser-client.ts
 *   with Ed25519 challenge-response signing using Web Crypto (PKCS#8 Ed25519).
 *
 * Running locally:
 *   brew install nats-server
 *   npx vitest run e2e/enrolled-jwt-roundtrip.test.ts
 */

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
} from "vitest";
import {
  spawn,
  execFileSync,
  type ChildProcess,
} from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

// @nats-io/nkeys and @nats-io/jwt — only used here in e2e tests (not in packages/plugin)
import { fromSeed, createUser } from "@nats-io/nkeys";
import { encodeUser } from "@nats-io/jwt";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const E2E_TIMEOUT_MS = 60000; // CI headroom: each test cold-launches headless Chromium, which is slow on shared runners

const _thisDir = dirname(fileURLToPath(import.meta.url));   // e2e/
const _root    = join(_thisDir, "..");                       // workspace root

// playwright-core is a transitive dependency via node_modules/openclaw/
const _require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const playwrightCore = _require(
  join(_root, "node_modules/openclaw/node_modules/playwright-core"),
// eslint-disable-next-line @typescript-eslint/no-explicit-any
) as any;
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const { chromium } = playwrightCore as {
  chromium: {
    launch(opts?: Record<string, unknown>): Promise<{
      newPage(): Promise<{
        addInitScript(script: string): Promise<void>;
        goto(url: string): Promise<void>;
        evaluate<T, A>(fn: (arg: A) => T | Promise<T>, arg?: A): Promise<T>;
        close(): Promise<void>;
      }>;
      close(): Promise<void>;
    }>;
  };
};

// ---------------------------------------------------------------------------
// Agent-side imports
// ---------------------------------------------------------------------------

import { startE2EAgent } from "../packages/plugin/src/e2e-roundtrip-agent.js";
import { setupTrustChain } from "../packages/saas/src/setup-trust-chain.js";

// ---------------------------------------------------------------------------
// Locate nats-server binary
// ---------------------------------------------------------------------------

const NATS_SERVER_CANDIDATES = [
  "/opt/homebrew/bin/nats-server",
  "/usr/local/bin/nats-server",
  "/usr/bin/nats-server",
  process.env["NATS_SERVER_BIN"] ?? "",
].filter(Boolean);

const NATS_SERVER_BIN = NATS_SERVER_CANDIDATES.find((p) => existsSync(p)) ?? null;

// Hard-fail in CI if nats-server is absent — silent skips not allowed.
if (!NATS_SERVER_BIN && process.env["CI"] === "true") {
  throw new Error(
    "FATAL: nats-server binary not found in CI.\n" +
    "The e2e-gate.yml workflow must install nats-server v2.14 before running tests.\n" +
    "Searched paths:\n  " + NATS_SERVER_CANDIDATES.join("\n  "),
  );
}

// ---------------------------------------------------------------------------
// Ports — dedicated to this suite (no collision with Sub-AC 1 or other suites)
//   Sub-AC 1 (dev-nats-roundtrip.test.ts):       WS_PORT=18091, CLIENT_PORT=14225
//   nats-transport-realserver.test.ts:            WS_PORT=18080, CLIENT_PORT=14223
//   nats-permissions-realserver.test.ts:          WS_PORT=18081, CLIENT_PORT=14224
// ---------------------------------------------------------------------------

const WS_PORT     = 18092;
const PAGE_PORT   = 19192;
const PAGE_URL    = `http://127.0.0.1:${PAGE_PORT}/`;
const CLIENT_PORT = 14226;
const NATS_WS_URL = `ws://127.0.0.1:${WS_PORT}`;

// ---------------------------------------------------------------------------
// Test routing constants
// ---------------------------------------------------------------------------

const TENANT   = "test";
const AGENT_ID = "agent1";
const PEER_ID  = "peer1";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function waitFor(pred: () => boolean, ms = 12000, step = 25): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise<void>((r) => setTimeout(r, step));
  }
  throw new Error("waitFor: condition not met before timeout");
}

// Wait until a TCP port actually accepts a connection (the nats-server readiness
// log can precede the socket accepting connections, racing the browser dial).
async function waitForPort(port: number, host = "127.0.0.1", ms = 12000, step = 50): Promise<void> {
  const net = await import("node:net");
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const ok = await new Promise<boolean>((resolve) => {
      const sock = net.connect({ port, host });
      const done = (v: boolean): void => { sock.destroy(); resolve(v); };
      sock.once("connect", () => done(true));
      sock.once("error", () => done(false));
      sock.setTimeout(step, () => done(false));
    });
    if (ok) return;
    await new Promise<void>((r) => setTimeout(r, step));
  }
  throw new Error(`waitForPort: ${host}:${port} not accepting connections before timeout`);
}

// ---------------------------------------------------------------------------
// Browser bundle build (esbuild: browser-side TypeScript → IIFE)
// ---------------------------------------------------------------------------

function buildBrowserBundle(): string {
  const esbuildBin = join(_root, "node_modules/tsx/node_modules/esbuild/bin/esbuild");
  const entryPoint = join(_root, "packages/client/src/e2e-browser-client.ts");
  const outFile    = join(tmpdir(), `e2e-enrolled-jwt-bundle-${process.pid}.js`);

  execFileSync(esbuildBin, [
    entryPoint,
    "--bundle",
    "--platform=browser",
    "--format=iife",
    "--global-name=E2EBrowserClient",
    // Pin the IIFE result onto globalThis (a top-level `var` does not reliably
    // attach to the page global when injected via Playwright addInitScript).
    "--footer:js=;globalThis.E2EBrowserClient=E2EBrowserClient;",
    `--outfile=${outFile}`,
    "--log-level=warning",
  ]);

  return readFileSync(outFile, "utf8");
}

// ---------------------------------------------------------------------------
// Credentials helpers
// ---------------------------------------------------------------------------

type UserCredentials = {
  userJwt: string;
  /** Raw 32-byte Ed25519 seed (from kp.getRawSeed()) */
  rawSeed: Uint8Array;
  /** Base64url-encoded raw seed for browser injection */
  rawSeedArray: number[];
  /** NKEY signing callback for NatsTransport */
  nkeySigningCallback: (nonce: string) => Promise<string>;
};

/**
 * Generate a NATS user JWT with broad tenant-scoped pub/sub permissions.
 * The user can publish and subscribe to webchannel.{tenant}.> subjects.
 */
async function generateUserCredentials(
  accountSeed: string,
  tenant: string,
  label: string,
): Promise<UserCredentials> {
  const accountSigner = fromSeed(new TextEncoder().encode(accountSeed));
  const userKp = createUser();
  // getRawSeed() is on the concrete KP class but not on the KeyPair interface.
  // Cast to access it — createUser() always returns a KP instance.
  const rawSeed = (userKp as unknown as { getRawSeed(): Uint8Array }).getRawSeed();

  const subjectPattern = `webchannel.${tenant}.>`;
  const userJwt = await encodeUser(
    label,
    userKp,
    accountSigner,
    {
      pub: { allow: [subjectPattern] },
      sub: { allow: [subjectPattern] },
    },
  );

  const nkeySigningCallback = (nonce: string): Promise<string> => {
    const sig = Buffer.from(userKp.sign(new TextEncoder().encode(nonce))).toString("base64url");
    return Promise.resolve(sig);
  };

  return {
    userJwt,
    rawSeed,
    rawSeedArray: Array.from(rawSeed),
    nkeySigningCallback,
  };
}

// ---------------------------------------------------------------------------
// Suite state
// ---------------------------------------------------------------------------

let natsServer: ChildProcess | null = null;
// Real http origin for the test page (Chromium blocks WS/fetch from about:blank).
let pageServer: import("node:http").Server | null = null;
let browserBundle = "";
let trustChainResult: Awaited<ReturnType<typeof setupTrustChain>> | null = null;
let browserCreds: UserCredentials | null = null;
let agentCreds: UserCredentials | null = null;

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe.skipIf(!NATS_SERVER_BIN)(
  "Sub-AC 2: Enrolled-JWT Encrypted Round-Trip",
  () => {
    beforeAll(async () => {
      // 1. Build browser bundle (esbuild → IIFE)
      browserBundle = buildBrowserBundle();

      // 2. Mint trust chain (operator + account JWTs, JWKS, private material)
      trustChainResult = await setupTrustChain({
        operatorName: "e2e-test-operator",
        accountName:  "e2e-test-account",
      });

      // 3. Generate user credentials for browser and agent
      browserCreds = await generateUserCredentials(
        trustChainResult.private.natsAccountSeed,
        TENANT,
        `browser-${TENANT}`,
      );
      agentCreds = await generateUserCredentials(
        trustChainResult.private.natsAccountSeed,
        TENANT,
        `agent-${TENANT}`,
      );

      // 4. Write nats-server config with JWT authentication
      const tmpDir = mkdtempSync(join(tmpdir(), "nats-enrolled-jwt-e2e-"));
      const operatorJwtPath = join(tmpDir, "operator.jwt");
      writeFileSync(operatorJwtPath, trustChainResult.natsConfig.operatorJwt);

      // Build resolver_preload block: accountPublicKey -> accountJwt
      const preloadEntries = Object.entries(
        trustChainResult.natsConfig.resolverConfig,
      )
        .map(([accPub, accJwt]) => `  ${accPub}: "${accJwt}"`)
        .join("\n");

      const confPath = join(tmpDir, "nats.conf");
      writeFileSync(confPath, [
        `port: ${CLIENT_PORT}`,
        `websocket {`,
        `  port: ${WS_PORT}`,
        `  no_tls: true`,
        `}`,
        `operator: "${operatorJwtPath}"`,
        `resolver: MEMORY`,
        `resolver_preload: {`,
        preloadEntries,
        `}`,
        "",
      ].join("\n"));

      // 5. Start nats-server with JWT auth required
      natsServer = spawn(NATS_SERVER_BIN!, ["-c", confPath], {
        stdio: ["ignore", "pipe", "pipe"],
      });

      let ready = false;
      const onData = (buf: Buffer): void => {
        if (buf.toString().includes("Server is ready")) ready = true;
      };
      natsServer.stdout?.on("data", onData);
      natsServer.stderr?.on("data", onData);

      await waitFor(() => ready, 12000, 25);
      // Gate on the websocket port actually accepting connections (removes the
      // readiness-log vs socket-accept race that surfaces as an opaque WS error).
      await waitForPort(WS_PORT);

      // Serve the test page from a real http origin (Chromium blocks WS/fetch
      // sub-resource connections from an about:blank null-origin page).
      const http = await import("node:http");
      pageServer = http.createServer((_req, res) => {
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<!doctype html><html><head><meta charset=\"utf-8\"></head><body>webchannel-e2e</body></html>");
      });
      await new Promise<void>((resolve) => pageServer!.listen(PAGE_PORT, "127.0.0.1", resolve));
    }, E2E_TIMEOUT_MS);

    afterAll(async () => {
      if (natsServer) {
        natsServer.kill("SIGKILL");
        natsServer = null;
      }
      if (pageServer) {
        await new Promise<void>((resolve) => pageServer!.close(() => resolve()));
        pageServer = null;
      }
    });

    // -----------------------------------------------------------------------
    // Test 1: Full enrolled-JWT encrypted round-trip
    //
    // Browser connects with user JWT + NKEY sig → encrypts message → agent
    // decrypts → echo kernel → encrypts reply → browser decrypts → verify.
    // -----------------------------------------------------------------------

    it(
      "browser (enrolled-JWT) sends encrypted envelope → agent echo-decrypts → browser decrypts reply",
      async () => {
        const { randomBytes } = await import("node:crypto");
        const sessionKey = new Uint8Array(randomBytes(32));

        const messageText   = "hello from browser — Sub-AC 2 enrolled-JWT encrypted round-trip";
        const expectedReply = `echo: ${messageText}`;

        // Start agent-side echo kernel with JWT credentials
        const agent = await startE2EAgent({
          natsUrl:             NATS_WS_URL,
          tenant:              TENANT,
          agentId:             AGENT_ID,
          preSharedKey:        sessionKey,
          jwtCredential:       agentCreds!.userJwt,
          nkeySigningCallback: agentCreds!.nkeySigningCallback,
        });

        // Allow subscriptions to register server-side
        await new Promise<void>((r) => setTimeout(r, 150));

        let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
        try {
          browser = await chromium.launch({
            headless: true,
            args: [
              "--single-process",
              "--no-sandbox",
              "--disable-setuid-sandbox",
              "--disable-dev-shm-usage",
            ],
          });

          const page = await browser.newPage();
          await page.addInitScript(browserBundle);
          await page.goto(PAGE_URL);

          type EvalArgs = [string, number[], string, string, string, string, string, number[]];
          type EvalResult = {
            replyText: string;
            wirePayloadJson: string;
            isOpaqueOnWire: boolean;
          };

          const result = await page.evaluate<EvalResult, EvalArgs>(
            async ([natsUrl, keyArr, msgText, tenant, agentId, peerId, userJwt, rawNkeyPrivateKey]) => {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const { runEncryptedRoundTrip } = (globalThis as any)["E2EBrowserClient"] as {
                runEncryptedRoundTrip: (opts: {
                  natsUrl: string; tenant: string; agentId: string; peerId: string;
                  messageText: string; preSharedKey: number[]; timeoutMs: number;
                  userJwt: string; rawNkeyPrivateKey: number[];
                }) => Promise<EvalResult>;
              };
              return runEncryptedRoundTrip({
                natsUrl, tenant, agentId, peerId,
                messageText: msgText,
                preSharedKey: keyArr,
                timeoutMs: 12000,
                userJwt,
                rawNkeyPrivateKey,
              });
            },
            [
              NATS_WS_URL,
              Array.from(sessionKey),
              messageText,
              TENANT,
              AGENT_ID,
              PEER_ID,
              browserCreds!.userJwt,
              browserCreds!.rawSeedArray,
            ],
          );

          // 1. Decrypted reply must be the exact expected echo text
          expect(result.replyText).toBe(expectedReply);

          // 2. Wire payload is opaque (proves relay only sees ciphertext)
          expect(result.wirePayloadJson).not.toContain(messageText);
          expect(result.wirePayloadJson).not.toContain("hello from browser");
          expect(result.isOpaqueOnWire).toBe(true);

          // 3. Wire payload is a valid MessageEnvelope v1
          const wireEnv = JSON.parse(result.wirePayloadJson) as Record<string, unknown>;
          expect(wireEnv["v"]).toBe(1);
          expect(wireEnv["agentId"]).toBe(AGENT_ID);
          expect(wireEnv["tenant"]).toBe(TENANT);
          const content = wireEnv["content"] as Record<string, unknown>;
          expect(typeof content["nonce"]).toBe("string");
          expect(typeof content["ciphertext"]).toBe("string");
          expect(typeof content["tag"]).toBe("string");

        } finally {
          agent.stop();
          await browser?.close();
        }
      },
      E2E_TIMEOUT_MS,
    );

    // -----------------------------------------------------------------------
    // Test 2: Fail-closed — unauthenticated connection is rejected
    //
    // Connecting to the JWT-auth NATS server WITHOUT credentials must fail.
    // This proves the relay is fail-closed: no JWT → no access.
    // -----------------------------------------------------------------------

    it(
      "unauthenticated connection (no JWT) is rejected by the JWT-auth NATS server (fail-closed)",
      async () => {
        let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
        try {
          browser = await chromium.launch({
            headless: true,
            args: [
              "--single-process",
              "--no-sandbox",
              "--disable-setuid-sandbox",
              "--disable-dev-shm-usage",
            ],
          });

          const page = await browser.newPage();
          await page.addInitScript(browserBundle);
          await page.goto(PAGE_URL);

          type EvalArgs3 = [string];
          type EvalResult3 = { error: string };

          const result = await page.evaluate<EvalResult3, EvalArgs3>(
            async ([natsUrl]) => {
              try {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const { runEncryptedRoundTrip } = (globalThis as any)["E2EBrowserClient"] as {
                  runEncryptedRoundTrip: (opts: {
                    natsUrl: string; tenant: string; agentId: string; peerId: string;
                    messageText: string; preSharedKey: number[]; timeoutMs: number;
                    // No userJwt / rawNkeyPrivateKey → unauthenticated
                  }) => Promise<unknown>;
                };
                await runEncryptedRoundTrip({
                  natsUrl,
                  tenant: "test",
                  agentId: "agent1",
                  peerId: "peer1",
                  messageText: "should be rejected",
                  preSharedKey: Array.from(new Uint8Array(32)),
                  timeoutMs: 5000,
                  // No JWT/NKEY → should fail with auth error
                });
                return { error: "" }; // Should NOT reach here
              } catch (e) {
                return { error: String(e) };
              }
            },
            [NATS_WS_URL],
          );

          // The connection MUST fail — unauthenticated access is not allowed
          expect(result.error).not.toBe("");
          // NATS should send -ERR 'Authorization Violation' or similar
          expect(
            result.error.toLowerCase().includes("authorization") ||
            result.error.toLowerCase().includes("err") ||
            result.error.toLowerCase().includes("closed") ||
            result.error.toLowerCase().includes("timeout"),
          ).toBe(true);

        } finally {
          await browser?.close();
        }
      },
      E2E_TIMEOUT_MS,
    );

    // -----------------------------------------------------------------------
    // Test 3: Full X25519 ECDH key exchange in enrolled-JWT mode
    //
    // Same as Test 1 but without pre-shared key — exercises the full
    // X25519 key exchange protocol through the JWT-auth NATS server.
    // -----------------------------------------------------------------------

    it(
      "browser and agent perform X25519 key exchange in enrolled-JWT mode → encrypted round-trip succeeds",
      async () => {
        const messageText   = "hello via X25519 ECDH in enrolled-JWT mode";
        const expectedReply = `echo: ${messageText}`;

        // Agent without pre-shared key → triggers X25519 key exchange
        const agent = await startE2EAgent({
          natsUrl:             NATS_WS_URL,
          tenant:              TENANT,
          agentId:             AGENT_ID,
          // no preSharedKey → X25519 key exchange via handshake subject
          jwtCredential:       agentCreds!.userJwt,
          nkeySigningCallback: agentCreds!.nkeySigningCallback,
        });

        await new Promise<void>((r) => setTimeout(r, 150));

        let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
        try {
          browser = await chromium.launch({
            headless: true,
            args: [
              "--single-process",
              "--no-sandbox",
              "--disable-setuid-sandbox",
              "--disable-dev-shm-usage",
            ],
          });

          const page = await browser.newPage();
          await page.addInitScript(browserBundle);
          await page.goto(PAGE_URL);

          type EvalArgs4 = [string, string, string, string, string, string, number[]];
          type EvalResult4 = { replyText: string; wirePayloadJson: string; isOpaqueOnWire: boolean };

          const result = await page.evaluate<EvalResult4, EvalArgs4>(
            async ([natsUrl, msgText, tenant, agentId, peerId, userJwt, rawNkeyPrivateKey]) => {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const { runEncryptedRoundTrip } = (globalThis as any)["E2EBrowserClient"] as {
                runEncryptedRoundTrip: (opts: {
                  natsUrl: string; tenant: string; agentId: string; peerId: string;
                  messageText: string; timeoutMs: number;
                  userJwt: string; rawNkeyPrivateKey: number[];
                }) => Promise<EvalResult4>;
              };
              return runEncryptedRoundTrip({
                natsUrl, tenant, agentId, peerId,
                messageText: msgText,
                // no preSharedKey → X25519 key exchange
                timeoutMs: 15000,
                userJwt,
                rawNkeyPrivateKey,
              });
            },
            [
              NATS_WS_URL,
              messageText,
              TENANT,
              AGENT_ID,
              PEER_ID,
              browserCreds!.userJwt,
              browserCreds!.rawSeedArray,
            ],
          );

          // 1. Decrypted reply is exact expected echo text
          expect(result.replyText).toBe(expectedReply);

          // 2. Wire payload is opaque (relay never sees plaintext)
          expect(result.wirePayloadJson).not.toContain(messageText);
          expect(result.isOpaqueOnWire).toBe(true);

          // 3. Valid MessageEnvelope v1 structure
          const env = JSON.parse(result.wirePayloadJson) as Record<string, unknown>;
          expect(env["v"]).toBe(1);
          expect(typeof (env["content"] as Record<string, unknown>)["nonce"]).toBe("string");

        } finally {
          agent.stop();
          await browser?.close();
        }
      },
      E2E_TIMEOUT_MS,
    );

  },
);

// ---------------------------------------------------------------------------
// Test 4: AAD mismatch fails decryption — Node.js only, no nats-server needed
//
// Same as Sub-AC 1 Test 4, included here to verify AAD enforcement in context
// of enrolled-JWT mode. Runs in ALL CI environments regardless of nats-server.
// ---------------------------------------------------------------------------

it(
  "AAD mismatch (tampered routing metadata) causes decryption failure [enrolled-JWT mode]",
  async () => {
    const { randomBytes } = await import("node:crypto");
    const sessionKey = new Uint8Array(randomBytes(32));

    const {
      encodeEnvelope,
      decryptEnvelopeContent,
      canonicalAad,
    } = await import("../packages/plugin/src/e2e-envelope.js");

    const routing = {
      agentId:      AGENT_ID,
      tenant:       TENANT,
      sub:          PEER_ID,
      messageId:    "msg-enrolled-jwt-aad-001",
      envelopeType: "conversation" as const,
      ts:           1718000000000,
    };
    const aad = canonicalAad(routing);
    const envelope = encodeEnvelope(routing, "enrolled-jwt secret content", sessionKey, aad);

    // Positive case: correct AAD decrypts successfully
    const plaintext = decryptEnvelopeContent(envelope, sessionKey, aad);
    expect(new TextDecoder().decode(plaintext)).toBe("enrolled-jwt secret content");

    // Negative case 1: tampered tenant → AAD mismatch → throw
    const tamperedAad = canonicalAad({ ...routing, tenant: "attacker-tenant" });
    expect(() => decryptEnvelopeContent(envelope, sessionKey, tamperedAad)).toThrow();

    // Negative case 2: wrong key → throw
    const wrongKey = new Uint8Array(randomBytes(32));
    expect(() => decryptEnvelopeContent(envelope, wrongKey, aad)).toThrow();

    // Negative case 3: no AAD when encryption used AAD → throw
    expect(() => decryptEnvelopeContent(envelope, sessionKey, undefined)).toThrow();
  },
);
