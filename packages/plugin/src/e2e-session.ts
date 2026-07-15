/**
 * E2E session helpers for the MessageEnvelope v1 codec.
 *
 * This module is the single place the production `NatsChannel` (encrypt-by-
 * construction mode) goes to:
 *  - seal / open structured JSON messages as `MessageEnvelope` v1 wire frames
 *    bound by the canonical AAD.
 *
 * It deliberately reuses the proven primitives (`e2e-crypto.ts`,
 * `e2e-envelope.ts`) so the production channel and the browser client speak the
 * identical envelope wire protocol.
 */

import { randomBytes } from "node:crypto";

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
