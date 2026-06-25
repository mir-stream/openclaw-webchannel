/**
 * Browser-side E2E crypto — X25519 + HKDF-SHA256 + ChaCha20-Poly1305.
 *
 * This is the browser counterpart the plugin's `e2e-crypto.ts` always promised
 * but never shipped (its doc comment says: "The browser-side client will use the
 * same interface backed by the Web Crypto API ... plus a portable
 * ChaCha20-Poly1305 polyfill"). WebCrypto has no ChaCha20-Poly1305, so we use the
 * audited @noble/* suite for all three primitives.
 *
 * BYTE-COMPATIBLE with the plugin's node:crypto implementation:
 *   - X25519     : raw 32-byte scalar/u-coordinate (RFC 7748) — same as node diffieHellman
 *   - HKDF-SHA256: salt=null → 32 zero bytes (RFC 5869 §2.2) — matches node hkdfSync
 *   - ChaCha20-Poly1305: IETF 12-byte nonce, 16-byte Poly1305 tag
 *
 * The envelope stores nonce/ciphertext/tag SEPARATELY (see e2e-envelope in the
 * plugin), but @noble returns ciphertext||tag concatenated, so encrypt() splits
 * the trailing 16-byte tag and decrypt() re-joins them.
 */

import { x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";

export type KeyPair = {
  readonly publicKey: Uint8Array; // 32 bytes
  readonly privateKey: Uint8Array; // 32 bytes
};

export type EncryptResult = {
  readonly ciphertext: Uint8Array;
  readonly nonce: Uint8Array; // 12 bytes
  readonly tag: Uint8Array; // 16 bytes
};

const TAG_LEN = 16;

/** X25519 key-pair generation (CSPRNG). */
export function generateKeyPair(): KeyPair {
  const privateKey = x25519.utils.randomSecretKey();
  const publicKey = x25519.getPublicKey(privateKey);
  return { publicKey, privateKey };
}

/**
 * X25519 ECDH. Symmetric: deriveSharedSecret(a.priv, b.pub) ===
 * deriveSharedSecret(b.priv, a.pub). Raw output MUST go through hkdfSha256.
 */
export function deriveSharedSecret(
  myPrivateKey: Uint8Array,
  theirPublicKey: Uint8Array,
): Uint8Array {
  return x25519.getSharedSecret(myPrivateKey, theirPublicKey);
}

/**
 * HKDF-SHA256 (RFC 5869). salt=null uses 32 zero bytes to match the plugin's
 * node:crypto `Buffer.alloc(32, 0)` default.
 */
export function hkdfSha256(
  ikm: Uint8Array,
  salt: Uint8Array | null,
  info: Uint8Array | string,
  length: number,
): Uint8Array {
  const saltBytes = salt != null ? salt : new Uint8Array(32);
  const infoBytes = typeof info === "string" ? new TextEncoder().encode(info) : info;
  return hkdf(sha256, ikm, saltBytes, infoBytes, length);
}

/** ChaCha20-Poly1305 AEAD encrypt. Fresh 12-byte nonce per call. */
export function encrypt(
  key: Uint8Array,
  plaintext: Uint8Array,
  aad?: Uint8Array,
): EncryptResult {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const out = chacha20poly1305(key, nonce, aad).encrypt(plaintext);
  // @noble appends the 16-byte Poly1305 tag; the wire envelope keeps them apart.
  const ciphertext = out.subarray(0, out.length - TAG_LEN);
  const tag = out.subarray(out.length - TAG_LEN);
  return { ciphertext, nonce, tag };
}

/** ChaCha20-Poly1305 AEAD decrypt. Throws if the tag fails to authenticate. */
export function decrypt(
  key: Uint8Array,
  nonce: Uint8Array,
  ciphertext: Uint8Array,
  tag: Uint8Array,
  aad?: Uint8Array,
): Uint8Array {
  const combined = new Uint8Array(ciphertext.length + tag.length);
  combined.set(ciphertext, 0);
  combined.set(tag, ciphertext.length);
  return chacha20poly1305(key, nonce, aad).decrypt(combined);
}
