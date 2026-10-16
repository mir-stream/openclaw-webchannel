/**
 * v6 delivery-render §15.4 — SHARED-REDUCER DRIFT GUARD (issue #237).
 *
 * WHY THIS FILE EXISTS. The v6 design's central correctness bet is
 * `history == the live view`, guaranteed BY CONSTRUCTION because both sides
 * compute their view by applying ONE pure reducer to the same ordered event
 * stream. That guarantee is only real if the plugin can actually CONSUME the
 * client's reducer module — if it cannot, the server-side history projection
 * ends up re-implementing the ordering / tombstone / supersession rules, and a
 * re-implementation is free to INVENT one. Inventing a rule is precisely the
 * regression class this redesign exists to kill (NOT-list N8).
 *
 * So this test is the executable half of the "ONE module, both sides" claim:
 *   - it lives in the PLUGIN package and imports the CLIENT SOURCE directly
 *     (`../../client/src/durable-view-reducer.js` — the `.js` specifier resolves
 *     to the `.ts` under vitest and under the plugin's NodeNext tsc, and the
 *     plugin bundles with `esbuild --bundle`, so a cross-package source import
 *     bundles cleanly). This is the established pattern here — see
 *     `abort-mirror-contract.test.ts` importing `../../client/src/abort-mirror.js`
 *     and the `wrap-aad.ts` / `wrap-aad-parity.test.ts` pair in the other
 *     direction;
 *   - it asserts the SAME view the client-side test asserts for the same stream,
 *     so a fork of the rules on either side turns one of the two files red.
 *
 * What it catches: the module gaining a dependency the plugin cannot resolve (a
 * `node:` import would break the client's browser build; a browser global would
 * break here), the export names drifting, and the reducer's answers/remove
 * semantics changing on one side only.
 * What it deliberately does NOT do: re-derive or re-state the reducer's rules.
 * The exhaustive behavioral coverage — including the equivalence anchor against
 * the client's REAL private `applyTurnSnapshot` — lives in
 * `packages/client/src/durable-view-reducer.test.ts`. Duplicating it here would
 * be the very fork this guard is meant to prevent.
 *
 * ⚠️ THIS IS NO LONGER THE ONLY PLUGIN-SIDE CONSUMER, and the sentence that said
 * so has been corrected rather than left standing. It read: "as of slice 1 no
 * plugin runtime code consumes the reducer yet; this test is the only
 * plugin-side consumer … it proves consumption is POSSIBLE before slice 2+
 * makes it load-bearing." #240 made it load-bearing: `journal-history.ts` is
 * PRODUCTION plugin source that imports `applyDurableEvent` and folds journal
 * rows through it, and `delivery-journal-event.ts`'s `JournalEvent` is now a
 * plain alias of `DurableEvent` from the same module.
 *
 * ⚠️ AND IT IS NOW IN THE SHIPPED BUNDLE, WHICH RAISES THE STAKES OF THE GUARD
 * BELOW. This paragraph used to end with a parenthetical claiming the reducer is
 * "not yet reached from the plugin's entry graph — #240 half 1 ships the
 * projection with no caller — so `esbuild --bundle` does not yet inline the
 * reducer into `dist/index-nats.js`". That was true when it was written and
 * went false when #240 HALF 2 wired the read path. MEASURED on this branch,
 * `npm run build -w packages/plugin` then grepping the output:
 *
 *   grep -c "applyReasoning\|projectJournalHistory" dist/index-nats.js   → 5
 *   applyReasoning 2 · applyDurableEvent 2 · projectJournalHistory 3
 *
 * The entry chain is all production source: `index-nats.ts` →
 * `nats-account-runtime.ts` → `history-serve.ts` → `journal-history.ts` →
 * `../../client/src/durable-view-reducer.js` (a VALUE import of
 * `applyDurableEvent`). #242 half 1 then added `applyReasoning` to that same
 * inlined module, which is why this correction belongs to a reasoning slice.
 *
 * So read the guard below at its real blast radius. If the reducer ever gains a
 * dependency this package cannot resolve — a `node:` builtin is the standing
 * hazard, forbidden by that module's DEPENDENCY CONTRACT — the failure is NOT
 * "a test goes red". It is `dist/index-nats.js` failing to build or failing at
 * load, i.e. the shipped plugin. The guard is the cheap early warning for a
 * break whose real cost lands on the artifact.
 */
