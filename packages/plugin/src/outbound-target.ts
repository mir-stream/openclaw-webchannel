/**
 * Core-initiated outbound targeting: the `messaging` adapter (#402) and its
 * outbound session route (#403). These cover `openclaw message send`, the
 * agent `message` tool and cron. The Telegram counterpart is the `messaging`
 * block in extensions/telegram `channel.ts` with `normalize.ts`/`targets.ts`.
 *
 * Grammar. A target is one peer id, optionally behind `webchannel:` and then
 * `user:`. The prefixes are case-insensitive, as Telegram's are. The peer is
 * the authenticated JWT `sub` and is case-sensitive (#372), so it is never
 * folded. ':' cannot occur in a valid peer token, so stripping is unambiguous.
 * The normalized form is the bare peer: inbound records `From`/`To` as the
 * bare peer, so an explicit target and a recorded route name one recipient.
 *
 * Admission. A Telegram bot can only message chats that started it. Likewise
 * only a peer holding a conversation key under THIS account's (tenant,
 * account) tuple is addressable, i.e. a user who registered at least once.
 * The key document is read from disk rather than from the live runtime,
 * because `openclaw message send` resolves its target in the CLI process,
 * where no account runtime exists. Whether the peer is reachable right now is
 * the send's business (`nats-channel.ts`); this module only decides who may be
 * named.
 *
 * Session. The route uses session-route.ts's builder with the account's
 * serving tenant, so proactive and cron text is mirrored into the peer's own
 * `:peer-v2` session instead of core's fallback key, which is
 * `agent:<id>:main` under the default dmScope and tenant-less and lowercased
 * otherwise. The key's agent is the SENDING agent core passes in, as in
 * Telegram: it records what that agent said. If a binding routes the peer's
 * inbound to another agent, outbound lands in the sender's peer session, not
 * the bound agent's; core rebases only for the same agent either way.
 *
 * Reserved words. As in Telegram, `current`, `self`, `this` and `me` are
 * reserved. Pinned core (2026.7.1-2) does not resolve them to the current
 * conversation; it refuses them as literal destinations ("Reserved target").
 * Core's raw-literal check intentionally permits typed forms such as
 * `user:<word>`, so the resolver repeats the check after plugin normalization.
 * A peer whose id is one of them therefore cannot be targeted explicitly.
 */

import type {
  ChannelMessagingAdapter,
  ChannelOutboundSessionRoute,
} from "openclaw/plugin-sdk/core";

import { WEBCHANNEL_ID } from "./channel-contract.js";
import { ConversationKeyStore } from "./conversation-key-store.js";
import { planWebchannelAccount } from "./multiplex.js";
import { resolveOutboundAccountId } from "./outbound-account.js";
import { buildWebchannelPeerSessionKey } from "./session-route.js";
import { isValidSubjectToken } from "./subject-token.js";

/** The (tenant, storage) tuple an account serves under. */
export type OutboundServingScope = { tenant: string; storageRoot?: string };

/**
 * Live serving scope of a running account. The serving tenant is immutable
 * for a runtime's lifetime (see session-route.ts), so a live runtime's scope
 * wins over the current config. Without one (the CLI), the config plan is the
 * only authority.
 */
export type ResolveServingScope = (accountId: string) => OutboundServingScope | undefined;

const PROVIDER_PREFIX = new RegExp(`^${WEBCHANNEL_ID}:`, "i");
const USER_PREFIX = /^user:/i;
const RESERVED_LITERALS = ["current", "self", "this", "me"];

/** Accept `peer`, `webchannel:peer`, `user:peer` and `webchannel:user:peer`. */
export function normalizeWebchannelTarget(raw: string): string | undefined {
  const peerId = raw.trim().replace(PROVIDER_PREFIX, "").trim().replace(USER_PREFIX, "").trim();
  return isValidSubjectToken(peerId) ? peerId : undefined;
}

/**
 * The bare peer a send surface delivers to. Core normally hands over the
 * normalized target, but a recorded or legacy route can still carry a prefix.
 */
