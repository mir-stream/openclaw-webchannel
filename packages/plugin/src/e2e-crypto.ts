/**
 * E2E crypto primitive module — X25519+HKDF-SHA256+ChaCha20-Poly1305.
 *
 * Provides the four building blocks needed for E2E encryption of conversation
 * and approval content over the untrusted NATS relay bus:
 *
 *  1. `generateKeyPair()` — X25519 key-pair generation.
 *  2. `deriveSharedSecret()` — X25519 ECDH shared-secret derivation.
 *  3. `hkdfSha256()` — HKDF-SHA256 key expansion from the raw shared secret.
 *  4. `encrypt()` / `decrypt()` — ChaCha20-Poly1305 AEAD cipher.
 *
 * Security model
 * ──────────────
 * The NATS relay operator observes only ciphertext and plaintext routing
 * metadata (subject names / agentId / tenant). Content plaintext is
 * readable only by parties that completed the X25519 key exchange.
 *
 * Typical usage pattern
 * ─────────────────────
 *   // Both sides:
 *   const myKeyPair  = generateKeyPair();
 *   // ... exchange publicKeys over the SaaS-authenticated channel ...
 *   const rawSecret  = deriveSharedSecret(myKeyPair.privateKey, theirPublicKey);
 *   const sessionKey = hkdfSha256(rawSecret, null, 'webchannel-v1', 32);
 *
 *   // Sender:
 *   const { ciphertext, nonce, tag } = encrypt(sessionKey, plaintext);
 *
 *   // Receiver:
 *   const plaintext = decrypt(sessionKey, nonce, ciphertext, tag);
 *
 * Runtime target
 * ──────────────
 * Implemented with Node.js built-in `node:crypto`. All four algorithms
 * (X25519, HKDF-SHA256, ChaCha20-Poly1305) are supported in Node.js ≥18
 * via OpenSSL without external dependencies.
 *
 * The browser-side client will use the same interface backed by the Web
 * Crypto API (which natively supports X25519 and HKDF since 2023 in Chrome/
 * Firefox/Safari) plus a portable ChaCha20-Poly1305 polyfill.
 */

import {
  generateKeyPairSync,
  diffieHellman,
  hkdfSync,
  createCipheriv,
  createDecipheriv,
  randomBytes,
  createPrivateKey,
  createPublicKey,
} from "node:crypto";

// ---------------------------------------------------------------------------
// DER encoding constants for X25519 key import
// ---------------------------------------------------------------------------

/**
 * Fixed PKCS#8 DER header for X25519 private keys (16 bytes).
 *
 * Structure (RFC 5958 OneAsymmetricKey, v0):
 *   SEQUENCE {
 *     INTEGER 0                        -- version
 *     SEQUENCE { OID 1.3.101.110 }    -- AlgorithmIdentifier (id-X25519)
 *     OCTET STRING {
 *       OCTET STRING { <32-byte key> } -- CurvePrivateKey
 *     }
 *   }
 * Total wire: 16 header bytes + 32 key bytes = 48 bytes.
 */
const X25519_PKCS8_HEADER = Buffer.from("302e020100300506032b656e04220420", "hex");

/**
 * Fixed SPKI DER header for X25519 public keys (12 bytes, includes BIT STRING
 * leading 0x00 padding-indicator byte).
 *
 * Structure (RFC 5480 SubjectPublicKeyInfo):
 *   SEQUENCE {
 *     SEQUENCE { OID 1.3.101.110 }  -- AlgorithmIdentifier (id-X25519)
 *     BIT STRING {
 *       0x00                         -- 0 padding bits
 *       <32-byte key>
 *     }
 *   }
 * Total wire: 12 header bytes + 32 key bytes = 44 bytes.
 */
const X25519_SPKI_HEADER = Buffer.from("302a300506032b656e032100", "hex");

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * An X25519 key pair. Both components are exactly 32 bytes (the raw
 * Curve25519 scalar / point encoding without any DER/PEM framing).
 */
export type KeyPair = {
  /** 32-byte X25519 public key (Curve25519 u-coordinate / public point). */
  readonly publicKey: Uint8Array;
  /** 32-byte X25519 private key (Curve25519 scalar). Keep secret. */
  readonly privateKey: Uint8Array;
};

/**
 * Result of an authenticated encryption operation.
 *
 * All three components MUST be stored / transmitted together; decryption
 * requires all three (plus an optionally authenticated AAD if used).
 */
