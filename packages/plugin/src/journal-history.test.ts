/**
 * v6 #240 — the journal → history projection, and the seam the live read path
 * calls it through.
 *
 * WHAT THESE PIN, AND WHAT THEY DELIBERATELY DO NOT. The module's whole product
 * is that it does NOT re-implement the reducer, so re-asserting the reducer's
 * transition rules here would be the very fork it exists to prevent (N8): a
 * second rule table, in the plugin, free to drift. The exhaustive behavioral
 * coverage lives in `packages/client/src/durable-view-reducer.test.ts`, and
 * `durable-view-reducer-contract.test.ts` already pins that the plugin can
 * consume it.
 *
 * So the no-reimplementation property is stated ONCE, as a property —
 * "the projected order is exactly `reduceDurableView(events).map(m => m.id)`" —
 * and everything else here is PROJECTION concern:
 *   - chunking: that it really chunks, that chunk size cannot change the answer,
 *     that an illegal `chunkRows` is REFUSED before any read, and that a reader
 *     which fails to advance terminates instead of spinning;
 *   - `ts`: first-appearance sourcing, including the seal-MINTED answer that
 *     never egressed a bubble and the post-`remove` same-id bubble that is now
 *     REFUSED (tombstone dominance, #241 half 2 — it used to resurrect), plus the
 *     fallback and the anchor that feeds it;
 *   - unknown kinds: counted, excluded, and harmless to the surrounding fold;
 *   - paging: every edge of the two pure selectors;
 *   - `serveHistoryRequest`: plan dispatch, and that a store failure
 *     PROPAGATES rather than degrading to an empty page — half 2 made this the
 *     only history read path, so `[]` on failure would impersonate an empty
 *     conversation to its owner.
 * Plus two tests against a REAL `openDeliveryJournal`, because nothing else
 * proves the projection and the store compose.
 *
 * THREE CHARACTERIZATION CASES record known-wrong-ish behaviour rather than
 * endorsing it — a `NaN` limit reaching `slice`, pinned on BOTH selectors because
 * the shared docblock claims they guard alike (inherited from
 * `history.ts:pageBefore` deliberately, see that selector's docblock), and an id
 * dated by a `seal` the REDUCER rejected (`recordFirstSeen`'s docblock has the
 * full argument for documenting instead of fixing). All three are labelled
 * CHARACTERIZATION in their names so nobody reads them as specifications.
 *
 * ⚠️ TWO TESTS ELSEWHERE IN THIS FILE — neither of them one of those three — ARE
 * MUTATION-PROVED AND MUST STAY THAT WAY. The ts-anchor test
 * goes red only if `lastCreatedMs` stops advancing across unsupported rows, and
 * the non-advancing test THROWS on a call bound rather than relying on a timeout
 * — because deleting the loop guard produces a synchronous `for(;;)` that blocks
 * the event loop, which `testTimeout` cannot interrupt. Do not "simplify" that
 * bound away; without it the mutation wedges a CI worker instead of failing.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  openDeliveryJournal,
  type DeliveryJournal,
  type DeliveryJournalRow,
} from "./delivery-journal.js";
import {
  journalEventForOutbound,
  type JournalEvent,
} from "./delivery-journal-event.js";
import type { OutboundWsMessage } from "./channel-contract.js";
import type { ProjectedHistoryMessage } from "./history.js";
import {
  HISTORY_REPLAY_CHUNK_ROWS,
  historyPageBefore,
  projectJournalHistory,
  recentHistoryPage,
  serveHistoryRequest,
  type JournalReader,
} from "./journal-history.js";
import {
  reduceDurableView,
  type DurableMessage,
} from "../../client/src/durable-view-reducer.js";

const TURN = "turn-1";
const CONV = "conv-0";

/** First row's `created_ms`, and the step between rows. Round so `ts` reads. */
const T0 = 1_000_000;
const T_STEP = 10;

/**
 * The representative journal: a user echo, slot claims, a notice, durable
 * bubbles, a seal that BOTH reorders two answers and MINTS a third that never
 * egressed a bubble (the #215 create-or-update recovery) and removes a
 * mis-routed overflow bubble, then a post-`remove` same-id bubble that is
 * REFUSED — since #241 half 2 the `remove` tombstones the id and no later frame
 * resurrects it (the events are unchanged; only the OUTCOME flipped).
 *
 * ⚠️ COPIED from `durable-view-reducer-contract.test.ts`'s `STREAM` (itself a
 * copy of the client test's `MIXED_STREAM`) rather than imported, and that is
 * deliberate — that file's own header makes the argument: a fixture shared
 * across the packages lets both sides drift TOGETHER, so the copy is the
 * mechanism, not duplication to tidy up. Here the point is narrower still: this
 * file must be able to state what the projection outputs for a stream WITHOUT
 * being able to change what the other two files assert for it.
 */
