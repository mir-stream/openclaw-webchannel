/**
 * Runtime state-sequence smoke — no-agent transient recovery.
 *
 * Boots the SaaS backend (which boots nats-server), logs in, mints a bootstrap
 * JWT + browser NATS creds through the PUBLIC HTTP surface, constructs a real
 * WebChannelNATSClient with `registration`, and asserts the SEQUENCE:
 *
 *   ① reaches status "connected"
 *   ② after the bounded register timeout, the client enters "reconnecting"
 *      rather than a terminal error (agent-offline is transient), and
 *   ③ the app classifier reflects that retrying state.
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
  ENROLLMENT_ADMIN_TOKEN: "smoke-enrollment-admin",
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

  // Pin a known active agent identity for the server-owned fixed tuple, plus a
  // different key in another tuple. `/bootstrap` must select the fixed tuple's
  // registry value, never a caller body value or the other account's key.
  const publicX25519 = async () => {
    const pair = await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"]);
    return b64url(await crypto.subtle.exportKey("raw", pair.publicKey));
  };
  const fixedAgentPublicKey = await publicX25519();
  const otherTuplePublicKey = await publicX25519();
  const callerChosenPublicKey = await publicX25519();
  const enrollAndApprove = async (accountId, agentPublicKey) => {
    const enrollRes = await fetch(`${BASE}/api/enroll`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tenant: session.tenant, accountId, agentPublicKey }),
    });
    assert.equal(enrollRes.status, 200, `enroll ${accountId} should succeed`);
    const enrolled = await enrollRes.json();
    assert.ok(enrolled.user_code, `enroll ${accountId} returns user_code`);
    const approveRes = await fetch(`${BASE}/admin/enrollments/${enrolled.user_code}/approve`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer smoke-enrollment-admin",
      },
      body: "{}",
    });
    assert.equal(approveRes.status, 200, `approve ${accountId} should succeed`);
  };
  await enrollAndApprove(session.accountId, fixedAgentPublicKey);
  await enrollAndApprove("other-account", otherTuplePublicKey);

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
      agentPublicKey: callerChosenPublicKey,
      deviceX25519PublicKey,
      devicePopPublicKey: pop.publicJwk.x,
    }),
  });
  assert.equal(bootRes.status, 200, "bootstrap should succeed");
  const boot = await bootRes.json();
  assert.ok(boot.jwt && boot.jwt.split(".").length === 3, "bootstrap returns a 3-part JWT");
  assert.equal(boot.agentPublicKey, fixedAgentPublicKey, "bootstrap returns the fixed tuple's active registry pin");
  assert.notEqual(boot.agentPublicKey, callerChosenPublicKey, "bootstrap ignores a caller-chosen pin");
  assert.notEqual(boot.agentPublicKey, otherTuplePublicKey, "bootstrap does not cross-read another tuple's pin");
  const claims = JSON.parse(Buffer.from(boot.jwt.split(".")[1], "base64url").toString("utf8"));
  assert.equal(claims.aud, session.accountId, "signed aud is the session-authorized scalar account");
  assert.equal(claims.tenant, session.tenant, "signed tenant is the server-owned session tenant");
  assert.equal("accountId" in claims, false, "JWT has no duplicate accountId claim");
  const wrongTarget = await fetch(`${BASE}/bootstrap`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${session.token}` },
    body: JSON.stringify({
      accountId: "caller-chosen-account",
      deviceX25519PublicKey,
      devicePopPublicKey: pop.publicJwk.x,
    }),
  });
  assert.equal(wrongTarget.status, 403, "bootstrap rejects a caller-selected target");
  const wrongTenant = await fetch(`${BASE}/bootstrap`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${session.token}` },
    body: JSON.stringify({
      tenant: "caller-chosen-tenant",
      accountId: session.accountId,
      deviceX25519PublicKey,
      devicePopPublicKey: pop.publicJwk.x,
    }),
  });
  assert.equal(wrongTenant.status, 403, "bootstrap rejects a caller-selected tenant");
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
  let reconnecting = null;
  let terminal = null;
  const retryReached = new Promise((resolve) => {
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
        pinnedAgentPublicKey: boot.agentPublicKey,
      },
    });
    client.subscribe((state) => {
      const t = Date.now();
      events.push({ t, status: state.status, error: state.error });
      if (state.status === "connected" && connectedAt === null) connectedAt = t;
      if (state.status === "error") {
        terminal = { t, state };
      }
      if (state.status === "reconnecting" && connectedAt !== null) {
        reconnecting = { t, state };
        resolve();
      }
    });
    client.connect();
  });

  // Wait for the first transient register recovery (bounded).
  await Promise.race([
    retryReached,
    new Promise((_, rej) => setTimeout(() => rej(new Error("no reconnecting state within 30s")), 30_000)),
  ]);

  // ① connected reached.
  assert.ok(connectedAt !== null, "① should reach status 'connected'");
  console.log("ok - ① reached status 'connected'");

  // ② registration timeout is transient: reconnect after the bounded attempts.
  assert.equal(terminal, null, "② agent-offline timeout must not retire the client");
  assert.ok(reconnecting, "② should enter 'reconnecting'");
  const gapMs = reconnecting.t - connectedAt;
  assert.ok(
    gapMs >= 10_000,
    `② reconnect should arrive >=10s after connected (was ${gapMs}ms) — proves bounded register attempts ran`,
  );
  console.log(`ok - ② transient register timeout triggered reconnect after ${gapMs}ms`);

  // ③ classify.
  const ui = classify(reconnecting.state);
  assert.equal(ui, "reconnecting", `③ classify should be 'reconnecting' (was ${ui})`);
  console.log("ok - ③ classify(state) === 'reconnecting'");

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
