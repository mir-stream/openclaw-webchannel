/**
 * Late-join envelope decryptor — Sub-AC 2b.
 *
 * Client-side (device-side) routine for late-join backlog decryption.
 *
 * Problem
 * ───────
 * A device that joins an existing conversation after some messages have already
 * been exchanged has missed live broadcasts.  The agent — the single authority
 * store — holds those messages as at-rest ciphertext envelopes.  To replay them,
 * the agent paginates the stored envelopes out over NATS (history subject).
 *
 * But ciphertext alone is not enough: the device also needs the conversation key
 * used to encrypt those envelopes.  That key is delivered out-of-band, wrapped
 * (encrypted) for the specific device's X25519 public key so that the NATS relay
 * operator never observes it in plaintext.
 *
 * Key-wrap scheme (X25519 ECDH + HKDF-SHA256 + ChaCha20-Poly1305)
 * ─────────────────────────────────────────────────────────────────
 *   Agent side (wrapConversationKey):
 *     1. Generate a fresh ephemeral X25519 key pair (ephemeralKP).
 *     2. ECDH: sharedSecret = X25519(ephemeralKP.private, device.publicKey).
 *     3. HKDF-SHA256: wrapKey = HKDF(sharedSecret, null, "webchannel-key-wrap-v1", 32).
 *     4. ChaCha20-Poly1305: {ciphertext, nonce, tag} = Encrypt(wrapKey, conversationKey).
 *     5. WrappedConversationKey = { ephemeralPublicKey, nonce, ciphertext, tag }.
 *
 *   Device side (unwrapConversationKey):
 *     1. ECDH: sharedSecret = X25519(device.privateKey, ephemeralPublicKey) — symmetric.
 *     2. HKDF-SHA256: wrapKey = HKDF(sharedSecret, null, "webchannel-key-wrap-v1", 32).
 *     3. ChaCha20-Poly1305: conversationKey = Decrypt(wrapKey, nonce, ciphertext, tag).
 *
 * Full late-join pipeline (decryptBacklog):
 *   1. Unwrap the conversation key from the WrappedConversationKey.
 *   2. For each envelope in the paginated backlog: decrypt with the recovered key.
 *   3. Return plaintext payloads in insertion order.
 *
 * Security invariants
 * ───────────────────
 *   • The conversation key never travels in plaintext over NATS or any public bus.
 *   • The wrapped key is targeted at exactly one device (ECDH binds to that
 *     device's public key); another device's private key cannot unwrap it.
 *   • The Poly1305 tag prevents undetected tampering of the wrapped key.
 *   • The ephemeral public key is freshly generated per wrap operation, providing
 *     forward secrecy for the key-distribution path (not for the conversation
 *     history itself — see Deferred below).
 *   • The device private key never leaves the device.
 *
 * Deferred
 * ────────
 *   • Message-level forward secrecy: the shared conversation key covers the
 *     entire backlog — compromise of the key exposes all stored messages.
 *     Per-message ratchets (e.g. Double Ratchet) are deferred (see Seed).
 *   • Key rotation / revocation rekey: rotating the conversation key and
 *     re-wrapping all stored envelopes is deferred.
 *   • Operator-keyless enterprise mode: deferred.
 */

import {
  generateKeyPair,
  deriveSharedSecret,
  hkdfSha256,
  encrypt,
  decrypt,
} from "./e2e-crypto.js";
import { decryptEnvelopeContent } from "./e2e-envelope.js";
import type { MessageEnvelope } from "./e2e-envelope.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * HKDF-SHA256 domain-separation info string for the key-wrap path.
 *
 * Distinct from the conversation-encryption info ("webchannel-conversation-v1")
 * so that a single ECDH shared secret cannot be used interchangeably for both
 * purposes — cryptographic domain separation ensures independence.
 */
export const KEY_WRAP_INFO = "webchannel-key-wrap-v1" as const;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * The wire format for a wrapped (encrypted) conversation key.
 *
 * All four fields are base64url-encoded binary.  Together they encode:
 *   - The agent's ephemeral X25519 public key (needed for ECDH on the device side).
 *   - A ChaCha20-Poly1305 ciphertext of the 32-byte conversation key.
 *
 * This structure is transmitted from agent → device over the SaaS-authenticated
 * bootstrap or key-distribution channel.  It MUST NOT be transmitted over NATS
 * in plaintext (the relay operator must not see the wrapped key material).
 *
 * Invariants:
 *   - `ephemeralPublicKey` decodes to exactly 32 bytes (X25519 public key).
 *   - `nonce` decodes to exactly 12 bytes (ChaCha20-Poly1305 nonce).
 *   - `ciphertext` decodes to exactly 32 bytes (encrypted conversation key).
 *   - `tag` decodes to exactly 16 bytes (Poly1305 authentication tag).
 */
