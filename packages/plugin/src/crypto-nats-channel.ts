/**
 * CryptoNatsChannel — E2E encrypted NATS channel (Sub-AC 2).
 *
 * Integrates the e2e-envelope crypto codec into the NATS-WebSocket chat
 * message send/receive path so that:
 *
 *  • Outbound (send): plaintext → encodeEnvelope → serializeEnvelope → transport.publish
 *  • Inbound  (recv): NatsMessage → deserializeEnvelope → decryptEnvelopeContent → 'message' event
 *
 * The NATS relay operator (or any on-wire observer) sees only the
 * `MessageEnvelope` wire format, which contains only base64url-encoded
 * ChaCha20-Poly1305 ciphertext in its `content` block — never any plaintext.
 * Routing metadata (accountId / tenant / sub / messageId / envelopeType / ts)
 * remain as plaintext for NATS subject routing and account isolation.
 *
 * Security model
 * ──────────────
 * This class is the boundary between the plaintext application layer and the
 * ciphertext transport layer.  Callers above this class work with plaintext;
 * the NATS bus below sees only ciphertext envelopes.
 *
 * Usage pattern
 * ─────────────
 *   // Both agent and browser complete an X25519 key exchange first.
 *   const agentKP   = generateKeyPair();
 *   const browserKP = generateKeyPair();
 *   const sessionKey = hkdfSha256(
 *     deriveSharedSecret(agentKP.privateKey, browserKP.publicKey),
 *     null, 'webchannel-conversation-v1', 32
 *   );
 *
 *   // Wrap the transport with the crypto layer.
 *   const channel = new CryptoNatsChannel(transport, sessionKey, {
 *     accountId: 'acct-1', tenant: 'acme', sub: 'user-42',
 *   });
 *
 *   // Send (auto-encrypts):
 *   channel.sendMessage('chat.acme.agent-1.user-42.out', 'Hello browser!', {
 *     envelopeType: 'conversation',
 *   });
 *
 *   // Receive (auto-decrypts):
 *   channel.on('message', (msg: DecryptedMessage) => {
 *     console.log(new TextDecoder().decode(msg.plaintext));
 *   });
 */

import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";

import type { NatsTransport, NatsMessage } from "./nats-transport.js";
import {
  encodeEnvelope,
  decryptEnvelopeContent,
  serializeEnvelope,
  deserializeEnvelope,
  getEnvelopeRouting,
} from "./e2e-envelope.js";
import type { EnvelopeRouting, MessageEnvelope } from "./e2e-envelope.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * A fully-decrypted message delivered to `CryptoNatsChannel` 'message' event
 * listeners. The plaintext is ready for application-level processing; no
 * further decryption is required.
 */
export type DecryptedMessage = {
  /** NATS subject the message arrived on. */
  readonly subject: string;
  /** Decrypted plaintext bytes (the original content passed to `sendMessage`). */
  readonly plaintext: Uint8Array;
  /** Plaintext routing metadata extracted from the envelope (no key required). */
  readonly routing: EnvelopeRouting;
  /**
   * The raw `MessageEnvelope` (ciphertext form) for callers that need to
   * inspect or store the at-rest encrypted form.
   */
  readonly envelope: MessageEnvelope;
};

/**
 * Routing fields that every message published by this channel instance will
 * inherit. The caller provides the stable, session-level fields; per-message
 * fields (`messageId`, `ts`) are generated automatically.
 */
export type ChannelRoutingDefaults = Omit<EnvelopeRouting, "messageId" | "ts" | "envelopeType">;

// ---------------------------------------------------------------------------
// CryptoNatsChannel
// ---------------------------------------------------------------------------

/**
 * E2E-encrypted NATS channel.
 *
 * Wraps a `NatsTransport` and transparently encrypts all outbound payloads and
 * decrypts all inbound payloads using the `e2e-envelope` codec
 * (X25519+HKDF-SHA256+ChaCha20-Poly1305).
 *
 * Events:
 *  - `'message'` (DecryptedMessage): a new inbound message has been
 *     decrypted and is ready for application-level processing.
 *  - `'error'`   (Error): deserialization or decryption failure on an inbound
 *     message. The channel remains usable; only the offending message is
 *     dropped (this is consistent with the "relay operator sees garbage if
 *     they try to inject" security model — invalid envelopes are silently
 *     rejected by the crypto layer).
 */
export class CryptoNatsChannel extends EventEmitter {
  private readonly transport: NatsTransport;
  private readonly sessionKey: Uint8Array;
  private readonly routingDefaults: ChannelRoutingDefaults;

