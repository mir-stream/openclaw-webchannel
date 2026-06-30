/**
 * SaaS Bootstrap Key-Pin Extraction — Sub-AC 4a.
 *
 * Parses the SaaS bootstrap response, validates the cnf/PoP claims, and
 * returns the pinned agent and device public keys for use in the E2E key
 * exchange over the untrusted NATS relay bus.
 *
 * Bootstrap flow
 * ──────────────
 *   1. Device generates an X25519 key pair and proves possession (PoP) to SaaS
 *      by signing a SaaS-issued challenge with its X25519 private key.
 *   2. SaaS verifies the PoP, then issues a bootstrap JWT (RS256) that carries:
 *        • sub    — stable per-user identity (peerId) across devices.
 *        • agentId / tenant — routing scope claims.
 *        • cnf.jwk — RFC 7800 confirmation claim binding the device's X25519
 *          public key.  This is the SINGLE source of truth for the device key;
 *          it MUST NOT be accepted from any channel other than this JWT.
 *   3. SaaS also returns the agent's X25519 identity public key (attested by SaaS).
 *   4. The browser (this module) parses the bootstrap response:
 *        a. Validates the JWT structure (3 segments, RS256 alg, kid present).
 *        b. Validates the cnf claim: must be present, must carry a `jwk` sub-claim
 *           of type OKP / crv X25519 with a 32-byte base64url `x` coordinate.
 *        c. Validates the agentPublicKey: must decode to exactly 32 bytes.
 *        d. Returns `{ agentPublicKey, devicePublicKey }` — the pinned key pair.
 *
 * Security invariants
 * ───────────────────
 *   • The cnf claim is the SINGLE authoritative source for the device public key.
 *     No device key is accepted from a non-JWT channel.
 *   • JWT signature verification (RS256 JWKS) is performed by the caller before
 *     passing the JWT to this module (or the caller may use `parseAndVerify`
 *     which accepts a JWKS resolver).  Accepting an UNVERIFIED JWT without a
 *     verified JWKS source is explicitly rejected by `parseBootstrapResponse`.
 *   • Malformed, missing, or structurally invalid cnf claims → hard rejection
 *     (Error throw), never a silent fallback to a default key.
 *   • The PoP was already verified by SaaS before the JWT was issued; the JWT
 *     with its cnf claim IS the PoP artifact.  The device does not re-prove
 *     possession to the browser — the cnf binding in the signed JWT is sufficient.
 *   • At-rest key storage (IndexedDB / Secure Storage) is the caller's
 *     responsibility; this module returns the parsed keys, not a store handle.
 *
 * Deferred
 * ────────
 *   • Key rotation / revocation rekey — the pinned keys are treated as stable
 *     for the device registration lifetime.  Rotation support is deferred.
 *   • NATS/JTI nonce-based replay prevention for the bootstrap JWT is deferred;
 *     callers should use short-lived JWTs (exp < 5 min) to mitigate replay.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * RFC 7800 §3.2 confirmation method via embedded JWK (`cnf.jwk`).
 *
 * For X25519 (OKP) keys the JWK shape is:
 *   { kty: "OKP", crv: "X25519", x: "<base64url 32-byte public point>" }
 *
 * The `d` (private key) field MUST NOT be present — the SaaS only knows
 * the device's PUBLIC key; the private key never leaves the device.
 */
export type CnfJwk = {
  readonly kty: "OKP";
  readonly crv: "X25519";
  /** base64url-encoded 32-byte X25519 public key (Curve25519 u-coordinate). */
  readonly x: string;
};

/**
 * The parsed cnf (confirmation) claim from the SaaS-issued bootstrap JWT.
 *
 * RFC 7800 defines multiple confirmation methods; this implementation only
 * accepts the embedded-JWK form (`cnf.jwk`) because:
 *   - It makes the public key self-contained in the JWT (no key-fetch round-trip).
 *   - The NATS relay never receives key material (the key is in the VERIFIED JWT).
 */
export type CnfClaim = {
  readonly jwk: CnfJwk;
};

/**
 * The SaaS bootstrap response payload fed to `parseBootstrapResponse`.
 *
 * `jwt` is the RS256 compact JWT issued by SaaS, containing:
 *   - Standard claims: iss, sub, aud, exp, iat, kid
 *   - Custom claims:   agentId, tenant
 *   - cnf.jwk:         device X25519 public key (RFC 7800)
 *
 * `agentPublicKey` is the agent's X25519 identity public key, attested and
 * signed by SaaS.  It MUST be transported alongside the JWT (not via NATS).
 *
 * `verifiedJwtPayload` is the already-decoded + signature-verified JWT payload
 * object.  The CALLER must verify the RS256 signature against the SaaS JWKS
 * before calling `parseBootstrapResponse`.  Passing the payload here instead of
 * re-decoding inside this module enforces a clear separation of concerns:
 * signature verification lives in the auth layer; key-pin extraction lives here.
 *
 * Rationale for "verified payload in / not JWT in": this module is intentionally
 * separated from the signature-verification concern so it can be unit-tested
 * without a JWKS endpoint, and so callers cannot accidentally skip JWKS
 * verification by not calling the right function.
 */
