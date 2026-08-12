import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-core";
import {
  isReplyPayloadNonTerminalToolErrorWarning,
  type ReplyPayload,
} from "openclaw/plugin-sdk/reply-payload";

import { WEBCHANNEL_ID, ANON_PEER_ID } from "./channel-contract.js";
import type { WebChannelPeerChannel, InboundWsMessage } from "./channel-contract.js";
import { resolveDmAdmission } from "./dm-allowlist.js";
import { DEFAULT_WEBCHANNEL_ACCOUNT_ID, resolveWebchannelAccountConfig } from "./account-config.js";
import { resolveWebchannelSessionRoute } from "./session-route.js";
import { resolveWebchannelReasoningLevel } from "./reasoning-level.js";
import {
  getApprovalOriginRegistry,
  type ApprovalOriginLease,
} from "./approval-origin.js";

import { readCoalescedMemberIds, type CoalescedMemberIds } from "./inbound-queue.js";

/**
 * The inbound path only handles user messages; approvals route separately.
 *
 * #99: a turn handed down by the per-session FIFO may be the MERGE of several
 * buffered user messages, in which case it carries their wireIds internally
 * (`coalescedIds`). That field is added by `coalesceUserMessages` after the
 * frame left the wire — it is not part of `InboundWsMessage` — and is absent
 * on an ordinary single-message turn.
 */
type InboundUserMessage = Extract<InboundWsMessage, { type: "user_message" }> &
  CoalescedMemberIds;
import {
  resolveStreamingMode,
  createProgressDraftController,
  createReasoningDraftController,
} from "./message-adapter.js";
import type {
  ProgressDraftController,
  ReasoningDraftController,
} from "./message-adapter.js";

type NoticeFlagPayload = {
  isStatusNotice?: boolean;
  isFallbackNotice?: boolean;
  isCompactionNotice?: boolean;
};

function noticeFlagsOf(payload: NoticeFlagPayload): NoticeFlagPayload {
  return {
    isStatusNotice: payload.isStatusNotice,
    isFallbackNotice: payload.isFallbackNotice,
    isCompactionNotice: payload.isCompactionNotice,
  };
}

function isCoreNoticePayload(payload: NoticeFlagPayload): boolean {
  return (
    payload.isStatusNotice === true ||
    payload.isFallbackNotice === true ||
    payload.isCompactionNotice === true
  );
}

export type FinalReconciliationState = {
  ordinaryAnswerFinalSeen: boolean;
  leadingTerminalErrorSeen: boolean;
};

/**
 * Route one draft-mode final without consuming a lane more than once.
 *
 * Notice classification is the only guard here that the downstream lane state
 * cannot reconstruct: notices deliberately bypass the controller's ordinary
 * final reconciliation. The error and prior-final predicates are retained as
 * defence-in-depth at this seam so every identity-less final after either
 * condition remains independent even if controller state changes later.
 */
export async function deliverDraftFinalPayload(
  draft: ProgressDraftController,
  payload: ReplyPayload,
  text: string,
  state: FinalReconciliationState,
): Promise<{ sent: boolean; independent: boolean }> {
  const isMarkedNonTerminalWarning =
    payload.isError === true && isReplyPayloadNonTerminalToolErrorWarning(payload);
  const isTerminalError = payload.isError === true && !isMarkedNonTerminalWarning;
  if (
    isTerminalError &&
    !state.ordinaryAnswerFinalSeen &&
    !state.leadingTerminalErrorSeen
  ) {
    state.leadingTerminalErrorSeen = true;
    draft.noteLeadingTerminalError();
  }

  const independent =
    isCoreNoticePayload(payload) ||
    payload.isError === true ||
    state.leadingTerminalErrorSeen ||
    state.ordinaryAnswerFinalSeen;
  if (!independent) state.ordinaryAnswerFinalSeen = true;
  const sent = independent
    ? await draft.deliverIndependentFinal({ text, ...noticeFlagsOf(payload) })
    : await draft.finalize(text);
  return { sent, independent };
}

/**
 * #87: core's own terminal verdict for an agent run, observed off the lifecycle
 * event stream.
 *
 * The delivery seam alone cannot decide a turn's outcome. It sees payloads, and
 * two different situations produce an identical payload shape — an answer
 * followed by an `isError` final:
 *
 *   - a turn that ANSWERED and then reported a failed (often mutating) tool.
 *     Core emits that warning specifically for mutating tools even when the
 *     turn answered (payloads-*.js:108), and only marks it non-terminal for
 *     MIDDLEWARE errors (payloads-*.js:77), so it usually arrives unmarked.
 *   - a turn that answered and then TIMED OUT, where core appends its terminal
 *     error after the retained payloads (embedded-agent-*.js:4105).
 *
 * Calling the first terminal fails a successful turn and offers a retry that
 * can repeat a mutation; calling the second non-terminal is #87 again. No
 * payload-shape heuristic separates them, so we take the verdict from core
 * instead: the run's lifecycle terminal is `end` (succeeded) or `error`
 * (failed). Measured at 2026.6.10 to arrive ~8-15ms BEFORE this plugin settles,
 * and `onAgentRunStart` hands us the very same `runId` the events carry.
 *
 * One `runId` emits several `start`/`finishing` pairs under model fallback;
 * only `end`/`error` are terminal, and the last one wins.
 */
