import { verifyJwt, type JwtIdentity } from "./jwt.js";
import {
  JWKSCache,
  JwksUnavailableError,
  type JsonWebKeySet,
} from "./jwks.js";
import { logSafe } from "./log-safe.js";

export class TransientVerifyError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options as ErrorOptions);
    this.name = "TransientVerifyError";
  }
}

export const ANON_PEER_ID = "web-anon";

export type AuthLogger = {
  warn?: (msg: string) => void;
  info?: (msg: string) => void;
  error?: (msg: string) => void;
};

export type SecretRef = string | { env: string };

/** Raw operator input. Every member is narrowed by {@link resolveVerifierConfig}. */
export type RawJwtAuthConfig = {
  strategy?: unknown;
  jwt?: unknown;
  requirePoP?: unknown;
  [key: string]: unknown;
};

export type ResolvedJwksSource =
  | { readonly jwksUrl: string; readonly jwksFile?: never; readonly jwks?: never }
  | { readonly jwksFile: string; readonly jwksUrl?: never; readonly jwks?: never }
  | { readonly jwks: JsonWebKeySet; readonly jwksUrl?: never; readonly jwksFile?: never };

/** Cache-free-validated verifier configuration. Expected audience is intentionally absent. */
export type ResolvedJwtVerifierConfig = {
  readonly strategy: "jwt";
  readonly jwt: {
    readonly issuer: string;
    readonly clockSkew: number;
  } & ResolvedJwksSource;
};

/** Historical exported name retained for source compatibility; the shape is audience-free. */
export type JwtAuthConfig = ResolvedJwtVerifierConfig;
export type AuthConfig = RawJwtAuthConfig;

export type VerifyAccountToken = (token: string) => Promise<JwtIdentity | null>;

export type VerifierFactoryDeps = {
  fetchImpl?: typeof fetch;
  readFileImpl?: (path: string, signal?: AbortSignal) => Promise<Uint8Array>;
};

export type AccountJwtVerifier = {
  readonly verifyIdentity: VerifyAccountToken;
  readonly warmJwks: (signal?: AbortSignal) => Promise<{ keyCount: number }>;
};

const LIVE_JWKS_FETCH_TIMEOUT_MS = 4000;
const STARTUP_WARM_JWKS_TIMEOUT_MS = 10_000;

type CacheRecord = { cache: JWKSCache; deps: VerifierFactoryDeps };
const jwksCacheByResolvedConfig = new WeakMap<ResolvedJwtVerifierConfig, CacheRecord>();

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function resolveJwksSource(jwt: Record<string, unknown>): ResolvedJwksSource {
  const present = ["jwksUrl", "jwksFile", "jwks"].filter((key) =>
    Object.prototype.hasOwnProperty.call(jwt, key),
  );
  if (present.length !== 1) {
    throw new Error(
      `webchannel: jwt strategy requires exactly one of jwksUrl, jwksFile, or jwks (got ${present.length}). Refusing to start.`,
    );
  }
  if (present[0] === "jwksUrl") {
    if (!nonEmptyString(jwt.jwksUrl)) {
      throw new Error("webchannel: auth.jwt.jwksUrl must be a non-empty string. Refusing to start.");
    }
    return { jwksUrl: jwt.jwksUrl };
  }
  if (present[0] === "jwksFile") {
    if (!nonEmptyString(jwt.jwksFile)) {
      throw new Error("webchannel: auth.jwt.jwksFile must be a non-empty string. Refusing to start.");
    }
    return { jwksFile: jwt.jwksFile };
  }
  if (!isPlainObject(jwt.jwks) || !Array.isArray(jwt.jwks.keys)) {
    throw new Error("webchannel: auth.jwt.jwks must be an object with a keys array. Refusing to start.");
  }
  // Detach the resolved trust source from mutable raw config and freeze the
  // shape used by the long-lived cache/verifier closure.
  const keys = jwt.jwks.keys.map((key) =>
    isPlainObject(key) ? Object.freeze({ ...key }) : key,
  );
  return {
    jwks: Object.freeze({
      keys: Object.freeze(keys) as JsonWebKeySet["keys"],
    }),
  };
}

/** Strictly narrow raw operator input without allocating a JWKS cache or doing I/O. */
export function resolveVerifierConfig(raw: unknown): ResolvedJwtVerifierConfig {
  if (!isPlainObject(raw) || raw.strategy === undefined) {
    throw new Error(
      "webchannel: channels.webchannel.auth.strategy is required (jwt). Refusing to start.",
    );
  }
  if (raw.strategy !== "jwt") {
    throw new Error(
      `webchannel: auth strategy ${logSafe(raw.strategy)} is not valid for register-hop JWT verification. Refusing to start.`,
    );
  }
  if (!isPlainObject(raw.jwt)) {
    throw new Error(
      "webchannel: channels.webchannel.auth.jwt is required when strategy=\"jwt\". Refusing to start.",
    );
  }
  const jwt = raw.jwt;
  if (Object.prototype.hasOwnProperty.call(jwt, "audience")) {
    throw new Error(
      "webchannel: auth.jwt.audience was removed; delete it. JWT aud is always the runtime accountId.",
    );
  }
  if (!nonEmptyString(jwt.issuer)) {
    throw new Error(
      "webchannel: channels.webchannel.auth.jwt.issuer is required (strategy=\"jwt\"). Refusing to start.",
    );
  }
  const clockSkew = jwt.clockSkew === undefined ? 60 : jwt.clockSkew;
  if (
    typeof clockSkew !== "number" ||
    !Number.isFinite(clockSkew) ||
    !Number.isInteger(clockSkew) ||
    clockSkew < 0
  ) {
    throw new Error(
      "webchannel: auth.jwt.clockSkew must be a finite non-negative integer. Refusing to start.",
    );
  }
  const resolvedJwt = Object.freeze({
    issuer: jwt.issuer,
    clockSkew,
    ...resolveJwksSource(jwt),
  });
  return Object.freeze({
    strategy: "jwt",
    jwt: resolvedJwt,
  });
}

