/**
 * WebChannel Plugin Entry — Gateway-WS mode (DEV-ONLY).
 *
 * ⚠️ NOT the production transport. The production default is `index-nats.ts`
 * (NATS E2E, no inbound port). This Gateway-WS entry serves a WebSocket upgrade
 * on the gateway's own port, so the browser must reach an INBOUND gateway port —
 * same-host/LAN only. It therefore does NOT satisfy the project's no-inbound-port
 * premise and must never be the default/production entry.
 *
 * Keep it for zero-infra local round-trips (no NATS relay, no SaaS issuer): its
 * dev demo is `e2e/local/live-chat*.{mjs,html}` + `packages/client/src/browser-live-entry.ts`.
 * The live gateway runs `index-nats.ts`; `package.json` defaults to it.
 */

import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";

import { WebChannelTransport } from "./src/transport.js";
import type { InboundWsMessage } from "./src/transport.js";
import { createWebChannelPlugin } from "./src/channel.js";
import { handleInboundMessage } from "./src/inbound.js";
import { createSerializedInboundDispatcher } from "./src/inbound-queue.js";
import { handleApprovalDecision } from "./src/approvals.js";
import { resolveVerifier } from "./src/auth.js";
import type { AuthConfig } from "./src/auth.js";
import { recent as historyRecent, pageBefore as historyPageBefore, resolveHistoryConfig } from "./src/history.js";
import { WEBCHANNEL_ID } from "./src/transport.js";

/**
 * Shared transport instance. The channel plugin (outbound) and the HTTP upgrade
 * route (inbound) both reference the same connection map.
 */
const transport = new WebChannelTransport();

const webChannelPlugin = createWebChannelPlugin(transport);

