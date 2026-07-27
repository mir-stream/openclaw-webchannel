/**
 * Real-server NATS integration tests (Phase 1: transport interop).
 *
 * Unlike `nats-transport-integration.test.ts` (which drives NatsTransport against
 * an in-process `FakeNatsBroker` via the `_wsFactory` seam), THIS suite spawns a
 * real `nats-server` with its WebSocket listener enabled and connects two
 * NatsTransport instances over an actual `ws://` socket using the DEFAULT
 * factory (`new WebSocket(url)`). It validates that our hand-rolled NATS text
 * protocol (CONNECT/PING/PONG/SUB/PUB/MSG) actually interoperates with a genuine
 * nats-server v2.14 — and that real E2E ciphertext survives the round-trip while
 * never appearing as plaintext on the wire.
 *
 * The suite is skipped automatically when the `nats-server` binary is absent
 * (e.g. on CI without it installed), so it never breaks the default `npm test`.
 * Install locally with `brew install nats-server`.
 *
 * Scope (Phase 1): transport interop, 1:N fan-out, backlog replay, ciphertext
 * opacity over the real bus. NOT covered here (Phase 2): JWKS-verified NATS
 * account/subject permission enforcement against a real broker.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { NatsTransport } from "./nats-transport.js";
import type { NatsMessage } from "./nats-transport.js";
import {
  generateKeyPair,
  deriveSharedSecret,
  encrypt,
  decrypt,
} from "./e2e-crypto.js";

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

// Dedicated ports for this suite (avoid clashing with any dev server on 4222/8080).
const CLIENT_PORT = 14223;
const WS_PORT = 18080;
const MONITOR_PORT = 18222;
const WS_URL = `ws://127.0.0.1:${WS_PORT}`;

let server: ChildProcess | null = null;
const transports: NatsTransport[] = [];

/** Encrypt a UTF-8 string into a JSON wire frame {n,t,c} of base64url parts. */
function sealToWire(key: Uint8Array, plaintext: string): Buffer {
  const { ciphertext, nonce, tag } = encrypt(
    key,
    new Uint8Array(Buffer.from(plaintext, "utf8")),
  );
  const frame = {
    n: Buffer.from(nonce).toString("base64url"),
    t: Buffer.from(tag).toString("base64url"),
    c: Buffer.from(ciphertext).toString("base64url"),
  };
  return Buffer.from(JSON.stringify(frame), "utf8");
}

/** Reverse of sealToWire — throws if authentication fails. */
function openFromWire(key: Uint8Array, payload: Buffer): string {
  const frame = JSON.parse(payload.toString("utf8")) as {
    n: string;
    t: string;
    c: string;
  };
  const plain = decrypt(
    key,
    new Uint8Array(Buffer.from(frame.n, "base64url")),
    new Uint8Array(Buffer.from(frame.c, "base64url")),
    new Uint8Array(Buffer.from(frame.t, "base64url")),
  );
  return Buffer.from(plain).toString("utf8");
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2000,
  stepMs = 10,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  if (!predicate()) throw new Error("waitFor: condition not met before timeout");
}

async function makeTransport(name: string): Promise<NatsTransport> {
  const t = new NatsTransport({ url: WS_URL, clientName: name });
  transports.push(t);
  await t.connect();
  return t;
}

