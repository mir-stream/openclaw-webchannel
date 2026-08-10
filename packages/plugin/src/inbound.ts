import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-core";
import { isReplyPayloadNonTerminalToolErrorWarning } from "openclaw/plugin-sdk/reply-payload";

import { WEBCHANNEL_ID, ANON_PEER_ID } from "./channel-contract.js";
import type { WebChannelPeerChannel, InboundWsMessage } from "./channel-contract.js";
import { resolveDmAdmission } from "./dm-allowlist.js";
import { DEFAULT_WEBCHANNEL_ACCOUNT_ID, resolveWebchannelAccountConfig } from "./account-config.js";
import { resolveWebchannelSessionRoute } from "./session-route.js";
import { resolveWebchannelReasoningLevel } from "./reasoning-level.js";

/** The inbound path only handles user messages; approvals route separately. */
type InboundUserMessage = Extract<InboundWsMessage, { type: "user_message" }>;
import {
  resolveStreamingMode,
  createProgressDraftController,
  createReasoningDraftController,
} from "./message-adapter.js";
import type {
  ProgressDraftController,
  ReasoningDraftController,
} from "./message-adapter.js";

/**
 * Core's own chatter — a status/fallback/compaction notice — as opposed to the
 * assistant's answer. Used by all three seams that must agree on the
 * distinction: the #87 turn-outcome classification, the partial-mode block
 * swallow, and the draft lane's block recording.
 */
