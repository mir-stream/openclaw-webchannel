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

import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import {
  loadSessionStore,
  resolveSessionStoreEntry,
  resolveStorePath,
} from "openclaw/plugin-sdk/session-store-runtime";

/** Injectable session-store seam for deterministic privacy-boundary tests. */
export type ReasoningOptOutStoreAccess = {
  resolveStorePath: typeof resolveStorePath;
  loadSessionStore: typeof loadSessionStore;
  resolveSessionStoreEntry: typeof resolveSessionStoreEntry;
};

const DEFAULT_STORE_ACCESS: ReasoningOptOutStoreAccess = {
  resolveStorePath,
  loadSessionStore,
  resolveSessionStoreEntry,
};

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
    const store = access.loadSessionStore(storePath, { skipCache: true });
    const level = access.resolveSessionStoreEntry({
      store,
      sessionKey: params.sessionKey,
    }).existing?.reasoningLevel;
    return level === "off";
  } catch {
    return true;
  }
}
