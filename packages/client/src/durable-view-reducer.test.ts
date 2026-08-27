import { describe, it, expect } from "vitest";

import {
  applyDurableEvent,
  reduceDurableView,
  projectDurableFromClient,
  type DurableEvent,
  type DurableMessage,
  type DurableRole,
  type DurableTextMessage,
  type DurableView,
} from "./durable-view-reducer.js";
import { WebChannelNATSClient } from "./nats-client-wrapper.js";
import type { InboundMessage } from "./nats-client.js";

// v6 slice 1 (#237). These tests feed ordered event streams through the PURE
// reducer and assert the resulting durable view, covering the round-4 P0s and
// known edges. Two blocks matter beyond the plain cases:
//
//  - "step / fold agreement" pins that `reduceDurableView` is genuinely the fold
//    of `applyDurableEvent` and not a second implementation of the transition
//    table. The whole shared-reducer guarantee rests on there being ONE code
//    path (the client folds incrementally, the server replays the log).
//  - the EQUIVALENCE ANCHOR drives the REAL `WebChannelNATSClient` with real
//    wire frames and compares its projected `state.messages` against this
//    reducer. Since the client was rewired onto the reducer that comparison is no
//    longer between two independent implementations — read the caveat at the
//    anchor section's own header before treating a green anchor as proof of a
//    transition.

const TURN = "turn-1";

/**
 * Narrow a view entry to the `text` variant so an anchor can read `role`.
 *
 * THROWS rather than filtering — but ⚠️ NOT FOR THE REASON THIS BLOCK USED TO
 * GIVE, AND THE OLD REASON NOW POINTS AT THE WRONG THING. It said "every entry
 * the anchors below produce is a text message: the client routes no `reasoning`
 * event through the reducer in #242 half 1", so a reasoning entry in a
 * wrapper-driven view "would mean the anchor is no longer comparing what it says
 * it compares." Half 2 deleted that premise — `case "reasoning"` routes through
 * `applyDurable` now — and the fifth anchor in this very file drives a real
 * `reasoning` frame and EXPECTS a reasoning entry in the wrapper-driven view. So
 * the old sentence named the expected outcome as the failure signal, and it
 * contradicted the retracted section header a few lines below it.
 *
 * The surviving reason is narrower and is about the CALLER: this helper exists so
 * an anchor can read `role`, which only the `text` variant has. A reasoning entry
 * reaching it therefore means the WRONG anchor called it — not that the reducer
 * or the client is broken. A silent skip would hide that; a throw names it.
 */
function asText(message: DurableMessage): DurableTextMessage {
  if (message.kind !== "text") {
    throw new Error(`expected a text durable message, received kind=${message.kind}`);
  }
  return message;
}

describe("reduceDurableView — durable view extraction (v6 slice 1)", () => {
  it("slot-claim ordering: a held answer keeps the slot it claimed via first progress (P0 #1)", () => {
    // A claims its slot (first progress / placement) BEFORE the independent
    // notice B arrives; A finalizes only later. Live renders [A, B] because A's
    // slot was fixed at placement time. If the reducer only saw A's final it
    // would land AFTER B → [B, A]. The placement event is what carries the
    // ordering.
    const events: DurableEvent[] = [
      { kind: "placement", answerId: "A", turnId: TURN },
      { kind: "bubble", answerId: "B", turnId: TURN, text: "independent notice" },
      { kind: "bubble", answerId: "A", turnId: TURN, text: "answer A (final)" },
    ];
    const view = reduceDurableView(events);
    expect(view.map((m) => m.id)).toEqual(["A", "B"]);
    expect(view).toEqual<DurableView>([
      { kind: "text", id: "A", role: "agent", text: "answer A (final)", turnId: TURN },
      { kind: "text", id: "B", role: "agent", text: "independent notice", turnId: TURN },
    ]);
  });

  it("late remove-then-readd RESURRECTS the bubble (order-sensitive, NOT tombstone dominance)", () => {
    const events: DurableEvent[] = [
      { kind: "placement", answerId: "A", turnId: TURN },
      { kind: "bubble", answerId: "A", turnId: TURN, text: "answer A" },
      { kind: "bubble", answerId: "X", turnId: TURN, text: "mis-routed overflow" },
      // The plugin realises X was mis-routed and removes it in the snapshot.
      { kind: "seal", turnId: TURN, answers: [{ id: "A", text: "answer A" }], remove: ["X"] },
      // ...but a LATER durable frame for X arrives → X is re-appended (resurrect).
      { kind: "bubble", answerId: "X", turnId: TURN, text: "X, resurrected" },
    ];
    const view = reduceDurableView(events);
    expect(view.map((m) => m.id)).toEqual(["A", "X"]);
    expect(view.find((m) => m.id === "X")?.text).toBe("X, resurrected");
  });

  it("remove ∩ answers within one seal: answers WIN (X present)", () => {
    const events: DurableEvent[] = [
      { kind: "bubble", answerId: "A", turnId: TURN, text: "A" },
      { kind: "bubble", answerId: "X", turnId: TURN, text: "old X" },
      // X named in BOTH remove and answers: the filter drops it, then answers
      // mint it back → present with the answer text.
      {
        kind: "seal",
        turnId: TURN,
        answers: [
          { id: "A", text: "A" },
          { id: "X", text: "X (answer wins)" },
        ],
        remove: ["X"],
      },
    ];
    const view = reduceDurableView(events);
    expect(view.map((m) => m.id)).toEqual(["A", "X"]);
    expect(view.find((m) => m.id === "X")?.text).toBe("X (answer wins)");
  });

  it("seal create-or-update: a lane that never egressed a bubble is MINTED (#215 recovery)", () => {
    // A streamed and materialized; B streamed live but its wire frames failed —
    // it appears ONLY in seal.answers. The snapshot mints B into place.
    const events: DurableEvent[] = [
      { kind: "placement", answerId: "A", turnId: TURN },
      { kind: "bubble", answerId: "A", turnId: TURN, text: "answer A" },
      {
        kind: "seal",
        turnId: TURN,
        answers: [
          { id: "A", text: "answer A" },
          { id: "B", text: "answer B (minted from snapshot)" },
        ],
        remove: [],
      },
    ];
    const view = reduceDurableView(events);
    expect(view.map((m) => m.id)).toEqual(["A", "B"]);
    expect(view.find((m) => m.id === "B")?.text).toBe("answer B (minted from snapshot)");
  });

  it("final-only C (K>=2): a non-answer independent bubble is preserved in position", () => {
    // A, B stream (placement + bubble). C arrives only as an independent bubble
    // and is NOT in seal.answers → it is neither reordered nor removed; it keeps
    // its slot as a non-answer bubble (matches live).
    const events: DurableEvent[] = [
      { kind: "placement", answerId: "A", turnId: TURN },
      { kind: "bubble", answerId: "A", turnId: TURN, text: "A" },
      { kind: "placement", answerId: "B", turnId: TURN },
      { kind: "bubble", answerId: "B", turnId: TURN, text: "B" },
      { kind: "bubble", answerId: "C", turnId: TURN, text: "C (independent final)" },
      {
        kind: "seal",
        turnId: TURN,
        answers: [
          { id: "A", text: "A" },
          { id: "B", text: "B" },
        ],
        remove: [],
      },
    ];
    const view = reduceDurableView(events);
    expect(view.map((m) => m.id)).toEqual(["A", "B", "C"]);
    expect(view.find((m) => m.id === "C")?.text).toBe("C (independent final)");
  });

  it("notice slot preservation: answers reorder among themselves; a notice keeps its exact slot", () => {
    // Layout before seal: [A, NOTICE, B]. The snapshot reorders the answers to
    // [B, A] but the notice bubble must NOT move — result [B, NOTICE, A].
    const events: DurableEvent[] = [
      { kind: "bubble", answerId: "A", turnId: TURN, text: "A" },
      { kind: "bubble", answerId: "NOTICE", turnId: TURN, text: "a notice (non-answer)" },
      { kind: "bubble", answerId: "B", turnId: TURN, text: "B" },
      {
        kind: "seal",
        turnId: TURN,
        answers: [
          { id: "B", text: "B" },
          { id: "A", text: "A" },
        ],
        remove: [],
      },
    ];
    const view = reduceDurableView(events);
    expect(view.map((m) => m.id)).toEqual(["B", "NOTICE", "A"]);
  });

  it("is a PURE function: does not mutate its input events", () => {
    const events: DurableEvent[] = [
      { kind: "bubble", answerId: "A", turnId: TURN, text: "A" },
      { kind: "seal", turnId: TURN, answers: [{ id: "A", text: "A2" }], remove: [] },
    ];
    const snapshot = JSON.stringify(events);
    reduceDurableView(events);
    expect(JSON.stringify(events)).toBe(snapshot);
  });

  it("includes the durable user echo in order", () => {
    const events: DurableEvent[] = [
      { kind: "user", id: "u-0", text: "hello", turnId: "w-0" },
      { kind: "placement", answerId: "A", turnId: TURN },
      { kind: "bubble", answerId: "A", turnId: TURN, text: "hi back" },
    ];
    const view = reduceDurableView(events);
    expect(view).toEqual<DurableView>([
      { kind: "text", id: "u-0", role: "user", text: "hello", turnId: "w-0" },
      { kind: "text", id: "A", role: "agent", text: "hi back", turnId: TURN },
    ]);
  });
});

