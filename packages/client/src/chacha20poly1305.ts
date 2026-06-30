/**
 * Pure-JavaScript ChaCha20-Poly1305 AEAD implementation (RFC 8439).
 *
 * Browser + Node.js compatible — zero dependencies, no Node.js-specific APIs.
 * Uses only:
 *   - Uint8Array / DataView (standard)
 *   - BigInt (ES2020, Chrome 67+, Firefox 68+, Safari 14+)
 *
 * Used as the browser-side cipher complement to Node.js `chacha20-poly1305`
 * (via `createCipheriv`). Both produce/consume identical ciphertext.
 *
 * Security note: This is a correctness-correct implementation per RFC 8439.
 * For high-performance production use, consider @noble/ciphers instead.
 */

// ---------------------------------------------------------------------------
// ChaCha20 stream cipher
// ---------------------------------------------------------------------------

/** 32-bit left rotation (unsigned). */
function rotl32(n: number, r: number): number {
  return ((n << r) | (n >>> (32 - r))) >>> 0;
}

/**
 * ChaCha20 quarter round — operates on four elements of the state array.
 * Mutates in place.
 */
function quarterRound(s: Uint32Array, a: number, b: number, c: number, d: number): void {
  s[a] = (s[a]! + s[b]!) >>> 0; s[d] = rotl32(s[d]! ^ s[a]!, 16);
  s[c] = (s[c]! + s[d]!) >>> 0; s[b] = rotl32(s[b]! ^ s[c]!, 12);
  s[a] = (s[a]! + s[b]!) >>> 0; s[d] = rotl32(s[d]! ^ s[a]!,  8);
  s[c] = (s[c]! + s[d]!) >>> 0; s[b] = rotl32(s[b]! ^ s[c]!,  7);
}

/**
 * ChaCha20 block function — returns 64 bytes of keystream.
 *
 * @param key     32-byte key
 * @param counter 32-bit block counter (little-endian word in state[12])
 * @param nonce   12-byte nonce (words in state[13..15])
 */
function chacha20Block(key: Uint8Array, counter: number, nonce: Uint8Array): Uint8Array {
  // RFC 8439 constants ("expa" "nd 3" "2-by" "te k" as LE uint32)
  const C0 = 0x61707865;
  const C1 = 0x3320646e;
  const C2 = 0x79622d32;
  const C3 = 0x6b206574;

  // Read key as 8 LE uint32s.
  const kv = new DataView(key.buffer, key.byteOffset, 32);
  const k0 = kv.getUint32(0,  true);
  const k1 = kv.getUint32(4,  true);
  const k2 = kv.getUint32(8,  true);
  const k3 = kv.getUint32(12, true);
  const k4 = kv.getUint32(16, true);
  const k5 = kv.getUint32(20, true);
  const k6 = kv.getUint32(24, true);
  const k7 = kv.getUint32(28, true);

  // Read nonce as 3 LE uint32s.
  const nv = new DataView(nonce.buffer, nonce.byteOffset, 12);
  const n0 = nv.getUint32(0, true);
  const n1 = nv.getUint32(4, true);
  const n2 = nv.getUint32(8, true);

  // Initial state (RFC 8439 §2.3)
  const init = new Uint32Array([
    C0, C1, C2, C3,
    k0, k1, k2, k3,
    k4, k5, k6, k7,
    counter >>> 0, n0, n1, n2,
  ]);
  const s = new Uint32Array(init);

  // 20 rounds (10 double rounds)
  for (let i = 0; i < 10; i++) {
    // Column rounds
    quarterRound(s,  0,  4,  8, 12);
    quarterRound(s,  1,  5,  9, 13);
    quarterRound(s,  2,  6, 10, 14);
    quarterRound(s,  3,  7, 11, 15);
    // Diagonal rounds
    quarterRound(s,  0,  5, 10, 15);
    quarterRound(s,  1,  6, 11, 12);
    quarterRound(s,  2,  7,  8, 13);
    quarterRound(s,  3,  4,  9, 14);
  }

  // Add initial state and serialize to little-endian bytes.
  const out = new Uint8Array(64);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < 16; i++) {
    dv.setUint32(i * 4, ((s[i]! + init[i]!) >>> 0), true);
  }
  return out;
}