export type EncryptResult = {
  /** Encrypted ciphertext (same byte length as the original plaintext). */
  readonly ciphertext: Uint8Array;
  /** 12-byte random nonce. Unique per encryption; NEVER reuse with the same key. */
  readonly nonce: Uint8Array;
  /** 16-byte Poly1305 authentication tag. Covers ciphertext + any AAD. */
  readonly tag: Uint8Array;
};

// ---------------------------------------------------------------------------
// 1. Key-pair generation
// ---------------------------------------------------------------------------

/**
 * Generate a fresh X25519 key pair.
 *
 * Uses `crypto.generateKeyPairSync('x25519')` (OpenSSL, CSPRNG) and exports
 * the raw 32-byte components via JWK format (avoids manual DER parsing on
 * the generation path).
 *
 * @returns A new `{ publicKey, privateKey }` pair. The private key MUST be
 *   stored securely; the public key can be shared freely.
 */
export function generateKeyPair(): KeyPair {
  const { privateKey, publicKey } = generateKeyPairSync("x25519");

  // JWK format for X25519 OKP keys (RFC 8037):
  //   { kty: "OKP", crv: "X25519", x: "<base64url public>", d: "<base64url private>" }
  const privJwk = privateKey.export({ format: "jwk" }) as {
    d: string;
    x: string;
  };
  const pubJwk = publicKey.export({ format: "jwk" }) as { x: string };

  return {
    publicKey: new Uint8Array(Buffer.from(pubJwk.x, "base64url")),
    privateKey: new Uint8Array(Buffer.from(privJwk.d, "base64url")),
  };
}

// ---------------------------------------------------------------------------
// 2. ECDH shared-secret derivation
// ---------------------------------------------------------------------------

/**
 * Derive the X25519 ECDH shared secret from one party's private key and the
 * other party's public key.
 *
 * ECDH is symmetric: `deriveSharedSecret(alice.priv, bob.pub)` produces the
 * same 32-byte output as `deriveSharedSecret(bob.priv, alice.pub)`.
 *
 * ⚠️  The raw shared secret MUST be passed through `hkdfSha256()` before use
 * as an encryption key (the raw ECDH output is not uniformly random).
 *
 * @param myPrivateKey    - 32-byte X25519 private key (caller's own key).
 * @param theirPublicKey  - 32-byte X25519 public key (the other party's key).
 * @returns 32-byte shared secret (raw X25519 output).
 */
export function deriveSharedSecret(
  myPrivateKey: Uint8Array,
  theirPublicKey: Uint8Array,
): Uint8Array {
  // Re-wrap raw bytes into DER-encoded KeyObjects that Node.js diffieHellman()
  // accepts. The headers are fixed constants — no parsing required.
  const privateKeyObj = createPrivateKey({
    key: Buffer.concat([X25519_PKCS8_HEADER, Buffer.from(myPrivateKey)]),
    format: "der",
    type: "pkcs8",
  });
  const publicKeyObj = createPublicKey({
    key: Buffer.concat([X25519_SPKI_HEADER, Buffer.from(theirPublicKey)]),
    format: "der",
    type: "spki",
  });
  // diffieHellman() returns a Buffer of the shared secret.
  return new Uint8Array(diffieHellman({ privateKey: privateKeyObj, publicKey: publicKeyObj }));
}

// ---------------------------------------------------------------------------
// 3. HKDF-SHA256 key derivation
// ---------------------------------------------------------------------------

/**
 * Expand input key material into a derived key using HKDF-SHA256 (RFC 5869).
 *
 * Use this to derive a uniformly random encryption key from the raw X25519
 * ECDH output. The `info` string provides domain separation — different values
 * for different key usages guarantee cryptographic independence even with the
 * same underlying ECDH secret.
 *
 * @param ikm    - Input key material (e.g. 32-byte raw X25519 shared secret).
 * @param salt   - Optional 32-byte random salt (recommended for freshness).
 *                 `null` uses the RFC 5869 §2.2 default: 32 zero bytes
 *                 (HashLen zeros for HMAC-SHA256).
 * @param info   - Context/domain-separation string or bytes
 *                 (e.g. `'webchannel-conversation-v1'`).
 * @param length - Desired output key length in bytes (e.g. 32 for ChaCha20).
 * @returns Derived key as `Uint8Array` of the requested length.
 */