const MIXED_STREAM: JournalEvent[] = [
  { kind: "user", id: "u-0", text: "do the thing", turnId: "w-0" },
  { kind: "placement", answerId: "A", turnId: TURN },
  { kind: "placement", answerId: "A", turnId: TURN }, // repeat claim → durable no-op
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

/**
 * `MIXED_STREAM` with a SECOND `user` event spliced into the middle.
 *
 * ⚠️ THIS EXISTS BECAUSE THE CHUNK-EQUIVALENCE TEST COULD NOT SEE A RE-FOLD.
 * `applyUser` is the ONLY non-idempotent transition — `placement` and `bubble`
 * upsert, `seal` is keyed by answer id — so a chunk loop that re-reads rows it
 * already folded is invisible unless a `user` event lands inside the overlap.
 * `MIXED_STREAM` has exactly one, at seq 1, which no overlap can reach.
 * MEASURED: mutating the loop's `afterSeq = lastSeq` to `afterSeq = rows[0].seq`
 * re-folds rows every chunk and the equivalence test STAYED GREEN on
 * `MIXED_STREAM` alone (other tests caught it; that test did not).
 *
 * A separate stream rather than an edit to `MIXED_STREAM`: that fixture is a
 * VERBATIM copy of the one in `durable-view-reducer-contract.test.ts` and the
 * client's reducer test, and the copy is the drift mechanism — see its comment.
 * Changing it here would quietly fork the three.
 */
const RE_FOLD_SENSITIVE_STREAM: JournalEvent[] = [
  ...MIXED_STREAM.slice(0, 5),
  { kind: "user", id: "u-1", text: "and another thing", turnId: "w-1" },
  ...MIXED_STREAM.slice(5),
];

/** Rows as the store would hand them back: 1-based contiguous seq, rising ts. */
function rowsFor(events: readonly unknown[]): DeliveryJournalRow[] {
  return events.map((event, i) => ({
    seq: i + 1,
    kind: (event as { kind: string }).kind,
    event: event as DeliveryJournalRow["event"],
    createdMs: T0 + i * T_STEP,
  }));
}

/**
 * An in-memory `read` with the REAL statement's semantics — `seq > afterSeq`,
 * `ORDER BY seq ASC`, `LIMIT ?` (see `delivery-journal.ts`'s `selectRows`) — plus
 * a call log, so a test can assert that chunking actually issued several reads
 * rather than one.
 */
function fakeReader(rows: readonly DeliveryJournalRow[]): {
  read: JournalReader;
  calls: Array<{ afterSeq: number; limit: number | undefined }>;
} {
  const calls: Array<{ afterSeq: number; limit: number | undefined }> = [];
  const read: JournalReader = (conversationId, options) => {
    calls.push({ afterSeq: options?.afterSeq ?? 0, limit: options?.limit });
    if (conversationId !== CONV) return [];
    const after = options?.afterSeq ?? 0;
    const matching = rows.filter((row) => row.seq > after);
    return options?.limit === undefined
      ? matching.slice()
      : matching.slice(0, options.limit);
  };
  return { read, calls };
}

describe("projectJournalHistory — the fold", () => {
  it("projects an empty conversation to an empty view with zero counters", () => {
    const { read, calls } = fakeReader([]);
    expect(projectJournalHistory(read, CONV)).toEqual({
      messages: [],
      unsupportedEvents: 0,
      tsFallbacks: 0,
    });
    // One read, and it stopped: an empty first chunk is shorter than the chunk
    // size, so the loop must not ask again.
    expect(calls).toEqual([{ afterSeq: 0, limit: HISTORY_REPLAY_CHUNK_ROWS }]);
  });

  it("projects a single user message, ts from its own row", () => {
    const { read } = fakeReader(
      rowsFor([{ kind: "user", id: "u-0", text: "hi" } satisfies JournalEvent]),
    );
    expect(projectJournalHistory(read, CONV).messages).toEqual([
      { id: "u-0", role: "user", text: "hi", ts: T0 },
    ]);
  });

  // ⚠️ THERE WAS A "returns nothing for an unknown conversation id" CASE HERE,
  // and it was DELETED rather than kept. Against `fakeReader` it asserted the
  // FIXTURE's own `conversationId !== CONV` filter, not this module's behaviour —
  // the module only forwards the argument. Conversation scoping is pinned where
  // it is a real claim: the real-store integration below writes TWO conversations
  // into ONE database file and projects each.

  it("projects the full mixed stream — order, role, text and ts", () => {
    const { read } = fakeReader(rowsFor(MIXED_STREAM));
    const projection = projectJournalHistory(read, CONV);
    expect(projection.unsupportedEvents).toBe(0);
    expect(projection.tsFallbacks).toBe(0);
    // The seal TOMBSTONES X and reorders the answer slots to [B, A]; C is MINTED
    // next to its predecessor answer A, which shifts NOTICE one slot right; the
    // trailing bubble does NOT resurrect X (tombstone dominance, #241 half 2), and
    // the tombstone is STRIPPED here — so X is absent from the served history.
    // Every one of those is the REDUCER's doing (plus this module's strip) — this
    // file asserts the projection carries them through, it does not re-derive them.
    expect(projection.messages).toEqual([
      { id: "u-0", role: "user", text: "do the thing", ts: T0 + 0 * T_STEP },
      { id: "B", role: "agent", text: "B (sealed)", ts: T0 + 4 * T_STEP },
      { id: "A", role: "agent", text: "A (sealed)", ts: T0 + 1 * T_STEP },
      { id: "NOTICE", role: "agent", text: "a notice", ts: T0 + 3 * T_STEP },
      { id: "C", role: "agent", text: "C (minted)", ts: T0 + 7 * T_STEP },
    ]);
  });

  it("emits the REDUCER's order, never a sort — ts is non-monotone and that is correct", () => {
    // THE no-reimplementation property, stated once. If this module ever grows
    // its own ordering rule — or "helpfully" sorts by ts — this is what goes red.
    const { read } = fakeReader(rowsFor(MIXED_STREAM));
    const projected = projectJournalHistory(read, CONV).messages;
    // Compared against the VISIBLE reducer view (#241 half 2: the tombstone from
    // `seal.remove` X is retained in the fold but stripped from the served list).
    expect(projected.map((m) => m.id)).toEqual(
      visibleView(reduceDurableView(MIXED_STREAM)).map((m) => m.id),
    );
    // And the stream is one where the two orders genuinely differ: B's first
    // appearance is LATER than A's, yet the seal puts B first. A ts sort would
    // silently pass the id check against a sorted expectation, so assert the
    // inversion directly.
    const ts = projected.map((m) => m.ts);
    expect(ts).not.toEqual([...ts].sort((a, b) => a - b));
  });

  it("carries the reducer's full durable view, text included", () => {
    // ⚠️ NO KIND FILTER SINCE #242 half 2. Half 1 filtered the reducer's view to
    // `kind === "text"` here, because the emitted list was the view MINUS
    // reasoning. The emitted list is the WHOLE view now — minus #241 tombstones,
    // which `visibleView` strips from the reducer side to match the served list —
    // so the equality is the stronger, unfiltered one, and it stays a no-op
    // distinction for reasoning on `MIXED_STREAM`, which holds no `reasoning`
    // event; the reasoning case has its own describe below.
    const { read } = fakeReader(rowsFor(MIXED_STREAM));
    const projected = projectJournalHistory(read, CONV).messages;
    expect(projected.map(comparableRow)).toEqual(
      visibleView(reduceDurableView(MIXED_STREAM)).map(comparableRow),
    );
  });
});

/**
 * The shape the wire row and the reducer entry are compared in — ONE function,
 * applied to BOTH sides, so the comparison can never be made to pass by mapping
 * the two halves differently.
 *
 * ⚠️ IT BRANCHES ON `kind` FOR ALL THREE ARMS, INCLUDING THE ONE NO FIXTURE
 * PRODUCES. Until #242 half 3 this was a two-way ternary inlined twice, and it
 * only type-checked because "not `reasoning` ⇒ has `role` and `text`" was
 * exhaustive. The `tool` arm carries NEITHER, so that inference is gone — and
 * inferring content from an absent tag is the habit v6 exists to remove, so the
 * arm is written out rather than folded into the bubble branch where it would
 * read `undefined` into `role`/`text` on both sides and compare equal for the
 * wrong reason. `MIXED_STREAM` holds no `tool` event today; the branch is what
 * makes adding one a real comparison instead of a silent pair of blanks.
 *
 * It drops `ts` on purpose (the wire has it, the reducer does not) and is
 * otherwise the FULL durable content of each arm — the equality stays the
 * strong, unfiltered one that #242 half 2 made it.
 */
/**
 * Find a projected row by id and narrow it to the TEXT variant.
 *
 * ⚠️ `undefined` IS PASSED THROUGH, DELIBERATELY. The callers assert with
 * `?.ts` / `?.text`, so an ABSENT id must keep failing exactly as it did — that
 * is the property those cases are about. Only a row that is PRESENT under a
 * `reasoning`/`tool` tag throws, because neither of those carries `text` and a
 * silent skip would turn "the projection tagged this row wrong" into a passing
 * `undefined === undefined`.
 */
function findTextRow(
  messages: readonly ProjectedHistoryMessage[],
  id: string,
): (ProjectedHistoryMessage & { kind?: undefined }) | undefined {
  const found = messages.find((m) => m.id === id);
  if (found === undefined) return undefined;
  if (found.kind !== undefined) {
    throw new Error(`expected a text history row for id=${id}, received kind=${found.kind}`);
  }
  return found;
}

/**
 * The reducer's view with #241 tombstones stripped — the projection's `messages`
 * are compared against THIS, not the raw view, because a `seal.remove`d id is
 * retained in the fold as a tombstone (so no later event resurrects it) but is
 * dropped at the emit step. `projectJournalHistory` strips it; this mirrors that.
 */
function visibleView(view: readonly DurableMessage[]): DurableMessage[] {
  return view.filter((m) => !(m.kind === "text" && m.deleted === true));
}

function comparableRow(m: ProjectedHistoryMessage | DurableMessage) {
  if (m.kind === "reasoning") {
    return { id: m.id, turnId: m.turnId, text: m.text };
  }
  if (m.kind === "tool") {
    return {
      id: m.id,
      turnId: m.turnId,
      name: m.name,
      phase: m.phase,
      status: m.status,
      summary: m.summary,
      argKeys: m.argKeys,
    };
  }
  // #242 half 4. `approvalKind`/`options` are compared too: the rename and the
  // button list are exactly what a layer could drop silently, and this helper
  // is what makes the both-sides equality unfiltered.
  if (m.kind === "approval") {
    return {
      id: m.id,
      approvalKind: m.approvalKind,
      title: m.title,
      description: m.description,
      prompt: m.prompt,
      options: m.options,
      expiresAtMs: m.expiresAtMs,
      resolvedDecision: m.resolvedDecision,
    };
  }
  return { id: m.id, role: m.role, text: m.text };
}

/**
 * #242 half 2 — the journal holds reasoning AND the `history` frame carries it.
 *
 * Half 1's version of this block asserted the OPPOSITE of the second half: the
 * projection folded `reasoning` rows into the durable view and then DROPPED them
 * on the way to the wire, because the row type's `role` was `"user" | "agent"`
 * and a reasoning message has none. Half 2 made the wire row a tagged union, so
 * the drop is gone and these cases pin what replaced it — the emitted list is
 * now the WHOLE view, reasoning in its journal position, with the reasoning
 * variant's own shape.
 */
describe("projectJournalHistory — reasoning reaches the wire (#242 half 2)", () => {
  const WITH_REASONING: JournalEvent[] = [
    { kind: "user", id: "u-0", text: "why?", turnId: TURN },
    { kind: "reasoning", id: "r-1", turnId: TURN, text: "let me think" },
    { kind: "bubble", answerId: "A", turnId: TURN, text: "because" },
    { kind: "reasoning", id: "r-2", turnId: TURN, text: "and also" },
    { kind: "bubble", answerId: "B", turnId: TURN, text: "and therefore" },
  ];

  it("the REDUCER's view holds every reasoning block, in JOURNAL order", () => {
    // Stated first and separately from the emitted list, so a regression can be
    // attributed: this one is about the STORE and the fold. If it goes red the
    // journal really is losing content, whatever the wire does.
    //
    // ⚠️ "JOURNAL order", not "delivery order" — the fold reproduces the order
    // rows were APPENDED, which `applyReasoning`'s docblock is explicit is not
    // always the order bursts were delivered (a burst closed by `stop()` is
    // appended after its turn's `seal`). This fixture appends in delivery
    // order, so the two agree here; the title should not claim more than the
    // reducer does.
    expect(reduceDurableView(WITH_REASONING).map((m) => m.id)).toEqual([
      "u-0",
      "r-1",
      "A",
      "r-2",
      "B",
    ]);
  });

  it("the emitted list holds EVERY block, in the view's order and with NO role", () => {
    const { read } = fakeReader(rowsFor(WITH_REASONING));
    const projection = projectJournalHistory(read, CONV);
    expect(projection.messages).toEqual([
      { id: "u-0", role: "user", text: "why?", ts: T0 + 0 * T_STEP },
      // ⚠️ NO `role` KEY AT ALL, and `toEqual` is what enforces that: an extra
      // own property on the actual value fails it. This is the exact property
      // every RELEASED client's `case "history"` relies on to DROP the row
      // rather than draw it as an answer bubble, so it is asserted here and not
      // merely described in `channel-contract.ts`.
      { kind: "reasoning", id: "r-1", turnId: TURN, text: "let me think", ts: T0 + 1 * T_STEP },
      { id: "A", role: "agent", text: "because", ts: T0 + 2 * T_STEP },
      { kind: "reasoning", id: "r-2", turnId: TURN, text: "and also", ts: T0 + 3 * T_STEP },
      { id: "B", role: "agent", text: "and therefore", ts: T0 + 4 * T_STEP },
    ]);
    // Symmetrically: a TEXT row still carries no `kind` key, so the widening is
    // byte-additive for every row that existed before this slice.
    for (const m of projection.messages.filter((row) => row.id === "A")) {
      expect(Object.hasOwn(m, "kind")).toBe(false);
    }
    // A reasoning row is KNOWN, not unsupported — it was folded.
    expect(projection.unsupportedEvents).toBe(0);
    // `recordFirstSeen` dated the reasoning ids in half 1 and half 2 reads them
    // unchanged, so emitting them adds no fallbacks.
    expect(projection.tsFallbacks).toBe(0);
  });

  it("a reasoning id IS a resolvable page cursor now that it reaches the wire", () => {
    // Half 1 asserted the opposite ("no reasoning id can become a cursor"),
    // which was true only because the ids never left the projection. The
    // replacement property is the one `historyPageBefore` actually rests on:
    // resolution is `findIndex` by id over the SAME list the client was served,
    // and that list is now the whole view.
    const { read } = fakeReader(rowsFor(WITH_REASONING));
    const messages = projectJournalHistory(read, CONV).messages;
    expect(messages.map((m) => m.id)).toEqual(["u-0", "r-1", "A", "r-2", "B"]);
    // Everything strictly older than B — reasoning blocks included, because
    // they are messages now.
    expect(historyPageBefore(messages, "B", 10).map((m) => m.id)).toEqual([
      "u-0",
      "r-1",
      "A",
      "r-2",
    ]);
    // A reasoning cursor resolves like any other.
    expect(historyPageBefore(messages, "r-2", 10).map((m) => m.id)).toEqual([
      "u-0",
      "r-1",
      "A",
    ]);
    // And an id the projection does not hold is still the empty page, not
    // newest-N — the unchanged contract, and the only outcome a live-only
    // reasoning id (an account with `reasoningDurable` off) can produce.
    expect(historyPageBefore(messages, "never-journaled", 10)).toEqual([]);
  });

  it("`limit` counts reasoning rows, so a page holds fewer bubbles", () => {
    // Stated as a test because it is a real behaviour change for an operator
    // who tuned `history.pageSize` against a bubble-only projection.
    const { read } = fakeReader(rowsFor(WITH_REASONING));
    const messages = projectJournalHistory(read, CONV).messages;
    expect(recentHistoryPage(messages, 3).map((m) => m.id)).toEqual(["A", "r-2", "B"]);
  });

  it("a reasoning-only conversation is a NON-empty wire frame now", () => {
    const { read } = fakeReader(
      rowsFor([{ kind: "reasoning", id: "r-1", turnId: TURN, text: "alone" } satisfies JournalEvent]),
    );
    // Half 1 asserted `messages: []` here. That mattered: `sendSnapshot` gates
    // the frame on `length > 0`, so under half 1 such a conversation looked
    // brand new to its owner. It no longer does.
    expect(projectJournalHistory(read, CONV)).toEqual({
      messages: [
        { kind: "reasoning", id: "r-1", turnId: TURN, text: "alone", ts: T0 },
      ],
      unsupportedEvents: 0,
      tsFallbacks: 0,
    });
  });
});

describe("projectJournalHistory — chunking", () => {
  it("really chunks: several bounded reads, afterSeq advancing by the last seq", () => {
    const { read, calls } = fakeReader(rowsFor(MIXED_STREAM));
    projectJournalHistory(read, CONV, { chunkRows: 4 });
    // 9 rows at 4 per read: [1-4], [5-8], [9] — the last is short, so it stops.
    expect(calls).toEqual([
      { afterSeq: 0, limit: 4 },
      { afterSeq: 4, limit: 4 },
      { afterSeq: 8, limit: 4 },
    ]);
  });

  it("issues one extra empty read when the log is an exact multiple of the chunk", () => {
    // Not a defect — the store cannot say "that was the last one", so the price
    // of not guessing is one empty read. Pinned so it is a decision, not a
    // surprise, if someone later counts queries.
    const { read, calls } = fakeReader(rowsFor(MIXED_STREAM.slice(0, 8)));
    projectJournalHistory(read, CONV, { chunkRows: 4 });
    expect(calls).toEqual([
      { afterSeq: 0, limit: 4 },
      { afterSeq: 4, limit: 4 },
      { afterSeq: 8, limit: 4 },
    ]);
  });

  it("REFUSES a chunkRows that is not an integer >= 1, with a named throw", () => {
    // Against the real store `read` already refuses these (`requireCount`,
    // delivery-journal.ts:721/727). Against an INJECTED reader `chunkRows: 0`
    // would return an empty projection indistinguishable from an empty
    // conversation — the shape `read`'s own implementation comment
    // (delivery-journal.ts:717-720) calls "the worse of the two by far", though
    // it reaches it from a different trigger (a `NaN` `afterSeq` binding as
    // NULL, not a zero page size).
    const { read, calls } = fakeReader(rowsFor(MIXED_STREAM));
    for (const chunkRows of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        projectJournalHistory(read, CONV, { chunkRows }),
      ).toThrow(/chunkRows must be an integer >= 1/);
    }
    // It throws BEFORE reading, so a bad page size cannot half-project.
    expect(calls).toEqual([]);
    // 1 is legal — the smallest page, not an error. Five served rows: the six
    // durable ids minus the #241-tombstoned X (`seal.remove`, stripped at emit).
    expect(
      projectJournalHistory(read, CONV, { chunkRows: 1 }).messages,
    ).toHaveLength(5);
  });

  it("gives the SAME projection at every chunk size as one big read", () => {
    // BOTH streams, and the second one is load-bearing rather than extra
    // coverage: `MIXED_STREAM` alone cannot detect a chunk loop that RE-FOLDS
    // rows it already consumed, because its only non-idempotent event
    // (`applyUser`) sits at seq 1 where no overlap reaches it. See
    // `RE_FOLD_SENSITIVE_STREAM`'s comment for the measurement.
    // Message counts are the durable id count MINUS the #241-tombstoned X, which
    // `seal.remove` retains in the fold but the projection strips at emit.
    const streams: Array<[string, JournalEvent[], number]> = [
      ["MIXED_STREAM", MIXED_STREAM, 5],
      ["RE_FOLD_SENSITIVE_STREAM", RE_FOLD_SENSITIVE_STREAM, 6],
    ];
    for (const [label, events, expectedMessages] of streams) {
      const rows = rowsFor(events);
      const whole = projectJournalHistory(fakeReader(rows).read, CONV, {
        chunkRows: rows.length + 100,
      });
      // Parameterised so this is a real assertion about chunk-boundary
      // independence rather than a restatement of the default: 1 puts a boundary
      // between EVERY pair of events, including the seal and the resurrect after
      // it, and the rest straddle the boundary at different places.
      for (const chunkRows of [1, 2, 3, 4, 5, 7, 8, 9, 10, 512]) {
        expect(
          projectJournalHistory(fakeReader(rows).read, CONV, { chunkRows }),
          `${label} @ chunkRows=${chunkRows}`,
        ).toEqual(whole);
      }
      // Guard against a vacuous pass: the "big read" really was one call, and
      // the stream really produced the message count this test thinks it did.
      const single = fakeReader(rows);
      projectJournalHistory(single.read, CONV, { chunkRows: rows.length + 100 });
      expect(single.calls, label).toHaveLength(1);
      expect(whole.messages, label).toHaveLength(expectedMessages);
    }
    // The second stream really does carry TWO user bubbles — the property the
    // re-fold mutation corrupts. Without this, a fixture edit could silently
    // remove the sensitivity again.
    const reFold = projectJournalHistory(
      fakeReader(rowsFor(RE_FOLD_SENSITIVE_STREAM)).read,
      CONV,
    );
    expect(
      reFold.messages.filter((m) => m.kind === undefined && m.role === "user").map((m) => m.id),
    ).toEqual(["u-0", "u-1"]);
  });

  it("TERMINATES against a reader that never advances, instead of spinning", () => {
    // Defensive: the real `selectRows` filters `seq > afterSeq`, so a full chunk
    // whose last seq did not advance cannot happen. A hung history read is not
    // an acceptable way to be wrong about that, so the loop stops and returns a
    // truncated view.
    //
    // ⚠️ THE CALL BOUND IS THE ASSERTION MECHANISM, NOT BOOKKEEPING. Deleting the
    // advancement guard makes this a SYNCHRONOUS `for(;;)`, which blocks the
    // event loop — so vitest's `testTimeout` can never fire and the mutation
    // WEDGES a CI worker indefinitely instead of failing. An earlier version of
    // this comment called that hang "the honest signal"; it is not, it is a
    // hang. The reader throws past a small bound (the guard needs 2 calls) so the
    // same mutation now produces a NAMED failure naming the non-terminating loop.
    // Verified both ways: with the guard, 2 calls; with it deleted, this throws.
    const rows = rowsFor(MIXED_STREAM);
    const MAX_CALLS = 10;
    let callCount = 0;
    const read: JournalReader = () => {
      callCount += 1;
      if (callCount > MAX_CALLS) {
        throw new Error(
          `projectJournalHistory did not terminate: the non-advancing reader ` +
            `was called ${callCount} times (bound ${MAX_CALLS}). The chunk-loop ` +
            `advancement guard is missing or no longer refuses a chunk whose ` +
            `last seq did not pass afterSeq.`,
        );
      }
      // Always the same two rows, always seq 1 and 2 — a reader that ignores
      // `afterSeq` entirely.
      return rows.slice(0, 2);
    };
    const projection = projectJournalHistory(read, CONV, { chunkRows: 2 });
    // Two reads: the first folds rows 1-2, the second sees lastSeq 2 == afterSeq
    // 2 and stops.
    expect(callCount).toBe(2);
    // ⚠️ AND THE REFUSED CHUNK WAS NOT FOLDED. The check runs BEFORE the fold on
    // purpose: `applyUser` blind-appends, so folding the repeat would leave
    // ["u-0", "A", "u-0"] — the hang guard corrupting the view it saved. This
    // assertion is the one that pins the ORDER of the two, and it went red for
    // exactly that reason while the check was still after the fold.
    expect(projection.messages.map((m) => m.id)).toEqual(["u-0", "A"]);
  });
});