// ---------------------------------------------------------------------------
// STEP / FOLD AGREEMENT — the shared-reducer guarantee's structural precondition
// ---------------------------------------------------------------------------
//
// Slice 2 makes the client render fold INCREMENTALLY (one event per frame, no
// retained log) while the future server projection REPLAYS the whole journal.
// Those are only "the same reducer" if the whole-log entry point is literally
// the fold of the step function. A drift here — someone re-implementing the
// switch inside `reduceDurableView` — would silently reopen exactly the
// "server invents its own rule" failure mode this module exists to close.

/** A non-trivial stream: user echo, slot claims, an out-of-order final, a seal
 *  carrying BOTH `answers` (with a mint + a reorder) and `remove`, and a
 *  post-seal resurrect. Exercises every transition in the table. */
const MIXED_STREAM: DurableEvent[] = [
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

describe("step / fold agreement: reduceDurableView === fold of applyDurableEvent", () => {
  it("the fold entry point agrees with a hand-written step-by-step loop", () => {
    // Written out longhand on purpose: `Array.reduce` and `reduceDurableView`
    // could in principle both be wrong in the same way. This loop is the
    // incremental client render's shape — carry only the view, never the log.
    let view: DurableView = [];
    for (const event of MIXED_STREAM) {
      view = applyDurableEvent(view, event);
    }
    expect(reduceDurableView(MIXED_STREAM)).toEqual(view);
    // And the stream is actually non-trivial — a vacuous [] on both sides would
    // satisfy the equality above without proving anything.
    //
    // Read the expected order carefully, it is NOT a typo: NOTICE ends up AFTER
    // A. The seal's answer PERMUTATION never moves a non-answer bubble, but step
    // 3's mint SPLICE does — minted C is inserted directly after its predecessor
    // answer A, which sits before NOTICE, so NOTICE shifts one slot right. That
    // is exactly what the live client does today (the anchor case "two minted
    // answers next to their predecessors" pins it against the REAL
    // `applyTurnSnapshot`), and this slice mirrors current behavior rather than
    // correcting it.
    expect(view.map((m) => m.id)).toEqual(["u-0", "B", "A", "NOTICE", "C", "X"]);
  });

  it("every prefix of the stream agrees between step-wise and whole-log replay", () => {
    // Stronger than the endpoints: an incremental consumer observes EVERY
    // intermediate view, so each prefix must match its own whole-log replay.
    let view: DurableView = [];
    for (let i = 0; i < MIXED_STREAM.length; i++) {
      view = applyDurableEvent(view, MIXED_STREAM[i]);
      expect(view).toEqual(reduceDurableView(MIXED_STREAM.slice(0, i + 1)));
    }
  });

  it("applyDurableEvent is PURE: it mutates neither the input view nor the event", () => {
    // The fold-level purity test above cannot see this: `reduceDurableView`
    // owns its intermediate arrays, so an in-place mutation would be invisible
    // there while corrupting an incremental caller's retained view.
    for (const event of MIXED_STREAM) {
      const view: DurableView = [
        { kind: "text", id: "u-0", role: "user", text: "do the thing", turnId: "w-0" },
        { kind: "text", id: "A", role: "agent", text: "A final", turnId: TURN },
        { kind: "text", id: "NOTICE", role: "agent", text: "a notice", turnId: TURN },
        { kind: "text", id: "X", role: "agent", text: "mis-routed overflow", turnId: TURN },
      ];
      const viewSnapshot = JSON.stringify(view);
      const eventSnapshot = JSON.stringify(event);
      applyDurableEvent(view, event);
      expect(JSON.stringify(view)).toBe(viewSnapshot);
      expect(JSON.stringify(event)).toBe(eventSnapshot);
    }
  });

  // -------------------------------------------------------------------------
  // ARRAY IDENTITY — pins the header's table, negative rows included.
  // -------------------------------------------------------------------------
  //
  // Array identity is a PARTIAL property: `placement` and `seal` each have paths
  // that hand the input back, while `user`, `bubble` and `reasoning` ALWAYS
  // allocate. The
  // three SAME-array rows below are exhaustive — they are every `return view` in
  // the module — and the three NEW-array rows are examples, not a partition (a
  // `seal` appears on both sides, and `user` has no row at all because it can
  // never return its input). The negative rows matter as much
  // as the positive ones — without them the header's narrowed claim is just
  // prose, and a slice-2 author could build a `prev === next` memo or a
  // `useSyncExternalStore` equality check on an invariant the code never held.
  // Sound reading: "same ref ⇒ definitely unchanged", NEVER "different ref ⇒
  // changed".

  it("SAME array: a placement whose turnId resolves unchanged", () => {
    const view = reduceDurableView([{ kind: "placement", answerId: "A", turnId: TURN }]);
    // A repeat progress carrying the SAME turnId: the real client rewrites the
    // draft text and `working`, neither of which is durable (§15.9).
    expect(applyDurableEvent(view, { kind: "placement", answerId: "A", turnId: TURN })).toBe(view);
    // …and one that carries no turnId at all falls back to the held value.
    expect(applyDurableEvent(view, { kind: "placement", answerId: "A" })).toBe(view);
    // A placement that DOES change the durable view must not alias it.
    const changed = applyDurableEvent(view, {
      kind: "placement",
      answerId: "A",
      turnId: "turn-new",
    });
    expect(changed).not.toBe(view);
    expect(view[0].turnId).toBe(TURN);
  });

  it("SAME array: a seal with neither valid answers nor removes", () => {
    const view = reduceDurableView([{ kind: "bubble", answerId: "A", text: "A", turnId: TURN }]);
    expect(applyDurableEvent(view, { kind: "seal", turnId: TURN, answers: [], remove: [] })).toBe(view);
  });

  it("SAME array: a seal with a blank turnId (the guard's early return)", () => {
    const view = reduceDurableView([{ kind: "bubble", answerId: "A", text: "A", turnId: TURN }]);
    expect(
      applyDurableEvent(view, { kind: "seal", turnId: "", answers: [{ id: "A", text: "A" }] }),
    ).toBe(view);
  });

  it("NEW array: a bubble with identical text and turnId still allocates", () => {
    // `applyBubble` does not compare before writing. Recorded, not endorsed —
    // teaching it to detect no-ops would be a behavior change this slice does
    // not need.
    const view = reduceDurableView([{ kind: "bubble", answerId: "A", text: "A", turnId: TURN }]);
    const next = applyDurableEvent(view, {
      kind: "bubble",
      answerId: "A",
      text: "A",
      turnId: TURN,
    });
    expect(next).not.toBe(view);
    expect(next).toEqual(view);
  });

  it("NEW array: a seal whose answers change nothing still allocates", () => {
    const view = reduceDurableView([{ kind: "bubble", answerId: "A", text: "A", turnId: TURN }]);
    const next = applyDurableEvent(view, {
      kind: "seal",
      turnId: TURN,
      answers: [{ id: "A", text: "A" }],
      remove: [],
    });
    expect(next).not.toBe(view);
    expect(next).toEqual(view);
  });

  it("NEW array: a reasoning event repeating id, turnId and text still allocates", () => {
    // `applyReasoning` has NO same-array path — both branches allocate. That is
    // what keeps the three SAME-array rows above exhaustive now that a fifth
    // transition exists. (This said "like the live `upsertReasoning` it ports";
    // #242 half 2 DELETED that method — `applyReasoning` ports nothing now, it
    // IS the client's reasoning transition, and the always-allocate behaviour is
    // simply what the client does.)
    const view = reduceDurableView([
      { kind: "reasoning", id: "r-1", turnId: TURN, text: "thought" },
    ]);
    const next = applyDurableEvent(view, {
      kind: "reasoning",
      id: "r-1",
      turnId: TURN,
      text: "thought",
    });
    expect(next).not.toBe(view);
    expect(next).toEqual(view);
  });
});

// ---------------------------------------------------------------------------
// REASONING — #242 half 1
// ---------------------------------------------------------------------------
//
// ✅ AN EQUIVALENCE ANCHOR IS POSSIBLE NOW — see the anchor section below. This
// block used to say one was impossible, correctly: half 1 made reasoning durable
// SERVER-side only, the client rendered it from its own `state.reasoning` array,
// and driving the real wrapper with a `reasoning` frame would have exercised
// `upsertReasoning` rather than this file. #242 half 2 deleted that method and
// routed `case "reasoning"` through `applyDurable`, so the fifth anchor is real.
// These cases still assert the transition on its own; the anchor covers the
// frame→event mapping.
describe("applyReasoning — one completed burst per event", () => {
  it("APPENDS an unseen id at the tail, claiming the slot where the EVENT was appended", () => {
    // The whole reason reasoning goes through the reducer: the block gets a
    // POSITION among the bubbles instead of living in a side list with none.
    //
    // ⚠️ "WHERE THE EVENT WAS APPENDED", NOT "WHERE IT WAS DELIVERED" — this
    // title used to say the latter, contradicting `applyReasoning`'s own
    // docblock, which retracts that wording in as many words.
    //
    // ⚠️ AND THE EXPLANATION THAT FOLLOWED IS CUT, BECAUSE IT WAS THE RETRACTED
    // FALSE UNIVERSAL. It read "the two coincide for a burst closed by
    // `onReasoningEnd` and DIVERGE for one still open at turn end" — and
    // `onReasoningEnd` IS `endBurst` (`inbound.ts`: `onReasoningEnd: () =>
    // reasoning!.endBurst()`), so that is word for word the dichotomy
    // `applyReasoning`'s docblock forbids re-deriving. The shared fixture's
    // counterexample closes MID-TURN via `endBurst` and still diverges.
    //
    // The real condition: live and replay agree for a burst IFF no
    // `placement`/`bubble` row is journaled between its first delivered frame
    // and its closing frame. `journal-history.ts`'s conversion loop (GAP 2b) is
    // where that is stated; this fixture interleaves nothing, so it exercises
    // the agreeing case only.
    const view = reduceDurableView([
      { kind: "bubble", answerId: "A", text: "A", turnId: TURN },
      { kind: "reasoning", id: "r-1", turnId: TURN, text: "thinking" },
      { kind: "bubble", answerId: "B", text: "B", turnId: TURN },
    ]);
    expect(view.map((m) => m.id)).toEqual(["A", "r-1", "B"]);
    expect(view[1]).toEqual({ kind: "reasoning", id: "r-1", turnId: TURN, text: "thinking" });
  });

  it("has NO role, because the wire carries none", () => {
    const view = reduceDurableView([
      { kind: "reasoning", id: "r-1", turnId: TURN, text: "thinking" },
    ]);
    expect(view[0]).not.toHaveProperty("role");
  });

  it("UPSERTS by id, keeping the slot", () => {
    const view = reduceDurableView([
      { kind: "reasoning", id: "r-1", turnId: TURN, text: "first" },
      { kind: "bubble", answerId: "A", text: "A", turnId: TURN },
      { kind: "reasoning", id: "r-1", turnId: "turn-2", text: "revised" },
    ]);
    expect(view.map((m) => m.id)).toEqual(["r-1", "A"]);
    expect(view[0]).toEqual({ kind: "reasoning", id: "r-1", turnId: "turn-2", text: "revised" });
  });

  it("keeps distinct bursts as distinct blocks, in delivery order", () => {
    const view = reduceDurableView([
      { kind: "reasoning", id: "r-1", turnId: TURN, text: "one" },
      { kind: "reasoning", id: "r-2", turnId: TURN, text: "two" },
      { kind: "reasoning", id: "r-3", turnId: TURN, text: "three" },
    ]);
    expect(view.map((m) => m.text)).toEqual(["one", "two", "three"]);
  });

  it("applies NO 100-item cap — a durable view never drops delivered content", () => {
    // A per-kind cap inside the system of record would silently discard
    // delivered content (N10). Retention is #299's job, at the store, where it
    // can be one policy over everything.
    // ⚠️ THE DIVERGENCE THIS CASE ONCE GUARDED IS CLOSED, AND THE TITLE CHANGED
    // WITH IT. It read "does NOT apply the LIVE 100-item cap" and its body
    // called that a "KNOWN live≠history DIVERGENCE FOR THE DURATION OF HALF 1,
    // and half 2 closes it by REMOVING the cap" — present tense, in this file,
    // whose header now records that half 2 (this slice) did exactly that. There
    // is no live cap left to differ from: `upsertReasoning` and its
    // `.slice(-100)` are deleted and `state.reasoning` is derived from an
    // uncapped `state.messages`. What survives is the rule for THIS module —
    // never cap here — which is why the case stays.
    const events: DurableEvent[] = Array.from({ length: 150 }, (_, i) => ({
      kind: "reasoning" as const,
      id: `r-${i}`,
      turnId: TURN,
      text: `thought ${i}`,
    }));
    const view = reduceDurableView(events);
    expect(view).toHaveLength(150);
    expect(view[0]).toEqual({ kind: "reasoning", id: "r-0", turnId: TURN, text: "thought 0" });
  });

  it("is PURE: it mutates neither the input view nor the event", () => {
    const view: DurableView = [
      { kind: "text", id: "A", role: "agent", text: "A", turnId: TURN },
      { kind: "reasoning", id: "r-1", turnId: TURN, text: "first" },
    ];
    const event: DurableEvent = { kind: "reasoning", id: "r-1", turnId: TURN, text: "second" };
    const viewSnapshot = JSON.stringify(view);
    const eventSnapshot = JSON.stringify(event);
    const next = applyDurableEvent(view, event);
    expect(JSON.stringify(view)).toBe(viewSnapshot);
    expect(JSON.stringify(event)).toBe(eventSnapshot);
    // Structural sharing: the untouched entry is the SAME reference.
    expect(next[0]).toBe(view[0]);
    expect(next[1]).not.toBe(view[1]);
  });

  it("does not cross-match the answer id space: a seal cannot remove or overwrite a block", () => {
    // ⚠️ NOT "unreachable because the ids differ" — they do NOT differ. Agent
    // answer ids come from the same `nextMessageId()` as reasoning ids, and user
    // ids are client-supplied and only length-checked, so a peer can send a
    // `webchannel-…`-shaped id verbatim. What makes a collision HARMLESS is the
    // `kind` guard, and that is what this drives: the collision is constructed
    // here and the outcome is pinned. See `findTextIndex`'s docblock.
    const view = reduceDurableView([
      { kind: "reasoning", id: "shared", turnId: TURN, text: "a thought" },
      {
        kind: "seal",
        turnId: TURN,
        answers: [{ id: "shared", text: "an answer" }],
        remove: ["shared"],
      },
    ]);
    // The reasoning block survives the remove AND is not reclassified; the seal's
    // answer is minted as its own text entry.
    expect(view).toEqual([
      { kind: "reasoning", id: "shared", turnId: TURN, text: "a thought" },
      { kind: "text", id: "shared", role: "agent", text: "an answer", turnId: TURN },
    ]);
  });

  it("a bubble does not overwrite a reasoning block that happens to share its id", () => {
    const view = reduceDurableView([
      { kind: "reasoning", id: "shared", turnId: TURN, text: "a thought" },
      { kind: "bubble", answerId: "shared", text: "an answer", turnId: TURN },
    ]);
    expect(view).toEqual([
      { kind: "reasoning", id: "shared", turnId: TURN, text: "a thought" },
      { kind: "text", id: "shared", role: "agent", text: "an answer", turnId: TURN },
    ]);
  });
});

// ---------------------------------------------------------------------------
// CHARACTERIZATION — the duplicate-`user` precondition
// ---------------------------------------------------------------------------
//
// These record what the reducer DOES on a journal that violates its stated
// precondition (no duplicate `user` rows). They are NOT endorsements, and the
// behavior is deliberately not "fixed" here: it is a faithful port of what the
// client's own hand-rolled loop did before the rewire (the client now reaches
// this same code, so the "REAL client throws too" case below no longer proves
// independence), and inventing a dedupe rule the client lacks is exactly the
// defect class this slice forbids. Idempotent append is the
// JOURNAL's job (slice #239's persist-before-publish boundary).
//
// The hazard is real: §15.8 mandates non-destructive retry of a failed journal
// append, so a retry whose first attempt landed writes the row twice.

describe("characterization: a duplicated `user` row violates the reducer's precondition", () => {
  const duplicated: DurableEvent[] = [
    { kind: "user", id: "u-0", text: "same message", turnId: "w-0" },
    { kind: "user", id: "u-0", text: "same message", turnId: "w-0" },
  ];

  it("appends the bubble TWICE (`user` is the one non-idempotent transition)", () => {
    // `placement`/`bubble` upsert and `seal` is keyed by answer id, so replaying
    // those is harmless. `user` blind-appends, mirroring `publish()`.
    const view = reduceDurableView(duplicated);
    expect(view.map((m) => m.id)).toEqual(["u-0", "u-0"]);
    // History would show the user's message twice while live shows it once —
    // the N8 live≠history duplicate class, reintroduced at the fold.
    expect(view).toHaveLength(2);
  });

  it("makes a later `seal` THROW rather than return a view", () => {
    // With a duplicate id present, `slots.length > answers.length`, so the slot
    // refill indexes `answers[idx]` past the end. A pure projection that crashes.
    // Matched on the MESSAGE too: a bare `toThrow(TypeError)` would go green on
    // any unrelated TypeError and stop describing this defect.
    expect(() =>
      reduceDurableView([
        ...duplicated,
        { kind: "seal", turnId: TURN, answers: [{ id: "u-0", text: "sealed" }], remove: [] },
      ]),
    ).toThrow(/Cannot read properties of undefined \(reading 'id'\)/);
  });

  it("is faithful: the REAL client throws on the same input", () => {
    // Non-circular check that the crash is a PORTED behavior, not one this
    // module introduced. Drive the real client with the same duplicated view
    // plus the same snapshot frame.
    const duplicatedView: DurableView = [
      { kind: "text", id: "u-0", role: "user", text: "same message", turnId: "w-0" },
      { kind: "text", id: "u-0", role: "user", text: "same message", turnId: "w-0" },
    ];
    expect(() =>
      realDrive(duplicatedView, [
        turnSnapshotFrame({ turnId: TURN, answers: [{ id: "u-0", text: "sealed" }], remove: [] }),
      ]),
    ).toThrow(/Cannot read properties of undefined \(reading 'id'\)/);
  });
});

// ---------------------------------------------------------------------------
// CHARACTERIZATION — the deliberate divergence, and the precondition trap
// ---------------------------------------------------------------------------
//
// The module's claim is byte-faithfulness, and the anchors below back it. These
// two tests record where the reducer's output is NOT the live view — but they
// are two DIFFERENT categories, and conflating them invites the wrong fix:
//
//  - `placement` dropping the draft text is a DELIBERATE DESIGN DIVERGENCE. The
//    §15.9 indicator classification chose it; the reducer is behaving correctly.
//  - `bubble` with `answerId: ""` is NOT deliberate. It is a CALLER-PRECONDITION
//    VIOLATION — BOUNDARY 1 requires `bubble.answerId` to be non-empty, and the
//    module states that this is a CALLER precondition and not a guard (the same
//    category as the duplicated-`user` block above). It is recorded here because
//    it is the trap a slice-2 mapper walks into, not because the reducer chose
//    to differ.
//
// Both RECORD; neither endorses. A change in EITHER direction — the reducer
// starting to mirror the client here, or the client changing under it — must
// turn one of them red rather than pass silently.

describe("characterization: the deliberate divergence, and the precondition trap beside it", () => {
  it("placement AGREES with the live view: the draft renders, the durable text is empty (§15.9)", () => {
    // FLIPPED from pinning a divergence to pinning agreement (#251). Until the
    // client was rewired onto the reducer this recorded a real delta: the live
    // bubble held "partial answer so far" where the reducer held "". The verdict
    // is that the reducer was right and LIVE was the defective side, so the
    // client now keeps the two apart with `draftOnly` instead of conflating them.
    //
    // `progress.text` is still REQUIRED on the wire (channel-contract.ts:66) and
    // the client still RENDERS it — what changed is that it no longer counts as
    // durable content. Do NOT "fix" this by teaching the reducer to keep draft
    // text: that is the §15.9 reversal, and it belongs in the doc first.
    const frames = [progressFrame("A", "partial answer so far", TURN)];
    const render = realRender([], frames);
    const real = realDrive([], frames);
    const reduced = reduceDurableView([{ kind: "placement", answerId: "A", turnId: TURN }]);

    // The UI still shows the rolling draft…
    expect(render[0].text).toBe("partial answer so far");
    expect(render[0].working).toBe(true);
    expect(render[0].draftOnly).toBe(true);
    // …and the durable view — the client's and the reducer's alike — does not.
    expect(real[0].text).toBe("");
    expect(reduced[0].text).toBe("");
    expect(reduced).toEqual(real);
  });

  it("an unfinalized lane renders NO bubble once the turn ends (#251)", () => {
    // The case the issue is actually about, end to end through the real client:
    // A claims a slot and streams, the turn settles, and no durable frame ever
    // named A. Core's built-in Telegram extension deletes exactly this preview at
    // turn end (`[core] extensions/telegram/src/bot-message-dispatch.ts:2971-2975`
    // → `stream.clear()` → `draft-stream.ts:653-668` → `:634 api.deleteMessage`),
    // so the bubble goes rather than freezing at its last partial.
    const live = realRender([], [progressFrame("A", "partial answer so far", TURN)]);
    expect(live.map((m) => m.id)).toEqual(["A"]);

    const settled = realRender([], [
      progressFrame("A", "partial answer so far", TURN),
      { type: "turn_settled", turnId: TURN } as unknown as InboundMessage,
    ]);
    expect(settled).toEqual([]);
    // live == history: the reducer's view of the same stream is equally empty of
    // durable text for A, so neither side shows a bubble the other lacks.
    expect(
      reduceDurableView([{ kind: "placement", answerId: "A", turnId: TURN }])[0].text,
    ).toBe("");
  });

  it("a lane that DID receive durable text survives the same turn end", () => {
    // Non-vacuity for the test above: the drop is keyed on "never authored
    // durable text", not on "the turn ended".
    const settled = realRender([], [
      progressFrame("A", "partial…", TURN),
      agentMessageFrame("A", "answer A (final)", TURN),
      { type: "turn_settled", turnId: TURN } as unknown as InboundMessage,
    ]);
    expect(settled.map((m) => m.id)).toEqual(["A"]);
    expect(settled[0].text).toBe("answer A (final)");
    expect(settled[0].working).toBe(false);
    expect(settled[0].draftOnly).toBeUndefined();
  });

  it("slot retention: B's text arriving first does not move A ahead of it", () => {
    // The ordering guarantee `placement` exists to provide, driven through the
    // real client: A claims slot 1 and B slot 2, then B's durable text lands
    // BEFORE A's. A must keep slot 1 rather than being appended at the tail.
    const view = realRender([], [
      progressFrame("A", "A partial…", TURN),
      progressFrame("B", "B partial…", TURN),
      agentMessageFrame("B", "answer B", TURN),
      agentMessageFrame("A", "answer A", TURN),
    ]);
    expect(view.map((m) => m.id)).toEqual(["A", "B"]);
    expect(view.map((m) => m.text)).toEqual(["answer A", "answer B"]);
  });

  it("never-arrives: A is absent and B's position is unchanged", () => {
    // A claims slot 1 and never receives durable text; B claims slot 2 and does.
    // A vanishes at the turn end; B stays where it was.
    const view = realRender([], [
      progressFrame("A", "A partial…", TURN),
      progressFrame("B", "B partial…", TURN),
      agentMessageFrame("B", "answer B", TURN),
      { type: "turn_settled", turnId: TURN } as unknown as InboundMessage,
    ]);
    expect(view.map((m) => m.id)).toEqual(["B"]);
    expect(view[0].text).toBe("answer B");
  });

  it("late progress after a drop re-materialises the lane at the TAIL (#251)", () => {
    // MEASURED consequence of the drop, recorded so it is visible in the suite
    // rather than discovered later. This is the self-heal path at a TURN-END site
    // — `turn_settled` here, and equally the terminal settle or an explicit
    // `/stop` — where the lane is dropped and then proves it was alive after all
    // by sending another `progress`. (The P1-9 staleness valve is NOT one of
    // these: it is a mid-turn guess, so it promotes instead of dropping and its
    // self-heal keeps the original slot. See `expireStaleDrafts`.)
    //
    // `applyPlacement` APPENDS on an id it does not hold, so the lane comes back
    // at the tail: [A, B] becomes [B, A]. That is correct rather than a defect to
    // design around — the preview was deleted, so the lane returning is a NEW
    // delivery act, and a new message lands at the bottom, exactly as it would in
    // Telegram. We are strictly better than the reference here because the id is
    // REUSED: the later final still matches this bubble, so the self-heal
    // produces no duplicate.
    //
    // Characterization: it records what happens, it does not claim the resulting
    // order is ideal.
    const w = newWrapper() as unknown as WrapperInternals;
    w.handleMessage(progressFrame("A", "A partial…", TURN));
    w.handleMessage(progressFrame("B", "B partial…", TURN));
    w.handleMessage(agentMessageFrame("B", "answer B", TURN));
    expect(w.state.messages.map((m) => m.id)).toEqual(["A", "B"]);

    // A never received durable text → dropped at the turn end.
    w.handleMessage({ type: "turn_settled", turnId: TURN } as unknown as InboundMessage);
    expect(w.state.messages.map((m) => m.id)).toEqual(["B"]);

    // …and A was alive after all. It returns — at the TAIL, not in slot 1.
    w.handleMessage(progressFrame("A", "back alive…", TURN));
    expect(w.state.messages.map((m) => m.id)).toEqual(["B", "A"]);
    expect(w.state.messages[1]).toMatchObject({ text: "back alive…", working: true, draftOnly: true });

    // The id was reused, so A's eventual final lands on THAT bubble — one A, not
    // two. Slot order is the only thing the drop cost.
    w.handleMessage(agentMessageFrame("A", "answer A", TURN));
    expect(w.state.messages.map((m) => m.id)).toEqual(["B", "A"]);
    expect(w.state.messages.map((m) => m.text)).toEqual(["answer B", "answer A"]);
  });

  it("a late seal re-materialises a dropped lane (characterised, not idealised)", () => {
    // #215 failed-frame recovery arriving AFTER the drop. `applySeal` step 3
    // mints an absent answer next to its PREDECESSOR answer, so A lands ahead of
    // B — its original relative order — even though its bubble was gone. This
    // records what `applySeal` actually produces; it is not an assertion that
    // this is the ideal placement.
    const view = realRender([], [
      progressFrame("A", "A partial…", TURN),
      progressFrame("B", "B partial…", TURN),
      agentMessageFrame("B", "answer B", TURN),
      { type: "turn_settled", turnId: TURN } as unknown as InboundMessage,
      turnSnapshotFrame({
        turnId: TURN,
        answers: [
          { id: "A", text: "answer A (recovered)" },
          { id: "B", text: "answer B" },
        ],
        remove: [],
      }),
    ]);
    expect(view.map((m) => m.id)).toEqual(["A", "B"]);
    expect(view[0].text).toBe("answer A (recovered)");
    expect(view[0].working).toBe(false);
    expect(view[0].draftOnly).toBeUndefined();
  });

  it('bubble with an EMPTY answerId is NOT "id-less" — the live client mints separate bubbles', () => {
    // The client's two id sites use DIFFERENT falsiness, and this is the trap the
    // frame→event mapper walks into (see BOUNDARY 1 in durable-view-reducer.ts):
    //   - `progress` keys on `id ?? ""` (the wrapper's `case "progress"`) —
    //     NULLISH, so "" survives as a
    //     real id, which is why `placement` with `answerId: ""` is FAITHFUL;
    //   - `agent_message` branches on `if (id)` (the wrapper's
    //     `case "agent_message"`) — TRUTHY, so "" falls into that case's
    //     `mintLocalBubbleId("a")` branch and gets a fresh `a-<n>`.
    // So two id-less finals are TWO bubbles live, while a mapper that mirrors the
    // progress site verbatim (`answerId: frame.id ?? ""`) collapses them into ONE
    // durable row — an N8 live≠history divergence landing in the mapper. Hence
    // `bubble.answerId` must be NON-EMPTY; "" is not the encoding for "id-less".
    // The live mapper preserves the difference verbatim, which is what keeps the
    // two-bubble outcome below true.
    const real = realDrive([], [
      agentMessageFrame("", "one", TURN),
      agentMessageFrame("", "two", TURN),
    ]);
    expect(real).toHaveLength(2);
    expect(real.map((m) => m.text)).toEqual(["one", "two"]);
    for (const m of real) expect(m.id).not.toBe("");
    // Non-vacuity: they are distinct client-minted ids, not one bubble twice.
    expect(new Set(real.map((m) => m.id)).size).toBe(2);

    const reduced = reduceDurableView([
      { kind: "bubble", answerId: "", text: "one", turnId: TURN },
      { kind: "bubble", answerId: "", text: "two", turnId: TURN },
    ]);
    expect(reduced).toHaveLength(1);
    expect(reduced[0].id).toBe("");
    expect(reduced[0].text).toBe("two");
  });
});

// ---------------------------------------------------------------------------
// EQUIVALENCE ANCHORS — every transition vs. the REAL client
// ---------------------------------------------------------------------------
//
// Each transition is anchored by driving the REAL
// `WebChannelNATSClient` with the REAL wire frames and comparing its projected
// `state.messages` against the reducer's output for the corresponding event
// stream:
//
//   user      → the real public `send()` → `publish()` (nats-client-wrapper.ts:847)
//   placement → a real `progress` frame  → `handleFrame`'s `case "progress"`
//   bubble    → a real `agent_message`   → `handleFrame`'s `case "agent_message"`
//   seal      → a real `turn_snapshot`   → `applyTurnSnapshot`
//   reasoning → a real `reasoning` frame → `handleFrame`'s `case "reasoning"`
//
// ⚠️ FIVE, NOT FOUR, SINCE #242 half 2. The header above this section used to
// say "each of the four", and `reasoning` was explicitly excluded because the
// client had no consumer to drive. It has one now.
//
// ⚠️ READ WHAT THESE NOW PROVE, AND WHAT THEY NO LONGER DO. Until the client was
// rewired onto the reducer they were genuinely NON-CIRCULAR: two independent
// implementations of the same reconciliation, compared. The client's durable half
// IS this reducer now, so a green anchor is no longer independent evidence about
// a TRANSITION — the wrapper reaches the same code the left-hand side calls.
//
// They are kept, and still earn it, because what they cover moved rather than
// vanished: the frame→event MAPPING (which falsifiable choices like `id ?? ""`
// vs `if (id)` live in), the client-local overlay merge, the `draftOnly`
// projection, and the dispatch edge — precisely where a rewiring bug lands. Do
// not read them as the reducer's own proof, and do not delete them for being
// "circular": that would drop the mapper's only end-to-end coverage.
//
// WHAT IS COMPARED IS NOW UNIFORM. `placement` used to compare only the SLOT
// SKELETON (id / role / turnId / order) because §15.9 excludes the rolling draft
// text from the durable view while the live client showed it. That carve-out
// closed: the draft is behind the client-local `draftOnly` flag and the client's
// own durable projection blanks it, so all four compare the full view.
//
// Nothing in this section may ever be "fixed" by adjusting an expectation — a red
// anchor means the reducer and the client's mapping diverged.

const registration = {
  devicePrivateKey: {} as CryptoKey,
  deviceX25519PrivateKey: {} as CryptoKey,
};

function newWrapper(): WebChannelNATSClient {
  // The constructor is side-effect-free (no socket until connect()), so this is
  // safe for a pure-reducer comparison.
  return new WebChannelNATSClient({
    natsUrl: "wss://nats.example.com",
    bootstrapJwt: "eyJ-bootstrap",
    accountId: "acct-1",
    tenant: "tenant-1",
    peerId: "peer-1",
    registration,
  });
}

/** The wrapper's internals the anchors reach into. Private on purpose — these
 *  are the real code paths, and a public-surface-only anchor could not reach
 *  them without also dragging in a socket. */
type WrapperInternals = {
  state: { messages: Array<Record<string, unknown>> } & Record<string, unknown>;
  handleMessage: (msg: InboundMessage) => void;
};

/** Seed a real wrapper's `state.messages` from a durable view. The client-local
 *  `working:false` is what a materialized bubble carries live. */
function seed(w: WrapperInternals, starting: DurableView): void {
  w.state = {
    ...w.state,
    // ⚠️ KIND-PRESERVING since #242 half 2. This used to force every entry
    // through `asText`; a reasoning entry in the starting view would now be
    // seeded as a role-less TEXT bubble, and the round trip through
    // `projectDurableFromClient` would report a divergence the client does not
    // have.
    messages: starting.map((m) =>
      m.kind === "reasoning"
        ? { kind: "reasoning", id: m.id, turnId: m.turnId, text: m.text }
        : { id: m.id, role: m.role, text: m.text, turnId: m.turnId, working: false },
    ),
  };
}

/**
 * Project a real wrapper's `state.messages`. Uses the SHARED
 * `projectDurableFromClient` — the same function the wrapper's own
 * `durableProjection` calls — rather than a local copy of the §15.9 draft rule,
 * so there is exactly one definition of what "durable" means for a live bubble.
 *
 * Reading `state.messages` through the RAW `projectDurable` instead would compare
 * the reducer's durable view against the client's RENDER text and report a
 * divergence the design says does not exist.
 */
function projectWrapper(messages: Array<Record<string, unknown>>): DurableView {
  return projectDurableFromClient(
    messages as unknown as Parameters<typeof projectDurableFromClient>[0],
  );
}

/**
 * Drive the REAL private inbound handler (`nats-client-wrapper.ts`'s
 * `handleMessage`) with real wire frames over a starting view, and
 * project the result. This is the same dispatch the socket feeds in production.
 */
function realDrive(starting: DurableView, frames: InboundMessage[]): DurableView {
  const w = newWrapper() as unknown as WrapperInternals;
  seed(w, starting);
  for (const frame of frames) w.handleMessage(frame);
  return projectWrapper(w.state.messages);
}

/** The RENDER view — `state.messages` as the UI sees it, draft text included. */
function realRender(
  starting: DurableView,
  frames: InboundMessage[],
): Array<Record<string, unknown>> {
  const w = newWrapper() as unknown as WrapperInternals;
  seed(w, starting);
  for (const frame of frames) w.handleMessage(frame);
  return w.state.messages;
}

/** Build a `progress` wire frame (`channel-contract.ts:66` — `turnId` OPTIONAL). */
function progressFrame(id: string, text: string, turnId?: string): InboundMessage {
  return {
    type: "progress",
    id,
    text,
    ...(turnId === undefined ? {} : { turnId }),
  } as unknown as InboundMessage;
}

/** Build an `agent_message` wire frame. */
function agentMessageFrame(id: string, text: string, turnId?: string): InboundMessage {
  return {
    type: "agent_message",
    id,
    text,
    ...(turnId === undefined ? {} : { turnId }),
  } as unknown as InboundMessage;
}

/**
 * The SLOT SKELETON of a view — id, role and turnId, but NOT text.
 *
 * Used only by the `placement` anchors, and the omission is deliberate rather
 * than convenient: a `progress` frame carries the rolling draft text ("Working…"),
 * which §15.9 classifies as a 표시기 (indicator), NOT a durable message. The
 * reducer therefore stores `text: ""` at placement on purpose and lets a later
 * `bubble`/`seal` author the durable text. Comparing text on a pure-placement
 * stream would assert the reducer mirrors something it deliberately excludes.
 * Everything placement DOES claim to mirror — that a slot is claimed, where in
 * the order, with which role and turnId — is compared in full. The `bubble` and
 * `seal` anchors below compare the whole view, text included.
 */
function slotSkeleton(view: DurableView): Array<{ id: string; role: DurableRole; turnId?: string }> {
  return view.map(asText).map((m) => ({ id: m.id, role: m.role, turnId: m.turnId }));
}

describe("equivalence anchor: user ≡ the real publish() echo", () => {
  it("appends each user echo at the tail, interleaved with agent bubbles", () => {
    // Drive the REAL public `send()`, which routes through `publish()` and
    // installs the u- bubble at nats-client-wrapper.ts:847. The bubble's ID and
    // turnId are minted by the client (a receipt/wireId concern the durable
    // stream does not model), so they are READ BACK from the real client and fed
    // into the reducer event. Everything `applyUser` actually claims — tail
    // append, ORDER relative to agent bubbles, role, text — is then compared.
    const w = newWrapper();
    const internals = w as unknown as WrapperInternals;

    w.send("first question");
    internals.handleMessage(agentMessageFrame("A", "answer A", TURN));
    w.send("second question");

    const real = projectWrapper(internals.state.messages);

    // Identity fields taken from the real client, never invented here.
    const [u0, , u1] = real;
    expect(asText(u0).role).toBe("user");
    expect(asText(u1).role).toBe("user");

    const events: DurableEvent[] = [
      { kind: "user", id: u0.id, text: "first question", turnId: u0.turnId },
      { kind: "bubble", answerId: "A", text: "answer A", turnId: TURN },
      { kind: "user", id: u1.id, text: "second question", turnId: u1.turnId },
    ];
    expect(reduceDurableView(events)).toEqual(real);
    // Non-vacuity: the interleaving is what the anchor is about.
    expect(real.map((m) => asText(m).role)).toEqual(["user", "agent", "user"]);
  });
});

describe("equivalence anchor: placement ≡ a real progress frame", () => {
  it("first progress claims a slot at the tail (both lanes, in arrival order)", () => {
    const real = realDrive([], [
      progressFrame("A", "Working…", TURN),
      progressFrame("B", "Working…", TURN),
    ]);
    const reduced = reduceDurableView([
      { kind: "placement", answerId: "A", turnId: TURN },
      { kind: "placement", answerId: "B", turnId: TURN },
    ]);
    expect(reduced).toEqual(real);
    expect(slotSkeleton(real)).toEqual([
      { id: "A", role: "agent", turnId: TURN },
      { id: "B", role: "agent", turnId: TURN },
    ]);
  });

  it("a REPEAT progress on a held id keeps the slot and REFRESHES turnId", () => {
    // The mapper applies `turnId: msg.turnId ?? prev.turnId` on EVERY progress,
    // not just the first (`applyPlacement` owns the `??`).
    const real = realDrive([], [
      progressFrame("A", "Working…", "turn-old"),
      progressFrame("A", "Working… more", "turn-new"),
    ]);
    const reduced = reduceDurableView([
      { kind: "placement", answerId: "A", turnId: "turn-old" },
      { kind: "placement", answerId: "A", turnId: "turn-new" },
    ]);
    expect(reduced).toEqual(real);
    expect(slotSkeleton(real)).toEqual([{ id: "A", role: "agent", turnId: "turn-new" }]);
  });

  it("a REPEAT progress WITHOUT turnId keeps the previous one (the `??` direction)", () => {
    const real = realDrive([], [
      progressFrame("A", "Working…", "turn-old"),
      progressFrame("A", "Working… more"),
    ]);
    const reduced = reduceDurableView([
      { kind: "placement", answerId: "A", turnId: "turn-old" },
      { kind: "placement", answerId: "A" },
    ]);
    expect(reduced).toEqual(real);
    expect(slotSkeleton(real)).toEqual([{ id: "A", role: "agent", turnId: "turn-old" }]);
  });

  it("a FIRST progress without turnId claims its slot with turnId undefined", () => {
    // `progress.turnId` is optional on the wire (channel-contract.ts:66;
    // `NatsChannel.sendProgress` omits it when falsy) and the client stores it
    // verbatim.
    // The slot claim must survive — dropping it would lose the
    // ordering the very first test in this file protects.
    const real = realDrive([], [progressFrame("A", "Working…")]);
    const reduced = reduceDurableView([{ kind: "placement", answerId: "A" }]);
    expect(reduced).toEqual(real);
    expect(slotSkeleton(real)).toEqual([{ id: "A", role: "agent", turnId: undefined }]);
  });
});

describe("equivalence anchor: bubble ≡ a real agent_message frame", () => {
  it("an UNKNOWN id appends at the tail as an agent bubble", () => {
    const prior: DurableEvent[] = [{ kind: "bubble", answerId: "A", text: "A", turnId: TURN }];
    const starting = reduceDurableView(prior);
    const real = realDrive(starting, [agentMessageFrame("B", "B (independent)", TURN)]);
    expect(reduceDurableView([
      ...prior,
      { kind: "bubble", answerId: "B", text: "B (independent)", turnId: TURN },
    ])).toEqual(real);
    expect(real.map((m) => m.id)).toEqual(["A", "B"]);
  });

  it("a HELD id (claimed by progress) is updated in place, keeping its slot", () => {
    // The P0 #1 ordering case driven end-to-end through the real client: A
    // claims its slot first, B lands second, A's final must NOT move to the tail.
    const real = realDrive([], [
      progressFrame("A", "Working…", TURN),
      agentMessageFrame("B", "independent notice", TURN),
      agentMessageFrame("A", "answer A (final)", TURN),
    ]);
    const reduced = reduceDurableView([
      { kind: "placement", answerId: "A", turnId: TURN },
      { kind: "bubble", answerId: "B", text: "independent notice", turnId: TURN },
      { kind: "bubble", answerId: "A", text: "answer A (final)", turnId: TURN },
    ]);
    expect(reduced).toEqual(real);
    expect(real.map((m) => m.id)).toEqual(["A", "B"]);
  });

  it("an agent_message on a held id does NOT rewrite that bubble's role", () => {
    // `applyBubble`'s UPDATE branch spreads the held entry and sets text/turnId
    // only; it never writes `role`. Only the APPEND fallback sets `role: "agent"`.
    // (Pre-rewire this asymmetry lived in the wrapper's `upsertMessage` call, and
    // it is preserved verbatim.) Unreachable today (u-/a-/lane id namespaces do
    // not collide), but byte-faithfulness is this module's entire product, and an
    // id-namespace change must break HERE rather than silently reclassifying a
    // user bubble in the durable history.
    const starting: DurableView = [{ kind: "text", id: "u-0", role: "user", text: "mine", turnId: "w-0" }];
    const real = realDrive(starting, [agentMessageFrame("u-0", "overwritten", TURN)]);
    const reduced = applyDurableEvent(starting, {
      kind: "bubble",
      answerId: "u-0",
      text: "overwritten",
      turnId: TURN,
    });
    expect(reduced).toEqual(real);
    expect(asText(real[0]).role).toBe("user");
  });

  it("an agent_message without turnId keeps the held bubble's previous turnId", () => {
    const starting = reduceDurableView([
      { kind: "placement", answerId: "A", turnId: TURN },
    ]);
    const real = realDrive(starting, [agentMessageFrame("A", "A final")]);
    const reduced = applyDurableEvent(starting, {
      kind: "bubble",
      answerId: "A",
      text: "A final",
    });
    expect(reduced).toEqual(real);
    expect(real[0].turnId).toBe(TURN);
  });
});

// ---------------------------------------------------------------------------
// EQUIVALENCE ANCHOR: reducer.seal ≡ the client's REAL turn_snapshot handling.
// ---------------------------------------------------------------------------
//
// For each scenario we (1) build the starting durable view from prior events via
// the reducer, (2) apply the seal event via the reducer, and (3) drive the SAME
// starting messages + snapshot frame through the real client, then project its
// `state.messages` down to the durable view and assert the two are identical.
//
// Step 3 goes through `handleMessage` — the same real dispatch as the other
// three anchors — rather than calling the private `applyTurnSnapshot`
// (`nats-client-wrapper.ts`'s `applyTurnSnapshot`) directly. That method is now
// the frame→event
// mapper plus the per-answer `working:false` / `draftOnly`-clearing overlay, so
// what these cases actually exercise is the MAPPING and the merge, not the
// reconciliation (which is `applySeal`, the left-hand side). Routing it this way
// also covers the dispatch edge, so a frame that stops reaching the handler at
// all fails here instead of passing against a hand-picked private method.

/** Build a `turn_snapshot` wire frame. */
function turnSnapshotFrame(seal: {
  turnId: string;
  answers: Array<{ id: string; text: string }>;
  remove?: string[];
}): InboundMessage {
  return {
    type: "turn_snapshot",
    turnId: seal.turnId,
    answers: seal.answers,
    remove: seal.remove ?? [],
  } as unknown as InboundMessage;
}

/** Drive a real `turn_snapshot` over a starting durable view. */
function realApplyTurnSnapshot(
  starting: DurableView,
  seal: { turnId: string; answers: Array<{ id: string; text: string }>; remove?: string[] },
): DurableView {
  return realDrive(starting, [turnSnapshotFrame(seal)]);
}

describe("equivalence anchor: reduceDurableView(seal) ≡ real turn_snapshot handling", () => {
  const cases: Array<{
    name: string;
    prior: DurableEvent[];
    seal: { turnId: string; answers: Array<{ id: string; text: string }>; remove?: string[] };
  }> = [
    {
      name: "remove ∩ answers (answers win)",
      prior: [
        { kind: "bubble", answerId: "A", turnId: TURN, text: "A" },
        { kind: "bubble", answerId: "X", turnId: TURN, text: "old X" },
      ],
      seal: {
        turnId: TURN,
        answers: [
          { id: "A", text: "A" },
          { id: "X", text: "X (answer wins)" },
        ],
        remove: ["X"],
      },
    },
    {
      name: "mint absent answer (#215 recovery)",
      prior: [{ kind: "bubble", answerId: "A", turnId: TURN, text: "A" }],
      seal: {
        turnId: TURN,
        answers: [
          { id: "A", text: "A" },
          { id: "B", text: "minted B" },
        ],
        remove: [],
      },
    },
    {
      name: "notice slot preservation with answer reorder",
      prior: [
        { kind: "bubble", answerId: "A", turnId: TURN, text: "A" },
        { kind: "bubble", answerId: "NOTICE", turnId: TURN, text: "notice" },
        { kind: "bubble", answerId: "B", turnId: TURN, text: "B" },
      ],
      seal: {
        turnId: TURN,
        answers: [
          { id: "B", text: "B" },
          { id: "A", text: "A" },
        ],
        remove: [],
      },
    },
    {
      name: "non-answer C preserved, answers untouched",
      prior: [
        { kind: "bubble", answerId: "A", turnId: TURN, text: "A" },
        { kind: "bubble", answerId: "B", turnId: TURN, text: "B" },
        { kind: "bubble", answerId: "C", turnId: TURN, text: "C" },
      ],
      seal: {
        turnId: TURN,
        answers: [
          { id: "A", text: "A" },
          { id: "B", text: "B" },
        ],
        remove: [],
      },
    },
    {
      name: "remove-only seal (no answers)",
      prior: [
        { kind: "bubble", answerId: "A", turnId: TURN, text: "A" },
        { kind: "bubble", answerId: "X", turnId: TURN, text: "X" },
      ],
      seal: { turnId: TURN, answers: [], remove: ["X"] },
    },
    {
      name: "two minted answers next to their predecessors",
      prior: [
        { kind: "bubble", answerId: "A", turnId: TURN, text: "A" },
        { kind: "bubble", answerId: "NOTICE", turnId: TURN, text: "notice" },
      ],
      seal: {
        turnId: TURN,
        answers: [
          { id: "A", text: "A" },
          { id: "B", text: "minted B" },
          { id: "C", text: "minted C" },
        ],
        remove: [],
      },
    },
    // Covers `applySeal` step 3's `k === 0` sub-branch — the one that runs when
    // answers[0] is ABSENT from the view while a LATER answer is PRESENT. Every
    // other case above mints only at k > 0 (predecessor lookup) or has no
    // surviving answer to anchor against, so WITHOUT this case the branch is
    // DEAD to the suite: deleting its body leaves the whole file green while
    // silently changing ORDERING — [Z, A, NOTICE] becomes [Z, NOTICE, A] — which
    // is precisely the property this module exists to guarantee.
    {
      name: "minted answers[0] lands at the FIRST answer slot, not the tail",
      prior: [
        { kind: "bubble", answerId: "A", turnId: TURN, text: "A" },
        { kind: "bubble", answerId: "NOTICE", turnId: TURN, text: "notice" },
      ],
      seal: {
        turnId: TURN,
        answers: [
          { id: "Z", text: "minted Z" },
          { id: "A", text: "A" },
        ],
        remove: [],
      },
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      const starting = reduceDurableView(c.prior);
      const reducerResult = reduceDurableView([
        ...c.prior,
        { kind: "seal", ...c.seal },
      ]);
      const realResult = realApplyTurnSnapshot(starting, c.seal);
      expect(reducerResult).toEqual(realResult);
    });
  }
});

