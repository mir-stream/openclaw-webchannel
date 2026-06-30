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
  listWebchannelAccountIds,
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