/** Strict PoP-policy narrowing performed once during account preparation. */
export function resolveRequirePoPPolicy(raw: unknown): boolean {
  if (!isPlainObject(raw) || raw.requirePoP === undefined) return true;
  if (typeof raw.requirePoP !== "boolean") {
    throw new Error("webchannel: auth.requirePoP must be a boolean. Refusing to start.");
  }
  return raw.requirePoP;
}

/** Normalize and validate a verifier value without allocating a cache. */
export function validateJwtVerifierConfig(raw: unknown): ResolvedJwtVerifierConfig {
  return resolveVerifierConfig(raw);
}

export function validateVerifierConfig(raw: unknown): ResolvedJwtVerifierConfig {
  return resolveVerifierConfig(raw);
}

function isImmutableResolvedConfig(config: ResolvedJwtVerifierConfig): boolean {
  return Object.isFrozen(config) &&
    Object.isFrozen(config.jwt) &&
    (config.jwt.jwks === undefined ||
      (Object.isFrozen(config.jwt.jwks) && Object.isFrozen(config.jwt.jwks.keys)));
}

function cacheFor(
  config: ResolvedJwtVerifierConfig,
  deps: VerifierFactoryDeps = {},
): JWKSCache {
  const existing = jwksCacheByResolvedConfig.get(config);
  if (existing) return existing.cache;
  const cache = JWKSCache.create(
    {
      ...(config.jwt.jwksUrl !== undefined ? { jwksUrl: config.jwt.jwksUrl } : {}),
      ...(config.jwt.jwksFile !== undefined ? { jwksFile: config.jwt.jwksFile } : {}),
      ...(config.jwt.jwks !== undefined ? { jwks: config.jwt.jwks } : {}),
    },
    {
      fetchTimeoutMs: LIVE_JWKS_FETCH_TIMEOUT_MS,
      ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
      ...(deps.readFileImpl !== undefined ? { readFileImpl: deps.readFileImpl } : {}),
    },
  );
  jwksCacheByResolvedConfig.set(config, { cache, deps });
  return cache;
}

/** Build a token-only verifier whose audience is immutably the runtime account id. */
export function createAccountJwtVerifier(input: {
  auth: ResolvedJwtVerifierConfig;
  accountId: string;
  logger?: AuthLogger;
}, deps: VerifierFactoryDeps = {}): AccountJwtVerifier {
  // Validate again at the factory boundary, but retain the prepared object's
  // identity so every consumer of one prepared account shares one JWKS cache.
  const normalized = resolveVerifierConfig(input.auth);
  const auth = isImmutableResolvedConfig(input.auth) ? input.auth : normalized;
  if (!nonEmptyString(input.accountId)) {
    throw new Error("webchannel: runtime accountId is required for JWT verification");
  }
  const accountId = input.accountId;
  const issuer = auth.jwt.issuer;
  const clockSkew = auth.jwt.clockSkew;
  const cache = cacheFor(auth, deps);
  return {
    verifyIdentity: async (token) => {
      let identity: JwtIdentity | null;
      try {
        identity = await verifyJwt(token, {
          jwks: cache,
          issuer,
          audience: accountId,
          clockSkewSec: clockSkew,
        });
      } catch (err) {
        if (err instanceof JwksUnavailableError) {
          input.logger?.error?.(
            `webchannel: JWT verification unavailable (transient): ${logSafe(err)}`,
          );
          throw new TransientVerifyError(
            "JWKS source unavailable — verification could not be performed",
            { cause: err },
          );
        }
        input.logger?.error?.(`webchannel: JWT verification error (fail-closed): ${logSafe(err)}`);
        return null;
      }
      if (!identity) {
        input.logger?.error?.("webchannel: JWT verification failed");
        return null;
      }
      input.logger?.info?.(`webchannel: JWT verified for peerId=${logSafe(identity.peerId)}`);
      return identity;
    },
    warmJwks: async (signal) => ({
      keyCount: (await cache.warm(STARTUP_WARM_JWKS_TIMEOUT_MS, signal)).keys.length,
    }),
  };
}

/** Compatibility helper with an explicit expected account target. */
export async function verifyJwtAndExtractIdentity(
  token: string,
  auth: ResolvedJwtVerifierConfig,
  expectedAccountId: string,
  logger?: AuthLogger,
): Promise<JwtIdentity | null> {
  return createAccountJwtVerifier({ auth, accountId: expectedAccountId, logger }).verifyIdentity(token);
}

export async function verifyJwtAndExtractPeerId(
  token: string,
  auth: ResolvedJwtVerifierConfig,
  expectedAccountId: string,
  logger?: AuthLogger,
): Promise<string | null> {
  return (await verifyJwtAndExtractIdentity(token, auth, expectedAccountId, logger))?.peerId ?? null;
}

export async function preflightResolveJwks(
  config: ResolvedJwtVerifierConfig,
  signal?: AbortSignal,
  deps: VerifierFactoryDeps = {},
): Promise<{ keyCount: number }> {
  const normalized = resolveVerifierConfig(config);
  const auth = isImmutableResolvedConfig(config) ? config : normalized;
  return {
    keyCount: (await cacheFor(auth, deps).warm(STARTUP_WARM_JWKS_TIMEOUT_MS, signal)).keys.length,
  };
}

/** Historical name retained; returns the actual normalized immutable value. */
export function assertJwtAuthConfig(raw: unknown): ResolvedJwtVerifierConfig {
  return resolveVerifierConfig(raw);
}
