export type EnrollmentEndpoints = Readonly<{
  saasEnrollUrl: string;
  saasPollUrl: string;
}>;

/** Validate without normalizing or replacing the configured authority string. */
export function isAbsoluteHttpUrl(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    !/^https?:\/\//i.test(value)
  ) {
    return false;
  }
  try {
    const parsed = new URL(value);
    return (
      (parsed.protocol === "https:" || (parsed.protocol === "http:" &&
        (parsed.hostname === "localhost" || parsed.hostname === "[::1]" ||
          /^127\.\d+\.\d+\.\d+$/.test(parsed.hostname)))) &&
      parsed.hostname.length > 0 &&
      parsed.username.length === 0 &&
      parsed.password.length === 0 &&
      parsed.search.length === 0 &&
      parsed.hash.length === 0
    );
  } catch {
    return false;
  }
}

/** The same transport policy applies before enrollment, derivation and probes. */
export function assertSaasBaseUrl(value: unknown): asserts value is string {
  if (!isAbsoluteHttpUrl(value)) {
    throw new Error(
      "webchannel: invalid SaaS enrollment authority fields=saasBaseUrl; use HTTPS (http is allowed only for localhost, 127.0.0.0/8 or ::1)",
    );
  }
}

/** Derive enrollment endpoints using trailing-slash normalization only. */
export function deriveEnrollmentEndpoints(
  saasBaseUrl: string,
): EnrollmentEndpoints {
  assertSaasBaseUrl(saasBaseUrl);
  const normalizedBase = saasBaseUrl.replace(/\/+$/, "");
  return Object.freeze({
    saasEnrollUrl: `${normalizedBase}/api/enroll`,
    saasPollUrl: `${normalizedBase}/api/poll`,
  });
}
