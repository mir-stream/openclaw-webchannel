/**
 * E2E Round-Trip Agent — encrypted echo agent for the live E2E gate.
 *
 * This module wires up the agent-side of the encrypted round-trip test:
 *  - Connects NatsTransport to a real nats-server
 *  - Handles X25519 key exchange via handshake subject
 *  - Decrypts inbound MessageEnvelope v1 content (ChaCha20-Poly1305)
 *  - Processes the message through the echo kernel (in-repo echo model provider)
 *  - Encrypts the reply using canonical AAD and publishes to outbound subject
 *
 * Echo kernel: `dispatchEchoReply` is the deterministic in-repo echo model
 * provider per the Seed specification. It replaces the LLM dispatch path with
 * a simple echo, while keeping ALL surrounding infrastructure (envelope codec,
 * NATS transport, AAD binding) production-identical.
 *
 * AAD binding: BOTH browser and agent compute
 *   canonicalAad = UTF-8(JSON.stringify({tenant, accountId, sub, messageId, envelopeType, ts}))
 * using the SAME key order. An AAD mismatch fails decryption.
 */

import { randomBytes } from "node:crypto";

import { NatsTransport } from "./nats-transport.js";
import {
  generateKeyPair,
  deriveSharedSecret,
  hkdfSha256,
} from "./e2e-crypto.js";
import {
  deserializeEnvelope,
  getEnvelopeRouting,
  encodeEnvelope,
  decryptEnvelopeContent,
  serializeEnvelope,
} from "./e2e-envelope.js";
import type { EnvelopeRouting } from "./e2e-envelope.js";
import type { NatsMessage } from "./nats-transport.js";

// ---------------------------------------------------------------------------
// Canonical AAD (must match browser-side canonicalAad in e2e-browser-client.ts)
// ---------------------------------------------------------------------------

/**
 * Canonical AAD binding for a message envelope.
 *
 * AAD = UTF-8 bytes of JSON-serialized routing metadata with FIXED key order:
 *   {tenant, accountId, sub, messageId, envelopeType, ts}
 *
 * An AAD mismatch causes ChaCha20-Poly1305 decryption to throw. Both browser
 * and agent MUST derive AAD from the SAME fields in the SAME key order.
 *
 * This is the canonical AAD binding described in the Seed specification.
 */
export function canonicalAad(routing: EnvelopeRouting): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      tenant:       routing.tenant,
      accountId:    routing.accountId,
      sub:          routing.sub,
      messageId:    routing.messageId,
      envelopeType: routing.envelopeType,
      ts:           routing.ts,
    }),
  );
}

// ---------------------------------------------------------------------------
// E2E Round-trip agent configuration
// ---------------------------------------------------------------------------

export type E2EAgentOptions = {
  /** WebSocket URL of the NATS server, e.g. ws://127.0.0.1:18091 */
  natsUrl: string;
  /** Subject namespace routing fields */
  tenant: string;
  accountId: string;
  /**
   * Optional pre-shared 32-byte session key.
   * When provided, the agent skips X25519 key exchange and uses this key
   * directly. Used for transport-layer verification tests that don't need to
   * exercise the key exchange protocol.
   */
  preSharedKey?: Uint8Array;
  /** Echo prefix (default: "echo: ") */
  echoPrefix?: string;
  /**
   * NATS user JWT for enrolled-JWT mode.
   * When provided (along with nkeySigningCallback), the agent authenticates
   * with the NATS server using JWT + NKEY challenge-response.
   * Omit for open/dev-NATS mode.
   */
  jwtCredential?: string;
  /**
   * NKEY challenge-response signing callback for enrolled-JWT mode.
   *
   * Receives the server nonce and returns a base64url-encoded Ed25519 signature.
   * Must be provided when jwtCredential is set.
   *
   * Example (using @nats-io/nkeys in packages/saas or e2e tests):
   *   const kp = fromSeed(new TextEncoder().encode(userSeed));
   *   nkeySigningCallback: (nonce) =>
   *     Promise.resolve(Buffer.from(kp.sign(new TextEncoder().encode(nonce))).toString("base64url"))
   */
  nkeySigningCallback?: (nonce: string) => Promise<string>;
};

/** Handle returned by `startE2EAgent`. Use `stop()` to teardown. */
export type E2EAgentHandle = {
  transport: NatsTransport;
  /** Call to disconnect and clean up. */
  stop: () => void;
};

// ---------------------------------------------------------------------------
// Start the E2E echo agent
// ---------------------------------------------------------------------------

/**
 * Start an E2E echo agent:
 *
 * 1. Connects to the open NATS server
 * 2. Subscribes to ALL peer inbound subjects (`*.in`) and handshake subjects
 * 3. On handshake message: performs X25519 ECDH key exchange
 * 4. On inbound message: decrypts with canonical AAD → echoes reply → encrypts
 *
 * Returns an `E2EAgentHandle` for teardown via `handle.stop()`.
 */
