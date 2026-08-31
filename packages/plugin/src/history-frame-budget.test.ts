/**
 * `history-frame-budget.ts` — the #311 byte budget, driven pure.
 *
 * `measure` is injected, so every case here is exact and instant: no crypto, no
 * transport, no journal. What that buys is the ability to make `measure`
 * DISAGREE with the module's own cheap estimate, which is the only way to prove
 * the rule the module rests on — estimate to nominate, MEASURE to decide.
 *
 * The end-to-end counterpart (real channel, real journal, real sealed sizes)
 * is `history-frame-oversize.test.ts`; this file is where the algorithm's edges
 * live.
 */
import { describe, expect, it } from "vitest";

import { fitHistoryFrame, type HistoryFrameMeasure } from "./history-frame-budget.js";
import type { HistoryMessage } from "./history.js";

/** A bubble whose body is `bytes` long, so a row's size is stated by the test. */
function row(id: string, bytes: number): HistoryMessage {
  return { id, role: "agent", text: "x".repeat(bytes), ts: 1_000 };
}

function rows(count: number, bytes: number, prefix = "m"): HistoryMessage[] {
  return Array.from({ length: count }, (_, i) => row(`${prefix}-${i}`, bytes));
}

/**
 * A stand-in for the sealed measurement: a fixed frame overhead plus a fixed
 * cost per row plus every body byte. Linear and monotone in the row set, which
 * is the only property `fitHistoryFrame` relies on.
 */
function linearMeasure(
  overrides: Record<string, number> = {},
  { frame = 40, perRow = 10 } = {},
): HistoryFrameMeasure & { calls: HistoryMessage[][] } {
  const calls: HistoryMessage[][] = [];
  const measure = ((candidate: HistoryMessage[]) => {
    // COPIED, not aliased: a spy that records the caller's own array records it
    // changing afterwards, and every assertion about call shapes then lies.
    calls.push([...candidate]);
    return candidate.reduce(
      (total, message) => total + perRow + (overrides[message.id] ?? bodyLen(message)),
      frame,
    );
  }) as HistoryFrameMeasure & { calls: HistoryMessage[][] };
  measure.calls = calls;
  return measure;
}

const ids = (fitted: { rows: HistoryMessage[] }): string[] => fitted.rows.map((m) => m.id);

/**
 * The row's body length in bytes of text. Only the text and reasoning variants
 * carry a `text` body; a tool or approval row has none, so it contributes 0 —
 * honest here because no fixture in this file builds one of those.
 */
const bodyLen = (m: HistoryMessage): number =>
  m.kind === undefined || m.kind === "reasoning" ? m.text.length : 0;

describe("fitHistoryFrame — the fast path", () => {
  it("returns the page unchanged, at a cost of exactly ONE measurement", () => {
    const page = rows(50, 100);
    const measure = linearMeasure();

    const fitted = fitHistoryFrame(page, { measure, limit: 1024 * 1024 });

    expect(fitted.rows).toEqual(page);
    expect(fitted.skipped).toEqual([]);
    expect(fitted.trimmed).toBe(0);
    // ⚠️ ASSERTED, NOT HOPED FOR. Every history read that fits — which is
    // essentially all of them — pays one seal. If a refactor makes the common
    // case measure per row, a 1000-row page seals a thousand times on the
    // shared event loop and this is what says so.
    expect(measure.calls).toHaveLength(1);
    expect(measure.calls[0]).toEqual(page);
  });

  it("treats the exact limit as fitting (boundary, not boundary+1)", () => {
    const page = rows(2, 100);
    const measure = linearMeasure();
    const exact = measure(page)!;

    expect(fitHistoryFrame(page, { measure, limit: exact }).rows).toEqual(page);
    const overBy1 = fitHistoryFrame(page, { measure, limit: exact - 1 });
    expect(overBy1.rows.length).toBeLessThan(page.length);
  });

  it("never mutates the page it was handed", () => {
    const page = rows(20, 1_000);
    const before = [...page];
    fitHistoryFrame(page, { measure: linearMeasure(), limit: 5_000 });
    expect(page).toEqual(before);
  });
});

