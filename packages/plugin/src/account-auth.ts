import type { AuthConfig } from "./auth.js";
import { loadPersistedEnrolledCreds, type PersistedEnrolledCreds } from "./account-config.js";
import { deriveIssuer, deriveJwksUrl } from "./preflight.js";

/**
 * Trust-anchor derivation (design §4 change 1): fill the ABSENT JWT-verify params
 * from `{saas.baseUrl, accountId}` — CONFIG-PRESENT-WINS. These are trust FACTS,
 * not settings, and cannot legitimately mismatch:
 *   - issuer  = SaaS-DELIVERED (EnrollmentResult.issuer, persisted with the
 *               enrolled creds) when present, else saas.baseUrl (back-compat
 *               derivation for pre-issuer enrollments / non-enrolled accounts)
 *   - audience = accountId    (bootstrap JWTs are minted with `aud == accountId`)
 *   - jwksUrl  = saas.baseUrl + /.well-known/jwks.json
 * An explicitly-configured value is an operator PIN (proxy / custom-domain /
 * logical-issuer) and ALWAYS wins — we only fill fields that are absent.
 * Issuer precedence: pin > delivered > derived. The delivered value is used
 * VERBATIM (verifyJwt compares slash-insensitively) — the SaaS declared the
 * exact `iss` it mints at enroll time; re-deriving it here from the base URL is
 * exactly the configuration-by-coincidence this field exists to kill.
 *
 * Returns a NEW object (never mutates the caller's config). Non-jwt (or absent)
 * auth is returned unchanged.
 *
 * Fail-closed: when `saasBaseUrl` is undefined AND the params are absent we fill
 * NOTHING — `assertJwtAuthConfig` then throws and the jwt account is skipped with a
 * loud log. Missing verify params NEVER downgrade an account to `auto`
 * (`admission` is a separate PINNED config default, not derived here). jwksUrl is
 * derived ONLY when no key source (jwksUrl/jwks/jwksFile) is configured, because
 * `assertJwtAuthConfig` requires EXACTLY ONE — we must not introduce a second.
 */
export function deriveAccountAuth(
  raw: AuthConfig | undefined,
  saasBaseUrl: string | undefined,
  accountId: string,
  deliveredIssuer?: string,
): AuthConfig | undefined {
  if (!raw || raw.strategy !== "jwt" || !saasBaseUrl) return raw;
  const jwt = (raw.jwt ?? {}) as {
    jwksUrl?: string;
    jwks?: unknown;
    jwksFile?: string;
    issuer?: string;
    audience?: string;
  };
  const hasKeySource =
    typeof jwt.jwksUrl === "string" || jwt.jwks !== undefined || typeof jwt.jwksFile === "string";
  return {
    ...raw,
    jwt: {
      ...jwt,
      issuer: jwt.issuer ?? deliveredIssuer ?? deriveIssuer(saasBaseUrl),
      audience: jwt.audience ?? accountId,
      ...(hasKeySource ? {} : { jwksUrl: deriveJwksUrl(saasBaseUrl) }),
    },
  } as AuthConfig;
}

export type ResolveEffectiveAccountAuthInput = {
  accountAuthRaw: AuthConfig | undefined;
  accountId: string;
  planSaasBaseUrl?: string;
  topLevelSaasBaseUrl?: string;
  loadCreds?: (accountId: string) => PersistedEnrolledCreds | undefined;
};

/** Mirror the serving loop's complete auth-input precedence in one place. */
export function resolveEffectiveAccountAuth(
  input: ResolveEffectiveAccountAuthInput,
): AuthConfig | undefined {
  const loadCreds = input.loadCreds ?? loadPersistedEnrolledCreds;
  return deriveAccountAuth(
    input.accountAuthRaw,
    input.planSaasBaseUrl ?? input.topLevelSaasBaseUrl,
    input.accountId,
    loadCreds(input.accountId)?.issuer,
  );
}
