/**
 * WebChannel wire-protocol version + plugin version reporting (plugin side).
 *
 * `WEBCHANNEL_PROTOCOL_VERSION` MUST equal the client's constant
 * (packages/client/src/protocol.ts). There is no shared package between the two,
 * so each declares its own. The current version is mandatory in both directions:
 * the plugin rejects a missing, malformed, or mismatched request version and the
 * client rejects a missing, malformed, or mismatched reply version.
 *
 * v3 (breaking): the register request carries a mandatory browser-chosen
 * `clientNonce` which is bound into the wrapped-conversation-key AAD (freshness
 * anchor, see client-nonce.ts), and `unregister` requires a PoP proof (#51).
 *
 * The lockstep is ENFORCED, not just asserted here:
 * `protocol-version-parity.test.ts` (this package) and
 * `protocol-version-lockstep.test.ts` (the e2e suite) each import BOTH constants
 * and compare them, so editing one side alone fails CI. Those two tests are what
 * this paragraph is worth — prose alone was the #122/#115 failure mode. Named
 * by filename, not path, so a moved file is still one grep away.
 *
 * When to bump (#160)
 * ───────────────────
 * Bumping is breaking for every deployment simultaneously: both sides reject a
 * mismatch, so after publication a bump means every consumer must redeploy the
 * gateway AND every browser bundle at the same time. Keep the trigger narrow.
 *
 *  - BUMP when the register handshake contract changes: required request or
 *    reply fields, challenge/response semantics, or what the key delivery is
 *    bound to. v3 is the worked example — a newly mandatory `clientNonce` plus
 *    a PoP proof on unregister.
 *  - DO NOT BUMP for a new frame type only when its semantics are optional and
 *    safely ignorable by an old peer. Measured, not assumed: this side's inbound
 *    dispatch ends in a `default:` that only `console.warn`s and drops the frame
 *    (`nats-channel.ts`), and the client has no dispatch switch at all —
 *    `deliverInbound` matches two specific types and forwards EVERY frame, known
 *    or not, to its message listeners (`nats-client.ts`). That proves wire
 *    tolerance, not semantic compatibility. If correctness requires the peer to
 *    act on a new frame (for example reset or revocation), BUMP or negotiate a
 *    capability.
 *
 * NOTE: this is a DIFFERENT layer from the E2E envelope version
 * (`ENVELOPE_VERSION` / `v:1`), which versions the encrypted payload format.
 */

import { createRequire } from "node:module";

/** The plugin's wire-protocol version. Kept in lockstep with the client. */
export const WEBCHANNEL_PROTOCOL_VERSION = 3;

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
