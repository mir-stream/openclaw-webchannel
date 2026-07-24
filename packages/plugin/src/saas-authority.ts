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
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
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

/** Derive enrollment endpoints using trailing-slash normalization only. */
export function deriveEnrollmentEndpoints(
  saasBaseUrl: string,
): EnrollmentEndpoints {
  if (!isAbsoluteHttpUrl(saasBaseUrl)) {
    throw new Error(
      "webchannel: invalid SaaS enrollment authority fields=saasBaseUrl",
    );
  }
  const normalizedBase = saasBaseUrl.replace(/\/+$/, "");
  return Object.freeze({
    saasEnrollUrl: `${normalizedBase}/api/enroll`,
    saasPollUrl: `${normalizedBase}/api/poll`,
  });
}
