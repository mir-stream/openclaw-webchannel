/**
 * WebChannel account model (가-1).
 *
 * ── Canonical layout (aligned with OpenClaw core) ───────────────────────────
 * OpenClaw's multi-account model stores per-account config under
 * `channels.<channel>.accounts.<accountId>`, with the channel-level (flat)
 * fields acting as a SHARED BASE that is merged UNDER each account
 * (core `mergeAccountConfig`: channel base, then the account override wins; the
 * `accounts` key itself is omitted from the base). A flat single-account config
 * with NO `accounts` map is the implicit `"default"` account. Once the `accounts`
 * map is present and non-empty, the channel-level leaf fields are the SHARED BASE
 * ONLY — they never conjure an implicit `"default"` account alongside the named
 * ones. `"default"` is then listed only when it is an explicit key of `accounts`.
 *
 * We mirror that exactly so `openclaw channels add --channel webchannel
 * --account X` interoperates with core's setup pipeline. In particular, for a
 * NON-default account core runs `moveSingleAccountChannelSectionToDefaultAccount`
 * BEFORE the plugin's `applyAccountConfig`, promoting an allowlisted subset of
 * channel-level keys into `accounts.default`; the channel-level fields it does
 * NOT promote (for webchannel: auth / nats / tenant / dmSecurity / …)
 * remain at channel level and are inherited as the shared base via the merge.
 * Reading through `resolveWebchannelAccountConfig` reconstructs the full account
 * config regardless of which fields ended up where.
 *
 * Cycle 1 keeps single-account `"default"` working end-to-end; multi-account
 * multiplex SERVING is Cycle 2. `"default"` is a NORMAL account id.
 *
 * ── Account id is a TRUST BOUNDARY ──────────────────────────────────────────
 * accountId participates in the exact storage identity, so it MUST be validated
 * before deriving an opaque tuple namespace. Raw tenant/account values are
 * never interpolated into v2 persistence paths.
 */

