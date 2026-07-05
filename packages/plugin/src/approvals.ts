import {
  createChannelApprovalNativeRuntimeAdapter,
  resolveApprovalOverGateway,
  // Runtime-context capability key channels register so core's approval
  // bootstrap starts the native handler. Re-exported from this barrel; the
  // canonical declaration is
  // dist/plugin-sdk/approval-handler-adapter-runtime-BLQ3gGQv.d.ts:5
  // (`CHANNEL_APPROVAL_NATIVE_RUNTIME_CONTEXT_CAPABILITY = "approval.native"`).
  CHANNEL_APPROVAL_NATIVE_RUNTIME_CONTEXT_CAPABILITY,
} from "openclaw/plugin-sdk/approval-handler-runtime";
import type {
  PendingApprovalView,
  ApprovalActionView,
  ChannelApprovalNativeRuntimeSpec,
  ChannelApprovalNativeFinalAction,
  // Erased runtime-adapter type the capability's `nativeRuntime` field carries
  // (dist/plugin-sdk/approval-handler-runtime-types-D7Tw1EQA.js). The strongly
  // typed adapter we build from createClawApprovalNativeRuntimeSpec is widened
  // to this via `as unknown as` in createClawApprovalCapability.load().
  ChannelApprovalNativeRuntimeAdapter,
} from "openclaw/plugin-sdk/approval-handler-runtime";
// Lazy adapter: heavy channel delivery code only loads when the runtime hooks
// actually run, so cold startup doesn't pay for it. Mirrors Discord's
// approval-native.ts. Verified:
// dist/plugin-sdk/approval-handler-adapter-runtime-BLQ3gGQv.d.ts:7-13.
import { createLazyChannelApprovalNativeRuntimeAdapter } from "openclaw/plugin-sdk/approval-handler-adapter-runtime";
// The canonical approver-restricted capability builder. Replaces the prior
// hand-rolled `createChannelApprovalCapability({ authorizeActorAction: () =>
// ({authorized:true}) })` stub (Phase 1 OPEN auth) with the SDK's per-peer
// authorization path. Verified:
// dist/plugin-sdk/approval-delivery-helpers-C2DqZtvB.d.ts:33-65
// (ApproverRestrictedNativeApprovalParams) and :108 (factory).
import { createApproverRestrictedNativeApprovalCapability } from "openclaw/plugin-sdk/approval-delivery-runtime";
// Account/channel match gate used by shouldHandleWebChannelApprovalRequest.
// Verified: dist/plugin-sdk/approval-request-account-binding-DUl0SBjl.d.ts:19-24
// (S1: we now pass the handler's accountId so it is compared against the
// request's turnSourceAccountId — stamped by src/inbound.ts buildContext).
import { doesApprovalRequestMatchChannelAccount } from "openclaw/plugin-sdk/approval-native-runtime";
// Idiomatic helper that decides whether a channel-native exec approval route
// replaces (suppresses) the local in-band `/approve …` text prompt. Verified:
// dist/plugin-sdk/approval-native-helpers-n_-eGDqh.d.ts (re-exported from the
// approval-native-runtime barrel). Its impl returns true only when
// `hint.nativeRouteActive === true` (proof the native runtime handler is live)
// AND native delivery is enabled for our config.
import { shouldSuppressLocalNativeExecApprovalPrompt } from "openclaw/plugin-sdk/approval-native-runtime";
// Dedupe/validate approver ids from config + ownerAllowFrom fallback. Verified:
// dist/plugin-sdk/approval-auth-helpers-D7LdqjtP.d.ts:5-12.
import { resolveApprovalApprovers } from "openclaw/plugin-sdk/approval-auth-runtime";
// enabled + approver-count gate and agent/session filter matcher used by
// shouldHandleWebChannelApprovalRequest. Verified:
// dist/plugin-sdk/approval-client-helpers-CUOhLj5r.d.ts:40-43 (:18-23).
import {
  isChannelExecApprovalClientEnabledFromConfig,
  matchesApprovalRequestFilters,
} from "openclaw/plugin-sdk/approval-client-runtime";
// Request types for the shouldHandle predicate. Verified:
// dist/plugin-sdk/approval-runtime.d.ts:14 (re-exports ExecApprovalRequest,
// PluginApprovalRequest).
import type {
  ExecApprovalRequest,
  PluginApprovalRequest,
} from "openclaw/plugin-sdk/approval-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
// `ChannelApprovalCapability` (the `nativeRuntime` field's erased type) is
// re-exported here, not from the approval-runtime barrel. Verified:
// dist/plugin-sdk/channel-runtime.d.ts:19.
import type {
  ChannelApprovalCapability,
  ChannelGatewayContext,
  ChannelOutboundPayloadHint,
} from "openclaw/plugin-sdk/channel-runtime";

