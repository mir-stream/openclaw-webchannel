import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";

import { ClawChannelTransport } from "./src/transport.js";
import { createClawChannelPlugin } from "./src/channel.js";
import { handleInboundMessage } from "./src/inbound.js";

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
      void handleInboundMessage(api, transport, sessionKey, message);
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
