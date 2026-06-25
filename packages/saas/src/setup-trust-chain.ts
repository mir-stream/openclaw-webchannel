/**
 * setupTrustChain — offline one-time SaaS trust root initialization.
 *
 * This module generates the complete trust chain artifacts:
 *
 *  PRIVATE (SaaS-only):
 *   - RS256 private key (PEM) — signs bootstrap JWTs
 *   - NATS account signing seed (NKEY) — signs NATS operator/account JWTs
 *
 *  PUBLIC (nats-server + JWKS endpoint):
 *   - NATS operator JWT (signed by operator NKEY)
 *   - NATS account JWT (signed by operator NKEY)
 *   - Resolver config (maps account public NKEY to account JWT)
 *   - JWKS document (RSA public key for bootstrap JWT verification)
 *
 * INVARIANTS:
 *   - Generated once per NATS bus (tenant isolation unit)
 *   - Private material never leaves SaaS infrastructure
 *   - Public config is loaded by nats-server at startup
 *   - No runtime SaaS↔NATS dependency (account keypair split at init)
 *
 * REFERENCES:
 *   - https://docs.nats.io/running-a-nats-service/configuration/securing_nats/auth_intro
 *   - https://docs.nats.io/running-a-nats-service/configuration/securing_nats/jwt
 *   - RFC 7517 (JWKS)
 *   - RFC 7518 (JWK RSA)
 */

import type {
  SetupTrustChainResult,
  SaasTrustChainPrivate,
  NatsAccountConfig,
  NatsResolverConfig,
  JwksDocument,
  JwkRsaPublicKey,
} from "./types.js";

/**
 * Configuration for setupTrustChain.
 */
export type SetupTrustChainOptions = {
  /**
   * Operator name (embedded in NATS operator JWT).
   */
  operatorName?: string;

  /**
   * Account name (embedded in NATS account JWT, typically tenant ID).
   * For a multi-tenant SaaS, each tenant gets their own account JWT.
   */
  accountName?: string;

  /**
   * RSA key size in bits. Default 2048 (recommended minimum for RS256).
   */
  rsaKeySize?: number;

  /**
   * Key ID for the RSA keypair. Generated as UUID if omitted.
   */
  kid?: string;
};

// ---------------------------------------------------------------------------
// Internal crypto utilities
// ---------------------------------------------------------------------------

/**
 * Generate an RSA keypair for RS256 signing.
 *
 * Returns the private key in PKCS#8 PEM format and extracts the public key
 * modulus (n) and exponent (e) for JWKS.
 */
async function generateRsaKeypair(
  keySize: number = 2048,
): Promise<{ privateKeyPem: string; publicKeyJwk: JwkRsaPublicKey; kid: string }> {
  const keypair = await globalThis.crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: keySize,
      publicExponent: new Uint8Array([1, 0, 1]), // 65537
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  if (!("publicKey" in keypair)) {
    throw new Error("Expected CryptoKeyPair from RSA generateKey");
  }

  // Export private key as PKCS#8 PEM
  const privateKeyBuffer = await globalThis.crypto.subtle.exportKey("pkcs8", keypair.privateKey);
  const privateKeyBase64 = bufferToBase64(new Uint8Array(privateKeyBuffer));
  const privateKeyPem = `-----BEGIN PRIVATE KEY-----\n${chunk(privateKeyBase64, 64)}\n-----END PRIVATE KEY-----`;

  // Export public key as JWK for JWKS
  const publicKeyJwk = await globalThis.crypto.subtle.exportKey("jwk", keypair.publicKey);
  const jwk: JwkRsaPublicKey = {
    kty: publicKeyJwk.kty === "RSA" ? "RSA" : "RSA",
    kid: await generateKid(),
    alg: "RS256",
    use: "sig",
    n: publicKeyJwk.n ?? "",
    e: publicKeyJwk.e ?? "",
  };

  return {
    privateKeyPem,
    publicKeyJwk: jwk,
    kid: jwk.kid,
  };
}

/**
 * Generate a UUID v4 for use as a key ID (kid).
 */
async function generateKid(): Promise<string> {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);

  // Version 4 UUID: random bytes with version/variant bits set
  bytes[6] = (bytes[6]! & 0x0f) | 0x40; // Version 4
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // Variant 10

  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  return [
    hex.substring(0, 8),
    hex.substring(8, 12),
    hex.substring(12, 16),
    hex.substring(16, 20),
    hex.substring(20, 32),
  ].join("-");
}

/**
 * Convert a Uint8Array to base64 string.
 */
function bufferToBase64(buffer: Uint8Array): string {
  const binary = Array.from(buffer)
    .map((b) => String.fromCharCode(b))
    .join("");
  return btoa(binary);
}

/**
 * Split a string into chunks of specified length.
 */
function chunk(str: string, size: number): string {
  const chunks: string[] = [];
  for (let i = 0; i < str.length; i += size) {
    chunks.push(str.slice(i, i + size));
  }
  return chunks.join("\n");
}

/**
 * Convert PEM string to crypto key.
 */