import { WEBCHANNEL_ID, ANON_PEER_ID } from "./transport.js";
import type {
  WebChannelTransport,
  ApprovalDecision,
  ApprovalOption,
  ApprovalRequestPayload,
} from "./transport.js";
import {
  DEFAULT_ACCOUNT_ID,
  listWebchannelAccountIds,
  resolveWebchannelAccountConfig,
} from "./account-config.js";

/**
 * Resolve the transport a given account's approval frames should ride. `null`/
 * `undefined` accountId means "unscoped" (legacy single-account callers); a
 * resolver may map that to the default account. Returning `undefined` makes the
 * caller fall back to the capability's closure-bound transport (the single-
 * account / legacy-WS path), so a missing resolver or unknown account degrades
 * to today's behavior instead of dropping the frame.
 */
export type ResolveAccountTransport = (
  accountId: string | null | undefined,
) => WebChannelTransport | undefined;

/**
 * approvalId → account it was DELIVERED on (S1 adversarial-round F1). The
 * widget-click reverse path (`handleApprovalDecision`) resolves an approval over
 * the gateway RPC, which does NO per-approval authz — it forwards `{id, decision}`
 * blind. So an approver on account B could otherwise resolve account A's exec by
 * replaying A's approvalId onto B's channel (ids are `crypto.randomUUID()`, so
 * this needs an id leak — a transcript/log — but the per-account boundary S1
 * claims must hold regardless). We record which account each approval was
 * delivered on at `deliverPending`, and `handleApprovalDecision` refuses a
 * decision arriving on a DIFFERENT account than the one that showed the card.
 *
 * Normalized to "default" (null/unscoped ⇒ default) so the single-account /
 * legacy-WS path compares consistently. Entries are removed on resolve/expire
 * (`updateEntry`, which fires for BOTH phases); the cap is a safety backstop for
 * an abandoned approval whose finalize never runs — approvals are agent-minted
 * (a browser can't forge one), so this is not a client-reachable growth vector.
 */
const APPROVAL_ACCOUNT_BINDING_CAP = 4096;
const deliveredApprovalAccounts = new Map<string, string>();

/** Normalize an account id for binding comparison (null/unscoped ⇒ "default"). */
function bindingAccountKey(accountId: string | null | undefined): string {
  return accountId ?? DEFAULT_ACCOUNT_ID;
}

/**
 * @internal Test seam for the approval→account binding (F1). Production code
 * populates it only via `deliverPending`; tests that exercise
 * `handleApprovalDecision` in isolation seed/reset it here so they drive the
 * SAME map the real delivery path writes.
 */
export const __approvalAccountBindingTestHook = {
  record: (approvalId: string, accountId: string | null | undefined) =>
    recordApprovalAccount(approvalId, accountId),
  clear: () => deliveredApprovalAccounts.clear(),
};

/** Record which account an approval was delivered on (bounded; evicts oldest). */
function recordApprovalAccount(approvalId: string, accountId: string | null | undefined): void {
  // Insertion-ordered Map: delete-then-set moves a repeat id to the newest slot
  // so a re-delivery (stateless register / retry) refreshes rather than dupes.
  deliveredApprovalAccounts.delete(approvalId);
  while (deliveredApprovalAccounts.size >= APPROVAL_ACCOUNT_BINDING_CAP) {
    const oldest = deliveredApprovalAccounts.keys().next().value;
    if (oldest === undefined) break;
    deliveredApprovalAccounts.delete(oldest);
  }
  deliveredApprovalAccounts.set(approvalId, bindingAccountKey(accountId));
}

