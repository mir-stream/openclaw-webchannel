import {
  createChannelApprovalNativeRuntimeAdapter,
  resolveApprovalOverGateway,
  // Runtime-context capability key channels register so core's approval
  // bootstrap starts the native handler. Re-exported from this barrel; the
  // canonical declaration is
  // dist/plugin-sdk/approval-handler-adapter-runtime-nCE8WKeq.d.ts:5
  // (`CHANNEL_APPROVAL_NATIVE_RUNTIME_CONTEXT_CAPABILITY = "approval.native"`).
  CHANNEL_APPROVAL_NATIVE_RUNTIME_CONTEXT_CAPABILITY,
} from "openclaw/plugin-sdk/approval-handler-runtime";
import type {
  PendingApprovalView,
  ApprovalActionView,
  ChannelApprovalNativeRuntimeSpec,
  ChannelApprovalNativeFinalAction,
} from "openclaw/plugin-sdk/approval-handler-runtime";
// Idiomatic helper that decides whether a channel-native exec approval route
// replaces (suppresses) the local in-band `/approve …` text prompt. Verified:
// dist/plugin-sdk/approval-native-helpers-Bqzi91B-.d.ts:189 (re-exported from
// the approval-native-runtime barrel). Its impl
// (dist/approval-native-helpers-WitYuyrm.js:26-59) returns true only when
// `hint.nativeRouteActive === true` (proof the native runtime handler is live)
// AND native delivery is enabled for our config.
import { shouldSuppressLocalNativeExecApprovalPrompt } from "openclaw/plugin-sdk/approval-native-runtime";
import { createChannelApprovalCapability } from "openclaw/plugin-sdk/approval-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
// `ChannelApprovalNativeAdapter` + `ChannelApprovalCapability` (the
// `nativeRuntime` field's erased type) are re-exported here, not from the
// approval-runtime barrel. Verified: dist/plugin-sdk/channel-runtime.d.ts:19.
import type {
  ChannelApprovalNativeAdapter,
  ChannelApprovalCapability,
  // `gateway.startAccount`'s context (carries cfg/accountId/abortSignal and the
  // task-scoped `channelRuntime` whose `runtimeContexts` registry the approval
  // bootstrap watches). Verified: dist/plugin-sdk/types.adapters-BRNttHis.d.ts:237
  // (re-exported from the channel-runtime barrel).
  ChannelGatewayContext,
  // Outbound payload hint core passes to `shouldSuppressLocalPayloadPrompt`; its
  // `nativeRouteActive` proves the native runtime handler is live. Verified:
  // dist/plugin-sdk/outbound.types-BEZiz165.d.ts:178-182.
  ChannelOutboundPayloadHint,
} from "openclaw/plugin-sdk/channel-runtime";

import { CLAWCHANNEL_ID, ANON_PEER_ID } from "./transport.js";
import type {
  ClawChannelTransport,
  ApprovalDecision,
  ApprovalOption,
  ApprovalRequestPayload,
} from "./transport.js";

/**
 * Native HITL approval capability for ClawChannel (Phase 1, slice 1-C).
 *
 * PATH: idiomatic `approvalCapability.nativeRuntime`. When a tool/exec needs
 * approval the agent run blocks and core surfaces an approval prompt; core's
 * channel-approval bootstrap (dist/server-channels-g1oRRKIH.js:429
 * `startChannelApprovalHandlerBootstrap`, which fires automatically for any
 * channel whose `config.isConfigured` is true and whose plugin exposes
 * `approvalCapability.nativeRuntime`) opens the operator approvals gateway
 * client and drives THIS adapter:
 *   - availability.{isConfigured,shouldHandle} gate whether we handle a request,
 *   - presentation.buildPendingPayload turns the SDK `PendingApprovalView` into
 *     our WS `approval_request` payload,
 *   - transport.prepareTarget/deliverPending emit the `approval_request` frame
 *     over our WebSocket (the "target" is just our single anon session),
 *   - presentation.buildResolvedResult / transport.updateEntry emit
 *     `approval_resolved` to finalize (disable buttons in the widget).
 *
 * The reverse direction (widget button click) is owned by us, NOT by the native
 * runtime: the widget sends `approval_decision`, the transport routes it to
 * `handleApprovalDecision` below, which calls the unified
 * `resolveApprovalOverGateway` (dist/plugin-sdk/approval-gateway-runtime-CxQ8cGa-.d.ts:5-16)
 * to resolve the exec/plugin approval over the gateway so the run continues.
 *
 * Verified SDK shapes:
 *  - ChannelApprovalNativeRuntimeSpec (presentation/transport/availability):
 *    dist/plugin-sdk/approval-handler-runtime-types-CL_Nb7hO.d.ts:476-502.
 *  - PendingApprovalView (approvalId, approvalKind, title, description,
 *    metadata[], expiresAtMs, actions: ApprovalActionView[]):
 *    same file :282-322; ApprovalActionView {decision,label,style,command} :246-252.
 *  - createChannelApprovalCapability({authorizeActorAction, nativeRuntime,
 *    native, ...}): dist/plugin-sdk/approval-delivery-helpers-xkx0jB6K.d.ts:81-92.
 *  - native adapter shape (describeDeliveryCapabilities/resolveOriginTarget):
 *    dist/plugin-sdk/approval-handler-runtime-types-CL_Nb7hO.d.ts:43-62; the
 *    delivery PLAN gates on describeDeliveryCapabilities().enabled +
 *    resolveOriginTarget (dist/approval-native-runtime-BKbmE99v.js:21-72).
 */