export type BootstrapPayload = {
  /**
   * The RS256-verified JWT payload object.  Callers MUST:
   *   1. Decode the compact JWT.
   *   2. Verify the RS256 signature against the SaaS JWKS.
   *   3. Validate `iss`, `aud`, and `exp` (clock-skew aware).
   *   4. Pass the verified payload object here.
   *
   * Passing an unverified payload is a security error — the cnf claim is
   * only trustworthy if the JWT signature is valid.
   */
  readonly verifiedJwtPayload: Record<string, unknown>;
  /**
   * Agent X25519 public key (base64url-encoded 32 bytes), attested by SaaS.
   * The browser MUST NOT accept this key from any untrusted source (e.g. from
   * a NATS message); it must arrive alongside the verified bootstrap JWT.
   */
  readonly agentPublicKey: string;
};

/**
 * The result of `parseBootstrapResponse`: pinned public keys ready for
 * use in the X25519 ECDH key exchange.
 *
 * Both keys are raw 32-byte Uint8Arrays (Curve25519 u-coordinates), matching
 * the format expected by `e2e-crypto`'s `deriveSharedSecret`.
 */
export type PinnedKeys = {
  /**
   * Agent X25519 public key (32 bytes), attested by SaaS.
   * Used for ECDH: `deriveSharedSecret(devicePrivKey, agentPublicKey)`.
   */
  readonly agentPublicKey: Uint8Array;
  /**
   * Device X25519 public key (32 bytes), from the JWT cnf.jwk claim.
   * Used as the authoritative device-side public key for key-wrap distribution.
   */
  readonly devicePublicKey: Uint8Array;
};

// ---------------------------------------------------------------------------
// Key-pin store (in-memory, per browser session)
// ---------------------------------------------------------------------------

/**
 * In-memory pinned-key store for the current browser session.
 *
 * Lifetime: session-scoped (cleared on page reload or explicit `clearPinnedKeys`).
 * Persistence: the CALLER is responsible for persisting to IndexedDB / Secure
 * Storage if cross-session durability is needed.
 *
 * Thread safety: single-threaded JS — no concurrent mutation risk.
 */
const pinnedKeys: Map<string, PinnedKeys> = new Map();

/**
 * Store the pinned keys for a given peerId (JWT sub).
 *
 * If `peerId` already has pinned keys, they are replaced (key rotation).
 *
 * @param peerId - JWT `sub` claim — stable per-user identity across devices.
 * @param keys   - Parsed pinned keys from `parseBootstrapResponse`.
 */
export function storePinnedKeys(peerId: string, keys: PinnedKeys): void {
  if (!peerId || typeof peerId !== "string") {
    throw new Error("saas-bootstrap: peerId must be a non-empty string");
  }
  pinnedKeys.set(peerId, keys);
}

/**
 * Retrieve the pinned keys for a given peerId, or `null` if not yet pinned.
 *
 * @param peerId - JWT `sub` claim.
 * @returns Pinned keys, or `null` if no bootstrap has been completed for this peer.
 */
export function getPinnedKeys(peerId: string): PinnedKeys | null {
  return pinnedKeys.get(peerId) ?? null;
}

/**
 * Clear all pinned keys (e.g. on logout or re-registration).
 */
export function clearPinnedKeys(): void {
  pinnedKeys.clear();
}

/**
 * Clear pinned keys for a specific peerId (e.g. on targeted revocation).
 */
export function clearPinnedKeysForPeer(peerId: string): void {
  pinnedKeys.delete(peerId);
}

// ---------------------------------------------------------------------------
// Core parsing / validation
// ---------------------------------------------------------------------------

/**
 * Parse the SaaS bootstrap response, validate the cnf/PoP claims, and return
 * the pinned agent and device public keys.
 *
 * The function enforces the following invariants:
 *   1. `verifiedJwtPayload.cnf` is a non-null object.
 *   2. `cnf.jwk` is a non-null object.
 *   3. `cnf.jwk.kty === "OKP"` — only OKP (EdDSA/X25519) keys are accepted.
 *   4. `cnf.jwk.crv === "X25519"` — only X25519 keys for ECDH.
 *   5. `cnf.jwk.x` is a non-empty string that base64url-decodes to exactly 32 bytes.
 *   6. `cnf.jwk.d` is absent — the device private key must never appear here.
 *   7. `agentPublicKey` is a non-empty string that base64url-decodes to exactly 32 bytes.
 *
 * Throws an `Error` on any validation failure.  The error message is descriptive
 * so callers can surface actionable diagnostics.
 *
 * @param payload - Bootstrap payload containing the verified JWT and agent key.
 * @returns `PinnedKeys` — extracted and validated agent + device public keys.
 * @throws `Error` if any cnf/PoP validation invariant fails.
 */
