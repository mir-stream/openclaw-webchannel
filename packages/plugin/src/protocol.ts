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
 * v4 (breaking, #246): the v6 delivery-render frames are not optional garnish —
 * a peer that ignores them DIVERGES SILENTLY. See the worked example below.
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
 *  - BUMP when correctness — not merely rendering — requires the peer to ACT on
 *    a new frame or field. **v4 is the worked example (#246).** v6 added: a
 *    per-conversation `seq` on every durable outbound frame plus the
 *    `get_difference`/`difference` round-trip that heals a hole in it (#244);
 *    the `user_committed` multi-device broadcast (#245); `history` rows of kind
 *    `reasoning`/`tool`/`approval` (#242); and `ack.committed[]`, the durable
 *    user id the server minted plus its seq (#243). A v3 peer stays on the wire,
 *    looks healthy, and is wrong in two ways it cannot itself detect:
 *      · No `seq` ⇒ no gap detection ⇒ it never sends `get_difference`. This
 *        transport is core NATS pub/sub, AT-MOST-ONCE with no retention, so a
 *        dropped frame leaves a hole the peer CANNOT SEE and therefore never asks
 *        to heal. What repairs it is incidental AND BOUNDED. A history snapshot
 *        is REQUESTED on every successful register (`nats-register.ts`; the send
 *        coalesces while one is already in flight for that peer and is suppressed
 *        on an empty projection) and it rides the shared `.out`, so ANY device's
 *        register delivers it to all of them — but it carries only the newest
 *        `history.limit` PROJECTED ROWS (50 by default), and fewer usable ones
 *        still for a v3 peer with `reasoningDurable` on, which drops the
 *        role-less rows. A hole inside that window closes. An OLDER one does not:
 *        the v3 peer's only other door is `loadHistory({before})`, which pages
 *        strictly OLDER than a cursor and can never page INTO a mid-transcript
 *        hole. That hole outlives every reconnect for the life of the tab's
 *        state, and only a RELOAD — empty state, full re-page — repairs it.
 *        #244 exists so the hole ITSELF triggers the heal instead of luck.
 *      · It DROPS `history` rows that carry no `role` — its own `case "history"`
 *        guard, which is the very thing that made that widening safe — so its
 *        transcript holds no reasoning id to cite as a `before` cursor and "load
 *        older" STALLS FOREVER once an operator enables
 *        `capabilities.reasoningDurable` (#309).
 *    #309 named the only two fixes: withhold the row per peer, or refuse the
 *    connection. This bump is the refusal, and it retires #309's operator-side
 *    mitigation ("do not enable `reasoningDurable` while a stale client is
 *    served"). Both sides already reject a mismatch, so the constant IS the
 *    enforcement — no new gate was added.
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
 * ⚠️ v4 ADDED NO CAPABILITY NEGOTIATION, AND THAT IS A DECISION — NOT AN
 * OVERSIGHT TO "FINISH". #309 framed the fix as negotiation, and negotiation is
 * what you need in order to WITHHOLD a frame kind from ONE peer while serving it
 * to another. Under an exact-match version gate there is no such peer: everything
 * that registers is at this exact version. The one shape that would need per-peer
 * withholding — a LIVE delete/edit frame — is not on this wire at all:
 * `messageDeleted`/`messageEdited` are `DurableEvent` kinds with NO PRODUCER
 * (`durable-view-reducer.ts`), reachable only through `difference`/`history`. So
 * a capability carrier would ship with zero consumers, and an unexercised
 * mechanism is one that gets discovered broken the first time it matters. The
 * slice that adds the first frame an EQUAL-version peer must act on decides
 * bump-vs-negotiate then, under the rule above.
 *
 * NOTE: this is a DIFFERENT layer from the E2E envelope version
 * (`ENVELOPE_VERSION` / `v:1`), which versions the encrypted payload format.
 */

import { createRequire } from "node:module";

/** The plugin's wire-protocol version. Kept in lockstep with the client. */
export const WEBCHANNEL_PROTOCOL_VERSION = 4;

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
