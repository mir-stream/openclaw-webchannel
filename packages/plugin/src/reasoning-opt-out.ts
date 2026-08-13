/**
 * Preserve an explicit per-session `/reasoning off` as a privacy veto.
 *
 * This deliberately does NOT resolve the effective reasoning mode and does not
 * read `agents.*.reasoningDefault`: core forces that config-derived mode to
 * `off` for the ordinary unauthorized browser peer, while the channel-private
 * capability must still be able to open the lane. Only a persisted, explicit
 * session value of `off` closes it here. An unreadable store also closes it,
 * because the plugin cannot rule out that explicit opt-out.
 */

import { readFileSync } from "node:fs";

import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import {
  resolveSessionStoreEntry,
  resolveStorePath,
} from "openclaw/plugin-sdk/session-store-runtime";

type SessionStoreSnapshot = Parameters<typeof resolveSessionStoreEntry>[0]["store"];

/**
 * Injectable raw-snapshot seam for deterministic privacy-boundary tests.
 *
 * Do not substitute core's `loadSessionStore` here. The pinned loader converts
 * parse and terminal read failures (including EACCES/EPERM) into `{}`, which is
 * indistinguishable from a genuinely absent opt-out and therefore fails open.
 */
export type ReasoningOptOutStoreAccess = {
  resolveStorePath: typeof resolveStorePath;
  readFile: (storePath: string) => string;
  resolveSessionStoreEntry: typeof resolveSessionStoreEntry;
};

const DEFAULT_STORE_ACCESS: ReasoningOptOutStoreAccess = {
  resolveStorePath,
  readFile: (storePath) => readFileSync(storePath, "utf8"),
  resolveSessionStoreEntry,
};

function isErrorCode(error: unknown, code: string): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

/**
 * Read exactly one fail-aware snapshot. ENOENT is the only benign read failure:
 * it means no session has persisted an opt-out yet. Every other read/parse/shape
 * failure returns `undefined`, which the caller interprets as a privacy veto.
 */
function readVerifiedSessionStore(
  storePath: string,
  access: ReasoningOptOutStoreAccess,
): SessionStoreSnapshot | undefined {
  let raw: string;
  try {
    raw = access.readFile(storePath);
  } catch (error) {
    return isErrorCode(error, "ENOENT") ? {} : undefined;
  }

  if (raw.trim().length === 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      Object.values(parsed).some(
        (entry) => entry === null || typeof entry !== "object" || Array.isArray(entry),
      )
    ) {
      return undefined;
    }
    return parsed as SessionStoreSnapshot;
  } catch {
    return undefined;
  }
}

export function hasExplicitSessionReasoningOptOut(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
  store?: ReasoningOptOutStoreAccess;
}): boolean {
  if (!params.sessionKey) return false;
  const access = params.store ?? DEFAULT_STORE_ACCESS;
  try {
    const storePath = access.resolveStorePath(params.cfg.session?.store, {
      agentId: params.agentId,
    });
    const store = readVerifiedSessionStore(storePath, access);
    if (!store) return true;
    // Resolve aliases from THIS verified snapshot. A second loader call here
    // would reopen a TOCTOU window and, on the pinned core, swallow read errors.
    const level = access.resolveSessionStoreEntry({
      store,
      sessionKey: params.sessionKey,
    }).existing?.reasoningLevel;
    return level === "off";
  } catch {
    return true;
  }
}