describe("projectJournalHistory — an unknown kind is counted, not folded", () => {
  const unknownRow = (seq: number, createdMs: number): DeliveryJournalRow => ({
    seq,
    kind: "sticker",
    event: {
      kind: "sticker",
      id: "s-1",
      pack: "cats",
    } as DeliveryJournalRow["event"],
    createdMs,
  });

  it("excludes it from the fold and counts it, leaving the rest untouched", () => {
    const baseline = projectJournalHistory(
      fakeReader(rowsFor(MIXED_STREAM)).read,
      CONV,
    );
    // Splice the unknown row into the MIDDLE — between the seal and the
    // resurrect, the most order-sensitive seam in the stream. `rowsFor`
    // renumbers `seq` and `createdMs` across the whole list, so the spliced row
    // lands at seq 9 with the surrounding rows shifted; nothing further is
    // needed — in particular do not reassign `withUnknown[8]` to "fix" the seq,
    // which only rebuilds the identical row while reading as if renumbering
    // were required.
    const withUnknown = rowsFor([
      ...MIXED_STREAM.slice(0, 8),
      { kind: "sticker", id: "s-1", pack: "cats" },
      ...MIXED_STREAM.slice(8),
    ]);
    expect(withUnknown[8]).toEqual(unknownRow(9, T0 + 8 * T_STEP));
    const projection = projectJournalHistory(fakeReader(withUnknown).read, CONV);
    expect(projection.unsupportedEvents).toBe(1);
    expect(projection.tsFallbacks).toBe(0);
    // BYTE-IDENTICAL to the baseline, `ts` included — the unsupported row is
    // invisible to the view. The `ts` half is not free: the row it displaces is
    // the resurrecting bubble at index 8, and it does NOT move X's timestamp,
    // because first-appearance dates X from its FIRST bubble at index 6 (which
    // is before the splice). Had this module dated messages from the last write,
    // this line would be the one that caught it.
    expect(projection.messages).toEqual(baseline.messages);
  });

  it("counts every unsupported row, including several in one chunk", () => {
    const rows = [
      unknownRow(1, T0),
      ...rowsFor([{ kind: "user", id: "u-0", text: "hi" }]).map((row) => ({
        ...row,
        seq: 2,
        createdMs: T0 + T_STEP,
      })),
      unknownRow(3, T0 + 2 * T_STEP),
    ];
    const projection = projectJournalHistory(fakeReader(rows).read, CONV);
    expect(projection.unsupportedEvents).toBe(2);
    expect(projection.messages).toEqual([
      { id: "u-0", role: "user", text: "hi", ts: T0 + T_STEP },
    ]);
  });

  it("advances the ts-fallback anchor across an UNSUPPORTED row too", () => {
    // The fold sets `lastCreatedMs` for EVERY row it reads, unsupported ones
    // included, and that decision had zero coverage — moving the assignment
    // below the `isKnownJournalEvent` guard left EVERY OTHER test in this file
    // green. This is the test that pins it. (Never restate that as a total —
    // a count goes stale the next time anyone adds a case, and then reads as a
    // measurement of a suite that no longer exists.)
    //
    // The bubble's id is a NUMBER, so `recordFirstSeen` refuses to key the map on
    // it and the message falls to the fallback; the unsupported row that FOLLOWS
    // is then the last row processed. If the anchor stopped advancing on
    // unsupported rows, the fallback would report the bubble's own row (T0)
    // instead.
    const rows: DeliveryJournalRow[] = [
      ...rowsFor([{ kind: "bubble", answerId: 7, text: "numeric id" }]),
      unknownRow(2, T0 + T_STEP),
    ];
    const projection = projectJournalHistory(fakeReader(rows).read, CONV);
    expect(projection.unsupportedEvents).toBe(1);
    expect(projection.tsFallbacks).toBe(1);
    expect(projection.messages[0].ts).toBe(T0 + T_STEP);
  });

  it("does not treat an inherited Object property name as a known kind", () => {
    // The kind comes off a JSON.parse'd payload, and `"constructor" in
    // KNOWN_EVENT_KINDS` is TRUE through the prototype chain. An inherited hit
    // would send an out-of-union event into `applyDurableEvent`, whose switch has
    // no `default`: it returns `undefined` and the NEXT event throws while naming
    // the wrong event. `Object.hasOwn` is what prevents that.
    const rows: DeliveryJournalRow[] = [
      {
        seq: 1,
        kind: "constructor",
        event: { kind: "constructor" } as DeliveryJournalRow["event"],
        createdMs: T0,
      },
      {
        seq: 2,
        kind: "toString",
        event: { kind: "toString" } as DeliveryJournalRow["event"],
        createdMs: T0 + T_STEP,
      },
      ...rowsFor([{ kind: "user", id: "u-0", text: "hi" }]).map((row) => ({
        ...row,
        seq: 3,
        createdMs: T0 + 2 * T_STEP,
      })),
    ];
    const projection = projectJournalHistory(fakeReader(rows).read, CONV);
    expect(projection.unsupportedEvents).toBe(2);
    expect(projection.messages).toEqual([
      { id: "u-0", role: "user", text: "hi", ts: T0 + 2 * T_STEP },
    ]);
  });

  it("does not treat a NON-STRING kind that stringifies to a known one as known", () => {
    // The other half of the same hole, and `Object.hasOwn` alone cannot close
    // it: it runs `ToPropertyKey` on its second argument, so `["user"]` becomes
    // the key `"user"` and answers TRUE. `RetainedJournalEvent`'s `kind: string`
    // does not stop it either — that annotation is an unvalidated `JSON.parse`
    // cast, not a check.
    //
    // ⚠️ AND THE READER IS THE DOOR, NOT `append`. Measured: `append` binds
    // `event.kind` and the payload in one `insertEvent.run`, and `node:sqlite`
    // REFUSES an array/object bind before writing a row, so our own writer
    // cannot store this shape. It arrives through an injected `JournalReader` —
    // this module's public seam, which is what this test is — or a foreign
    // writer. That is the guard's real justification; see `isKnownJournalEvent`.
    //
    // If it passed, `applyDurableEvent`'s `switch` would compare with `===`,
    // match no case, fall off the end and return `undefined` — and the NEXT
    // event would throw while naming the wrong one. So the assertion that
    // matters is not just the count: it is that the user row AFTER it still
    // folds, which is what the `undefined` view would have destroyed.
    const rows: DeliveryJournalRow[] = [
      ...rowsFor([{ kind: "user", id: "u-0", text: "before" }]),
      {
        seq: 2,
        kind: "user",
        event: { kind: ["user"] } as unknown as DeliveryJournalRow["event"],
        createdMs: T0 + T_STEP,
      },
      ...rowsFor([{ kind: "user", id: "u-1", text: "after" }]).map((row) => ({
        ...row,
        seq: 3,
        createdMs: T0 + 2 * T_STEP,
      })),
    ];
    const projection = projectJournalHistory(fakeReader(rows).read, CONV);
    expect(projection.unsupportedEvents).toBe(1);
    expect(projection.tsFallbacks).toBe(0);
    expect(projection.messages).toEqual([
      { id: "u-0", role: "user", text: "before", ts: T0 },
      { id: "u-1", role: "user", text: "after", ts: T0 + 2 * T_STEP },
    ]);
  });
});

