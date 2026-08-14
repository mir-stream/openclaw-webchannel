/**
 * Acquisition-identity env precedence (가-1 Cycle 1, deliverable 6).
 *
 * ── The footgun this removes ────────────────────────────────────────────────
 * `WEBCHANNEL_TENANT` / `WEBCHANNEL_SAAS_BASE_URL` used
 * to unconditionally override the config-derived acquisition identity. With
 * per-account config (가-1) that is a wrong-tenant footgun: a stale env var
 * would silently mis-route an explicitly-configured account.
 *
 * New identity rule (deterministic, config wins):
 *   - If ANY `channels.webchannel` account config exists (flat OR per-account),
 *     `WEBCHANNEL_TENANT` is IGNORED for identity. `WEBCHANNEL_SAAS_BASE_URL`
 *     remains an effective enrolled-credential override during its deprecation
 *     window. A ONE-TIME warning accurately describes either case.
 *   - ONLY when there is NO webchannel account config at all are they used, to
 *     synthesize a legacy `"default"` account's identity.
 *
 * This does NOT touch the connection/static-creds env
 * (WEBCHANNEL_NATS_URL/_USER_JWT/_USER_SEED/_CREDS) — those keep their
 * runtime-connection override meaning (handled by the credential-source resolver).
 */

import {
  DEFAULT_WEBCHANNEL_ACCOUNT_ID,
  DEFAULT_WEBCHANNEL_TENANT,
  hasWebchannelConfig,
  resolveAcquisitionIdentity,
  type WebchannelAcquisitionIdentity,
} from "./account-config.js";

export const IGNORED_ACQUISITION_IDENTITY_ENV_KEYS = ["WEBCHANNEL_TENANT"] as const;
export const EFFECTIVE_DEPRECATED_ACQUISITION_ENV_KEYS = [
  "WEBCHANNEL_SAAS_BASE_URL",
] as const;
export const ACQUISITION_IDENTITY_ENV_KEYS = [
  ...IGNORED_ACQUISITION_IDENTITY_ENV_KEYS,
  ...EFFECTIVE_DEPRECATED_ACQUISITION_ENV_KEYS,
] as const;

// Retain the existing module export while sharing the account-model predicate.
export { hasWebchannelConfig };

/** Module-scoped guard so the deprecation warning fires at most once per process. */
let deprecationWarned = false;

/** @internal Test-only: reset the one-time warning guard. */
export function _resetAcquisitionEnvWarning(): void {
  deprecationWarned = false;
}

/**
 * Resolve the tenant while building the immutable account serving plan.
 *
 * In the config-less compatibility path this samples `WEBCHANNEL_TENANT` once.
 * The resulting `identity.tenant` is then carried by the serving runtime; turn
 * dispatch and history reads must never consult the ambient environment again.
 * OpenClaw can temporarily override process env while running a skill, so a
 * later read could otherwise route a session under a tenant different from the
 * NATS channel and register-admission tenant captured at startup.
 */
function resolveAccountTenant(
  cfg: unknown,
  accountId: string = DEFAULT_WEBCHANNEL_ACCOUNT_ID,
  env: Record<string, string | undefined> = process.env,
): string {
  if (hasWebchannelConfig(cfg)) return resolveAcquisitionIdentity(cfg, accountId).tenant;
  // No webchannel config at all: the legacy synthesized-default account, whose
  // tenant comes from the environment snapshot supplied to startup planning
  // (see the module docstring's precedence rule).
  return env["WEBCHANNEL_TENANT"] ?? DEFAULT_WEBCHANNEL_TENANT;
}

export type AcquisitionEnvResult = {
  /** The effective acquisition identity for the account. */
  identity: WebchannelAcquisitionIdentity;
  /** True when env was honored (legacy synthesized-default path). */
  usedLegacyEnv: boolean;
};

/**
 * Resolve the acquisition identity for an account, applying the env-precedence
 * rule.
 *
 *   - Config present  → config wins for tenant; the SaaS env override remains
 *     effective temporarily. A one-time deprecation warning is emitted.
 *   - Config absent   → synthesize from env (legacy `"default"` path), falling
 *     back to the historical defaults.
 *
 * `env` and `warn` are injectable for tests.
 */
export function resolveAcquisitionEnvPrecedence(
  cfg: unknown,
  accountId: string = DEFAULT_WEBCHANNEL_ACCOUNT_ID,
  opts: {
    env?: Record<string, string | undefined>;
    warn?: (msg: string) => void;
  } = {},
): AcquisitionEnvResult {
  const env = opts.env ?? process.env;
  const warn = opts.warn ?? ((msg: string) => console.warn(msg));

  const hasConfig = hasWebchannelConfig(cfg);

  const ignoredEnv = IGNORED_ACQUISITION_IDENTITY_ENV_KEYS.filter(
    (key) => env[key] !== undefined,
  );
  const effectiveDeprecatedEnv = EFFECTIVE_DEPRECATED_ACQUISITION_ENV_KEYS.filter(
    (key) => env[key] !== undefined,
  );

  if (hasConfig) {
    if ((ignoredEnv.length > 0 || effectiveDeprecatedEnv.length > 0) && !deprecationWarned) {
      deprecationWarned = true;
      if (ignoredEnv.length > 0) warn(
        `[webchannel] ignoring deprecated acquisition env (${ignoredEnv.join(", ")}) — ` +
          `channels.webchannel config is authoritative. Configure identity via ` +
          `'openclaw channels add --channel webchannel' instead.`,
      );
      if (effectiveDeprecatedEnv.length > 0) warn(
        `[webchannel] deprecated acquisition env (${effectiveDeprecatedEnv.join(", ")}) is still effective ` +
          `and overrides configured SaaS settings. Move it to channels.webchannel configuration; ` +
          `environment-variable support will be removed after 2026-08-15.`,
      );
    }
    return { identity: resolveAcquisitionIdentity(cfg, accountId), usedLegacyEnv: false };
  }

  // No config: synthesize the legacy "default" account identity from env.
  const identity: WebchannelAcquisitionIdentity = {
    accountId,
    tenant: resolveAccountTenant(cfg, accountId, env),
    ...(env["WEBCHANNEL_SAAS_BASE_URL"] !== undefined
      ? { saasBaseUrl: env["WEBCHANNEL_SAAS_BASE_URL"] }
      : {}),
  };
  return { identity, usedLegacyEnv: true };
}