/**
 * Pending entry we hand back from `deliverPending`; we get it back in
 * `buildResolvedResult` / `transport.updateEntry` to finalize the widget card.
 */
type ClawApprovalEntry = {
  approvalId: string;
  sessionKey: string;
};

/** Final payload carried by `update` actions; the decision drives the widget. */
type ClawApprovalFinalPayload = {
  decision: ApprovalDecision;
};

/**
 * Compile-time assert that our local ApprovalDecision matches the SDK's
 * `ExecApprovalDecision` (the type `view.actions[].decision` and
 * `resolveApprovalOverGateway`'s `decision` use). If the SDK union ever drifts
 * this stops compiling. `ApprovalActionView["decision"]` is the SDK side.
 */
type _AssertDecisionInSync = ApprovalDecision extends ApprovalActionView["decision"]
  ? ApprovalActionView["decision"] extends ApprovalDecision
    ? true
    : never
  : never;
const _assertDecisionInSync: _AssertDecisionInSync = true;
void _assertDecisionInSync;

/** Read the channel's `execApprovals` block from config (account-agnostic Phase 1). */
function readExecApprovals(
  cfg: OpenClawConfig,
): { enabled?: boolean | "auto" } | undefined {
  const section = (cfg.channels as Record<string, any> | undefined)?.[
    CLAWCHANNEL_ID
  ];
  return section?.execApprovals;
}

/**
 * Native approvals are "on" when `execApprovals.enabled` is `true` or `"auto"`.
 * `false`/unset => off. We treat `"auto"` as on because this single-session web
 * surface is always able to render the prompt (unlike DM-routed channels which
 * gate `"auto"` on having a reachable approver).
 */
function isExecApprovalsEnabled(cfg: OpenClawConfig): boolean {
  const enabled = readExecApprovals(cfg)?.enabled;
  return enabled === true || enabled === "auto";
}

/**
 * Project a `PendingApprovalView` into our WS `approval_request` payload. We
 * only forward the offered decisions present in `view.actions` (the gateway
 * rejects decisions not offered), and deliberately DROP `action.command` (the
 * synthesized `/approve …` text) — we resolve via `resolveApprovalOverGateway`
 * keyed on `{approvalId, decision}`, never by replaying command text.
 */
export function buildApprovalRequestPayload(
  view: PendingApprovalView,
): ApprovalRequestPayload {
  const options: ApprovalOption[] = view.actions.map((action) => ({
    decision: action.decision,
    label: action.label,
    style: action.style,
  }));

  // Short one-liner for accessibility / non-button fallback. For exec we append
  // the command preview; for plugin the tool name (both already in the view).
  const detail =
    view.approvalKind === "exec"
      ? view.commandPreview || view.commandText
      : view.toolName || view.pluginId || "";
  const prompt = detail ? `${view.title}: ${detail}` : view.title;

  return {
    id: view.approvalId,
    kind: view.approvalKind,
    title: view.title,
    ...(view.description ? { description: view.description } : {}),
    prompt,
    options,
    expiresAtMs: view.expiresAtMs,
  };
}

/**
 * Build the strongly typed native runtime spec. `transport` is captured in the
 * closure so delivery/finalize go straight to our WebSocket session map — we do
 * not need the gateway-supplied `context` (which other channels use to reach a
 * platform client). The delivery "target" resolves to our single anon session.
 */
export function createClawApprovalNativeRuntimeSpec(
  transport: ClawChannelTransport,
): ChannelApprovalNativeRuntimeSpec<
  ApprovalRequestPayload, // TPendingPayload
  { sessionKey: string }, // TPreparedTarget
  ClawApprovalEntry, // TPendingEntry
  unknown, // TBinding (no interactive binding to clear; we own the widget card)
  ClawApprovalFinalPayload // TFinalPayload
