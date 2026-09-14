/**
 * WebChannel owns core session isolation: agent selection uses the raw peer,
 * then the public routing SDK builds a per-account-channel-peer session key.
 * Telegram's conversation-route.ts uses the same resolve/rebuild seams. Unlike
 * its numeric sender IDs, our authenticated JWT sub is case-sensitive ASCII.
 * Hex expresses every accepted byte without losing case during core's fold.
 *
 * The immutable serving tenant remains a separate SHA-256 scope. The final
 * :peer-v2 marker makes this namespace disjoint from ALL previous tenant-scoped
 * keys, even ones whose configured identityLinks name imitated an encoded peer:
 * every old key ended in :tenant:<64 hex>, whereas every new key ends :peer-v2.
 * No old core context is adopted. Journal history and wire/store identities
 * continue to use the raw peer. See docs/SESSION_IDENTITY.md for the transition.
 *
 * Inbound dispatch is the production derivation site. Dispatch, last-route and
 * stop must use its returned key; journal history does not derive a core key.
 */

import { createHash } from "node:crypto";

import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-core";
import {
  buildAgentSessionKey,
  deriveLastRoutePolicy,
  type ResolvedAgentRoute,
} from "openclaw/plugin-sdk/routing";

import { WEBCHANNEL_ID } from "./channel-contract.js";
import { assertValidSubjectToken } from "./subject-token.js";

/** Enforced independently of the gateway's global DM scope. */
export const WEBCHANNEL_ENFORCED_DM_SCOPE = "per-account-channel-peer" as const;

function scopeToken(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Keep SDK identityLinks matching (raw/scoped IDs, case folding, first match).
 * The SDK has no standalone link resolver, so ask its key builder to select a
 * unique marker for each nonblank canonical name. Compare SDK-built keys rather
 * than parsing a private format or reproducing the link matcher. ':' cannot
 * occur in a validated raw peer, so an unlinked peer cannot impersonate a marker.
 *
 * Only an explicit matching link enters the l: namespace. Canonical names keep
 * the SDK's trim/lowercase equivalence and use a full digest because operator
 * names have no peer-length bound. Unlinked peers use injective ASCII hex in
 * the separate p: namespace, including peers named like a canonical identity.
 */
function sessionPeerId(
  channel: string,
  peerId: string,
  identityLinks: Record<string, string[]> | undefined,
): string {
  if (identityLinks) {
    const probe = {
      agentId: "main",
      channel,
      dmScope: "per-peer" as const,
    };
    const canonicalByKey = new Map<string, string>();
    const markedLinks = Object.fromEntries(
      Object.entries(identityLinks)
        .filter(([canonical]) => canonical.trim())
        .map(([canonical, ids], index) => {
          const marker = `link:${index}`;
          const key = buildAgentSessionKey({
            ...probe,
            peer: { kind: "direct", id: marker },
          });
          canonicalByKey.set(key, canonical);
          return [marker, ids];
        }),
    );
    const selectedKey = buildAgentSessionKey({
      ...probe,
      peer: { kind: "direct", id: peerId },
      identityLinks: markedLinks,
    });
    const canonical = canonicalByKey.get(selectedKey);
    if (canonical !== undefined) {
      return `l:${scopeToken(canonical.trim().toLowerCase())}`;
    }
  }
  return `p:${Buffer.from(peerId, "ascii").toString("hex")}`;
}

/** Resolve bindings with the raw identity; encode only the core session peer. */
export function resolveWebchannelSessionRoute(
  api: OpenClawPluginApi,
  accountId: string,
  peerId: string,
  servingTenant: string,
): ResolvedAgentRoute {
  assertValidSubjectToken(peerId, "peerId");
  assertValidSubjectToken(servingTenant, "tenant");
  const route = api.runtime.channel.routing.resolveAgentRoute({
    cfg: api.config,
    channel: WEBCHANNEL_ID,
    accountId,
    peer: { kind: "direct", id: peerId },
  });

  const baseSessionKey = buildAgentSessionKey({
    agentId: route.agentId,
    channel: route.channel,
    accountId: route.accountId,
    peer: {
      kind: "direct",
      id: sessionPeerId(route.channel, peerId, api.config.session?.identityLinks),
    },
    dmScope: WEBCHANNEL_ENFORCED_DM_SCOPE,
  });

  // Never re-resolve the tenant from config/env: admission and NATS remain
  // bound to the immutable tenant captured by this account's serving plan.
  const sessionKey = `${baseSessionKey}:tenant:${scopeToken(servingTenant)}:peer-v2`;
  return {
    ...route,
    sessionKey,
    lastRoutePolicy: deriveLastRoutePolicy({ sessionKey, mainSessionKey: route.mainSessionKey }),
  };
}
