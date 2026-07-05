/**
 * Runtime state-sequence smoke (plan §9.3) — the no-agent graceful end state.
 *
 * Boots the SaaS backend (which boots nats-server), logs in, mints a bootstrap
 * JWT + browser NATS creds through the PUBLIC HTTP surface, constructs a real
 * WebChannelNATSClient with `registration`, and asserts the SEQUENCE:
 *
 *   ① reaches status "connected"
 *   ② a TERMINAL status "error" arrives AFTER connected, ~>=10s later, with
 *      message exactly "[nats-client] request timeout" (the register request had
 *      no responder — no agent — which we INFER from timing + message, since
 *      "register in flight" is not publicly observable)
 *   ③ the app classifier classify(state) === "waiting-for-agent"
 *
 * Run headless via `node --import tsx test/smoke.mjs`. Requires `nats-server` on
 * PATH (skips + warns if absent — but CI/local here has it, so it RUNS).
 */

import { spawn, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

import { WebChannelNATSClient, generateDevicePopKeyPair } from "@mir-stream/webchannel-client";
import { classify } from "../web/app.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = join(__dirname, "..");

// nats-server presence gate.
const hasNats = spawnSync("nats-server", ["--version"], { stdio: "ignore" }).status === 0;
if (!hasNats) {
  console.warn("SKIP: nats-server not on PATH — cannot run the runtime smoke.");
  process.exit(0);
}

const PORT = process.env.SMOKE_PORT || "4055";
const BASE = `http://127.0.0.1:${PORT}`;
const env = {
  ...process.env,
  PORT,
  NATS_WS: process.env.SMOKE_NATS_WS || "18795",
  NATS_TCP: process.env.SMOKE_NATS_TCP || "14795",
};

function b64url(buf) {
  return Buffer.from(new Uint8Array(buf)).toString("base64url");
}

async function waitForReady(child) {
  return new Promise((resolve, reject) => {
    let out = "";
    const onData = (b) => {
      out += b.toString();
      if (out.includes("SaaS backend on")) resolve();
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", (code) => reject(new Error(`server exited early (code ${code})\n${out}`)));
    setTimeout(() => reject(new Error(`server not ready in 30s\n${out}`)), 30_000);
  });
}

let server;
let client;
try {
  server = spawn("node", ["--import", "tsx", "server/index.ts"], {
    cwd: APP_ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitForReady(server);
  console.log("ok - server + nats-server booted");

  // 1. login → session.
  const loginRes = await fetch(`${BASE}/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "alice", password: "password" }),
  });
  assert.equal(loginRes.status, 200, "login should succeed");
  const session = await loginRes.json();
  assert.ok(session.token && session.peerId, "login returns token + peerId");
  console.log(`ok - login (peerId=${session.peerId})`);

  // 2. device keys.
  const x25519 = await crypto.subtle.generateKey({ name: "X25519" }, false, ["deriveBits"]);
  const deviceX25519PublicKey = b64url(await crypto.subtle.exportKey("raw", x25519.publicKey));
  const pop = await generateDevicePopKeyPair();

  // 3. /bootstrap (session-gated).
  const bootRes = await fetch(`${BASE}/bootstrap`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${session.token}` },
    body: JSON.stringify({
      accountId: session.accountId,
      deviceX25519PublicKey,
      devicePopPublicKey: pop.publicJwk.x,
    }),
  });
  assert.equal(bootRes.status, 200, "bootstrap should succeed");
  const boot = await bootRes.json();
  assert.ok(boot.jwt && boot.jwt.split(".").length === 3, "bootstrap returns a 3-part JWT");
  console.log("ok - /bootstrap returned a valid JWT");

  // 4. /nats-user (session-gated).
  const credsRes = await fetch(`${BASE}/nats-user`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${session.token}` },
    body: JSON.stringify({}),
  });
  assert.equal(credsRes.status, 200, "nats-user should succeed");
  const creds = await credsRes.json();
  assert.ok(creds.userJwt && creds.userSeedRaw, "nats-user returns userJwt + userSeedRaw");
  console.log("ok - /nats-user returned browser creds");

  // 5. construct the real client + observe the sequence.
  const events = [];
  let connectedAt = null;
  let terminal = null;
  const terminalReached = new Promise((resolve) => {
    client = new WebChannelNATSClient({
      natsUrl: boot.natsUrl ?? creds.natsUrl,
      bootstrapJwt: boot.jwt,
      accountId: session.accountId,
      tenant: session.tenant,
      peerId: boot.peerId,
      natsCredentials: { userJwt: creds.userJwt, userSeedRaw: creds.userSeedRaw },
      registration: {
        devicePrivateKey: pop.privateKey,
        deviceX25519PrivateKey: x25519.privateKey,
      },
    });
    client.subscribe((state) => {
      const t = Date.now();
      events.push({ t, status: state.status, error: state.error });
      if (state.status === "connected" && connectedAt === null) connectedAt = t;
      if (state.status === "error") {
        terminal = { t, state };
        resolve();
      }
    });
    client.connect();
  });

  // Wait for the terminal error (bounded).
  await Promise.race([
    terminalReached,
    new Promise((_, rej) => setTimeout(() => rej(new Error("no terminal state within 30s")), 30_000)),
  ]);

  // ① connected reached.
  assert.ok(connectedAt !== null, "① should reach status 'connected'");
  console.log("ok - ① reached status 'connected'");

  // ② terminal error after connected, ~>=10s later, exact message.
  assert.ok(terminal, "② should reach a terminal 'error' state");
  const gapMs = terminal.t - connectedAt;
  assert.ok(
    gapMs >= 10_000,
    `② terminal error should arrive >=10s after connected (was ${gapMs}ms) — proves a register attempt was in flight`,
  );
  assert.equal(
    terminal.state.error,
    "[nats-client] request timeout",
    `② terminal message should be the register timeout (was: ${terminal.state.error})`,
  );
  console.log(`ok - ② terminal 'error' ${gapMs}ms after connected, message = "${terminal.state.error}"`);

  // ③ classify.
  const ui = classify(terminal.state);
  assert.equal(ui, "waiting-for-agent", `③ classify should be 'waiting-for-agent' (was ${ui})`);
  console.log("ok - ③ classify(state) === 'waiting-for-agent'");

  console.log("\nSMOKE PASSED — observed sequence:");
  for (const e of events) {
    console.log(`  +${e.t - events[0].t}ms  status=${e.status}${e.error ? ` error="${e.error}"` : ""}`);
  }
} finally {
  try {
    client?.close();
  } catch {
    /* ignore */
  }
  // SIGTERM (not SIGKILL) so index.ts's shutdown handler runs and reaps the child
  // nats-server — otherwise it's orphaned and the next smoke run collides. Wait
  // briefly for a clean exit, then fall back to SIGKILL only if it lingers.
  if (server && server.exitCode === null) {
    await new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      server.once("exit", done);
      const timer = setTimeout(() => {
        try {
          server.kill("SIGKILL");
        } catch {
          /* ignore */
        }
        done();
      }, 5000);
      try {
        server.kill("SIGTERM");
      } catch {
        done();
      }
    });
  }
}