describe("equivalence anchor: reasoning ≡ a real reasoning frame", () => {
  /** Build a `reasoning` wire frame (`channel-contract.ts` — `turnId` REQUIRED). */
  function reasoningFrame(
    id: string,
    turnId: string,
    text: string,
    final?: boolean,
  ): InboundMessage {
    return {
      type: "reasoning",
      id,
      turnId,
      text,
      ...(final === undefined ? {} : { final }),
    } as unknown as InboundMessage;
  }

  it("appends an unseen burst at the tail, among the turn's bubbles", () => {
    const prior: DurableEvent[] = [
      { kind: "bubble", answerId: "A", turnId: TURN, text: "first" },
    ];
    const starting = reduceDurableView(prior);
    const event: DurableEvent = { kind: "reasoning", id: "r1", turnId: TURN, text: "hmm" };

    expect(realDrive(starting, [reasoningFrame("r1", TURN, "hmm")])).toEqual(
      reduceDurableView([...prior, event]),
    );
  });

  it("upserts by id across a whole cumulative burst — N frames, ONE entry", () => {
    // The live lane sends a frame per cumulative token update, each carrying the
    // full text so far, and closes with one more carrying `final: true`. The
    // JOURNAL records only that last one. This is the anchor that makes the two
    // agree: folding all N frames converges on exactly the single `final` event.
    const frames = [
      reasoningFrame("r1", TURN, "Let"),
      reasoningFrame("r1", TURN, "Let me"),
      reasoningFrame("r1", TURN, "Let me think"),
      reasoningFrame("r1", TURN, "Let me think", true),
    ];
    const journaled: DurableEvent[] = [
      { kind: "reasoning", id: "r1", turnId: TURN, text: "Let me think" },
    ];
    expect(realDrive([], frames)).toEqual(reduceDurableView(journaled));
  });

  it("a second burst claims its own slot after the answer it followed", () => {
    const prior: DurableEvent[] = [
      { kind: "reasoning", id: "r1", turnId: TURN, text: "first thought" },
      { kind: "bubble", answerId: "A", turnId: TURN, text: "an answer" },
    ];
    const starting = reduceDurableView(prior);
    const event: DurableEvent = { kind: "reasoning", id: "r2", turnId: TURN, text: "second" };
    expect(realDrive(starting, [reasoningFrame("r2", TURN, "second")])).toEqual(
      reduceDurableView([...prior, event]),
    );
  });

  it("the MAPPER drops a frame the reducer could not represent, and the anchor sees it", () => {
    // `case "reasoning"`'s guard, stated as an equivalence rather than as a unit
    // test of the guard: a frame with no `turnId` (or empty text) produces NO
    // event, because `DurableMessage`'s reasoning variant requires a `turnId`
    // and the client refuses to invent one.
    const starting = reduceDurableView([
      { kind: "bubble", answerId: "A", turnId: TURN, text: "a" },
    ]);
    for (const bad of [
      { type: "reasoning", id: "r1", text: "orphan" },
      { type: "reasoning", id: "r1", turnId: "", text: "orphan" },
      { type: "reasoning", id: "r1", turnId: TURN, text: "" },
      { type: "reasoning", turnId: TURN, text: "no id" },
    ]) {
      expect(realDrive(starting, [bad as unknown as InboundMessage])).toEqual(starting);
    }
  });
});