  /**
   * @param transport      - A connected (or pre-connection-pending) NatsTransport.
   * @param sessionKey     - 32-byte ChaCha20-Poly1305 session key derived from
   *                         the X25519 ECDH key exchange + HKDF-SHA256.
   * @param routingDefaults - Stable routing fields shared by all messages this
   *                         channel sends (accountId, tenant, sub).
   */
  constructor(
    transport: NatsTransport,
    sessionKey: Uint8Array,
    routingDefaults: ChannelRoutingDefaults,
  ) {
    super();
    this.transport = transport;
    this.sessionKey = sessionKey;
    this.routingDefaults = routingDefaults;

    // Wire up the auto-decrypt receive path.
    // Every NatsMessage the underlying transport delivers will be treated as a
    // MessageEnvelope and decrypted before re-emitting to application listeners.
    transport.on("message", (msg: NatsMessage) => this._handleInbound(msg));
  }

  // ---------------------------------------------------------------------------
  // Outbound — send (encrypt → publish)
  // ---------------------------------------------------------------------------

  /**
   * Encrypt `plaintext` and publish it as a `MessageEnvelope` to `subject`.
   *
   * The on-wire payload is a JSON-serialized `MessageEnvelope` whose `content`
   * block contains ONLY base64url-encoded ciphertext (nonce / ciphertext / tag).
   * No part of `plaintext` appears on the wire.
   *
   * @param subject        - NATS subject to publish to (plaintext routing metadata).
   * @param plaintext      - Message content to encrypt (UTF-8 string or raw bytes).
   * @param routingOverrides - Optional per-message routing overrides.
   *                          `messageId` defaults to a random 8-byte hex string.
   *                          `ts` defaults to `Date.now()`.
   *                          `envelopeType` defaults to `'conversation'`.
   * @param aad            - Optional additional authenticated data
   *                         (e.g. `approvalId` for approval messages). The same
   *                         `aad` MUST be passed to the receiving side's
   *                         `decryptEnvelopeContent` call (or the matching
   *                         CryptoNatsChannel if it is extended to support per-
   *                         message AAD). NOT stored in the envelope.
   */
  sendMessage(
    subject: string,
    plaintext: string | Uint8Array,
    routingOverrides?: Partial<Pick<EnvelopeRouting, "messageId" | "ts" | "envelopeType">>,
    aad?: Uint8Array,
  ): void {
    const routing: EnvelopeRouting = {
      ...this.routingDefaults,
      messageId: routingOverrides?.messageId ?? randomBytes(8).toString("hex"),
      ts: routingOverrides?.ts ?? Date.now(),
      envelopeType: routingOverrides?.envelopeType ?? "conversation",
    };

    const plaintextBytes: Uint8Array =
      typeof plaintext === "string"
        ? new TextEncoder().encode(plaintext)
        : plaintext;

    const envelope = encodeEnvelope(routing, plaintextBytes, this.sessionKey, aad);
    const wireBytes = serializeEnvelope(envelope);
    this.transport.publish(subject, wireBytes);
  }

  // ---------------------------------------------------------------------------
  // Inbound — receive (deserialize → decrypt → emit)
  // ---------------------------------------------------------------------------

  /**
   * Handle a raw `NatsMessage` from the underlying transport.
   *
   * Deserializes the `MessageEnvelope`, decrypts the content block, and
   * emits a `'message'` event with the decrypted `DecryptedMessage`. On any
   * deserialization or decryption error, emits `'error'` and drops the message.
   *
   * @internal
   */
  private _handleInbound(msg: NatsMessage): void {
    let env: MessageEnvelope;
    try {
      env = deserializeEnvelope(msg.payload);
    } catch (err) {
      this.emit(
        "error",
        new Error(
          `CryptoNatsChannel: failed to deserialize envelope on subject "${msg.subject}": ${String(err)}`,
        ),
      );
      return;
    }

    let plaintext: Uint8Array;
    try {
      plaintext = decryptEnvelopeContent(env, this.sessionKey);
    } catch (err) {
      this.emit(
        "error",
        new Error(
          `CryptoNatsChannel: decryption failed on subject "${msg.subject}" (wrong key or tampered message): ${String(err)}`,
        ),
      );
      return;
    }

    const decrypted: DecryptedMessage = {
      subject: msg.subject,
      plaintext,
      routing: getEnvelopeRouting(env),
      envelope: env,
    };
    this.emit("message", decrypted);
  }

  // ---------------------------------------------------------------------------
  // Transport delegation — subscribe / unsubscribe / connected
  // ---------------------------------------------------------------------------

  /**
   * Subscribe to a NATS subject. Inbound messages are delivered via the
   * `'message'` event (decrypted). Returns the numeric sid for `unsubscribe`.
   */
  subscribe(subject: string): number {
    return this.transport.subscribe(subject);
  }

  /** Unsubscribe by sid (from `subscribe()`). */
  unsubscribe(sid: number): void {
    this.transport.unsubscribe(sid);
  }

  /** `true` when the underlying NatsTransport has completed the NATS handshake. */
  get connected(): boolean {
    return this.transport.connected;
  }
}