> {
  return {
    // We can render BOTH exec and plugin approvals natively in the widget.
    eventKinds: ["exec", "plugin"],
    availability: {
      // Configured/should-handle both reduce to "execApprovals enabled". The
      // single web session is always able to present, so there is no per-request
      // routing gate (cf. DM channels that gate on a reachable approver).
      isConfigured: ({ cfg }) => isExecApprovalsEnabled(cfg),
      shouldHandle: ({ cfg }) => isExecApprovalsEnabled(cfg),
    },
    presentation: {
      // Turn the SDK view into our WS payload.
      buildPendingPayload: ({ view }) => buildApprovalRequestPayload(view),
      // On resolution, instruct an `update` carrying the decision; the transport
      // hook (updateEntry) emits `approval_resolved` to finalize the widget card.
      buildResolvedResult: ({
        view,
      }): ChannelApprovalNativeFinalAction<ClawApprovalFinalPayload> => ({
        kind: "update",
        payload: { decision: view.decision },
      }),
      // On expiry there is no decision; emit a denial-equivalent resolution so
      // the widget stops showing actionable buttons. We model expiry as "deny"
      // for the widget (no further action possible).
      buildExpiredResult: (): ChannelApprovalNativeFinalAction<ClawApprovalFinalPayload> => ({
        kind: "update",
        payload: { decision: "deny" },
      }),
    },
    transport: {
      // Our only target is the originating web session. Phase 0/1 maps every
      // connection to the single anon peer, so the prepared target is fixed.
      // TODO(auth): Phase 1 real approver identity once per-user auth lands —
      // derive the target session from the approval's origin peer instead.
      prepareTarget: () => ({
        dedupeKey: `${CLAWCHANNEL_ID}:${ANON_PEER_ID}`,
        target: { sessionKey: ANON_PEER_ID },
      }),
      // Emit the `approval_request` frame. Returning a non-null entry tells the
      // runtime the prompt was delivered; the entry is handed back on finalize.
      deliverPending: ({ preparedTarget, pendingPayload }) => {
        const sessionKey = preparedTarget.sessionKey;
        transport.sendApprovalRequest(sessionKey, pendingPayload);
        return { approvalId: pendingPayload.id, sessionKey };
      },
      // Finalize: emit `approval_resolved` so the widget disables buttons and
      // shows the outcome. Fires for both resolved and expired `update` actions.
      updateEntry: async ({ entry, payload }) => {
        transport.sendApprovalResolved(
          entry.sessionKey,
          entry.approvalId,
          payload.decision,
        );
      },
    },
  };
}

/**
 * Our `native` adapter. The core delivery plan
 * (dist/approval-native-runtime-BKbmE99v.js:21-72) gates on
 * `describeDeliveryCapabilities().enabled` and an origin target; we always
 * report a single origin surface pointing at the anon session so the plan
 * yields exactly one target (our web session). We do NOT use approver-DM
 * machinery (that depends on real approver identity, which `web-anon` lacks).
 */
function createClawApprovalNativeAdapter(): ChannelApprovalNativeAdapter {
  return {
    describeDeliveryCapabilities: ({ cfg }: { cfg: OpenClawConfig }) => ({
      enabled: isExecApprovalsEnabled(cfg),
      preferredSurface: "origin",
      supportsOriginSurface: true,
      supportsApproverDmSurface: false,
    }),
    resolveOriginTarget: () => ({ to: ANON_PEER_ID }),
  };
}

/**
 * Assemble the full `approvalCapability`. `authorizeActorAction` returns
 * `{authorized:true}` unconditionally: auth is OPEN in Phase 1 and there is a
 * single trusted local session (`web-anon`), which would NOT resolve against a
 * real `approvers` allowlist. We trust the local session so prompts are
 * presentable AND resolvable.
 * TODO(auth): Phase 1 real approver identity once per-user auth lands — replace
 * with a real per-user authorization check.
 */
