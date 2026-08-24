import {
  createChatChannelPlugin,
  createChannelPluginBase,
} from "openclaw/plugin-sdk/channel-core";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import type { ChannelDoctorAdapter, ChannelStatusAdapter } from "openclaw/plugin-sdk/channel-contract";

import { WEBCHANNEL_ID } from "./channel-contract.js";
import type { WebChannelPeerChannel } from "./channel-contract.js";
import { createClawMessageAdapter, nextMessageId } from "./message-adapter.js";
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
// approval bootstrap (verified at 2026.7.1-2). We
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
// Contract: both helpers are exported by `openclaw/plugin-sdk/channel-core`; the
// required `base` shape is derived below from `createChatChannelPlugin`'s public
// parameter type rather than naming an internal declaration.
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
 * Contract: `createChatChannelPlugin` is exported by
 * `openclaw/plugin-sdk/channel-core`, and `ChannelOutboundContext` is exported
 * by `openclaw/plugin-sdk/channel-contract`.
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
    // omit `message`) because the public `createChatChannelPlugin` `base`
    // parameter DOES carry `message`. It COEXISTS with the legacy `outbound`
    // block; the bundled SMS channel shipped both at 2026.7.1-2. See
    // src/message-adapter.ts for why core does not auto-drive
    // `message.live` for plugin channels and how drafts fire via the inbound
    // turn's reply callbacks instead.
    base: asWebchannelChatBase(Object.assign(withRequiredCapabilities(createChannelPluginBase<ResolvedAccount>({
      id: WEBCHANNEL_ID,
      // Channel-presentation metadata (`ChannelMeta`, exported by
      // `openclaw/plugin-sdk/channel-contract`). `createChannelPluginBase` merges
      // this into `plugin.meta`, which the pinned core (2026.7.1-2) reads at
      // registration (`normalizeRegisteredChannelPlugin` →
      // `collectMissingChannelMetaFields`). WebChannel is not a bundled core
      // channel, so `resolveSdkChatChannelMeta("webchannel")` returns nothing:
      // without these four fields core fills defaults and emits an "incomplete
      // metadata" diagnostic on EVERY gateway boot. Supplying them stops that
      // per-boot diagnostic and gives the operator's channel picker real
      // presentation copy. Values are owner-approved — do not reword.
      //
      // The same four values also live in `package.json` → `openclaw.channel`.
      // Core's `toChannelMeta()` reads all four from that block, defaulting
      // `selectionLabel` to `label` and `docsPath` to `/channels/<id>` when
      // absent, so the block is not limited to `id`/`label`/`blurb`. It is how
      // the channel presents itself on surfaces where the plugin bundle is not
      // loaded. An omission there therefore does not defer to runtime meta; it
      // ships a second, different presentation of the same channel. Both
      // surfaces must carry the same four values; `entry-exports.test.ts`
      // cross-asserts them. See #170.
      meta: {
        label: "WebChannel",
        selectionLabel: "WebChannel (self-hosted web chat)",
        docsPath: "https://github.com/mir-stream/openclaw-webchannel#readme",
        blurb: "Self-hosted, end-to-end encrypted browser chat over NATS.",
      },
      // Contract: `ChannelPlugin`, exported by
      // `openclaw/plugin-sdk/channel-runtime`, requires `capabilities`. One web
      // chat surface => direct chats.
      capabilities: { chatTypes: ["direct"], media: false },
      // NOTE: account resolution lives on `config` (ChannelConfigAdapter), NOT on
      // `setup` (ChannelSetupAdapter, which is for config writes). The acme-chat
      // doc example placed resolveAccount/inspectAccount under `setup`, which does
      // not match the real types. Contract: `ChannelConfigAdapter`,
      // `ChannelSetupAdapter`, and `ChannelPlugin` are exported by
      // `openclaw/plugin-sdk/channel-runtime` (`config` required, `setup` optional).
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
      // outbound/security/message). The public `createChatChannelPlugin` base
      // contract includes it, and the helper carries that base field into the
      // returned plugin (runtime behavior verified at 2026.7.1-2). Attaching it
      // here therefore flows through by the same mechanism as the `message`
      // adapter. The HITL native runtime delivers approval prompts over our
      // WebSocket; see src/approvals.ts.
      approvalCapability: createClawApprovalCapability(
        transport,
        opts?.resolveApprovalTransport,
      ),
      // `gateway.startAccount` is the monitor core's channel runtime starts per
      // account. We use it solely to register the `approval.native` runtime
      // context (which arms the native approval handler) and then stay alive for
      // the channel's lifetime. `gateway` is a top-level ChannelPlugin field that
      // the public `createChatChannelPlugin` base contract preserves, so it flows
      // through the same way `message`/`approvalCapability` do.
      // Contract: `ChannelGatewayAdapter` is exported by
      // `openclaw/plugin-sdk/channel-runtime`.
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
          // #238: ONE id, minted before the send, put on the wire AND reported
          // back to core. This seam used to fabricate `webchannel-${Date.now()}`
          // for core's receipt while sending the frame id-less, so core's
          // receipt id and the client's bubble id were two different names for
          // the same message (and the fabricated one was millisecond-collision
          // prone). Mint order matters: the id must exist before the send, and a
          // failed send still throws exactly as before.
          const id = nextMessageId();
          if (!transport.sendText(ctx.to, ctx.text, id)) {
            throw new Error(
              `[webchannel] outbound send failed: targeted send returned false for peer ${ctx.to}`,
            );
          }
          return { messageId: id };
        },
      },
      // No media in Phase 0. `deliveryMode` is required on the outbound base
      // (`ChannelOutboundAdapter`, exported by
      // `openclaw/plugin-sdk/channel-contract`). We deliver directly over our
      // own WebSocket, so "direct".
      //
      // GATE 2: `shouldSuppressLocalPayloadPrompt` lets us drop the in-band
      // `/approve …` text once the native approval route is live (core passes
      // `hint.nativeRouteActive === true`). Without this, native widget buttons
      // AND the slash-command text would both appear. The hook is part of the
      // `ChannelOutboundAdapter` contract exported by
      // `openclaw/plugin-sdk/channel-contract`. We delegate to the
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
