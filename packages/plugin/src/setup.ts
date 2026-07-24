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
 *      under `channels.webchannel.accounts.<accountId>`. Channel level is the
 *      SHARED BASE only: the `"default"` account is written flat ONLY while no
 *      named accounts exist (a single-account deployment's on-disk shape is then
 *      unchanged, regression-safe); once named accounts exist a `"default"` write
 *      is scoped under `accounts.default` too, mirroring core, so it is actually
 *      served and its identity fields never contaminate the named accounts as
 *      shared base (issue #17). Core runs
 *      `moveSingleAccountChannelSectionToDefaultAccount` BEFORE this hook for a
 *      non-default account, so we only ADD the named account and never duplicate
 *      core's promotion.
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
 * mis-mapping is visible, AND the re-run remediation string spells out that
 * `--url` carries the tenant id. (The legacy acquisition env WEBCHANNEL_TENANT /
 * WEBCHANNEL_SAAS_BASE_URL is NOT an onboarding alternative here: it is honored
 * only at gateway-run time when NO webchannel config exists and is deprecated
 * once config is present — see acquisition-env.ts.) The mapping is documented in
 * README.md ("Enrollment & credentials → CLI flag mapping").
 */

import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";

import { WEBCHANNEL_ID } from "./channel-contract.js";
import {
  DEFAULT_WEBCHANNEL_ACCOUNT_ID,
  accountCredentialPath,
  assertNoRemovedAudienceConfig,
  canonicalizeAccountId,
  loadPersistedCredentialDocument,
  readAccountsMap,
  readWebchannelSection,
  resolveWebchannelAccountConfig,
} from "./account-config.js";
import { acquireCredentials } from "./acquire-credentials.js";
import {
  formatCredentialInspection,
} from "./credential-document.js";
import { runAddPreflight } from "./preflight.js";

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
  // JWT issuer pin (advanced). Audience is structurally the account id and is
  // intentionally not an input.
  issuer?: string;
  // Connection / credential-mode passthrough.
  credentialsMode?: "enrolled" | "static";
} & Record<string, unknown>;

/** Minimal runtime log sink (the host passes `RuntimeEnv`). */
type SetupRuntime = { log: (...args: unknown[]) => void };

/** Keys whose nested object values are shallow-merged when writing a patch. */
const NESTED_PATCH_KEYS = ["nats", "saas", "auth"] as const;

/**
 * Sub-keys merged ONE MORE level deep under a nested patch key, so writing e.g.
 * `nats.credentials.mode` does not drop a sibling `nats.credentials.saasBaseUrl`,
 * and writing `auth.jwt.issuer` does not drop other supported JWT fields.
 */
const DEEP_PATCH_SUBKEYS: Record<string, readonly string[]> = {
  nats: ["credentials"],
  auth: ["jwt"],
};

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

/** True for a plain (non-array) object we can shallow-merge into. */
function isMergeableObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Shallow-merge a patch onto an account object, one level deep for nats/saas/auth
 * and one further level for the known compound children (`nats.credentials`,
 * `auth.jwt`) so a full-block write MERGES onto existing config rather than
 * clobbering sibling fields (for example, a re-run preserves an explicit
 * `auth.jwt.issuer` pin).
 */
function mergePatch(
  prev: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...prev, ...patch };
  for (const key of NESTED_PATCH_KEYS) {
    const prevVal = prev[key];
    const patchVal = patch[key];
    if (isMergeableObject(prevVal) && isMergeableObject(patchVal)) {
      const merged: Record<string, unknown> = { ...prevVal, ...patchVal };
      for (const sub of DEEP_PATCH_SUBKEYS[key] ?? []) {
        const prevSub = prevVal[sub];
        const patchSub = patchVal[sub];
        if (isMergeableObject(prevSub) && isMergeableObject(patchSub)) {
          merged[sub] = { ...prevSub, ...patchSub };
        }
      }
      next[key] = merged;
    }
  }
  return next;
}

/**
 * Build the COMPLETE, enroll-ready account block — the proven demo config
 * (`e2e/local/run-demo-synadia.sh`): tenant + saas.baseUrl + jwt auth strategy +
 * `dmSecurity: "open"` + enrolled NATS credentials under `admission:
 * "register-hop"`.
 *
 * TRUST-ANCHOR (design §4 change 2): the builder NO LONGER writes the JWT-verify
 * params (`issuer` / `jwksUrl`). Those are trust facts derived at runtime from
 * the SaaS anchor. Audience is not a verifier-config field at all: the prepared
 * verifier is immutably bound to the canonical runtime account id.
 *
 * `issuer` is an OPTIONAL OPERATOR PIN, not a default. It is written only when
 * explicitly supplied. When it is absent
 * the `auth.jwt` sub-object is OMITTED ENTIRELY so nothing is guessed — only
 * `auth.strategy: "jwt"` is written (runtime derivation supplies the rest).
 *
 * `admission` is pinned to `register-hop` because this builder always emits a
 * SaaS-enrolled JWT account and authenticated registration is the only serving
 * path.
 *
 * `nats.url` is intentionally OMITTED — the SaaS delivers the relay URL together
 * with the enrolled credentials at device-flow time (it is the rendezvous
 * authority), so pinning it in config would be redundant and drift-prone.
 *
 * Pure: no config read/write, no I/O. The two write seams (the non-interactive
 * `applyAccountConfig` and the interactive wizard `finalize`) both funnel their
 * full-block writes through this one builder.
 */