describe("projectJournalHistory — where ts comes from", () => {
  it("takes the FIRST row that names an id, and an edit never moves it", () => {
    const { read } = fakeReader(
      rowsFor([
        { kind: "placement", answerId: "A", turnId: TURN },
        { kind: "bubble", answerId: "A", text: "draft", turnId: TURN },
        { kind: "bubble", answerId: "A", text: "edited", turnId: TURN },
      ] satisfies JournalEvent[]),
    );
    expect(projectJournalHistory(read, CONV).messages).toEqual([
      { id: "A", role: "agent", text: "edited", ts: T0 },
    ]);
  });

  it("dates a seal-MINTED answer from the seal row — there is no earlier row", () => {
    // The #215 recovery: an answer that never egressed a bubble appears for the
    // first time inside `seal.answers`, so that IS its first appearance.
    const { read } = fakeReader(rowsFor(MIXED_STREAM));
    const minted = projectJournalHistory(read, CONV).messages.find(
      (m) => m.id === "C",
    );
    // The seal is index 7 in the stream.
    expect(minted?.ts).toBe(T0 + 7 * T_STEP);
  });

  it("a post-remove same-id bubble is REFUSED — X is tombstoned and absent from the served history (#241 half 2)", () => {
    // X is bubbled at index 6, removed by the seal at 7, and re-bubbled at 8.
    // Before #241 the re-bubble resurrected X (keeping its original ts=6); now the
    // `remove` tombstones it, the re-bubble's no-resurrect guard refuses it, and
    // the tombstone is stripped from the projection — so X is not served at all.
    const { read } = fakeReader(rowsFor(MIXED_STREAM));
    const served = projectJournalHistory(read, CONV).messages;
    expect(findTextRow(served, "X")).toBeUndefined();
    expect(served.some((m) => m.id === "X")).toBe(false);
  });

  it("records first appearance for EVERY id a seal names, not just minted ones", () => {
    // A seal that arrives before any placement/bubble for its answers is the
    // only row naming them, so all three must be dated from it.
    const { read } = fakeReader(
      rowsFor([
        {
          kind: "seal",
          turnId: TURN,
          answers: [
            { id: "P", text: "p" },
            { id: "Q", text: "q" },
          ],
        },
      ] satisfies JournalEvent[]),
    );
    const projection = projectJournalHistory(read, CONV);
    expect(projection.tsFallbacks).toBe(0);
    expect(projection.messages).toEqual([
      { id: "P", role: "agent", text: "p", ts: T0 },
      { id: "Q", role: "agent", text: "q", ts: T0 },
    ]);
  });

  it("never reports a ts fallback on today's four kinds", () => {
    // The fallback exists for a FIFTH kind that introduces an id without being
    // taught to record one — it must not ship `ts: undefined`/`NaN` on the wire.
    // On the current event set the path is unreachable, and this is what says so.
    //
    // Several DISTINCT streams, not just the mixed one: asserting it again on
    // MIXED_STREAM alone would only restate the assertion the mixed-stream test
    // already makes. Each of these introduces ids through a different event —
    // user, placement-only (never authored), bubble-first, and seal-only (the
    // #215 mint) — which is every id-introducing path the four kinds have.
    const streams: Array<[string, JournalEvent[]]> = [
      ["mixed", MIXED_STREAM],
      ["user only", [{ kind: "user", id: "u-0", text: "hi" }]],
      [
        "placement never authored",
        [{ kind: "placement", answerId: "A", turnId: TURN }],
      ],
      ["bubble first", [{ kind: "bubble", answerId: "A", text: "a", turnId: TURN }]],
      [
        "seal only (minted)",
        [{ kind: "seal", turnId: TURN, answers: [{ id: "C", text: "c" }] }],
      ],
    ];
    for (const [label, events] of streams) {
      const projection = projectJournalHistory(
        fakeReader(rowsFor(events)).read,
        CONV,
      );
      expect(projection.tsFallbacks, label).toBe(0);
      // Non-vacuous: each stream really produced a dated message.
      expect(projection.messages.length, label).toBeGreaterThan(0);
      for (const message of projection.messages) {
        expect(Number.isFinite(message.ts), `${label} / ${message.id}`).toBe(true);
      }
    }
  });

  it("FALLS BACK to the last processed row's ts, and counts it", () => {
    // The fallback is unreachable through the four kinds — every one of them
    // records — so the only way to exercise it is a row whose id is not a
    // string. `applyBubble` keys on `===` and happily creates a message under a
    // NUMBER id; `recordFirstSeen` refuses to key the map on one. Contrived, but
    // it is the exact shape a FIFTH kind that introduces an id without being
    // taught to record would have, and it proves the branch ships a real number
    // rather than `undefined`/`NaN` on the wire.
    const { read } = fakeReader(
      rowsFor([
        { kind: "user", id: "u-0", text: "hi" },
        { kind: "bubble", answerId: 7, text: "numeric id" },
      ]),
    );
    const projection = projectJournalHistory(read, CONV);
    expect(projection.tsFallbacks).toBe(1);
    expect(projection.unsupportedEvents).toBe(0);
    // The undated message takes the LAST processed row's createdMs — here its
    // own row, which is also the last one.
    expect(projection.messages[1].ts).toBe(T0 + T_STEP);
    expect(Number.isFinite(projection.messages[1].ts)).toBe(true);
    // …and the dated one is untouched.
    expect(projection.messages[0].ts).toBe(T0);
  });

  it("CHARACTERIZATION: an id is dated by a seal the REDUCER rejected", () => {
    // A known, accepted divergence, recorded rather than fixed —
    // `recordFirstSeen`'s docblock has the full argument. `applySeal` refuses the
    // whole event at its blank-turnId guard, so this
    // seal contributes NOTHING to the view; `recordFirstSeen` records `C`
    // anyway. The later genuine bubble for C therefore materializes with a `ts`
    // sourced from an event that never entered the view.
    //
    // Not fixed here because mirroring `applySeal`'s admission guards into this
    // module would put the reducer's rules in two packages with nothing to make
    // the copies go red together (N8). Bounded because `ts` is hydration
    // metadata and NOT an ordering key. This test exists so the divergence is a
    // recorded fact rather than a surprise — if `ts` ever becomes load-bearing,
    // start here.
    const { read } = fakeReader(
      rowsFor([
        { kind: "seal", turnId: "", answers: [{ id: "C", text: "ignored" }] },
        { kind: "bubble", answerId: "C", text: "the real one", turnId: TURN },
      ] satisfies JournalEvent[]),
    );
    const projection = projectJournalHistory(read, CONV);
    // The rejected seal left no trace in the VIEW…
    expect(projection.messages).toEqual([
      { id: "C", role: "agent", text: "the real one", ts: T0 },
    ]);
    // …but T0 is the SEAL's row, not the bubble's at T0 + T_STEP. That is the
    // divergence, stated as a number.
    expect(projection.messages[0].ts).not.toBe(T0 + T_STEP);
  });

  it("survives a seal whose answers array is malformed, exactly as the reducer does", () => {
    // `applySeal` guards with `Array.isArray` and returns the view unchanged; a
    // projection that threw where the reducer shrugs would be stricter than the
    // rules it is replaying.
    const { read } = fakeReader(
      rowsFor([
        { kind: "user", id: "u-0", text: "hi" },
        { kind: "seal", turnId: TURN, answers: null },
      ]),
    );
    expect(projectJournalHistory(read, CONV).messages).toEqual([
      { id: "u-0", role: "user", text: "hi", ts: T0 },
    ]);
  });

  it("survives a seal whose answers array holds NON-OBJECT ELEMENTS", () => {
    // The array-level guard above is not the whole story: `recordFirstSeen`
    // walks the elements, and `answers: [null]` reaches `note(answer.id)` —
    // which throws `Cannot read properties of null` on the way to a history
    // read, i.e. this module crashing where `applySeal` merely filters (its
    // element predicate in `applySeal`'s `rawAnswers` filter starts `!!a &&`). The
    // per-element `answer && typeof answer === "object"` check is what keeps the
    // projection no stricter than the rules it replays, and this is the case
    // that pins it. A string element is covered too: `typeof "C" === "object"`
    // is false, so it is skipped rather than dated under `undefined`.
    const { read } = fakeReader(
      rowsFor([
        { kind: "user", id: "u-0", text: "hi" },
        {
          kind: "seal",
          turnId: TURN,
          answers: [null, "C", 7, undefined, { id: "D", text: "d" }],
        },
      ]),
    );
    const projection = projectJournalHistory(read, CONV);
    expect(projection.unsupportedEvents).toBe(0);
    expect(projection.tsFallbacks).toBe(0);
    // Only the well-formed answer survives the REDUCER's own filter, and it is
    // dated from the seal row — the elements the reducer dropped left no trace.
    expect(projection.messages).toEqual([
      { id: "u-0", role: "user", text: "hi", ts: T0 },
      { id: "D", role: "agent", text: "d", ts: T0 + T_STEP },
    ]);
  });
});

