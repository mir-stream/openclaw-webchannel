/**
 * WebChannel account model (가-1).
 *
 * ── Canonical layout (aligned with OpenClaw core) ───────────────────────────
 * OpenClaw's multi-account model stores per-account config under
 * `channels.<channel>.accounts.<accountId>`, with the channel-level (flat)
 * fields acting as a SHARED BASE that is merged UNDER each account
 * (core `mergeAccountConfig`: channel base, then the account override wins; the
 * `accounts` key itself is omitted from the base). A flat single-account config
 * with NO `accounts` map is the implicit `"default"` account.
 *
 * We mirror that exactly so `openclaw channels add --channel webchannel
 * --account X` interoperates with core's setup pipeline. In particular, for a
 * NON-default account core runs `moveSingleAccountChannelSectionToDefaultAccount`
 * BEFORE the plugin's `applyAccountConfig`, promoting an allowlisted subset of
 * channel-level keys into `accounts.default`; the channel-level fields it does
 * NOT promote (for webchannel: auth / nats / tenant / agentId / dmSecurity / …)
 * remain at channel level and are inherited as the shared base via the merge.
 * Reading through `resolveWebchannelAccountConfig` reconstructs the full account
 * config regardless of which fields ended up where.
 *
 * Cycle 1 keeps single-account `"default"` working end-to-end; multi-account
 * multiplex SERVING is Cycle 2. `"default"` is a NORMAL account id.
 *
 * ── Account id is a TRUST BOUNDARY ──────────────────────────────────────────
 * accountId flows into filesystem paths (`~/.openclaw-webchannel/<account>/…`),
 * so it MUST be validated/canonicalized before any `path.join`. We reuse core's
 * canonicalization rules and additionally HARD-REJECT a non-conforming id at the
 * path boundary so a traversal sequence (`../../evil`) can never escape the root.
 */

import { homedir } from "node:os";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { WebchannelNatsConfig } from "./nats-credential-source.js";

/** The single default account id (mirrors core's `"default"`). */
export const DEFAULT_ACCOUNT_ID = "default";

/**
 * Strict account-id shape accepted at the filesystem trust boundary. Matches the
 * brief's `^[A-Za-z0-9_-]{1,64}$`; intentionally stricter than core's lenient
 * canonicalizer (no leading-dash / dot / slash) so a path component can never
 * contain `.`/`/`/`\`.
 */
const STRICT_ACCOUNT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Object keys that must never be used as account ids (prototype pollution). */
const BLOCKED_ACCOUNT_IDS = new Set(["__proto__", "prototype", "constructor"]);

/**
 * Core-compatible canonicalization (mirrors openclaw's `normalizeAccountId`):
 * lowercase, replace runs of invalid chars with `-`, strip leading/trailing
 * `-`, clamp to 64 chars, default to `"default"` when empty. Use this when
 * accepting an operator-supplied id (e.g. `channels add --account …`) so the
 * stored id matches what core would store and can never be a traversal sequence.
 */
export function canonicalizeAccountId(value: string | undefined | null): string {
  const trimmed = (value ?? "").trim().toLowerCase();
  if (!trimmed) return DEFAULT_ACCOUNT_ID;
  const canonical = trimmed
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
    .slice(0, 64);
  if (!canonical || BLOCKED_ACCOUNT_IDS.has(canonical)) return DEFAULT_ACCOUNT_ID;
  return canonical;
}

/** True when `id` is a safe account id for use as a filesystem path component. */
export function isValidAccountId(id: string): boolean {
  return STRICT_ACCOUNT_ID_RE.test(id) && !BLOCKED_ACCOUNT_IDS.has(id.toLowerCase());
}

/**
 * Assert that an account id is safe to use in a filesystem path. Throws on a
 * traversal sequence / illegal character / blocked key. This is the last-line
 * defense at every path-building / credential-loading entry point.
 */
export function assertValidAccountId(id: string): void {
  if (!isValidAccountId(id)) {
    throw new Error(
      `webchannel: invalid account id ${JSON.stringify(id)} — must match ` +
        `/^[A-Za-z0-9_-]{1,64}$/ (refusing to build a credential path).`,
    );
  }
}

