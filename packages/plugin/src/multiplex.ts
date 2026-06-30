/**
 * Multi-account serving plan (가-1 Cycle 2 — Phase 3).
 *
 * `planAccounts` turns an OpenClaw config into the ordered list of webchannel
 * accounts a single `gateway run` should serve, applying the two structural
 * skip rules BEFORE any I/O (so they are pure + unit-testable):
 *
 *   1. NAMED-ACCOUNT-WITHOUT-OWN-AGENTID — a non-`"default"` account that does
 *      not declare its OWN `agentId` is a misconfig: the merged config would
 *      inherit the channel-level/default agentId, colliding the NATS subject
 *      namespace and the aud→account dispatch. Skip it with an actionable log.
 *      (`"default"` is exempt — it legitimately uses channel-level identity.)
 *
 *   2. DUPLICATE AGENTID — the NATS subject embeds the agentId and account↔agent
 *      is 1:1, so agentIds MUST be unique across accounts. On a collision the
 *      later account is skipped (the first keeps the agentId) with an actionable
 *      log naming both accounts.
 *
 * The actual encryption-policy / credential / connection I/O (which can also
 * skip an account — creds-missing, connect failure, encryption misconfig) lives
 * in the registerFull caller; those are account-scoped graceful skips too.
 */

import {
  DEFAULT_ACCOUNT_ID,
  listWebchannelAccountIds,
  readAccountsMap,
  readWebchannelSection,
  resolveWebchannelAccountConfig,
  type WebchannelAccountConfig,
} from "./account-config.js";
import { resolveAcquisitionEnvPrecedence } from "./acquisition-env.js";

/** A planned account that should be served (passed to the I/O build step). */
export type AccountServePlan = {
  accountId: string;
  tenant: string;
  agentId: string;
  saasBaseUrl?: string;
  /** The merged per-account config (channel-level base + account override). */
  account: WebchannelAccountConfig;
};

/** An account that is skipped before any I/O, with an actionable reason. */
export type AccountSkip = {
  accountId: string;
  reason: "missing-agent-id" | "duplicate-agent-id";
  /** Operator-facing, actionable message (logged at registerFull time). */
  message: string;
};

export type AccountPlanEntry =
  | ({ status: "serve" } & AccountServePlan)
  | ({ status: "skip" } & AccountSkip);

export type PlanAccountsOptions = {
  env?: Record<string, string | undefined>;
  warn?: (msg: string) => void;
};

/** Read a non-empty string field off a raw config object. */
function readOwnString(
  obj: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = obj?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Plan which webchannel accounts to serve from a config, applying the
 * missing-own-agentId and duplicate-agentId skip rules. Pure (no I/O).
 *
 * Order follows `listWebchannelAccountIds` (sorted), so duplicate-agentId
 * resolution is deterministic: the first account in sorted order wins the
 * agentId; later collisions are skipped.
 */
export function planAccounts(
  cfg: unknown,
  opts: PlanAccountsOptions = {},
): AccountPlanEntry[] {
  const accountIds = listWebchannelAccountIds(cfg);
  const section = readWebchannelSection(cfg);
  const accountsMap = readAccountsMap(section);

  const entries: AccountPlanEntry[] = [];
  const agentIdToAccount = new Map<string, string>();

  for (const accountId of accountIds) {
    const isDefault = accountId === DEFAULT_ACCOUNT_ID;

    // Identity with config-over-env precedence. For a named account this is
    // config-only; for the synthesized default with no config it is env-derived.
    const { identity } = resolveAcquisitionEnvPrecedence(cfg, accountId, {
      ...(opts.env !== undefined ? { env: opts.env } : {}),
      ...(opts.warn !== undefined ? { warn: opts.warn } : {}),
    });

    // Rule 1: a NAMED account MUST declare its own agentId (no inheritance).
    if (!isDefault) {
      const ownAgentId = readOwnString(accountsMap[accountId], "agentId");
      if (!ownAgentId) {
        entries.push({
          status: "skip",
          accountId,
          reason: "missing-agent-id",
          message:
            `[webchannel] account "${accountId}" has no agentId of its own — ` +
            `skipping (a named account must not inherit the channel-level/default ` +
            `agentId; subjects would collide). Set it: openclaw channels add ` +
            `--channel webchannel --account ${accountId} --agent-id <unique-id>`,
        });
        continue;
      }
    }

    const agentId = identity.agentId;

    // Rule 2: agentId must be unique across served accounts.
    const existing = agentIdToAccount.get(agentId);
    if (existing !== undefined) {
      entries.push({
        status: "skip",
        accountId,
        reason: "duplicate-agent-id",
        message:
          `[webchannel] account "${accountId}" has the same agentId "${agentId}" ` +
          `as account "${existing}" — skipping (agentId must be unique; the NATS ` +
          `subject embeds it). Give account "${accountId}" a distinct agentId.`,
      });
      continue;
    }
    agentIdToAccount.set(agentId, accountId);

    const account = resolveWebchannelAccountConfig(cfg, accountId);
    entries.push({
      status: "serve",
      accountId,
      tenant: identity.tenant,
      agentId,
      ...(identity.saasBaseUrl !== undefined ? { saasBaseUrl: identity.saasBaseUrl } : {}),
      account,
    });
  }

  return entries;
}