describe("recentHistoryPage", () => {
  const page: ProjectedHistoryMessage[] = [
    { id: "m1", role: "user", text: "1", ts: 1 },
    { id: "m2", role: "agent", text: "2", ts: 2 },
    { id: "m3", role: "user", text: "3", ts: 3 },
  ];

  it("returns the LAST limit messages", () => {
    expect(recentHistoryPage(page, 2).map((m) => m.id)).toEqual(["m2", "m3"]);
  });

  it("returns everything when limit exceeds the available messages", () => {
    expect(recentHistoryPage(page, 99)).toEqual(page);
  });

  it("clamps a limit JUST past the end — the only window where Math.max matters", () => {
    // ⚠️ THE CASE ABOVE DOES NOT COVER THE CLAMP, WHICH IS WHY THIS ONE EXISTS.
    // `slice` re-clamps a sufficiently negative start to 0 all by itself, so at
    // limit 99 (start -96) dropping the `Math.max(0, …)` changes NOTHING. The
    // divergence window is exactly `length < limit < 2 * length`, where the
    // negative start lands INSIDE the array and `slice` reads it as an
    // offset-from-the-end instead: at 3 messages and limit 4, the unclamped
    // `slice(-1)` silently returns the tail instead of the whole page.
    //
    // That window is production-dominant, not exotic: the default `limit` and
    // `pageSize` are both 50 (`DEFAULT_HISTORY_CONFIG`, history.ts:56-59), so
    // every conversation between 26 and 49 messages long sits in it.
    expect(recentHistoryPage(page, 4)).toEqual(page);
    expect(recentHistoryPage(page, 5)).toEqual(page);
    // And the boundary itself: limit === length is the last non-clamping value.
    expect(recentHistoryPage(page, 3)).toEqual(page);
  });

  it("returns [] for a non-positive limit — history.ts:pageBefore's guard", () => {
    expect(recentHistoryPage(page, 0)).toEqual([]);
    expect(recentHistoryPage(page, -1)).toEqual([]);
  });

  it("CHARACTERIZATION: a NaN limit falls through and returns everything", () => {
    // `NaN <= 0` is false, so it reaches `slice`. This is inherited from
    // the DELETED `history.ts:pageBefore` on purpose rather than fixed with
    // a third convention: `planHistoryFetch` (history.ts:104) is what sanitizes
    // limit in BOTH the old path and the new one. Recorded, not endorsed.
    expect(recentHistoryPage(page, Number.NaN)).toEqual(page);
  });

  it("does not alias the input array", () => {
    expect(recentHistoryPage(page, 99)).not.toBe(page);
  });
});

