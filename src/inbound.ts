import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-core";

import { CLAWCHANNEL_ID, ANON_PEER_ID } from "./transport.js";
import type { ClawChannelTransport, InboundWsMessage } from "./transport.js";

/**
 * Handle one inbound user message from the browser widget.
 *
 * Phase 0 inbound path (walking skeleton) — proper channel inbound lifecycle:
 *  1. Resolve the agent route for this channel + peer via
 *     `runtime.channel.routing.resolveAgentRoute(...)`. This honours the
 *     configured dmScope/bindings and yields a channel-scoped `sessionKey`
 *     (e.g. carrying `clawchannel`), instead of `buildAgentSessionKey(...)`
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
 * value lining up with the map. (Phase 1 replaces the single anon peer with a
 * real per-user/per-tab peer id; the recorded `reply.to` already carries that
 * peer so per-peer routing drops in without changing this seam.)
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
  transport: ClawChannelTransport,
  peerId: string,
  message: InboundWsMessage,
): Promise<void> {
  // The transport always maps connections to the single anon peer in Phase 0.
  const wsKey = peerId || ANON_PEER_ID;
  const channelRuntime = api.runtime.channel;

  // Resolve the channel-scoped agent route (carries `clawchannel` + peer in the
  // session key per configured dmScope/bindings).
  const route = channelRuntime.routing.resolveAgentRoute({
    cfg: api.config,
    channel: CLAWCHANNEL_ID,
    peer: { kind: "direct", id: wsKey },
  });

  try {
    await channelRuntime.inbound.run({
      channel: CLAWCHANNEL_ID,
      raw: message,
      adapter: {
        ingest: (raw) => ({
          id: `clawchannel-${Date.now()}`,
          timestamp: Date.now(),
          rawText: raw.text,
          textForAgent: raw.text,
          textForCommands: raw.text,
          raw,
        }),
        resolveTurn: (input) => {
          const ctxPayload = channelRuntime.inbound.buildContext({
            channel: CLAWCHANNEL_ID,
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
            channel: CLAWCHANNEL_ID,
            agentId: route.agentId,
            routeSessionKey: route.sessionKey,
            storePath,
            ctxPayload,
            recordInboundSession: channelRuntime.session.recordInboundSession,
            dispatchReplyWithBufferedBlockDispatcher:
              channelRuntime.reply.dispatchReplyWithBufferedBlockDispatcher,
            // THIS channel's outbound delivery seam. Forward the assembled
            // reply text to the originating widget's live socket.
            delivery: {
              deliver: async (payload) => {
                const text = payload.text;
                if (!text) return { visibleReplySent: false };
                const sent = transport.sendText(wsKey, text);
                return { visibleReplySent: sent };
              },
            },
          };
        },
      },
    });
  } catch (err) {
    api.logger.error?.(`clawchannel: inbound dispatch failed: ${String(err)}`);
  }
}
