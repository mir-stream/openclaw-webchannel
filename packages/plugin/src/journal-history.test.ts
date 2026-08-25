/**
 * v6 #240 half 1 — the journal → history projection.
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
 *     never egressed a bubble and the post-`remove` resurrect that must keep its
 *     ORIGINAL moment, plus the fallback and the anchor that feeds it;
 *   - unknown kinds: counted, excluded, and harmless to the surrounding fold;
 *   - paging: every edge of the two pure selectors.
 * Plus two tests against a REAL `openDeliveryJournal`, because nothing else
 * proves the projection and the store compose.
 *
 * TWO CHARACTERIZATION CASES record known-wrong-ish behaviour rather than
 * endorsing it — a `NaN` limit reaching `slice` (inherited from
 * `history.ts:pageBefore` deliberately, see that selector's docblock), and an id
 * dated by a `seal` the REDUCER rejected (`recordFirstSeen`'s docblock has the
 * full argument for documenting instead of fixing). Both are labelled
 * CHARACTERIZATION in their names so nobody reads them as specifications.
 *
 * ⚠️ TWO OF THESE ARE MUTATION-PROVED AND MUST STAY THAT WAY. The ts-anchor test
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
import type { JournalEvent } from "./delivery-journal-event.js";
import type { HistoryMessage } from "./history.js";
import {
  HISTORY_REPLAY_CHUNK_ROWS,
  historyPageBefore,
  projectJournalHistory,
  recentHistoryPage,
  type JournalReader,
} from "./journal-history.js";
import { reduceDurableView } from "../../client/src/durable-view-reducer.js";

const TURN = "turn-1";
const CONV = "conv-0";

/** First row's `created_ms`, and the step between rows. Round so `ts` reads. */
const T0 = 1_000_000;
const T_STEP = 10;