/**
 * Native HITL approval capability for WebChannel.
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
 *     over our WebSocket (the "target" is the originating peer's wsKey),
 *   - presentation.buildResolvedResult / transport.updateEntry emit
 *     `approval_resolved` to finalize (disable buttons in the widget).
 *
 * The reverse direction (widget button click) is owned by us, NOT by the native
 * runtime: the widget sends `approval_decision`, the transport routes it to
 * `handleApprovalDecision` below, which calls the unified
 * `resolveApprovalOverGateway` (dist/plugin-sdk/approval-gateway-runtime-CsiA6CDb.d.ts)
 * to resolve the exec/plugin approval over the gateway so the run continues.
 *
 * AUTHORIZATION: the capability is built by the SDK's
 * `createApproverRestrictedNativeApprovalCapability`, which wires
 * `authorizeActorAction` to enforce `channels.webchannel.execApprovals.approvers`
 * (falling back to `commands.ownerAllowFrom`). This closes the Phase 1 hole
 * where `authorizeActorAction: () => ({authorized:true})` let any verified peer
 * approve any exec and silently ignored `approvers`. The reverse-leg sender is
 * the verified peer id (`sessionKey`, see index.ts), which the gateway checks
 * against the same approver set.
 *
 * Verified SDK shapes:
 *  - ChannelApprovalNativeRuntimeSpec (presentation/transport/availability):
 *    dist/plugin-sdk/approval-handler-runtime-types-D7Tw1EQA.d.ts.
 *  - PendingApprovalView (approvalId, approvalKind, title, description,
 *    metadata[], expiresAtMs, actions: ApprovalActionView[]).
 *  - ApproverRestrictedNativeApprovalParams:
 *    dist/plugin-sdk/approval-delivery-helpers-C2DqZtvB.d.ts:33-65; factory
 *    :108. The capability's `native` adapter (describeDeliveryCapabilities +
 *    resolveOriginTarget) is built by the factory from the `resolveOriginTarget`
 *    we pass in (dist/approval-native-runtime delivery plan reads it).
 */

/**
 * Pending entry we hand back from `deliverPending`; we get it back in
 * `buildResolvedResult` / `transport.updateEntry` to finalize the widget card.
 */
