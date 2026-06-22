import type { IncomingMessage } from "node:http";

import { verifyTicket } from "./ticket.js";
import { verifyJwt } from "./jwt.js";
import { JWKSCache } from "./jwks.js";

/**
 * The auth seam. AUTH.md §3: every built-in or custom strategy converges to ONE
 * contract — a `ConnectionVerifier` run in `transport.handleUpgrade`. Its result
 * (`peerId`) becomes the session key, so closing the auth hole also gives us
 * per-user session separation. This file is SDK-free and `ws`-free; it needs
 * only `node:http` types + `./ticket.js`.
 */

/**
 * The single anonymous peer id. Defined HERE (the auth module) as the source of
 * truth and re-exported by `transport.ts`, since "what identity an unauthed
 * connection gets" is an auth decision, not a transport one.
 */
export const ANON_PEER_ID = "web-anon";

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
 * (file/exec) are intentionally out of scope here.
 */
export type SecretRef = string | { env: string };

export type AnonymousAuthConfig = { strategy: "anonymous" };

export type HmacTicketAuthConfig = {
  strategy: "hmac-ticket";
  ticketSecret: SecretRef;
  /** Query param the ticket arrives in. Default `"ticket"`. */
  ticketParam?: string;
};

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
};

export type AuthConfig = AnonymousAuthConfig | HmacTicketAuthConfig | JwtAuthConfig;

/**
 * Resolve a `SecretRef` to a concrete secret string at startup. Throws on an
 * empty/missing value so misconfiguration fails loudly at plugin load rather
 * than silently producing a verifier that rejects every connection.
 */
function resolveSecret(ref: SecretRef): string {
  // TODO(secretref): support OpenClaw's richer SecretRef forms (file/exec) once
  // the seam needs them; env + inline cover the SaaS handoff case today.
  if (typeof ref === "string") {
    if (ref.length === 0) {
      throw new Error(
        "webchannel: channels.webchannel.auth.ticketSecret is an empty string. Refusing to start.",
      );
    }
    return ref;
  }
  if (ref && typeof ref === "object" && typeof ref.env === "string") {
    const value = process.env[ref.env];
    if (!value) {
      throw new Error(
        `webchannel: channels.webchannel.auth.ticketSecret env "${ref.env}" is unset or empty. Refusing to start.`,
      );
    }
    return value;
  }
  throw new Error(
    "webchannel: channels.webchannel.auth.ticketSecret must be a string or { env: \"VAR_NAME\" }. Refusing to start.",
  );
}

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
  // Loud opt-in warning (AUTH.md §7): anonymous must never be a quiet default.
  logger?.warn?.(
    "webchannel: auth strategy 'anonymous' selected — ALL connections are unauthenticated (single shared peer). Do NOT use in production.",
  );
  return async () => ({ peerId: ANON_PEER_ID });
}

function makeHmacTicketVerifier(
  config: HmacTicketAuthConfig,
): ConnectionVerifier {
  const secret = resolveSecret(config.ticketSecret);
  const ticketParam = config.ticketParam ?? "ticket";
  return async (req: IncomingMessage) => {
    const token = readQueryParam(req.url, ticketParam);
    if (!token) return null;
    const identity = verifyTicket(token, secret);
    if (!identity) return null;
    return identity.name !== undefined
      ? { peerId: identity.sub, displayName: identity.name }
      : { peerId: identity.sub };
  };
}

/**
 * Build a `ConnectionVerifier` for the `jwt` (RS256 / JWKS) strategy.
 *
 * Fail-closed (AC1): throws at construction if any of the three required
 * `auth.jwt.{issuer, audience, (jwksUrl|jwks|jwksFile)}` fields is missing.
 * This matches the existing `hmac-ticket` behavior — missing config means the
 * plugin refuses to start, NOT that the gateway silently accepts unauthed
 * upgrades.
 *
 * The returned verifier resolves the configured JWKS lazily via the injected
 * `JWKSCache` and calls `verifyJwt` per upgrade. JWKS I/O errors propagate as
 * rejections (AC5), so a flaky IdP degrades connection establishment rather
 * than silently authenticating with a stale key.
 */
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
  // Exactly one JWKS source must be supplied. `JWKSCache.create` enforces
  // this; we call it once here so a misconfig fails at plugin load instead of
  // every upgrade.
  const jwksCache = JWKSCache.create(
    {
      jwksUrl: jwtCfg.jwksUrl,
      jwksFile: jwtCfg.jwksFile,
      jwks: jwtCfg.jwks,
    },
    // 5-minute TTL is the documented default; tests / operators can override
    // by passing a `ttlMs` — but the operator-facing schema (see
    // openclaw.plugin.json) doesn't expose `ttlMs` yet; that's an intentional
    // narrowing for v1.
    //
    // `_fetchImpl` is a test-only escape hatch: when set, the JWKSCache uses
    // the injected function instead of `globalThis.fetch`. This lets unit tests
    // simulate a JWKS server response without opening a real network socket.
    jwtCfg._fetchImpl !== undefined
      ? { fetchImpl: jwtCfg._fetchImpl }
      : undefined,
  );
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
 */
export function resolveVerifier(
  authConfig: AuthConfig | undefined | null,
  logger?: AuthLogger,
): ConnectionVerifier {
  if (!authConfig || typeof authConfig !== "object" || !("strategy" in authConfig)) {
    throw new Error(
      "webchannel: channels.webchannel.auth.strategy is required (anonymous | hmac-ticket | jwt). Refusing to start.",
    );
  }

  switch (authConfig.strategy) {
    case "anonymous":
      return makeAnonymousVerifier(logger);
    case "hmac-ticket":
      return makeHmacTicketVerifier(authConfig);
    case "jwt":
      return makeJwtVerifier(authConfig);
    default:
      throw new Error(
        `webchannel: unknown auth strategy "${(authConfig as { strategy: unknown }).strategy}" (expected anonymous | hmac-ticket | jwt). Refusing to start.`,
      );
  }
}
