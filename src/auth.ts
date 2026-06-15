import type { IncomingMessage } from "node:http";

import { verifyTicket } from "./ticket.js";

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

export type AuthConfig = AnonymousAuthConfig | HmacTicketAuthConfig;

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
        "clawchannel: channels.clawchannel.auth.ticketSecret is an empty string. Refusing to start.",
      );
    }
    return ref;
  }
  if (ref && typeof ref === "object" && typeof ref.env === "string") {
    const value = process.env[ref.env];
    if (!value) {
      throw new Error(
        `clawchannel: channels.clawchannel.auth.ticketSecret env "${ref.env}" is unset or empty. Refusing to start.`,
      );
    }
    return value;
  }
  throw new Error(
    "clawchannel: channels.clawchannel.auth.ticketSecret must be a string or { env: \"VAR_NAME\" }. Refusing to start.",
  );
}

/** Read a single query param value from a raw request URL (path+query). */
function readQueryParam(reqUrl: string | undefined, param: string): string | null {
  if (!reqUrl) return null;
  // `req.url` is a path+query like "/clawchannel/ws?ticket=...". Resolve against
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
    "clawchannel: auth strategy 'anonymous' selected — ALL connections are unauthenticated (single shared peer). Do NOT use in production.",
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
      "clawchannel: channels.clawchannel.auth.strategy is required (anonymous | hmac-ticket). Refusing to start.",
    );
  }

  switch (authConfig.strategy) {
    case "anonymous":
      return makeAnonymousVerifier(logger);
    case "hmac-ticket":
      return makeHmacTicketVerifier(authConfig);
    default:
      throw new Error(
        `clawchannel: unknown auth strategy "${(authConfig as { strategy: unknown }).strategy}" (expected anonymous | hmac-ticket). Refusing to start.`,
      );
  }
}
