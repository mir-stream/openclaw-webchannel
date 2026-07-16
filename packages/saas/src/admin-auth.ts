import { timingSafeEqual } from "node:crypto";

export type AdminAuthResult = { ok: true } | { ok: false; status: 401 | 503; error: string };

export function authorizeEnrollmentAdmin(configuredToken: string | undefined, authorization: string | undefined): AdminAuthResult {
  if (!configuredToken) return { ok: false, status: 503, error: "enrollment admin token is not configured" };
  const expected = Buffer.from(`Bearer ${configuredToken}`);
  const received = Buffer.from(authorization ?? "");
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) return { ok: false, status: 401, error: "unauthorized" };
  return { ok: true };
}
