/**
 * Webchannel reasoning display-policy resolution — CHANNEL-OWNED, Telegram parity.
 *
 * ── Why the channel owns this gate ──────────────────────────────────────────
 * OpenClaw's plugin dispatch path forwards `onReasoningStream` with NO
 * reasoning-level gate of its own: the ACP runner always emits a full-text
 * snapshot (`isReasoningSnapshot: true`, verified: dist/run-attempt-DRhLt3eF.js
 * :4114-4117) and the btw runner emits cumulative full text whenever the
 * resolved level is not "off" — i.e. it also emits at level "on" (verified:
 * dist/btw-CDO5476N.js:617-627). The dispatch layer wraps the callback only in
 * abort/source-delivery gating (dist/dispatch-B2e1grFo.js:1658-1710). So WHETHER
 * a channel shows reasoning to its client is the CHANNEL's decision, exactly as
 * the two other reference channels implement it.
 *
 * Telegram is the reference: it streams its reasoning draft only when the
 * resolved level is "stream" (dist/bot-Dxj27QDQ.js:6441) and suppresses at "off"
 * (:6582). We mirror `resolveTelegramReasoningLevel` (:6029-6044) and
 * `resolveTelegramConfigReasoningDefault` (:5211-5214) exactly:
 *   - if a sessionKey exists, read the session-store entry's `reasoningLevel`;
 *     when it is "on"/"stream"/"off" it WINS over config;
 *   - a store-read THROW returns "off" (fail-closed — never leak reasoning when
 *     the store cannot be trusted);
 *   - otherwise fall back to the config default: the matching `agents.list` entry's
 *     `reasoningDefault`, else `agents.defaults.reasoningDefault`, else "off".
 *
 * The webchannel lane is wired ONLY when this resolves to "stream" (see
 * inbound.ts). Default is therefore "off" — no ambient reasoning ever reaches the
 * browser unless the operator/session explicitly set the level to "stream".
 */

import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import {
  resolveStorePath,
  loadSessionStore,
  resolveSessionStoreEntry,
} from "openclaw/plugin-sdk/session-store-runtime";

/** The three levels a session/config may resolve to; anything else is treated as its raw string. */
export type ResolvedReasoningLevel = string;

/**
 * Injectable session-store access seam. Defaults to the real plugin-sdk
 * functions; unit tests inject fakes. Verified signatures (OpenClaw v2026.6.x):
 *  - resolveStorePath(store?, { agentId? }): string
 *      dist/plugin-sdk/sessions-C99VWO-T.d.ts:44
 *  - loadSessionStore(storePath, { skipCache? }): Record<string, SessionEntry>
 *      dist/plugin-sdk/session-accessor-DAKXqqth.d.ts:60
 *  - resolveSessionStoreEntry({ store, sessionKey }): { existing?: SessionEntry }
 *      dist/plugin-sdk/session-accessor-DAKXqqth.d.ts:63; SessionEntry.reasoningLevel?: string
 *      dist/plugin-sdk/types-CUUb7tbP.d.ts:237.
 */
export type ReasoningStoreAccess = {
  resolveStorePath: typeof resolveStorePath;
  loadSessionStore: typeof loadSessionStore;
  resolveSessionStoreEntry: typeof resolveSessionStoreEntry;
};

const DEFAULT_STORE_ACCESS: ReasoningStoreAccess = {
  resolveStorePath,
  loadSessionStore,
  resolveSessionStoreEntry,
};

/** Matches Telegram's `normalizeAgentId` (dist/bot-Dxj27QDQ.js:5207-5209). */
const DEFAULT_AGENT_ID = "main";
function normalizeAgentId(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase() || DEFAULT_AGENT_ID;
}

/**
 * The config-default half, mirroring `resolveTelegramConfigReasoningDefault`
 * (dist/bot-Dxj27QDQ.js:5211-5214): the matching `agents.list` entry's
 * `reasoningDefault`, else `agents.defaults.reasoningDefault`, else "off".
 */
function resolveConfigReasoningDefault(
  cfg: OpenClawConfig,
  agentId: string,
): ResolvedReasoningLevel {
  const id = normalizeAgentId(agentId);
  // Narrowed local view of the fields we read (verified shape:
  // dist/plugin-sdk/types.openclaw-CXiJ86ZN.d.ts:492 reasoningDefault).
  const agents = (cfg as {
    agents?: {
      list?: ReadonlyArray<{ id?: string; reasoningDefault?: string } | undefined>;
      defaults?: { reasoningDefault?: string };
    };
  }).agents;
  return (
    agents?.list?.find((entry) => normalizeAgentId(entry?.id) === id)?.reasoningDefault ??
    agents?.defaults?.reasoningDefault ??
    "off"
  );
}

/**
 * Resolve the reasoning display level for a webchannel turn, mirroring
 * `resolveTelegramReasoningLevel` (dist/bot-Dxj27QDQ.js:6029-6044). Session-store
 * level wins; a store-read throw is fail-closed to "off"; otherwise the config
 * default applies. The caller (inbound.ts) wires the reasoning lane only when
 * this returns "stream".
 */
export function resolveWebchannelReasoningLevel(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
  store?: ReasoningStoreAccess;
}): ResolvedReasoningLevel {
  const { cfg, agentId, sessionKey } = params;
  const access = params.store ?? DEFAULT_STORE_ACCESS;
  const configDefault = resolveConfigReasoningDefault(cfg, agentId);
  if (!sessionKey) return configDefault;
  try {
    const storePath = access.resolveStorePath(cfg.session?.store, { agentId });
    const store = access.loadSessionStore(storePath, { skipCache: true });
    const level = access.resolveSessionStoreEntry({ store, sessionKey }).existing
      ?.reasoningLevel;
    if (level === "on" || level === "stream" || level === "off") return level;
  } catch {
    // Fail-closed: a store read we cannot trust must never leak reasoning.
    return "off";
  }
  return configDefault;
}