/** Per-account config keys whose nested object values are shallow-merged. */
const NESTED_OBJECT_KEYS = [
  "auth",
  "nats",
  "saas",
  "capabilities",
  "history",
  "streaming",
  "execApprovals",
  "encryption",
] as const;

/**
 * Channel-level keys that are structural (NOT shared-base account fields). These
 * are excluded from the merge base, matching core's `mergeAccountConfig`
 * (`accounts` omitted) plus `defaultAccount`/`enabled`.
 */
const STRUCTURAL_KEYS = new Set(["accounts", "defaultAccount", "enabled"]);

/**
 * Channel-level leaf fields that signal an implicit `"default"` account is
 * configured (the shared base is itself a usable account).
 */
const DEFAULT_ACCOUNT_MARKER_KEYS = [
  "auth",
  "nats",
  "allowFrom",
  "groupAllowFrom",
  "dmSecurity",
  "streaming",
  "execApprovals",
  "capabilities",
  "history",
  "encryption",
  "saas",
  "tenant",
  "agentId",
] as const;

/** A single resolved account's raw config object. */
export type WebchannelAccountConfig = Record<string, unknown>;

/**
 * Acquisition identity for an account — the inputs the device-flow enroll needs.
 * `saasBaseUrl` is optional; the credential-source resolver owns its full
 * precedence (env > nats.credentials.saasBaseUrl > … > default).
 */
export type WebchannelAcquisitionIdentity = {
  accountId: string;
  tenant: string;
  agentId: string;
  saasBaseUrl?: string;
};

/** Read the `channels.webchannel` block off an OpenClaw config, untyped. */
export function readWebchannelSection(cfg: unknown): Record<string, unknown> | undefined {
  const channels = (cfg as { channels?: Record<string, unknown> } | undefined)?.channels;
  return (channels?.["webchannel"] as Record<string, unknown> | undefined) ?? undefined;
}

/** Read the per-account map `channels.webchannel.accounts`. */
export function readAccountsMap(
  section: Record<string, unknown> | undefined,
): Record<string, WebchannelAccountConfig> {
  const accounts = section?.["accounts"];
  return accounts !== null && typeof accounts === "object"
    ? (accounts as Record<string, WebchannelAccountConfig>)
    : {};
}

/** The channel-level shared base (flat fields, excluding structural keys). */
function channelLevelBase(
  section: Record<string, unknown> | undefined,
): WebchannelAccountConfig {
  if (!section) return {};
  const base: WebchannelAccountConfig = {};
  for (const [key, value] of Object.entries(section)) {
    if (!STRUCTURAL_KEYS.has(key)) base[key] = value;
  }
  return base;
}

/** Does the channel-level base carry any leaf field (⇒ implicit default account)? */
export function hasChannelLevelAccountFields(
  section: Record<string, unknown> | undefined,
): boolean {
  if (!section) return false;
  return DEFAULT_ACCOUNT_MARKER_KEYS.some((key) => key in section);
}

/**
 * Merge the channel-level base under an account override (core-compatible):
 * shallow spread (override wins), then a one-level shallow merge for the known
 * nested object keys so e.g. `nats.credentials` from the account does not drop
 * `nats.url` from the base.
 */
function mergeAccountConfig(
  base: WebchannelAccountConfig,
  override: WebchannelAccountConfig,
): WebchannelAccountConfig {
  const merged: WebchannelAccountConfig = { ...base, ...override };
  for (const key of NESTED_OBJECT_KEYS) {
    const baseVal = base[key];
    const overrideVal = override[key];
    if (
      baseVal &&
      typeof baseVal === "object" &&
      !Array.isArray(baseVal) &&
      overrideVal &&
      typeof overrideVal === "object" &&
      !Array.isArray(overrideVal)
    ) {
      merged[key] = { ...(baseVal as object), ...(overrideVal as object) };
    }
  }
  return merged;
}