export function buildFullAccountPatch(params: {
  tenant: string;
  saasBaseUrl: string;
  accountId: string;
  /**
   * OPERATOR PIN (optional). When present, written as `auth.jwt.issuer` to force
   * a specific issuer; when absent, issuer DERIVES at runtime from saas.baseUrl.
   */
  issuer?: string;
}): Record<string, unknown> {
  // `accountId` remains a required param (callers pass it, and it documents that
  // expected JWT aud derives from it at runtime) but is no longer read here —
  // the account-bound verifier closes over `accountId` directly.
  const { tenant, saasBaseUrl, issuer } = params;
  // Emit auth.jwt ONLY for the explicit issuer pin. jwksUrl
  // is never written here — it derives at runtime. If neither pin is supplied,
  // omit auth.jwt entirely so nothing is guessed (strategy alone is written).
  const jwtPins: Record<string, unknown> = {};
  if (issuer !== undefined) jwtPins.issuer = issuer;
  const auth: Record<string, unknown> = { strategy: "jwt" };
  if (Object.keys(jwtPins).length > 0) auth.jwt = jwtPins;
  return {
    tenant,
    saas: { baseUrl: saasBaseUrl },
    auth,
    dmSecurity: "open",
    nats: { admission: "register-hop", credentials: { mode: "enrolled" } },
  };
}