export type WrappedConversationKey = {
  /**
   * base64url-encoded 32-byte ephemeral X25519 public key.
   * Generated fresh per wrap operation; used by the device for ECDH key derivation.
   */
  readonly ephemeralPublicKey: string;
  /**
   * base64url-encoded 12-byte ChaCha20-Poly1305 nonce.
   * Unique per encrypt call (random); MUST be transmitted alongside ciphertext + tag.
   */
  readonly nonce: string;
  /**
   * base64url-encoded 32-byte ciphertext of the conversation key.
   * Decryptable only by the target device (holder of the matching private key).
   */
  readonly ciphertext: string;
  /**
   * base64url-encoded 16-byte Poly1305 authentication tag.
   * Covers the ciphertext; prevents undetected tampering.
   */
  readonly tag: string;
};

/**
 * The result of a successful `decryptBacklog` call.
 *
 * Plaintext payloads are in the same order as the input envelopes.
 * Each `Uint8Array` is the raw plaintext bytes of the corresponding envelope's
 * content — typically a UTF-8 JSON string (conversation message body).
 */
export type DecryptedBacklog = {
  /**
   * Recovered plaintext payloads, one per input envelope, in insertion order.
   * Use `new TextDecoder().decode(plaintexts[i])` to obtain the string payload.
   */
  readonly plaintexts: Uint8Array[];
  /**
   * The recovered 32-byte conversation key (exposed for callers that need to
   * decrypt future envelopes without re-unwrapping the key each time).
   */
  readonly conversationKey: Uint8Array;
};

// ---------------------------------------------------------------------------
// Agent-side: wrap a conversation key for a specific device
// ---------------------------------------------------------------------------

/**
 * Wrap (encrypt) a conversation key for delivery to a specific device.
 *
 * Called by the AGENT when a new device registers or when a late-joining device
 * needs the key distributed.  The result is delivered to the device via the
 * SaaS-authenticated channel — never via NATS in plaintext.
 *
 * The wrapping is device-specific: only the holder of `devicePrivateKey`
 * (corresponding to `devicePublicKey`) can unwrap via `unwrapConversationKey`.
 *
 * A fresh ephemeral X25519 key pair is generated on every call, so two successive
 * wraps of the same conversation key for the same device produce different outputs.
 * This provides forward secrecy for the key-distribution path.
 *
 * @param conversationKey - 32-byte symmetric conversation key to wrap.
 * @param devicePublicKey - 32-byte X25519 public key of the target device (from cnf.jwk).
 * @returns WrappedConversationKey — safe to transmit over an authenticated channel.
 */
export function wrapConversationKey(
  conversationKey: Uint8Array,
  devicePublicKey: Uint8Array,
): WrappedConversationKey {
  // Fresh ephemeral key pair per wrap — forward secrecy for key distribution.
  const ephemeralKP = generateKeyPair();

  // X25519 ECDH: ephemeral private × device public → raw shared secret.
  const rawSecret = deriveSharedSecret(ephemeralKP.privateKey, devicePublicKey);

  // HKDF-SHA256: expand to a 32-byte wrapping key with domain separation.
  const wrapKey = hkdfSha256(rawSecret, null, KEY_WRAP_INFO, 32);

  // ChaCha20-Poly1305: authenticate-encrypt the 32-byte conversation key.
  const { ciphertext, nonce, tag } = encrypt(wrapKey, conversationKey);

  return {
    ephemeralPublicKey: uint8ToBase64Url(ephemeralKP.publicKey),
    nonce: uint8ToBase64Url(nonce),
    ciphertext: uint8ToBase64Url(ciphertext),
    tag: uint8ToBase64Url(tag),
  };
}

// ---------------------------------------------------------------------------
// Device-side: unwrap a conversation key using this device's private key
// ---------------------------------------------------------------------------

/**
 * Unwrap (decrypt) a conversation key using this device's X25519 private key.
 *
 * Called by the DEVICE (browser) upon receiving a `WrappedConversationKey` from
 * the agent via the SaaS-authenticated bootstrap or key-distribution channel.
 *
 * The ECDH operation is symmetric to the agent's wrap:
 *   device.private × ephemeral.public == ephemeral.private × device.public
 * Both sides derive the same raw shared secret and therefore the same wrap key.
 *
 * Authentication (Poly1305) is verified before returning the conversation key.
 * Any tampering of the wrapped key — or use of a wrong private key — causes an
 * exception; the caller MUST NOT use the return value if an exception is thrown.
 *
 * @param wrapped          - WrappedConversationKey received from the agent.
 * @param devicePrivateKey - 32-byte X25519 private key of this device. Keep secret.
 * @returns 32-byte plaintext conversation key.
 * @throws `Error` if authentication fails (wrong key, tampered ciphertext/tag,
 *         or malformed base64url in the wrapped key fields).
 */