/**
 * The representative journal: a user echo, slot claims, a notice, durable
 * bubbles, a seal that BOTH reorders two answers and MINTS a third that never
 * egressed a bubble (the #215 create-or-update recovery) and removes a
 * mis-routed overflow bubble, then a post-`remove` same-id bubble that
 * RESURRECTS it.
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
    // The seal drops X and reorders the answer slots to [B, A]; C is MINTED next
    // to its predecessor answer A, which shifts NOTICE one slot right; the
    // trailing bubble then RESURRECTS X at the tail. Every one of those is the
    // REDUCER's doing — this file asserts the projection carries them through
    // unchanged, it does not re-derive them.
    expect(projection.messages).toEqual([
      { id: "u-0", role: "user", text: "do the thing", ts: T0 + 0 * T_STEP },
      { id: "B", role: "agent", text: "B (sealed)", ts: T0 + 4 * T_STEP },
      { id: "A", role: "agent", text: "A (sealed)", ts: T0 + 1 * T_STEP },
      { id: "NOTICE", role: "agent", text: "a notice", ts: T0 + 3 * T_STEP },
      { id: "C", role: "agent", text: "C (minted)", ts: T0 + 7 * T_STEP },
      { id: "X", role: "agent", text: "X, resurrected", ts: T0 + 6 * T_STEP },
    ]);
  });

  it("emits the REDUCER's order, never a sort — ts is non-monotone and that is correct", () => {
    // THE no-reimplementation property, stated once. If this module ever grows
    // its own ordering rule — or "helpfully" sorts by ts — this is what goes red.
    const { read } = fakeReader(rowsFor(MIXED_STREAM));
    const projected = projectJournalHistory(read, CONV).messages;
    expect(projected.map((m) => m.id)).toEqual(
      reduceDurableView(MIXED_STREAM).map((m) => m.id),
    );
    // And the stream is one where the two orders genuinely differ: B's first
    // appearance is LATER than A's, yet the seal puts B first. A ts sort would
    // silently pass the id check against a sorted expectation, so assert the
    // inversion directly.
    const ts = projected.map((m) => m.ts);
    expect(ts).not.toEqual([...ts].sort((a, b) => a - b));
  });

  it("carries the reducer's full durable view, text included", () => {
    const { read } = fakeReader(rowsFor(MIXED_STREAM));
    const projected = projectJournalHistory(read, CONV).messages;
    expect(projected.map(({ id, role, text }) => ({ id, role, text }))).toEqual(
      reduceDurableView(MIXED_STREAM).map(({ id, role, text }) => ({
        id,
        role,
        text,
      })),
    );
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
    // delivery-journal.ts:720-723). Against an INJECTED reader `chunkRows: 0`
    // would return an empty projection indistinguishable from an empty
    // conversation — the silently-empty-history failure `DeliveryJournal.read`'s
    // docblock calls the worse of its two evils.
    const { read, calls } = fakeReader(rowsFor(MIXED_STREAM));
    for (const chunkRows of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        projectJournalHistory(read, CONV, { chunkRows }),
      ).toThrow(/chunkRows must be an integer >= 1/);
    }
    // It throws BEFORE reading, so a bad page size cannot half-project.
    expect(calls).toEqual([]);
    // 1 is legal — the smallest page, not an error.
    expect(
      projectJournalHistory(read, CONV, { chunkRows: 1 }).messages,
    ).toHaveLength(6);
  });

  it("gives the SAME projection at every chunk size as one big read", () => {
    // BOTH streams, and the second one is load-bearing rather than extra
    // coverage: `MIXED_STREAM` alone cannot detect a chunk loop that RE-FOLDS
    // rows it already consumed, because its only non-idempotent event
    // (`applyUser`) sits at seq 1 where no overlap reaches it. See
    // `RE_FOLD_SENSITIVE_STREAM`'s comment for the measurement.
    const streams: Array<[string, JournalEvent[], number]> = [
      ["MIXED_STREAM", MIXED_STREAM, 6],
      ["RE_FOLD_SENSITIVE_STREAM", RE_FOLD_SENSITIVE_STREAM, 7],
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
    expect(reFold.messages.filter((m) => m.role === "user").map((m) => m.id)).toEqual(
      ["u-0", "u-1"],
    );
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
    // needed. (An earlier revision reassigned `withUnknown[8]` here, which was a
    // no-op — it rebuilt the identical row — and read as if renumbering were
    // required.)
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
    // below the `isKnownJournalEvent` guard left all 34 tests green. This is the
    // test that pins it.
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

  it("a post-remove RESURRECT keeps its ORIGINAL ts, not the resurrecting row's", () => {
    // X is bubbled at index 6, removed by the seal at 7, and re-bubbled at 8.
    // First-appearance means the moment the user first saw it, which is 6.
    const { read } = fakeReader(rowsFor(MIXED_STREAM));
    const resurrected = projectJournalHistory(read, CONV).messages.find(
      (m) => m.id === "X",
    );
    expect(resurrected?.ts).toBe(T0 + 6 * T_STEP);
    expect(resurrected?.text).toBe("X, resurrected");
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
    // whole event when `turnId` is blank (durable-view-reducer.ts:544), so this
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
});

describe("recentHistoryPage", () => {
  const page: HistoryMessage[] = [
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

  it("returns [] for a non-positive limit — history.ts:pageBefore's guard", () => {
    expect(recentHistoryPage(page, 0)).toEqual([]);
    expect(recentHistoryPage(page, -1)).toEqual([]);
  });

  it("CHARACTERIZATION: a NaN limit falls through and returns everything", () => {
    // `NaN <= 0` is false, so it reaches `slice`. This is inherited from
    // `history.ts:pageBefore` (history.ts:431) on purpose rather than fixed with
    // a third convention: `planHistoryFetch` (history.ts:337) is what sanitizes
    // limit in BOTH the old path and the new one. Recorded, not endorsed.
    expect(recentHistoryPage(page, Number.NaN)).toEqual(page);
  });

  it("does not alias the input array", () => {
    expect(recentHistoryPage(page, 99)).not.toBe(page);
  });
});

describe("historyPageBefore", () => {
  const page: HistoryMessage[] = [
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

  it("returns [] for a cursor that is not in the projection", () => {
    // The honest "no more history" signal, and `history.ts:pageBefore`'s
    // existing contract (history.ts:411-414): newest-N would only feed the
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
    // `planHistoryFetch` (history.ts:337) is what prevents this upstream, in the
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
    const input: HistoryMessage[] = [
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