export function requireOutboundPeerId(to: string): string {
  const peerId = normalizeWebchannelTarget(to);
  if (peerId === undefined) {
    throw new Error(`[webchannel] outbound target ${JSON.stringify(to)} is not a valid peer id`);
  }
  return peerId;
}

/** Resolve the account and fail unless `peerId` has registered with it. */
function requireRegisteredPeer(
  cfg: unknown,
  accountId: string | null | undefined,
  peerId: string,
  resolveServingScope?: ResolveServingScope,
): { accountId: string; tenant: string } {
  const id = resolveOutboundAccountId(cfg, accountId);
  const scope = resolveServingScope?.(id) ?? planServingScope(cfg, id);
  let registered: boolean;
  try {
    registered = new ConversationKeyStore({
      tenant: scope.tenant,
      accountId: id,
      ...(scope.storageRoot !== undefined ? { storageRoot: scope.storageRoot } : {}),
    }).hasDurableKey(peerId);
  } catch (error) {
    throw new Error(
      `[webchannel] cannot resolve target ${JSON.stringify(peerId)} for account ` +
        `${JSON.stringify(id)}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (!registered) {
    throw new Error(
      `[webchannel] unknown target ${JSON.stringify(peerId)} for account ${JSON.stringify(id)}: ` +
        "only a peer that has registered with this account can be messaged",
    );
  }
  return { accountId: id, tenant: scope.tenant };
}

function planServingScope(cfg: unknown, accountId: string): OutboundServingScope {
  // Acquisition-env deprecation warnings belong to the serving lifecycle.
  const plan = planWebchannelAccount(cfg, accountId, { warn: () => {} });
  if (!plan) {
    throw new Error(`[webchannel] outbound account ${JSON.stringify(accountId)} is not served`);
  }
  return {
    tenant: plan.tenant,
    ...(plan.storageRoot !== undefined ? { storageRoot: plan.storageRoot } : {}),
  };
}

/** The `messaging` adapter for core-initiated sends. */
export function createWebchannelMessagingAdapter(
  resolveServingScope?: ResolveServingScope,
): ChannelMessagingAdapter {
  return {
    targetPrefixes: [WEBCHANNEL_ID],
    normalizeTarget: normalizeWebchannelTarget,
    // Every target is a direct chat with one peer.
    inferTargetChatType: () => "direct",
    targetResolver: {
      looksLikeId: (raw) => normalizeWebchannelTarget(raw) !== undefined,
      hint: "<peerId>",
      reservedLiterals: RESERVED_LITERALS,
      // Core keeps a normalized id-like target when this returns null, so an
      // unregistered or normalized reserved peer must throw to be rejected
      // rather than sent blind.
      resolveTarget: async ({ cfg, accountId, input, normalized }) => {
        const peerId = normalizeWebchannelTarget(normalized) ?? normalizeWebchannelTarget(input);
        if (peerId === undefined) return null;
        if (RESERVED_LITERALS.includes(peerId.toLowerCase())) {
          throw new Error(`[webchannel] reserved target ${JSON.stringify(peerId)} cannot be addressed explicitly`);
        }
        requireRegisteredPeer(cfg, accountId, peerId, resolveServingScope);
        return { to: peerId, kind: "user", display: peerId, source: "normalized" };
      },
    },
    resolveOutboundSessionRoute: ({ cfg, agentId, accountId, target }): ChannelOutboundSessionRoute | null => {
      const peerId = normalizeWebchannelTarget(target);
      if (peerId === undefined) return null;
      const scope = requireRegisteredPeer(cfg, accountId, peerId, resolveServingScope);
      const sessionKey = buildWebchannelPeerSessionKey({
        cfg,
        agentId,
        accountId: scope.accountId,
        peerId,
        servingTenant: scope.tenant,
      });
      return {
        sessionKey,
        baseSessionKey: sessionKey,
        // `true` would let core rebase this route onto its own key whenever a
        // binding overrides dmScope, but inbound ignores that override and
        // keeps the forced peer scope. This route is plugin-keyed and never
        // the agent main session, which is what "delivery-identity" asserts.
        recipientSessionExact: "delivery-identity",
        peer: { kind: "direct", id: peerId },
        chatType: "direct",
        from: peerId,
        to: peerId,
      };
    },
  };
}