/**
 * ChaCha20 stream encrypt/decrypt (symmetric — same function for both).
 *
 * @param key     32-byte key
 * @param nonce   12-byte nonce
 * @param counter Initial block counter (1 for AEAD payload, 0 for Poly1305 key)
 * @param data    Input bytes to XOR with keystream
 */
export function chacha20(
  key: Uint8Array,
  nonce: Uint8Array,
  counter: number,
  data: Uint8Array,
): Uint8Array {
  const out = new Uint8Array(data.length);
  for (let blockIdx = 0; blockIdx * 64 < data.length; blockIdx++) {
    const block = chacha20Block(key, counter + blockIdx, nonce);
    const base = blockIdx * 64;
    const len = Math.min(64, data.length - base);
    for (let i = 0; i < len; i++) {
      out[base + i] = data[base + i]! ^ block[i]!;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Poly1305 MAC
// ---------------------------------------------------------------------------

/**
 * Poly1305 one-time MAC (RFC 8439 §2.5).
 *
 * Uses BigInt for field arithmetic in ℤ/(2^130 − 5). BigInt is supported in
 * all modern browsers (Chrome 67+, Firefox 68+, Safari 14+, Node 10+).
 *
 * @param key 32-byte one-time key (r || s, where r is bytes 0-15 clamped)
 * @param msg Message bytes to authenticate
 * @returns 16-byte authentication tag
 */
export function poly1305(key: Uint8Array, msg: Uint8Array): Uint8Array {
  const P = (1n << 130n) - 5n; // 2^130 - 5

  // --- Clamp r (RFC 8439 §2.5.1) ---
  // Make a mutable copy of the first 16 bytes
  const rBytes = new Uint8Array(key.slice(0, 16));
  rBytes[3]!  &= 0x0f;
  rBytes[7]!  &= 0x0f;
  rBytes[11]! &= 0x0f;
  rBytes[15]! &= 0x0f;
  rBytes[4]!  &= 0xfc;
  rBytes[8]!  &= 0xfc;
  rBytes[12]! &= 0xfc;

  // Decode r as 128-bit LE integer
  let r = 0n;
  for (let i = 0; i < 16; i++) r |= BigInt(rBytes[i]!) << BigInt(i * 8);

  // Decode s as 128-bit LE integer (bytes 16-31)
  let s = 0n;
  for (let i = 0; i < 16; i++) s |= BigInt(key[16 + i]!) << BigInt(i * 8);

  // --- Accumulate ---
  let a = 0n;
  for (let i = 0; i < msg.length; i += 16) {
    const end = Math.min(i + 16, msg.length);
    const chunk = msg.subarray(i, end);
    // Decode chunk as LE integer, then OR in the 0x01 padding bit
    let n = 0n;
    for (let j = 0; j < chunk.length; j++) n |= BigInt(chunk[j]!) << BigInt(j * 8);
    n |= 1n << BigInt(chunk.length * 8);
    a = ((a + n) * r) % P;
  }

  // Final: a + s mod 2^128
  a = (a + s) & 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFn; // 128-bit mask

  // Encode as 16-byte LE
  const tag = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    tag[i] = Number(a & 0xffn);
    a >>= 8n;
  }
  return tag;
}

// ---------------------------------------------------------------------------
// Constant-time bytes equality (timing-safe tag comparison)
// ---------------------------------------------------------------------------

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

// ---------------------------------------------------------------------------
// RFC 8439 §2.8 — ChaCha20-Poly1305 AEAD
// ---------------------------------------------------------------------------

/**
 * ChaCha20-Poly1305 AEAD encryption.
 *
 * @param key       32-byte symmetric key
 * @param nonce     12-byte (96-bit) nonce — MUST be unique per (key, message) pair
 * @param plaintext Message to encrypt
 * @param aad       Additional authenticated data (authenticated but NOT encrypted)
 * @returns `{ ciphertext, tag }` — both needed for decryption
 */
export function chacha20poly1305Encrypt(
  key: Uint8Array,
  nonce: Uint8Array,
  plaintext: Uint8Array,
  aad: Uint8Array = new Uint8Array(0),
): { ciphertext: Uint8Array; tag: Uint8Array } {
  // Generate Poly1305 one-time key from block 0
  const otk = chacha20Block(key, 0, nonce).subarray(0, 32);

  // Encrypt plaintext starting at block counter=1
  const ciphertext = chacha20(key, nonce, 1, plaintext);

  // Compute Poly1305 MAC input per RFC 8439 §2.8:
  //   AAD || pad16(AAD) || ciphertext || pad16(ciphertext) || len(AAD,LE64) || len(ciphertext,LE64)
  const macInput = buildMacInput(aad, ciphertext);
  const tag = poly1305(otk, macInput);

  return { ciphertext, tag };
}

/**
 * ChaCha20-Poly1305 AEAD decryption + authentication.
 *
 * Throws if the Poly1305 tag does not verify (wrong key, tampered ciphertext/AAD).
 *
 * @param key        32-byte symmetric key
 * @param nonce      12-byte nonce (from encryption)
 * @param ciphertext Encrypted bytes
 * @param tag        16-byte authentication tag (from encryption)
 * @param aad        Additional authenticated data (must match encryption)
 * @returns Decrypted plaintext bytes
 * @throws Error on authentication failure
 */
export function chacha20poly1305Decrypt(
  key: Uint8Array,
  nonce: Uint8Array,
  ciphertext: Uint8Array,
  tag: Uint8Array,
  aad: Uint8Array = new Uint8Array(0),
): Uint8Array {
  // Generate Poly1305 one-time key from block 0
  const otk = chacha20Block(key, 0, nonce).subarray(0, 32);

  // Verify tag FIRST (before decrypting — always)
  const macInput = buildMacInput(aad, ciphertext);
  const expectedTag = poly1305(otk, macInput);
  if (!timingSafeEqual(tag, expectedTag)) {
    throw new Error("ChaCha20-Poly1305: authentication failed (wrong key or tampered data)");
  }

  // Decrypt
  return chacha20(key, nonce, 1, ciphertext);
}

// ---------------------------------------------------------------------------
// Internal helper
// ---------------------------------------------------------------------------

/**
 * Build the Poly1305 MAC input per RFC 8439 §2.8.1:
 *   AAD || pad16(AAD) || ciphertext || pad16(ciphertext) || LE64(len_aad) || LE64(len_ct)
 */
function buildMacInput(aad: Uint8Array, ciphertext: Uint8Array): Uint8Array {
  const aadPad = pad16(aad.length);
  const ctPad  = pad16(ciphertext.length);
  const lens   = new Uint8Array(16); // Two LE64 length fields
  const dv     = new DataView(lens.buffer);
  dv.setBigUint64(0, BigInt(aad.length),        true);
  dv.setBigUint64(8, BigInt(ciphertext.length),  true);

  const total = aad.length + aadPad + ciphertext.length + ctPad + 16;
  const out = new Uint8Array(total);
  let off = 0;
  out.set(aad,        off); off += aad.length;
  off += aadPad; // zero-padding already present in Uint8Array
  out.set(ciphertext, off); off += ciphertext.length;
  off += ctPad;
  out.set(lens,       off);
  return out;
}

/** Returns the number of zero-padding bytes needed to round up to the next 16-byte boundary. */
function pad16(len: number): number {
  return (16 - (len % 16)) % 16;
}