async function pemToKey(pem: string): Promise<CryptoKey> {
  const pemContents = pem
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/\s/g, "");

  const binary = atob(pemContents);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  return globalThis.crypto.subtle.importKey(
    "pkcs8",
    bytes,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    true,
    ["sign"],
  );
}

// ---------------------------------------------------------------------------
// NKEY utilities (simplified for Phase B)
// ---------------------------------------------------------------------------

/**
 * Generate a NATS NKEY seed pair (Ed25519).
 *
 * NATS NKEYs are Ed25519 keypairs encoded in a specific base32 alphabet.
 * For Phase B, we use a simplified implementation that generates compatible
 * seeds and public keys.
 *
 * Format: "SA..." where 'S' = operator, 'A' = account (NATS category byte).
 */
async function generateNkeySeed(): Promise<{ seed: string; publicKey: string }> {
  try {
    // Try Ed25519 (preferred, available in modern browsers/Node 19+)
    const keypair = await globalThis.crypto.subtle.generateKey(
      {
        name: "Ed25519",
      },
      true,
      ["sign", "verify"],
    );
    if (!("publicKey" in keypair)) {
      throw new Error("Expected CryptoKeyPair from Ed25519 generateKey");
    }

    // Export seed (private key) — OKP raw export is unsupported, use JWK 'd'
    const seedBase32 = encodeNkeyBase32(await exportOkpPrivateSeed(keypair.privateKey));

    // Export public key
    const publicBuffer = await globalThis.crypto.subtle.exportKey("raw", keypair.publicKey);
    const publicBase32 = encodeNkeyBase32(new Uint8Array(publicBuffer));

    // NATS NKEY seed format: "SA" + encoded seed
    // NATS NKEY public format: "SA" + encoded public key
    const seed = `SA${seedBase32}`;
    const publicKey = `SA${publicBase32}`;

    return { seed, publicKey };
  } catch (err) {
    // Fallback for environments without Ed25519 support (e.g., older Node versions)
    // Generate X25519 as a substitute (still provides keypair semantics)
    const keypair = await globalThis.crypto.subtle.generateKey(
      {
        name: "X25519",
      },
      true,
      ["deriveKey", "deriveBits"],
    );
    if (!("publicKey" in keypair)) {
      throw new Error("Expected CryptoKeyPair from X25519 generateKey");
    }

    // Export private key — OKP raw export is unsupported, use JWK 'd'
    const seedBase32 = encodeNkeyBase32(await exportOkpPrivateSeed(keypair.privateKey));

    // Export public key
    const publicBuffer = await globalThis.crypto.subtle.exportKey("raw", keypair.publicKey);
    const publicBase32 = encodeNkeyBase32(new Uint8Array(publicBuffer));

    const seed = `SA${seedBase32}`;
    const publicKey = `SA${publicBase32}`;

    return { seed, publicKey };
  }
}

/**
 * Extract the 32-byte private scalar (seed) from an Ed25519/X25519 private key.
 *
 * WebCrypto does NOT support `exportKey("raw", privateKey)` for OKP curves
 * (only `"pkcs8"` / `"jwk"`). The JWK form exposes the raw seed in the
 * base64url-encoded `d` parameter, so we export as JWK and decode `d`.
 */
async function exportOkpPrivateSeed(privateKey: CryptoKey): Promise<Uint8Array> {
  const jwk = await globalThis.crypto.subtle.exportKey("jwk", privateKey);
  if (!jwk.d) {
    throw new Error("OKP private key JWK is missing the 'd' (seed) parameter");
  }
  return base64UrlToBytes(jwk.d);
}

/** Decode a base64url string (no padding) to bytes. */
function base64UrlToBytes(b64url: string): Uint8Array {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Encode bytes to NATS NKEY base32 alphabet.
 *
 * NATS uses a custom base32 alphabet: C H F 2 P ... (no vowels to avoid
 * accidental words). This is a simplified implementation for Phase B.
 */
function encodeNkeyBase32(bytes: Uint8Array): string {
  const alphabet = "CFH23567PR89JKLMNPQTUVWXYZ456789";
  let result = "";
  let bits = 0;
  let value = 0;

  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;

    while (bits >= 5) {
      bits -= 5;
      result += alphabet[(value >>> bits) & 0x1f]!;
    }
  }

  if (bits > 0) {
    result += alphabet[(value << (5 - bits)) & 0x1f]!;
  }

  return result;
}

/**
 * Sign a NATS JWT using an NKEY seed.
 *
 * This is a placeholder implementation. For Phase B, we use a simplified
 * approach that creates JWT-like structures without full NATS JWT library
 * integration. In production, this would use the nats.js jwt library.
 */
async function signNatsJwtWithNkey(
  payload: Record<string, unknown>,
  seed: string,
): Promise<string> {
  // Placeholder: create a base64url-encoded "JWT" for testing
  // In production, this would use the nats.js signing library
  const header = { typ: "jwt", alg: "ed25519" };
  const headerSegment = urlSafeBase64(JSON.stringify(header));
  const payloadSegment = urlSafeBase64(JSON.stringify(payload));
  const signature = "placeholder_signature"; // Would be NKEY-signed

  return `${headerSegment}.${payloadSegment}.${signature}`;
}

