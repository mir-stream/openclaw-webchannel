import type { IncomingMessage } from "node:http";

import { verifyJwt } from "./jwt.js";
import type { JwtIdentity } from "./jwt.js";
import { JWKSCache, JwksUnavailableError } from "./jwks.js";

/**
 * Verification could NOT be performed because a dependency (the JWKS source) was
 * unavailable — a transient infrastructure fault, NOT a decision about the token.
 * The register handler answers this with a distinct retryable code (503) rather
 * than a terminal 401, so a momentary JWKS/IdP hiccup doesn't permanently kill a
 * session. It is NOT an oracle: a transient failure and a genuine reject are both
 * non-admit; only the client's retry disposition differs (503 → retry, 401 → stop).
 */
export class TransientVerifyError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options as ErrorOptions);
    this.name = "TransientVerifyError";
  }
}

/**
 * The auth seam. AUTH.md §3: every built-in or custom strategy converges to ONE
 * contract — a `ConnectionVerifier` run in `transport.handleUpgrade`. Its result
 * (`peerId`) becomes the session key, so closing the auth hole also gives us
 * per-user session separation. This file is SDK-free and `ws`-free; it needs
 * only `node:http` types + `./jwt.js`.
 */

/**
 * The single anonymous peer id. Defined HERE (the auth module) as the source of
 * truth and re-exported by `transport.ts`, since "what identity an unauthed
 * connection gets" is an auth decision, not a transport one.
 */
export const ANON_PEER_ID = "web-anon";

// NOTE (Phase 6 / W7): the module-global "pinned device key" store that lived
// here is GONE. It was peerId-keyed (so two devices of one user collided,
// last-writer-wins — audit F2) and its only intended consumer, the
// handshake-time verifier (`handshake-verifier.ts`), was never wired (review
// finding C2). The register-delivered key model replaces both: the register
// route wraps the conversation key to the device key presented in THAT
// request's verified JWT `cnf` claim (`identity.devicePublicKey`), so there is
// no cross-request key store to poison or collide.

export type ConnectionIdentity = { peerId: string; displayName?: string };
export type ConnectionVerifier = (
  req: IncomingMessage,
) => Promise<ConnectionIdentity | null>;

/**
 * Minimal logger shape we accept (matches OpenClaw's optional-method logger).
 * Kept structural so we don't import the SDK.
 */
export type AuthLogger = {
  warn?: (msg: string) => void;
  info?: (msg: string) => void;
  error?: (msg: string) => void;
};

/**
 * A secret may be given inline (a plain string, discouraged) or as an env
 * reference resolved from `process.env` at startup. Richer SecretRef forms
 * (file/exec) are intentionally out of scope here. Consumed by the NATS
 * static-credential source (`nats-credential-source.ts`).
 */
export type SecretRef = string | { env: string };

export type AnonymousAuthConfig = { strategy: "anonymous" };

/**
 * JWT (RS256 / JWKS) auth config. The gateway validates compact JWTs against
 * an asymmetric public key resolved from a JWKS source. See AUTH.md §10 for
 * the full operator-facing documentation and IdP integration examples.
 *
 * `issuer` / `audience` are required claims: a missing mismatch rejects every
 * token (intentional fail-closed default — no silent "trust any iss/aud"
 * fallback). `jwksUrl` / `jwksFile` / `jwks` is the key source (exactly one;
 * `resolveVerifier` throws if zero or more than one is supplied). `clockSkew`
 * defaults to 60s, `ticketParam` to "ticket".
 */
export type JwtAuthConfig = {
  strategy: "jwt";
  jwt: {
    /** HTTPS URL that returns a JWKS document. Mutually exclusive with `jwksFile`/`jwks`. */
    jwksUrl?: string;
    /** Inline JWKS document (object). Mutually exclusive with `jwksUrl`/`jwksFile`. */
    jwks?: import("./jwks.js").JsonWebKeySet;
    /** Path to a JWKS file baked into the deployment. Mutually exclusive with the others. */
    jwksFile?: string;
    /** Expected `iss` claim. Rejected on mismatch (constant-time compare). */
    issuer: string;
    /** Expected `aud` claim — string OR array containing it. */
    audience: string;
    /** Allowed clock-skew leeway in seconds when checking `exp`. Default 60. */
    clockSkew?: number;
    /**
     * @internal Test-only: override the HTTP fetch implementation used when
     * resolving a `jwksUrl`. Injected by unit tests to simulate a JWKS server
     * without opening a real socket. Production code never sets this field.
     */
    _fetchImpl?: typeof fetch;
  };
  /** Query param the JWT arrives in. Default `"ticket"`. */
  ticketParam?: string;
  /**
   * Require Proof-of-Possession at the NATS register hop. Secure-by-default:
   * when unset the plugin behaves as `true`, so a verified bootstrap JWT that
   * carries no `pop_jwk` is REJECTED before any peer is registered. Set to
   * `false` to restore the legacy optional-PoP behavior (dev only).
   */
  requirePoP?: boolean;
};