type AgentRunVerdict = "ok" | "error";

/** Terminal verdict per agent run, drained by the turn that owns the run. */
const agentRunVerdicts = new Map<string, AgentRunVerdict>();
/** Live subscription, so a reload replaces rather than stacks listeners. */
let lifecycleUnsubscribe: (() => void) | undefined;
/**
 * Backstop only. Entries are deleted by the settling turn, so this cap is never
 * reached in normal operation — it bounds the leak if a run terminates for a
 * turn that never settles (a control-lane turn, or a crashed dispatch).
 */
const MAX_TRACKED_RUNS = 512;

/**
 * Subscribe to the lifecycle stream. A no-op when the host predates the API.
 *
 * `onAgentEvent` registers on a PROCESS-GLOBAL listener set
 * (agent-events-*.js:227), while a reload hands the plugin a fresh
 * `runtime.events` facade — so identity of the facade cannot be used to detect
 * "already subscribed", and simply subscribing again on each reload would stack
 * listeners for the lifetime of the process. We keep the unsubscribe handle
 * instead and drop the previous listener before installing a new one, and
 * `stopAgentLifecycleSubscription` releases it at host teardown.
 */
export function startAgentLifecycleSubscription(api: OpenClawPluginApi): void {
  // #93: touch the process-global approval-origin registry at INITIALIZATION.
  // The getter throws when a co-installed build left an incompatible object in
  // the versioned global slot, and that has to surface here — while the host is
  // still wiring the plugin up — rather than mid-turn, where the first symptom
  // would be a failed user turn. Nothing is cached: the reference is deliberately
  // re-read on every use (see `handleInboundMessage`).
  getApprovalOriginRegistry();
  const events = api.runtime?.events;
  if (!events || typeof events.onAgentEvent !== "function") return;
  stopAgentLifecycleSubscription();
  lifecycleUnsubscribe = events.onAgentEvent((evt) => {
    if (evt?.stream !== "lifecycle") return;
    const runId = evt.runId;
    if (!runId) return;
    const data = evt.data as { phase?: unknown; aborted?: unknown } | undefined;
    const phase = data?.phase;
    if (phase !== "end" && phase !== "error") return;
    // #89: a user abort is a CANCELLATION, not a turn failure. Core stamps
    // `aborted` on the terminal (run-termination-*.js:23) and, depending on how
    // the abort surfaces, the phase can be either `end` or `error`. Recording
    // the `error` form as a failure would settle a /stop-ed turn as
    // `failed{reason:"turn-failed", retryable:true}` — mislabelling a
    // deliberate cancellation and offering to re-run work the user just
    // stopped. `cancelled` is the right outcome and needs a wire value that
    // does not exist yet, so an aborted run keeps the pre-existing `ok` until
    // #89 adds one. This turn deliberately does NOT change /stop behaviour.
    if (agentRunVerdicts.size >= MAX_TRACKED_RUNS && !agentRunVerdicts.has(runId)) {
      const oldest = agentRunVerdicts.keys().next();
      if (!oldest.done) agentRunVerdicts.delete(oldest.value);
    }
    const aborted = data?.aborted === true;
    agentRunVerdicts.set(runId, phase === "error" && !aborted ? "error" : "ok");
  });
}

/** Release the lifecycle subscription and drop any verdicts still pending. */
export function stopAgentLifecycleSubscription(): void {
  lifecycleUnsubscribe?.();
  lifecycleUnsubscribe = undefined;
  agentRunVerdicts.clear();
  // #93: host teardown draws a new approval-origin barrier. Any request the
  // gateway replays from BEFORE this point can no longer be attributed to a
  // live run, so it is refused rather than matched against whatever is running
  // after the reload. Rotation deliberately does NOT drop active claims: the
  // queue lets a running handler settle instead of aborting it
  // (`inbound-queue.ts:393`), and that handler still owns its lease until its
  // own `finally` — it can still legitimately emit approvals for requests it
  // creates after the new barrier.
  //
  // Swallowed on failure: the getter throws when the versioned global slot holds
  // an incompatible registry, and a teardown that cannot rotate must not take
  // the rest of the host's cleanup down with it. That condition is never silent
  // overall — the same getter throws loudly at `startAgentLifecycleSubscription`
  // and on every turn, which is where it is actionable.
  try {
    getApprovalOriginRegistry().rotateEpoch();
  } catch {
    /* teardown continues */
  }
}

