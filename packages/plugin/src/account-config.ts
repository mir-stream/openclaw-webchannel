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
 * accountId flows into filesystem paths (`~/.openclaw-webchannel/<account>/…`),
 * so it MUST be validated/canonicalized before any `path.join`. We reuse core's
 * canonicalization rules and additionally HARD-REJECT a non-conforming id at the
 * path boundary so a traversal sequence (`../../evil`) can never escape the root.
 */

import { homedir } from "node:os";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { WebchannelNatsConfig } from "./nats-credential-source.js";
import type { KeyPair } from "./e2e-crypto.js";

/** The single default account id (mirrors core's `"default"`). */
export const DEFAULT_WEBCHANNEL_ACCOUNT_ID = "default";

/**
 * Strict account-id shape accepted at the filesystem trust boundary. Matches the
 * brief's `^[A-Za-z0-9_-]{1,64}$`; intentionally stricter than core's lenient
 * canonicalizer (no leading-dash / dot / slash) so a path component can never
 * contain `.`/`/`/`\`.
 */
const STRICT_ACCOUNT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Object keys that must never be used as account ids (prototype pollution). */
const BLOCKED_ACCOUNT_IDS = new Set(["__proto__", "prototype", "constructor"]);

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
        reason: BLOCKED_ACCOUNT_IDS.has(id.toLowerCase())
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
  if (!canonical || BLOCKED_ACCOUNT_IDS.has(canonical)) return DEFAULT_WEBCHANNEL_ACCOUNT_ID;
  return canonical;
}

/** True when `id` is a safe account id for use as a filesystem path component. */
export function isValidAccountId(id: string): boolean {
  return typeof id === "string" && STRICT_ACCOUNT_ID_RE.test(id) && !BLOCKED_ACCOUNT_IDS.has(id.toLowerCase());
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
 * Per-account credential path: `~/.openclaw-webchannel/<account>/credentials.json`.
 * Validates `accountId` (rejects traversal) BEFORE the join.
 */
export function accountCredentialPath(
  accountId: string,
  home: string = homedir(),
): string {
  assertValidAccountId(accountId);
  return join(credentialsRootDir(home), accountId, "credentials.json");
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
 * Resolve the credential path to READ for an account.
 *
 * This always returns the account-scoped path. The legacy single-file location
 * is migration/cleanup-only and is deliberately never a read fallback.
 *
 * `assertValidAccountId` runs first (via `accountCredentialPath`).
 */
export function resolveReadCredentialPath(
  accountId: string,
  opts: { home?: string; exists?: (p: string) => boolean } = {},
): string {
  const home = opts.home ?? homedir();
  return accountCredentialPath(accountId, home);
}

/**
 * Persisted enrolled NATS credentials (the subset `gateway run` consumes).
 * Mirrors the `enrollment.creds` block of the on-disk `PluginCredentials`.
 */
export type PersistedEnrolledCreds = {
  userJwt: string;
  userSeed: string;
  /**
   * NATS relay URL the SaaS delivered alongside the creds (EnrollmentResult.natsUrl,
   * persisted under `enrollment.natsUrl`). The SaaS is the rendezvous authority, so
   * the consume path dials THIS in preference to any local `nats.url` /
   * `WEBCHANNEL_NATS_URL`. Absent for creds enrolled before this field existed —
   * the consumer then falls back to the resolver URL (back-compat).
   */
  natsUrl?: string;
  /**
   * Bootstrap-JWT issuer the SaaS delivered alongside the creds
   * (EnrollmentResult.issuer, persisted under `enrollment.issuer`). Same
   * rendezvous-authority principle as `natsUrl`: the SaaS declares the exact
   * `iss` it mints, so the runtime verifies against THIS instead of deriving
   * issuer = saas.baseUrl and hoping the two agree. Precedence: operator pin
   * (`auth.jwt.issuer`) > this delivered value > derived. Absent for creds
   * enrolled before this field existed — the runtime then derives (back-compat).
   * Used VERBATIM (verify already compares slash-insensitively).
   */
  issuer?: string;
  /**
   * F2 — the agent's SaaS-attested static X25519 identity key pair, read from the
   * top-level `identityKey.{publicKey,privateKey}` (base64url) that
   * `enrollment-client.ts` persists in the SAME `credentials.json`. The register
   * (keyStore) path wraps the conversation key under THIS so the browser can
   * authenticate K against the SaaS-pinned agent public key. Absent for creds
   * enrolled before this field existed or a malformed key block — the register-hop
   * account then fail-closed skips serving (index-nats), while auto/open/static
   * accounts (which never wrap K) are unaffected.
   */
  identityKey?: KeyPair;
};

/**
 * Load the persisted enrolled creds for an account (CONSUME-only path — 가-1).
 *
 * Reads the account-scoped credential file and returns its `enrollment.creds`.
 * The legacy single-file path is never consulted. Returns `undefined` when the
 * file is absent, unreadable, malformed, or has no enrollment block — the
 * runtime treats that as "creds missing" and applies account-scoped graceful
 * degradation (it never enrolls at runtime). Validates `accountId` first.
 *
 * The fs seams are injectable for tests.
 */
export function loadPersistedEnrolledCreds(
  accountId: string,
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
      identityKey?: { publicKey?: unknown; privateKey?: unknown };
      enrollment?: {
        creds?: { userJwt?: unknown; userSeed?: unknown };
        natsUrl?: unknown;
        issuer?: unknown;
      };
    };
    const creds = parsed.enrollment?.creds;
    if (
      creds &&
      typeof creds.userJwt === "string" &&
      typeof creds.userSeed === "string" &&
      creds.userJwt.length > 0 &&
      creds.userSeed.length > 0
    ) {
      // Thread the SaaS-delivered relay URL + issuer through when present. Kept
      // optional so already-persisted (pre-natsUrl / pre-issuer) creds still
      // load and fall back gracefully.
      const natsUrl = parsed.enrollment?.natsUrl;
      const issuer = parsed.enrollment?.issuer;
      // F2: decode the agent identity key pair (top-level, base64url). Only
      // surfaced when BOTH halves decode to exactly 32 bytes — a partial or
      // malformed block is treated as absent so the register-hop account
      // fail-closed skips serving rather than wrapping under a bad key.
      const identityKey = parseIdentityKey(parsed.identityKey);
      return {
        userJwt: creds.userJwt,
        userSeed: creds.userSeed,
        ...(typeof natsUrl === "string" && natsUrl.length > 0 ? { natsUrl } : {}),
        ...(typeof issuer === "string" && issuer.length > 0 ? { issuer } : {}),
        ...(identityKey ? { identityKey } : {}),
      };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * F2 — decode a persisted `identityKey.{publicKey,privateKey}` (base64url) into a
 * raw-bytes `KeyPair`. Returns `undefined` unless BOTH halves are present and
 * decode to exactly 32 bytes (an X25519 key), so a malformed/partial block is
 * treated as "no identity key" (fail-closed downstream) rather than surfacing a
 * bad key into the wrap path.
 */
function parseIdentityKey(
  raw: { publicKey?: unknown; privateKey?: unknown } | undefined,
): KeyPair | undefined {
  if (!raw || typeof raw.publicKey !== "string" || typeof raw.privateKey !== "string") {
    return undefined;
  }
  try {
    const publicKey = new Uint8Array(Buffer.from(raw.publicKey, "base64url"));
    const privateKey = new Uint8Array(Buffer.from(raw.privateKey, "base64url"));
    if (publicKey.length !== 32 || privateKey.length !== 32) return undefined;
    return { publicKey, privateKey };
  } catch {
    return undefined;
  }
}