/**
 * List the configured account ids (canonical `accounts.<id>` model).
 *
 *   - keys of `channels.webchannel.accounts`, PLUS
 *   - `"default"` when the channel-level base carries leaf fields (implicit
 *     default), PLUS
 *   - a `["default"]` fallback when nothing else is configured.
 *
 * MUST return ≥1 entry (core's channel monitor short-circuits otherwise).
 * Sorted for stable ordering (mirrors core).
 */
export function listWebchannelAccountIds(cfg: unknown): string[] {
  const section = readWebchannelSection(cfg);
  const ids = new Set<string>(Object.keys(readAccountsMap(section)).filter(Boolean));
  if (hasChannelLevelAccountFields(section)) ids.add(DEFAULT_ACCOUNT_ID);
  if (ids.size === 0) return [DEFAULT_ACCOUNT_ID];
  return [...ids].sort((a, b) => a.localeCompare(b));
}

/**
 * Resolve the account id this Cycle-1 process serves. Prefers `"default"` when
 * listed (regression-stable for single-account deployments), else the first
 * listed account. Cycle 2 will multiplex ALL listed accounts.
 */
export function resolveServingAccountId(cfg: unknown): string {
  const ids = listWebchannelAccountIds(cfg);
  return ids.includes(DEFAULT_ACCOUNT_ID) ? DEFAULT_ACCOUNT_ID : (ids[0] ?? DEFAULT_ACCOUNT_ID);
}

/**
 * Resolve a single account's effective config: the channel-level shared base
 * merged under the account override at `accounts.<accountId>`.
 *
 *   - Flat single-account config (no `accounts`) + `"default"` ⇒ the flat base
 *     (backward-compatible single-account behavior).
 *   - Per-account config ⇒ shared base + the named account's override.
 */
export function resolveWebchannelAccountConfig(
  cfg: unknown,
  accountId: string = DEFAULT_ACCOUNT_ID,
): WebchannelAccountConfig {
  const section = readWebchannelSection(cfg);
  if (!section) return {};
  const base = channelLevelBase(section);
  const override = readAccountsMap(section)[accountId] ?? {};
  return mergeAccountConfig(base, override);
}

/**
 * Resolve the acquisition identity (saasBaseUrl / tenant / agentId) for an
 * account from its merged config. Falls back to legacy top-level
 * `cfg.tenant`/`cfg.agentId`/`cfg.saas.baseUrl` ONLY for the `"default"` account.
 *
 * NOTE (Cycle 2): the merged config inherits channel-level tenant/agentId as a
 * shared base, so a NAMED account that does not set its own agentId would
 * inherit the default's. Cycle 2 multiplex routing must require each named
 * account to declare its own agentId (no cross-account identity inheritance).
 */
export function resolveAcquisitionIdentity(
  cfg: unknown,
  accountId: string = DEFAULT_ACCOUNT_ID,
): WebchannelAcquisitionIdentity {
  const account = resolveWebchannelAccountConfig(cfg, accountId);
  const top = cfg as
    | { tenant?: string; agentId?: string; saas?: { baseUrl?: string } }
    | undefined;
  const accountSaas = (account.saas as { baseUrl?: string } | undefined)?.baseUrl;

  const isDefault = accountId === DEFAULT_ACCOUNT_ID;
  return {
    accountId,
    tenant:
      (account.tenant as string | undefined) ??
      (isDefault ? top?.tenant : undefined) ??
      "default-tenant",
    agentId:
      (account.agentId as string | undefined) ??
      (isDefault ? top?.agentId : undefined) ??
      "default-agent",
    saasBaseUrl: accountSaas ?? (isDefault ? top?.saas?.baseUrl : undefined),
  };
}

/** Read an account's merged `nats` config block (for credential-source resolution). */
export function resolveAccountNatsConfig(
  cfg: unknown,
  accountId: string = DEFAULT_ACCOUNT_ID,
): WebchannelNatsConfig | undefined {
  const account = resolveWebchannelAccountConfig(cfg, accountId);
  return account.nats as WebchannelNatsConfig | undefined;
}

