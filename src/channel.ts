import {
  createChatChannelPlugin,
  createChannelPluginBase,
} from "openclaw/plugin-sdk/channel-core";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";

import { CLAWCHANNEL_ID, ANON_PEER_ID } from "./transport.js";
import type { ClawChannelTransport } from "./transport.js";
import { createClawMessageAdapter } from "./message-adapter.js";
import {
  createClawApprovalCapability,
  startClawApprovalMonitor,
  shouldSuppressClawNativeExecApprovalPrompt,
} from "./approvals.js";

// Single default account id for Phase 1. `listAccountIds` MUST return ≥1 entry
// and the plugin MUST expose `gateway.startAccount`, otherwise core's channel
// monitor (`startChannelInternal`) short-circuits and never starts the native
// approval bootstrap (dist/server-channels-g1oRRKIH.js:330-331, :339-341). We
// register the `approval.native` runtime context from that monitor; see
// startClawApprovalMonitor in src/approvals.ts.
const DEFAULT_ACCOUNT_ID = "default";

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
    // `message` (ChannelMessageAdapter) declares our outbound text send plus the
    // `live` progress-draft capabilities. It is attached on the base object here
    // (rather than passed into `createChannelPluginBase`, whose typed options
    // omit `message`: core-HhTaqQ72.d.ts:124-141) because `ChatChannelPluginBase`
    // = Omit<ChannelPlugin,...> & Partial<...> DOES carry `message`
    // (core-HhTaqQ72.d.ts:169). It COEXISTS with the legacy `outbound` block
    // below — the bundled SMS channel ships both (dist/extensions/sms/
    // channel-plugin-api.js:1242 attaches `message` while also defining
    // `outbound`). See src/message-adapter.ts for why core does not auto-drive
    // `message.live` for plugin channels and how drafts fire via the inbound
    // turn's reply callbacks instead.
    base: Object.assign(createChannelPluginBase<ResolvedAccount>({
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
        // Must be non-empty so core's channel monitor actually runs the
        // start-account task (and thus the native approval bootstrap). A single
        // default account models our one web surface.
        listAccountIds: () => [DEFAULT_ACCOUNT_ID],
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
    }), {
      message: createClawMessageAdapter(transport),
      // `approvalCapability` is a top-level ChannelPlugin field (sibling of
      // outbound/security/message). `createChatChannelPlugin` spreads `base`
      // into the returned plugin (dist/core-DSxVv-v1.js:255-266) and
      // `ChatChannelPluginBase` does NOT omit `approvalCapability`
      // (core-HhTaqQ72.d.ts:169), so attaching it here flows through — same
      // mechanism the `message` adapter uses. The HITL native runtime delivers
      // approval prompts over our WebSocket; see src/approvals.ts.
      approvalCapability: createClawApprovalCapability(transport),
      // `gateway.startAccount` is the monitor core's channel runtime starts per
      // account. We use it solely to register the `approval.native` runtime
      // context (which arms the native approval handler) and then stay alive for
      // the channel's lifetime. `gateway` is a top-level ChannelPlugin field that
      // ChatChannelPluginBase does NOT omit (core-HhTaqQ72.d.ts:169), so it flows
      // through the same way `message`/`approvalCapability` do.
      // ChannelGatewayAdapter.startAccount signature verified:
      // dist/plugin-sdk/types.adapters-BRNttHis.d.ts:330-331.
      gateway: {
        startAccount: (ctx: any) => startClawApprovalMonitor(ctx),
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
      //
      // GATE 2: `shouldSuppressLocalPayloadPrompt` lets us drop the in-band
      // `/approve …` text once the native approval route is live (core passes
      // `hint.nativeRouteActive === true`). Without this, native widget buttons
      // AND the slash-command text would both appear. Hook verified:
      // dist/plugin-sdk/outbound.types-BEZiz165.d.ts:227-232. We delegate to the
      // SDK helper via shouldSuppressClawNativeExecApprovalPrompt (src/approvals.ts).
      base: {
        deliveryMode: "direct",
        shouldSuppressLocalPayloadPrompt: ({ cfg, accountId, payload, hint }) =>
          shouldSuppressClawNativeExecApprovalPrompt({
            cfg,
            accountId,
            payload,
            hint,
          }),
      },
    },
  });
}