// ---------------------------------------------------------------------------
// ⭐ THE v6 BET, END TO END, FOR REASONING (#242 half 2)
// ---------------------------------------------------------------------------
//
// "A reasoning block the user watched live is still there after a reload, in the
// position it was delivered." That sentence is the slice, and this is the case
// that decides it. It is deliberately NOT a reducer-vs-reducer comparison:
//
//   LIVE    — the REAL `WebChannelNATSClient`, driven by the REAL wire frames a
//             turn emits, INCLUDING the untorn cumulative reasoning stream.
//   REPLAY  — the REAL `history` frame the plugin would serve for the same turn,
//             delivered to a FRESH client with empty state, which is exactly what
//             a reload does.
//
// ⚠️ THE ROWS ARE NOT HAND-WRITTEN HERE, AND THAT IS THE POINT OF THE HARNESS.
// Round 1 had this file and `packages/plugin/src/journal-history.test.ts`
// carrying INDEPENDENT literals for the same turn, with a comment claiming
// "if either side is edited alone, one of the two goes red" — which was false:
// nothing connected them, and their `ts` values already differed. Both now
// import `reasoning-turn.test-harness.ts`, so there is ONE definition of the
// turn and ONE definition of the rows it must serve. The plugin half proves the
// projection EMITS those rows; this half proves the client RENDERS them the same
// as live. Neither can be edited alone.
import {
  INTERLEAVED_TURN_FRAMES,
  INTERLEAVED_TURN_LIVE_IDS,
  INTERLEAVED_TURN_REPLAY_IDS,
  ORDINARY_TURN_FRAMES,
  ORDINARY_TURN_ROWS,
  REASONING_TURN,
  type ReasoningTurnFrame,
  type ReasoningTurnRow,
} from "./reasoning-turn.test-harness.js";

