import { describe, it, expect } from "vitest";

import {
  applyDurableEvent,
  reduceDurableView,
  projectDurable,
  type DurableEvent,
  type DurableRole,
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
//  - the EQUIVALENCE ANCHOR asserts the reducer's `seal` transition equals the
//    client's REAL private `applyTurnSnapshot` for the same starting messages +
//    snapshot. It instantiates the REAL `WebChannelNATSClient` on purpose: an
//    anchor against a copy of the reducer would be circular and prove nothing.

const TURN = "turn-1";

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
      { id: "A", role: "agent", text: "answer A (final)", turnId: TURN },
      { id: "B", role: "agent", text: "independent notice", turnId: TURN },
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
      { id: "u-0", role: "user", text: "hello", turnId: "w-0" },
      { id: "A", role: "agent", text: "hi back", turnId: TURN },
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
        { id: "u-0", role: "user", text: "do the thing", turnId: "w-0" },
        { id: "A", role: "agent", text: "A final", turnId: TURN },
        { id: "NOTICE", role: "agent", text: "a notice", turnId: TURN },
        { id: "X", role: "agent", text: "mis-routed overflow", turnId: TURN },
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
  // Array identity is a PARTIAL property: two transitions hand the input back on
  // a durable no-op, two others always allocate. The negative rows matter as much
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
});

// ---------------------------------------------------------------------------
// CHARACTERIZATION — the duplicate-`user` precondition
// ---------------------------------------------------------------------------
//
// These record what the reducer DOES on a journal that violates its stated
// precondition (no duplicate `user` rows). They are NOT endorsements, and the
// behavior is deliberately not "fixed" here: the live client does the same thing
// at nats-client-wrapper.ts:1552-1554, and inventing a dedupe rule the client
// lacks is exactly the defect class this slice forbids. Idempotent append is the
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
      { id: "u-0", role: "user", text: "same message", turnId: "w-0" },
      { id: "u-0", role: "user", text: "same message", turnId: "w-0" },
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
  it("placement drops the draft text the live view shows (§15.9 indicator, not a message)", () => {
    // `progress.text` is REQUIRED on the wire (channel-contract.ts:66) and the
    // real client writes it into the bubble (nats-client-wrapper.ts:2472-2473).
    // The reducer appends `text: ""` instead. That is the settled §15.9 decision
    // — the rolling draft is a 표시기 (indicator), not a message — and it is the
    // ONLY reason the `placement` anchors compare `slotSkeleton` rather than the
    // whole view. Recorded here so the delta is a fact in the suite instead of a
    // gap: do NOT "fix" the reducer to match, and do NOT widen the placement
    // anchors to compare text — either move is a §15.9 reversal that belongs in
    // the doc first.
    const real = realDrive([], [progressFrame("A", "partial answer so far", TURN)]);
    const reduced = reduceDurableView([{ kind: "placement", answerId: "A", turnId: TURN }]);

    expect(real[0].text).toBe("partial answer so far");
    expect(reduced[0].text).toBe("");
    // …and the divergence is confined to `text`: everything placement DOES claim
    // to mirror still matches exactly.
    expect(slotSkeleton(reduced)).toEqual(slotSkeleton(real));
  });

  it('bubble with an EMPTY answerId is NOT "id-less" — the live client mints separate bubbles', () => {
    // The client's two id sites use DIFFERENT falsiness, and this is the trap it
    // sets for slice 2's mapper (see BOUNDARY 1 in durable-view-reducer.ts):
    //   - `progress` upserts on `id ?? ""` (…:2471) — NULLISH, so "" survives as
    //     a real id, which is why `placement` with `answerId: ""` is FAITHFUL;
    //   - `agent_message` branches on `if (id)` (…:2569) — TRUTHY, so "" falls
    //     into the id-less mint branch at …:2593 and gets a fresh `a-<n>`.
    // So two id-less finals are TWO bubbles live, while a mapper that mirrors the
    // progress site verbatim (`answerId: frame.id ?? ""`) collapses them into ONE
    // durable row — an N8 live≠history divergence landing in the mapper. Hence
    // `bubble.answerId` must be NON-EMPTY; "" is not the encoding for "id-less",
    // and until #238 an id-less `agent_message` has NO `bubble` event at all.
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
// This module's ONLY claim is that it is a faithful mirror of what the client
// does TODAY. A hand-written expectation cannot distinguish a faithful mirror
// from a merely plausible one, so each of the four transitions is anchored by
// driving the REAL `WebChannelNATSClient` with the REAL wire frames and
// comparing its projected `state.messages` against the reducer's output for the
// corresponding event stream:
//
//   user      → the real public `send()` → `publish()` (nats-client-wrapper.ts:804)
//   placement → a real `progress` frame  → `handleMessage` case (…:2467)
//   bubble    → a real `agent_message`   → `handleMessage` case (…:2562)
//   seal      → a real `turn_snapshot`   → `applyTurnSnapshot`  (…:1486-1557)
//
// WHAT IS COMPARED IS NOT UNIFORM, and the difference is a carve-out rather than
// an oversight. `user`, `bubble` and `seal` compare the FULL projected view
// (`projectDurable(state.messages)`, text included). `placement` compares only
// the SLOT SKELETON — id / role / turnId / order — because §15.9 excludes the
// rolling draft text from the durable view, so the reducer deliberately stores
// `text: ""` where the live client shows the draft. That single delta is itself
// pinned, by the characterization test above ("placement drops the draft text
// the live view shows"), so it is observed and not merely narrated.
//
// The discipline that makes these worth anything is NON-CIRCULARITY: they call
// real client code, never a second copy of the reducer. Nothing in this section
// may ever be "fixed" by adjusting an expectation — a red anchor means the
// reducer diverged from the client and the REDUCER is what changes.

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
    messages: starting.map((m) => ({
      id: m.id,
      role: m.role,
      text: m.text,
      turnId: m.turnId,
      working: false,
    })),
  };
}

