/**
 * Sub-AC 1: Dev/open-NATS Encrypted Round-Trip — LIVE E2E Gate
 *
 * Verifies that:
 *  1. A headless Chromium browser connects to a real nats-server via the
 *     hand-rolled NATS wire-protocol client (packages/client/src/e2e-browser-client.ts)
 *  2. The browser encrypts a user message as a MessageEnvelope v1 with
 *     ChaCha20-Poly1305 (pure-JS: packages/client/src/chacha20poly1305.ts)
 *  3. The encrypted envelope travels through the real nats-server (ciphertext only)
 *  4. The agent-side echo kernel decrypts the message (Node.js crypto)
 *  5. The echo reply is encrypted with canonical AAD and published back
 *  6. The browser decrypts the reply → exact expected text
 *  7. Wire payload proves the relay never sees plaintext
 *
 * Browser: headless Chromium via playwright-core
 *   (node_modules/openclaw/node_modules/playwright-core, no @playwright/test needed)
 * NATS:    real nats-server v2.14 (must be in PATH or NATS_SERVER_BIN env)
 * Agent:   startE2EAgent() — echo kernel with real CryptoNatsChannel
 * Crypto:  X25519 (Web Crypto) + HKDF-SHA256 (Web Crypto) + ChaCha20-Poly1305 (pure JS)
 *
 * CI guard: absent nats-server hard-fails when process.env.CI === "true".
 *
 * Running locally:
 *   brew install nats-server
 *   npx vitest run e2e/dev-nats-roundtrip.test.ts
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

// ---------------------------------------------------------------------------
// Paths (relative to this test file)
// ---------------------------------------------------------------------------

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
// Ports (avoid collision with other real-server suites)
//   nats-transport-realserver.test.ts:    WS_PORT=18080, CLIENT_PORT=14223, MONITOR_PORT=18222
//   nats-permissions-realserver.test.ts:  WS_PORT=18081, CLIENT_PORT=14224
// ---------------------------------------------------------------------------

const WS_PORT      = 18091;
const PAGE_PORT    = 19191;
const PAGE_URL     = `http://127.0.0.1:${PAGE_PORT}/`;
const CLIENT_PORT  = 14225;
const NATS_WS_URL  = `ws://127.0.0.1:${WS_PORT}`;

// ---------------------------------------------------------------------------
// Test routing constants
// ---------------------------------------------------------------------------

const TENANT   = "test";
const AGENT_ID = "agent1";
const PEER_ID  = "peer1";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function waitFor(pred: () => boolean, ms = 10000, step = 25): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise<void>((r) => setTimeout(r, step));
  }
  throw new Error("waitFor: condition not met before timeout");
}

// Wait until a TCP port actually accepts a connection. The nats-server
// "Server is ready" log line can be observed before the websocket listener
// socket is reliably accepting connections, which races the browser dial and
// surfaces as an opaque `WebSocket error`. Probing the real socket removes the
// race deterministically.
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
  const outFile    = join(tmpdir(), `e2e-browser-bundle-${process.pid}.js`);

  execFileSync(esbuildBin, [
    entryPoint,
    "--bundle",
    "--platform=browser",
    "--format=iife",
    "--global-name=E2EBrowserClient",
    // esbuild's `--global-name` emits a top-level `var E2EBrowserClient = ...`.
    // When injected via Playwright `addInitScript`, a top-level `var` does not
    // reliably attach to the page's `globalThis`. This footer runs in the same
    // bundle scope and pins the global explicitly so `page.evaluate` can read it.
    "--footer:js=;globalThis.E2EBrowserClient=E2EBrowserClient;",
    `--outfile=${outFile}`,
    "--log-level=warning",
  ]);

  return readFileSync(outFile, "utf8");
}

// ---------------------------------------------------------------------------
// nats-server lifecycle
// ---------------------------------------------------------------------------

let natsServer: ChildProcess | null = null;
// A real http origin for the test page. Chromium blocks WebSocket/fetch
// sub-resource connections from an `about:blank` page (origin "null"), so the
// browser dial must run from a real http origin served locally.
let pageServer: import("node:http").Server | null = null;
let browserBundle = "";

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe.skipIf(!NATS_SERVER_BIN)(
  "Sub-AC 1: Dev/open-NATS Encrypted Round-Trip",
  () => {
    beforeAll(async () => {
      // 1. Build browser bundle (esbuild → IIFE)
      browserBundle = buildBrowserBundle();

      // 2. Start real nats-server with WebSocket listener
      const dir = mkdtempSync(join(tmpdir(), "nats-e2e-"));
      const confPath = join(dir, "nats.conf");
      writeFileSync(confPath, [
        `port: ${CLIENT_PORT}`,
        "websocket {",
        `  port: ${WS_PORT}`,
        "  no_tls: true",
        "}",
        "",
      ].join("\n"));

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
      // The readiness log can precede the socket actually accepting connections;
      // gate on a real TCP connect to the websocket port to remove the race.
      await waitForPort(WS_PORT);

      // Serve the test page from a real http origin (see pageServer note above).
      const http = await import("node:http");
      pageServer = http.createServer((_req, res) => {
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<!doctype html><html><head><meta charset=\"utf-8\"></head><body>webchannel-e2e</body></html>");
      });
      await new Promise<void>((resolve) => pageServer!.listen(PAGE_PORT, "127.0.0.1", resolve));
    }, 30000);

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
    // Test 1: Pre-shared key — transport-layer encryption verification
    // -----------------------------------------------------------------------

    it(
      "browser sends encrypted envelope → agent echo-decrypts → browser decrypts reply (pre-shared key mode)",
      async () => {
        const { randomBytes } = await import("node:crypto");
        const sessionKey = new Uint8Array(randomBytes(32));
        const sessionKeyArray = Array.from(sessionKey);

        const messageText  = "hello from browser — Sub-AC 1 E2E encrypted round-trip";
        const expectedReply = `echo: ${messageText}`;

        // Start agent-side echo kernel
        const agent = await startE2EAgent({
          natsUrl:      NATS_WS_URL,
          tenant:       TENANT,
          agentId:      AGENT_ID,
          preSharedKey: sessionKey,
        });

        // Allow subscriptions to register server-side
        await new Promise<void>((r) => setTimeout(r, 100));

        let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
        try {
          // Launch headless Chromium (--single-process needed in sandboxed env)
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

          // Inject the browser bundle (ChaCha20-Poly1305 + hand-rolled NATS client)
          await page.addInitScript(browserBundle);
          await page.goto(PAGE_URL);

          // Run the encrypted round-trip inside the browser
          type EvalArgs = [string, number[], string, string, string, string];
          type EvalResult = {
            replyText: string;
            wirePayloadJson: string;
            isOpaqueOnWire: boolean;
          };

          const result = await page.evaluate<EvalResult, EvalArgs>(
            async ([natsUrl, keyArr, msgText, tenant, agentId, peerId]) => {
              // E2EBrowserClient is the IIFE global injected by addInitScript
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const { runEncryptedRoundTrip } = (globalThis as any)["E2EBrowserClient"] as {
                runEncryptedRoundTrip: (opts: {
                  natsUrl: string; tenant: string; agentId: string; peerId: string;
                  messageText: string; preSharedKey: number[]; timeoutMs: number;
                }) => Promise<{ replyText: string; wirePayloadJson: string; isOpaqueOnWire: boolean }>;
              };
              return runEncryptedRoundTrip({
                natsUrl, tenant, agentId, peerId,
                messageText: msgText,
                preSharedKey: keyArr,
                timeoutMs: 8000,
              });
            },
            [NATS_WS_URL, sessionKeyArray, messageText, TENANT, AGENT_ID, PEER_ID],
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
      30000,
    );

    // -----------------------------------------------------------------------
    // Test 2: Full X25519 ECDH key exchange via NATS handshake subject
    // -----------------------------------------------------------------------

    it(
      "browser and agent perform X25519 key exchange → encrypted round-trip succeeds",
      async () => {
        const messageText   = "hello via X25519 ECDH key exchange";
        const expectedReply = `echo: ${messageText}`;

        // Start agent WITHOUT pre-shared key → triggers X25519 key exchange
        const agent = await startE2EAgent({
          natsUrl:  NATS_WS_URL,
          tenant:   TENANT,
          agentId:  AGENT_ID,
          // no preSharedKey → agent performs X25519 key exchange
        });

        // Allow agent subscriptions to register before browser connects
        await new Promise<void>((r) => setTimeout(r, 150));

        let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
        try {
          browser = await chromium.launch({
            headless: true,
            args: ["--single-process", "--no-sandbox", "--disable-setuid-sandbox"],
          });

          const page = await browser.newPage();
          await page.addInitScript(browserBundle);
          await page.goto(PAGE_URL);

          type EvalArgs2 = [string, string, string, string, string];
          type EvalResult2 = {
            replyText: string;
            wirePayloadJson: string;
            isOpaqueOnWire: boolean;
          };

          const result = await page.evaluate<EvalResult2, EvalArgs2>(
            async ([natsUrl, msgText, tenant, agentId, peerId]) => {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const { runEncryptedRoundTrip } = (globalThis as any)["E2EBrowserClient"] as {
                runEncryptedRoundTrip: (opts: {
                  natsUrl: string; tenant: string; agentId: string; peerId: string;
                  messageText: string; timeoutMs: number;
                }) => Promise<{ replyText: string; wirePayloadJson: string; isOpaqueOnWire: boolean }>;
              };
              return runEncryptedRoundTrip({
                natsUrl, tenant, agentId, peerId,
                messageText: msgText,
                // no preSharedKey → browser performs X25519 key exchange
                timeoutMs: 10000,
              });
            },
            [NATS_WS_URL, messageText, TENANT, AGENT_ID, PEER_ID],
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
      35000,
    );

    // -----------------------------------------------------------------------
    // Test 3: Ciphertext opacity — sensitive text never appears on wire
    // -----------------------------------------------------------------------

    it(
      "sensitive plaintext never appears on the NATS wire (relay-opacity guarantee)",
      async () => {
        const { randomBytes } = await import("node:crypto");
        const sessionKey = new Uint8Array(randomBytes(32));

        const sensitiveText  = "SECRET-PAYLOAD-MUST-NOT-APPEAR-ON-WIRE-12345";
        const expectedReply  = `echo: ${sensitiveText}`;

        const agent = await startE2EAgent({
          natsUrl: NATS_WS_URL, tenant: TENANT, agentId: AGENT_ID,
          preSharedKey: sessionKey,
        });

        await new Promise<void>((r) => setTimeout(r, 100));

        let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
        try {
          browser = await chromium.launch({
            headless: true,
            args: ["--single-process", "--no-sandbox", "--disable-setuid-sandbox"],
          });

          const page = await browser.newPage();
          await page.addInitScript(browserBundle);
          await page.goto(PAGE_URL);

          type EvalArgsO = [string, number[], string, string, string, string];
          type EvalResultO = { replyText: string; wirePayloadJson: string; isOpaqueOnWire: boolean };

          const result = await page.evaluate<EvalResultO, EvalArgsO>(
            async ([natsUrl, keyArr, msgText, tenant, agentId, peerId]) => {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const { runEncryptedRoundTrip } = (globalThis as any)["E2EBrowserClient"] as {
                runEncryptedRoundTrip: (opts: {
                  natsUrl: string; tenant: string; agentId: string; peerId: string;
                  messageText: string; preSharedKey: number[]; timeoutMs: number;
                }) => Promise<EvalResultO>;
              };
              return runEncryptedRoundTrip({
                natsUrl, tenant, agentId, peerId,
                messageText: msgText,
                preSharedKey: keyArr,
                timeoutMs: 8000,
              });
            },
            [NATS_WS_URL, Array.from(sessionKey), sensitiveText, TENANT, AGENT_ID, PEER_ID],
          );

          // Relay (wire) payload must NOT contain the sensitive text
          expect(result.wirePayloadJson).not.toContain(sensitiveText);
          expect(result.wirePayloadJson).not.toContain("SECRET-PAYLOAD");
          expect(result.isOpaqueOnWire).toBe(true);

          // But the legitimate recipient decrypts it correctly
          expect(result.replyText).toBe(expectedReply);

        } finally {
          agent.stop();
          await browser?.close();
        }
      },
      30000,
    );

  },
);

// ---------------------------------------------------------------------------
// Test 4: AAD mismatch → decryption failure (always runs — no nats-server needed)
//
// This is a Node.js-only test: verifies that the canonicalAad binding is
// enforced. A tampered routing field invalidates the AAD and causes
// ChaCha20-Poly1305 authentication to fail. This test runs in ALL CI
// environments regardless of nats-server availability.
// ---------------------------------------------------------------------------

it(
  "AAD mismatch (tampered routing metadata) causes decryption failure",
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
      messageId:    "msg-aad-test-001",
      envelopeType: "conversation" as const,
      ts:           1718000000000,
    };
    const aad = canonicalAad(routing);
    const envelope = encodeEnvelope(routing, "secret content", sessionKey, aad);

    // --- Positive case: correct AAD decrypts successfully ---
    const plaintext = decryptEnvelopeContent(envelope, sessionKey, aad);
    expect(new TextDecoder().decode(plaintext)).toBe("secret content");

    // --- Negative case 1: tampered tenant field → AAD mismatch → throw ---
    const tamperedAad = canonicalAad({ ...routing, tenant: "attacker-tenant" });
    expect(() => decryptEnvelopeContent(envelope, sessionKey, tamperedAad)).toThrow();

    // --- Negative case 2: wrong key → throw ---
    const wrongKey = new Uint8Array(randomBytes(32));
    expect(() => decryptEnvelopeContent(envelope, wrongKey, aad)).toThrow();

    // --- Negative case 3: no AAD when encryption used AAD → throw ---
    // (Sending undefined AAD when the encryption used specific AAD fails
    // because the Poly1305 tag covers the AAD bytes.)
    expect(() => decryptEnvelopeContent(envelope, sessionKey, undefined)).toThrow();
  },
);