function isCoreNoticePayload(payload: {
  isStatusNotice?: boolean;
  isFallbackNotice?: boolean;
  isCompactionNotice?: boolean;
}): boolean {
  return Boolean(
    payload.isStatusNotice || payload.isFallbackNotice || payload.isCompactionNotice,
  );
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
  // Ordinary messages have already been ACKed by ingress and therefore need one
  // settled outcome even when setup fails. Control-lane turns never settle; an
  // explicit DM denial opts out below because no agent turn was admitted.
  let settlementEligible = !controlLane;

  try {
    const channelRuntime = api.runtime.channel;

  // Progress-draft wiring (Phase 1 first slice). Core does NOT auto-drive a
  // plugin's `message.live` adapter; the generic seam for a plugin channel is
  // the inbound turn's reply dispatcher callbacks. We build a per-turn draft
  // controller and hook `onToolStart`/`onItemEvent`/`onPartialReply`
  // (GetReplyOptions, dist/plugin-sdk/types-BYvUZFDr.d.ts:274-304) via the turn's
  // `replyOptions` (Omit<GetReplyOptions,"onBlockReply">, AssembledChannelTurn,
  // dist/plugin-sdk/types-BVAOMoZy.d.ts:5813). Each event refreshes the ACTIVE
  // draft lane, pushed to the widget as a `progress` frame; each completed
  // assistant message settles into its own bubble at its own id, and the final
  // answer (delivered through `delivery.deliver`) settles the last lane (#94).
  //
  // `channels.webchannel.streaming.mode` selects WHAT streams, mirroring core's
  // own distinction (`onPartialReply` is wired only when `draftStream &&
  // !isProgressMode`, verified: dist/message-handler.process-CcPQD8zK.js:1357):
  //  - "partial": stream ANSWER TEXT. Draft is created; `onPartialReply` feeds
  //    `pushAnswerText`, and tool/item events stay wired too, so a mixed turn
  //    shows "Working… + tool lines" until the first answer text arrives, then
  //    the answer text replaces the scaffold in the FIRST lane. The
  //    message-boundary callbacks (`onBlockReplyQueued`,
  //    `onAssistantMessageStart`) are wired here too, so a multi-message reply
  //    settles one bubble per assistant message.
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
      // Lane rotations emit a diagnostic (never silent — §6.5.1).
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
            // `replyOptions` exists ONLY when this turn has a live lane to feed:
            // the reasoning lane (resolved level "stream") and/or the answer/tool
            // draft (progress/partial mode). When NEITHER is active — block/off
            // with no "stream" reasoning, and every control-lane turn — the whole
            // key is omitted, restoring the pre-reasoning-lane block/off shape.
            replyOptions: {
                    // #87: always wired, on every turn and every streaming mode
                    // — this is how the turn learns which agent run's lifecycle
                    // terminal is its own.
                    onAgentRunStart: (runId) => {
                      agentRunId = runId;
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
                          // These three callbacks are the message-boundary axis
                          // (#94): each completed assistant message settles into
                          // its OWN bubble id instead of being merged into one
                          // turn-wide draft. `onBlockReplyQueued` is wired here
                          // and NOT in progress mode, where the answer is atomic
                          // and recording blocks would change behaviour.
                          ...(answerStreamingEnabled
                            ? {
                                onPartialReply: (p) => {
                                  draft!.pushAnswerText({
                                    text: p.text,
                                    delta: p.delta,
                                    replace: p.replace,
                                  });
                                },
                                // `BlockReplyContext.assistantMessageIndex`
                                // (dist/plugin-sdk/types-DNy-f8Hr.d.ts:172) is
                                // the only place the plugin contract exposes a
                                // per-message identity — core populates it from
                                // payload metadata and AWAITS this callback
                                // before the async delivery drains
                                // (dist/dispatch-B2e1grFo.js:1868-1872). The
                                // delivery seam's `ChannelDeliveryInfo` is
                                // `{ kind }` and has no index, so this is where
                                // the controller learns which message a block
                                // belongs to.
                                onBlockReplyQueued: (payload, context) => {
                                  // Core's own notices reach this callback the
                                  // same way an answer block does, but they are
                                  // not assistant text. Recording one would let
                                  // it become a partial-less lane's settled
                                  // body — a status notice promoted to a
                                  // completed assistant message (§2/§7). They
                                  // still reach the user: `deliver` sends them
                                  // on the plain path (see the block swallow).
                                  if (isCoreNoticePayload(payload)) return;
                                  draft!.recordQueuedBlock({
                                    text: payload.text,
                                    assistantMessageIndex: context?.assistantMessageIndex,
                                  });
                                },
                                // NOTE: the two runners THIS channel's turns go
                                // through latch this to fire ONCE PER RUN, not
                                // once per assistant message: ACP sets
                                // `assistantStarted` at
                                // dist/run-attempt-DRhLt3eF.js:4083-4085 (reset
                                // nowhere but its constructor, :3876) and btw at
                                // dist/btw-CDO5476N.js:564/:597-599. A third
                                // path in the bundle DOES fire it per message
                                // (dist/selection-BfRwHcjH.js:3788-3793 and
                                // :3860-3865, wired :13601, reached from
                                // dist/embedded-agent-BgF2MOkH.js:3092). On our
                                // paths it therefore lands at the first delta,
                                // when the lane is still empty and rotation
                                // correctly no-ops — so it is NOT the live
                                // rotation path here (that is the queued block's
                                // index change, plus the partial stream-restart
                                // fallback) — while on that third path it
                                // behaves as advertised. The handler is correct
                                // under both.
                                onAssistantMessageStart: () => {
                                  draft!.handleAssistantMessageBoundary();
                                },
                              }
                            : {}),
                        }
                      : {}),
            },
            // THIS channel's outbound delivery seam. Forward the assembled reply
            // text to the originating widget's live socket. In either draft mode
            // (progress/partial) we FINALIZE the ACTIVE draft lane (reusing its
            // id) so the widget transitions that working bubble into the final
            // answer; otherwise (block/off, no draft) we send a plain no-id
            // agent_message (legacy append path).
            delivery: {
              deliver: async (payload, info) => {
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
                const kind = info?.kind;
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
                  } else if (!isCoreNoticePayload(payload)) {
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
                // #94 lane rule: `deliver` does NOT identify a lane — its `info`
                // is `{ kind }` and carries nothing else (§5.2) — so it acts on
                // the ACTIVE lane only. A `final` is by definition the finished
                // form of the CURRENT (last) assistant message, so it settles
                // the active lane's bubble; earlier messages already settled on
                // their own ids at their own boundaries and are never touched.
                if (draft && kind === "final") {
                  const sent = await draft.finalize(text);
                  if (sent) finalReplyDelivered = true;
                  return { visibleReplySent: sent };
                }
                // In partial mode a non-final ANSWER block's text is ALREADY in
                // the active lane (it arrived as partials, and the block itself
                // was recorded via onBlockReplyQueued), so sending it here would
                // append a duplicate bubble beside the lane's own terminal
                // frame. Account for it and send nothing (§6.2-6). This also
                // covers a block draining AFTER a rotation: the lane that owned
                // it has already settled with its own body. `visibleReplySent:
                // true` is honest — the content does reach the user, through
                // that lane's terminal frame rather than through this call.
                //
                // A NOTICE block is excluded. Core's status/fallback/compaction
                // notices reach this seam as `kind:"block"`
                // (reply-usage-state-q7j5CVEd.js:488-495 →
                // agent-runner.runtime-C8N-o26U.js:4126-4133 →
                // dispatch-B2e1grFo.js:1885) but never stream as a partial and
                // are never repeated in the final, so swallowing one would
                // DROP it while claiming it was delivered. They fall through to
                // the plain send, exactly as in the non-draft modes.
                if (
                  draft &&
                  kind === "block" &&
                  answerStreamingEnabled &&
                  !isCoreNoticePayload(payload)
                ) {
                  return { visibleReplySent: true };
                }
                const sent = transport.sendText(wsKey, text, undefined, turnId);
                if (sent && kind === "final") finalReplyDelivered = true;
                return { visibleReplySent: sent };
              },
            },
          };
        },
      },
    });

    // Draft settle (P1-8a). If `inbound.run` resolves WITHOUT ever calling our
    // `delivery.deliver` with kind:"final", a started progress draft would hang
    // as an italic "working" bubble forever (the catch below only fires on a
    // THROW, not this clean resolve). This happens on two clean-resolve paths we
    // can't tell apart here: (a) core aborted the run (an out-of-band /stop
    // reached fast-abort while this turn was live), and (b) a silent completion
    // — a tool-only turn, or an empty/suppressed answer where `deliver`
    // early-returns on falsy text. So we settle the bubble with the streamed
    // SNAPSHOT ALONE and add no marker:
    //   - a genuine abort already gets explicit feedback — core's "/stop" turn
    //     separately delivers "⚙️ Agent was aborted." — so this bubble only needs
    //     to settle with what it streamed, not announce anything; and
    //   - a silent/tool-only completion is correctly settled by its own streamed
    //     content, where any "Stopped"-style marker would be a mislabel.
    // `snapshotText()`/`finalize()` both read the ACTIVE LANE (#94, §8-6):
    // messages that already settled at their own boundaries are never touched
    // here, and `finalize` is idempotent per lane (message-adapter.ts), so a
    // turn that already delivered its final answer is a no-op.
    //
    // The gate is the SNAPSHOT, not `started`. §8-6 words this condition as
    // "did the lane emit a frame", which was the same question while one draft
    // spanned the whole turn — but a per-lane `started` is false for the whole
    // ~600ms throttle window after a rotation, and a lane whose first frame is
    // still pending in that window already holds the new message's text. Keying
    // on `started` drops exactly that text on an abort (a regression against the
    // old turn-wide flag, which was true by then). The intent §8-6 protects —
    // never mint an empty bubble, never a stop marker — is what the snapshot
    // itself expresses: it is "" precisely when the lane has nothing worth
    // settling (a rotated lane with no text yet, or a bare scaffold header).
    // `finalize` flushes the pending frame before settling, so the widget still
    // sees the bubble before it resolves.
    if (draft) {
      const snapshot = draft.snapshotText();
      if (snapshot) await draft.finalize(snapshot);
    }
  } catch (err) {
    turnOutcome = "error";
    api.logger.error?.(`webchannel: inbound dispatch failed: ${String(err)}`);
    // BLOCKING recovery: if the turn threw AFTER a progress frame was emitted,
    // the widget is showing a working bubble that will otherwise hang forever
    // (no terminal frame for that id is ever sent and the draft loop keeps
    // running). Reuse the finalize path to send a settling `agent_message` for
    // the SAME draft id with a short apologetic text, so the widget transitions
    // the bubble out of its italic "working" state into a settled message.
    //
    // `finalize` is idempotent, so on the (impossible-here, but defensive) case
    // where the normal path already finalized before throwing, this is a no-op.
    if (draft?.started) {
      try {
        await draft.finalize(
          "Sorry — something went wrong while answering. Please try again.",
        );
      } catch (finalizeErr) {
        api.logger.error?.(
          `webchannel: draft error-finalize failed: ${String(finalizeErr)}`,
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
    if (settlementEligible && !transport.sendTurnSettled(wsKey, turnId, turnOutcome)) {
      api.logger?.warn?.(
        `webchannel: turn_settled was not delivered for peer=${wsKey} turn=${turnId} outcome=${turnOutcome}`,
      );
    }
  }
}
