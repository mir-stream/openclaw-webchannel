/**
 * DEMO-ONLY browser-side hmac-ticket issuer (vanilla; no framework).
 *
 * ⚠️ Mints the `hmac-ticket` IN THE BROWSER from a shared secret, exposing it to
 * every visitor — NOT secure. It exists only so the hmac-ticket auth path can be
 * exercised without a real backend. In production the host's SaaS backend issues
 * tickets server-side and the app receives them via `getTicket` (AUTH.md §5).
 *
 * Output is the exact compact JWT (HS256) the server verifier accepts:
 * `base64url(header).base64url(payload).base64url(sig)`. Uses the Web Crypto API
 * (`crypto.subtle`) — byte-compatible with the server's `node:crypto` HMAC.
 *
 * (This mirrors the React example's `devTicket.ts`, kept framework-free.)
 */

const encoder = new TextEncoder();

function base64UrlFromBytes(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlFromString(value: string): string {
  return base64UrlFromBytes(encoder.encode(value));
}

/** Issue an HS256 ticket for `sub`, valid for `ttlSeconds` (default 60s). */
export async function issueDevTicket(
  secret: string,
  sub: string,
  ttlSeconds = 60,
): Promise<string> {
  const header = base64UrlFromString(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const iat = Math.floor(Date.now() / 1000);
  const payload = base64UrlFromString(
    JSON.stringify({ sub, iat, exp: iat + ttlSeconds }),
  );
  const signingInput = `${header}.${payload}`;

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(signingInput),
  );

  return `${signingInput}.${base64UrlFromBytes(new Uint8Array(signature))}`;
}

/** Build a `getTicket` callback that mints a fresh ticket on every (re)connect. */
export function makeDevGetTicket(
  secret: string,
  sub: string,
  ttlSeconds = 60,
): () => Promise<string> {
  return () => issueDevTicket(secret, sub, ttlSeconds);
}
