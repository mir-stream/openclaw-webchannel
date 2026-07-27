import {
  createChatChannelPlugin,
  createChannelPluginBase,
} from "openclaw/plugin-sdk/channel-core";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import type { ChannelDoctorAdapter, ChannelStatusAdapter } from "openclaw/plugin-sdk/channel-contract";

import { WEBCHANNEL_ID } from "./channel-contract.js";
import type { WebChannelPeerChannel } from "./channel-contract.js";
import { createClawMessageAdapter } from "./message-adapter.js";
import {
  createClawApprovalCapability,
  startClawApprovalMonitor,
  shouldSuppressClawNativeExecApprovalPrompt,
} from "./approvals.js";
import type { ResolveAccountTransport } from "./approvals.js";
import {
  DEFAULT_WEBCHANNEL_ACCOUNT_ID as ACCOUNT_CONFIG_DEFAULT_WEBCHANNEL_ACCOUNT_ID,
  hasWebchannelConfig,
  inspectWebchannelAccountIds,
  isWebchannelAccountEnabled,
  listWebchannelAccountIds,
  readAccountsMap,
  readWebchannelSection,
  resolveWebchannelAccountConfig,
} from "./account-config.js";
import { webchannelSetup } from "./setup.js";
import { webchannelSetupWizard } from "./setup-wizard.js";
import {
  createWebchannelDoctorAdapter,
  createWebchannelStatusAdapter,
  type WebchannelProbe,
} from "./doctor.js";

// Single default account id for Phase 1. `listAccountIds` MUST return ≥1 entry
// and the plugin MUST expose `gateway.startAccount`, otherwise core's channel
// monitor (`startChannelInternal`) short-circuits and never starts the native
// approval bootstrap (dist/server-channels-g1oRRKIH.js:330-331, :339-341). We
// register the `approval.native` runtime context from that monitor; see
// startClawApprovalMonitor in src/approvals.ts.
//
// Exported so src/approvals.ts can pass the same account id to the SDK's
// `createApproverRestrictedNativeApprovalCapability` (`listAccountIds`) without
// duplicating the literal. The channel→approvals import edge already exists, so
// approvals.ts reading this back adds no new module cycle (and it's only
// dereferenced at runtime inside createClawApprovalCapability, so ESM live
// bindings resolve it well after module evaluation).
export const DEFAULT_WEBCHANNEL_ACCOUNT_ID = ACCOUNT_CONFIG_DEFAULT_WEBCHANNEL_ACCOUNT_ID;

type ResolvedAccount = {
  accountId: string | null;
  enabled: boolean;
  allowFrom: string[];
  dmPolicy: string | undefined;
};

// `createChatChannelPlugin`'s `base` param requires a non-optional `capabilities`,
// but `createChannelPluginBase`'s return type weakens it to optional
// (CreatedChannelPluginBase makes capabilities Partial). We pass capabilities in,
// so at runtime it is present; the helper below documents the SDK type mismatch.
// Verified: dist/plugin-sdk/core-HhTaqQ72.d.ts:142 (CreatedChannelPluginBase
// optional capabilities) vs :169/:228 (ChatChannelPluginBase requires capabilities).
type WebchannelAdapters = {
  doctor: ChannelDoctorAdapter;
  status: ChannelStatusAdapter<ResolvedAccount, WebchannelProbe>;
};

type WebchannelChatBase = Parameters<
  typeof createChatChannelPlugin<ResolvedAccount, WebchannelProbe>
>[0]["base"];

function withRequiredCapabilities<T extends { capabilities?: unknown }>(
  value: T,
): T & { capabilities: Exclude<T["capabilities"], undefined> } {
  return value as T & { capabilities: Exclude<T["capabilities"], undefined> };
}

function asWebchannelChatBase<T>(value: T): T & WebchannelChatBase {
  return value as T & WebchannelChatBase;
}

function resolveAccount(
  cfg: OpenClawConfig,
  accountId?: string | null,
): ResolvedAccount {
  // 가-1: account-aware resolution. A flat (legacy single-account) config is
  // treated as the `"default"` account; a per-account config resolves the named
  // account's leaf fields. `resolveWebchannelAccountConfig` owns the shape
  // detection so a single-account deployment is a regression-free pass-through.
  const account = resolveWebchannelAccountConfig(
    cfg,
    accountId ?? DEFAULT_WEBCHANNEL_ACCOUNT_ID,
  );
  return {
    accountId: accountId ?? null,
    enabled: isWebchannelAccountEnabled(cfg, accountId),
    allowFrom: (account.allowFrom as string[] | undefined) ?? [],
    dmPolicy: account.dmSecurity as string | undefined,
  };
}