import { describe, it, expect } from "vitest";

import {
  applyDurableEvent,
  reduceDurableView,
  type DurableEvent,
  type DurableView,
} from "../../client/src/durable-view-reducer.js";

const TURN = "turn-1";

/**
 * A representative journal — a user echo, slot claims (first `progress`), a
 * notice, durable agent bubbles, a seal carrying BOTH `answers` (reordering two
 * lanes AND minting a third that never egressed a bubble — the #215 recovery)
 * and `remove` (a mis-routed overflow bubble), then a post-seal same-id bubble
 * that is REFUSED (tombstone dominance, #241 half 2 — it used to resurrect).
 *
 * This is a VERBATIM copy of `MIXED_STREAM` in
 * `packages/client/src/durable-view-reducer.test.ts` — copied rather than shared,
 * because a fixture imported through the module under test would let both sides
 * drift together.
 *
 * The two expectations below are NOT both duplicated across the packages, and it
 * is worth being precise about which is which:
 *   - the ID-ORDER expectation is asserted on BOTH sides (there, in the
 *     "step / fold agreement" block); it is the redundant one, so a rule change
 *     that reorders this stream turns BOTH files red;
 *   - the FULL-OBJECT expectation (role/text/turnId per row) exists ONLY here.
 *     The client side never asserts it for this stream, so it is written
 *     independently against the same input rather than copied from anywhere.
 * Either way the drift guard holds: a fork of the reducer's rules on one side
 * cannot satisfy both files at once. Do not "sync" these by importing them from
 * the client test — the independence is the mechanism.
 */
const STREAM: DurableEvent[] = [
  { kind: "user", id: "u-0", text: "do the thing", turnId: "w-0" },
  { kind: "placement", answerId: "A", turnId: TURN },
  { kind: "placement", answerId: "A", turnId: TURN }, // repeat claim, same turnId → durable no-op
  { kind: "bubble", answerId: "NOTICE", turnId: TURN, text: "a notice" },
  { kind: "placement", answerId: "B", turnId: TURN },
  { kind: "bubble", answerId: "A", turnId: TURN, text: "A final" },
  { kind: "bubble", answerId: "X", turnId: TURN, text: "mis-routed overflow" },
  {
    kind: "seal",
    turnId: TURN,
    answers: [
      { id: "B", text: "B (sealed)" },
      { id: "A", text: "A (sealed)" },
      { id: "C", text: "C (minted)" },
    ],
    remove: ["X"],
  },
  { kind: "bubble", answerId: "X", turnId: TURN, text: "X, resurrected" },
];

describe("shared durable-view reducer — the plugin consumes the client module", () => {
  it("imports and folds the client's reducer to the same view the client asserts", () => {
    const view = reduceDurableView(STREAM);
    // The seal TOMBSTONES X and reorders the answer slots to [B, A]; C is MINTED
    // next to its predecessor answer A, which shifts NOTICE one slot right; the
    // trailing bubble does NOT resurrect X (tombstone dominance, #241 half 2 —
    // it used to). X is RETAINED as a tombstone at its slot, so the id list is
    // unchanged, but its content is the empty deleted marker. Every one of those
    // is the shared reducer's doing.
    expect(view.map((m) => m.id)).toEqual(["u-0", "B", "A", "NOTICE", "C", "X"]);
    expect(view).toEqual<DurableView>([
      { kind: "text", id: "u-0", role: "user", text: "do the thing", turnId: "w-0" },
      { kind: "text", id: "B", role: "agent", text: "B (sealed)", turnId: TURN },
      { kind: "text", id: "A", role: "agent", text: "A (sealed)", turnId: TURN },
      { kind: "text", id: "NOTICE", role: "agent", text: "a notice", turnId: TURN },
      { kind: "text", id: "C", role: "agent", text: "C (minted)", turnId: TURN },
      { kind: "text", id: "X", role: "agent", text: "", turnId: TURN, deleted: true },
    ]);
  });

  it("exposes the step function, and the fold agrees with it event-by-event", () => {
    // The server projection replays the whole journal while the client render
    // folds incrementally. Both entry points must be reachable from HERE, and
    // must agree, or "one shared reducer" is only true of one of the two.
    let stepwise: DurableView = [];
    for (const event of STREAM) stepwise = applyDurableEvent(stepwise, event);
    expect(stepwise).toEqual(reduceDurableView(STREAM));
  });
});