/**
 * Write an account's config without mutating the caller's config object.
 *
 *   - `"default"` with NO existing named accounts ⇒ merge the patch into the
 *     CHANNEL-LEVEL (flat) fields. Channel level is the SHARED BASE; while no
 *     named accounts exist a flat `"default"` is still servable (via the
 *     empty/absent-accounts fallback), so a single-account deployment's on-disk
 *     shape never changes.
 *   - `"default"` WHEN a named `accounts` map already exists ⇒ write the patch
 *     under `accounts.default` instead of flat. Once named accounts exist,
 *     channel-level fields are shared base ONLY and no longer conjure an implicit
 *     default (issue #17); a flat default write would enroll creds for an account
 *     that `listWebchannelAccountIds` never serves, and its identity fields would
 *     contaminate the named accounts as shared base. Scoping to `accounts.default`
 *     mirrors core's own behavior once named accounts exist.
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

  const existingAccounts = readAccountsMap(section);
  const hasNamedAccounts = Object.keys(existingAccounts).length > 0;

  if (accountId === DEFAULT_WEBCHANNEL_ACCOUNT_ID && !hasNamedAccounts) {
    // Merge at channel level (excluding the structural `accounts` map). Safe only
    // while no named accounts exist — a flat default is still servable then.
    const { accounts, ...flat } = section as { accounts?: unknown } & Record<string, unknown>;
    const mergedFlat = mergePatch(flat, patch);
    const nextSection: Record<string, unknown> = { ...mergedFlat };
    if (accounts !== undefined) nextSection.accounts = accounts;
    channels[WEBCHANNEL_ID] = nextSection;
  } else {
    // Named account, OR the default once named accounts exist: scope under
    // `accounts.<id>` so it is actually served (issue #17).
    const accounts = { ...existingAccounts };
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

  /**
   * Sync config WRITE: shape the account from flags.
   *
   * This is the NON-INTERACTIVE (`--flag`) write seam. The interactive wizard
   * writes atomically in its `finalize` (its text inputs use no-op `applySet`s
   * and never reach here), so the two cases are distinguished purely by whether a
   * `saasBaseUrl` is present in the input:
   *   - `saasBaseUrl` PRESENT (`channels add --base-url <saas> …`) ⇒ write the
   *     COMPLETE enroll-ready block (`buildFullAccountPatch`), MERGED onto any
   *     existing account so a re-run preserves a hand-tuned `auth.jwt.issuer`
   *     pin (only fields we actually supply win).
   *   - `saasBaseUrl` ABSENT (a genuine partial `--flag` run — e.g. setting only
   *     `--url <tenant>` or the credential mode) ⇒ fall back to the partial
   *     `buildAccountPatch` write. This guard is REQUIRED so a partial run never
   *     emits a broken full block before a `saasBaseUrl` has been supplied.
   */
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
    assertNoRemovedAudienceConfig(cfg, id);
    if (Object.prototype.hasOwnProperty.call(input, "audience")) {
      throw new Error(
        "webchannel: removed setup input audience is no longer supported; delete it. JWT aud is always the accountId.",
      );
    }
    const identity = resolveSetupIdentity(input);

    if (identity.saasBaseUrl !== undefined) {
      // Full-block seam. Read the existing account so a re-run preserves the
      // operator's manual issuer pin unless the flag explicitly overrides.
      const existing = resolveWebchannelAccountConfig(cfg, id);
      const existingJwt = (existing.auth as { jwt?: { issuer?: string } } | undefined)
        ?.jwt;
      const patch = buildFullAccountPatch({
        tenant: identity.tenant ?? (existing.tenant as string | undefined) ?? "default-tenant",
        saasBaseUrl: identity.saasBaseUrl,
        accountId: id,
        issuer: input.issuer ?? existingJwt?.issuer,
      });
      return writeAccountConfig(cfg, id, patch);
    }

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

    // Resolve the COMPLETE effective identity before consulting the credential
    // path. Path ownership alone is never proof that persisted enrollment
    // material belongs to this configured account.
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
          `webchannel --account ${id} --base-url <saas-url> --url <tenant-uuid> ` +
          `(--url carries the tenant id, not a URL — the flag name is a host-CLI ` +
          `limitation; --base-url is the SaaS URL)`,
      );
      return;
    }

    const existingPath = accountCredentialPath(id);
    let persisted: ReturnType<typeof loadPersistedCredentialDocument>;
    try {
      persisted = loadPersistedCredentialDocument({
        tenant,
        accountId: id,
        saasBaseUrl,
      });
    } catch {
      runtime.log(
        `[webchannel] account "${id}": effective tenant/account/SaaS identity is ` +
          `invalid; refusing credential reuse or enrollment. Correct the account ` +
          `configuration, then re-run channels add.`,
      );
      return;
    }
    if (persisted.status === "match") {
      runtime.log(
        `[webchannel] account "${id}" has complete matching v2 credentials at ` +
          `${existingPath}; skipping acquisition.`,
      );
      return;
    }
    if (persisted.status !== "absent") {
      runtime.log(
        `[webchannel] account "${id}": refusing to reuse or replace persisted ` +
          `credentials (${formatCredentialInspection(persisted)}). Stop the gateway, ` +
          `archive ${existingPath} to a new backup path, complete any SaaS active-key ` +
          `replacement required by your deployment, then re-run: openclaw channels add ` +
          `--channel webchannel --account ${id}`,
      );
      return;
    }

    // Echo the RESOLVED identity (non-secret) so the generic-flag mapping is
    // never silent — a mis-mapped --url/--base-url is visible here. The wire
    // identity is the account id itself (가-2).
    runtime.log(
      `[webchannel] account "${id}" resolved acquisition identity: ` +
        `accountId=${id}, tenant=${tenant}, saasBaseUrl=${saasBaseUrl} ` +
        `(reminder: on 'channels add' the tenant id rides the --url flag, the ` +
        `SaaS URL rides --base-url)`,
    );

    try {
      const enrollment = await acquireCredentials({
        accountId: id,
        saasBaseUrl,
        tenant,
        log: (...args) => runtime.log(...args),
      });

      // Gate A (design §4 change 4): the achievable add-time preflight, run
      // POST-enroll (creds are now persisted) and BEFORE declaring the add
      // done, so any residual trust misconfig is self-explaining while the
      // operator is watching. It checks issuer/aud internal consistency, the
      // derived JWKS (reachable + non-empty + matching the SaaS's advertised
      // url — the issuer-mismatch trap), and a real relay dial with the enrolled
      // creds. A true end-to-end register round-trip is INFEASIBLE at add-time
      // (no running gateway ⇒ no `*.register` subscriber, and no browser
      // bootstrap JWT yet) — see `preflight.ts` runAddPreflight for the honest
      // scope. Never throws (matches this hook's non-fatal contract); a FAIL is a
      // loud, actionable log line.
      const existingJwt = (account.auth as { jwt?: { issuer?: string } } | undefined)
        ?.jwt;
      await runAddPreflight({
        accountId: id,
        tenant,
        saasBaseUrl,
        enrollment: {
          userJwt: enrollment.creds.userJwt,
          userSeed: enrollment.creds.userSeed,
          ...(enrollment.natsUrl !== undefined ? { natsUrl: enrollment.natsUrl } : {}),
          ...(enrollment.jwksUrl !== undefined ? { jwksUrl: enrollment.jwksUrl } : {}),
          ...(enrollment.issuer !== undefined ? { issuer: enrollment.issuer } : {}),
        },
        // Config-present-wins: an operator PIN overrides the derivation.
        ...(existingJwt?.issuer !== undefined ? { pinnedIssuer: existingJwt.issuer } : {}),
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
