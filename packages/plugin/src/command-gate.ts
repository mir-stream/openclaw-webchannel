/**
 * Command-authorization gate mirror — WIDGET UX FEEDBACK ONLY.
 *
 * WHY THIS EXISTS
 * ---------------
 * P1-8a's `/stop` reaches core's fast-abort by stamping
 * `access.commands.authorized` on the control-lane turn context (see
 * `inbound.ts` buildContext + `control-lane.ts`). That stamp is what core's
 * `resolveCommandSenderAuthorization` consults — BUT ONLY on its default path.
 * When an operator configures a commands allowlist (or an owner allowlist),
 * core IGNORES our stamp entirely and decides purely by membership: a peer who
 * is NOT in the list gets `handled:false` from fast-abort, the abort falls
 * through to a normal turn, races the running turn, and is dropped as busy. The
 * turn is NOT aborted and the widget gets ZERO feedback — its Stop button sits
 * silently inert. This module lets the plugin DETECT that configuration so the
 * caller can send a hedged "Stop may not be permitted" notice to the peer.
 *
 * This is a BEST-EFFORT MIRROR for UX only. Core remains the sole authority: we
 * still always dispatch the abort (core decides whether it takes effect). A
 * mismatch between this mirror and core can only ever change whether the hedged
 * NOTICE is shown, never whether the abort happens. The mirror is deliberately
 * biased toward showing the notice (a false "not listed" merely produces an
 * extra hedged notice; the harm we avoid is the opposite — suppressing the
 * notice when the abort really did silently fail).
 *
 * TRACED CORE PATHS (node_modules/openclaw/dist/command-auth-DskH_Lgk.js)
 * ----------------------------------------------------------------------
 * `resolveCommandSenderAuthorization` (line 283) is the decision:
 *   1. `if (enforceOwnerForCommands && !isOwnerForCommands) return false;`
 *      — `enforceOwnerForCommands` is the PLUGIN flag
 *      (`plugin.commands.enforceOwnerForCommands`); webchannel's plugin does not
 *      set `commands`, so this is always false for us and never gates.
 *   2. `if (commandsAllowFromList !== null || providerResolutionError &&
 *      commandsAllowFromConfigured) { ... return commandsAllowAll ||
 *      matchedCommandsAllowFrom; }` — the STAMP IS IGNORED here; membership of
 *      the sender's candidates in `commandsAllowFromList` decides.
 *   3. `return commandAuthorized && (isOwnerForCommands || nativeCommandAuthorized);`
 *      — the default path where our stamp (`commandAuthorized === true`) is
 *      honored, PROVIDED `isOwnerForCommands` is true. `isOwnerForCommands`
 *      (line 398) collapses to `true` UNLESS an owner allowlist is configured
 *      (`requireOwner`), in which case a non-owner sender yields false and the
 *      stamp is again neutralized.
 *
 * So core IGNORES our stamp when EITHER:
 *   (A) a commands allowFrom list resolves for this channel
 *       (`commandsAllowFromList !== null`, `resolveCommandsAllowFromList` line
 *       221), OR
 *   (B) an owner allowlist is configured (`cfg.commands.ownerAllowFrom`,
 *       `resolveOwnerAllowFromList` line 190 → `ownerAllowlistConfigured` →
 *       `requireOwner` line 397).
 * We treat the `providerResolutionError` sub-clause of (A) as inapplicable: our
 * control-lane turns always stamp `Provider = "webchannel"` (inbound.ts
 * buildContext), so core resolves the provider cleanly and never takes that
 * error branch.
 *
 * CONFIG PATHS that feed those lists (both are GLOBAL `cfg.commands`, NOT
 * per-channel or per-account blocks — verified in the dist):
 *   - (A) `cfg.commands.allowFrom` is a MAP keyed by channel id (or "*"):
 *     `resolveCommandsAllowFromList` (line 221-235) reads
 *     `commandsAllowFrom[providerId] ?? commandsAllowFrom["*"]` where
 *     `providerId === "webchannel"`. There is NO
 *     `channels.webchannel.commands.allowFrom` path — that shape is never read.
 *   - (B) `cfg.commands.ownerAllowFrom` is a flat list; entries may be bare or
 *     `channel:remainder`-prefixed (line 197-206 strips a matching channel
 *     prefix, drops a non-matching one).
 * `accountId` does not currently change either lookup (core keys commands config
 * by channel, and webchannel's plugin defines no `config.formatAllowFrom`, so
 * `accountId` never reaches normalization). It is accepted for symmetry with the
 * other per-account resolvers and to stay correct if core gains per-account
 * commands config.
 *
 * CANDIDATE / ENTRY NORMALIZATION
 * -------------------------------
 * Core normalizes BOTH the allowFrom list entries AND the sender candidates
 * through `formatAllowFromList` (line 88). webchannel's plugin exposes no
 * `config.formatAllowFrom`, so that falls back to `normalizeStringEntries`
 * (string-normalization dist): coerce to string, TRIM, drop empty — no
 * lowercasing, no channel prefix. `resolveSenderCandidates` (line 293) pushes
 * `SenderId` first; for our turns that is the peerId verbatim (inbound.ts sets
 * `sender.id = wsKey`), and NO `webchannel:`-prefixed candidate form is ever
 * synthesized. So membership is an EXACT, case-sensitive, trimmed match of the
 * peerId against the trimmed list entries, plus the `"*"` wildcard.
 */