describe("fitHistoryFrame — the budget keeps the NEWEST rows", () => {
  it("serves a contiguous suffix in the original order and reports the trim", () => {
    // Rows arrive oldest → newest. 10 rows × (100 body + 10 row) + 40 frame =
    // 1140; a 590-byte limit holds 5 of them (40 + 5×110 = 590).
    const page = rows(10, 100);
    const measure = linearMeasure();

    const fitted = fitHistoryFrame(page, { measure, limit: 590 });

    expect(ids(fitted)).toEqual(["m-5", "m-6", "m-7", "m-8", "m-9"]);
    expect(fitted.trimmed).toBe(5);
    expect(fitted.skipped).toEqual([]);
    // ⚠️ ORDER IS NEVER PERMUTED. The reducer owns message order; a pager that
    // reordered rows to pack more of them in would be a second opinion about
    // what was said (N8). The served rows must be a CONTIGUOUS slice of the
    // input, in the input's order — checked against the input rather than
    // against a hand-written list.
    const start = page.findIndex((m) => m.id === fitted.rows[0].id);
    expect(fitted.rows).toEqual(page.slice(start));
  });

  it("keeps the single newest row when only one fits", () => {
    const page = rows(6, 100);
    const fitted = fitHistoryFrame(page, { measure: linearMeasure(), limit: 150 });
    expect(ids(fitted)).toEqual(["m-5"]);
    expect(fitted.trimmed).toBe(5);
  });

  it("bisects rather than walks: a 1000-row page costs ~log2(n) measurements", () => {
    // 40 + 1000 × 1110 = 1 110 040, so a stock 1 MiB limit holds 944 rows.
    const page = rows(1_000, 1_100);
    const measure = linearMeasure();

    const fitted = fitHistoryFrame(page, { measure, limit: 1024 * 1024 });

    expect(fitted.rows).toHaveLength(944);
    expect(fitted.trimmed).toBe(56);
    expect(ids(fitted)[0]).toBe("m-56");
    // whole + empty + survivors-whole + ~10 bisection steps + the blocker. A
    // linear walk would be ~1000, and it would run on the shared event loop
    // sealing a ~1 MiB frame each time.
    expect(measure.calls.length).toBeLessThanOrEqual(16);
  });
});

