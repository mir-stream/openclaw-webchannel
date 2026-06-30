/**
 * CORS allow-origin decision for the browser-driven register hop.
 *
 * Default (no allowlist configured) is permissive — reflect the request Origin
 * (falling back to `*`) — preserving the existing SaaS-embed behavior with zero
 * regression. When `auth.cors.allowedOrigins` is configured AND non-empty, the
 * allow-origin header is set ONLY for an in-list Origin; an out-of-list (or
 * missing) Origin yields `null`, meaning the caller MUST NOT set the header and
 * the browser will block the cross-origin response.
 */

/**
 * Compute the value for `Access-Control-Allow-Origin`, or `null` to omit it.
 *
 * @param requestOrigin - The request's `Origin` header (or undefined).
 * @param allowedOrigins - Configured allowlist; unset/empty ⇒ permissive.
 */
export function resolveAllowOrigin(
  requestOrigin: string | undefined,
  allowedOrigins: string[] | undefined,
): string | null {
  // No allowlist configured ⇒ permissive: reflect the Origin or fall back to `*`.
  if (!allowedOrigins || allowedOrigins.length === 0) {
    return typeof requestOrigin === "string" && requestOrigin ? requestOrigin : "*";
  }
  // Allowlist configured ⇒ only echo an in-list Origin; otherwise omit the header.
  if (typeof requestOrigin === "string" && allowedOrigins.includes(requestOrigin)) {
    return requestOrigin;
  }
  return null;
}