/** Core resolves `commands.allowFrom` by the channel's provider id. */
const WEBCHANNEL_PROVIDER_ID = "webchannel";

/**
 * Structural view of the only config we read. Kept loose (not the full
 * `OpenClawConfig`) so the mirror is a pure function over plain data and its
 * tests need no config-builder scaffolding.
 */
export type CommandGateConfig = {
  commands?: {
    allowFrom?: unknown;
    ownerAllowFrom?: unknown;
  };
};

export type CommandGate = {
  /**
   * True when core will IGNORE our `access.commands.authorized` stamp because a
   * commands allowlist (A) and/or an owner allowlist (B) is configured. When
   * false, the stamp path governs and a webchannel peer's `/stop` is authorized
   * — no notice is warranted.
   */
  delegated: boolean;
  /**
   * Best-effort mirror of whether core would authorize THIS peer's command via
   * the configured list(s). Only meaningful when `delegated` is true. Biased
   * toward `false` (show the notice) on any ambiguity.
   */
  isListed: (peerId: string) => boolean;
};

/** `normalizeStringEntries` mirror: coerce, trim, drop empty. No lowercasing. */
function normalizeEntries(raw: readonly unknown[]): string[] {
  const out: string[] = [];
  for (const entry of raw) {
    const trimmed = String(entry ?? "").trim();
    if (trimmed) out.push(trimmed);
  }
  return out;
}

/** A trimmed list authorizes a trimmed peer via the `"*"` wildcard or an exact match. */
function listAllowsPeer(list: readonly string[], peer: string): boolean {
  if (list.some((entry) => entry === "*")) return true;
  return peer.length > 0 && list.includes(peer);
}

/**
 * Resolve the commands allowFrom list for the webchannel channel, mirroring
 * `resolveCommandsAllowFromList` (dist line 221): the per-provider array wins,
 * else the `"*"` array, else `null` (not configured for us). An EMPTY array is
 * returned as `[]` (non-null) — core treats that as "configured, matches no one".
 */
function resolveCommandsAllowFromList(cfg: CommandGateConfig): string[] | null {
  const allowFrom = cfg.commands?.allowFrom;
  if (!allowFrom || typeof allowFrom !== "object" || Array.isArray(allowFrom)) return null;
  const map = allowFrom as Record<string, unknown>;
  const providerList = map[WEBCHANNEL_PROVIDER_ID];
  const globalList = map["*"];
  const raw = Array.isArray(providerList)
    ? providerList
    : Array.isArray(globalList)
      ? globalList
      : null;
  return raw === null ? null : normalizeEntries(raw);
}

/**
 * Resolve the owner allowFrom list as it applies to webchannel, mirroring
 * `resolveOwnerAllowFromList` (dist line 190): keep bare entries; for a
 * `channel:remainder` entry, keep `remainder` when the channel is webchannel and
 * drop it otherwise. Returns `null` when no owner allowlist is configured.
 *
 * Conservative divergence: core uses `normalizeAnyChannelId` to decide whether
 * the token before the first colon IS a channel id, and KEEPS the whole entry if
 * it is not (e.g. a bare id that legitimately contains a colon). We instead treat
 * any `x:rest` as channel-prefixed and drop it unless `x === "webchannel"`. That
 * can only DROP an entry core would keep → `isListed` may return false where core
 * returns true → an extra hedged notice, never a suppressed one (the safe
 * direction). webchannel peerIds are server-derived and do not contain colons, so
 * this divergence does not affect real webchannel owner entries.
 */
function resolveOwnerAllowFromList(cfg: CommandGateConfig): string[] | null {
  const raw = cfg.commands?.ownerAllowFrom;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const filtered: string[] = [];
  for (const entry of raw) {
    const trimmed = String(entry ?? "").trim();
    if (!trimmed) continue;
    const sep = trimmed.indexOf(":");
    if (sep > 0) {
      const channel = trimmed.slice(0, sep).trim().toLowerCase();
      if (channel !== WEBCHANNEL_PROVIDER_ID) continue;
      const remainder = trimmed.slice(sep + 1).trim();
      if (remainder) filtered.push(remainder);
      continue;
    }
    filtered.push(trimmed);
  }
  return normalizeEntries(filtered);
}

/**
 * Build the command gate for one account. PURE over `{ cfg, accountId }`, so the
 * caller resolves it ONCE per account (it never varies per message) and reuses it
 * for every abort. See the module doc for the traced core paths this mirrors.
 */
export function resolveCommandGate(cfg: CommandGateConfig, _accountId: string): CommandGate {
  const commandsList = resolveCommandsAllowFromList(cfg);
  const ownerList = resolveOwnerAllowFromList(cfg);
  const delegated = commandsList !== null || ownerList !== null;
  return {
    delegated,
    isListed: (peerId: string): boolean => {
      const peer = peerId.trim();
      // Core short-circuits: when a commands allowFrom list resolves, branch (A)
      // decides on THAT list alone and the owner path is never consulted. Only
      // when no commands list is configured does the owner allowlist govern.
      if (commandsList !== null) return listAllowsPeer(commandsList, peer);
      if (ownerList !== null) return listAllowsPeer(ownerList, peer);
      // Not delegated — the stamp path authorizes the peer; value is unused by
      // the caller (it only reads `isListed` when `delegated`).
      return true;
    },
  };
}