import { homedir } from "node:os";
import {
  lstatSync,
  readFileSync,
  statSync,
  type Stats,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

import {
  assertValidAccountId,
  isBlockedAccountId,
  isValidAccountId,
} from "./account-id.js";
import {
  assertValidCredentialBindingExpectation,
  loadBoundCredentialDocumentJson,
  type BoundCredentialLoadResult,
  type CredentialBindingExpectation,
} from "./credential-document.js";
import { migrateLegacyTupleState } from "./legacy-storage-migration.js";
import type { WebchannelNatsConfig } from "./nats-credential-source.js";
import {
  resolveCredentialPath,
  type CredentialPathOptions,
} from "./storage-paths.js";
import type { StorageScopeIdentity } from "./storage-identity.js";
import { StorageDocumentError } from "./storage-document.js";

export { assertValidAccountId, isValidAccountId } from "./account-id.js";
export type { PersistedEnrolledCreds } from "./credential-document.js";

/** The single default account id (mirrors core's `"default"`). */
export const DEFAULT_WEBCHANNEL_ACCOUNT_ID = "default";

export type InvalidAccountId = { id: string; reason: string };

export type AccountIdInspection = {
  validIds: string[];
  invalid: InvalidAccountId[];
  usesImplicitDefault: boolean;
};

/** JSON rendering is deliberately shared by every surface that prints an id. */
export function formatAccountIdForLog(id: string): string {
  return JSON.stringify(id);
}

export function inspectWebchannelAccountIds(cfg: unknown): AccountIdInspection {
  const section = readWebchannelSection(cfg);
  const rawIds = Object.keys(readAccountsMap(section));
  if (rawIds.length === 0) {
    return {
      validIds: [DEFAULT_WEBCHANNEL_ACCOUNT_ID],
      invalid: [],
      usesImplicitDefault: true,
    };
  }

  const validIds: string[] = [];
  const invalid: InvalidAccountId[] = [];
  for (const id of rawIds) {
    if (isValidAccountId(id)) validIds.push(id);
    else {
      invalid.push({
        id,
        reason: isBlockedAccountId(id)
          ? "the id is a blocked prototype key"
          : "the id must match /^[A-Za-z0-9_-]{1,64}$/",
      });
    }
  }
  validIds.sort((a, b) => a.localeCompare(b));
  invalid.sort((a, b) => a.id.localeCompare(b.id));
  return { validIds, invalid, usesImplicitDefault: false };
}

/**
 * Core-compatible canonicalization (mirrors openclaw's `normalizeAccountId`):
 * lowercase, replace runs of invalid chars with `-`, strip leading/trailing
 * `-`, clamp to 64 chars, default to `"default"` when empty. Use this when
 * accepting an operator-supplied id (e.g. `channels add --account …`) so the
 * stored id matches what core would store and can never be a traversal sequence.
 */
export function canonicalizeAccountId(value: string | undefined | null): string {
  const trimmed = (value ?? "").trim().toLowerCase();
  if (!trimmed) return DEFAULT_WEBCHANNEL_ACCOUNT_ID;
  const canonical = trimmed
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
    .slice(0, 64);
  if (!canonical || isBlockedAccountId(canonical)) return DEFAULT_WEBCHANNEL_ACCOUNT_ID;
  return canonical;
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

/** A single resolved account's raw config object. */
export type WebchannelAccountConfig = Record<string, unknown>;

export class RemovedAudienceConfigError extends Error {
  readonly accountId: string;
  readonly paths: readonly string[];

  constructor(accountId: string, paths: readonly string[]) {
    super(
      `webchannel: removed config ${paths.join(", ")} is no longer supported for account ` +
        `${JSON.stringify(accountId)}; delete auth.jwt.audience. JWT aud is always the runtime ` +
        `accountId. Refusing to serve this account.`,
    );
    this.name = "RemovedAudienceConfigError";
    this.accountId = accountId;
    this.paths = [...paths];
  }
}

function hasRawAudience(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const jwt = (value as { jwt?: unknown }).jwt;
  return Boolean(
    jwt &&
      typeof jwt === "object" &&
      !Array.isArray(jwt) &&
      Object.prototype.hasOwnProperty.call(jwt, "audience"),
  );
}

/** Return the raw removed-key locations that scope to one account before merge. */
export function findRemovedAudiencePaths(cfg: unknown, accountId: string): string[] {
  const section = readWebchannelSection(cfg);
  if (!section) return [];
  const paths: string[] = [];
  if (hasRawAudience(section.auth)) {
    paths.push("channels.webchannel.auth.jwt.audience");
  }
  const account = readAccountsMap(section)[accountId];
  if (account && hasRawAudience(account.auth)) {
    paths.push(`channels.webchannel.accounts.${accountId}.auth.jwt.audience`);
  }
  return paths;
}

export function assertNoRemovedAudienceConfig(cfg: unknown, accountId: string): void {
  const paths = findRemovedAudiencePaths(cfg, accountId);
  if (paths.length > 0) throw new RemovedAudienceConfigError(accountId, paths);
}

/**
 * Acquisition identity for an account — the inputs the device-flow enroll needs.
 * `saasBaseUrl` is optional; the credential-source resolver owns its full
 * precedence (env > nats.credentials.saasBaseUrl > … > default).
 */
export type WebchannelAcquisitionIdentity = {
  /** Account (deployment) id — the wire identity (JWT aud / NATS subject key). */
  accountId: string;
  tenant: string;
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

/**
 * Whether `channels.webchannel` contains actual account configuration data.
 * Lifecycle/selection metadata alone does not configure an account: an empty
 * `accounts` map, `defaultAccount`, and `enabled` are structural. Any real flat
 * field or at least one entry in `accounts` does count as configuration.
 */
export function hasWebchannelConfig(cfg: unknown): boolean {
  const section = readWebchannelSection(cfg);
  if (!section) return false;
  if (Object.keys(readAccountsMap(section)).length > 0) return true;
  return Object.keys(section).some((key) => !STRUCTURAL_KEYS.has(key));
}

/**
 * Resolve whether an account is enabled for both status and runtime planning.
 * A channel-level false disables every account; otherwise an explicit named
 * account false disables only that account. Missing flags default to enabled.
 */
export function isWebchannelAccountEnabled(
  cfg: unknown,
  accountId?: string | null,
): boolean {
  const section = readWebchannelSection(cfg);
  if (section?.enabled === false) return false;

  const id = accountId ?? DEFAULT_WEBCHANNEL_ACCOUNT_ID;
  const account = readAccountsMap(section)[id];
  return !(account && typeof account === "object" && account.enabled === false);
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

function assertNoRemovedConfig(account: WebchannelAccountConfig): void {
  const auth = account.auth;
  if (auth && typeof auth === "object" && Object.prototype.hasOwnProperty.call(auth, "ticketParam")) {
    throw new Error(
      "webchannel: removed config auth.ticketParam is no longer supported because Gateway direct WebSocket authentication was deleted; reconfigure with `openclaw channels add --channel webchannel`.",
    );
  }
  const migrationError = (setting: string): never => {
    throw new Error(
      `webchannel: removed config ${setting} is no longer supported; authenticated enrollment is required. Reconfigure with \`openclaw channels add --channel webchannel\`.`,
    );
  };
  if (auth && typeof auth === "object" && (auth as { strategy?: unknown }).strategy === "anonymous") {
    migrationError('auth.strategy="anonymous"');
  }
  const nats = account.nats;
  if (nats && typeof nats === "object") {
    if (Object.prototype.hasOwnProperty.call(nats, "devOpen")) migrationError("nats.devOpen");
    if ((nats as { admission?: unknown }).admission === "auto") migrationError('nats.admission="auto"');
    const credentials = (nats as { credentials?: unknown }).credentials;
    if (credentials && typeof credentials === "object" && (credentials as { mode?: unknown }).mode === "open") {
      migrationError('nats.credentials.mode="open"');
    }
  }
}

/**
 * List the configured account ids (canonical `accounts.<id>` model).
 *
 *   - the keys of `channels.webchannel.accounts`, OR
 *   - a `["default"]` fallback when that map is empty/absent (the flat
 *     single-account config, whose channel-level base IS the default account).
 *
 * Channel-level leaf fields are the SHARED BASE only: once `accounts` is present
 * and non-empty they never conjure an implicit `"default"` alongside the named
 * accounts (issue #17). `"default"` is listed only when it is an explicit key of
 * `accounts`, or when `accounts` is empty/absent (the fallback).
 *
 * MUST return ≥1 entry (core's channel monitor short-circuits otherwise).
 * Sorted for stable ordering (mirrors core).
 */
export function listWebchannelAccountIds(cfg: unknown): string[] {
  return inspectWebchannelAccountIds(cfg).validIds;
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
  accountId: string = DEFAULT_WEBCHANNEL_ACCOUNT_ID,
): WebchannelAccountConfig {
  const section = readWebchannelSection(cfg);
  if (!section) return {};
  const base = channelLevelBase(section);
  const override = readAccountsMap(section)[accountId] ?? {};
  const resolved = mergeAccountConfig(base, override);
  assertNoRemovedConfig(resolved);
  return resolved;
}

/**
 * Resolve the acquisition identity (accountId / tenant / saasBaseUrl) for an
 * account from its merged config. Falls back to legacy top-level
 * `cfg.tenant`/`cfg.saas.baseUrl` ONLY for the `"default"` account.
 *
 * 가-2: the wire identity is the `accountId` itself (the `--account` flag / the
 * `accounts.<id>` key). The handling agent is decoupled — it is now purely an
 * `agents bind` concern (telegram-like), so no per-account `agentId` is read.
 */
export function resolveAcquisitionIdentity(
  cfg: unknown,
  accountId: string = DEFAULT_WEBCHANNEL_ACCOUNT_ID,
): WebchannelAcquisitionIdentity {
  const account = resolveWebchannelAccountConfig(cfg, accountId);
  const top = cfg as
    | { tenant?: string; saas?: { baseUrl?: string } }
    | undefined;
  const accountSaas = (account.saas as { baseUrl?: string } | undefined)?.baseUrl;

  const isDefault = accountId === DEFAULT_WEBCHANNEL_ACCOUNT_ID;
  return {
    accountId,
    tenant:
      (account.tenant as string | undefined) ??
      (isDefault ? top?.tenant : undefined) ??
      "default-tenant",
    saasBaseUrl: accountSaas ?? (isDefault ? top?.saas?.baseUrl : undefined),
  };
}

/**
 * Resolve whether the typing indicator is enabled for an account (P0-6).
 *
 * Reads the account's merged `capabilities.typing` (channel-level shared base
 * under the account override — pass a config already resolved via
 * `resolveWebchannelAccountConfig`). Enabled by ANYTHING but an explicit
 * `"off"`, so an omitted key defaults ON, mirroring the legacy WS wiring at
 * `index.ts` (`typing !== "off"`) — we apply the default here rather than
 * depending on the JSON schema being applied.
 *
 * Unlike the legacy WS path, which reads the flat CHANNEL-LEVEL section, this
 * reads the PER-ACCOUNT resolved config so each account's capability applies to
 * its own channel (가-1 Cycle 2 — see `inbound.ts`). The NATS channel gate
 * (`NatsChannel.setTypingEnabled`) was previously never wired, so an operator's
 * `typing: "off"` was silently ignored on NATS.
 */
export function resolveTypingEnabled(accountConfig: WebchannelAccountConfig): boolean {
  const capabilities = accountConfig?.capabilities as
    | { typing?: "on" | "off" }
    | undefined;
  return (capabilities?.typing ?? "on") !== "off";
}

/**
 * Resolve whether the REASONING lane is enabled for an account (#113).
 *
 * Reads the account's merged `capabilities.reasoning` (channel-level shared base
 * under the account override — pass a config already resolved via
 * `resolveWebchannelAccountConfig`), exactly like `resolveTypingEnabled` above.
 *
 * DEFAULT ON — an ABSENT key enables the lane. The consumer already ships the
 * reasoning UI, so a deployment that has not hand-edited its config renders an
 * empty Reasoning shell on every turn; that empty shell is the exact symptom
 * #113 exists to remove, and defaulting OFF would have left it in place for
 * everyone who never read this file.
 *
 * The rule is `absent → ON; present-and-not-boolean-true → OFF`, NOT a `!== false`
 * truthiness test. That distinction is the whole safety argument and it survives
 * the default flip intact:
 *
 *   - `capabilities.typing` next door spells its values `"on"` / `"off"`, so
 *     `reasoning: "off"` is the FIRST thing an operator copying the sibling key
 *     reaches for when they want the lane disabled;
 *   - under `!== false` that string is truthy and would KEEP reasoning on, i.e.
 *     silently defeat the operator's intent — and now in the privacy-losing
 *     direction, because reasoning can restate file contents, credentials, or the
 *     user's own prompt to the least trusted surface this plugin serves;
 *   - so every PRESENT value that is not boolean `true` fails CLOSED: `false`,
 *     `"off"`, `"false"`, `"true"`, `"on"`, `0`, `1`, `null`. Someone who typed
 *     something gets the safe reading of it; only someone who typed NOTHING gets
 *     the new default.
 *
 * The JSON schema rejects the string spellings, but this resolver must not depend
 * on the schema having been applied — `resolveTypingEnabled` documents the same
 * rule.
 *
 * Note this is only the CHANNEL half of the gate. Reasoning also requires the
 * model's own thinking level to be something other than "off" (`canShowReasoning`
 * in core), which no amount of channel config can force. That precondition is why
 * an opened-but-silent lane surfaces a diagnostic rather than an empty section —
 * see the turn-scoped warning in inbound.ts.
 */
export function resolveReasoningEnabled(accountConfig: WebchannelAccountConfig): boolean {
  const capabilities = accountConfig?.capabilities as
    | { reasoning?: unknown }
    | undefined;
  const value = capabilities?.reasoning;
  // Absent → the new default ON. Present → strictly boolean `true`, everything
  // else fails closed (see the docblock: `reasoning: "off"` must never mean on).
  return value === undefined ? true : value === true;
}

/** Read an account's merged `nats` config block (for credential-source resolution). */
export function resolveAccountNatsConfig(
  cfg: unknown,
  accountId: string = DEFAULT_WEBCHANNEL_ACCOUNT_ID,
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
 * Exact tuple credential path under the opaque v2 namespace.
 */
export function accountCredentialPath(
  scope: StorageScopeIdentity,
  opts: { home?: string; storageRoot?: string; credentialPath?: string } = {},
): string {
  return resolveCredentialPath({ ...scope, ...opts });
}

/**
 * Migration-only legacy single-file location. Runtime readers must never
 * consult this path; it is exposed solely for explicit cleanup tooling.
 *
 * Readers never consult this location. Operators may use it only for an
 * explicit one-time migration or for the offline reset cleanup procedure.
 */
export function legacyCredentialPath(home: string = homedir()): string {
  return join(credentialsRootDir(home), "credentials.json");
}

/**
 * Resolve the credential path to READ for one exact tuple.
 *
 * This always returns the tuple-scoped path. The legacy single-file location
 * is migration/cleanup-only and is deliberately never a read fallback.
 *
 */
export function resolveReadCredentialPath(
  scope: StorageScopeIdentity,
  opts: {
    home?: string;
    storageRoot?: string;
    credentialPath?: string;
    exists?: (p: string) => boolean;
  } = {},
): string {
  return accountCredentialPath(scope, opts);
}

/** Resolve and validate a common tuple storage root from merged config. */
export function resolveAccountStorageRoot(
  account: WebchannelAccountConfig,
): string | undefined {
  const value = account.storageRoot;
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new Error(
      "webchannel: storageRoot must be a non-empty absolute filesystem path",
    );
  }
  if (!isAbsolute(value)) {
    throw new Error(
      "webchannel: storageRoot must be an absolute filesystem path",
    );
  }
  return value;
}

/**
 * Load one complete credential document only after proving its v2 binding.
 *
 * The legacy single-file path is never consulted. Unlike the historical loader,
 * this preserves absent/unbound/mismatch/incomplete/malformed as distinct,
 * sanitized outcomes and returns secrets only for a complete match.
 *
 * The fs seams are injectable for tests.
 */
export function loadPersistedCredentialDocument(
  expected: CredentialBindingExpectation,
  opts: {
    home?: string;
    storageRoot?: string;
    credentialPath?: string;
    /** @deprecated Retained for source compatibility; direct reads ignore it. */
    exists?: (p: string) => boolean;
    read?: (p: string) => string;
    migrateLegacy?: boolean;
  } = {},
): BoundCredentialLoadResult {
  assertValidCredentialBindingExpectation(expected);
  const pathOptions: CredentialPathOptions = {
    tenant: expected.tenant,
    accountId: expected.accountId,
    ...(opts.home !== undefined ? { home: opts.home } : {}),
    ...(opts.storageRoot !== undefined
      ? { storageRoot: opts.storageRoot }
      : {}),
    ...(opts.credentialPath !== undefined
      ? { credentialPath: opts.credentialPath }
      : {}),
  };
  const path = resolveReadCredentialPath(expected, opts);
  const initial = loadCredentialDocumentAtPath(expected, path, opts.read);
  const shouldMigrate =
    opts.migrateLegacy !== false &&
    opts.read === undefined &&
    opts.exists === undefined;
  if (!shouldMigrate) return initial;
  // An exact override may itself be a proven v1 source. Only the complete
  // unbound classification can enter that migration path; malformed,
  // mismatched, incomplete, and anomalous reads remain authoritative.
  if (initial.status !== "absent" && initial.status !== "match") {
    if (
      initial.status === "unbound" &&
      opts.credentialPath !== undefined
    ) {
      try {
        migrateLegacyTupleState(pathOptions);
      } catch (error) {
        if (
          error instanceof StorageDocumentError &&
          error.code === "identity-unbound"
        ) {
          return initial;
        }
        throw error;
      }
      return loadCredentialDocumentAtPath(expected, path, opts.read);
    }
    return initial;
  }
  migrateLegacyTupleState(pathOptions);
  return loadCredentialDocumentAtPath(expected, path, opts.read);
}

/**
 * Read and classify one exact credential path without an existence precheck.
 *
 * A direct read avoids check/read races and, critically, distinguishes a
 * genuinely absent file from an existing store hidden by filesystem denial.
 */
export function loadCredentialDocumentAtPath(
  expected: CredentialBindingExpectation,
  path: string,
  read: (p: string) => string = (p) => readFileSync(p, "utf-8"),
): BoundCredentialLoadResult {
  assertValidCredentialBindingExpectation(expected);
  let serialized: string;
  try {
    serialized = read(path);
  } catch (error) {
    if (
      isFilesystemErrorCode(error, "ENOENT") &&
      isGenuinelyAbsentCredentialPath(path)
    ) {
      return Object.freeze({ status: "absent" });
    }
    return Object.freeze({
      status: "invalid",
      code: "read-failed",
      fields: Object.freeze([]),
    });
  }
  return loadBoundCredentialDocumentJson(expected, serialized);
}

/**
 * Prove ENOENT means no credential directory entry exists.
 *
 * `readFileSync` follows symlinks, so a dangling symlink at the credential path
 * or in a parent component also reports ENOENT. Walk upward with lstat (which
 * does not follow the entry), follow only existing symlink ancestors to prove
 * they still resolve to directories, then recheck every observation. Any
 * unexpected entry, permission failure, non-directory, or detected race fails
 * closed as read-failed.
 */
function isGenuinelyAbsentCredentialPath(path: string): boolean {
  const missing: string[] = [];
  let cursor = path;
  let anchor:
    | { path: string; lstat: Stats; target?: Stats }
    | undefined;

  while (true) {
    try {
      const entry = lstatSync(cursor);
      if (cursor === path) return false;
      let target: Stats | undefined;
      if (entry.isSymbolicLink()) {
        try {
          target = statSync(cursor);
        } catch {
          return false;
        }
        if (!target.isDirectory()) return false;
      } else if (!entry.isDirectory()) {
        return false;
      }
      anchor = {
        path: cursor,
        lstat: entry,
        ...(target ? { target } : {}),
      };
      break;
    } catch (error) {
      if (!isFilesystemErrorCode(error, "ENOENT")) return false;
      missing.push(cursor);
      const parent = dirname(cursor);
      if (parent === cursor) return false;
      cursor = parent;
    }
  }

  // Bias races closed: the supporting directory entry must be unchanged and
  // every component observed missing must still be missing.
  try {
    const currentAnchor = lstatSync(anchor.path);
    if (
      currentAnchor.dev !== anchor.lstat.dev ||
      currentAnchor.ino !== anchor.lstat.ino ||
      currentAnchor.isDirectory() !== anchor.lstat.isDirectory() ||
      currentAnchor.isSymbolicLink() !== anchor.lstat.isSymbolicLink()
    ) {
      return false;
    }
    if (currentAnchor.isSymbolicLink()) {
      const currentTarget = statSync(anchor.path);
      if (
        !currentTarget.isDirectory() ||
        !anchor.target ||
        currentTarget.dev !== anchor.target.dev ||
        currentTarget.ino !== anchor.target.ino
      ) {
        return false;
      }
    }
  } catch {
    return false;
  }
  for (const missingPath of missing) {
    try {
      lstatSync(missingPath);
      return false;
    } catch (error) {
      if (!isFilesystemErrorCode(error, "ENOENT")) return false;
    }
  }
  return true;
}

function isFilesystemErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}
