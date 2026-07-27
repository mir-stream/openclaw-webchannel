/**
 * Zero-dependency RS256 JWT verifier for the `jwt` auth strategy.
 *
 * AUTH.md §10: SaaS operators / IdPs issue RS256 JWTs carrying `kid`, `iss`,
 * `aud`, `exp`, `sub` (and optional display name claims). The browser presents
 * the compact JWT during the NATS register hop; the plugin validates it against
 * a JWKS public key resolved by `kid`.
 *
 * CONSTRAINTS:
 *  - Use only `globalThis.crypto.subtle` (Cloudflare Workers + Node 18+ both
 *    expose it as part of the Web Crypto API surface).
 *  - Pin `alg === "RS256"` — reject `none`, `HS256` (algorithm-confusion), and
 *    every other algorithm outright.
 *  - Constant-time string compare for `iss` / `aud`.
 *  - Return `null` on EVERY failure mode (parse error, segment count, alg
 *    mismatch, signature fail, kid miss, claim fail, etc). Never throw — a bad
 *    token is just an authentication failure.
 *
 * WHY zero-dep: the SAME verifier must run in two independent Node processes
 * (host backend issuing tickets, gateway plugin verifying them) AND in the
 * Cloudflare Worker runtime. Pulling `jsonwebtoken` would either mismatch
 * runtimes or balloon the bundle; the small RS256 subset we need is hand-rolled
 * on top of Web Crypto's `verify`, which is byte-identical everywhere.
 */

import type { KeyResolver } from "./jwks.js";

/**
 * Constant-time string equality. XOR-accumulating byte differences across the
 * full length defeats timing oracles; if the lengths differ we still walk a
 * fixed-length loop so the comparison time is independent of where the
 * difference lies.
 *
 * `Buffer`-based comparison would not work for `Uint8Array` inputs of
 * mismatched length safely, but here we only compare strings.
 */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    // Still walk a comparable amount of work so a length mismatch doesn't
    // short-circuit early and leak the length.
    let dummy = 0;
    for (let i = 0; i < a.length; i++) dummy |= a.charCodeAt(i) ^ b.charCodeAt(i % b.length);
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Collapse any trailing slash(es) from a URL-style issuer so `https://x` and
 * `https://x/` compare equal. Used ONLY for the `iss` claim comparison — a
 * trailing slash is not a meaningful part of an origin identifier.
 */
function stripTrailingSlashes(s: string): string {
  return s.replace(/\/+$/, "");
}

/**
 * RFC 4648 §5 base64url decode that tolerates missing padding. We can't use
 * Node's `Buffer.from(..., "base64url")` because that path isn't available in
 * Cloudflare Workers; the Web Crypto API only gives us raw bytes via
 * `globalThis.atob` (Workers + browsers) — and `atob` expects STANDARD
 * base64, not base64url. So we transcode.
 *
 * Output is a `Uint8Array` (compatible with `crypto.subtle.verify`'s
 * `BufferSource` parameter and Workers' lack of `Buffer`).
 */
