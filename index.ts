import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";

import { ClawChannelTransport } from "./src/transport.js";
import { createClawChannelPlugin } from "./src/channel.js";
import { handleInboundMessage } from "./src/inbound.js";
import { handleApprovalDecision } from "./src/approvals.js";

/**
 * Shared transport instance. The channel plugin (outbound) and the HTTP upgrade
 * route (inbound) both reference the same connection map.
 */
const transport = new ClawChannelTransport();

const clawChannelPlugin = createClawChannelPlugin(transport);

export default defineChannelPluginEntry({
  id: "clawchannel",
  name: "ClawChannel",
  description: "Self-hosted web chat channel plugin for OpenClaw.",
  plugin: clawChannelPlugin,

  registerFull(api) {
    // Bridge inbound WS messages into the agent runtime.
    transport.setMessageHandler((sessionKey, message) => {
      if (message.type !== "user_message") return; // approvals routed below
      void handleInboundMessage(api, transport, sessionKey, message);
    });

    // Bridge approval button clicks (`approval_decision`) into the gateway. This
    // is the reverse leg of the native approval capability (src/approvals.ts):
    // resolving the approval unblocks the agent run. The gateway then emits a
    // resolution event that drives the native runtime's `approval_resolved`
    // frame back to the widget, so we do NOT finalize the card here.
    transport.setApprovalDecisionHandler((_sessionKey, id, decision) => {
      void handleApprovalDecision(api.config, id, decision).catch((err) => {
        api.logger.error?.(
          `clawchannel: approval resolve failed (${id}): ${String(err)}`,
        );
      });
    });

    // Accept WebSocket upgrades on the gateway's own port. No extra server.
    //
    // `handler` is required by OpenClawPluginHttpRouteParams (verified:
    // dist/types-C0dQmare.d.ts:7796). For a WS-only route we reject plain HTTP
    // and let `handleUpgrade` do the real work.
    //
    // auth: "plugin" — plugin-managed auth. Phase 0 assumes loopback dev and
    // does NOT verify any token.
    // TODO(auth): Phase 1 per-user token — verify an issued widget token here
    // (and in handleUpgrade) before accepting the connection.
    api.registerHttpRoute({
      path: "/clawchannel/ws",
      auth: "plugin",
      match: "exact",
      handler: async (_req, res) => {
        res.statusCode = 426; // Upgrade Required
        res.end("clawchannel: WebSocket upgrade required");
        return true;
      },
      handleUpgrade: (req, socket, head) => {
        // TODO(auth): Phase 1 — verify per-user widget token from req before upgrade.
        transport.handleUpgrade(req, socket, head);
        return true;
      },
    });
  },
});