export function createClawApprovalCapability(transport: ClawChannelTransport) {
  // `createChannelApprovalNativeRuntimeAdapter` returns a STRONGLY typed adapter
  // (our payload/entry generics), but the capability's `nativeRuntime` field is
  // the erased adapter (all generics `unknown`,
  // dist/plugin-sdk/types.adapters-BRNttHis.d.ts:604). The specific form is not
  // assignable to the erased one (hook params are contravariant in payload), so
  // we widen to the field type. This is purely a generic-erasure cast — core
  // calls the hooks with the exact runtime values we produce.
  const nativeRuntime = createChannelApprovalNativeRuntimeAdapter(
    createClawApprovalNativeRuntimeSpec(transport),
  ) as ChannelApprovalCapability["nativeRuntime"];

  return createChannelApprovalCapability({
    authorizeActorAction: () => ({ authorized: true }),
    nativeRuntime,
    native: createClawApprovalNativeAdapter(),
    // GATE 2 (suppress the in-band `/approve` text so the user sees ONLY native
    // buttons). These two hooks live on the CAPABILITY object, NOT on `native`
    // (the diagnostic mis-located them). Verified against the real d.ts:
    // dist/plugin-sdk/types.adapters-BRNttHis.d.ts:624-634 declares
    // `getActionAvailabilityState` and `getExecInitiatingSurfaceState` on
    // `ChannelApprovalCapability` (siblings of `authorizeActorAction`/`native`),
    // and the runtime reads them at the CAPABILITY level:
    // dist/exec-approval-surface-DEygHHf5.js:40-49
    // (`capability?.getExecInitiatingSurfaceState?.(...)` /
    // `capability?.getActionAvailabilityState?.(...)`), gated by
    // `hasNativeExecApprovalCapability` which requires `capability.native` AND at
    // least one of these hooks to exist (same file :15-18).
    //
    // Return value = `"enabled"` when our approvals are on. Why `"enabled"` and
    // not `"disabled"`/`"unsupported"`:
    //   - The three legal kinds are `{kind:"enabled"|"disabled"|"unsupported"}`
    //     (types.adapters-BRNttHis.d.ts:63-69).
    //   - These kinds do NOT themselves suppress the in-band text — they only
    //     change WHICH text core emits (verified end-to-end in
    //     dist/bash-tools-CIjH6l_2.js:594: `kind==="disabled"` =>
    //     unavailableReason `"initiating-platform-disabled"`, `"unsupported"` =>
    //     `"initiating-platform-unsupported"`, else `null`; each branch still
    //     produces text in `buildExecApprovalPendingToolResult` :718-741 /
    //     `buildExecApprovalUnavailableReplyPayload`
    //     exec-approval-reply-BXMsffTv.js:231-256). `"disabled"`/`"unsupported"`
    //     would emit a WORSE "approvals not configured/supported" message.
    //   - Actual text suppression is owned by `outbound.shouldSuppressLocalPayloadPrompt`
    //     keyed on `hint.nativeRouteActive` (see channel.ts +
    //     `shouldSuppressClawNativeExecApprovalPrompt` below). So we report
    //     `"enabled"` (we CAN present natively) and let the outbound suppressor
    //     drop the text once the native route is live.
    //
    // ALTERNATIVES (flip during live test if `"enabled"` still shows text):
    //   - If a future core build makes a specific `kind` suppress text directly,
    //     return `{kind:"unsupported"}` from getExecInitiatingSurfaceState to take
    //     the `initiating-platform-unsupported` branch — but only AFTER confirming
    //     the outbound suppressor is not the real lever in that build.
    getExecInitiatingSurfaceState: ({ cfg }: { cfg: OpenClawConfig }) =>
      isExecApprovalsEnabled(cfg)
        ? { kind: "enabled" as const }
        : { kind: "disabled" as const },
    getActionAvailabilityState: ({ cfg }: { cfg: OpenClawConfig }) =>
      isExecApprovalsEnabled(cfg)
        ? { kind: "enabled" as const }
        : { kind: "disabled" as const },
  });
}

/**
 * GATE 2 text suppressor. Wired from the channel's
 * `outbound.shouldSuppressLocalPayloadPrompt`
 * (dist/plugin-sdk/outbound.types-BEZiz165.d.ts:227-232). Core calls that hook
 * with `hint.nativeRouteActive === true` only when a native approval runtime is
 * actually live for our channel (dist/dispatch-DO0Fpkbp.js:86-103 ->
 * `hasActiveApprovalNativeRouteRuntime`,
 * dist/approval-native-route-coordinator-Bs0VdpS8.js:143). We delegate the
 * decision to the SDK helper, passing OUR config gate so suppression keys on
 * `clawchannel.execApprovals.enabled` rather than the global `approvals.exec`
 * block (and so the helper skips the `approvals.exec.mode` forwarding-mode gate,
 * which does not apply to our origin-surface delivery). Returns true => core
 * drops the in-band `/approve …` text and the user sees only the native widget.
 */