/**
 * Drive the REAL private inbound handler (`handleMessage`,
 * nats-client-wrapper.ts:2048) with real wire frames over a starting view, and
 * project the result. This is the same dispatch the socket feeds in production.
 */
function realDrive(starting: DurableView, frames: InboundMessage[]): DurableView {
  const w = newWrapper() as unknown as WrapperInternals;
  seed(w, starting);
  for (const frame of frames) w.handleMessage(frame);
  return projectDurable(
    w.state.messages as unknown as Array<{
      id: string;
      role: DurableRole;
      text: string;
      turnId?: string;
    }>,
  );
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
  return view.map((m) => ({ id: m.id, role: m.role, turnId: m.turnId }));
}

describe("equivalence anchor: user ≡ the real publish() echo", () => {
  it("appends each user echo at the tail, interleaved with agent bubbles", () => {
    // Drive the REAL public `send()`, which routes through `publish()` and
    // installs the u- bubble at nats-client-wrapper.ts:804. The bubble's ID and
    // turnId are minted by the client (a receipt/wireId concern the durable
    // stream does not model), so they are READ BACK from the real client and fed
    // into the reducer event. Everything `applyUser` actually claims — tail
    // append, ORDER relative to agent bubbles, role, text — is then compared.
    const w = newWrapper();
    const internals = w as unknown as WrapperInternals;

    w.send("first question");
    internals.handleMessage(agentMessageFrame("A", "answer A", TURN));
    w.send("second question");

    const real = projectDurable(
      internals.state.messages as unknown as Array<{
        id: string;
        role: DurableRole;
        text: string;
        turnId?: string;
      }>,
    );

    // Identity fields taken from the real client, never invented here.
    const [u0, , u1] = real;
    expect(u0.role).toBe("user");
    expect(u1.role).toBe("user");

    const events: DurableEvent[] = [
      { kind: "user", id: u0.id, text: "first question", turnId: u0.turnId },
      { kind: "bubble", answerId: "A", text: "answer A", turnId: TURN },
      { kind: "user", id: u1.id, text: "second question", turnId: u1.turnId },
    ];
    expect(reduceDurableView(events)).toEqual(real);
    // Non-vacuity: the interleaving is what the anchor is about.
    expect(real.map((m) => m.role)).toEqual(["user", "agent", "user"]);
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
    expect(slotSkeleton(reduced)).toEqual(slotSkeleton(real));
    expect(slotSkeleton(real)).toEqual([
      { id: "A", role: "agent", turnId: TURN },
      { id: "B", role: "agent", turnId: TURN },
    ]);
  });

  it("a REPEAT progress on a held id keeps the slot and REFRESHES turnId", () => {
    // nats-client-wrapper.ts:2472 applies `turnId: msg.turnId ?? prev.turnId` on
    // EVERY progress, not just the first.
    const real = realDrive([], [
      progressFrame("A", "Working…", "turn-old"),
      progressFrame("A", "Working… more", "turn-new"),
    ]);
    const reduced = reduceDurableView([
      { kind: "placement", answerId: "A", turnId: "turn-old" },
      { kind: "placement", answerId: "A", turnId: "turn-new" },
    ]);
    expect(slotSkeleton(reduced)).toEqual(slotSkeleton(real));
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
    expect(slotSkeleton(reduced)).toEqual(slotSkeleton(real));
    expect(slotSkeleton(real)).toEqual([{ id: "A", role: "agent", turnId: "turn-old" }]);
  });

  it("a FIRST progress without turnId claims its slot with turnId undefined", () => {
    // `progress.turnId` is optional on the wire (channel-contract.ts:66;
    // nats-channel.ts:469 omits it when falsy) and the client stores it verbatim
    // (…:2473). The slot claim must survive — dropping it would lose the
    // ordering the very first test in this file protects.
    const real = realDrive([], [progressFrame("A", "Working…")]);
    const reduced = reduceDurableView([{ kind: "placement", answerId: "A" }]);
    expect(slotSkeleton(reduced)).toEqual(slotSkeleton(real));
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
    // nats-client-wrapper.ts:2571-2578 — the UPDATE branch spreads `prev` and
    // sets text/working/turnId only; it never writes `role`. Only the APPEND
    // fallback (…:2579-2586) sets `role: "agent"`. Unreachable today (u-/a-/lane
    // id namespaces do not collide), but byte-faithfulness is this module's
    // entire product, and an id-namespace change must break HERE rather than
    // silently reclassifying a user bubble in the durable history.
    const starting: DurableView = [{ id: "u-0", role: "user", text: "mine", turnId: "w-0" }];
    const real = realDrive(starting, [agentMessageFrame("u-0", "overwritten", TURN)]);
    const reduced = applyDurableEvent(starting, {
      kind: "bubble",
      answerId: "u-0",
      text: "overwritten",
      turnId: TURN,
    });
    expect(reduced).toEqual(real);
    expect(real[0].role).toBe("user");
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
// (nats-client-wrapper.ts:1486-1557) directly. `case "turn_snapshot"` (…:2557)
// is a bare delegation today, so nothing is lost; routing it this way also
// covers the dispatch edge, so a frame that stops reaching the handler at all
// fails here instead of passing against a hand-picked private method.

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
