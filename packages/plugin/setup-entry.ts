import { defineSetupPluginEntry } from "openclaw/plugin-sdk/channel-core";

import { WebChannelTransport } from "./src/transport.js";
import { createWebChannelPlugin } from "./src/channel.js";

/**
 * Lightweight setup entry. OpenClaw loads this instead of the full entry when
 * the channel is disabled/unconfigured, so it must avoid starting transport
 * runtimes. The transport instance here is never wired to an HTTP upgrade route
 * (that only happens in index.ts `registerFull`); it exists only to satisfy the
 * channel plugin's outbound adapter shape during setup-safe inspection.
 */
const transport = new WebChannelTransport();

export default defineSetupPluginEntry(createWebChannelPlugin(transport));