describe("historyPageBefore", () => {
  const page: ProjectedHistoryMessage[] = [
    { id: "m1", role: "user", text: "1", ts: 1 },
    { id: "m2", role: "agent", text: "2", ts: 2 },
    { id: "m3", role: "user", text: "3", ts: 3 },
    { id: "m4", role: "agent", text: "4", ts: 4 },
  ];

  it("returns the limit messages immediately older than the cursor", () => {
    expect(historyPageBefore(page, "m4", 2).map((m) => m.id)).toEqual([
      "m2",
      "m3",
    ]);
  });

  it("NEVER includes the cursor itself", () => {
    expect(historyPageBefore(page, "m4", 99).map((m) => m.id)).toEqual([
      "m1",
      "m2",
      "m3",
    ]);
  });

  it("returns [] when the cursor is the FIRST message — nothing older exists", () => {
    expect(historyPageBefore(page, "m1", 10)).toEqual([]);
  });

  it("returns the whole prefix when limit exceeds it", () => {
    expect(historyPageBefore(page, "m3", 100).map((m) => m.id)).toEqual([
      "m1",
      "m2",
    ]);
  });

  it("clamps a limit JUST past the cursor — unclamped is a SILENT STOP", () => {
    // ⚠️ THE CASE ABOVE DOES NOT COVER THE CLAMP. At limit 100 the unclamped
    // start is -98, which `slice` re-clamps to 0 on its own, so dropping the
    // `Math.max(0, …)` changes nothing there. The divergence window is
    // `0 < idx < limit < length + idx`: `slice` maps the negative start
    // `idx-limit` to `max(length + idx - limit, 0)`, so it stays INSIDE the
    // array — and is read as an offset from the END — for exactly that range,
    // where it can exceed `idx` and invert the range. At the cursor "m2"
    // (idx 1, length 4) with limit 3, `slice(-2, 1)` starts at index 2 and ends
    // at 1 — EMPTY.
    //
    // The leading `0 <` is not decoration: at `idx === 0` BOTH forms are `[]`
    // for every limit (clamped is `slice(0,0)`; unclamped has start >= end), so
    // the cursor-at-the-very-start case never diverges. Verified by exhaustive
    // scan over length 1..8 x idx x limit 1..20 — this predicate matches the
    // divergence set exactly, and dropping the `0 <` mismatches 28 cases.
    //
    // ⚠️ AND EMPTY IS NOT A VISIBLE FAILURE HERE, WHICH IS WHY THIS MATTERS MORE
    // THAN THE TWIN ABOVE. `[]` is this function's honest "no more history"
    // signal, which the client wrapper treats as a no-op — so the unclamped
    // version does not look broken, it looks like the top of the conversation.
    // That is exactly the SILENT STOP this selector's docblock says the
    // cursor-miss contract exists to prevent, reintroduced one line below it.
    //
    // Production-dominant window, same as the twin: the default `pageSize` is 50
    // (`DEFAULT_HISTORY_CONFIG`, history.ts:56-59), so any cursor at projection
    // positions 1..49 sits in it — position 0 excluded, per the `0 <` above.
    expect(historyPageBefore(page, "m2", 3).map((m) => m.id)).toEqual(["m1"]);
    expect(historyPageBefore(page, "m3", 3).map((m) => m.id)).toEqual([
      "m1",
      "m2",
    ]);
    // The boundary: limit === idx is the last non-clamping value.
    expect(historyPageBefore(page, "m2", 1).map((m) => m.id)).toEqual(["m1"]);
  });

  it("returns [] for a cursor that is not in the projection", () => {
    // The honest "no more history" signal, and `history.ts:pageBefore`'s
    // contract, preserved verbatim from the deleted reader: newest-N would only feed the
    // client duplicates it dedupes — a SILENT stop.
    expect(historyPageBefore(page, "nope", 10)).toEqual([]);
  });

  it("returns [] for an empty cursor or a non-positive limit", () => {
    expect(historyPageBefore(page, "", 10)).toEqual([]);
    expect(historyPageBefore(page, "m4", 0)).toEqual([]);
    expect(historyPageBefore(page, "m4", -3)).toEqual([]);
  });

  it("CHARACTERIZATION: a NaN limit falls through and returns the whole prefix", () => {
    // The docblock claims "same guard on `limit` as `recentHistoryPage`", so the
    // same inherited hole must be pinned on BOTH or the claim is untested on one
    // of them. `NaN <= 0` is false, so it reaches `slice`, where
    // `Math.max(0, idx - NaN)` is NaN and `slice(NaN, idx)` starts at 0.
    // `planHistoryFetch` (history.ts:104) is what prevents this upstream, in the
    // new path exactly as in the old. Recorded, not endorsed.
    expect(historyPageBefore(page, "m3", Number.NaN).map((m) => m.id)).toEqual([
      "m1",
      "m2",
    ]);
  });

  it("does not alias the input array", () => {
    // `slice` always allocates, but the cursor-at-tail case is the one where an
    // "optimization" would be tempting: the returned prefix is every element but
    // the last, so "just hand the input back" is nearly right.
    //
    // ⚠️ THE INPUT MUST BE HOISTED AND COMPARED AGAINST ITSELF. An earlier
    // revision built the input inline and asserted `not.toBe(page)` — against a
    // fixture that was never passed in, so NO implementation could fail it. The
    // identity claim is only real when the reference under test is the reference
    // that went in; the twin at `recentHistoryPage` does it that way.
    const input: ProjectedHistoryMessage[] = [
      ...page,
      { id: "m5", role: "user", text: "5", ts: 5 },
    ];
    const all = historyPageBefore(input, "m5", 99);
    expect(all).toEqual(page);
    expect(all).not.toBe(input);
    // And the ELEMENTS are shared by reference — structural sharing is the
    // discipline here, so this must not become a deep copy either.
    expect(all[0]).toBe(input[0]);
  });

  it("pages backwards to exhaustion without ever repeating or skipping", () => {
    const seen: string[] = [];
    let cursor = "m4";
    for (;;) {
      const older = historyPageBefore(page, cursor, 1);
      if (older.length === 0) break;
      seen.unshift(older[0].id);
      cursor = older[0].id;
    }
    expect(seen).toEqual(["m1", "m2", "m3"]);
  });
});

describe("serveHistoryRequest — the composition seam both call sites use", () => {
  /**
   * The two live call sites (`history-serve.ts`'s `sendSnapshot` and
   * `servePage`) differ ONLY in the plan
   * they carry, so what is worth pinning here is the dispatch and the failure
   * policy — not the selectors, which have their own describes above.
   */
  // The served (visible) order: the durable ids minus the #241-tombstoned X
  // (`seal.remove`, stripped at emit — it used to resurrect at the tail).
  const IDS = ["u-0", "B", "A", "NOTICE", "C"];

  it("routes a `recent` plan to the tail of the full projection", () => {
    const { read } = fakeReader(rowsFor(MIXED_STREAM));
    expect(
      serveHistoryRequest(read, CONV, { kind: "recent", limit: 2 }).messages.map(
        (m) => m.id,
      ),
    ).toEqual(IDS.slice(-2));
  });

  it("routes a `page` plan to the messages older than the cursor", () => {
    const { read } = fakeReader(rowsFor(MIXED_STREAM));
    expect(
      serveHistoryRequest(read, CONV, {
        kind: "page",
        beforeId: "NOTICE",
        limit: 2,
      }).messages.map((m) => m.id),
    ).toEqual(["B", "A"]);
  });

  it("serves a page off the REDUCER's order, not the journal's write order", () => {
    // The distinction the seam exists to preserve: `B` was placed after `A` and
    // the seal permuted them, so "older than NOTICE" is [B, A] rather than
    // [A, B]. A page selector applied to raw rows would answer differently.
    const { read } = fakeReader(rowsFor(MIXED_STREAM));
    expect(
      serveHistoryRequest(read, CONV, { kind: "recent", limit: 100 }).messages.map(
        (m) => m.id,
      ),
    ).toEqual(IDS);
  });

  it("forwards the conversationId — a different id gets that id's rows", () => {
    const { read, calls } = fakeReader(rowsFor(MIXED_STREAM));
    expect(
      serveHistoryRequest(read, "someone-else", { kind: "recent", limit: 5 }),
    ).toEqual({ messages: [], unsupportedEvents: 0, tsFallbacks: 0 });
    expect(calls).toHaveLength(1);
  });

  it("PROPAGATES a store failure — it must never come back as an empty page", () => {
    // ⚠️ THE LOAD-BEARING TEST OF THIS SEAM. With the journal as the only store,
    // catching and returning `[]` would render a broken read as an empty
    // conversation to its owner (doc §15.6, and the READ FAILURE block in
    // `journal-history.ts`). The two call sites log at `error` and send no
    // frame; that policy is only reachable if the throw gets to them.
    const boom = new Error("SQLITE_CORRUPT: database disk image is malformed");
    const read: JournalReader = () => {
      throw boom;
    };
    expect(() => serveHistoryRequest(read, CONV, { kind: "recent", limit: 5 })).toThrow(
      boom,
    );
    expect(() =>
      serveHistoryRequest(read, CONV, { kind: "page", beforeId: "A", limit: 5 }),
    ).toThrow(boom);
  });
});