/** A fixture frame, as the wrapper's inbound dispatcher receives it. */
function inbound(frame: ReasoningTurnFrame): InboundMessage {
  return frame as unknown as InboundMessage;
}

/** A fixture row, as a `history` frame carries it — `ts` added by position. */
function servedRow(row: ReasoningTurnRow, index: number): unknown {
  return { ...row, ts: index + 1 };
}

describe("live == history for reasoning: a reload reproduces what was watched", () => {
  /**
   * The DURABLE fields of a transcript. `ts`/`working` are the client-local
   * overlay §0.1 puts on the app's side of the split, and a live bubble
   * legitimately has no `ts`, so they are excluded from the comparison.
   */
  function durable(list: Array<Record<string, unknown>>): unknown[] {
    return list.map((m) =>
      m.kind === "reasoning"
        ? { kind: "reasoning", id: m.id, turnId: m.turnId, text: m.text }
        : { id: m.id, role: m.role, text: m.text },
    );
  }

  it("same content, same position — across a turn with two bursts and two answers", () => {
    // ── LIVE ──
    const w = newWrapper() as unknown as WrapperInternals;
    for (const frame of ORDINARY_TURN_FRAMES) w.handleMessage(inbound(frame));
    const live = w.state.messages;
    expect(live.map((m) => m.id)).toEqual(["r1", "A", "r2", "B"]);

    // ── REPLAY ── the rows the plugin's projection emits for that same journal.
    // Reasoning rows carry NO `role`; `toEqual` on the durable projection below
    // would fail if one appeared.
    const fresh = newWrapper() as unknown as WrapperInternals;
    fresh.handleMessage({
      type: "history",
      messages: ORDINARY_TURN_ROWS.map(servedRow),
    } as unknown as InboundMessage);

    // ⭐ SAME CONTENT, SAME POSITION.
    expect(durable(fresh.state.messages)).toEqual(durable(live));
    // Non-vacuity: the shared fixture really does describe this turn, so a
    // fixture edit cannot make the equality above pass by emptying both sides.
    expect(durable(live)).toEqual(ORDINARY_TURN_ROWS.map((row) => ({ ...row })));

    // And the derived public surface agrees too, since that is what a widget
    // reads: same bursts, same order, same text.
    const reasoningOf = (x: WrapperInternals) =>
      (x.state as unknown as { reasoning: unknown[] }).reasoning;
    expect(reasoningOf(fresh)).toEqual(reasoningOf(w));
    expect(reasoningOf(fresh)).toEqual([
      { id: "r1", turnId: REASONING_TURN, text: "Let me think" },
      { id: "r2", turnId: REASONING_TURN, text: "and also" },
    ]);
  });

  it("a MID-SESSION snapshot re-serving the same turn is a no-op — tier 1 matches by id", () => {
    // The other half of "still there": a snapshot arrives at every device
    // mid-session (Phase 6), so the reload path must not DUPLICATE a block this
    // device already rendered. Reasoning ids are plugin-minted and identical
    // live and in history, so they match at tier 1.
    const w = newWrapper() as unknown as WrapperInternals;
    for (const frame of ORDINARY_TURN_FRAMES) w.handleMessage(inbound(frame));
    const before = w.state.messages.map((m) => m.id);

    w.handleMessage({
      type: "history",
      messages: ORDINARY_TURN_ROWS.map(servedRow),
    } as unknown as InboundMessage);

    expect(w.state.messages.map((m) => m.id)).toEqual(before);
    expect(w.state.messages.map((m) => m.id)).toEqual(["r1", "A", "r2", "B"]);
  });

  /**
   * ⚠️ CHARACTERIZATION — GAP 2b, THE ONE STREAM WHERE THEY DO NOT AGREE.
   *
   * Recorded, not endorsed. It is here because the pair's shared fixture above
   * cannot reach it (every burst there closes before the next answer's
   * `progress`), and round 1 asserted a DICHOTOMY — "safe if closed by
   * `endBurst`, broken if closed at turn end" — that this stream refutes: the
   * burst below closes via `endBurst`, mid-turn, and still diverges. The real
   * invariant is stated once, in `journal-history.ts`'s conversion loop.
   *
   * The plugin half drives the same fixture through the REAL mapper and the REAL
   * projection, so both directions are pinned in both packages.
   */
  it("CHARACTERIZATION: an answer slot claimed mid-burst puts live and replay out of order", () => {
    const w = newWrapper() as unknown as WrapperInternals;
    for (const frame of INTERLEAVED_TURN_FRAMES) w.handleMessage(inbound(frame));
    expect(w.state.messages.map((m) => m.id)).toEqual([...INTERLEAVED_TURN_LIVE_IDS]);

    // The replay order, computed by the same reducer the server projection runs.
    const replayed = reduceDurableView([
      { kind: "placement", answerId: "A", turnId: REASONING_TURN },
      { kind: "reasoning", id: "r1", turnId: REASONING_TURN, text: "thinking" },
      { kind: "bubble", answerId: "A", turnId: REASONING_TURN, text: "because" },
    ]);
    expect(replayed.map((m) => m.id)).toEqual([...INTERLEAVED_TURN_REPLAY_IDS]);

    // The point of the case, said out loud so nobody "fixes" the expectations:
    expect(INTERLEAVED_TURN_LIVE_IDS).not.toEqual(INTERLEAVED_TURN_REPLAY_IDS);
  });
});