/**
 * Handle one inbound user message from the browser widget.
 *
 * Phase 0 inbound path (walking skeleton) — proper channel inbound lifecycle:
 *  1. Resolve the agent route for this channel + peer via
 *     `runtime.channel.routing.resolveAgentRoute(...)`. This honours the
 *     configured dmScope/bindings and yields a channel-scoped `sessionKey`
 *     (e.g. carrying `webchannel`), instead of `buildAgentSessionKey(...)`
 *     which defaults `dmScope` to `"main"` and collapses the key to
 *     `agent:main:main`, discarding channel + peer.
 *  2. Run the turn through `runtime.channel.inbound.run({ adapter })`. The
 *     adapter's `resolveTurn` returns a fully assembled `AssembledChannelTurn`
 *     built from runtime-provided pieces (`recordInboundSession`,
 *     `dispatchReplyWithBufferedBlockDispatcher`, `resolveStorePath`, and the
 *     context payload from `inbound.buildContext`). The kernel RECORDS the
 *     inbound session/route first, then dispatches the reply.
 *  3. The agent reply is delivered back through THIS channel via the turn's
 *     `delivery.deliver(payload)` adapter — the proper inbound delivery seam.
 *     We forward `payload.text` to the live WebSocket for the originating peer.
 *
 * Because `delivery.deliver` is a closure over the originating `peerId`, the
 * socket-map key always matches: we never depend on a core-recorded `ctx.to`
 * value lining up with the map. The transport now keys sockets by the verified
 * per-peer id (the anonymous strategy is just the single-peer special case),
 * and the recorded `reply.to` carries that same peer, so per-peer routing
 * flows through this seam unchanged.
 *
 * This mirrors the bundled SMS channel's inbound path
 * (`dist/extensions/sms/channel-plugin-api.js`, `channelRuntime.inbound.run`).
 *
 * Verified signatures (OpenClaw v2026.6.6):
 *  - api.runtime.channel.routing.resolveAgentRoute(input): ResolvedAgentRoute
 *      dist/plugin-sdk/resolve-route-BCF-LST9.d.ts:46 / :11-29
 *  - api.runtime.channel.inbound.run = runChannelInboundEvent(params:
 *      RunChannelTurnParams<TRaw>): dist/types-C0dQmare.d.ts:6111-6116,
 *      dist/plugin-sdk/types-BVAOMoZy.d.ts:5894-5900 (RunChannelTurnParams),
 *      :5885-5892 (ChannelTurnAdapter), :5799-5823 (AssembledChannelTurn).
 *  - api.runtime.channel.inbound.buildContext = buildChannelInboundEventContext:
 *      dist/plugin-sdk/types-BVAOMoZy.d.ts:5924-5947 (params), :5953 (result).
 *  - api.runtime.channel.session.{recordInboundSession,resolveStorePath}:
 *      dist/types-C0dQmare.d.ts:6075,6078.
 *  - api.runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher:
 *      dist/types-C0dQmare.d.ts:6022.
 *  - ChannelEventDeliveryAdapter.deliver(payload: ReplyPayload, info):
 *      dist/plugin-sdk/types-BVAOMoZy.d.ts:5760-5769; ReplyPayload.text:
 *      dist/plugin-sdk/types-BYvUZFDr.d.ts:8-9.
 */
