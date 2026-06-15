import { fileURLToPath } from "node:url";
import path from "node:path";

import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";

import { ClawChannelTransport } from "./src/transport.js";
import { createClawChannelPlugin } from "./src/channel.js";
import { handleInboundMessage } from "./src/inbound.js";
import { handleApprovalDecision } from "./src/approvals.js";
import { resolveVerifier } from "./src/auth.js";
import type { AuthConfig } from "./src/auth.js";
import { createStaticAssetsHandler } from "./src/static-assets.js";

// Resolve the built widget's `dist/` relative to THIS module (the plugin entry
// at the repo root), so the path is correct regardless of the gateway's cwd.
// index.ts -> <repo-root>/clawchannel/widget/dist.
const pluginDir = path.dirname(fileURLToPath(import.meta.url));
const widgetDistRoot = path.join(pluginDir, "clawchannel", "widget", "dist");

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

    // Resolve the configured auth strategy into a ConnectionVerifier and inject
    // it BEFORE registering the route. `resolveVerifier` enforces the safe
    // default (AUTH.md §7): if `auth` is unconfigured/unknown — or a ticket
    // secret is missing — it THROWS, which we deliberately let propagate so the
    // plugin fails to load loudly rather than serving an open WebSocket.
    const authConfig = (
      api.config.channels as Record<string, unknown> | undefined
    )?.clawchannel as { auth?: AuthConfig } | undefined;
    transport.setVerifier(resolveVerifier(authConfig?.auth, api.logger));

    // Accept WebSocket upgrades on the gateway's own port. No extra server.
    //
    // `handler` is required by OpenClawPluginHttpRouteParams (verified:
    // dist/types-C0dQmare.d.ts:7796). For a WS-only route we reject plain HTTP
    // and let `handleUpgrade` do the real work.
    //
    // auth: "plugin" — plugin-managed auth: all identity resolution flows
    // through our injected verifier inside `handleUpgrade` (the single seam).
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
        transport.handleUpgrade(req, socket, head);
        return true;
      },
    });

    // Serve the built example widget (chat UI) from the gateway under the
    // `/clawchannel/` prefix, so the whole demo runs from the gateway port with
    // no separate web server. These assets are PUBLIC by design (`auth:
    // "plugin"`): the page and its JS carry no secrets — authentication happens
    // at the WebSocket connect (the verifier seam above). The exact
    // `/clawchannel/ws` route registered first takes precedence over this prefix
    // route, so WS upgrades are unaffected; the handler also ignores `ws`.
    api.registerHttpRoute({
      path: "/clawchannel/",
      auth: "plugin",
      match: "prefix",
      handler: createStaticAssetsHandler(widgetDistRoot),
    });
  },
});