describe("against a REAL openDeliveryJournal", () => {
  const openJournals: DeliveryJournal[] = [];
  const tempRoots: string[] = [];

  afterEach(() => {
    while (openJournals.length > 0) openJournals.pop()?.close();
    while (tempRoots.length > 0) {
      rmSync(tempRoots.pop() as string, { recursive: true, force: true });
    }
  });

  /** A journal in its own tmpdir, with a pinned clock so `ts` is assertable. */
  function open(startMs = T0): DeliveryJournal {
    const root = mkdtempSync(join(tmpdir(), "webchannel-journal-history-"));
    tempRoots.push(root);
    let tick = 0;
    const journal = openDeliveryJournal({
      databasePath: join(root, "tuple", "delivery-journal.sqlite"),
      now: () => startMs + tick++ * T_STEP,
    });
    openJournals.push(journal);
    return journal;
  }

  it("projects the mixed stream out of a real store, matching the fake reader", () => {
    const journal = open();
    for (const event of MIXED_STREAM) journal.append(CONV, event);
    // A second conversation in the same file, so the projection is proven to be
    // conversation-scoped rather than accidentally correct on a single-tenant DB.
    journal.append("other-conv", { kind: "user", id: "u-9", text: "elsewhere" });

    const projection = projectJournalHistory(journal.read, CONV);
    expect(projection).toEqual(
      projectJournalHistory(fakeReader(rowsFor(MIXED_STREAM)).read, CONV),
    );
    expect(projectJournalHistory(journal.read, "other-conv").messages).toEqual([
      { id: "u-9", role: "user", text: "elsewhere", ts: T0 + 9 * T_STEP },
    ]);
  });

  it("chunks across a real store, and retains a forward kind as unsupported", () => {
    const journal = open();
    // Enough rows to force several chunks, plus one kind this build cannot fold.
    // #253: the store RETAINS it in `payload` rather than dropping the row, so
    // the projection is the layer that has to decide — and it counts.
    for (let i = 0; i < 30; i++) {
      journal.append(CONV, { kind: "user", id: `u-${i}`, text: `m${i}` });
    }
    journal.append(CONV, {
      kind: "sticker",
      id: "s-1",
      pack: "cats",
    } as unknown as JournalEvent);
    for (let i = 30; i < 60; i++) {
      journal.append(CONV, { kind: "user", id: `u-${i}`, text: `m${i}` });
    }

    const chunked = projectJournalHistory(journal.read, CONV, { chunkRows: 7 });
    const whole = projectJournalHistory(journal.read, CONV, { chunkRows: 1000 });
    expect(chunked).toEqual(whole);
    expect(chunked.unsupportedEvents).toBe(1);
    expect(chunked.tsFallbacks).toBe(0);
    expect(chunked.messages).toHaveLength(60);
    expect(chunked.messages[0]).toEqual({
      id: "u-0",
      role: "user",
      text: "m0",
      ts: T0,
    });
    // The 31st journal row is the sticker, so u-30 is the 32nd row written.
    expect(chunked.messages[30].id).toBe("u-30");
    expect(chunked.messages[30].ts).toBe(T0 + 31 * T_STEP);
    // And the selectors compose with a real projection.
    expect(recentHistoryPage(chunked.messages, 3).map((m) => m.id)).toEqual([
      "u-57",
      "u-58",
      "u-59",
    ]);
    expect(
      historyPageBefore(chunked.messages, "u-57", 2).map((m) => m.id),
    ).toEqual(["u-55", "u-56"]);
  });
});

// ---------------------------------------------------------------------------
// ⭐ THE PLUGIN HALF OF THE v6 BET FOR REASONING (#242 half 2)
// ---------------------------------------------------------------------------
//
// The client half — "the live view and a replayed `history` frame agree, in
// content and in position" — is in
// `packages/client/src/durable-view-reducer.test.ts`'s
// "live == history for reasoning" block, which drives the REAL wrapper with the
// REAL wire frames and then hands a FRESH wrapper a `history` frame.
//
// ⚠️ THE TWO HALVES SHARE ONE FIXTURE, AND ROUND 1'S CLAIM THAT THEY DID WAS
// FALSE. This block used to say "asserts the served rows are byte-for-byte the
// ones the client test consumes … if either side is edited alone, one of the two
// goes red" — while both files carried INDEPENDENT hand-written literals with no
// shared constant, no import edge, and different `ts` values. Reordering the
// client's copy, or adding a `role` to one of its reasoning rows, left this file
// green. Both now import `reasoning-turn.test-harness.ts` from the CLIENT
// package, which this file's module already depends on (`journal-history.ts` →
// `durable-view-reducer.ts`), so the edge and its direction are unchanged.
//
// WHAT EACH HALF PROVES, stated separately because they are different claims:
//   - THIS half: the real `journalEventForOutbound` + the real projection EMIT
//     exactly `ORDINARY_TURN_ROWS`, with the `ts` sourcing this module owns;
//   - the CLIENT half: replaying those rows renders what the live stream did.
// Neither proves the other, and neither can be edited alone any more.
import {
  INTERLEAVED_TURN_FRAMES,
  INTERLEAVED_TURN_REPLAY_IDS,
  ORDINARY_TURN_FRAMES,
  ORDINARY_TURN_ROWS,
  TOOL_TURN_FRAMES,
  TOOL_TURN_ROWS,
  APPROVAL_TURN_FRAMES,
  APPROVAL_TURN_ROWS,
  type ApprovalTurnFrame,
  type ReasoningTurnFrame,
  type ToolTurnFrame,
} from "../../client/src/reasoning-turn.test-harness.js";

describe("live == history for reasoning: what the plugin actually serves (#242 half 2)", () => {
  const asOutbound = (frame: ReasoningTurnFrame): OutboundWsMessage =>
    frame as unknown as OutboundWsMessage;

  function journalRowsFor(
    frames: readonly ReasoningTurnFrame[],
    reasoningDurable = true,
  ): DeliveryJournalRow[] {
    const events: JournalEvent[] = [];
    for (const frame of frames) {
      const event = journalEventForOutbound(asOutbound(frame), { reasoningDurable });
      if (event !== null) events.push(event);
    }
    return rowsFor(events);
  }

  /** A served row with `ts` stripped — the shape the shared fixture pins. */
  const withoutTs = (row: ProjectedHistoryMessage): unknown => {
    const { ts: _ts, ...rest } = row;
    return rest;
  };

  it("ONE row per burst — the unthrottled cumulative stream does not reach the store", () => {
    // Stated first: without the `final` gate this turn would write three rows
    // for `r1` alone, each holding the whole text so far.
    expect(journalRowsFor(ORDINARY_TURN_FRAMES).map((r) => r.kind)).toEqual([
      "reasoning",
      "placement",
      "bubble",
      "reasoning",
      "bubble",
    ]);
    // Non-vacuity: the fixture really does stream the burst more than once.
    expect(
      ORDINARY_TURN_FRAMES.filter((f) => f.type === "reasoning" && f.final !== true),
    ).not.toHaveLength(0);
  });

  it("serves EXACTLY the rows the client-side live==history twin replays", () => {
    const { read } = fakeReader(journalRowsFor(ORDINARY_TURN_FRAMES));
    const messages = projectJournalHistory(read, CONV).messages;

    // ⚠️ THE SHARED FIXTURE IS THE EXPECTATION. `toEqual` on the whole array
    // after stripping `ts`: no `role` on a reasoning row, no `kind` on a text
    // row, and the ORDER is the reducer's.
    expect(messages.map(withoutTs)).toEqual(ORDINARY_TURN_ROWS.map((row) => ({ ...row })));
    // The position claim, stated on its own so a reordering regression names
    // itself rather than hiding inside the equality above.
    expect(messages.map((m) => m.id)).toEqual(["r1", "A", "r2", "B"]);

    // `ts` is THIS module's concern and is asserted here rather than in the
    // shared fixture — first appearance, so `A` is dated by its PLACEMENT row
    // (index 1), not by its bubble.
    expect(messages.map((m) => m.ts)).toEqual([
      T0 + 0 * T_STEP,
      T0 + 1 * T_STEP,
      T0 + 3 * T_STEP,
      T0 + 4 * T_STEP,
    ]);
  });

  it("serves NOTHING for the same turn when the account did not opt in", () => {
    // Non-vacuity for the whole block, and the shipped default: with
    // `reasoningDurable` off the identical frames produce a bubble-only history,
    // and the peer's reload legitimately shows no reasoning.
    const { read } = fakeReader(journalRowsFor(ORDINARY_TURN_FRAMES, false));
    expect(projectJournalHistory(read, CONV).messages.map((m) => m.id)).toEqual(["A", "B"]);
  });

  /**
   * ⚠️ CHARACTERIZATION — GAP 2b, FROM THE SERVER SIDE.
   *
   * The shared fixture's ordinary turn closes every burst before the next
   * answer's `progress`, so it cannot reach the ordering divergence. This drives
   * the fixture that can, through the REAL mapper and the REAL projection, and
   * pins the order the SERVER produces; the client half pins the order the LIVE
   * client produces for the same frames. The two expectations differ ON PURPOSE
   * — that difference IS the gap, and it is now measured in both packages
   * instead of asserted in a comment.
   */
  it("CHARACTERIZATION: an answer slot claimed mid-burst replays out of live order", () => {
    const { read } = fakeReader(journalRowsFor(INTERLEAVED_TURN_FRAMES));
    expect(projectJournalHistory(read, CONV).messages.map((m) => m.id)).toEqual([
      ...INTERLEAVED_TURN_REPLAY_IDS,
    ]);
  });
});

