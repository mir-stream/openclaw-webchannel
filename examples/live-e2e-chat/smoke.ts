/**
 * Headless end-to-end smoke — proves the WHOLE path without a browser.
 *
 * It boots a real nats-server + the real agent, then plays the browser role
 * using the SAME browser modules the real UI uses (web/e2e-crypto, web/e2e-
 * envelope, web/nats-ws). If a typed message comes back decrypted, the live
 * E2E chat works.
 *
 * Run: npm run smoke  (from examples/live-e2e-chat)
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { generateKeyPair, deriveSharedSecret, hkdfSha256 } from "./web/e2e-crypto.js";
import {
  encodeEnvelope,
  decryptEnvelopeContent,
  serializeEnvelope,
  deserializeEnvelope,
} from "./web/e2e-envelope.js";
import { NatsWsClient } from "./web/nats-ws.js";
import {
  NATS_WS_URL,
  TENANT,
  AGENT_ID,
  PEER_ID,
  inboundSubject,
  outboundSubject,
  handshakeSubject,
  type HandshakeMessage,
} from "./protocol.js";

const HKDF_INFO = "webchannel-conversation-v1";
const __dirname = dirname(fileURLToPath(import.meta.url));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (...a: unknown[]) => console.log("[smoke]", ...a);

let nats: ChildProcess | null = null;
let agent: ChildProcess | null = null;

function cleanup() {
  agent?.kill("SIGKILL");
  nats?.kill("SIGKILL");
}

async function waitForLog(child: ChildProcess, needle: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for "${needle}"`)), timeoutMs);
    const onData = (b: Buffer) => {
      if (b.toString().includes(needle)) {
        clearTimeout(timer);
        child.stdout?.off("data", onData);
        child.stderr?.off("data", onData);
        resolve();
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
  });
}

async function main() {
  // 1. Boot nats-server with the demo websocket config.
  nats = spawn("nats-server", ["-c", join(__dirname, "nats.conf")], { stdio: ["ignore", "pipe", "pipe"] });
  await waitForLog(nats, "Server is ready", 8000).catch(() => {
    throw new Error("nats-server failed to start (is it installed? `brew install nats-server`)");
  });
  log("nats-server up (ws://127.0.0.1:8087)");

  // 2. Boot the real agent (tsx — resolve local or hoisted to the workspace root).
  const tsx = [
    join(__dirname, "node_modules", ".bin", "tsx"),
    join(__dirname, "..", "..", "node_modules", ".bin", "tsx"),
  ].find(existsSync);
  if (!tsx) throw new Error("tsx binary not found (run `npm install`)");
  agent = spawn(tsx, [join(__dirname, "agent", "agent.ts")], { stdio: ["ignore", "pipe", "pipe"] });
  agent.stdout?.on("data", (b) => process.stdout.write(b));
  agent.stderr?.on("data", (b) => process.stderr.write(b));
  await waitForLog(agent, "waiting for a browser", 10000);
  log("agent up");

  // 3. Play the browser using the browser modules.
  const browser = generateKeyPair();
  let sessionKey: Uint8Array | null = null;
  const replies: string[] = [];

  const client = new NatsWsClient(NATS_WS_URL);
  const hs = handshakeSubject();
  const out = outboundSubject();
  const inbound = inboundSubject();

  client.onMessage((subject, payload) => {
    const raw = new TextDecoder().decode(payload);
    if (subject === hs) {
      const m: HandshakeMessage = JSON.parse(raw);
      if (m.type !== "handshake" || m.from !== "agent") return;
      const agentPub = Uint8Array.from(Buffer.from(m.publicKey, "base64url"));
      const shared = deriveSharedSecret(browser.privateKey, agentPub);
      sessionKey = hkdfSha256(shared, null, HKDF_INFO, 32);
      log("derived session key from agent handshake ack");
    } else if (subject === out) {
      if (!sessionKey) return;
      const env = deserializeEnvelope(raw);
      const text = new TextDecoder().decode(decryptEnvelopeContent(env, sessionKey));
      const obj = JSON.parse(text);
      log("decrypted agent reply:", JSON.stringify(obj.text));
      log("  …raw on-the-wire ciphertext was:", env.content.ciphertext.slice(0, 32) + "…");
      replies.push(obj.text);
    }
  });

  await client.connect();
  client.subscribe(hs);
  client.subscribe(out);
  log("browser connected + subscribed");

  // 4. Handshake (retry until the session key is set).
  const hello: HandshakeMessage = {
    type: "handshake",
    from: "browser",
    publicKey: Buffer.from(browser.publicKey).toString("base64url"),
  };
  for (let i = 0; i < 10 && !sessionKey; i++) {
    client.publish(hs, JSON.stringify(hello));
    await sleep(400);
  }
  if (!sessionKey) throw new Error("handshake never completed");

  // 5. Send an encrypted message; expect a decrypted reply.
  const msg = encodeEnvelope(
    { agentId: AGENT_ID, tenant: TENANT, sub: PEER_ID, messageId: crypto.randomUUID(), envelopeType: "conversation", ts: Date.now() },
    JSON.stringify({ text: "hello agent, are we encrypted?" }),
    sessionKey,
  );
  log("browser sends encrypted: \"hello agent, are we encrypted?\"");
  client.publish(inbound, serializeEnvelope(msg));

  for (let i = 0; i < 20 && replies.length === 0; i++) await sleep(200);
  client.close();

  if (replies.length === 0) throw new Error("no decrypted reply received");
  log(`\nE2E CHAT SMOKE PASSED ✅  (round-tripped ${replies.length} encrypted message)`);
}

main()
  .then(() => {
    cleanup();
    process.exit(0);
  })
  .catch((err) => {
    console.error("[smoke] FAILED ❌", err.message);
    cleanup();
    process.exit(1);
  });
