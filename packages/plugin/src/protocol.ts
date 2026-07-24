/**
 * WebChannel wire-protocol version + plugin version reporting (plugin side).
 *
 * `WEBCHANNEL_PROTOCOL_VERSION` MUST equal the client's constant
 * (packages/client/src/protocol.ts). There is no shared package between the two,
 * so each declares its own. Protocol v2 is mandatory in both directions: the
 * plugin rejects a missing, malformed, or mismatched request version and the
 * client rejects a missing, malformed, or mismatched reply version.
 *
 * NOTE: this is a DIFFERENT layer from the E2E envelope version
 * (`ENVELOPE_VERSION` / `v:1`), which versions the encrypted payload format.
 */

import { createRequire } from "node:module";

/** The plugin's wire-protocol version. Kept in lockstep with the client. */
export const WEBCHANNEL_PROTOCOL_VERSION = 2;

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
    // "../package.json" resolves to the package root from BOTH the repo/test
    // location (packages/plugin/src/protocol.ts) AND the esbuild bundle
    // (packages/plugin/dist/<entry>.js) — but ONLY because both sit exactly
    // depth-1 under the package root, so `..` lands on the root in each case. If
    // the bundle outdir ever nests deeper (dist/foo/…), this silently resolves to
    // the wrong path, the require throws, and version reporting degrades to null
    // (by design — it's advisory). Keep the plugin's build outdir depth-1, or
    // revisit this relative path.
    const pkg = require("../package.json") as { version?: unknown };
    cachedPluginVersion = typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    cachedPluginVersion = null;
  }
  return cachedPluginVersion;
}