describe("fitHistoryFrame — a row that can never be sent is SKIPPED, not a wall", () => {
  it("skips a poison row IN THE MIDDLE and serves rows both older and newer", () => {
    // ⚠️ THE CASE THAT SEPARATES A FIX FROM A RELOCATION. Without the explicit
    // filter the budget simply stops at the oversized row: every page ends
    // there and "load older" can never get behind it. With it, the page spans
    // ACROSS the row — which is sound because a row this big never reached the
    // peer live either (the journal is written before the publish, so it is in
    // the store precisely because its own send hit the same limit).
    const page = [
      row("old-0", 100),
      row("old-1", 100),
      row("poison", 10_000),
      row("new-0", 100),
      row("new-1", 100),
    ];
    const measure = linearMeasure();

    const fitted = fitHistoryFrame(page, { measure, limit: 600 });

    expect(fitted.skipped).toEqual([{ id: "poison", bytes: 10_050 }]);
    // Rows on BOTH sides of it are served, in order, in one frame.
    expect(ids(fitted)).toEqual(["old-0", "old-1", "new-0", "new-1"]);
    expect(fitted.trimmed).toBe(0);
  });

  it("skips several, including the newest and the oldest row of the page", () => {
    const page = [
      row("poison-oldest", 10_000),
      row("keep-0", 50),
      row("poison-mid", 10_000),
      row("keep-1", 50),
      row("poison-newest", 10_000),
    ];
    const fitted = fitHistoryFrame(page, { measure: linearMeasure(), limit: 400 });

    expect(fitted.skipped.map((s) => s.id).sort()).toEqual([
      "poison-mid",
      "poison-newest",
      "poison-oldest",
    ]);
    expect(ids(fitted)).toEqual(["keep-0", "keep-1"]);
  });

  it("judges by `measure` ALONE — a huge body that measures small is served", () => {
    // ⚠️ NOTHING ABOUT A ROW ITSELF MAY DECIDE ITS FATE. `slandered` has a 4 400
    // byte body against a 200-byte limit, so any intrinsic test — a length
    // check, a `JSON.stringify` estimate, the `base64UrlLength` pre-filter this
    // module used to carry — condemns it. The injected measurement says it is
    // tiny, and it is SERVED. This is what keeps the module honest about the
    // difference between the plaintext body and the sealed wire, which on an
    // encrypted channel is a factor of ~4/3 plus a routing block.
    //
    // `real-poison` is here because the loop only runs once the WHOLE frame
    // overflows; it is what makes this page overflow.
    const page = [row("slandered", 4_400), row("real-poison", 20_000), row("tail", 10)];
    const measure = linearMeasure({ slandered: 10 });

    const fitted = fitHistoryFrame(page, { measure, limit: 200 });

    expect(fitted.skipped.map((s) => s.id)).toEqual(["real-poison"]);
    expect(ids(fitted)).toEqual(["slandered", "tail"]);
    // ⚠️ AND IT WAS NEVER EVEN MEASURED ON ITS OWN. Only the row the bisection
    // stops at is; a row that fits inside a fitting suffix is never singled
    // out. So "served" here is not "measured and exonerated" — it is "never
    // suspected", which is the cheaper and stricter property.
    expect(measure.calls.some((c) => c.length === 1 && c[0].id === "slandered")).toBe(false);
  });

  it("catches a row whose SEALED size is the only thing that betrays it", () => {
    // The mirror of the test above: every row here has a 10-byte body, so
    // nothing about `just-over` looks wrong. Only the injected measurement
    // knows it is 250 bytes on the wire — the sealed/plaintext gap, which for a
    // small row is mostly the envelope's fixed routing block. The blocker step
    // is what catches it: the row the bisection stops at is measured alone.
    const page = [row("old", 10), row("just-over", 10), row("new", 10)];
    const measure = linearMeasure({ "just-over": 200 });

    const fitted = fitHistoryFrame(page, { measure, limit: 130 });

    // No per-row probing before the loop: the first three measurements are the
    // whole frame, the empty frame, and the whole surviving set. The single-row
    // calls that follow belong to the bisection and to the blocker check.
    expect(measure.calls.slice(0, 3).map((c) => c.length)).toEqual([3, 0, 3]);
    expect(fitted.skipped).toEqual([{ id: "just-over", bytes: 250 }]);
    expect(ids(fitted)).toEqual(["old", "new"]);
    expect(fitted.trimmed).toBe(0);
  });
});

describe("fitHistoryFrame — the cases where it must decline to budget", () => {
  it("returns the page unchanged when `measure` cannot answer", () => {
    // What `NatsChannel.outboundWireSize` returns on an encrypted channel with
    // no session key yet. `sendToPeer` is about to refuse the send fail-closed
    // for the same reason, and a plaintext-based budget would apply a different
    // bound than the one that governs the wire.
    const page = rows(10, 10_000);
    const fitted = fitHistoryFrame(page, { measure: () => undefined, limit: 10 });
    expect(fitted.rows).toEqual(page);
    expect(fitted.skipped).toEqual([]);
    expect(fitted.trimmed).toBe(0);
  });

  it("returns the page unchanged for an unusable limit", () => {
    const page = rows(4, 1_000);
    for (const limit of [Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5]) {
      const fitted = fitHistoryFrame(page, { measure: linearMeasure(), limit });
      expect(fitted.rows).toEqual(page);
      expect(fitted.trimmed).toBe(0);
    }
  });

  it("CONVERGES when the limit is smaller than an EMPTY frame", () => {
    // No subset can help. Returning `[]` here would publish an empty frame that
    // impersonates an empty conversation to its owner, so the whole page is
    // handed on and the refusal is reported by `history-serve.ts`. What must
    // never happen is the loop that a "shrink until it fits" rule invites.
    const page = rows(5, 100);
    const measure = linearMeasure({}, { frame: 500 });

    const fitted = fitHistoryFrame(page, { measure, limit: 10 });

    expect(fitted.rows).toEqual(page);
    expect(fitted.skipped).toEqual([]);
    expect(fitted.trimmed).toBe(0);
    // Two measurements and out: the whole frame, then the empty one.
    expect(measure.calls).toHaveLength(2);
  });

  it("CONVERGES when every row is undeliverable — an empty page, all skipped", () => {
    const page = rows(4, 10_000);
    const fitted = fitHistoryFrame(page, { measure: linearMeasure(), limit: 300 });
    expect(fitted.rows).toEqual([]);
    expect(fitted.skipped).toHaveLength(4);
    expect(fitted.trimmed).toBe(0);
  });

  it("handles an empty page without measuring a suffix of it", () => {
    const measure = linearMeasure();
    const fitted = fitHistoryFrame([], { measure, limit: 1_000 });
    expect(fitted.rows).toEqual([]);
    expect(measure.calls).toHaveLength(1);
  });
});


