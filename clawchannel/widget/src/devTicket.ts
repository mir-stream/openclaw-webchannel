/**
 * PoC / DEV-ONLY browser-side hmac-ticket issuer.
 *
 * ⚠️ This mints the `hmac-ticket` IN THE BROWSER from a shared secret. That
 * exposes the secret to every visitor — it is NOT secure and exists only so the
 * hmac-ticket auth path can be exercised end-to-end without a real backend.
 * In production the host's SaaS backend issues tickets server-side (see AUTH.md
 * §5) and the widget receives them via `getTicket`; the secret never reaches the
 * browser.
 *
 * The output is the exact compact JWT (HS256) format the server verifier
 * accepts: `base64url(header).base64url(payload).base64url(sig)` with header
 * `{alg:"HS256",typ:"JWT"}` and payload `{sub, iat, exp}`. It uses the Web
 * Crypto API (`crypto.subtle`), the browser counterpart of the server's
 * `node:crypto` HMAC — verified byte-compatible by a cross-runtime test
 * (src/devticket-webcrypto.test.ts).
 */

const encoder = new TextEncoder();

/** base64url-encode raw bytes (no padding), matching the server's encoding. */
function base64UrlFromBytes(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** base64url-encode a UTF-8 string. */
function base64UrlFromString(value: string): string {
  return base64UrlFromBytes(encoder.encode(value));
}

/**
 * Issue an HS256 ticket for `sub`, valid for `ttlSeconds` (default 60s, matching
 * the short-lived ticket model). Async because Web Crypto signing is async.
 */
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

/**
 * Build a `getTicket` callback for `useClawChannel`. Returns a fresh ticket on
 * every call, so each (re)connect gets an unexpired one.
 */
export function makeDevGetTicket(
  secret: string,
  sub: string,
  ttlSeconds = 60,
): () => Promise<string> {
  return () => issueDevTicket(secret, sub, ttlSeconds);
}