/**
 * ⭐ #242 half 3 — THE CENTRAL PROPERTY, PLUGIN HALF.
 *
 * The client twin (`packages/client/src/durable-view-reducer.test.ts`) drives
 * the REAL wrapper over `TOOL_TURN_FRAMES` and asserts the live view. THIS half
 * drives the real `journalEventForOutbound` and the real projection over the
 * SAME fixture and asserts that what the plugin SERVES is exactly what that
 * twin replays. Neither can be edited alone.
 */
describe("live == history for tool activity: what the plugin serves (#242 half 3)", () => {
  const asOutbound = (frame: ToolTurnFrame | ReasoningTurnFrame): OutboundWsMessage =>
    frame as unknown as OutboundWsMessage;

  function toolJournalRows(): DeliveryJournalRow[] {
    const events: JournalEvent[] = [];
    for (const frame of TOOL_TURN_FRAMES) {
      // NO policy: tool durability has no account opt-in, unlike reasoning.
      const event = journalEventForOutbound(asOutbound(frame));
      if (event !== null) events.push(event);
    }
    return rowsFor(events);
  }

  const stripTs = (row: ProjectedHistoryMessage): unknown => {
    const { ts: _ts, ...rest } = row;
    return rest;
  };

  it("writes ONE ROW PER FRAME — the opposite of reasoning's one-per-burst", () => {
    // The decision, made checkable. Three tool frames become three `tool` rows,
    // because no single frame is self-contained (the closing one carries neither
    // `name` nor `argKeys`).
    expect(toolJournalRows().map((r) => r.kind)).toEqual([
      "tool",
      "tool",
      "placement",
      "tool",
      "bubble",
    ]);
  });

  it("serves EXACTLY the rows the client-side live==history twin replays", () => {
    const { read } = fakeReader(toolJournalRows());
    const messages = projectJournalHistory(read, CONV).messages;

    // ⚠️ THE SHARED FIXTURE IS THE EXPECTATION. The three delta rows have been
    // folded by `applyTool` into ONE served row carrying fields from all three.
    expect(messages.map(stripTs)).toEqual(TOOL_TURN_ROWS.map((row) => ({ ...row })));
    // The position claim, stated on its own so a reordering regression names
    // itself rather than hiding inside the equality above.
    expect(messages.map((m) => m.id)).toEqual(["call-1", "A"]);
  });

  it("dates the call by its FIRST frame — a tool call's moment is when it began", () => {
    // `ts` is THIS module's concern and is asserted here rather than in the
    // shared fixture. `recordFirstSeen` is first-write-wins, so `call-1` is
    // dated by row 1 (its `start`), not by the `end` frame at row 4.
    const rows = toolJournalRows();
    const { read } = fakeReader(rows);
    const messages = projectJournalHistory(read, CONV).messages;
    expect(messages.find((m) => m.id === "call-1")?.ts).toBe(rows[0].createdMs);
  });

  it("recognises the `tool` kind — it is not counted as an unsupported row", () => {
    // `KNOWN_EVENT_KINDS` is the gate; a build that forgot to add `tool` there
    // would drop every row and report it here rather than serving a partial
    // transcript silently.
    const { read } = fakeReader(toolJournalRows());
    expect(projectJournalHistory(read, CONV).unsupportedEvents).toBe(0);
  });
});

/**
 * ⭐ #242 half 4 — THE CENTRAL PROPERTY, PLUGIN HALF.
 *
 * The client twin (`packages/client/src/durable-view-reducer.test.ts`) drives
 * the REAL wrapper over `APPROVAL_TURN_FRAMES` and asserts the live view. THIS
 * half drives the real `journalEventForOutbound` and the real projection over
 * the SAME fixture and asserts that what the plugin SERVES is exactly what that
 * twin replays. Neither can be edited alone.
 */
describe("live == history for approvals: what the plugin serves (#242 half 4)", () => {
  const asOutbound = (frame: ApprovalTurnFrame | ReasoningTurnFrame): OutboundWsMessage =>
    frame as unknown as OutboundWsMessage;

  function approvalJournalRows(): DeliveryJournalRow[] {
    const events: JournalEvent[] = [];
    for (const frame of APPROVAL_TURN_FRAMES) {
      // NO policy: approval durability has no account opt-in, like tool and
      // unlike reasoning. The argument is at the mapper's `approval_request`
      // case and is made from the payload's own content.
      const event = journalEventForOutbound(asOutbound(frame));
      if (event !== null) events.push(event);
    }
    return rowsFor(events);
  }

  const stripTs = (row: ProjectedHistoryMessage): unknown => {
    const { ts: _ts, ...rest } = row;
    return rest;
  };

  it("writes TWO APPEND-ONLY ROWS for one card — never an edit of the first", () => {
    // The design decision, made checkable. The request and the resolution are
    // two rows; nothing rewrites a stored payload, so #241's revision model is
    // not a prerequisite.
    expect(approvalJournalRows().map((r) => r.kind)).toEqual([
      "approval",
      "placement",
      "approvalResolution",
      "bubble",
    ]);
  });

  it("serves EXACTLY the rows the client-side live==history twin replays", () => {
    const { read } = fakeReader(approvalJournalRows());
    const messages = projectJournalHistory(read, CONV).messages;

    // ⚠️ THE SHARED FIXTURE IS THE EXPECTATION. The two rows have been folded
    // into ONE served card carrying the request's payload AND the resolution's
    // verdict.
    expect(messages.map(stripTs)).toEqual(APPROVAL_TURN_ROWS.map((row) => ({ ...row })));
    // The position claim, stated on its own so a reordering regression names
    // itself rather than hiding inside the equality above.
    expect(messages.map((m) => m.id)).toEqual(["ap-1", "A"]);
  });

  it("dates the card by its REQUEST — a prompt's moment is when it was shown", () => {
    // `ts` is THIS module's concern and is asserted here rather than in the
    // shared fixture. `recordFirstSeen` is first-write-wins and
    // `approvalResolution` notes nothing at all, so `ap-1` is dated by row 1.
    const rows = approvalJournalRows();
    const { read } = fakeReader(rows);
    const messages = projectJournalHistory(read, CONV).messages;
    expect(messages.find((m) => m.id === "ap-1")?.ts).toBe(rows[0].createdMs);
  });

  it("recognises both approval kinds — neither is counted as an unsupported row", () => {
    // `KNOWN_EVENT_KINDS` is the gate; a build that forgot either arm would drop
    // those rows and report it here rather than serving a partial transcript
    // silently. Half 4 is the first slice to add TWO kinds at once.
    const { read } = fakeReader(approvalJournalRows());
    expect(projectJournalHistory(read, CONV).unsupportedEvents).toBe(0);
  });

  it("a resolution naming a card the journal does not hold changes nothing", () => {
    // `applyApprovalResolution` no-ops rather than appending a contentless card
    // built from an id and a verdict — that would be the server INVENTING a
    // message (N8). Unreachable in a full replay since #341 (both rows are
    // written at the moment the plugin RECORDS each state change, above the
    // transport's refusals, so the request row always precedes — before that a
    // refused request really did leave this orphan), and pinned here because the
    // alternative is the tempting one.
    const orphan = journalEventForOutbound({
      type: "approval_resolved",
      id: "never-requested",
      decision: "deny",
    } as unknown as OutboundWsMessage);
    expect(orphan).not.toBeNull();
    const { read } = fakeReader(rowsFor([orphan!]));
    expect(projectJournalHistory(read, CONV).messages).toEqual([]);
  });

  it("an id-less approval frame is refused rather than stored under an empty id", () => {
    // The same `isUsableMessageId` rule every other durable branch uses. The
    // client refuses the identical shape, so nothing renders live that history
    // cannot hold.
    expect(
      journalEventForOutbound({
        type: "approval_request",
        id: "",
        kind: "exec",
        title: "T",
        prompt: "P",
        options: [],
      } as unknown as OutboundWsMessage),
    ).toBeNull();
    expect(
      journalEventForOutbound({
        type: "approval_resolved",
        id: "",
        decision: "deny",
      } as unknown as OutboundWsMessage),
    ).toBeNull();
  });

  it("the stored event COPIES `options` — the caller cannot mutate the journal", () => {
    const frame = {
      type: "approval_request",
      id: "ap-x",
      kind: "exec" as const,
      title: "T",
      prompt: "P",
      options: [{ decision: "deny" as const, label: "No", style: "danger" }],
    };
    const event = journalEventForOutbound(frame as unknown as OutboundWsMessage);
    frame.options[0].label = "MUTATED";
    expect(event).toMatchObject({
      kind: "approval",
      options: [{ decision: "deny", label: "No", style: "danger" }],
    });
  });
});