export function hkdfSha256(
  ikm: Uint8Array,
  salt: Uint8Array | null,
  info: Uint8Array | string,
  length: number,
): Uint8Array {
  // RFC 5869 §2.2: "if not provided, [salt] is set to a string of HashLen zeros."
  // For HMAC-SHA256, HashLen = 32.
  const saltBuf = salt != null ? Buffer.from(salt) : Buffer.alloc(32, 0);
  const infoBuf =
    typeof info === "string"
      ? Buffer.from(info, "utf8")
      : Buffer.from(info);
  // hkdfSync returns ArrayBuffer.
  return new Uint8Array(hkdfSync("sha256", Buffer.from(ikm), saltBuf, infoBuf, length));
}

// ---------------------------------------------------------------------------
// 4. ChaCha20-Poly1305 authenticated encryption / decryption
// ---------------------------------------------------------------------------

/**
 * Encrypt `plaintext` with ChaCha20-Poly1305 using the given 32-byte `key`.
 *
 * A fresh 12-byte random nonce is generated per call (never reuse a nonce
 * with the same key — each encrypt call produces a different nonce). The
 * 16-byte Poly1305 authentication tag covers both the ciphertext and any
 * additional authenticated data (AAD).
 *
 * @param key       - 32-byte encryption key (output of `hkdfSha256`).
 * @param plaintext - Plaintext bytes to encrypt.
 * @param aad       - Optional additional authenticated data. Authenticated but
 *                    NOT encrypted (e.g. message ID, NATS subject, envelope type).
 *                    Must be provided identically to `decrypt()`.
 * @returns `{ ciphertext, nonce, tag }` — store all three for decryption.
 */
export function encrypt(
  key: Uint8Array,
  plaintext: Uint8Array,
  aad?: Uint8Array,
): EncryptResult {
  const nonce = randomBytes(12); // 96-bit random nonce per IETF ChaCha20-Poly1305
  const cipher = createCipheriv(
    "chacha20-poly1305",
    Buffer.from(key),
    nonce,
    // authTagLength defaults to 16 for chacha20-poly1305; explicit for clarity.
    { authTagLength: 16 },
  );

  if (aad !== undefined) {
    // plaintextLength is required by the @types/node CipherChaCha20Poly1305
    // interface (matches CCM mode typing). Node.js ignores it at runtime for
    // ChaCha20-Poly1305 (only CCM actually uses it), but we provide it for
    // type safety.
    cipher.setAAD(Buffer.from(aad), { plaintextLength: plaintext.length });
  }

  const enc1 = cipher.update(Buffer.from(plaintext));
  const enc2 = cipher.final();
  const ciphertext = Buffer.concat([enc1, enc2]);
  const tag = cipher.getAuthTag();

  return {
    ciphertext: new Uint8Array(ciphertext),
    nonce: new Uint8Array(nonce),
    tag: new Uint8Array(tag),
  };
}

/**
 * Decrypt and authenticate a ChaCha20-Poly1305 ciphertext.
 *
 * Verifies the Poly1305 tag over both the ciphertext and any AAD before
 * returning plaintext. Throws if authentication fails — the caller MUST NOT
 * use the return value if an exception was thrown.
 *
 * @param key        - 32-byte decryption key (same as used for encryption).
 * @param nonce      - 12-byte nonce from `EncryptResult.nonce`.
 * @param ciphertext - Encrypted bytes from `EncryptResult.ciphertext`.
 * @param tag        - 16-byte auth tag from `EncryptResult.tag`.
 * @param aad        - Optional additional authenticated data (must exactly
 *                     match what was passed to `encrypt()`).
 * @returns Decrypted plaintext as `Uint8Array`.
 * @throws `Error` if the authentication tag does not match (wrong key,
 *         tampered ciphertext/tag/AAD, or nonce reuse). The error message
 *         is `'Unsupported state or unable to authenticate data'` (OpenSSL).
 */
export function decrypt(
  key: Uint8Array,
  nonce: Uint8Array,
  ciphertext: Uint8Array,
  tag: Uint8Array,
  aad?: Uint8Array,
): Uint8Array {
  const decipher = createDecipheriv(
    "chacha20-poly1305",
    Buffer.from(key),
    Buffer.from(nonce),
    { authTagLength: 16 },
  );

  decipher.setAuthTag(Buffer.from(tag));

  if (aad !== undefined) {
    // Same plaintextLength reasoning as encrypt() — required by types, ignored
    // at runtime for ChaCha20-Poly1305. ciphertext.length === plaintext.length
    // for a stream cipher.
    decipher.setAAD(Buffer.from(aad), { plaintextLength: ciphertext.length });
  }

  const dec1 = decipher.update(Buffer.from(ciphertext));
  // decipher.final() verifies the auth tag and throws if it does not match.
  const dec2 = decipher.final();

  return new Uint8Array(Buffer.concat([dec1, dec2]));
}