describe("fitHistoryFrame — the price of having no estimator", () => {
  /**
   * ⚠️ THIS IS A COST PIN, NOT A BEHAVIOUR TEST, AND ITS NUMBERS ARE EXACT ON
   * PURPOSE. A cheap `base64UrlLength(JSON.stringify(row))` pre-filter used to
   * nominate undeliverable rows before the loop ran. It was DELETED because it
   * was behaviourally identical to the blocker step — mutating it away left
   * every test in both files green, which is the definition of untested weight.
   * What it really bought was measurement count, and this test is where that
   * price is visible instead of implicit.
   *
   * MEASURED, on a 1000-row page carrying `p` undeliverable rows spread through
   * it, comparing the deleted pre-filter against what ships. The outcomes were
   * identical in every row — same `skipped`, same `served`, same `trimmed`;
   * only the cost differs. (The exact counts shift slightly with WHERE the
   * rows sit, which is why the assertions below pin this test's own page —
   * 62 calls / 85 MiB — rather than the p=5 line of this table.)
   *
   *      p   |  with pre-filter  |  as shipped
   *      ----|-------------------|-------------------
   *       0  |    1 call, 0.7 MiB|    1 call, 0.7 MiB
   *       1  |    4 calls,  3.6  |   15 calls,  12.6
   *       2  |    5 calls,  5.9  |   27 calls,  23.1
   *       5  |    8 calls, 12.8  |   63 calls,  80.1
   *      10  |   13 calls, 24.2  |  123 calls, 197.1
   *      20  |   23 calls, 47.1  |  243 calls, 550.5
   *
   * Calls grow as 12p+3 — one pass of {survivors-whole + ~log2(n) bisection +
   * blocker} per undeliverable row. BYTES grow QUADRATICALLY, because every
   * pass re-seals the surviving set while the not-yet-removed oversized rows
   * are still in it. At ~9.1 ms per MiB sealed (measured on this box against a
   * real encrypted channel) p=5 is ~0.7 s and p=20 is ~5 s of event loop.
   *
   * That is the accepted trade: p undeliverable rows means p × ~768 KiB of
   * stored rows that ALSO failed their live send, on a path that before #311
   * delivered NOTHING to the peer at all, ever. If this ever needs to be
   * cheaper, the fix is a smaller `hi` for the next bisection — NOT a
   * re-introduced estimator.
   */
  it("costs 12 measurements per undeliverable row, and nothing when there are none", () => {
    const page: HistoryMessage[] = [];
    for (let i = 0; i < 1_000; i++) {
      page.push(row(`m-${i}`, 700));
      if (i % 200 === 199) page.push(row(`poison-${i}`, 1_200_000));
    }
    let calls = 0;
    let bytesMeasured = 0;
    const measure = (candidate: HistoryMessage[]): number => {
      calls++;
      bytesMeasured += candidate.reduce((total, m) => total + bodyLen(m), 0);
      return candidate.reduce((total, m) => total + 10 + bodyLen(m), 40);
    };

    const fitted = fitHistoryFrame(page, { measure, limit: 1024 * 1024 });

    // The outcome is the one the deleted pre-filter produced, row for row.
    expect(fitted.skipped.map((s) => s.id).sort()).toEqual([
      "poison-199",
      "poison-399",
      "poison-599",
      "poison-799",
      "poison-999",
    ]);
    expect(fitted.rows).toHaveLength(1_000);
    expect(fitted.rows.every((m) => m.id.startsWith("m-"))).toBe(true);
    expect(fitted.trimmed).toBe(0);

    // The price. Exact, so that any change to the search shows up here as a
    // number rather than as a silent slowdown on the one path nobody profiles.
    expect(calls).toBe(62);
    expect(Math.round(bytesMeasured / (1024 * 1024))).toBe(85);
  });
});
