/**
 * Bootstrap JWT claim builder — the SaaS producer side of device key pinning.
 *
 * The browser bootstrap JWT (RS256, verified by the plugin against the SaaS
 * JWKS) carries TWO device public keys, both bound by the signature:
 *
 *   - `cnf.jwk`  — RFC 7800 confirmation: the device's X25519 public key, the
 *     single source of truth for the E2E key exchange (parsed by the browser's
 *     `saas-bootstrap.ts`).
 *   - `pop_jwk`  — the device's Ed25519 PoP public key. Proof-of-Possession at
 *     peer registration: the plugin issues a nonce and the device must sign
 *     `webchannel-pop:<peerId>:<nonce>` with the matching Ed25519 PRIVATE key
 *     (parsed by the plugin's `jwt.ts`, verified by `pop-challenge.ts`).
 *
 * The two keys are deliberately SEPARATE: X25519 is for ECDH and cannot sign, so
 * Proof-of-Possession needs its own Ed25519 signing key (standard RFC 7800 split).
 *
 * This module builds the claim object only; signing (RS256) is the issuer's job.
 */

/** Device X25519 public key (cnf.jwk) — base64url 32-byte `x`. */
export type DeviceCnfJwk = {
  readonly kty: "OKP";
  readonly crv: "X25519";
  readonly x: string;
};

/** Device Ed25519 PoP public key (pop_jwk) — base64url 32-byte `x`. */
export type DevicePopJwk = {
  readonly kty: "OKP";
  readonly crv: "Ed25519";
  readonly x: string;
};

export type BootstrapClaimsInput = {
  /** Token issuer (SaaS base URL). */
  iss: string;
  /** Stable per-user identity = peerId = JWT `sub`. */
  peerId: string;
  /** Account (deployment) identity = wire identity (also the JWT `aud`). */
  accountId: string;
  /** Tenant scope. */
  tenant: string;
  /** Device X25519 public key (base64url 32 bytes) → `cnf.jwk`. */
  deviceX25519PublicKey: string;
  /**
   * Device Ed25519 PoP public key (base64url 32 bytes) → `pop_jwk`.
   * Omit only for legacy bootstraps that pre-date PoP; when present, the plugin
   * REQUIRES a valid signed-nonce proof at registration.
   */
  devicePopPublicKey?: string;
  /** Issued-at (unix seconds). Defaults to now. */
  nowSeconds?: number;
  /** Lifetime in seconds (default 300 — keep short to limit replay). */
  ttlSeconds?: number;
};

/** Bootstrap JWT payload shape (the object an issuer RS256-signs). */
export type BootstrapClaims = {
  iss: string;
  sub: string;
  aud: string;
  exp: number;
  iat: number;
  accountId: string;
  tenant: string;
  cnf: { jwk: DeviceCnfJwk };
  pop_jwk?: DevicePopJwk;
};

const DEFAULT_TTL_SECONDS = 300;

/** Assert a base64url string decodes to exactly 32 bytes (an OKP public key). */
function assert32Bytes(label: string, b64url: string): void {
  const len = Buffer.from(b64url, "base64url").length;
  if (len !== 32) {
    throw new Error(`bootstrap-claims: ${label} must be a 32-byte base64url key (got ${len} bytes)`);
  }
}

/**
 * Build the bootstrap JWT claim object, embedding the device's X25519 key as
 * `cnf.jwk` and (when supplied) its Ed25519 PoP key as `pop_jwk`.
 */
export function buildBootstrapClaims(input: BootstrapClaimsInput): BootstrapClaims {
  if (!input.peerId) throw new Error("bootstrap-claims: peerId is required");
  assert32Bytes("deviceX25519PublicKey", input.deviceX25519PublicKey);
  if (input.devicePopPublicKey) assert32Bytes("devicePopPublicKey", input.devicePopPublicKey);

  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const ttl = input.ttlSeconds ?? DEFAULT_TTL_SECONDS;

  const claims: BootstrapClaims = {
    iss: input.iss,
    sub: input.peerId,
    aud: input.accountId,
    exp: now + ttl,
    iat: now,
    accountId: input.accountId,
    tenant: input.tenant,
    cnf: { jwk: { kty: "OKP", crv: "X25519", x: input.deviceX25519PublicKey } },
  };
  if (input.devicePopPublicKey) {
    claims.pop_jwk = { kty: "OKP", crv: "Ed25519", x: input.devicePopPublicKey };
  }
  return claims;
}
