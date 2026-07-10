/**
 * E2E session helpers — the agent-side glue between the X25519 handshake and the
 * MessageEnvelope v1 codec.
 *
 * This module is the single place the production `NatsChannel` (encrypt-by-
 * construction mode) goes to:
 *  - derive a per-peer conversation key from an X25519 ECDH exchange, and
 *  - seal / open structured JSON messages as `MessageEnvelope` v1 wire frames
 *    bound by the canonical AAD.
 *
 * It deliberately reuses the proven primitives (`e2e-crypto.ts`,
 * `e2e-envelope.ts`) and the same handshake frame shape + KDF info string the
 * live E2E gate exercises (`e2e-roundtrip-agent.ts` ↔ `e2e-browser-client.ts`),
 * so the production channel speaks the identical wire protocol.
 */

import { randomBytes } from "node:crypto";

import { deriveSharedSecret, hkdfSha256 } from "./e2e-crypto.js";
import {
  encodeEnvelope,
  decryptEnvelopeContent,
  serializeEnvelope,
  deserializeEnvelope,
  getEnvelopeRouting,
  canonicalAad,
} from "./e2e-envelope.js";
import type { EnvelopeRouting, EnvelopeType } from "./e2e-envelope.js";

/**
 * HKDF `info` string for the conversation key. MUST match the browser
 * (`e2e-browser-client.ts`) and the live gate agent (`e2e-roundtrip-agent.ts`)
 * — both derive `hkdfSha256(sharedSecret, null, "webchannel-conversation-v1", 32)`.
 */
export const CONVERSATION_KDF_INFO = "webchannel-conversation-v1";

/** Stable routing identity shared by every envelope a peer session emits. */
export type SessionRouting = {
  readonly accountId: string;
  readonly tenant: string;
  /** JWT `sub` — equal to the peerId in the WebChannel subject grammar. */
  readonly sub: string;
};

/**
 * Derive the 32-byte ChaCha20-Poly1305 conversation key from an X25519 ECDH
 * exchange + HKDF-SHA256. Symmetric: agent and browser compute the same key.
 */
export function deriveConversationKey(
  myPrivateKey: Uint8Array,
  theirPublicKey: Uint8Array,
): Uint8Array {
  const rawSecret = deriveSharedSecret(myPrivateKey, theirPublicKey);
  return hkdfSha256(rawSecret, null, CONVERSATION_KDF_INFO, 32);
}

/**
 * Build the `{type:"key_exchange", pubKey}` handshake frame as a JSON string,
 * with the public key base64url-encoded (the wire shape both ends expect).
 */
export function keyExchangeFrame(publicKey: Uint8Array): string {
  return JSON.stringify({
    type: "key_exchange",
    pubKey: Buffer.from(publicKey).toString("base64url"),
  });
}

/**
 * Parse a handshake frame payload. Returns the peer's raw 32-byte X25519 public
 * key, or `null` if the payload is not a valid `key_exchange` frame.
 */
export function parseKeyExchange(payload: Buffer | Uint8Array): Uint8Array | null {
  try {
    const text = Buffer.isBuffer(payload)
      ? payload.toString("utf8")
      : Buffer.from(payload).toString("utf8");
    const frame = JSON.parse(text) as { type?: unknown; pubKey?: unknown };
    if (frame.type !== "key_exchange" || typeof frame.pubKey !== "string" || !frame.pubKey) {
      return null;
    }
    const raw = new Uint8Array(Buffer.from(frame.pubKey, "base64url"));
    // An X25519 public key is exactly 32 bytes. A non-32-byte key would throw
    // synchronously deep in `deriveSharedSecret` → `createPublicKey` (the SPKI
    // header hard-codes a 32-byte key), so reject it HERE — a malformed key is
    // an ignorable frame, same as bad JSON.
    if (raw.length !== 32) {
      return null;
    }
    return raw;
  } catch {
    return null;
  }
}

/**
 * Encrypt a structured message into a serialized `MessageEnvelope` v1 frame.
 *
 * The message object is JSON-serialized and becomes the ChaCha20-Poly1305
 * plaintext; routing metadata stays plaintext and is bound as the canonical AAD.
 */
export function sealEnvelope(
  routing: SessionRouting,
  key: Uint8Array,
  message: unknown,
  envelopeType: EnvelopeType = "conversation",
): Buffer {
  const fullRouting: EnvelopeRouting = {
    accountId: routing.accountId,
    tenant: routing.tenant,
    sub: routing.sub,
    messageId: randomBytes(8).toString("hex"),
    envelopeType,
    ts: Date.now(),
  };
  const aad = canonicalAad(fullRouting);
  const envelope = encodeEnvelope(fullRouting, JSON.stringify(message), key, aad);
  return serializeEnvelope(envelope);
}

/**
 * Decrypt and parse a `MessageEnvelope` v1 frame back into its structured
 * message object. Throws on malformed/undecryptable frames (wrong key, tampered
 * ciphertext, or AAD mismatch) — callers MUST treat a throw as "drop".
 */
export function openEnvelope(
  payload: Buffer | Uint8Array,
  key: Uint8Array,
): { routing: EnvelopeRouting; message: unknown } {
  const envelope = deserializeEnvelope(Buffer.isBuffer(payload) ? payload : Buffer.from(payload));
  const routing = getEnvelopeRouting(envelope);
  const aad = canonicalAad(routing);
  const plaintext = decryptEnvelopeContent(envelope, key, aad);
  const message = JSON.parse(Buffer.from(plaintext).toString("utf8")) as unknown;
  return { routing, message };
}