function isWebchannelAccountConfigured(
  cfg: OpenClawConfig,
  accountId?: string | null,
): boolean {
  const section = readWebchannelSection(cfg);
  if (!section || !hasWebchannelConfig(cfg)) return false;

  const id = accountId ?? DEFAULT_WEBCHANNEL_ACCOUNT_ID;
  const accounts = readAccountsMap(section);
  if (Object.keys(accounts).length > 0) {
    return listWebchannelAccountIds(cfg).includes(id);
  }

  // Flat configuration represents only the implicit default account. Structural
  // keys alone do not configure that account, and must not configure arbitrary
  // account ids synthesized by a caller.
  return id === DEFAULT_WEBCHANNEL_ACCOUNT_ID;
}

/**
 * Build the WebChannel ChannelPlugin.
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
export function createWebChannelPlugin(
  transport: WebChannelPeerChannel,
  opts?: {
    /**
     * S1 (accountId-aware approvals): resolve a specific account's transport
     * for native approval delivery/finalize. The NATS entry passes a resolver
     * over its per-account runtimes; the legacy single-transport WS entry omits
     * it and every account falls back to `transport` (unchanged behavior).
    */
    resolveApprovalTransport?: ResolveAccountTransport;
    startNatsAccount?: (ctx: any) => Promise<void>;
    onInvalidAccountId?: (cfg: OpenClawConfig, invalid: { id: string; reason: string }) => void;
  },
) {
  return createChatChannelPlugin<ResolvedAccount, WebchannelProbe>({
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
    base: asWebchannelChatBase(Object.assign(withRequiredCapabilities(createChannelPluginBase<ResolvedAccount>({
      id: WEBCHANNEL_ID,
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
        // 가-1: list the configured accounts. A flat (legacy) config yields the
        // single `"default"` account; a per-account config lists its children.
        // An implicit/flat configuration retains the synthesized `"default"`
        // account. An explicit accounts map whose keys are all invalid returns
        // `[]` fail-closed, so core starts no account task for those keys.
        listAccountIds: (cfg: OpenClawConfig) => {
          const inspection = inspectWebchannelAccountIds(cfg);
          for (const invalid of inspection.invalid) {
            try { opts?.onInvalidAccountId?.(cfg, invalid); } catch { /* enumeration is fail-safe */ }
          }
          return inspection.validIds;
        },
        resolveAccount,
        inspectAccount: (cfg: OpenClawConfig, accountId?: string | null) => {
          const configured = isWebchannelAccountConfigured(cfg, accountId);
          return {
            enabled: isWebchannelAccountEnabled(cfg, accountId),
            configured,
            tokenStatus: configured ? "available" : "missing",
          };
        },
        isEnabled: (account) => account.enabled,
        isConfigured: (account, cfg) =>
          isWebchannelAccountConfigured(cfg, account.accountId),
      },
      // `setup` (ChannelSetupAdapter) is required by CreateChannelPluginBaseOptions
      // and owns config writes for `openclaw channels add`. 가-1: this is where
      // config-time credential acquisition now lives (applyAccountConfig writes
      // the account, afterAccountConfigWritten runs the headless device-flow
      // enroll). See src/setup.ts.
      setup: webchannelSetup,
      // `setupWizard` (ChannelSetupWizard) drives the INTERACTIVE `channels add`
      // flow: bare `channels add` → prompt tenant/saasBaseUrl (+ advanced jwt
      // overrides) → finalize writes the full enroll-ready block. Forwarded onto
      // the plugin via createChannelPluginBase (openclaw core.ts:502/841/817).
      // See src/setup-wizard.ts.
      setupWizard: webchannelSetupWizard,
    })), {
      message: createClawMessageAdapter(transport),
      doctor: createWebchannelDoctorAdapter(),
      status: createWebchannelStatusAdapter(),
      // `approvalCapability` is a top-level ChannelPlugin field (sibling of
      // outbound/security/message). `createChatChannelPlugin` spreads `base`
      // into the returned plugin (dist/core-DSxVv-v1.js:255-266) and
      // `ChatChannelPluginBase` does NOT omit `approvalCapability`
      // (core-HhTaqQ72.d.ts:169), so attaching it here flows through — same
      // mechanism the `message` adapter uses. The HITL native runtime delivers
      // approval prompts over our WebSocket; see src/approvals.ts.
      approvalCapability: createClawApprovalCapability(
        transport,
        opts?.resolveApprovalTransport,
      ),
      // `gateway.startAccount` is the monitor core's channel runtime starts per
      // account. We use it solely to register the `approval.native` runtime
      // context (which arms the native approval handler) and then stay alive for
      // the channel's lifetime. `gateway` is a top-level ChannelPlugin field that
      // ChatChannelPluginBase does NOT omit (core-HhTaqQ72.d.ts:169), so it flows
      // through the same way `message`/`approvalCapability` do.
      // ChannelGatewayAdapter.startAccount signature verified:
      // dist/plugin-sdk/types.adapters-BRNttHis.d.ts:330-331.
      gateway: {
        startAccount: (ctx: any) => opts?.startNatsAccount
          ? composeAccountLifecycles(ctx, opts.startNatsAccount)
          : startClawApprovalMonitor(ctx),
      },
    } satisfies WebchannelAdapters & Record<string, unknown>)),

    // DM security: who may message the bot. Phase 0 uses config allowlist only.
    security: {
      dm: {
        channelKey: WEBCHANNEL_ID,
        resolvePolicy: (account) => account.dmPolicy,
        resolveAllowFrom: (account) => account.allowFrom,
        defaultPolicy: "allowlist",
      },
    },

    // Top-level reply threading is fine for a single web chat surface.
    threading: { topLevelReplyToMode: "reply" },

    outbound: {
      attachedResults: {
        channel: WEBCHANNEL_ID,
        sendText: async (ctx) => {
          // The inbound round-trip delivers replies through the turn's
          // `delivery.deliver` adapter (see src/inbound.ts), NOT here. This
          // outbound seam only fires for core-initiated (untargeted) sends.
          // `ctx.to` is the recorded reply target — now the REAL per-peer
          // `wsKey` (inbound.ts records `reply.to = wsKey`), so target it
          // directly. If it is absent or stale, throw so core observes a failed
          // outbound delivery; recipient guessing is intentionally unsupported.
          //
          // P0-4 (review R2): throwing is safe ONLY because core never re-sends a
          // thrown outbound — traced in openclaw 2026.6.10 (the installed version
          // and the floor of the `>=2026.6.10` peer range): core stamps
          // `send_attempt_started` immediately before calling us, and its durable
          // delivery drain refuses to blindly replay an entry in that state unless
          // the adapter supplies `reconcileUnknownSend` (we deliberately do not),
          // so the entry moves to failed instead. See the fuller trace in
          // `message-adapter.ts`. A core bump — or adding `reconcileUnknownSend` —
          // re-opens the blind-replay path → SILENT DUPLICATE DELIVERY.
          if (!ctx.to) {
            throw new Error("[webchannel] outbound send failed: ctx.to is absent");
          }
          if (!transport.sendText(ctx.to, ctx.text)) {
            throw new Error(
              `[webchannel] outbound send failed: targeted send returned false for peer ${ctx.to}`,
            );
          }
          return { messageId: `webchannel-${Date.now()}` };
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

/** Run approval and NATS account ownership as one host lifecycle. */
export async function composeAccountLifecycles(
  ctx: any,
  startNatsAccount: (ctx: any) => Promise<void>,
): Promise<void> {
  const child = new AbortController();
  let resolveHostAbort: (() => void) | undefined;
  const onHostAbort = () => {
    child.abort(ctx.abortSignal.reason);
    resolveHostAbort?.();
  };
  ctx.abortSignal.addEventListener("abort", onHostAbort, { once: true });
  if (ctx.abortSignal.aborted) onHostAbort();
  const childCtx = { ...ctx, abortSignal: child.signal };
  const approval = Promise.resolve().then(() => startClawApprovalMonitor(childCtx));
  const nats = Promise.resolve().then(() => startNatsAccount(childCtx));
  const tagged = <T>(name: string, promise: Promise<T>) => promise.then(
    () => ({ name, status: "fulfilled" as const }),
    (reason) => ({ name, status: "rejected" as const, reason }),
  );
  const hostAbort = new Promise<{ name: "host-abort"; status: "fulfilled" }>((resolve) => {
    resolveHostAbort = () => resolve({ name: "host-abort", status: "fulfilled" });
    if (ctx.abortSignal.aborted) resolveHostAbort();
  });
  try {
    const first = await Promise.race([tagged("approval", approval), tagged("nats", nats), hostAbort]);
    child.abort();
    await Promise.allSettled([approval, nats]);
    if (first.name === "host-abort") return;
    if (first.status === "rejected") throw first.reason;
    throw new Error(`webchannel: ${first.name} account lifecycle exited before host abort`);
  } finally {
    ctx.abortSignal.removeEventListener("abort", onHostAbort);
  }
}