export type AuthConfig = AnonymousAuthConfig | JwtAuthConfig;

/** Read a single query param value from a raw request URL (path+query). */
function readQueryParam(reqUrl: string | undefined, param: string): string | null {
  if (!reqUrl) return null;
  // `req.url` is a path+query like "/webchannel/ws?ticket=...". Resolve against
  // a dummy origin so the URL parser accepts a relative target.
  let url: URL;
  try {
    url = new URL(reqUrl, "http://localhost");
  } catch {
    return null;
  }
  return url.searchParams.get(param);
}

function makeAnonymousVerifier(logger?: AuthLogger): ConnectionVerifier {
  // AC 4: Anonymous strategy is now REJECTED to prevent open-admission security hole.
  // All connections MUST be authenticated with SaaS-attested keys (cnf claim).
  // Operators must use the 'jwt' strategy with proper verification.
  const errorMsg =
    "webchannel: auth strategy 'anonymous' is disabled — " +
    "AC 4 requires SaaS-attested device keys (cnf claim). " +
    "Use the 'jwt' strategy with JWKS verification. " +
    "Refusing to start.";
  logger?.error?.(errorMsg);
  throw new Error(errorMsg);

  // NOTE: The function never returns a verifier — anonymous admission is a
  // security violation in Phase B. Callers must use authenticated strategies.
}

/**
 * Build a `ConnectionVerifier` for the `jwt` (RS256 / JWKS) strategy.
 *
 * Fail-closed (AC1): throws at construction if any of the three required
 * `auth.jwt.{issuer, audience, (jwksUrl|jwks|jwksFile)}` fields is missing.
 * Missing config means the plugin refuses to start, NOT that the gateway
 * silently accepts unauthed upgrades.
 *
 * The returned verifier resolves the configured JWKS lazily via the injected
 * `JWKSCache` and calls `verifyJwt` per upgrade. JWKS I/O errors propagate as
 * rejections (AC5), so a flaky IdP degrades connection establishment rather
 * than silently authenticating with a stale key.
 */
/**
 * S3: one long-lived {@link JWKSCache} per account auth config.
 *
 * The live NATS register/challenge routes call `verifyJwtAndExtractIdentity`
 * per pairing. Building a fresh empty cache each call defeated the 5-minute TTL,
 * so every pairing (and every reconnect storm) turned into 2+ JWKS fetches
 * against the IdP — the IdP became a per-request hot dependency.
 *
 * Keyed on the `JwtAuthConfig` object identity: each account's `auth` block is a
 * stable reference for the plugin's lifetime, so this yields exactly one cache
 * per account, shared by the challenge route and the register route. The WeakMap
 * lets the cache be collected when the account config is (no manual eviction).
 */
const jwksCacheByAuthConfig = new WeakMap<JwtAuthConfig, JWKSCache>();

function jwksCacheFor(config: JwtAuthConfig): JWKSCache {
  let cache = jwksCacheByAuthConfig.get(config);
  if (cache === undefined) {
    // `JWKSCache.create` enforces the "exactly one source" invariant; calling it
    // here (rather than on every upgrade) means a misconfig still fails on the
    // FIRST use — which for the WS path is plugin load — instead of silently
    // deferring the throw to each request.
    cache = JWKSCache.create(
      {
        jwksUrl: config.jwt.jwksUrl,
        jwksFile: config.jwt.jwksFile,
        jwks: config.jwt.jwks,
      },
      // `_fetchImpl` is a test-only escape hatch: when set, the JWKSCache uses
      // the injected function instead of `globalThis.fetch`. This lets unit
      // tests simulate a JWKS server response without opening a real socket.
      config.jwt._fetchImpl !== undefined
        ? { fetchImpl: config.jwt._fetchImpl }
        : undefined,
    );
    jwksCacheByAuthConfig.set(config, cache);
  }
  return cache;
}

