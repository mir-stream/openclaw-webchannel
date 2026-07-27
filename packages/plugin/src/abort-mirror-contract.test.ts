/**
 * P1-9 §3.3 / §6.5 — abort-vocabulary DRIFT GUARD.
 *
 * The client package (`packages/client`) is zero-dependency and cannot import
 * openclaw, so it MIRRORS core's abort predicate in `abort-mirror.ts` (a strict
 * subset — it omits `normalizeCommandBody`). This test lives in the plugin
 * package (which depends on openclaw) and asserts the SUBSET property against the
 * REAL SDK predicate `isAbortRequestText`, exactly as PACKAGING.md §3 guards the
 * mirrored wire types.
 *
 * It imports the CLIENT SOURCE directly (the `.js` specifier resolves to the
 * `.ts` under vitest/tsc, the same cross-package source-import the demo widget
 * uses) rather than a re-implementation, so it exercises the code that actually
 * ships.
 *
 * What it catches:
 *   - a mirror entry the server does NOT accept (a false positive) → the subset
 *     assertion fails;
 *   - core REMOVING a vocabulary word → `isAbortRequestText(word)` flips false
 *     while the mirror still lists it → the subset assertion fails (prune the
 *     mirror).
 * What it deliberately CANNOT catch: core ADDING a word (the mirror is a subset;
 * the new word is simply held-then-released — an accepted, bounded residual,
 * re-pin on upgrade). See abort-mirror.ts's header.
 *
 * Cross-link: `control-lane.test.ts` covers the SERVER routing predicate
 * (`isControlLaneMessage`); this file covers the CLIENT mirror of it.
 */
import { describe, it, expect } from "vitest";

import { isAbortRequestText } from "openclaw/plugin-sdk/command-primitives-runtime";

import {
  ABORT_TRIGGERS,
  isLikelyAbortText,
  isExplicitStop,
} from "../../client/src/abort-mirror.js";

/**
 * Normalization-preserving variants of a trigger — case, surrounding whitespace,
 * trailing punctuation, and straight→curly apostrophe. Each survives BOTH the
 * mirror's `normalizeAbort` and the server's `normalizeAbortTriggerText` back to
 * the same canonical trigger, so all must be accepted on both sides.
 */
function variants(trigger: string): string[] {
  return [
    trigger,
    trigger.toUpperCase(),
    `  ${trigger}  `,
    `${trigger}.`,
    `${trigger}!`,
    `${trigger}…`,
    trigger.replace(/'/g, "’"), // straight apostrophe → curly (identity if none)
  ];
}

describe("P1-9 abort-mirror contract — the client mirror is a strict subset of the SDK predicate", () => {
  it("every mirrored trigger (and its case/punctuation/whitespace/quote variants) is accepted by the SDK", () => {
    for (const trigger of ABORT_TRIGGERS) {
      for (const v of variants(trigger)) {
        // The mirror accepts it (otherwise the fixture is meaningless)…
        expect(isLikelyAbortText(v), `mirror should accept ${JSON.stringify(v)}`).toBe(true);
        // …and — the subset property — so does the server. A drift here means the
        // mirror would hold-then-release a "stale abort" of the wrong turn, OR
        // core dropped the word (prune the mirror).
        expect(isAbortRequestText(v), `SDK should accept ${JSON.stringify(v)}`).toBe(true);
      }
    }
  });

  it("the explicit /stop command (and normalized forms) satisfies both predicates", () => {
    for (const v of ["/stop", " /STOP ", "/stop.", "/Stop"]) {
      expect(isLikelyAbortText(v)).toBe(true);
      expect(isAbortRequestText(v)).toBe(true);
    }
    expect(isExplicitStop("/stop")).toBe(true);
    expect(isExplicitStop(" /STOP ")).toBe(true);
    expect(isExplicitStop("/stop now")).toBe(false); // not the bare command
  });

  it("the stop command's registry textAliases are each mirror-accepted", () => {
    // The plugin-sdk `command-primitives-runtime` does NOT expose the commands
    // registry, so the stop command's `textAliases` cannot be read at runtime.
    // Pin the known alias list (today exactly one) and assert each is accepted by
    // BOTH sides — so a future core alias that canonicalizes to /stop via
    // `normalizeCommandBody` (e.g. `/abort`) fails this test mechanically instead
    // of silently becoming a held stale abort. RE-PIN on openclaw upgrades.
    const STOP_TEXT_ALIASES = ["/stop"];
    for (const alias of STOP_TEXT_ALIASES) {
      expect(isLikelyAbortText(alias)).toBe(true);
      expect(isAbortRequestText(alias)).toBe(true);
    }
  });

  it("does NOT over-accept: near-miss text is neither a mirror abort nor an SDK abort", () => {
    for (const negative of ["stop it now", "/stop now", "stopwatch"]) {
      expect(isLikelyAbortText(negative), `mirror should reject ${JSON.stringify(negative)}`).toBe(false);
      // The server also does not treat these as bare aborts (defensive — pins that
      // the negatives are genuine non-aborts, not merely mirror-invisible).
      expect(isAbortRequestText(negative), `SDK should reject ${JSON.stringify(negative)}`).toBe(false);
    }
  });
});
