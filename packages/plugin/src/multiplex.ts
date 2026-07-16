/**
 * Multi-account serving plan (가-1 Cycle 2 — Phase 3; 가-2 wire rename).
 *
 * `planAccounts` turns an OpenClaw config into the ordered list of webchannel
 * accounts a single `gateway run` should serve.
 *
 * 가-2: the WIRE identity is the `accountId` itself (the `--account` flag / the
 * `accounts.<id>` key), which is unique by construction (it is a map key). The
 * handling agent is fully decoupled — it is now purely an `agents bind` concern
 * (telegram-like) and no per-account `agentId` is read here. As a result the old
 * structural skip rules (missing-own-agentId, duplicate-agentId) no longer apply:
 * the accountId can neither be missing nor collide.
 *
 * The encryption-policy / credential / connection I/O (which CAN still skip an
 * account — creds-missing, connect failure, encryption misconfig) lives in the
 * registerFull caller; those are account-scoped graceful skips.
 */

import {
  DEFAULT_WEBCHANNEL_ACCOUNT_ID,
  listWebchannelAccountIds,
  readAccountsMap,
  readWebchannelSection,
  resolveWebchannelAccountConfig,
  type WebchannelAccountConfig,
} from "./account-config.js";
import { resolveAcquisitionEnvPrecedence } from "./acquisition-env.js";

/** A planned account that should be served (passed to the I/O build step). */
export type AccountServePlan = {
  /** Account (deployment) id — the wire identity (NATS subject key / JWT aud). */
  accountId: string;
  tenant: string;
  saasBaseUrl?: string;
  /** The merged per-account config (channel-level base + account override). */
  account: WebchannelAccountConfig;
};

export type AccountPlanEntry = { status: "serve" } & AccountServePlan;

export type PlanAccountsOptions = {
  env?: Record<string, string | undefined>;
  warn?: (msg: string) => void;
};

/**
 * Plan which webchannel accounts to serve from a config. Pure (no I/O).
 *
 * Order follows `listWebchannelAccountIds` (sorted) for deterministic serving.
 * Every listed account is served — the accountId is the unique wire identity, so
 * there are no structural (pre-I/O) skips to apply.
 */
export function planAccounts(
  cfg: unknown,
  opts: PlanAccountsOptions = {},
): AccountPlanEntry[] {
  const accountIds = listWebchannelAccountIds(cfg);

  warnOnOrphanedDefault(cfg, opts.warn);

  const entries: AccountPlanEntry[] = [];

  for (const accountId of accountIds) {
    // Identity with config-over-env precedence. For a named account this is
    // config-only; for the synthesized default with no config it is env-derived.
    const { identity } = resolveAcquisitionEnvPrecedence(cfg, accountId, {
      ...(opts.env !== undefined ? { env: opts.env } : {}),
      ...(opts.warn !== undefined ? { warn: opts.warn } : {}),
    });

    const account = resolveWebchannelAccountConfig(cfg, accountId);
    entries.push({
      status: "serve",
      accountId,
      tenant: identity.tenant,
      ...(identity.saasBaseUrl !== undefined ? { saasBaseUrl: identity.saasBaseUrl } : {}),
      account,
    });
  }

  return entries;
}

/**
 * Warn ONCE when the config carries channel-level `auth`/`nats` alongside named
 * accounts but has NO explicit `accounts.default`. After core's supported
 * `channels add --account X` migration an explicit `accounts.default` always
 * exists, so this shape is only reachable via the OLD plugin writer (which wrote
 * a default flat beside named accounts) or a hand-edit. Under the issue-#17 read
 * semantics that channel-level default silently stops being served — even though
 * its enrolled creds may still exist on disk — so surface it at boot.
 *
 * Intentionally narrow: tuning / tenant / saas-only shared bases are legitimate
 * shapes and stay quiet (that boot noise was the original complaint).
 */
function warnOnOrphanedDefault(cfg: unknown, warn?: (msg: string) => void): void {
  if (!warn) return;
  const section = readWebchannelSection(cfg);
  if (!section) return;
  const accounts = readAccountsMap(section);
  const hasNamedAccounts = Object.keys(accounts).length > 0;
  if (!hasNamedAccounts) return;
  if (DEFAULT_WEBCHANNEL_ACCOUNT_ID in accounts) return;
  const hasIdentityBase = "auth" in section || "nats" in section;
  if (!hasIdentityBase) return;
  warn(
    `webchannel: channel-level auth/nats present but no accounts.default — the ` +
      `"default" account is NOT served (channel-level fields are shared base only). ` +
      `If a default account was intended, move its fields under accounts.default.`,
  );
}
