/**
 * Multi-account serving plan (가-1 Cycle 2 — Phase 3; 가-2 wire rename).
 *
 * `planAccounts` turns an OpenClaw config into the ordered list of webchannel
 * accounts a single `gateway run` should serve.
 *
 * 가-2: the WIRE identity is the `accountId` itself (the `--account` flag / the
 * `accounts.<id>` key). `inspectWebchannelAccountIds` is the boundary that makes
 * this identity unique: it rejects every group of raw keys that the SDK account
 * contract normalizes to one id before this planner can receive them. The
 * handling agent is fully decoupled — it is now purely an `agents bind` concern
 * (telegram-like) and no per-account `agentId` is read here. As a result the old
 * structural skip rules (missing-own-agentId, duplicate-agentId) no longer apply.
 *
 * The encryption-policy / credential / connection I/O (which CAN still skip an
 * account — creds-missing, connect failure, encryption misconfig) lives in the
 * registerFull caller; those are account-scoped graceful skips.
 */

import {
  DEFAULT_WEBCHANNEL_ACCOUNT_ID,
  assertNoRemovedAudienceConfig,
  isWebchannelAccountEnabled,
  listWebchannelAccountIds,
  readAccountsMap,
  readWebchannelSection,
  resolveAccountStorageRoot,
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
  storageRoot?: string;
  /** The merged per-account config (channel-level base + account override). */
  account: WebchannelAccountConfig;
};

export type AccountPlanEntry = { status: "serve" } & AccountServePlan;

export type PlanAccountsOptions = {
  env?: Record<string, string | undefined>;
  warn?: (msg: string) => void;
};

/** Plan one raw account id without applying cross-account warnings. */
export function planWebchannelAccount(
  cfg: unknown,
  accountId: string,
  opts: PlanAccountsOptions = {},
): AccountPlanEntry | undefined {
  // Share the exact status predicate and skip before acquisition identity,
  // credential resolution, or any future per-account runtime I/O.
  if (!isWebchannelAccountEnabled(cfg, accountId)) return undefined;

  // Removed-key policy is evaluated on raw locations before acquisition or the
  // shallow effective merge, so a channel-base tombstone cannot be shadowed by
  // an account-local auth.jwt object.
  assertNoRemovedAudienceConfig(cfg, accountId);

  // Identity with config-over-env precedence. For a named account this is
  // config-only; for the synthesized default with no config it is env-derived.
  const { identity } = resolveAcquisitionEnvPrecedence(cfg, accountId, {
    ...(opts.env !== undefined ? { env: opts.env } : {}),
    ...(opts.warn !== undefined ? { warn: opts.warn } : {}),
  });

  const account = resolveWebchannelAccountConfig(cfg, accountId);
  const storageRoot = resolveAccountStorageRoot(account);
  return {
    status: "serve",
    accountId,
    tenant: identity.tenant,
    ...(identity.saasBaseUrl !== undefined ? { saasBaseUrl: identity.saasBaseUrl } : {}),
    ...(storageRoot !== undefined ? { storageRoot } : {}),
    account,
  };
}

/**
 * Plan which webchannel accounts to serve from a config. Pure (no I/O).
 *
 * Order follows `listWebchannelAccountIds` (sorted) for deterministic serving.
 * Every enabled listed account is served; disabled accounts are omitted before
 * acquisition identity or later runtime I/O. Account ids reaching this point
 * have already passed the module-level uniqueness boundary above.
 */
export function planAccounts(
  cfg: unknown,
  opts: PlanAccountsOptions = {},
): AccountPlanEntry[] {
  const accountIds = listWebchannelAccountIds(cfg);

  warnOnOrphanedDefault(cfg, opts.warn);

  const entries: AccountPlanEntry[] = [];

  for (const accountId of accountIds) {
    const plan = planWebchannelAccount(cfg, accountId, opts);
    if (plan) entries.push(plan);
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
export function detectOrphanedDefault(cfg: unknown): boolean {
  const section = readWebchannelSection(cfg);
  if (!section) return false;
  const accounts = readAccountsMap(section);
  const hasNamedAccounts = Object.keys(accounts).length > 0;
  if (!hasNamedAccounts) return false;
  if (DEFAULT_WEBCHANNEL_ACCOUNT_ID in accounts) return false;
  const hasIdentityBase = "auth" in section || "nats" in section;
  return hasIdentityBase;
}

export function warnOnOrphanedDefault(cfg: unknown, warn?: (msg: string) => void): void {
  if (!warn || !detectOrphanedDefault(cfg)) return;
  warn(
    `webchannel: channel-level auth/nats present but no accounts.default — the ` +
      `"default" account is NOT served (channel-level fields are shared base only). ` +
      `If a default account was intended, move its fields under accounts.default.`,
  );
}
