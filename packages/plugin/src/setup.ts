/**
 * WebChannel ChannelSetupAdapter (가-1 Cycle 1).
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * Credential ACQUISITION is config-time, not runtime. `openclaw channels add`
 * drives this adapter:
 *
 *   1. `applyAccountConfig` (sync) shapes the account's config from the CLI flags
 *      (identity: saasBaseUrl / tenant, plus credential mode). The wire identity
 *      is the `--account` id itself (가-2); the handling agent is decoupled into a
 *      pure `agents bind` concern (`agents bind --bind webchannel:<account>
 *      --agent <agent>`). This is
 *      the config WRITE. Per core's canonical model, a NAMED account is written
 *      under `channels.webchannel.accounts.<accountId>`; the `"default"` account
 *      stays at the channel-level (the shared/implicit-default base) so a
 *      single-account deployment's on-disk shape is unchanged (regression-safe).
 *      Core runs `moveSingleAccountChannelSectionToDefaultAccount` BEFORE this
 *      hook for a non-default account, so we only ADD the named account and never
 *      duplicate core's promotion.
 *   2. `afterAccountConfigWritten` (async) runs the device-flow enroll for that
 *      account when its credential mode is `enrolled` (default) and per-account
 *      creds are absent — the headless path CI relies on. Progress streams via
 *      `runtime.log`.
 *
 * ── CLI flag mapping (intentional, logged at acquisition time) ───────────────
 * OpenClaw's `channels add` parses a FIXED generic flag set for the
 * `ChannelSetupInput` (token / secret / url / base-url / …); a NON-bundled
 * plugin cannot register custom commander flags through the host CLI (the bundled
 * metadata loader filters `origin: "bundled"`). So we read identity from BOTH:
 *   - dedicated input keys (`saasBaseUrl` / `tenant`) — present when the flags
 *     ARE registered (future/bundled, or a programmatic caller), AND
 *   - the generic flags as a fallback mapping:
 *         --base-url  → saasBaseUrl
 *         --url       → tenant
 * The wire identity is the `--account` id itself (가-2) — there is no `--token`
 * → agentId mapping anymore. The handling agent is a separate `agents bind`
 * concern. Because the generic-flag mapping is semantically surprising (and
 * `--help` still reads "Channel setup URL"), `afterAccountConfigWritten` ECHOES
 * the RESOLVED tenant/accountId/saasBaseUrl (non-secret) before enrolling so a
 * mis-mapping is visible. The unambiguous alternative is the acquisition env
 * (WEBCHANNEL_TENANT / WEBCHANNEL_SAAS_BASE_URL), honored only when no webchannel
 * config exists (see acquisition-env.ts). The mapping is documented in README.md.
 */

import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";

import { WEBCHANNEL_ID } from "./transport.js";
import {
  DEFAULT_ACCOUNT_ID,
  canonicalizeAccountId,
  readAccountsMap,
  readWebchannelSection,
  resolveReadCredentialPath,
  resolveWebchannelAccountConfig,
} from "./account-config.js";
import { acquireCredentials } from "./acquire-credentials.js";

/**
 * The slice of `ChannelSetupInput` this adapter reads. The host type is a closed
 * shape with generic keys; the dedicated identity keys are optional extras that
 * only arrive when a caller supplies them (programmatically or via future flags).
 */
type WebchannelSetupInput = {
  // Dedicated identity keys (preferred when present).
  saasBaseUrl?: string;
  tenant?: string;
  // Generic CLI flags (fallback mapping).
  baseUrl?: string;
  url?: string;
  // Connection / credential-mode passthrough.
  credentialsMode?: "enrolled" | "static" | "open";
} & Record<string, unknown>;

/** Minimal runtime log sink (the host passes `RuntimeEnv`). */
type SetupRuntime = { log: (...args: unknown[]) => void };

/** Keys whose nested object values are shallow-merged when writing a patch. */
const NESTED_PATCH_KEYS = ["nats", "saas"] as const;