export default defineChannelPluginEntry({
  id: "webchannel",
  name: "WebChannel",
  description: "Self-hosted web chat channel plugin for OpenClaw.",
  plugin: webChannelPlugin,

  registerFull(api) {
    // Bridge inbound WS messages into the agent runtime.
    //
    // Same-session inbound MUST be serialized: two `handleInboundMessage` →
    // `channelRuntime.inbound.run` turns running concurrently for one
    // `sessionKey` collide on core's per-session reply-operation admission gate
    // (`admitReplyTurn`), which assumes the channel feeds it one turn at a time
    // (the bundled Telegram channel gets this for free via its long-poll offset
    // spool; a WebSocket has no such natural spool). The collision wedges the
    // channel — a "working" bubble that never settles. So we run each
    // `user_message` through a per-sessionKey FIFO queue: same-session messages
    // run one at a time in order, while DIFFERENT sessions still run in
    // parallel. See src/inbound-queue.ts for the full rationale.
    const { dispatch: dispatchInbound } = createSerializedInboundDispatcher<
      Extract<InboundWsMessage, { type: "user_message" }>
    >((sessionKey, message) =>
      handleInboundMessage(api, transport, sessionKey, message),
    );
    transport.setMessageHandler((sessionKey, message) => {
      if (message.type !== "user_message") return; // approvals routed below
      dispatchInbound(sessionKey, message);
    });

    // Bridge approval button clicks (`approval_decision`) into the gateway. This
    // is the reverse leg of the native approval capability (src/approvals.ts):
    // resolving the approval unblocks the agent run. The gateway then emits a
    // resolution event that drives the native runtime's `approval_resolved`
    // frame back to the widget, so we do NOT finalize the card here.
    //
    // AUTHZ for this path lives in `handleApprovalDecision`, NOT in the
    // capability's `authorizeActorAction`. `sessionKey` is the verified peer id
    // (transport.handleUpgrade stamps it from the verifier's peerId in
    // src/auth.js), and we pass it as `senderId`; `handleApprovalDecision` then
    // checks it fail-closed against `channels.webchannel.execApprovals.approvers`
    // (falling back to `commands.ownerAllowFrom`) BEFORE the gateway RPC. The
    // gateway RPC itself does NOT authorize — `resolveApprovalOverGateway` only
    // forwards `{id, decision}` and uses `senderId` purely for
    // `clientDisplayName` (verified:
    // dist/approval-gateway-resolver-DNNKgGbF.js). The capability's
    // `authorizeActorAction` only guards the chat `/approve` text-command path
    // (dist/commands-handlers.runtime-DIVsKJOl.js:784), which the widget never
    // sends. The sender MUST therefore be threaded through here (the prior
    // handler ignored `_sessionKey`).
    transport.setApprovalDecisionHandler((sessionKey, id, decision) => {
      void handleApprovalDecision(api.config, id, decision, sessionKey).catch((err) => {
        api.logger.error?.(
          `webchannel: approval resolve failed (${id}): ${String(err)}`,
        );
      });
    });

    // Resolve the configured auth strategy into a ConnectionVerifier and inject
    // it BEFORE registering the route. `resolveVerifier` enforces the safe
    // default (AUTH.md §7): if `auth` is unconfigured/unknown — or a ticket
    // secret is missing — it THROWS, which we deliberately let propagate so the
    // plugin fails to load loudly rather than serving an open WebSocket.
    const authConfig = (
      api.config.channels as Record<string, unknown> | undefined
    )?.webchannel as { auth?: AuthConfig } | undefined;
    transport.setVerifier(resolveVerifier(authConfig?.auth, api.logger));

    // Wire the typing-indicator capability from `channels.webchannel.capabilities.typing`.
    // The transport defaults to "on"; only an explicit "off" disables it. The
    // schema (openclaw.plugin.json) defines the default, but we still apply the
    // default here so a config block that OMITS `capabilities.typing` keeps
    // typing enabled without us having to depend on the JSON schema being
    // applied by the gateway.
    const webchannelSection = (
      api.config.channels as Record<string, unknown> | undefined
    )?.webchannel as
      | { capabilities?: { typing?: "on" | "off" } }
      | undefined;
    transport.setTypingEnabled(
      webchannelSection?.capabilities?.typing !== "off",
    );

    // Wire the history-pagination capability from
    // `channels.webchannel.history.{enabled,limit,pageSize}`. The transport
    // defaults to enabled + 50/50; the schema (openclaw.plugin.json) defines
    // the same defaults. We apply them here too so a config block that OMITS
    // the entire `history` key still gets hydrated history on reconnect.
    const historyConfig = resolveHistoryConfig(webchannelSection);
    transport.setHistoryEnabled(historyConfig.limit > 0);

    // First-pong snapshot trigger. After the server sees the first pong for a
    // given connection (proof the socket is alive enough to deliver), push
    // the initial history snapshot via `history.recent(...)`. The transport's
    // Liveness dedupe flag ensures this fires EXACTLY ONCE per connection —
    // late pongs never re-send. Best-effort: `history.recent` itself swallows
    // store errors and logs via api.logger; we additionally catch here so a
    // routing-resolution throw NEVER crashes the connection.
    transport.setFirstLivenessHandler((wsKey) => {
      try {
        const route = api.runtime.channel.routing.resolveAgentRoute({
          cfg: api.config,
          channel: WEBCHANNEL_ID,
          peer: { kind: "direct", id: wsKey },
        });
        void historyRecent(api, route.sessionKey, historyConfig.limit, api.logger)
          .then((messages) => {
            transport.sendHistory(wsKey, messages);
          })
          .catch((err) => {
            api.logger.error?.(
              `webchannel: history snapshot failed for ${wsKey}: ${String(err)}`,
            );
          });
      } catch (err) {
        api.logger.error?.(
          `webchannel: history snapshot setup failed for ${wsKey}: ${String(err)}`,
        );
      }
    });

    // load_history request handler. The widget asks for a page of older
    // messages; we resolve the route session key (so cross-peer isolation
    // holds — the SDK scopes `getSessionMessages` by sessionKey) and hand the
    // page back via `transport.sendHistory`. The handler is fire-and-forget:
    // errors are logged, never thrown.
    transport.setLoadHistoryHandler((wsKey, request) => {
      try {
        const route = api.runtime.channel.routing.resolveAgentRoute({
          cfg: api.config,
          channel: WEBCHANNEL_ID,
          peer: { kind: "direct", id: wsKey },
        });
        const requestedLimit = request.limit ?? historyConfig.pageSize;
        const fetch = request.before
          ? historyPageBefore(
              api,
              route.sessionKey,
              request.before,
              requestedLimit,
              api.logger,
            )
          : historyRecent(api, route.sessionKey, requestedLimit, api.logger);
        void fetch
          .then((messages) => {
            transport.sendHistory(wsKey, messages);
          })
          .catch((err) => {
            api.logger.error?.(
              `webchannel: load_history failed for ${wsKey}: ${String(err)}`,
            );
          });
      } catch (err) {
        api.logger.error?.(
          `webchannel: load_history setup failed for ${wsKey}: ${String(err)}`,
        );
      }
    });

    // Accept WebSocket upgrades on the gateway's own port. No extra server.
    //
    // `handler` is required by OpenClawPluginHttpRouteParams (verified:
    // dist/types-C0dQmare.d.ts:7796). For a WS-only route we reject plain HTTP
    // and let `handleUpgrade` do the real work.
    //
    // auth: "plugin" — plugin-managed auth: all identity resolution flows
    // through our injected verifier inside `handleUpgrade` (the single seam).
    api.registerHttpRoute({
      path: "/webchannel/ws",
      auth: "plugin",
      match: "exact",
      handler: async (_req, res) => {
        res.statusCode = 426; // Upgrade Required
        res.end("webchannel: WebSocket upgrade required");
        return true;
      },
      handleUpgrade: (req, socket, head) => {
        transport.handleUpgrade(req, socket, head);
        return true;
      },
    });
  },
});
