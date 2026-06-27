/**
 * NATS NKEY nonce-signing — dependency-free (node:crypto only).
 *
 * A JWT-auth nats-server greets each client with an INFO message carrying a
 * challenge `nonce`. To authenticate, the client must sign that nonce with the
 * Ed25519 PRIVATE key encoded in its NATS user seed ("SU…") and return the
 * base64url signature in CONNECT (alongside the user JWT). The agent's enrolled
 * credentials (`createEnrolledNatsConnection`) include such a seed.
 *
 * `@nats-io/nkeys` (which exposes `fromSeed().sign()`) is intentionally NOT a
 * dependency of packages/plugin — it lives in packages/saas/e2e only. So we
 * decode the NKEY seed and sign with node:crypto directly. The decode is the
 * standard NATS NKEY layout:
 *
 *   base32(RFC 4648) → bytes = [ 2 prefix bytes | 32 Ed25519 seed | 2 CRC16 ]
 *
 * We take bytes[2..34] (the raw 32-byte Ed25519 seed), wrap it in the RFC 8410
 * PKCS#8 envelope, and Ed25519-sign the nonce. This is byte-identical to
 * `@nats-io/nkeys` `fromSeed(seed).sign(...)` (verified against the library).
 */

import { createPrivateKey, sign as edSign } from "node:crypto";

/** RFC 4648 base32 alphabet used by NATS NKEYs (no padding). */
const NKEY_BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** Decode an RFC 4648 base32 string (NATS NKEY flavour) to bytes. */
function base32Decode(input: string): Uint8Array {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of input) {
    const idx = NKEY_BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) continue; // ignore stray characters (e.g. accidental padding)
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >>> bits) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

/** RFC 8410 PKCS#8 prefix for an Ed25519 private key wrapping a 32-byte seed. */
const ED25519_PKCS8_PREFIX = Uint8Array.from([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70,
  0x04, 0x22, 0x04, 0x20,
]);

/**
 * Extract the raw 32-byte Ed25519 seed from a NATS user NKEY seed ("SU…").
 * @throws if the seed does not decode to the expected 2+32+2 byte layout.
 */
function nkeySeedToRawEd25519Seed(nkeySeed: string): Uint8Array {
  const decoded = base32Decode(nkeySeed.trim());
  // 2 prefix bytes + 32 seed + 2 CRC = 36 bytes.
  if (decoded.length < 34) {
    throw new Error(
      `nkey-sign: NKEY seed decoded to ${decoded.length} bytes (expected >= 34)`,
    );
  }
  return decoded.slice(2, 34);
}

/**
 * Build an NKEY nonce-signing callback for `NatsTransport.nkeySigningCallback`.
 *
 * The returned function signs the server nonce with the user's Ed25519 key and
 * returns the base64url signature. Validation (seed decode + key import) happens
 * eagerly so a malformed seed fails loudly at connection setup, not mid-handshake.
 */
export function makeNkeySigningCallback(
  nkeySeed: string,
): (nonce: string) => Promise<string> {
  const rawSeed = nkeySeedToRawEd25519Seed(nkeySeed);
  const pkcs8 = new Uint8Array(ED25519_PKCS8_PREFIX.length + rawSeed.length);
  pkcs8.set(ED25519_PKCS8_PREFIX, 0);
  pkcs8.set(rawSeed, ED25519_PKCS8_PREFIX.length);
  const privateKey = createPrivateKey({
    key: Buffer.from(pkcs8),
    format: "der",
    type: "pkcs8",
  });

  return (nonce: string): Promise<string> => {
    const sig = edSign(null, Buffer.from(nonce, "utf8"), privateKey);
    return Promise.resolve(sig.toString("base64url"));
  };
}