/**
 * Preflight (Gate B — gateway start): resolve the account's JWKS ONCE and count
 * the keys, reusing the account's long-lived {@link JWKSCache} (keyed on this
 * exact `JwtAuthConfig` object — the same instance the register/challenge routes
 * verify against). This is the readiness gate's most useful diagnostic: an empty
 * or unreachable JWKS means NO bootstrap JWT can ever verify, and surfacing it at
 * startup (not lazily on the first browser register) is the whole point.
 *
 * Does NOT open a second fetcher — it drives {@link JWKSCache.warm}, so warming
 * here also primes the cache the live verify path reuses. A transient fetch
 * failure propagates as {@link JwksUnavailableError} (fail-closed; the caller
 * reports `JWKS FETCH FAILED` and keeps serving — the account is already
 * fail-closed because with no keys every register verify returns non-admit).
 */
export async function preflightResolveJwks(
  config: JwtAuthConfig,
): Promise<{ keyCount: number }> {
  const cache = jwksCacheFor(config);
  const doc = await cache.warm();
  return { keyCount: doc.keys.length };
}

function makeJwtVerifier(config: JwtAuthConfig): ConnectionVerifier {
  const jwtCfg = config.jwt;
  if (!jwtCfg || typeof jwtCfg !== "object") {
    throw new Error(
      "webchannel: channels.webchannel.auth.jwt is required when strategy=\"jwt\". Refusing to start.",
    );
  }
  if (typeof jwtCfg.issuer !== "string" || jwtCfg.issuer.length === 0) {
    throw new Error(
      "webchannel: channels.webchannel.auth.jwt.issuer is required (strategy=\"jwt\"). Refusing to start.",
    );
  }
  if (typeof jwtCfg.audience !== "string" || jwtCfg.audience.length === 0) {
    throw new Error(
      "webchannel: channels.webchannel.auth.jwt.audience is required (strategy=\"jwt\"). Refusing to start.",
    );
  }
  // Exactly one JWKS source must be supplied. `jwksCacheFor` calls
  // `JWKSCache.create` (which enforces this) once per account and memoizes the
  // result, so a misconfig fails at plugin load instead of every upgrade, and
  // the 5-minute TTL is honored across upgrades rather than reset each time.
  const jwksCache = jwksCacheFor(config);
  const ticketParam = config.ticketParam ?? "ticket";
  const issuer = jwtCfg.issuer;
  const audience = jwtCfg.audience;
  const clockSkew = jwtCfg.clockSkew;
  return async (req: IncomingMessage) => {
    const token = readQueryParam(req.url, ticketParam);
    if (!token) return null;
    const identity = await verifyJwt(token, {
      jwks: jwksCache,
      issuer,
      audience,
      clockSkewSec: clockSkew,
    });
    if (!identity) return null;

    return identity.displayName !== undefined
      ? { peerId: identity.peerId, displayName: identity.displayName }
      : { peerId: identity.peerId };
  };
}

/**
 * Build the `ConnectionVerifier` for the configured auth block.
 *
 * SAFE DEFAULT (AUTH.md §7): an unconfigured / unknown strategy THROWS rather
 * than silently falling back to anonymous. `auth:"plugin"` with zero
 * verification would expose every connection to the world — refusing to start is
 * the safe behavior, and the caller (index.ts) lets this propagate so plugin
 * load fails loudly.
 *
 * AC 4: 'anonymous' strategy is disabled — only the authenticated 'jwt'
 * strategy (with cnf claim) is allowed.
 */
export function resolveVerifier(
  authConfig: AuthConfig | undefined | null,
  logger?: AuthLogger,
): ConnectionVerifier {
  if (!authConfig || typeof authConfig !== "object" || !("strategy" in authConfig)) {
    throw new Error(
      "webchannel: channels.webchannel.auth.strategy is required (jwt). Refusing to start.",
    );
  }

  switch (authConfig.strategy) {
    case "anonymous":
      // AC 4: Anonymous is now disabled — throw to prevent open-admission hole
      return makeAnonymousVerifier(logger);
    case "jwt":
      return makeJwtVerifier(authConfig);
    default:
      throw new Error(
        `webchannel: unknown auth strategy "${(authConfig as { strategy: unknown }).strategy}" (expected jwt). Refusing to start.`,
      );
  }
}