export function unwrapConversationKey(
  wrapped: WrappedConversationKey,
  devicePrivateKey: Uint8Array,
): Uint8Array {
  const ephemeralPublicKey = base64UrlToUint8(wrapped.ephemeralPublicKey);
  const nonce = base64UrlToUint8(wrapped.nonce);
  const ciphertext = base64UrlToUint8(wrapped.ciphertext);
  const tag = base64UrlToUint8(wrapped.tag);

  // X25519 ECDH: device private × ephemeral public → same raw shared secret as agent.
  const rawSecret = deriveSharedSecret(devicePrivateKey, ephemeralPublicKey);

  // HKDF-SHA256: derive the same 32-byte wrapping key.
  const wrapKey = hkdfSha256(rawSecret, null, KEY_WRAP_INFO, 32);

  // ChaCha20-Poly1305: decrypt and verify the Poly1305 tag.
  // Throws if authentication fails — caller must not use output on exception.
  return decrypt(wrapKey, nonce, ciphertext, tag);
}

// ---------------------------------------------------------------------------
// Device-side: full late-join pipeline
// ---------------------------------------------------------------------------

/**
 * Decrypt a full backlog of paginated ciphertext envelopes as a late-joining device.
 *
 * This is the primary late-join API.  It combines key unwrapping and envelope
 * decryption into a single call, matching the late-join device flow:
 *
 *   1. Unwrap the conversation key using this device's X25519 private key.
 *   2. Decrypt every envelope in the (already-paginated) backlog using the key.
 *   3. Return the recovered plaintexts in insertion order.
 *
 * Callers are responsible for paginating the HistoryStore (or history replay
 * subject) and collecting envelopes before calling this function.  The typical
 * pattern for a late-joining device:
 *
 *   ```ts
 *   // (a) Collect all history envelopes via the paginated load_history request.
 *   let cursor: string | null = null;
 *   const allEnvelopes: MessageEnvelope[] = [];
 *   do {
 *     const { envelopes, nextCursor } = await requestHistory(sub, cursor, PAGE_SIZE);
 *     allEnvelopes.push(...envelopes);
 *     cursor = nextCursor;
 *   } while (cursor !== null);
 *
 *   // (b) Unwrap the conversation key and decrypt all envelopes.
 *   const { plaintexts, conversationKey } = decryptBacklog(
 *     allEnvelopes,
 *     wrappedKey,          // delivered via SaaS-authenticated channel
 *     device.privateKey,   // never leaves the device
 *   );
 *
 *   // (c) Use plaintexts[i] to render message i in the conversation history.
 *   for (const pt of plaintexts) {
 *     const message = JSON.parse(new TextDecoder().decode(pt));
 *     renderMessage(message);
 *   }
 *   ```
 *
 * Failure semantics:
 *   - If key unwrapping fails (wrong device key or tampered wrapped key), the
 *     function throws before any envelope is decrypted.
 *   - If any envelope decryption fails (tampered ciphertext, wrong key version),
 *     the function throws at that envelope.  Partially-decrypted results are NOT
 *     returned — the caller receives either all M plaintexts or an exception.
 *
 * @param envelopes        - Ordered ciphertext `MessageEnvelope` array (all history pages
 *                           concatenated, oldest-first as returned by `load_history`).
 * @param wrappedKey       - Conversation key wrapped for this device (from agent key distribution).
 * @param devicePrivateKey - 32-byte X25519 device private key.
 * @returns `DecryptedBacklog` with `plaintexts` (in insertion order) and the recovered key.
 * @throws `Error` if key unwrapping or any envelope decryption fails.
 */
export function decryptBacklog(
  envelopes: readonly MessageEnvelope[],
  wrappedKey: WrappedConversationKey,
  devicePrivateKey: Uint8Array,
): DecryptedBacklog {
  // Step 1: Unwrap the conversation key.
  // This is the gatekeeper — if this fails, no plaintexts are produced.
  const conversationKey = unwrapConversationKey(wrappedKey, devicePrivateKey);

  // Step 2: Decrypt each envelope using the recovered conversation key.
  // `decryptEnvelopeContent` throws on auth failure — any tampered envelope
  // propagates the error to the caller.
  const plaintexts = envelopes.map((env) =>
    decryptEnvelopeContent(env, conversationKey),
  );

  return { plaintexts, conversationKey };
}

// ---------------------------------------------------------------------------
// Internal base64url helpers
// ---------------------------------------------------------------------------

function uint8ToBase64Url(buf: Uint8Array): string {
  return Buffer.from(buf).toString("base64url");
}

function base64UrlToUint8(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, "base64url"));
}