/** Resolve the acquisition identity from a setup input (dedicated > generic). */
export function resolveSetupIdentity(input: WebchannelSetupInput): {
  saasBaseUrl?: string;
  tenant?: string;
} {
  return {
    saasBaseUrl: input.saasBaseUrl ?? input.baseUrl,
    tenant: input.tenant ?? input.url,
  };
}

/**
 * Build the account config patch from a setup input — identity + credential
 * mode. Only defined fields are written (so re-running `channels add` to set one
 * field does not clobber the others).
 */
export function buildAccountPatch(input: WebchannelSetupInput): Record<string, unknown> {
  const identity = resolveSetupIdentity(input);
  const patch: Record<string, unknown> = {};
  if (identity.tenant !== undefined) patch.tenant = identity.tenant;
  if (identity.saasBaseUrl !== undefined) {
    // saasBaseUrl lives under `saas.baseUrl` (the same place
    // resolveAcquisitionIdentity / resolveAccountNatsConfig read it from).
    patch.saas = { baseUrl: identity.saasBaseUrl };
  }
  if (input.credentialsMode !== undefined) {
    patch.nats = { credentials: { mode: input.credentialsMode } };
  }
  return patch;
}

/** Shallow-merge a patch onto an account object, one level deep for nats/saas. */
function mergePatch(
  prev: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...prev, ...patch };
  for (const key of NESTED_PATCH_KEYS) {
    const prevVal = prev[key];
    const patchVal = patch[key];
    if (
      prevVal &&
      typeof prevVal === "object" &&
      !Array.isArray(prevVal) &&
      patchVal &&
      typeof patchVal === "object" &&
      !Array.isArray(patchVal)
    ) {
      next[key] = { ...(prevVal as object), ...(patchVal as object) };
    }
  }
  return next;
}

/**
 * Write an account's config without mutating the caller's config object.
 *
 *   - `"default"` ⇒ merge the patch into the CHANNEL-LEVEL (flat) fields. This
 *     is the shared/implicit-default base; keeping default flat means a
 *     single-account deployment's shape never changes.
 *   - named account ⇒ merge the patch into `channels.webchannel.accounts.<id>`,
 *     preserving any existing `accounts` map (core has already promoted the prior
 *     flat single-account fields into `accounts.default` for us).
 */
function writeAccountConfig(
  cfg: OpenClawConfig,
  accountId: string,
  patch: Record<string, unknown>,
): OpenClawConfig {
  const channels = { ...((cfg as { channels?: Record<string, unknown> }).channels ?? {}) };
  const section = { ...(readWebchannelSection(cfg) ?? {}) };

  if (accountId === DEFAULT_ACCOUNT_ID) {
    // Merge at channel level (excluding the structural `accounts` map).
    const { accounts, ...flat } = section as { accounts?: unknown } & Record<string, unknown>;
    const mergedFlat = mergePatch(flat, patch);
    const nextSection: Record<string, unknown> = { ...mergedFlat };
    if (accounts !== undefined) nextSection.accounts = accounts;
    channels[WEBCHANNEL_ID] = nextSection;
  } else {
    const accounts = { ...readAccountsMap(section) };
    accounts[accountId] = mergePatch(accounts[accountId] ?? {}, patch);
    section.accounts = accounts;
    channels[WEBCHANNEL_ID] = section;
  }

  return { ...(cfg as object), channels } as OpenClawConfig;
}

/**
 * The webchannel `ChannelSetupAdapter`. Attached on the plugin descriptor so
 * `openclaw channels add --channel webchannel --account X …` writes the account
 * config and (headless) enrolls.
 */