// ---------------------------------------------------------------------------
// Credential paths
// ---------------------------------------------------------------------------

/** Root dir for persisted webchannel credentials (~/.openclaw-webchannel). */
export function credentialsRootDir(home: string = homedir()): string {
  return join(home, ".openclaw-webchannel");
}

/**
 * Per-account credential path: `~/.openclaw-webchannel/<account>/credentials.json`.
 * Validates `accountId` (rejects traversal) BEFORE the join.
 */
export function accountCredentialPath(
  accountId: string = DEFAULT_ACCOUNT_ID,
  home: string = homedir(),
): string {
  assertValidAccountId(accountId);
  return join(credentialsRootDir(home), accountId, "credentials.json");
}

/**
 * Legacy single-file path: `~/.openclaw-webchannel/credentials.json`.
 *
 * Kept for the backward-compat fallback: when the per-account file is absent for
 * the `"default"` account AND this legacy file exists, the runtime reads it.
 */
export function legacyCredentialPath(home: string = homedir()): string {
  return join(credentialsRootDir(home), "credentials.json");
}

/**
 * Resolve the credential path to READ for an account.
 *
 * Precedence:
 *   1. The per-account path if it exists.
 *   2. Backward-compat: for `"default"` only, the legacy single-file path.
 *   3. Otherwise the per-account path (callers treat a non-existent path as
 *      "creds missing").
 *
 * `assertValidAccountId` runs first (via `accountCredentialPath`).
 */
export function resolveReadCredentialPath(
  accountId: string = DEFAULT_ACCOUNT_ID,
  opts: { home?: string; exists?: (p: string) => boolean } = {},
): string {
  const home = opts.home ?? homedir();
  const exists = opts.exists ?? existsSync;
  const perAccount = accountCredentialPath(accountId, home);
  if (exists(perAccount)) return perAccount;
  if (accountId === DEFAULT_ACCOUNT_ID) {
    const legacy = legacyCredentialPath(home);
    if (exists(legacy)) return legacy;
  }
  return perAccount;
}

/**
 * Persisted enrolled NATS credentials (the subset `gateway run` consumes).
 * Mirrors the `enrollment.creds` block of the on-disk `PluginCredentials`.
 */
export type PersistedEnrolledCreds = {
  userJwt: string;
  userSeed: string;
};

/**
 * Load the persisted enrolled creds for an account (CONSUME-only path — 가-1).
 *
 * Reads the resolved credential file (per-account, with the legacy fallback for
 * `"default"`) and returns its `enrollment.creds`. Returns `undefined` when the
 * file is absent, unreadable, malformed, or has no enrollment block — the
 * runtime treats that as "creds missing" and applies account-scoped graceful
 * degradation (it never enrolls at runtime). Validates `accountId` first.
 *
 * The fs seams are injectable for tests.
 */
export function loadPersistedEnrolledCreds(
  accountId: string = DEFAULT_ACCOUNT_ID,
  opts: {
    home?: string;
    exists?: (p: string) => boolean;
    read?: (p: string) => string;
  } = {},
): PersistedEnrolledCreds | undefined {
  assertValidAccountId(accountId);
  const exists = opts.exists ?? existsSync;
  const read = opts.read ?? ((p: string) => readFileSync(p, "utf-8"));
  const path = resolveReadCredentialPath(accountId, {
    ...(opts.home !== undefined ? { home: opts.home } : {}),
    exists,
  });
  if (!exists(path)) return undefined;
  try {
    const parsed = JSON.parse(read(path)) as {
      enrollment?: { creds?: { userJwt?: unknown; userSeed?: unknown } };
    };
    const creds = parsed.enrollment?.creds;
    if (
      creds &&
      typeof creds.userJwt === "string" &&
      typeof creds.userSeed === "string" &&
      creds.userJwt.length > 0 &&
      creds.userSeed.length > 0
    ) {
      return { userJwt: creds.userJwt, userSeed: creds.userSeed };
    }
    return undefined;
  } catch {
    return undefined;
  }
}