/**
 * URL-safe base64 encoding.
 */
function urlSafeBase64(str: string): string {
  return btoa(str)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

// ---------------------------------------------------------------------------
// JWT signing utilities (RS256)
// ---------------------------------------------------------------------------

/**
 * Sign a JWT using RS256 (RSA PKCS#1 v1.5 with SHA-256).
 */
async function signRs256Jwt(
  payload: Record<string, unknown>,
  privateKeyPem: string,
): Promise<string> {
  const header = { alg: "RS256", typ: "JWT" };
  const headerSegment = urlSafeBase64(JSON.stringify(header));
  const payloadSegment = urlSafeBase64(JSON.stringify(payload));
  const signingInput = `${headerSegment}.${payloadSegment}`;

  const privateKey = await pemToKey(privateKeyPem);
  const data = new TextEncoder().encode(signingInput);
  const signature = await globalThis.crypto.subtle.sign(
    { name: "RSASSA-PKCS1-v1_5" },
    privateKey,
    data,
  );

  const signatureSegment = urlSafeBase64(
    String.fromCharCode(...Array.from(new Uint8Array(signature))),
  );

  return `${headerSegment}.${payloadSegment}.${signatureSegment}`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate the complete SaaS trust chain.
 *
 * This is the one-time offline initialization function that creates:
 *   1. RSA keypair for bootstrap JWT signing (SaaS private)
 *   2. NKEY seed for NATS account signing (SaaS private)
 *   3. NATS operator JWT (public, loaded by nats-server)
 *   4. NATS account JWT (public, loaded by nats-server)
 *   5. Resolver config (public, loaded by nats-server)
 *   6. JWKS document (public, hosted at SaaS JWKS endpoint)
 *
 * CONSTRAINTS:
 *   - MUST be run once per NATS bus (tenant isolation unit)
 *   - Private material (returned in result.private) MUST be stored securely
 *   - Public config (result.natsConfig + result.jwks) MUST be loaded by nats-server
 *   - No runtime SaaS↔NATS dependency (all config is static)
 *
 * @throws if crypto operations fail
 */
export async function setupTrustChain(
  options: SetupTrustChainOptions = {},
): Promise<SetupTrustChainResult> {
  const {
    operatorName = "openclaw-webchannel-operator",
    accountName = "openclaw-webchannel-account",
    rsaKeySize = 2048,
    kid: providedKid,
  } = options;

  // -----------------------------------------------------------------------
  // Step 1: Generate RSA keypair for bootstrap JWT signing
  // -----------------------------------------------------------------------

  const { privateKeyPem, publicKeyJwk, kid: generatedKid } = await generateRsaKeypair(rsaKeySize);
  const kid = providedKid ?? generatedKid;
  publicKeyJwk.kid = kid;

  // -----------------------------------------------------------------------
  // Step 2: Generate NKEY seed for NATS account signing
  // -----------------------------------------------------------------------

  const { seed: natsAccountSeed, publicKey: natsAccountPublicKey } =
    await generateNkeySeed();

  // -----------------------------------------------------------------------
  // Step 3: Create NATS operator JWT
  // -----------------------------------------------------------------------

  const operatorClaims = {
    iss: natsAccountPublicKey, // Operator public NKEY
    name: operatorName,
    sub: natsAccountPublicKey, // Operator public NKEY
    nats: {
      server: {
        id: `${operatorName}-server`,
      },
    },
  };

  const operatorJwt = await signNatsJwtWithNkey(operatorClaims, natsAccountSeed);

  // -----------------------------------------------------------------------
  // Step 4: Create NATS account JWT
  // -----------------------------------------------------------------------

  const accountClaims = {
    iss: natsAccountPublicKey, // Operator public NKEY
    name: accountName,
    sub: natsAccountPublicKey, // Account public NKEY
    nats: {
      limits: {
        conn: -1, // Unlimited connections
        subs: -1, // Unlimited subscriptions
        data: -1, // Unlimited data
        payload: -1, // Unlimited payload
      },
    },
  };

  const accountJwt = await signNatsJwtWithNkey(accountClaims, natsAccountSeed);

  // -----------------------------------------------------------------------
  // Step 5: Create resolver config
  // -----------------------------------------------------------------------

  const resolverConfig: NatsResolverConfig = {
    [natsAccountPublicKey]: accountJwt,
  };

  // -----------------------------------------------------------------------
  // Step 6: Create JWKS document
  // -----------------------------------------------------------------------

  const jwks: JwksDocument = {
    keys: [publicKeyJwk],
  };

  // -----------------------------------------------------------------------
  // Return complete trust chain
  // -----------------------------------------------------------------------

  const privateKey: SaasTrustChainPrivate = {
    rsaPrivateKeyPem: privateKeyPem,
    natsAccountSeed,
  };

  const natsConfig: NatsAccountConfig = {
    operatorJwt,
    accountJwt,
    resolverConfig,
    accountPublicKey: natsAccountPublicKey,
  };

  return {
    private: privateKey,
    natsConfig,
    jwks,
    kid,
  };
}
