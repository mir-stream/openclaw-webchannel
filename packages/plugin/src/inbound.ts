import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-core";

import { WEBCHANNEL_ID, ANON_PEER_ID } from "./transport.js";
import type { WebChannelTransport, InboundWsMessage } from "./transport.js";
import { resolveDmAdmission } from "./dm-allowlist.js";
import { DEFAULT_ACCOUNT_ID, resolveWebchannelAccountConfig } from "./account-config.js";
import { resolveWebchannelSessionRoute } from "./session-route.js";

/** The inbound path only handles user messages; approvals route separately. */
type InboundUserMessage = Extract<InboundWsMessage, { type: "user_message" }>;
import {
  resolveStreamingMode,
  createProgressDraftController,
} from "./message-adapter.js";
import type { ProgressDraftController } from "./message-adapter.js";

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
  transport: WebChannelTransport,
  peerId: string,
  message: InboundUserMessage,
  accountId: string = DEFAULT_ACCOUNT_ID,
  options?: { controlLane?: boolean },
): Promise<void> {
  // `wsKey` is the verified per-peer id the transport uses as its socket-map
  // key (the anonymous strategy is the single-peer special case, where this
  // falls back to ANON_PEER_ID).
  const wsKey = peerId || ANON_PEER_ID;
  const channelRuntime = api.runtime.channel;

  // Control lane (P1-8a): an out-of-band abort turn ("/stop"). It reaches here
  // directly (NOT via the per-session FIFO) so core's fast-abort can cancel the
  // still-live running turn — see `src/control-lane.ts` and index-nats.ts. Two
  // things differ for a control-lane turn: (1) no progress draft — the abort's
  // reply is a single short final text, so a "Working…" bubble for it is noise;
  // (2) we stamp CommandAuthorized on the turn context (see the buildContext
  // call) so core's fast-abort accepts it.
  const controlLane = options?.controlLane === true;

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
  let draft: ProgressDraftController | undefined;
  if (draftEnabled) {
    draft = createProgressDraftController({
      transport,
      sessionKey: wsKey,
      channelConfig,
    });
  }

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
  transport.sendTyping(wsKey);

  try {
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
            // Progress-draft callbacks (only when streaming.mode === "progress").
            // These fire DURING the agent run and feed the rolling draft. We also
            // set `suppressDefaultToolProgressMessages` so the agent's own tool
            // progress text isn't ALSO delivered as separate messages (it lives
            // inside our draft instead — GetReplyOptions.suppressDefaultToolProgressMessages,
            // dist/plugin-sdk/types-BYvUZFDr.d.ts:261-265).
            ...(draft
              ? {
                  replyOptions: {
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
                    // Answer-text streaming — PARTIAL MODE ONLY. Core emits
                    // `onPartialReply` with the CUMULATIVE assistant text
                    // (`text`) for final-answer-phase items only (commentary
                    // goes to item events; shouldStreamAssistantPartial, verified:
                    // dist/run-attempt-DRhLt3eF.js:4546-4548) — so no filtering
                    // is needed here. In progress mode this is omitted, so
                    // answer text never streams (the mode distinction). Guard an
                    // empty `text` so a trailing empty partial can't clobber the
                    // draft (PartialReplyPayload.text, dist/plugin-sdk/types-DNy-f8Hr.d.ts:200-203).
                    ...(answerStreamingEnabled
                      ? {
                          onPartialReply: (p) => {
                            draft!.pushAnswerText(p.text ?? "");
                          },
                          // Assistant-message boundary. Core's cumulative
                          // `text` is per-itemId (restarts from "" on the next
                          // final_answer message); rolling the prior message's
                          // text into a prefix here prevents it visibly
                          // vanishing on a multi-message reply. Fired once per
                          // message start, incl. before the first (a no-op then)
                          // — verified: dist/run-attempt-DRhLt3eF.js:4083-4086.
                          // Partial mode only; NOT wired in progress mode.
                          onAssistantMessageStart: () => {
                            draft!.handleAssistantMessageBoundary();
                          },
                        }
                      : {}),
                  },
                }
              : {}),
            // THIS channel's outbound delivery seam. Forward the assembled reply
            // text to the originating widget's live socket. In either draft mode
            // (progress/partial) we FINALIZE the in-flight draft (reusing its id)
            // so the widget transitions the working bubble into the final answer;
            // otherwise (block/off, no draft) we send a plain no-id agent_message
            // (legacy append path).
            delivery: {
              deliver: async (payload, info) => {
                const text = payload.text;
                if (!text) return { visibleReplySent: false };
                // Only the final reply replaces the draft. Non-final visible
                // blocks (rare for this channel) fall through to a plain send.
                if (draft && info?.kind === "final") {
                  await draft.finalize(text);
                  return { visibleReplySent: true };
                }
                const sent = transport.sendText(wsKey, text);
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
    // `finalize` is idempotent (message-adapter.ts), so a turn that already
    // delivered its final answer is a no-op here. The `|| "⏹ Stopped."` fallback
    // is defensively unreachable (`started === true` implies a progress frame was
    // sent, and frames always carry non-empty `composeText()` output, so
    // `snapshotText()` is non-empty) — it exists only so the bubble can never
    // finalize to empty text.
    if (draft?.started) {
      const snapshot = draft.snapshotText();
      await draft.finalize(snapshot || "⏹ Stopped.");
    }
  } catch (err) {
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
    }
  } finally {
    // Always halt the throttled draft loop so a late background flush can't race
    // the error handling (or linger after a normal finalize). Idempotent and a
    // no-op when no draft was created or it was already stopped by finalize().
    draft?.stop();
  }
}
