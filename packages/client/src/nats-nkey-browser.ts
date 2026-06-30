/**
 * Browser-safe NATS NKEY signing helpers (NATS-layer challenge-response auth).
 *
 * A JWT-auth nats-server greets every connection with an `INFO` line carrying a
 * single-use `nonce`. To authenticate, the client must present its user JWT AND
 * an Ed25519 signature over that nonce, proving possession of the user NKEY's
 * private seed. These two helpers are the device half of that handshake.
 *
 * BROWSER-SAFE ONLY: uses `crypto.subtle` + base64url — no `@nats-io/*`, no
 * `node:` imports, no base32/CRC NKEY decoder. The caller supplies the raw
 * 32-byte Ed25519 seed (base64url) instead of the base32 NKEY seed string, so
 * the browser never needs an nkeys codec. Shared by the production
 * `WebChannelNatsClient` (`nats-client.ts`) and the E2E browser client.
 */

import { base64urlEncode } from "./e2e-crypto-browser.js";

/**
 * Import a raw 32-byte Ed25519 seed as a non-extractable signing `CryptoKey`.
 *
 * Wraps the seed in the PKCS#8 DER encoding (RFC 8410) that Chrome 130+ accepts:
 *   SEQUENCE {
 *     INTEGER 0 (version)
 *     SEQUENCE { OID 1.3.101.112 (Ed25519) }
 *     OCTET STRING { OCTET STRING { <32 seed bytes> } }
 *   }
 */
export async function importEd25519SeedKey(rawSeed: Uint8Array): Promise<CryptoKey> {
  // PKCS#8 DER header for Ed25519 (RFC 8410), 16 bytes; followed by the 32-byte seed.
  const header = new Uint8Array([
    0x30, 0x2e, // SEQUENCE (46 bytes follow)
    0x02, 0x01, 0x00, // INTEGER 0 (version)
    0x30, 0x05, // SEQUENCE
    0x06, 0x03, 0x2b, 0x65, 0x70, // OID 1.3.101.112 (id-EdDSA / Ed25519)
    0x04, 0x22, // OCTET STRING (34 bytes follow)
    0x04, 0x20, // OCTET STRING (32 bytes = seed)
  ]);
  const pkcs8 = new Uint8Array(header.length + rawSeed.length);
  pkcs8.set(header, 0);
  pkcs8.set(rawSeed, header.length);
  return crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, false, ["sign"]);
}

/** Sign a server `nonce` string with an Ed25519 private key → base64url signature. */
export async function signNonce(privateKey: CryptoKey, nonce: string): Promise<string> {
  const sigBytes = await crypto.subtle.sign(
    { name: "Ed25519" },
    privateKey,
    new TextEncoder().encode(nonce),
  );
  return base64urlEncode(new Uint8Array(sigBytes));
}
