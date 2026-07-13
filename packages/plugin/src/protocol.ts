/**
 * WebChannel wire-protocol version + plugin version reporting (plugin side).
 *
 * `WEBCHANNEL_PROTOCOL_VERSION` MUST equal the client's constant
 * (packages/client/src/protocol.ts). There is no shared package between the two,
 * so each declares its own; the register handshake catches any drift (the client
 * enforces the match, the plugin stays permissive — v1 is the only version).
 *
 * NOTE: this is a DIFFERENT layer from the E2E envelope version
 * (`ENVELOPE_VERSION` / `v:1`), which versions the encrypted payload format.
 */

import { createRequire } from "node:module";

/** The plugin's wire-protocol version. Kept in lockstep with the client. */
export const WEBCHANNEL_PROTOCOL_VERSION = 1;

let cachedPluginVersion: string | null | undefined;

/**
 * Read this plugin's package version at runtime (from its own package.json),
 * for reporting in the register reply + enrollment body. Node-only (uses
 * `createRequire`), which is fine — the plugin always runs in the OpenClaw
 * gateway (Node). Cached after the first read; returns `null` if the version
 * cannot be resolved (never throws — version reporting is advisory).
 */
export function readPluginVersion(): string | null {
  if (cachedPluginVersion !== undefined) return cachedPluginVersion;
  try {
    const require = createRequire(import.meta.url);
    const pkg = require("../package.json") as { version?: unknown };
    cachedPluginVersion = typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    cachedPluginVersion = null;
  }
  return cachedPluginVersion;
}