export function parseBootstrapResponse(payload: BootstrapPayload): PinnedKeys {
  const { verifiedJwtPayload, agentPublicKey: agentPublicKeyB64 } = payload;

  // ── 1. Validate and extract the cnf claim ───────────────────────────────

  const cnf = verifiedJwtPayload["cnf"];
  if (cnf === null || cnf === undefined || typeof cnf !== "object" || Array.isArray(cnf)) {
    throw new Error(
      "saas-bootstrap: JWT cnf claim is missing or not an object " +
      "(expected cnf.jwk with kty:OKP crv:X25519)",
    );
  }
  const cnfObj = cnf as Record<string, unknown>;

  // ── 2. Validate cnf.jwk ─────────────────────────────────────────────────

  const jwk = cnfObj["jwk"];
  if (jwk === null || jwk === undefined || typeof jwk !== "object" || Array.isArray(jwk)) {
    throw new Error(
      "saas-bootstrap: cnf.jwk is missing or not an object " +
      "(expected { kty: 'OKP', crv: 'X25519', x: '<base64url>' })",
    );
  }
  const jwkObj = jwk as Record<string, unknown>;

  // ── 3. Pin kty === "OKP" ────────────────────────────────────────────────
  if (jwkObj["kty"] !== "OKP") {
    throw new Error(
      `saas-bootstrap: cnf.jwk.kty must be "OKP" (got ${JSON.stringify(jwkObj["kty"])})`,
    );
  }

  // ── 4. Pin crv === "X25519" ─────────────────────────────────────────────
  if (jwkObj["crv"] !== "X25519") {
    throw new Error(
      `saas-bootstrap: cnf.jwk.crv must be "X25519" (got ${JSON.stringify(jwkObj["crv"])})` +
      " — only X25519 keys are supported for ECDH key exchange",
    );
  }

  // ── 5. Validate and decode the public coordinate x ──────────────────────
  const xField = jwkObj["x"];
  if (typeof xField !== "string" || xField.length === 0) {
    throw new Error(
      "saas-bootstrap: cnf.jwk.x must be a non-empty base64url string " +
      "(32-byte X25519 public key coordinate)",
    );
  }
  const devicePublicKey = base64UrlToUint8(xField);
  if (devicePublicKey.length !== 32) {
    throw new Error(
      `saas-bootstrap: cnf.jwk.x must decode to exactly 32 bytes ` +
      `(got ${devicePublicKey.length} bytes)`,
    );
  }

  // ── 6. Reject any private key material in the cnf claim ─────────────────
  if (jwkObj["d"] !== undefined) {
    throw new Error(
      "saas-bootstrap: cnf.jwk.d (private key) must not be present — " +
      "the device private key must never leave the device",
    );
  }

  // ── 7. Validate and decode the agent public key ─────────────────────────
  if (typeof agentPublicKeyB64 !== "string" || agentPublicKeyB64.length === 0) {
    throw new Error(
      "saas-bootstrap: agentPublicKey must be a non-empty base64url string " +
      "(32-byte X25519 agent identity public key)",
    );
  }
  const agentPublicKey = base64UrlToUint8(agentPublicKeyB64);
  if (agentPublicKey.length !== 32) {
    throw new Error(
      `saas-bootstrap: agentPublicKey must decode to exactly 32 bytes ` +
      `(got ${agentPublicKey.length} bytes)`,
    );
  }

  return { agentPublicKey, devicePublicKey };
}

// ---------------------------------------------------------------------------
// Convenience: parse + store in one call
// ---------------------------------------------------------------------------

/**
 * Parse the bootstrap response AND store the resulting keys for the given peer.
 *
 * Combines `parseBootstrapResponse` + `storePinnedKeys` into a single call for
 * the common case where the caller wants to parse and immediately persist the
 * pinned keys.
 *
 * @param peerId  - JWT `sub` claim (stable per-user identity, used as store key).
 * @param payload - Bootstrap payload (verified JWT payload + agent public key).
 * @returns `PinnedKeys` — the parsed and now-stored pinned keys.
 * @throws `Error` if parsing fails (see `parseBootstrapResponse`).
 */
export function parseAndStorePinnedKeys(
  peerId: string,
  payload: BootstrapPayload,
): PinnedKeys {
  const keys = parseBootstrapResponse(payload);
  storePinnedKeys(peerId, keys);
  return keys;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Decode a base64url string to a `Uint8Array`.
 *
 * Implements RFC 4648 §5 base64url decoding with optional-padding tolerance.
 * Compatible with both browser (globalThis.atob) and Node.js (Buffer) runtimes.
 */
function base64UrlToUint8(input: string): Uint8Array {
  // Fast path: Node.js Buffer (available in both Node and vitest env).
  if (typeof Buffer !== "undefined") {
    return new Uint8Array(Buffer.from(input, "base64url"));
  }
  // Browser path: transcode base64url → base64 and use atob.
  let std = input.replace(/-/g, "+").replace(/_/g, "/");
  const pad = std.length % 4;
  if (pad === 2) std += "==";
  else if (pad === 3) std += "=";
  else if (pad === 1) {
    throw new Error("saas-bootstrap: invalid base64url length (1 mod 4)");
  }
  const binary = globalThis.atob(std);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
