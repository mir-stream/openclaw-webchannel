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
 * plain alias of `DurableEvent` from the same module. (It is not yet reached
 * from the plugin's entry graph — #240 half 1 ships the projection with no
 * caller — so `esbuild --bundle` does not yet inline the reducer into
 * `dist/index-nats.js`. That is a wiring fact about half 2, not a fact about
 * whether the import resolves; bundling `journal-history.ts` directly with the
 * build's own flags inlines it.)
 *
 * The guard below keeps its job either way: it is the executable proof that a
 * cross-package SOURCE import of the client's reducer resolves and folds from
 * inside this package.
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
 * and `remove` (a mis-routed overflow bubble), then a post-seal resurrect.
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
    // The seal drops X and reorders the answer slots to [B, A]; C is MINTED next
    // to its predecessor answer A, which shifts NOTICE one slot right; the
    // trailing bubble then RESURRECTS X at the tail. Every one of those is
    // current live-client behavior, anchored in the client-side test against the
    // REAL private `applyTurnSnapshot`.
    expect(view.map((m) => m.id)).toEqual(["u-0", "B", "A", "NOTICE", "C", "X"]);
    expect(view).toEqual<DurableView>([
      { id: "u-0", role: "user", text: "do the thing", turnId: "w-0" },
      { id: "B", role: "agent", text: "B (sealed)", turnId: TURN },
      { id: "A", role: "agent", text: "A (sealed)", turnId: TURN },
      { id: "NOTICE", role: "agent", text: "a notice", turnId: TURN },
      { id: "C", role: "agent", text: "C (minted)", turnId: TURN },
      { id: "X", role: "agent", text: "X, resurrected", turnId: TURN },
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
