/**
 * Webchannel session-key derivation — FORCED per-user isolation (Option A).
 *
 * ── Why webchannel overrides the global dmScope ─────────────────────────────
 * openclaw's `session.dmScope` defaults to `"main"`, which collapses EVERY
 * direct peer onto the SAME agent session (`agent:<id>:main`). For a single-user
 * channel that is fine, but webchannel's register-hop mode serves MANY users
 * (one peerId per authenticated user uuid) on one account. Under `"main"` all of
 * them share one transcript, so the register-time history snapshot and
 * `load_history` re-seal OTHER USERS' messages to each requester's own
 * conversation key — a cross-user transcript leak that per-peer E2E encryption
 * cannot prevent, because the leak happens BEFORE sealing, at session scoping.
 *
 * Rather than depend on the operator setting a safe global `session.dmScope`,
 * webchannel FORCES its own inbound session scope — exactly as the two blessed
 * in-tree multi-user channels do:
 *   - Telegram: `resolveTelegramConversationBaseSessionKey` rebuilds the key with
 *     a hardcoded `dmScope: "per-account-channel-peer"`
 *     (dist `bot-*.js`, buildAgentSessionKey({ …, dmScope: "per-account-channel-peer" })).
 *   - Synology chat: `buildSynologyChatInboundSessionKey` always uses
 *     `per-account-channel-peer` (dist `channel-*.js`).
 * Both pass `cfg.session?.identityLinks` through so the forced key matches what
 * `resolveAgentRoute` itself would derive under that scope; we do the same.
 *
 * We use `"per-account-channel-peer"` (not `"per-channel-peer"`) because a single
 * user uuid can span MULTIPLE webchannel accounts in the multiplex deployment —
 * `per-channel-peer` alone would let two accounts' sessions for the same peerId
 * collide. `per-account-channel-peer` keys on `channel:accountId:direct:peerId`,
 * isolating both by account AND by peer.
 *
 * ── The crux: ONE key everywhere ────────────────────────────────────────────
 * Webchannel derives a session key at several sites — the inbound turn dispatch
 * (WRITE), the register-time history snapshot (READ), and the `load_history`
 * pagination handler (READ). If any one of them derived a DIFFERENT key, history
 * would silently break (empty) or leak. Every one of those sites MUST route
 * through this ONE helper so the key is byte-identical.
 *
 * The helper keeps the binding-based AGENT routing from `resolveAgentRoute`
 * (a `binding.account` may pick a specific agentId) and ONLY overrides the
 * session key, mirroring telegram/synology (which likewise leave the route's
 * `agentId`/`mainSessionKey` alone and rebuild only the peer session key). We
 * re-derive `lastRoutePolicy` from the new key so the returned route stays
 * internally consistent (`deriveLastRoutePolicy`: sessionKey === mainSessionKey
 * ? "main" : "session") — a forced per-peer key is never the main key, so this
 * is always `"session"`. Webchannel itself only reads `sessionKey`, but keeping
 * the route non-contradictory avoids a latent trap for any future consumer.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-core";
import {
  buildAgentSessionKey,
  type ResolvedAgentRoute,
} from "openclaw/plugin-sdk/routing";

import { WEBCHANNEL_ID } from "./channel-contract.js";

/**
 * The DM scope webchannel FORCES for its own inbound session-key derivation,
 * regardless of the operator's global `session.dmScope`. Matches telegram/synology.
 */
export const WEBCHANNEL_ENFORCED_DM_SCOPE = "per-account-channel-peer" as const;

/**
 * Resolve the webchannel agent route for `accountId`/`peerId`, then FORCE the
 * session key to the per-account-channel-peer scope (see the module docstring).
 * The returned route is the SAME shape as `resolveAgentRoute`'s, with only
 * `sessionKey` (and the derived `lastRoutePolicy`) overridden — binding-based
 * agent selection, `agentId`, `channel`, `accountId`, and `mainSessionKey` are
 * preserved verbatim.
 *
 * ALL webchannel session-key sites (inbound dispatch, history snapshot,
 * load_history) call THIS so the key is identical everywhere.
 */
export function resolveWebchannelSessionRoute(
  api: OpenClawPluginApi,
  accountId: string,
  peerId: string,
): ResolvedAgentRoute {
  const route = api.runtime.channel.routing.resolveAgentRoute({
    cfg: api.config,
    channel: WEBCHANNEL_ID,
    accountId,
    peer: { kind: "direct", id: peerId },
  });

  // Rebuild ONLY the session key with the forced scope. Preserve the resolved
  // agentId/channel/accountId (a binding may have picked a specific agent) and
  // pass identityLinks through exactly as telegram/synology do, so the forced
  // key matches what resolveAgentRoute would derive under this scope.
  const sessionKey = buildAgentSessionKey({
    agentId: route.agentId,
    channel: route.channel,
    accountId: route.accountId,
    peer: { kind: "direct", id: peerId },
    dmScope: WEBCHANNEL_ENFORCED_DM_SCOPE,
    identityLinks: api.config.session?.identityLinks,
  });

  return {
    ...route,
    sessionKey,
    // deriveLastRoutePolicy(sessionKey, mainSessionKey): a forced per-peer key is
    // never the agent's main key, so this is "session" — keep the route truthful
    // rather than half-overriding and leaving a "main" policy behind.
    lastRoutePolicy: sessionKey === route.mainSessionKey ? "main" : "session",
  };
}