export async function startE2EAgent(opts: E2EAgentOptions): Promise<E2EAgentHandle> {
  const { tenant, accountId, echoPrefix = "echo: " } = opts;

  const transport = new NatsTransport({
    url: opts.natsUrl,
    clientName: "e2e-echo-agent",
    jwtCredential: opts.jwtCredential,
    nkeySigningCallback: opts.nkeySigningCallback,
  });
  await transport.connect();

  // NATS subject patterns
  const inboundWildcard   = `webchannel.${tenant}.${accountId}.*.in`;
  const handshakeWildcard = `webchannel.${tenant}.${accountId}.*.handshake`;

  // Subscribe to inbound messages from any peer
  transport.subscribe(inboundWildcard);

  // Map peerId → established session key (populated after key exchange)
  const peerKeys = new Map<string, Uint8Array>();

  // Agent X25519 key pair (only generated when key exchange is needed)
  const agentKP = opts.preSharedKey ? null : generateKeyPair();

  // Subscribe to handshake subjects when using X25519 key exchange
  let handshakeSid: number | null = null;
  if (!opts.preSharedKey && agentKP) {
    handshakeSid = transport.subscribe(handshakeWildcard);
  }

  // ---------------------------------------------------------------------------
  // Unified message handler
  // ---------------------------------------------------------------------------
  transport.on("message", (msg: NatsMessage) => {
    // Determine message type from subject suffix
    const parts = msg.subject.split(".");
    const suffix = parts[parts.length - 1];      // "in", "out", "handshake"
    const peerId = parts[3] ?? "";               // webchannel.{tenant}.{accountId}.{peerId}.*

    if (!peerId) return;

    if (suffix === "handshake" && agentKP) {
      handleHandshake(msg, peerId);
    } else if (suffix === "in") {
      void handleInbound(msg, peerId);
    }
  });

  // ---------------------------------------------------------------------------
  // Handshake: receive browser public key → send agent public key → store session key
  // ---------------------------------------------------------------------------
  function handleHandshake(msg: NatsMessage, peerId: string): void {
    if (!agentKP) return;
    try {
      const frame = JSON.parse(msg.payload.toString("utf8")) as {
        type?: string;
        pubKey?: string;
      };
      if (frame.type !== "key_exchange" || !frame.pubKey) return;

      // Derive shared secret from browser's public key
      const browserPubKey = new Uint8Array(Buffer.from(frame.pubKey, "base64url"));
      const rawSecret = deriveSharedSecret(agentKP.privateKey, browserPubKey);
      const sessionKey = hkdfSha256(rawSecret, null, "webchannel-conversation-v1", 32);
      peerKeys.set(peerId, sessionKey);

      // Respond with agent's public key on the SAME handshake subject
      const agentPubKeyB64 = Buffer.from(agentKP.publicKey).toString("base64url");
      transport.publish(
        `webchannel.${tenant}.${accountId}.${peerId}.handshake`,
        JSON.stringify({ type: "key_exchange", pubKey: agentPubKeyB64 }),
      );
    } catch {
      // Ignore malformed handshake
    }
  }

  // ---------------------------------------------------------------------------
  // Inbound: decrypt → echo kernel → encrypt reply → publish
  // ---------------------------------------------------------------------------
  async function handleInbound(msg: NatsMessage, peerId: string): Promise<void> {
    // Resolve session key
    const sessionKey = opts.preSharedKey ?? peerKeys.get(peerId);
    if (!sessionKey) return; // Key exchange not yet completed
    // --- Deserialize envelope ---
    let envelope;
    try {
      envelope = deserializeEnvelope(msg.payload);
    } catch {
      return; // Not a valid MessageEnvelope v1
    }

    // --- Decrypt with canonical AAD binding ---
    const routing = getEnvelopeRouting(envelope);
    const aad = canonicalAad(routing);
    let plaintextBytes: Uint8Array;
    try {
      plaintextBytes = decryptEnvelopeContent(envelope, sessionKey, aad);
    } catch {
      return; // Decryption failure (wrong key, tampered envelope, AAD mismatch)
    }

    // --- Extract user text (plaintext is JSON: {type, text}) ---
    const plaintextStr = Buffer.from(plaintextBytes).toString("utf8");
    let userText = plaintextStr;
    try {
      const parsed = JSON.parse(plaintextStr) as { text?: string };
      if (parsed.text) userText = parsed.text;
    } catch { /* use raw text */ }

    // --- Echo kernel (in-repo deterministic model provider) ---
    const replyText = `${echoPrefix}${userText}`;

    // --- Construct reply routing ---
    const replyRouting: EnvelopeRouting = {
      accountId:    routing.accountId,
      tenant:       routing.tenant,
      sub:          routing.sub,
      messageId:    randomBytes(8).toString("hex"),
      envelopeType: "conversation",
      ts:           Date.now(),
    };

    // --- Encrypt reply with canonical AAD ---
    const replyAad = canonicalAad(replyRouting);
    const replyEnvelope = encodeEnvelope(replyRouting, replyText, sessionKey, replyAad);
    const replyWire = serializeEnvelope(replyEnvelope);

    // --- Publish to outbound subject ---
    transport.publish(`webchannel.${tenant}.${accountId}.${peerId}.out`, replyWire);
  }

  return {
    transport,
    stop(): void {
      if (handshakeSid !== null) transport.unsubscribe(handshakeSid);
      transport.disconnect();
    },
  };
}
