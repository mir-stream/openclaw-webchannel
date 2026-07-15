/**
 * Acquisition-identity env precedence (가-1 Cycle 1, deliverable 6).
 *
 * ── The footgun this removes ────────────────────────────────────────────────
 * `WEBCHANNEL_TENANT` / `WEBCHANNEL_SAAS_BASE_URL` used
 * to unconditionally override the config-derived acquisition identity. With
 * per-account config (가-1) that is a wrong-tenant footgun: a stale env var
 * would silently mis-route an explicitly-configured account.
 *
 * New rule (deterministic, config wins):
 *   - If ANY `channels.webchannel` account config exists (flat OR per-account),
 *     these three env vars are IGNORED for identity, and a ONE-TIME deprecation
 *     warning is emitted. Config is authoritative.
 *   - ONLY when there is NO webchannel account config at all are they used, to
 *     synthesize a legacy `"default"` account's identity.
 *
 * This does NOT touch the connection/static-creds env
 * (WEBCHANNEL_NATS_URL/_USER_JWT/_USER_SEED/_CREDS) — those keep their
 * runtime-connection override meaning (handled by the credential-source resolver).
 */

import {
  DEFAULT_ACCOUNT_ID,
  readWebchannelSection,
  resolveAcquisitionIdentity,
  type WebchannelAcquisitionIdentity,
} from "./account-config.js";

const ACQUISITION_IDENTITY_ENV_KEYS = [
  "WEBCHANNEL_TENANT",
  "WEBCHANNEL_SAAS_BASE_URL",
] as const;

/** Module-scoped guard so the deprecation warning fires at most once per process. */
let deprecationWarned = false;

/** @internal Test-only: reset the one-time warning guard. */
export function _resetAcquisitionEnvWarning(): void {
  deprecationWarned = false;
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
 *   - Config present  → config wins; the three identity env vars are ignored
 *     and a one-time deprecation warning is emitted (if any are set).
 *   - Config absent   → synthesize from env (legacy `"default"` path), falling
 *     back to the historical defaults.
 *
 * `env` and `warn` are injectable for tests.
 */
export function resolveAcquisitionEnvPrecedence(
  cfg: unknown,
  accountId: string = DEFAULT_ACCOUNT_ID,
  opts: {
    env?: Record<string, string | undefined>;
    warn?: (msg: string) => void;
  } = {},
): AcquisitionEnvResult {
  const env = opts.env ?? process.env;
  const warn = opts.warn ?? ((msg: string) => console.warn(msg));

  const section = readWebchannelSection(cfg);
  const hasConfig = section !== undefined && Object.keys(section).length > 0;

  const envSet = ACQUISITION_IDENTITY_ENV_KEYS.filter((k) => env[k] !== undefined);

  if (hasConfig) {
    if (envSet.length > 0 && !deprecationWarned) {
      deprecationWarned = true;
      warn(
        `[webchannel] ignoring deprecated acquisition env (${envSet.join(", ")}) — ` +
          `channels.webchannel config is authoritative. Configure identity via ` +
          `'openclaw channels add --channel webchannel' instead.`,
      );
    }
    return { identity: resolveAcquisitionIdentity(cfg, accountId), usedLegacyEnv: false };
  }

  // No config: synthesize the legacy "default" account identity from env.
  const identity: WebchannelAcquisitionIdentity = {
    accountId,
    tenant: env["WEBCHANNEL_TENANT"] ?? "default-tenant",
    ...(env["WEBCHANNEL_SAAS_BASE_URL"] !== undefined
      ? { saasBaseUrl: env["WEBCHANNEL_SAAS_BASE_URL"] }
      : {}),
  };
  return { identity, usedLegacyEnv: true };
}