function base64UrlDecode(input: string): Uint8Array {
  if (typeof input !== "string" || input.length === 0) {
    throw new Error("webchannel: empty base64url segment");
  }
  // base64url → base64: replace chars and add padding.
  let std = input.replace(/-/g, "+").replace(/_/g, "/");
  const pad = std.length % 4;
  if (pad === 2) std += "==";
  else if (pad === 3) std += "=";
  else if (pad === 1) throw new Error("webchannel: invalid base64url length");
  // atob returns a binary string; transcode to Uint8Array.
  const binary = globalThis.atob(std);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * RFC 7800 §3.2 confirmation method via embedded JWK (`cnf.jwk`).
 *
 * For X25519 (OKP) keys the JWK shape is:
 *   { kty: "OKP", crv: "X25519", x: "<base64url 32-byte public point>" }
 *
 * The `d` (private key) field MUST NOT be present — the device private key
 * must never appear in a JWT.
 */
export type CnfJwk = {
  readonly kty: "OKP";
  readonly crv: "X25519";
  /** base64url-encoded 32-byte X25519 public key (Curve25519 u-coordinate). */
  readonly x: string;
};

/**
 * The cnf (confirmation) claim from a verified JWT.
 *
 * RFC 7800 defines multiple confirmation methods; this implementation only
 * accepts the embedded-JWK form (`cnf.jwk`) because:
 *   - It makes the public key self-contained in the JWT (no key-fetch round-trip).
 *   - The relay never receives key material (the key is in the VERIFIED JWT).
 */
export type CnfClaim = {
  readonly jwk: CnfJwk;
};

/**
 * The public identity `verifyJwt` returns. `peerId` is the gateway's session
 * key — it MUST come from a verified claim, not the request URL. `displayName`
 * is best-effort metadata for the chat UI; missing claims simply omit it.
 *
 * `devicePublicKey` is the X25519 device public key from the cnf.jwk claim,
 * base64url-encoded. This key is SaaS-attested and MUST be used for ECDH
 * key exchange — no other device key may be accepted (MITM prevention).
 *
 * `verifyJwt` returns `null` on ANY failure; the verifier in `auth.ts` is
 * expected to convert null to a connection rejection.
 */
export type JwtIdentity = {
  peerId: string;
  tenant?: string;
  displayName?: string;
  /** Device X25519 public key from cnf.jwk (base64url, 32 bytes when decoded). */
  devicePublicKey?: string;
  /**
   * Device Ed25519 PoP public key from the `pop_jwk` claim (OKP/Ed25519). Used
   * to verify the signed-nonce proof-of-possession at peer registration. This
   * is a SIGNING key, distinct from the X25519 `cnf.jwk` (which cannot sign).
   */
  popPublicJwk?: { kty: string; crv: string; x: string };
};

export type VerifyJwtOptions = {
  /**
   * Caller-provided JWKS-backed key resolver. The JWT verifier doesn't know or
   * care HOW the resolver fetches — it just calls `getKey(kid)` and trusts the
   * result. `getKey` MUST throw on miss / network failure (fail-closed), which
   * we propagate to the caller as a rejection.
   */
  jwks: KeyResolver;
  /**
   * Expected `iss` claim. Token rejected on mismatch (constant-time compare).
   */
  issuer: string;
  /**
   * Expected `aud` claim — string OR array. If the token's `aud` is an array,
   * it's accepted when the expected audience appears anywhere in it.
   */
  audience: string;
  /**
   * Allowed clock-skew leeway in seconds when checking `exp`. Default 60.
   */
  clockSkewSec?: number;
};

/**
 * Verify an RS256 JWT and return its identity, or `null` on ANY failure:
 *  - non-string / empty token
 *  - segment count != 3
 *  - header alg != "RS256" (rejects "none" / "HS256" / "ES256" / etc)
 *  - header missing `kid`
 *  - JWKS `getKey(kid)` throws (network / miss-after-refetch) — propagates as
 *    REJECTION (we re-throw to the caller rather than swallow the network
 *    failure as a silent auth bypass)
 *  - signature verification fails (Web Crypto `verify` returns false)
 *  - header / payload JSON parse fails
 *  - `iss` doesn't match (constant-time)
 *  - `aud` doesn't match (constant-time; array-aware)
 *  - `exp` is missing, non-numeric, or expired beyond `clockSkewSec`
 *
 * We DO re-throw `jwks.getKey(kid)` failures because swallowing them would
 * silently accept or reject based on stale data — that's the kind of behavior
 * a fail-closed seam explicitly forbids (AC5).
 */
export async function verifyJwt(
  token: unknown,
  opts: VerifyJwtOptions,
): Promise<JwtIdentity | null> {
  if (typeof token !== "string" || token.length === 0) return null;

  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerSegment, payloadSegment, signatureSegment] = parts;
  if (!headerSegment || !payloadSegment || !signatureSegment) return null;

  // Step 1: header. Pin alg = RS256 (defense-in-depth; signature check below
  // would already reject mismatched algs via Web Crypto, but we refuse to even
  // run the verify for non-RS256 tokens).
  let header: Record<string, unknown>;
  try {
    const decoded = base64UrlDecode(headerSegment);
    const text = new TextDecoder("utf-8").decode(decoded);
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    header = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  if (header.alg !== "RS256") return null;

  // Step 2: extract kid. Missing kid is a hard reject — we never default to a
  // single key (the operator's IdP could rotate).
  const kid = header.kid;
  if (typeof kid !== "string" || kid.length === 0) return null;

  // Step 3: decode signature bytes up-front so a bad signature segment is a
  // clean reject (the Web Crypto API throws on invalid input, which we want to
  // turn into null here).
  let signatureBytes: Uint8Array;
  try {
    signatureBytes = base64UrlDecode(signatureSegment);
  } catch {
    return null;
  }

  // Step 4: import the public key from JWKS and verify. `getKey` may throw
  // (network error, kid miss-after-refetch) — we let it propagate so the
  // gateway can fail closed; we do NOT catch + return null because that would
  // mask infrastructure failures as authentication failures of unclear origin.
  const jwk = await opts.jwks.getKey(kid);
  const publicKey = await globalThis.crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );

  // Re-derive the exact signing input from the *original* segments (not from
  // re-encoded JSON) so the verification matches the issuer's byte-exact input.
  // Copy the signature + signing-input buffers into fresh ArrayBuffers so the
  // call satisfies the DOM lib's `BufferSource = ArrayBufferView<ArrayBuffer>`
  // constraint (a Uint8Array constructed from an `ArrayBufferLike` is rejected
  // by the strict DOM typings in the client tsconfig).
  const signingInput = `${headerSegment}.${payloadSegment}`;
  const ok = await globalThis.crypto.subtle.verify(
    { name: "RSASSA-PKCS1-v1_5" },
    publicKey,
    signatureBytes.slice().buffer,
    new TextEncoder().encode(signingInput).slice().buffer,
  );
  if (!ok) return null;

  // Step 5: payload. Signature is valid; now validate the claims.
  let payload: Record<string, unknown>;
  try {
    const decoded = base64UrlDecode(payloadSegment);
    const text = new TextDecoder("utf-8").decode(decoded);
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    payload = parsed as Record<string, unknown>;
  } catch {
    return null;
  }

  // iss — constant-time compare against expected issuer, tolerant of a trailing
  // slash. A URL issuer `https://x` and `https://x/` denote the same origin, but
  // the SaaS mints `iss` verbatim from its base URL while the gateway derives its
  // EXPECTED issuer from a possibly-differently-slashed `--base-url`; an exact
  // compare turns that cosmetic difference into a silent reject-every-token trap.
  // Collapsing trailing slashes on BOTH sides removes it for every deployment
  // (including external IdPs the plugin can't normalize). NOT a relaxation: it
  // only equates trailing-slash variants of the SAME issuer, never distinct hosts.
  if (typeof payload.iss !== "string") return null;
  if (!constantTimeEqual(stripTrailingSlashes(payload.iss), stripTrailingSlashes(opts.issuer))) {
    return null;
  }

  // aud — string OR array. We accept if the expected audience appears anywhere.
  const aud = payload.aud;
  if (typeof aud === "string") {
    if (!constantTimeEqual(aud, opts.audience)) return null;
  } else if (Array.isArray(aud)) {
    // Reject a malformed array as a whole. Filtering non-string members and
    // accepting a remaining match would let an issuer accidentally mint a
    // claim with ambiguous/non-RFC audience semantics.
    if (aud.length === 0 || !aud.every((value) => typeof value === "string")) {
      return null;
    }
    let matched = false;
    for (const a of aud) {
      if (constantTimeEqual(a as string, opts.audience)) {
        matched = true;
        break;
      }
    }
    if (!matched) return null;
  } else {
    return null;
  }

  // exp — numeric, not expired (modulo clockSkewSec).
  const exp = payload.exp;
  if (typeof exp !== "number" || !Number.isFinite(exp)) return null;
  const leeway = opts.clockSkewSec ?? 60;
  const now = Math.floor(Date.now() / 1000);
  // Reject if now is at or past expiry (allowing leeway).
  if (now >= exp + leeway) return null;

  // sub — non-empty string (peerId).
  if (typeof payload.sub !== "string" || payload.sub.length === 0) return null;

  // ── cnf claim validation (AC 4: SaaS-attested device key) ───────────────

  let devicePublicKeyB64: string | undefined;
  const cnf = payload.cnf;
  if (cnf !== undefined && cnf !== null && typeof cnf === "object" && !Array.isArray(cnf)) {
    const cnfObj = cnf as Record<string, unknown>;

    // Extract cnf.jwk if present
    const jwk = cnfObj["jwk"];
    if (jwk !== undefined && jwk !== null && typeof jwk === "object" && !Array.isArray(jwk)) {
      const jwkObj = jwk as Record<string, unknown>;

      // Validate kty === "OKP"
      if (jwkObj["kty"] === "OKP" && jwkObj["crv"] === "X25519") {
        const x = jwkObj["x"];
        if (typeof x === "string" && x.length > 0) {
          // Verify no private key present
          if (jwkObj["d"] === undefined) {
            // Verify x decodes to exactly 32 bytes
            try {
              const decoded = base64UrlDecode(x);
              if (decoded.length === 32) {
                devicePublicKeyB64 = x;
              }
              // If decoded length != 32, we reject the cnf claim entirely
            } catch {
              // Invalid base64url — reject cnf claim
            }
          }
          // If private key present, we reject the cnf claim entirely (security error)
        }
        // If x missing/empty, we reject the cnf claim entirely
      }
      // If kty/crv don't match, we reject the cnf claim entirely
    }
    // If jwk missing/invalid, we reject the cnf claim entirely

    // If cnf claim is present but validation fails, reject the entire JWT
    // (a malformed cnf is a security issue — we must not admit unverified keys)
    if (!devicePublicKeyB64) {
      return null;
    }
  }
  // If cnf is absent, we proceed without device key (backward compatibility,
  // but the caller should enforce device key attestation in production).

  // displayName — best-effort, prefers `name` then `preferred_username`
  // (OIDC convention). Anything else is ignored silently.
  const identity: JwtIdentity = { peerId: payload.sub };
  if (typeof payload.tenant === "string" && payload.tenant.length > 0) identity.tenant = payload.tenant;
  const dn = payload.name ?? payload.preferred_username;
  if (typeof dn === "string" && dn.length > 0) identity.displayName = dn;
  if (devicePublicKeyB64) identity.devicePublicKey = devicePublicKeyB64;

  // pop_jwk — Ed25519 PoP public key (RFC 7800-style split key). Presence is a
  // security commitment: a malformed present claim must reject the JWT rather
  // than degrade to "PoP absent" when requirePoP=false.
  const popJwk = (payload as Record<string, unknown>)["pop_jwk"];
  if (popJwk !== undefined) {
    if (!popJwk || typeof popJwk !== "object" || Array.isArray(popJwk)) return null;
    const p = popJwk as Record<string, unknown>;
    if (
      p["kty"] !== "OKP" ||
      p["crv"] !== "Ed25519" ||
      typeof p["x"] !== "string" ||
      p["x"].length === 0 ||
      p["d"] !== undefined
    ) return null;
    try {
      if (base64UrlDecode(p["x"]).length !== 32) return null;
    } catch {
      return null;
    }
    identity.popPublicJwk = { kty: "OKP", crv: "Ed25519", x: p["x"] };
  }
  return identity;
}
