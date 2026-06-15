import {
  createChatChannelPlugin,
  createChannelPluginBase,
} from "openclaw/plugin-sdk/channel-core";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";

import { CLAWCHANNEL_ID, ANON_PEER_ID } from "./transport.js";
import type { ClawChannelTransport } from "./transport.js";

type ResolvedAccount = {
  accountId: string | null;
  allowFrom: string[];
  dmPolicy: string | undefined;
};

// `createChatChannelPlugin`'s `base` param requires a non-optional `capabilities`,
// but `createChannelPluginBase`'s return type weakens it to optional
// (CreatedChannelPluginBase makes capabilities Partial). We pass capabilities in,
// so at runtime it is present; this alias documents the SDK type mismatch we cast
// around. Verified: dist/plugin-sdk/core-HhTaqQ72.d.ts:142 (CreatedChannelPluginBase
// optional capabilities) vs :169/:228 (ChatChannelPluginBase requires capabilities).
type ChatChannelBaseParam = Parameters<
  typeof createChatChannelPlugin<ResolvedAccount>
>[0]["base"];

function resolveAccount(
  cfg: OpenClawConfig,
  accountId?: string | null,
): ResolvedAccount {
  const section = (cfg.channels as Record<string, any>)?.[CLAWCHANNEL_ID];
  return {
    accountId: accountId ?? null,
    allowFrom: section?.allowFrom ?? [],
    dmPolicy: section?.dmSecurity,
  };
}

/**
 * Build the ClawChannel ChannelPlugin.
 *
 * Outbound is the load-bearing seam for Phase 0: when the agent replies, core
 * calls `outbound.sendText(ctx)` for this channel, and we forward the text to
 * the browser over the live WebSocket via the transport's session map.
 *
 * The `attachedResults` form returns `Omit<OutboundDeliveryResult, "channel">`,
 * i.e. `{ messageId }`. The `attachedResults.channel` field is required by the
 * SDK type (the acme-chat doc example omits it, but the .d.ts requires it).
 * Verified: dist/plugin-sdk/core-HhTaqQ72.d.ts:211-219 (ChatChannelAttachedOutboundOptions)
 * and dist/plugin-sdk/outbound.types-BEZiz165.d.ts:105-127 (ChannelOutboundContext).
 */
export function createClawChannelPlugin(transport: ClawChannelTransport) {
  return createChatChannelPlugin<ResolvedAccount>({
    base: createChannelPluginBase<ResolvedAccount>({
      id: CLAWCHANNEL_ID,
      // `capabilities` is required on ChannelPlugin (verified:
      // dist/types.plugin-BIHyhl5u.d.ts:22). One web chat surface => direct chats.
      capabilities: { chatTypes: ["direct"], media: false },
      // NOTE: account resolution lives on `config` (ChannelConfigAdapter), NOT on
      // `setup` (ChannelSetupAdapter, which is for config writes). The acme-chat
      // doc example placed resolveAccount/inspectAccount under `setup`, which does
      // not match the real types. Verified:
      // dist/types.adapters-B6PMXit1.d.ts:127 (ChannelConfigAdapter) and
      // dist/types.plugin-BIHyhl5u.d.ts:33-35 (config required, setup optional).
      config: {
        listAccountIds: () => [],
        resolveAccount,
        inspectAccount: (_cfg: OpenClawConfig, _accountId?: string | null) => {
          // Phase 0: no token/auth required (loopback dev). Always "configured".
          // TODO(auth): Phase 1 per-user token — reflect real config state here.
          return { enabled: true, configured: true, tokenStatus: "available" };
        },
      },
      // `setup` (ChannelSetupAdapter) is required by CreateChannelPluginBaseOptions
      // and owns config writes during the setup wizard. Phase 0 has no wizard, so
      // applyAccountConfig is a no-op pass-through. Verified:
      // dist/types.adapters-B6PMXit1.d.ts:104 (applyAccountConfig required).
      // TODO(setup): Phase 1 — real setup wizard for allowlist/token config.
      setup: {
        applyAccountConfig: ({ cfg }) => cfg,
      },
    }) as ChatChannelBaseParam,

    // DM security: who may message the bot. Phase 0 uses config allowlist only.
    security: {
      dm: {
        channelKey: CLAWCHANNEL_ID,
        resolvePolicy: (account) => account.dmPolicy,
        resolveAllowFrom: (account) => account.allowFrom,
        defaultPolicy: "allowlist",
      },
    },

    // Top-level reply threading is fine for a single web chat surface.
    threading: { topLevelReplyToMode: "reply" },

    outbound: {
      attachedResults: {
        channel: CLAWCHANNEL_ID,
        sendText: async (ctx) => {
          // Phase 0: the inbound round-trip delivers replies through the turn's
          // `delivery.deliver` adapter (see src/inbound.ts), NOT here. This
          // outbound seam only fires for core-initiated sends. `ctx.to` is the
          // recorded peer id (we record `web-anon`), so try an exact map lookup
          // first, then fall back to the single open socket since Phase 0 has
          // exactly one anonymous connection.
          // TODO(session): Phase 1 — `ctx.to` becomes a real per-peer id that
          // always matches a mapped session; drop the single-socket fallback.
          const sessionKey = ctx.to || ANON_PEER_ID;
          if (!transport.sendText(sessionKey, ctx.text)) {
            transport.sendTextToAnyOpen(ctx.text);
          }
          return { messageId: `clawchannel-${Date.now()}` };
        },
      },
      // No media in Phase 0. `deliveryMode` is required on the outbound base
      // (verified: dist/plugin-sdk/outbound.types-BEZiz165.d.ts:204). We deliver
      // directly over our own WebSocket, so "direct".
      base: { deliveryMode: "direct" },
    },
  });
}
