/**
 * Demo AGENT — the "server" side of the E2E chat.
 *
 * This process uses the plugin's REAL modules (no reimplementation):
 *   - NatsTransport       (packages/plugin/src/nats-transport.ts) — live NATS dial
 *   - e2e-crypto          (X25519 + HKDF-SHA256 + ChaCha20-Poly1305)
 *   - e2e-envelope        (the on-the-wire ciphertext envelope)
 *
 * Flow:
 *   1. connect to NATS over WebSocket
 *   2. subscribe to the handshake + inbound subjects
 *   3. on a browser handshake_hello: X25519-derive the session key, reply with
 *      the agent's own public key
 *   4. on an inbound envelope: decrypt → craft a reply → encrypt → publish
 *
 * The NATS operator (relay) only ever sees ciphertext + plaintext routing.
 */

import { NatsTransport, type NatsMessage } from "../../../packages/plugin/src/nats-transport.js";
import {
  generateKeyPair,
  deriveSharedSecret,
  hkdfSha256,
} from "../../../packages/plugin/src/e2e-crypto.js";
import {
  encodeEnvelope,
  decryptEnvelopeContent,
  serializeEnvelope,
  deserializeEnvelope,
} from "../../../packages/plugin/src/e2e-envelope.js";
import {
  NATS_WS_URL,
  AGENT_ID,
  TENANT,
  PEER_ID,
  inboundSubject,
  outboundSubject,
  handshakeSubject,
  type HandshakeMessage,
} from "../protocol.js";

const HKDF_INFO = "webchannel-conversation-v1";

const log = (...a: unknown[]) => console.log("[agent]", ...a);

async function main() {
  const identity = generateKeyPair();
  log("X25519 identity public key:", Buffer.from(identity.publicKey).toString("base64url"));

  const nats = new NatsTransport({ url: NATS_WS_URL, clientName: "demo-agent" });
  await nats.connect();
  log("connected to NATS at", NATS_WS_URL);

  let sessionKey: Uint8Array | null = null;

  const hs = handshakeSubject();
  const inbound = inboundSubject();
  const outbound = outboundSubject();
  nats.subscribe(hs);
  nats.subscribe(inbound);
  log("subscribed:", hs, "|", inbound);
  log("waiting for a browser to connect…");

  nats.on("message", (msg: NatsMessage) => {
    if (msg.subject === hs) {
      handleHandshake(msg.payload.toString("utf8"));
    } else if (msg.subject === inbound) {
      handleInbound(msg.payload.toString("utf8"));
    }
  });

  function handleHandshake(raw: string): void {
    let m: HandshakeMessage;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    if (m.type !== "handshake" || m.from !== "browser") return; // ignore our own ack

    const browserPub = new Uint8Array(Buffer.from(m.publicKey, "base64url"));
    const shared = deriveSharedSecret(identity.privateKey, browserPub);
    sessionKey = hkdfSha256(shared, null, HKDF_INFO, 32);
    log("handshake from browser → derived session key (X25519 + HKDF-SHA256)");

    const ack: HandshakeMessage = {
      type: "handshake",
      from: "agent",
      publicKey: Buffer.from(identity.publicKey).toString("base64url"),
    };
    nats.publish(hs, JSON.stringify(ack));
    log("sent handshake ack → session established");
  }

  function handleInbound(raw: string): void {
    if (!sessionKey) {
      log("inbound before handshake — ignoring");
      return;
    }
    let plaintext: string;
    try {
      const env = deserializeEnvelope(raw);
      plaintext = new TextDecoder().decode(decryptEnvelopeContent(env, sessionKey));
    } catch (err) {
      log("failed to decrypt inbound:", (err as Error).message);
      return;
    }
    const userText = parseText(plaintext);
    log("decrypted from browser:", JSON.stringify(userText));

    const replyText = reply(userText);
    const env = encodeEnvelope(
      {
        agentId: AGENT_ID,
        tenant: TENANT,
        sub: PEER_ID,
        messageId: crypto.randomUUID(),
        envelopeType: "conversation",
        ts: Date.now(),
      },
      JSON.stringify({ text: replyText }),
      sessionKey,
    );
    nats.publish(outbound, serializeEnvelope(env).toString("utf8"));
    log("encrypted reply → published to", outbound);
  }
}

function parseText(plaintext: string): string {
  try {
    const obj = JSON.parse(plaintext);
    if (obj && typeof obj.text === "string") return obj.text;
  } catch {
    /* fall through */
  }
  return plaintext;
}

/** A tiny canned "agent". The point of the demo is the encrypted transport. */
function reply(userText: string): string {
  const t = userText.trim().toLowerCase();
  if (/^(hi|hello|hey|안녕)/.test(t)) return "👋 Hi! This whole conversation is end-to-end encrypted over NATS.";
  if (t.includes("encrypt")) return "Yes — the relay only sees ChaCha20-Poly1305 ciphertext. Try the 'wire' panel.";
  if (t.includes("?")) return `Good question. (echo) You asked: "${userText}"`;
  return `Agent received (decrypted): "${userText}"`;
}

main().catch((err) => {
  console.error("[agent] fatal:", err);
  process.exit(1);
});