export async function handleInboundMessage(
  api: OpenClawPluginApi,
  transport: WebChannelPeerChannel,
  peerId: string,
  message: InboundUserMessage,
  accountId: string = DEFAULT_WEBCHANNEL_ACCOUNT_ID,
  options?: { controlLane?: boolean },
): Promise<void> {
  // `wsKey` is the verified per-peer id the transport uses as its socket-map
  // key (the anonymous strategy is the single-peer special case, where this
  // falls back to ANON_PEER_ID).
  const wsKey = peerId || ANON_PEER_ID;

  /** The agent run this turn owns, learned from `onAgentRunStart`. */
  let agentRunId: string | undefined;

  // Control lane (P1-8a): an out-of-band abort turn ("/stop"). It reaches here
  // directly (NOT via the per-session FIFO) so core's fast-abort can cancel the
  // still-live running turn — see `src/control-lane.ts` and index-nats.ts. Two
  // things differ for a control-lane turn: (1) no progress draft — the abort's
  // reply is a single short final text, so a "Working…" bubble for it is noise;
  // (2) we stamp CommandAuthorized on the turn context (see the buildContext
  // call) so core's fast-abort accepts it.
  const controlLane = options?.controlLane === true;
  const turnId =
    message.id ??
    `webchannel-turn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  let draft: ProgressDraftController | undefined;
  let reasoning: ReasoningDraftController | undefined;
  let finalReplyDelivered = false;
  let turnOutcome: "ok" | "error" = "ok";
  // #87: a provider-rejected turn does NOT throw — core absorbs the failure and
  // returns its terminal error as an ordinary `isError` reply payload, so the
  // `catch` below never runs and the turn would settle `ok`. These two track the
  // turn's ANSWER, which is what the outcome actually means (see the settle
  // computation in `finally`).
  let answerDelivered = false;
  let terminalErrorSeen = false;
  // Final reconciliation is deliberately independent of block callback counts
  // and of `answerDelivered` (which also tracks actual block output for #87).
  // Only the first ordinary, non-notice final before a leading terminal error
  // consumes the current assistant lane.
  const finalReconciliation: FinalReconciliationState = {
    ordinaryAnswerFinalSeen: false,
    leadingTerminalErrorSeen: false,
  };
  // Ordinary messages have already been ACKed by ingress and therefore need one
  // settled outcome even when setup fails. Control-lane turns never settle; an
  // explicit DM denial opts out below because no agent turn was admitted.
  let settlementEligible = !controlLane;
  /**
   * #93: this turn's approval-origin lease, held for exactly the window in
   * which the agent run can emit a tool approval. Declared out here because the
   * `finally` below must be able to release it — a `let` inside the `try` would
   * not be in scope there.
   */
  let originLease: ApprovalOriginLease | undefined;

  try {
    const channelRuntime = api.runtime.channel;

  // Progress-draft wiring (Phase 1 first slice). Core does NOT auto-drive a
  // plugin's `message.live` adapter; the generic seam for a plugin channel is
  // the inbound turn's reply dispatcher callbacks. We build a per-turn draft
  // controller and hook `onToolStart`/`onItemEvent`/`onPartialReply`
  // (GetReplyOptions, dist/plugin-sdk/types-BYvUZFDr.d.ts:274-304) via the turn's
  // `replyOptions` (Omit<GetReplyOptions,"onBlockReply">, AssembledChannelTurn,
  // dist/plugin-sdk/types-BVAOMoZy.d.ts:5813). Each event refreshes a single
  // rolling draft pushed to the widget as a `progress` frame; the final answer
  // (delivered through `delivery.deliver`) finalizes that same draft id.
  //
  // `channels.webchannel.streaming.mode` selects WHAT streams, mirroring core's
  // own distinction (`onPartialReply` is wired only when `draftStream &&
  // !isProgressMode`, verified: dist/message-handler.process-CcPQD8zK.js:1357):
  //  - "partial": stream ANSWER TEXT. Draft is created; `onPartialReply` feeds
  //    `pushAnswerText`, and tool/item events stay wired too, so a mixed turn
  //    shows "Working… + tool lines" until the first answer text arrives, then
  //    the answer text replaces the scaffold in the same draft.
  //  - "progress": tool-lines-only. Draft is created but `onPartialReply` is
  //    NOT wired — answer text never streams (the deliberate mode distinction).
  //  - "block"/"off": NO draft. Falls through to the plain no-id `agent_message`
  //    atomic append (see delivery.deliver below); `replyOptions` is omitted.
  // 가-1 Cycle 2: read the PER-ACCOUNT resolved config (channel-level shared
  // base merged under this account's override), not the flat block, so each
  // account's streaming/dmSecurity/allowFrom apply to its own turns. For the
  // single `"default"` account this is identical to the flat block (regression).
  const channelConfig = resolveWebchannelAccountConfig(api.config, accountId);

  // DM allowlist admission (split-authz, plugin-owned half). When the operator
  // sets `channels.webchannel.dmSecurity: "allowlist"`, a non-allowlisted peer
  // is denied here — BEFORE the agent turn runs — so `inbound.run` is never
  // invoked and no reply is emitted (default-deny). With no `dmSecurity` set,
  // admission is open, preserving the shipping Gateway-WS behavior.
  const cc = channelConfig as { allowFrom?: readonly string[]; dmSecurity?: string } | undefined;
  const admission = resolveDmAdmission(wsKey, {
    allowFrom: cc?.allowFrom,
    dmSecurity: cc?.dmSecurity,
  });
  if (!admission.allowed) {
    settlementEligible = false;
    api.logger?.info?.(
      `webchannel: inbound denied for peer ${wsKey} (${admission.reason}); turn not dispatched`,
    );
    return;
  }

  // Draft enabled for the two streaming modes ("progress" tool-lines-only,
  // "partial" answer-text); answer-text streaming (onPartialReply) is wired
  // ONLY in "partial" mode. "block"/"off" take the no-draft fallback.
  const streamingMode = resolveStreamingMode(channelConfig);
  const draftEnabled =
    (streamingMode === "progress" || streamingMode === "partial") && !controlLane;
  const answerStreamingEnabled = streamingMode === "partial";
  if (draftEnabled) {
    draft = createProgressDraftController({
      transport,
      sessionKey: wsKey,
      turnId,
      channelConfig,
      logger: api.logger,
    });
  }
  // Reasoning lane is created AFTER route resolution (below), once we can resolve
  // the session's reasoning display level.

  // Resolve the channel-scoped agent route, then FORCE the per-account-channel-
  // peer session scope (see `resolveWebchannelSessionRoute`). Binding-based agent
  // routing is preserved (`agents bind --agent X --bind webchannel:<account>`
  // still routes THIS account's inbound to agent X), but the session key NEVER
  // inherits the operator's global `session.dmScope="main"` — every user's uuid
  // gets its OWN agent session, so the cross-user transcript leak on the history
  // snapshot / load_history read paths cannot happen. This is the WRITE site: the
  // turn is dispatched under this key, and the history READ sites resolve the
  // SAME key via the SAME helper, so paging/snapshot stay consistent.
  const route = resolveWebchannelSessionRoute(api, accountId, wsKey);

  // #93: build this turn's approval-origin lease handle. Creating it claims
  // NOTHING — `activate()` in `onAgentRunStart` is what publishes the claim, so
  // a turn that is denied or fails setup before the agent run starts can never
  // leave a claim behind that absorbs someone else's approval.
  //
  // EVERY turn gets a handle, including the control lane. A `/stop` turn is
  // exempt from being SELECTABLE as an origin, not from being recorded: when
  // core's fast-abort finds nothing to consume, the control-lane message falls
  // through to an ordinary agent turn that can call tools and request approvals.
  // Leaving that run unrecorded would hide it from the overlap poison, and a
  // request it created could then be answered with a DIFFERENT peer's claim on
  // the same session key (`session.identityLinks` collapses distinct peers onto
  // one key). `evidence: "presence"` records the run while keeping it
  // permanently unselectable.
  //
  // The registry is fetched per turn and never cached in a module-level
  // variable: a cache-busted reload would pin a stale reference, and old and new
  // module generations would then see different claims — the exact split the
  // versioned process-global slot exists to prevent.
  //
  // `accountId` goes in VERBATIM. The claim's account is compared byte-for-byte
  // at resolve time, so normalizing here would let an alias account satisfy a
  // lookup it did not originate.
  originLease = getApprovalOriginRegistry().createLease({
    rawAccountId: accountId,
    sessionKey: route.sessionKey,
    peerId: wsKey,
    evidence: controlLane ? "presence" : "origin",
  });

  // Reasoning display policy (CHANNEL-OWNED). OpenClaw's plugin dispatch path
  // forwards `onReasoningStream` with no reasoning-level gate of its own (ACP
  // always snapshots; btw emits at any level != "off" — dist/run-attempt
  // -DRhLt3eF.js:4114-4117, dist/btw-CDO5476N.js:617-627), so the CHANNEL decides
  // whether reasoning reaches the browser. Mirroring the Telegram reference
  // (streams only at "stream", suppresses at "off" — dist/bot-Dxj27QDQ.js:6441,
  // :6582), we wire the lane ONLY when the resolved session reasoning level is
  // "stream". Resolution is session-store-first, fail-closed to "off" on a store
  // read error, with the `agents.*.reasoningDefault` config default otherwise
  // (see reasoning-level.ts). Default is "off": no ambient reasoning ever streams
  // to a widget unless the operator/session explicitly opted into "stream". The
  // control lane (/stop) never opens a reasoning lane while aborting another turn.
  if (!controlLane) {
    const reasoningLevel = resolveWebchannelReasoningLevel({
      cfg: api.config,
      agentId: route.agentId,
      sessionKey: route.sessionKey,
    });
    if (reasoningLevel === "stream") {
      reasoning = createReasoningDraftController({ transport, sessionKey: wsKey, turnId });
    }
  }

  // Native "Bot is typing…" affordance. We push the frame right after route
  // resolution and right before agent dispatch (1) so the widget sees the
  // indicator as soon as the turn has been accepted — even before the first
  // `progress` / `agent_message` / `approval_*` frame, which can take seconds
  // on a long-running tool call — and (2) regardless of which turn exit path
  // the dispatch takes (the inner try/catch can still throw). The first real
  // frame from the agent settles the indicator client-side; we never send a
  // matching "stop" frame.
  //
  // The transport gates the frame on `channels.webchannel.capabilities.typing`
  // (default "on"), so when an operator sets it to "off" this call is a no-op.
  // It is also best-effort (no ack/retry) and drop-only under backpressure —
  // we ignore the boolean return.
  //
  // Control lane (P1-8a): NEVER emit typing for an abort turn. An abort is not
  // the agent "thinking about a reply" — it cancels the turn already in flight,
  // and its own reply is a single short final ("⚙️ Agent was aborted."). Two
  // concrete harms if we flashed typing here: (1) it visually contradicts the
  // Stop the user just pressed (the widget is trying to WIND DOWN, not spin up);
  // and (2) the widget holds its Stop button armed until a settling frame
  // arrives — on the paths where the abort's own ack is never delivered (core
  // returns handled:false for an unauthorized sender; see the allowlist trap in
  // command-gate.ts / index-nats.ts), a typing frame with no follow-up would
  // leave the button stuck in Stop mode with nothing to release it. Skipping
  // typing keeps the abort lane silent unless it has a real terminal frame.
  if (!controlLane) {
    transport.sendTyping(wsKey);
  }

    await channelRuntime.inbound.run({
      channel: WEBCHANNEL_ID,
      accountId,
      raw: message,
      adapter: {
        ingest: (raw) => ({
          id: `webchannel-${Date.now()}`,
          timestamp: Date.now(),
          rawText: raw.text,
          textForAgent: raw.text,
          textForCommands: raw.text,
          raw,
        }),
        resolveTurn: (input) => {
          const ctxPayload = channelRuntime.inbound.buildContext({
            channel: WEBCHANNEL_ID,
            // S1: stamp the serving account on the turn context. Core copies
            // this into `ctx.AccountId` → the agent-run request's `accountId`
            // → the approval request's `turnSourceAccountId`, which is what
            // lets each account's native approval handler claim ONLY its own
            // turns' approvals (and the prompt deliver on the right channel).
            accountId,
            // Control lane (P1-8a): stamp CommandAuthorized for THIS turn only.
            // Core's fast-abort (`tryFastAbortFromMessage`) runs before the
            // per-session busy gate but requires `resolveCommandAuthorization`'s
            // `isAuthorizedSender`, which with no `commands.allowFrom` reduces to
            // `ctx.CommandAuthorized`. `buildContext` sets that to false unless
            // `access.commands.authorized` is passed. We stamp it ONLY on the
            // abort lane (not every turn) so we don't broadly enable text
            // commands for every peer. It is safe here because webchannel peers
            // are JWT-authenticated with FORCED per-peer session isolation
            // (`resolveWebchannelSessionRoute`) — an abort can only ever target
            // the sender's OWN session, never another peer's.
            ...(controlLane
              ? { access: { commands: { authorized: true } } }
              : {}),
            timestamp: input.timestamp,
            from: wsKey,
            sender: { id: wsKey, name: wsKey },
            conversation: { kind: "direct", id: wsKey, label: wsKey },
            route: {
              agentId: route.agentId,
              routeSessionKey: route.sessionKey,
              dispatchSessionKey: route.sessionKey,
            },
            // Record a stable reply target for this peer. Delivery itself uses
            // the captured `wsKey` (below), so this `to` only needs to be a
            // stable per-peer identifier for route recording.
            reply: { to: wsKey },
            message: {
              rawBody: input.rawText,
              commandBody: input.textForCommands,
              bodyForAgent: input.textForAgent,
            },
          });

          const storePath = channelRuntime.session.resolveStorePath(
            api.config.session?.store,
            { agentId: route.agentId },
          );

          return {
            cfg: api.config,
            channel: WEBCHANNEL_ID,
            agentId: route.agentId,
            routeSessionKey: route.sessionKey,
            storePath,
            ctxPayload,
            recordInboundSession: channelRuntime.session.recordInboundSession,
            dispatchReplyWithBufferedBlockDispatcher:
              channelRuntime.reply.dispatchReplyWithBufferedBlockDispatcher,
            // `replyOptions` is UNCONDITIONAL — it is present on every turn,
            // including block/off streaming and the control lane, because
            // `onAgentRunStart` (below) must fire for all of them. Only the
            // reasoning and draft callbacks inside it are conditional, each on
            // its own lane having opened.
            replyOptions: {
                    // #87: always wired, on every turn and every streaming mode
                    // — this is how the turn learns which agent run's lifecycle
                    // terminal is its own.
                    //
                    // #93: it is also the exact moment the run becomes able to
                    // emit a tool approval, which is why the origin lease is
                    // activated HERE and not at dispatch. `activate()` is
                    // idempotent, so the repeated callbacks core emits under
                    // model fallback claim once. A control-lane turn that got
                    // this far is a real agent run and claims too — as
                    // `presence`, so it is recorded but never selectable.
                    onAgentRunStart: (runId) => {
                      agentRunId = runId;
                      originLease?.activate();
                    },
                    // Reasoning callbacks are wired iff the lane opened above.
                    ...(reasoning
                      ? {
                          onReasoningStream: (p) => reasoning!.push(p),
                          onReasoningEnd: () => reasoning!.endBurst(),
                        }
                      : {}),
                    // Progress-draft callbacks (only when a draft exists, i.e.
                    // streaming.mode "progress"/"partial"). These fire DURING the
                    // agent run and feed the rolling draft. We also set
                    // `suppressDefaultToolProgressMessages` so the agent's own tool
                    // progress text isn't ALSO delivered as separate messages (it
                    // lives inside our draft instead — GetReplyOptions
                    // .suppressDefaultToolProgressMessages, dist/plugin-sdk/
                    // types-BYvUZFDr.d.ts:261-265).
                    ...(draft
                      ? {
                          suppressDefaultToolProgressMessages: true,
                          onToolStart: (p) => {
                            draft!.pushEvent({
                              event: "tool",
                              itemId: p.itemId,
                              toolCallId: p.toolCallId,
                              name: p.name,
                              phase: p.phase,
                              args: p.args,
                            });
                          },
                          onItemEvent: (p) => {
                            draft!.pushEvent({
                              event: "item",
                              itemId: p.itemId,
                              itemKind: p.kind,
                              title: p.title,
                              name: p.name,
                              phase: p.phase,
                              status: p.status,
                              summary: p.summary,
                              progressText: p.progressText,
                              meta: p.meta,
                            });
                          },
                          // Answer-text streaming remains PARTIAL MODE ONLY.
                          ...(answerStreamingEnabled
                            ? {
                                onPartialReply: (p) => {
                                  draft!.pushAnswerText({
                                    text: p.text,
                                    delta: p.delta,
                                    replace: p.replace,
                                  });
                                },
                                onAssistantMessageStart: () => {
                                  draft!.handleAssistantMessageBoundary();
                                },
                                onBlockReplyQueued: (payload, context) => {
                                  draft!.noteBlockReplyQueued({
                                    assistantMessageIndex: context?.assistantMessageIndex,
                                    ...noticeFlagsOf(payload),
                                  });
                                },
                              }
                            : {}),
                        }
                      : {}),
            },
            ...(draft
              ? {
                  dispatcherOptions: {
                    onSkip: (payload, info) => {
                      draft!.noteDeliveryLifecycle("skip", {
                        deliveryKind: info.kind,
                        assistantMessageIndex: info.assistantMessageIndex,
                        ...noticeFlagsOf(payload),
                      });
                    },
                    onBeforeDeliverCancelled: (payload, info) => {
                      draft!.noteDeliveryLifecycle("cancel", {
                        deliveryKind: info.kind,
                        assistantMessageIndex: info.assistantMessageIndex,
                        ...noticeFlagsOf(payload),
                      });
                    },
                    onDeliverySettled: (info) => {
                      draft!.noteDeliveryLifecycle("settled", {
                        deliveryKind: info.kind,
                        assistantMessageIndex: info.assistantMessageIndex,
                      });
                    },
                  },
                }
              : {}),
            // THIS channel's outbound delivery seam. Forward the assembled reply
            // text to the originating widget's live socket. Draft-mode blocks
            // and non-ordinary finals use the controller's independent delivery
            // path; only the first ordinary final settles the current lane.
            delivery: {
              deliver: async (payload, info) => {
                const kind = info.kind;
                const noticeFlags = noticeFlagsOf(payload);
                const isNotice = isCoreNoticePayload(payload);
                const text = payload.text;
                if (!text) return { visibleReplySent: false };
                // #87: classify this final payload for the turn outcome.
                //
                // `isError` alone is NOT the verdict: core flags BOTH a terminal
                // failure and a merely non-terminal tool-error warning with it.
                // Core distinguishes them itself and exposes the answer through
                // `isReplyPayloadNonTerminalToolErrorWarning`, so we read core's
                // classification rather than infer one.
                //
                // The marker is NOT sufficient on its own. At 2026.6.10 core
                // only sets it for MIDDLEWARE tool errors
                // (`shouldMarkNonTerminalToolErrorWarning = middlewareError ===
                // true`, payloads-*.js:77), so an ordinary tool warning is
                // `isError` with no marker at all. It is also WeakMap-backed
                // metadata rather than a payload field, so a host and plugin
                // resolving different copies of the openclaw module would make
                // the lookup silently return false.
                //
                // `!answerDelivered` carries those cases. Core builds the payload
                // array as [terminal error?, ..., answers..., tool warning?]
                // (payloads-*.js:180/:251/:285) and the dispatcher sends every
                // element (dispatch-*.js:1966), so a terminal error PRECEDES the
                // answer while a warning FOLLOWS it: an error arriving after an
                // answer is a warning even when unmarked.
                //
                // Block payloads count as answer output for exactly that reason.
                // They are visible assistant text, and when core streams the
                // answer as blocks a trailing unmarked tool warning would
                // otherwise be the only `final` and read as a terminal failure —
                // reporting an answered (possibly mutating) turn as failed and
                // offering a retry. Counting them keeps a block-streamed turn no
                // worse than it was before this fix. The cost is that partial
                // block output followed by a real terminal failure still settles
                // `ok`; that is the pre-existing #87 shape, not a new regression,
                // and closing it needs a turn-level terminal signal this seam
                // does not carry. Tool payloads are tool chatter, never an answer.
                //
                // Status/fallback/compaction notices are core's own chatter and
                // never count as the turn's answer.
                if (kind === "final" || kind === "block") {
                  if (payload.isError === true) {
                    // Only a FINAL error can be the turn's verdict; a block-level
                    // error is interim streamed content, not a settlement.
                    if (
                      kind === "final" &&
                      !isReplyPayloadNonTerminalToolErrorWarning(payload) &&
                      !answerDelivered
                    ) {
                      terminalErrorSeen = true;
                    }
                  } else if (!isNotice) {
                    answerDelivered = true;
                  }
                }
                // P0-4 DECISION: `visibleReplySent:false` (a final-frame send that
                // failed) does NOT suppress the later `turn_settled{outcome:"ok"}`
                // — the turn genuinely settled without error, so the client's
                // send-receipt correctly reaches `completed` (it tracks the USER
                // message's fate, not answer delivery). The dropped answer text is
                // recovered by the register-time history snapshot (recovery lanes
                // §5 L3/L6), never by faking the turn outcome.
                if (draft && kind === "block") {
                  const sent = await draft.deliverAuthorizedBlock({
                    text,
                    ...noticeFlags,
                  });
                  return { visibleReplySent: sent };
                }
                if (draft && kind === "final") {
                  const { sent } = await deliverDraftFinalPayload(
                    draft,
                    payload,
                    text,
                    finalReconciliation,
                  );
                  if (sent) finalReplyDelivered = true;
                  return { visibleReplySent: sent };
                }
                const sent = transport.sendText(wsKey, text, undefined, turnId);
                if (sent && kind === "final") finalReplyDelivered = true;
                return { visibleReplySent: sent };
              },
              onError: (_error, info) => {
                draft?.noteDeliveryLifecycle("error", {
                  deliveryKind: info.kind,
                });
              },
            },
          };
        },
      },
    });

    // A clean resolve can have no final delivery (abort, tool-only, or a silent
    // completion). The controller owns terminal cleanup because `started` and
    // `snapshotText()` describe different state under the lane model: drain
    // retires tentative barriers, settles real lane text in generation order,
    // and settles a lone unclaimed tool preview only for the no-delete case.
    await draft?.drain();
  } catch (err) {
    turnOutcome = "error";
    api.logger.error?.(`webchannel: inbound dispatch failed: ${String(err)}`);
    // Surface a thrown turn independently before terminal cleanup. That gives
    // the apology the first claim attempt on an ownerless tool preview without
    // replacing any assistant lane that already streamed real text. A turn
    // whose final was delivered already needs no appended apology; the drain
    // below remains its idempotent terminal cleanup.
    if (draft) {
      try {
        if (!finalReplyDelivered) {
          await draft.deliverIndependentFinal({
            text: "Sorry — something went wrong while answering. Please try again.",
          });
        }
        await draft.drain();
      } catch (drainErr) {
        api.logger.error?.(
          `webchannel: draft error-drain failed: ${String(drainErr)}`,
        );
      }
    } else if (!controlLane && !finalReplyDelivered) {
      const sent = transport.sendText(
        wsKey,
        "Sorry — something went wrong while answering. Please try again.",
        undefined,
        turnId,
      );
      if (!sent) {
        api.logger?.warn?.(
          `webchannel: error fallback reply was not delivered for peer=${wsKey} turn=${turnId}`,
        );
      }
    }
  } finally {
    // #93: FIRST, so no throw from the cleanup below can skip it. The lease is
    // the only thing keeping this run's claim in the registry, and a claim that
    // outlives its run poisons its tuple for every later origin on the same
    // key. Normal return, throw, provider error and abort all pass through
    // here; the claim is removed by its own id, so a run retained across a
    // teardown rotation releases only itself.
    originLease?.release();
    // Always halt the throttled draft loop so a late background flush can't race
    // the error handling (or linger after a normal finalize). Idempotent and a
    // no-op when no draft was created or it was already stopped by finalize().
    draft?.stop();
    reasoning?.stop();
    // #87: settle `error` when core handed us a terminal failure instead of an
    // answer (see the classification in the delivery seam). This only ever
    // ASSIGNS `"error"`, so it can never downgrade the `catch` above. A turn
    // that answers nothing and never errored (tool-only work, an empty or
    // suppressed reply) stays `ok`: silence is a legitimate clean completion.
    //
    // A terminal error that arrives BEFORE partial answer text still wins — the
    // turn failed, and partial output is not a completed answer.
    //
    // This is distinct from the `visibleReplySent:false` decision at the
    // delivery seam: that one is about our transport failing to ship an answer
    // the turn DID produce, which is recovered by the history snapshot. This is
    // about the turn producing no answer at all.
    // #87: core's own verdict for this turn's agent run decides the outcome.
    // It is authoritative — it separates the two payload shapes this seam
    // cannot (an answered turn reporting a failed mutating tool vs an answered
    // turn that then timed out), so when it is present the payload heuristics
    // below are not consulted at all.
    const verdict = agentRunId ? agentRunVerdicts.get(agentRunId) : undefined;
    if (agentRunId) agentRunVerdicts.delete(agentRunId);
    if (verdict === "error") {
      turnOutcome = "error";
    } else if (verdict === undefined && terminalErrorSeen) {
      // No verdict: the turn never started an agent run (a command-only turn),
      // or the terminal event has not landed. Fall back to the payload-shape
      // reading, which is what shipped before the verdict existed. It is the
      // ambiguous path — it favors `ok` on an answered turn so that a success
      // is never reported as a failure with a retry that could repeat a
      // mutation. See the classification comment in the delivery seam.
      turnOutcome = "error";
    }
    // A `verdict === "ok"` never downgrades the `catch` above: this block only
    // ever ASSIGNS "error".
    if (settlementEligible) {
      // #99: this turn may be the merge of N buffered user messages (P1-8b layer
      // (b) coalescing). Each of them was ACKed and holds its own P0-4 receipt,
      // and only a `turn_settled` naming that exact wireId can move it off
      // `accepted` — the client's `promoteAnchor` matches strictly on the id.
      // Settling only the anchor strands the other N-1 receipts forever, so we
      // settle EVERY member with THIS turn's outcome: the group ran as one turn,
      // so it succeeded or failed as one.
      //
      // No protocol change and no client change: `turn_settled{turnId,outcome}`
      // already exists, and an already-deployed client promotes whichever
      // receipt each frame names (`finalizeDraftsForTurn` is a no-op for a
      // non-anchor id — drafts and `agent_message` frames only ever carry the
      // anchor turnId).
      //
      // Anchor LAST, exactly once each: the anchor is the id the UI ends the
      // turn on, so the member frames must not trail it.
      //
      // The member list is read through `readCoalescedMemberIds`, which cannot
      // throw and cannot return an unbounded or non-string list. That matters
      // here specifically: this loop runs BEFORE the anchor is pushed, so a
      // throw would emit ZERO settle frames — the dispatcher swallows the
      // rejection and every receipt in the turn, anchor included, would be
      // stranded at `accepted`.
      const settleIds: string[] = [];
      const seenSettleIds = new Set<string>([turnId]);
      for (const memberId of readCoalescedMemberIds(message)) {
        if (seenSettleIds.has(memberId)) continue;
        seenSettleIds.add(memberId);
        settleIds.push(memberId);
      }
      settleIds.push(turnId);
      for (const settleId of settleIds) {
        // One frame must never take the group down with it. `transport` is an
        // interface: the shipped channel wraps its publish and returns a
        // boolean, but a throwing implementation here would skip every id still
        // queued — including the ANCHOR, which is emitted last — and the throw
        // would escape from a `finally` (masking any in-flight error) into the
        // dispatcher's `.catch(() => {})`. A thrown send is treated exactly like
        // a `false` one: warn, then keep settling.
        let delivered = false;
        try {
          delivered = transport.sendTurnSettled(wsKey, settleId, turnOutcome);
        } catch {
          delivered = false;
        }
        if (!delivered) {
          api.logger?.warn?.(
            `webchannel: turn_settled was not delivered for peer=${wsKey} turn=${settleId} outcome=${turnOutcome}`,
          );
        }
      }
    }
  }
}
