import {
  createAccountJwtVerifier,
  resolveRequirePoPPolicy,
  resolveVerifierConfig,
  type AccountJwtVerifier,
  type AuthConfig,
  type RawJwtAuthConfig,
  type ResolvedJwtVerifierConfig,
  type VerifierFactoryDeps,
  type VerifyAccountToken,
} from "./auth.js";
import type { AccountServePlan } from "./multiplex.js";
import { deriveIssuer, deriveJwksUrl } from "./preflight.js";

export type PersistedAuthMetadata = Readonly<{ issuer?: string }>;
export type MemoizedPersistedAccessor = () => PersistedAuthMetadata | undefined;

export function createMemoizedPersistedAccessor(
  load: () => PersistedAuthMetadata | undefined,
): MemoizedPersistedAccessor {
  let loaded = false;
  let value: PersistedAuthMetadata | undefined;
  return () => {
    if (!loaded) {
      loaded = true;
      value = load();
    }
    return value;
  };
}

function rawJwt(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const jwt = (raw as { jwt?: unknown }).jwt;
  return jwt && typeof jwt === "object" && !Array.isArray(jwt)
    ? (jwt as Record<string, unknown>)
    : {};
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isRawJwtAuth(raw: unknown): raw is AuthConfig {
  return Boolean(
    raw &&
    typeof raw === "object" &&
    !Array.isArray(raw) &&
    (raw as { strategy?: unknown }).strategy === "jwt",
  );
}

function canDeriveJwtFields(raw: unknown): raw is AuthConfig {
  if (!isRawJwtAuth(raw)) return false;
  const record = raw as Record<string, unknown>;
  return !hasOwn(record, "jwt") || Boolean(
    record.jwt && typeof record.jwt === "object" && !Array.isArray(record.jwt),
  );
}

/**
 * Derive only issuer/JWKS trust facts. The expected audience is never part of
 * this value; account binding is supplied separately to the verifier factory.
 */
export function deriveAccountAuth(
  raw: AuthConfig | undefined,
  saasBaseUrl: string | undefined,
  _accountId: string,
  deliveredIssuer?: string,
): RawJwtAuthConfig | undefined {
  if (!raw || raw.strategy !== "jwt") return raw;
  // An absent jwt object is the setup-produced derivation pointer. An explicitly
  // present malformed value is operator input and must survive unchanged so the
  // strict parser rejects it; never synthesize trust pins over null/string/array.
  if (!canDeriveJwtFields(raw)) return raw;
  const jwt = rawJwt(raw);
  // Presence wins even when the supplied value is malformed. The strict parser
  // must reject an explicit null/empty/undefined pin; derivation must never hide
  // it by replacing it with a delivered/default value.
  const issuer = hasOwn(jwt, "issuer")
    ? jwt.issuer
    : deliveredIssuer ?? (saasBaseUrl ? deriveIssuer(saasBaseUrl) : undefined);
  const hasSource = ["jwksUrl", "jwksFile", "jwks"].some((key) => hasOwn(jwt, key));
  return {
    ...raw,
    jwt: {
      ...jwt,
      ...(issuer !== undefined ? { issuer } : {}),
      ...(!hasSource && saasBaseUrl ? { jwksUrl: deriveJwksUrl(saasBaseUrl) } : {}),
    },
  };
}

export type ResolveEffectiveAccountAuthInput = {
  accountAuthRaw: AuthConfig | undefined;
  accountId: string;
  planSaasBaseUrl?: string;
  topLevelSaasBaseUrl?: string;
  loadCreds?: (accountId: string) => PersistedAuthMetadata | undefined;
};

/** Legacy derivation seam; preparation below is the production boundary. */
export function resolveEffectiveAccountAuth(
  input: ResolveEffectiveAccountAuthInput,
): RawJwtAuthConfig | undefined {
  // Persisted enrollment metadata is relevant only to an otherwise-valid JWT
  // trust plan. Invalid/missing strategies must fail from their raw config
  // without touching disk, and an explicit issuer never needs the delivered
  // issuer fallback.
  if (!canDeriveJwtFields(input.accountAuthRaw)) {
    return deriveAccountAuth(
      input.accountAuthRaw,
      input.planSaasBaseUrl ?? input.topLevelSaasBaseUrl,
      input.accountId,
    );
  }
  const jwt = rawJwt(input.accountAuthRaw);
  const explicitIssuer = hasOwn(jwt, "issuer");
  const delivered = explicitIssuer
    ? undefined
    : input.loadCreds?.(input.accountId)?.issuer;
  return deriveAccountAuth(
    input.accountAuthRaw,
    input.planSaasBaseUrl ?? input.topLevelSaasBaseUrl,
    input.accountId,
    delivered,
  );
}

export type PreparedAccountAuth = {
  readonly auth: ResolvedJwtVerifierConfig;
  readonly verifyIdentity: VerifyAccountToken;
  readonly warmJwks: AccountJwtVerifier["warmJwks"];
  readonly requirePoP: boolean;
};

export function prepareAccountAuth(input: {
  plan: AccountServePlan;
  getPersisted: MemoizedPersistedAccessor;
  /** Fully resolved enrolled SaaS base, including effective override precedence. */
  effectiveSaasBaseUrl?: string;
  topLevelSaasBaseUrl?: string;
  logger?: Parameters<typeof createAccountJwtVerifier>[0]["logger"];
  verifierDeps?: VerifierFactoryDeps;
}): PreparedAccountAuth {
  const raw = input.plan.account.auth as AuthConfig | undefined;
  const jwt = rawJwt(raw);
  const shouldLoadDeliveredIssuer = canDeriveJwtFields(raw) && !hasOwn(jwt, "issuer");
  const effective = deriveAccountAuth(
    raw,
    input.effectiveSaasBaseUrl ??
      input.plan.saasBaseUrl ??
      input.topLevelSaasBaseUrl,
    input.plan.accountId,
    shouldLoadDeliveredIssuer ? input.getPersisted()?.issuer : undefined,
  );
  const auth = resolveVerifierConfig(effective);
  const requirePoP = resolveRequirePoPPolicy(effective);
  const verifier = createAccountJwtVerifier(
    {
      auth,
      accountId: input.plan.accountId,
      ...(input.logger !== undefined ? { logger: input.logger } : {}),
    },
    input.verifierDeps,
  );
  return Object.freeze({
    auth,
    verifyIdentity: verifier.verifyIdentity,
    warmJwks: verifier.warmJwks,
    requirePoP,
  });
}