type ClawApprovalEntry = {
  approvalId: string;
  sessionKey: string;
  /**
   * The account this entry was DELIVERED on (normalized; null = unscoped
   * legacy). `updateEntry` re-resolves the same account's transport from this
   * (preferring the live hook context's accountId), so the resolved/expired
   * finalize frame always lands on the channel that showed the prompt.
   */
  accountId: string | null;
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

/**
 * Read an ACCOUNT's effective `execApprovals` block (S1: account-aware).
 * `resolveWebchannelAccountConfig` merges the channel-level shared base under
 * the `accounts.<id>` override (execApprovals is one of its NESTED_OBJECT_KEYS,
 * so per-field account overrides compose with channel-wide defaults). A null/
 * absent accountId reads the `"default"` account, which for a flat single-
 * account config is exactly the old channel-level read (regression-free).
 */
function readExecApprovals(
  cfg: OpenClawConfig,
  accountId?: string | null,
): {
  enabled?: boolean | "auto";
  approvers?: (string | number)[];
  agentFilter?: string[];
  sessionFilter?: string[];
} | undefined {
  const account = resolveWebchannelAccountConfig(cfg, accountId ?? DEFAULT_ACCOUNT_ID);
  return account.execApprovals as ReturnType<typeof readExecApprovals>;
}

/**
 * Native approvals are "on" when `execApprovals.enabled` is `true` or `"auto"`.
 * `false`/unset => off. We treat `"auto"` as on because this single-session web
 * surface is always able to render the prompt (unlike DM-routed channels which
 * gate `"auto"` on having a reachable approver). This gates DELIVERY only;
 * whether the surface counts as an enabled approval CLIENT also requires
 * configured approvers (see isWebChannelExecApprovalClientEnabled via
 * shouldHandleWebChannelApprovalRequest + the capability's surface hooks).
 */
function isExecApprovalsEnabled(cfg: OpenClawConfig, accountId?: string | null): boolean {
  const enabled = readExecApprovals(cfg, accountId)?.enabled;
  return enabled === true || enabled === "auto";
}

// ── approver resolution ──────────────────────────────────────────────────

/**
 * Resolve the configured approver peer ids for webchannel. Source priority
 * (mirrors Discord's exec-approvals.ts):
 *   1. channels.webchannel.execApprovals.approvers (typed array of peer ids)
 *   2. commands.ownerAllowFrom (global fallback)
 * Webchannel peer ids are arbitrary verified strings (the verifier's peerId),
 * so no normalization is needed beyond trim+drop-empty (cf. Discord's numeric
 * user-id parsing). resolveApprovalApprovers also dedupes.
 */
export function getWebChannelExecApprovalApprovers(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): string[] {
  const explicit = readExecApprovals(params.cfg, params.accountId)?.approvers;
  const source: readonly (string | number)[] =
    Array.isArray(explicit) && explicit.length > 0
      ? explicit
      : (params.cfg.commands?.ownerAllowFrom ?? []);
  return resolveApprovalApprovers({
    explicit: source,
    normalizeApprover: (value) => {
      // Webchannel peer ids are strings; numeric config entries are not valid
      // peer ids, so drop them (schema permits numbers only for cross-channel
      // config reuse like Discord/Telegram user ids).
      const s = typeof value === "string" ? value.trim() : "";
      return s.length > 0 ? s : undefined;
    },
  });
}

/** Whether `senderId` is one of the ACCOUNT's configured webchannel approvers. */
export function isWebChannelExecApprovalApprover(params: {
  cfg: OpenClawConfig;
  senderId?: string | null;
  accountId?: string | null;
}): boolean {
  const senderId = params.senderId?.trim();
  if (!senderId) return false;
  return getWebChannelExecApprovalApprovers({
    cfg: params.cfg,
    accountId: params.accountId,
  }).includes(senderId);
}

function hasConfiguredApprovers(cfg: OpenClawConfig, accountId?: string | null): boolean {
  return getWebChannelExecApprovalApprovers({ cfg, accountId }).length > 0;
}

/**
 * Whether a native approval request should be handled by webchannel. Combines
 * (a) account/channel match via SDK helper, (b) execApprovals.enabled +
 * approver count via isChannelExecApprovalClientEnabledFromConfig, (c) the
 * optional agent/session filters from config. Mirrors Discord's
 * approval-shared.ts shouldHandleDiscordApprovalRequest.
 */
export function shouldHandleWebChannelApprovalRequest(params: {
  cfg: OpenClawConfig;
  request: ExecApprovalRequest | PluginApprovalRequest;
  accountId?: string | null;
}): boolean {
  const { cfg, request, accountId } = params;
  // S1: pass the handler's accountId so the SDK matcher compares it against the
  // request's `turnSourceAccountId` (stamped by our inbound buildContext) — an
  // account-B turn's approval is claimed ONLY by account B's handler, never A's.
  //
  // KNOWN RESIDUAL (adversarial-round F3, deferred): the SDK matcher returns
  // TRUE for EVERY account's handler when a request has NEITHER a
  // `turnSourceAccountId` NOR a session-bound accountId — so an approval with no
  // account linkage fans out to all served accounts' channels. That only arises
  // for AGENT-INITIATED / cron approvals (a user turn always carries the account
  // via inbound.ts's stamp), which is exactly the still-open "proactive/
  // untargeted outbound" leg (docs/BACKLOG.md S1). The F2 fail-closed delivery
  // above bounds the blast radius to accounts with a LIVE channel; fully
  // resolving the fan-out needs the outbound-account semantics that leg defines.
  if (
    !doesApprovalRequestMatchChannelAccount({
      cfg,
      request,
      channel: WEBCHANNEL_ID,
      accountId,
    })
  ) {
    return false;
  }
  const config = readExecApprovals(cfg, accountId);
  const approvers = getWebChannelExecApprovalApprovers({ cfg, accountId });
  if (
    !isChannelExecApprovalClientEnabledFromConfig({
      enabled: config?.enabled,
      approverCount: approvers.length,
    })
  ) {
    return false;
  }
  return matchesApprovalRequestFilters({
    request: request.request,
    agentFilter: config?.agentFilter,
    sessionFilter: config?.sessionFilter,
  });
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
 * platform client). The delivery target resolves to the ORIGINATING peer's web
 * session (see `prepareTarget` / the capability's `resolveOriginTarget`), so
 * with multiple concurrent users each approval prompt reaches the user who
 * triggered it.
 */
export function createClawApprovalNativeRuntimeSpec(
  transport: WebChannelTransport,
  resolveAccountTransport?: ResolveAccountTransport,
): ChannelApprovalNativeRuntimeSpec<
  ApprovalRequestPayload, // TPendingPayload
  { sessionKey: string }, // TPreparedTarget
  ClawApprovalEntry, // TPendingEntry
  unknown, // TBinding (no interactive binding to clear; we own the widget card)
  ClawApprovalFinalPayload // TFinalPayload
> {
  // S1 delivery routing: core starts ONE native handler per account (the
  // bootstrap's per-account start passes `accountId` into every hook context),
  // so delivery resolves THAT account's channel.
  //
  // FAIL-CLOSED (adversarial-round F2): when a resolver IS wired (the NATS
  // multi-account entry), a MISS returns `undefined` and the caller DROPS the
  // frame — it must NEVER fall back to the closure `transport` (the primary
  // channel), or an account that `registerFull` skipped (creds-missing /
  // connect-fail) would have its prompt delivered on the PRIMARY account's
  // channel — re-opening the exact cross-account misroute S1 closes. Only the
  // legacy single-transport WS entry (no resolver) uses the closure transport,
  // where there is exactly one account and no misroute is possible.
  const hasResolver = typeof resolveAccountTransport === "function";
  const transportFor = (
    accountId: string | null | undefined,
  ): WebChannelTransport | undefined =>
    hasResolver ? resolveAccountTransport!(accountId) : transport;
  return {
    // We can render BOTH exec and plugin approvals natively in the widget.
    eventKinds: ["exec", "plugin"],
    availability: {
      // Mirror the outer lazy adapter's gate (createClawApprovalCapability):
      // native delivery requires BOTH approvers configured AND execApprovals
      // enabled, and a request must clear shouldHandleWebChannelApprovalRequest.
      // Core reads the outer adapter in production, but keeping the inner spec
      // aligned avoids a misleading "enabled-but-no-approvers" half-state if the
      // spec is ever consumed directly (and documents the true invariant).
      isConfigured: ({ cfg, accountId }) =>
        hasConfiguredApprovers(cfg, accountId) && isExecApprovalsEnabled(cfg, accountId),
      shouldHandle: ({ cfg, accountId, request }) =>
        shouldHandleWebChannelApprovalRequest({ cfg, accountId, request }),
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
      // Route the prompt to the ORIGINATING peer's web session. The planned
      // target's `to` was produced by the capability's `resolveOriginTarget`,
      // which reads `request.turnSourceTo` — the real per-peer `wsKey` we
      // recorded as the inbound turn's `reply.to` (src/inbound.ts buildContext).
      // The transport socket map is keyed by that same `peerId`, so it lines up.
      // With 2+ concurrent users this targets the right user's socket; the
      // dedupeKey is per-peer so distinct users never collide.
      prepareTarget: ({ accountId, plannedTarget }) => {
        // `plannedTarget.target.to` is the per-peer key resolveOriginTarget
        // produced; default to the anon peer if it's somehow absent so a
        // single-session deployment still gets its prompt.
        const sessionKey = plannedTarget?.target?.to || ANON_PEER_ID;
        return {
          // Scope the dedupe key by account: the SAME peerId registered on two
          // accounts is two distinct delivery targets (each account's channel),
          // never one deduped entry.
          dedupeKey: `${WEBCHANNEL_ID}:${accountId ?? DEFAULT_ACCOUNT_ID}:${sessionKey}`,
          target: { sessionKey },
        };
      },
      // Emit the `approval_request` frame ON THE ORIGINATING ACCOUNT's channel.
      // Returning a non-null entry tells the runtime the prompt was delivered;
      // the entry is handed back on finalize.
      deliverPending: ({ accountId, preparedTarget, pendingPayload }) => {
        const sessionKey = preparedTarget.sessionKey;
        // Bind this approval to its delivering account BEFORE sending, so the
        // widget-click reverse path can enforce the per-account boundary (F1)
        // even if the frame itself never reaches a socket.
        recordApprovalAccount(pendingPayload.id, accountId);
        const channel = transportFor(accountId);
        if (!channel) {
          // F2 fail-closed: no live channel for this account (skipped/unknown).
          // Refuse to misroute onto the primary channel; drop with a warn.
          console.warn(
            `[webchannel] approval ${pendingPayload.id} not delivered: no live channel for ` +
              `account "${accountId ?? DEFAULT_ACCOUNT_ID}" (skipped or unknown) — refusing to misroute`,
          );
          return { approvalId: pendingPayload.id, sessionKey, accountId: accountId ?? null };
        }
        // Fail-closed: with 2+ connections and an absent `turnSourceTo` the
        // target falls back to `web-anon`, `soleOpenSocket` returns undefined,
        // and the prompt is correctly DROPPED rather than misrouted. That drop
        // is otherwise invisible, so log it (no logger in scope here; match the
        // transport's `[webchannel]` console style — src/transport.ts safeSend).
        const delivered = channel.sendApprovalRequest(sessionKey, pendingPayload);
        if (!delivered) {
          console.warn(
            `[webchannel] approval ${pendingPayload.id} not delivered: no matching open ` +
              `socket for "${sessionKey}" (account "${accountId ?? DEFAULT_ACCOUNT_ID}")`,
          );
        }
        return { approvalId: pendingPayload.id, sessionKey, accountId: accountId ?? null };
      },
      // Finalize: emit `approval_resolved` so the widget disables buttons and
      // shows the outcome. Fires for both resolved and expired `update` actions.
      // Route via the DELIVERING account's channel (context accountId, with the
      // entry's recorded account as fallback) so finalize matches delivery.
      updateEntry: async ({ entry, payload, accountId }) => {
        // Finalize is terminal for this approval — release the id→account
        // binding (resolved AND expired both route here).
        deliveredApprovalAccounts.delete(entry.approvalId);
        const channel = transportFor(accountId ?? entry.accountId);
        if (!channel) {
          console.warn(
            `[webchannel] approval ${entry.approvalId} resolve frame dropped: no live channel ` +
              `for account "${accountId ?? entry.accountId ?? DEFAULT_ACCOUNT_ID}"`,
          );
          return;
        }
        channel.sendApprovalResolved(
          entry.sessionKey,
          entry.approvalId,
          payload.decision,
        );
      },
    },
  };
}

/**
 * Build the WebChannel approval capability using the SDK's
 * `createApproverRestrictedNativeApprovalCapability`. This replaces the prior
 * `authorizeActorAction: () => ({authorized: true})` stub (Phase 1 had OPEN
 * auth with a single trusted `web-anon` session).
 *
 * AUTHORIZATION SCOPE — read carefully. This capability's `authorizeActorAction`
 * (wired by the SDK helper from `isExecAuthorizedSender`) only protects the chat
 * `/approve` TEXT-COMMAND path (dist/commands-handlers.runtime-DIVsKJOl.js:784),
 * which webchannel's widget never sends. The WIDGET-CLICK path
 * (`approval_decision` frame → `handleApprovalDecision`) is NOT routed through
 * `authorizeActorAction`; its enforcement lives in `handleApprovalDecision`
 * (fail-closed `isWebChannelExecApprovalApprover` before the gateway RPC). Both
 * paths resolve approvers from `channels.webchannel.execApprovals.approvers`
 * (falling back to `commands.ownerAllowFrom`). The capability hook is still
 * wired so the SDK's surface-state derivation and any future text-command entry
 * stay correct.
 *
 * Native delivery is origin-surface only (we deliver the approval card to the
 * peer that started the turn, never via DM). Mirrors Discord's
 * createDiscordApprovalCapability (discord/src/approval-native.ts).
 */
export function createClawApprovalCapability(
  transport: WebChannelTransport,
  resolveAccountTransport?: ResolveAccountTransport,
) {
  const nativeRuntime = createLazyChannelApprovalNativeRuntimeAdapter({
    eventKinds: ["exec", "plugin"],
    isConfigured: ({ cfg, accountId }) =>
      hasConfiguredApprovers(cfg, accountId) && isExecApprovalsEnabled(cfg, accountId),
    shouldHandle: ({ cfg, accountId, request }) =>
      shouldHandleWebChannelApprovalRequest({ cfg, accountId, request }),
    load: async () => {
      // Build the strongly-typed spec lazily so cold startup doesn't pay for it.
      const spec = createClawApprovalNativeRuntimeSpec(transport, resolveAccountTransport);
      // The capability's nativeRuntime field is generic-erased (all unknown),
      // so widen with a cast. Pure generic-erasure — core calls the hooks with
      // the exact runtime values we produce. (See the former cast at the old
      // createClawApprovalCapability, and the SDK type citation:
      // dist/plugin-sdk/types.adapters-772EgiLZ.d.ts:604.)
      const adapter = createChannelApprovalNativeRuntimeAdapter(spec);
      return adapter as unknown as ChannelApprovalNativeRuntimeAdapter;
    },
  });

  return createApproverRestrictedNativeApprovalCapability({
    channel: WEBCHANNEL_ID,
    channelLabel: "WebChannel",
    describeExecApprovalSetup: ({ accountId }) => {
      const prefix =
        accountId && accountId !== "default"
          ? `channels.webchannel.accounts.${accountId}`
          : "channels.webchannel";
      return `WebChannel supports native exec approvals for this account. Configure \`${prefix}.execApprovals.approvers\` (peer ids from your verifier) and set \`${prefix}.execApprovals.enabled\` to \`true\` or \`"auto"\`. The global fallback is \`commands.ownerAllowFrom\`.`;
    },
    // Core's approval bootstrap checks the outer adapter's `isConfigured`
    // (above, which requires approvers AND enabled) BEFORE the native handler
    // starts, so with no approvers configured the delivery hooks never run and
    // no prompt is shown — `listAccountIds` just enumerates which accounts to
    // probe. S1: enumerate the REAL configured accounts (Telegram pattern) so
    // the SDK's surface-state scans see every deployment, not just "default".
    listAccountIds: (cfg) => listWebchannelAccountIds(cfg),
    hasApprovers: ({ cfg, accountId }) => hasConfiguredApprovers(cfg, accountId),
    isExecAuthorizedSender: ({ cfg, accountId, senderId }) =>
      isWebChannelExecApprovalApprover({ cfg, accountId, senderId }),
    isNativeDeliveryEnabled: ({ cfg, accountId }) => isExecApprovalsEnabled(cfg, accountId),
    resolveNativeDeliveryMode: () => "channel",
    resolveOriginTarget: ({ request }) => {
      // The ORIGINATING peer's web session. `request.request.turnSourceTo` is
      // exactly the wsKey we recorded as the inbound turn's `reply.to`
      // (src/inbound.ts buildContext), which is also the transport socket-map
      // key. Filter on turnSourceChannel so we never mis-claim an approval that
      // originated on a different channel. Fall back to the anon peer when the
      // turn-source is absent (the anonymous single-session dev path).
      const src = request.request;
      const channel = src.turnSourceChannel?.toLowerCase();
      if (channel && channel !== WEBCHANNEL_ID) return null;
      const to =
        typeof src.turnSourceTo === "string" && src.turnSourceTo.length > 0
          ? src.turnSourceTo
          : ANON_PEER_ID;
      return { to };
    },
    // `notifyOriginWhenDmOnly` intentionally omitted: `resolveNativeDeliveryMode`
    // is always "channel" (webchannel has no DM surface), so DM-only delivery
    // never triggers and the flag would be dead config.
    nativeRuntime,
  });
}

/**
 * GATE 2 text suppressor. Wired from the channel's
 * `outbound.shouldSuppressLocalPayloadPrompt`
 * (dist/plugin-sdk/outbound.types.d.ts). Core calls that hook
 * with `hint.nativeRouteActive === true` only when a native approval runtime is
 * actually live for our channel. We delegate the
 * decision to the SDK helper, passing OUR config gate so suppression keys on
 * `webchannel.execApprovals.enabled` rather than the global `approvals.exec`
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
    // Native delivery is enabled exactly when the ACCOUNT's exec approvals are on.
    isNativeDeliveryEnabled: ({ cfg, accountId }) => isExecApprovalsEnabled(cfg, accountId),
    // Resolve "approval config" from OUR channel section (account-scoped) so the
    // helper's agent/session filters + enabled check use webchannel config, and
    // the forwarding-mode gate is bypassed (helper defaults
    // requireApprovalConfigEnabled/enforceForwardingMode to false when
    // resolveApprovalConfig is provided).
    resolveApprovalConfig: ({ cfg, accountId }) =>
      readExecApprovals(cfg, accountId) ?? { enabled: true },
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
 * dist/plugin-sdk/channel-runtime-surface.types.d.ts
 * (`ChannelRuntimeContextRegistry.register(key & {context; abortSignal?}) =>
 * {dispose}`). We scope `accountId` to `ctx.accountId` so it matches the
 * watcher's account filter exactly and pass `ctx.abortSignal` so the lease is
 * torn down on channel stop. We then keep `startAccount` alive until abort
 * (returning early would make core log "channel exited" and tear the bootstrap
 * down — server-channels:472-488).
 */
export async function startClawApprovalMonitor(
  ctx: ChannelGatewayContext,
): Promise<void> {
  const registry = ctx.channelRuntime?.runtimeContexts;
  const registration = registry?.register({
    channelId: WEBCHANNEL_ID,
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
 * `senderId` is REQUIRED: it is the verified peer id — the `jwt`-authenticated
 * `sub` on the register hop, or the X25519-handshake peer on the NATS path.
 *
 * THIS FUNCTION IS THE AUTHORIZATION ENFORCEMENT POINT for the widget-click
 * path. The capability's `authorizeActorAction` hook does NOT protect this path:
 * `resolveApprovalOverGateway` only forwards `{id, decision}` to the gateway RPC
 * and uses `senderId` purely for `clientDisplayName` (verified:
 * dist/approval-gateway-resolver-DNNKgGbF.js:5-28). `authorizeActorAction` is
 * invoked solely from the chat `/approve` text-command path
 * (dist/commands-handlers.runtime-DIVsKJOl.js:784), which the widget never
 * sends. So we fail-closed HERE, at the channel boundary, before the RPC leaves
 * the process: only peers in `channels.webchannel.execApprovals.approvers`
 * (falling back to `commands.ownerAllowFrom`) may resolve an approval. The prior
 * default of `ANON_PEER_ID` is dropped so no caller can bypass this check.
 */
export async function handleApprovalDecision(
  cfg: OpenClawConfig,
  approvalId: string,
  decision: ApprovalDecision,
  senderId: string,
  accountId?: string | null,
): Promise<void> {
  // FAIL-CLOSED #1 (adversarial-round F1): the approval must be resolved on the
  // SAME account it was delivered on. The gateway RPC resolves by id with NO
  // per-approval authz, so without this an approver on account B could replay
  // account A's approvalId onto B's channel and resolve A's exec (ids are random
  // UUIDs, so this needs an id leak — but the per-account boundary must hold
  // regardless). Absence of a binding is ALWAYS a reject: an id we never
  // delivered (foreign/forged), or one already finalized, or (rare) one whose
  // in-memory binding was lost to an agent restart mid-approval — all fail
  // closed. A real widget click always follows a `deliverPending` in the same
  // process, so a legitimate resolve holds its binding.
  const boundAccount = deliveredApprovalAccounts.get(approvalId);
  if (boundAccount === undefined) {
    throw new Error(
      `webchannel: approval "${approvalId}" is unknown or already resolved ` +
        `(no live delivery binding) — refusing to resolve`,
    );
  }
  if (boundAccount !== bindingAccountKey(accountId)) {
    throw new Error(
      `webchannel: approval "${approvalId}" was delivered on account ` +
        `"${boundAccount}", not "${bindingAccountKey(accountId)}" — refusing cross-account resolve`,
    );
  }

  // FAIL-CLOSED #2: see JSDoc — the gateway RPC does not authz, so the channel
  // boundary must. A non-approver gets rejected before any RPC is issued.
  // S1: the decision frame arrives on a specific ACCOUNT's channel (the NATS
  // handler passes its accountId), so the approver set is that account's —
  // an approver configured only on account A cannot resolve via account B's
  // channel. Legacy callers omit accountId and keep the default-account read.
  if (!isWebChannelExecApprovalApprover({ cfg, senderId, accountId })) {
    throw new Error(
      `webchannel: peer "${senderId}" is not a configured exec approver` +
        (accountId ? ` for account "${accountId}"` : ""),
    );
  }
  await resolveApprovalOverGateway({
    cfg,
    approvalId,
    decision,
    allowPluginFallback: true,
    senderId,
  });
}