/**
 * Verify a JWT and extract the peerId (for NATS peer registration).
 *
 * This is a helper function for AC 5's NATS mode where browsers register
 * their peerId via HTTP POST with a bootstrap JWT. The function verifies
 * the JWT signature and claims, then returns the peerId from the `sub` claim.
 *
 * @param jwt - The compact JWT string.
 * @param authConfig - The auth configuration (must be 'jwt' strategy).
 * @param logger - Optional logger.
 * @returns The peerId from the JWT `sub` claim, or `null` if verification fails.
 *
 * @throws If authConfig is not configured or strategy is not 'jwt'.
 */
export async function verifyJwtAndExtractPeerId(
  jwt: string,
  authConfig: AuthConfig | undefined | null,
  logger?: AuthLogger,
): Promise<string | null> {
  const identity = await verifyJwtAndExtractIdentity(jwt, authConfig, logger);
  return identity?.peerId ?? null;
}

/**
 * Like {@link verifyJwtAndExtractPeerId} but returns the full verified identity
 * (peerId + devicePublicKey + popPublicJwk). Used by the NATS register route to
 * obtain the Ed25519 PoP key for the signed-nonce challenge.
 */
export async function verifyJwtAndExtractIdentity(
  jwt: string,
  authConfig: AuthConfig | undefined | null,
  logger?: AuthLogger,
): Promise<JwtIdentity | null> {
  if (!authConfig || typeof authConfig !== "object") {
    throw new Error("webchannel: auth config is required for JWT verification");
  }

  if (authConfig.strategy !== "jwt") {
    throw new Error(`webchannel: cannot verify JWT with strategy "${authConfig.strategy}" (expected "jwt")`);
  }

  const jwtCfg: JwtAuthConfig = authConfig;

  if (!jwtCfg.jwt || typeof jwtCfg.jwt !== "object") {
    throw new Error("webchannel: auth.jwt block is required for JWT verification");
  }

  // S3: reuse the account's long-lived JWKS cache (keyed on this config object)
  // instead of rebuilding an empty one per register/challenge call, which
  // defeated the TTL and re-fetched the IdP on every pairing.
  const jwksCache = jwksCacheFor(jwtCfg);

  // Verify JWT. Two distinct throw classes must NOT be conflated:
  //  - JwksUnavailableError (JWKS source unreachable — network/non-2xx/file I/O):
  //    verification could not be PERFORMED. Re-thrown as TransientVerifyError so
  //    the register handler answers a retryable 503, not a terminal 401 — a
  //    momentary IdP hiccup must not permanently kill a session.
  //  - any OTHER throw (e.g. an unknown/evicted `kid` that IS a genuine key miss)
  //    or a `null` verdict (bad signature / claims): a fail-to-authenticate
  //    condition → treat as `null` so the caller returns a clean 401 (never a 500).
  // The config guards above still throw (a deploy error, correctly surfaced).
  let identity: Awaited<ReturnType<typeof verifyJwt>>;
  try {
    identity = await verifyJwt(jwt, {
      jwks: jwksCache,
      issuer: jwtCfg.jwt.issuer,
      audience: jwtCfg.jwt.audience,
      clockSkewSec: jwtCfg.jwt.clockSkew,
    });
  } catch (err) {
    if (err instanceof JwksUnavailableError) {
      logger?.error?.(`webchannel: JWT verification unavailable (transient): ${String(err)}`);
      throw new TransientVerifyError(
        "JWKS source unavailable — verification could not be performed",
        { cause: err },
      );
    }
    logger?.error?.(`webchannel: JWT verification error (fail-closed): ${String(err)}`);
    return null;
  }

  if (!identity) {
    logger?.error?.("webchannel: JWT verification failed");
    return null;
  }

  // The cnf device public key rides on the returned identity itself
  // (`identity.devicePublicKey`) — the register route wraps the conversation
  // key to it per-request (Phase 6); nothing is stored module-globally.
  logger?.info?.(`webchannel: JWT verified for peerId="${identity.peerId}"`);
  return identity;
}