beforeAll(async () => {
  if (!NATS_SERVER_BIN) return; // suite will be skipped

  const dir = mkdtempSync(join(tmpdir(), "nats-real-"));
  const confPath = join(dir, "nats.conf");
  writeFileSync(
    confPath,
    [
      `port: ${CLIENT_PORT}`,
      `http: ${MONITOR_PORT}`,
      `websocket {`,
      `  port: ${WS_PORT}`,
      `  no_tls: true`,
      `}`,
      "",
    ].join("\n"),
  );

  server = spawn(NATS_SERVER_BIN, ["-c", confPath], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  // Wait for the "Server is ready" line on stderr (nats-server logs to stderr).
  let ready = false;
  const onData = (buf: Buffer) => {
    if (buf.toString().includes("Server is ready")) ready = true;
  };
  server.stdout?.on("data", onData);
  server.stderr?.on("data", onData);

  await waitFor(() => ready, 8000, 25);
}, 15000);

afterAll(async () => {
  for (const t of transports) {
    try {
      t.disconnect();
    } catch {
      /* best-effort */
    }
  }
  transports.length = 0;
  if (server) {
    server.kill("SIGKILL");
    server = null;
  }
});

// ---------------------------------------------------------------------------
// Subjects (plaintext routing metadata, per design)
// ---------------------------------------------------------------------------
const OUTBOUND = "chat.tenant1.agent1.user42.out";
const HISTORY = "chat.tenant1.agent1.user42.history";

describe.skipIf(!NATS_SERVER_BIN)(
  "NatsTransport against a REAL nats-server (Phase 1 interop)",
  () => {
    it("connects to the real server and round-trips an E2E-encrypted message (plaintext never on the wire)", async () => {
      const agentKeys = generateKeyPair();
      const browserKeys = generateKeyPair();
      const key = deriveSharedSecret(agentKeys.privateKey, browserKeys.publicKey);
      const keyB = deriveSharedSecret(
        browserKeys.privateKey,
        agentKeys.publicKey,
      );
      // Sanity: both sides derive the identical shared secret.
      expect(Buffer.from(keyB)).toEqual(Buffer.from(key));

      const agent = await makeTransport("agent");
      const browser = await makeTransport("browser");

      const received: NatsMessage[] = [];
      browser.on("message", (m) => received.push(m));
      browser.subscribe(OUTBOUND);
      // Let the SUB register server-side before publishing.
      await new Promise((r) => setTimeout(r, 100));

      const secret = "approve transfer of 5000 to acct-9981";
      agent.publish(OUTBOUND, sealToWire(key, secret));

      await waitFor(() => received.length >= 1, 3000);
      expect(received).toHaveLength(1);

      const wire = received[0]!.payload;
      // On-wire opacity: the plaintext must NOT appear in the raw frame.
      expect(wire.toString("utf8")).not.toContain("approve transfer");
      expect(wire.toString("utf8")).not.toContain("acct-9981");
      // But the legitimate recipient decrypts it back to the original.
      expect(openFromWire(keyB, wire)).toBe(secret);
    });

    it("fans a single publish out to N same-subject subscribers (1:N broadcast)", async () => {
      const agentKeys = generateKeyPair();
      const browserKeys = generateKeyPair();
      const key = deriveSharedSecret(agentKeys.privateKey, browserKeys.publicKey);

      const agent = await makeTransport("agent-fanout");
      const N = 4;
      const buckets: NatsMessage[][] = [];
      for (let i = 0; i < N; i++) {
        const b = await makeTransport(`browser-${i}`);
        const got: NatsMessage[] = [];
        b.on("message", (m) => got.push(m));
        b.subscribe(OUTBOUND);
        buckets.push(got);
      }
      await new Promise((r) => setTimeout(r, 150));

      agent.publish(OUTBOUND, sealToWire(key, "fanout-payload"));

      await waitFor(() => buckets.every((b) => b.length >= 1), 3000);
      for (const b of buckets) {
        expect(b).toHaveLength(1);
        expect(openFromWire(key, b[0]!.payload)).toBe("fanout-payload");
      }
    });

    it("replays a backlog of N messages in order with zero gaps over the real bus", async () => {
      const agentKeys = generateKeyPair();
      const browserKeys = generateKeyPair();
      const key = deriveSharedSecret(agentKeys.privateKey, browserKeys.publicKey);

      const agent = await makeTransport("agent-history");
      const browser = await makeTransport("browser-history");
      const received: NatsMessage[] = [];
      browser.on("message", (m) => received.push(m));
      browser.subscribe(HISTORY);
      await new Promise((r) => setTimeout(r, 100));

      const M = 25;
      for (let i = 0; i < M; i++) {
        agent.publish(HISTORY, sealToWire(key, `msg-${i}`));
      }

      await waitFor(() => received.length >= M, 4000);
      expect(received).toHaveLength(M);
      // Decrypt all and assert exact order, zero gaps.
      const plain = received.map((m) => openFromWire(key, m.payload));
      expect(plain).toEqual(Array.from({ length: M }, (_, i) => `msg-${i}`));
    });
  },
);