export function shouldSuppressClawNativeExecApprovalPrompt(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  payload: Parameters<typeof shouldSuppressLocalNativeExecApprovalPrompt>[0]["payload"];
  hint?: ChannelOutboundPayloadHint;
}): boolean {
  return shouldSuppressLocalNativeExecApprovalPrompt({
    cfg: params.cfg,
    accountId: params.accountId,
    payload: params.payload,
    hint: params.hint,
    // Native delivery is enabled exactly when our exec approvals are on.
    isNativeDeliveryEnabled: ({ cfg }) => isExecApprovalsEnabled(cfg),
    // Resolve "approval config" from OUR channel section so the helper's
    // agent/session filters + enabled check use clawchannel config, and the
    // forwarding-mode gate is bypassed (helper defaults
    // requireApprovalConfigEnabled/enforceForwardingMode to false when
    // resolveApprovalConfig is provided — approval-native-helpers-WitYuyrm.js:40-44).
    resolveApprovalConfig: ({ cfg }) => readExecApprovals(cfg) ?? { enabled: true },
  });
}

/**
 * GATE 1 enabler. Register the `"approval.native"` runtime context from a
 * `gateway.startAccount` monitor so core's approval bootstrap actually starts
 * the native handler that drives our runtime spec
 * (presentation.buildPendingPayload / transport.deliverPending).
 *
 * Why a gateway monitor (not `registerFull`): the bootstrap that WATCHES for
 * this context (dist/server-channels-g1oRRKIH.js:112-116, started :429
 * `startChannelApprovalHandlerBootstrap`) runs ONLY inside
 * `startChannelInternal`, which short-circuits unless the plugin provides
 * `gateway.startAccount` (:330-331) AND `listAccountIds` returns ≥1 account
 * (:339-341). It then hands `startAccount` the SAME task-scoped `channelRuntime`
 * it watches (:433 vs :465), and the context registry is a per-runtime Map (NOT
 * a global singleton — dist/runtime-channel-DiQw75-a.js:61), so the registration
 * must go through `ctx.channelRuntime.runtimeContexts.register`. Registering via
 * `api.runtime.channel.runtimeContexts` in `registerFull` targets a DIFFERENT
 * registry instance the bootstrap never reads — it would not work.
 *
 * `register` params/return verified:
 * dist/plugin-sdk/channel-runtime-surface.types-CouuvmKm.d.ts:21-33
 * (`ChannelRuntimeContextRegistry.register(key & {context; abortSignal?}) =>
 * {dispose}`). We scope `accountId` to `ctx.accountId` so it matches the
 * watcher's account filter exactly (dist/runtime-channel-DiQw75-a.js:56) and
 * pass `ctx.abortSignal` so the lease is torn down on channel stop. We then
 * keep `startAccount` alive until abort (returning early would make core log
 * "channel exited" and tear the bootstrap down — server-channels:472-488).
 */
export async function startClawApprovalMonitor(
  ctx: ChannelGatewayContext,
): Promise<void> {
  const registry = ctx.channelRuntime?.runtimeContexts;
  const registration = registry?.register({
    channelId: CLAWCHANNEL_ID,
    accountId: ctx.accountId,
    capability: CHANNEL_APPROVAL_NATIVE_RUNTIME_CONTEXT_CAPABILITY,
    // The native runtime spec talks straight to the transport WebSocket session
    // map, so it needs no per-channel context payload; the registration's mere
    // PRESENCE is what flips the bootstrap on. Empty object documents that.
    context: {},
    abortSignal: ctx.abortSignal,
  });
  try {
    // Stay alive for the channel's lifetime so the native approval handler keeps
    // running; resolve when the gateway aborts the account (channel stop).
    await waitForAbort(ctx.abortSignal);
  } finally {
    registration?.dispose();
  }
}

/** Resolve once `signal` aborts (immediately if already aborted). */
function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

/**
 * Resolve an approval over the gateway in response to a widget button click.
 * Routes exec vs plugin internally (plugin: ids => plugin). `allowPluginFallback`
 * lets a plugin approval resolve even if the gateway tries exec first. After the
 * gateway records the decision it emits a resolution event that drives our
 * native runtime's `updateEntry` -> `approval_resolved`, so we do NOT emit the
 * resolved frame here (avoids double-finalize).
 *
 * `senderId` is the single anon peer; with OPEN auth the gateway authorization
 * is delegated to our `authorizeActorAction` (always authorized).
 */
export async function handleApprovalDecision(
  cfg: OpenClawConfig,
  approvalId: string,
  decision: ApprovalDecision,
  senderId: string = ANON_PEER_ID,
): Promise<void> {
  await resolveApprovalOverGateway({
    cfg,
    approvalId,
    decision,
    allowPluginFallback: true,
    senderId,
  });
}
