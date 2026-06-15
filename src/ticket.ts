import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Zero-dependency HS256 JWT sign/verify for ClawChannel connection tickets.
 *
 * Deliberately depends on `node:crypto` ONLY — no `ws`, no plugin SDK. The same
 * code must run in two independent Node processes: the host's SaaS backend (which
 * ISSUES tickets after its own login) and the gateway plugin (which VERIFIES
 * them at WS upgrade). Pulling heavy deps here would make the issuer side
 * awkward to vendor, so we hand-roll the (small, well-understood) HS256 subset
 * of JWT rather than take a `jsonwebtoken`-style dependency. See AUTH.md §6.
 */

/** base64url-encode (RFC 4648 §5, no padding) a Buffer or string. */
function base64url(input: Buffer | string): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return buf.toString("base64url");
}

/** base64url-decode to a Buffer. Node's "base64url" tolerates missing padding. */
function fromBase64url(segment: string): Buffer {
  return Buffer.from(segment, "base64url");
}

function hmacSha256(secret: string, signingInput: string): Buffer {
  return createHmac("sha256", secret).update(signingInput).digest();
}

/** Fixed JWT header for HS256. */
const HEADER_SEGMENT = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));

export type IssueTicketInput = {
  /** Stable subject = the per-user peer identity the host owns. */
  sub: string;
  /** Shared HMAC secret. Same secret the gateway verifies with. */
  secret: string;
  /** Time-to-live in seconds. Tickets are short-lived (see AUTH.md §5). */
  ttlSeconds: number;
  /** Optional human-readable name carried as the `name` claim. */
  displayName?: string;
};

/**
 * Issue a compact HS256 JWT ticket: `base64url(header).base64url(payload).base64url(sig)`.
 * Payload is `{ sub, iat, exp, name? }` with `exp = iat + ttlSeconds` (seconds).
 */
export function issueClawChannelTicket(input: IssueTicketInput): string {
  const { sub, secret, ttlSeconds, displayName } = input;
  const iat = Math.floor(Date.now() / 1000);
  const payload: Record<string, unknown> = {
    sub,
    iat,
    exp: iat + ttlSeconds,
  };
  if (displayName !== undefined) payload.name = displayName;

  const payloadSegment = base64url(JSON.stringify(payload));
  const signingInput = `${HEADER_SEGMENT}.${payloadSegment}`;
  const signature = base64url(hmacSha256(secret, signingInput));
  return `${signingInput}.${signature}`;
}

export type VerifyTicketOptions = {
  /**
   * Allowed clock-skew leeway in seconds when checking expiry. Default 0. A
   * small positive value tolerates minor clock drift between the issuing host
   * and the gateway.
   */
  clockSkewSeconds?: number;
};

export type TicketIdentity = { sub: string; name?: string };

/**
 * Verify a ticket and return its identity, or `null` on ANY failure: malformed
 * input, wrong segment count, bad signature, expired, or missing `sub`. Never
 * throws — a bad ticket is just an authentication failure.
 *
 * Uses a timing-safe signature comparison (length-guarded so `timingSafeEqual`
 * never throws on mismatched lengths).
 */
export function verifyTicket(
  token: unknown,
  secret: string,
  opts?: VerifyTicketOptions,
): TicketIdentity | null {
  if (typeof token !== "string" || token.length === 0) return null;

  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerSegment, payloadSegment, signatureSegment] = parts;
  if (!headerSegment || !payloadSegment || !signatureSegment) return null;

  // Pin the algorithm to HS256 explicitly (defense-in-depth). Even though the
  // signature check below already rejects `alg:"none"` and other forgeries via
  // HMAC mismatch, refuse any token whose header doesn't declare HS256 outright.
  let header: unknown;
  try {
    header = JSON.parse(fromBase64url(headerSegment).toString("utf8"));
  } catch {
    return null;
  }
  if (!header || typeof header !== "object") return null;
  if ((header as Record<string, unknown>).alg !== "HS256") return null;

  // Recompute the signature over the exact received header.payload bytes and
  // compare timing-safely. Guard the lengths first: timingSafeEqual throws on
  // unequal-length buffers, which would itself leak a length comparison.
  const expected = hmacSha256(secret, `${headerSegment}.${payloadSegment}`);
  let provided: Buffer;
  try {
    provided = fromBase64url(signatureSegment);
  } catch {
    return null;
  }
  if (provided.length !== expected.length) return null;
  if (!timingSafeEqual(provided, expected)) return null;

  // Signature is valid; now parse and validate the claims.
  let payload: unknown;
  try {
    payload = JSON.parse(fromBase64url(payloadSegment).toString("utf8"));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object") return null;
  const claims = payload as Record<string, unknown>;

  if (typeof claims.sub !== "string" || claims.sub.length === 0) return null;

  const exp = claims.exp;
  if (typeof exp !== "number" || !Number.isFinite(exp)) return null;
  const leeway = opts?.clockSkewSeconds ?? 0;
  const now = Math.floor(Date.now() / 1000);
  // Reject if now is at or past expiry (allowing the configured leeway).
  if (now >= exp + leeway) return null;

  const identity: TicketIdentity = { sub: claims.sub };
  if (typeof claims.name === "string") identity.name = claims.name;
  return identity;
}