export const webchannelSetup = {
  /**
   * Resolve + CANONICALIZE the account id. Returning a value here means core
   * skips its own `normalizeAccountId`, so we MUST canonicalize ourselves — an
   * un-sanitized id would otherwise flow into a credential filesystem path.
   * `canonicalizeAccountId` mirrors core's rules (lowercase, strip illegal
   * chars, clamp 64, default to `"default"`), so a traversal sequence like
   * `../../tmp/evil` collapses to a safe `tmp-evil`.
   */
  resolveAccountId: ({ accountId }: { accountId?: string }): string =>
    canonicalizeAccountId(accountId),

  /** Sync config WRITE: shape the account from flags. */
  applyAccountConfig: ({
    cfg,
    accountId,
    input,
  }: {
    cfg: OpenClawConfig;
    accountId: string;
    input: WebchannelSetupInput;
  }): OpenClawConfig => {
    // Defensive: even though core/our resolveAccountId canonicalizes, re-derive
    // here so a direct/programmatic caller can never inject a raw id.
    const id = canonicalizeAccountId(accountId);
    const patch = buildAccountPatch(input);
    // Always write (even an empty patch) so the account exists for `gateway run`
    // to list. For default with an empty patch on an empty config this is a no-op
    // shape-wise.
    return writeAccountConfig(cfg, id, patch);
  },

  /**
   * Async post-write hook: headless device-flow enroll for `enrolled` accounts
   * whose per-account creds are absent. This is the path `channels add` and CI
   * rely on (the user_code is printed to `runtime.log`; the operator/harness
   * approves at the SaaS `/approve` UI). Idempotent — present creds short-circuit.
   *
   * Non-fatal on failure: a failed enroll logs an actionable message and does
   * NOT throw, so `channels add` still writes the config and exits cleanly; the
   * operator can re-run acquisition.
   */
  afterAccountConfigWritten: async ({
    cfg,
    accountId,
    input,
    runtime,
  }: {
    previousCfg: OpenClawConfig;
    cfg: OpenClawConfig;
    accountId: string;
    input: WebchannelSetupInput;
    runtime: SetupRuntime;
  }): Promise<void> => {
    const id = canonicalizeAccountId(accountId);

    // Resolve the effective account config (channel-level base merged under the
    // account override), then the credential mode (config > input > enrolled).
    const account = resolveWebchannelAccountConfig(cfg, id);
    const mode =
      ((account.nats as { credentials?: { mode?: string } } | undefined)?.credentials
        ?.mode as string | undefined) ??
      input.credentialsMode ??
      "enrolled";

    if (mode !== "enrolled") {
      runtime.log(
        `[webchannel] account "${id}" credential mode is "${mode}"; ` +
          `skipping device-flow acquisition (no creds to acquire).`,
      );
      return;
    }

    // Skip if per-account (or legacy-default) creds already exist.
    const existingPath = resolveReadCredentialPath(id);
    const { existsSync } = await import("node:fs");
    if (existsSync(existingPath)) {
      runtime.log(
        `[webchannel] account "${id}" already has credentials at ${existingPath}; ` +
          `skipping acquisition.`,
      );
      return;
    }

    const identity = resolveSetupIdentity(input);
    const tenant =
      identity.tenant ?? (account.tenant as string | undefined) ?? "default-tenant";
    const saasBaseUrl =
      identity.saasBaseUrl ??
      (account.saas as { baseUrl?: string } | undefined)?.baseUrl ??
      (account.nats as { credentials?: { saasBaseUrl?: string } } | undefined)?.credentials
        ?.saasBaseUrl;

    if (!saasBaseUrl) {
      runtime.log(
        `[webchannel] account "${id}": no saas-base-url provided; cannot run ` +
          `device-flow acquisition. Re-run: openclaw channels add --channel ` +
          `webchannel --account ${id} --base-url <saas-url> --url <tenant>`,
      );
      return;
    }

    // Echo the RESOLVED identity (non-secret) so the generic-flag mapping is
    // never silent — a mis-mapped --url/--base-url is visible here. The wire
    // identity is the account id itself (가-2).
    runtime.log(
      `[webchannel] account "${id}" resolved acquisition identity: ` +
        `accountId=${id}, tenant=${tenant}, saasBaseUrl=${saasBaseUrl}`,
    );

    try {
      await acquireCredentials({
        accountId: id,
        saasBaseUrl,
        tenant,
        log: (...args) => runtime.log(...args),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      runtime.log(
        `[webchannel] account "${id}": credential acquisition failed (${msg}). ` +
          `Re-run: openclaw channels add --channel webchannel --account ${id}`,
      );
    }
  },
};
