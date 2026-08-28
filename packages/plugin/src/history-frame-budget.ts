/**
 * #311 — FIT A `history` PAGE INTO THE PEER'S EFFECTIVE `max_payload`.
 *
 * ⚠️ WHAT WENT WRONG WITHOUT THIS, MEASURED, because the numbers are the whole
 * argument for the module existing. `history.limit` / `history.pageSize` /
 * `MAX_WIRE_HISTORY_LIMIT` bound a page by ROW COUNT and nothing bounded it by
 * BYTES. On an encrypted channel a 50-row snapshot seals past a stock
 * nats-server's 1 MiB at 15 651 bytes of text per row, and a peer-requested
 * 1000-row page at 734 bytes per row — an ordinary paragraph. Past that,
 * `nats-transport.ts`'s `publish` threw a `RangeError`,
 * `nats-channel.ts`'s `sendToPeer` swallowed it and returned `false`, and
 * `history-serve.ts` discarded that `false`. The peer received NO history frame
 * at all — not a short one — on every reconnect, and nothing said so.
 * `history-frame-oversize.test.ts` holds those measurements.
 *
 * ── WHY SHORTEN RATHER THAN CHUNK ──
 *
 * The `history` frame is ALREADY a page and a pager already exists
 * (`load_history` → `historyPageBefore`). So rows dropped from the OLD end cost
 * ZERO reach: the next "load older" fetches exactly them. Chunking would need a
 * wire change, a client change, and a reassembly rule that can fail halfway;
 * shortening needs none of the three. That is the product decision, not a
 * simplification of one.
 *
 * ── WHY A ROW THAT CANNOT FIT ALONE IS SKIPPED, AND WHY THAT IS NOT N8 ──
 *
 * The rule this looks like it collides with is doc §0.2's **N8**: we own the
 * whole stream, so ANY difference between live and history is a bug — never a
 * tolerable gap. Skipping a row is exactly such a difference unless the row was
 * never live, and here it was not: `nats-channel.ts`'s `sendToPeer` journals
 * BEFORE it publishes, so a row too big for the wire is in the store PRECISELY
 * BECAUSE its own live send hit the same `RangeError` at the same limit. The
 * peer never saw it. Omitting it therefore PRESERVES `live == history`, and
 * SHOWING it is what would break it — by making history offer something live
 * never did, which is N8 in the gaining direction.
 *
 * ⚠️ THE ARGUMENT IS ABOUT THIS PEER'S LIMIT, NOT ABOUT SIZE IN THE ABSTRACT.
 * It holds because the budget compares against the very number `publish`
 * compares against. If a caller ever passed a limit LOWER than the transport's,
 * the equivalence would break and rows the peer HAD seen live would start
 * disappearing from history — so `history-serve.ts` passes
 * `effectiveOutboundLimit()` and nothing else.
 *
 * ⚠️ AND SKIPPING IS WHAT KEEPS THE PAGER ABLE TO PASS IT. Without the skip the
 * budget simply stops at such a row, every page ends there, and "load older"
 * can never get behind it — the blackout becomes a permanent wall at one row
 * instead of a whole-frame loss. The skip is the difference between a fix and a
 * relocation of the bug.
 *
 * ── WHY MEASUREMENT IS INJECTED ──
 *
 * `measure` is a parameter, so this module imports no channel, no crypto and no
 * transport, exactly as `history.ts` holds the pure planning logic that
 * `history-serve.ts` wires to a seam. The caller passes
 * `NatsChannel.outboundWireSize`, which returns the SEALED length — the number
 * `publish` actually compares against `effectiveOutboundLimit`. A
 * `JSON.stringify` estimate would be a different bound than the one that
 * governs: on an encrypted channel the sealed frame is ~4/3 of the JSON,
 * because `e2e-envelope.ts` base64url-encodes the ciphertext.
 *
 * ⚠️ NO ROW IS EVER JUDGED BY AN ESTIMATE, and there is no estimator here to be
 * tempted by. A cheap per-row `base64UrlLength(JSON.stringify(row))` pre-filter
 * DID exist and was deleted: mutating it away left all 27 tests green, because
 * it was behaviourally identical to the boundary-blocker step below — the
 * bisection's blocker always lands on the oversized row, at any position,
 * including when nothing fits at all. It was a measurement-count optimisation
 * wearing a correctness argument, and the cost of keeping it was an estimator
 * whose two error directions had to be documented and could never be tested.
 * The price paid for deleting it is measured and pinned in
 * `history-frame-budget.test.ts` ("the multi-poison cost").
 */
import type { HistoryMessage } from "./history.js";

/**
 * Sealed size of `{type:"history", messages: rows}` for the peer this page is
 * for, or `undefined` when the size cannot be known.
 *
 * `undefined` is the shape `NatsChannel.outboundWireSize` returns on an
 * encrypted channel with no session key yet, and it is deliberately NOT treated
 * as "assume plaintext" here — see `fitHistoryFrame`.
 */
export type HistoryFrameMeasure = (rows: HistoryMessage[]) => number | undefined;

/** A row that alone exceeds the limit, with the size that proved it. */
export type SkippedHistoryRow = { id: string; bytes: number };

export type FittedHistoryFrame = {
  /** The rows to publish: a contiguous, order-preserving subset. */
  rows: HistoryMessage[];
  /** Rows that can NEVER be sent to this peer. Operator-actionable. */
  skipped: SkippedHistoryRow[];
  /**
   * How many OLD rows the byte budget dropped. Not data loss: every one of them
   * is still reachable through `load_history` with the served page's oldest id
   * as the cursor.
   */
  trimmed: number;
};

export type FitHistoryFrameOptions = {
  measure: HistoryFrameMeasure;
  /** The peer's effective `max_payload` (`NatsChannel.effectiveOutboundLimit`). */
  limit: number;
};

/**
 * Shorten a history page until it fits the peer's wire, keeping the NEWEST rows.
 *
 * Rows arrive oldest → newest (the order `journal-history.ts` produces and the
 * order the client renders) and the result is always a CONTIGUOUS SUBSEQUENCE
 * in that same order. Order is never permuted: the reducer owns it, and a
 * second opinion about message order held by the pager is N8.
 *
 * Never mutates `rows`.
 *
 * The three ways this can end:
 *  1. it already fits — returned unchanged, at a cost of exactly ONE
 *     measurement, which is the case essentially every real page takes;
 *  2. it does not fit — ONE loop below both serves the newest rows that do
 *     (`trimmed` counts the older ones it left out, all still reachable by
 *     paging) and `skipped`s any row that cannot fit even alone, so the page
 *     can span across it. Those are not two passes: the row the bisection stops
 *     at is measured on its own, and which of the two outcomes it gets is
 *     decided by that one measurement;
 *  3. nothing can be decided (see below) — returned unchanged, so the send
 *     fails loudly at the channel rather than quietly here.
 *
 * ⚠️ CASE 3 IS TWO SITUATIONS AND BOTH RETURN THE INPUT ON PURPOSE:
 *  - `measure` returns `undefined`: the channel is encrypted and has no session
 *    key for this peer yet (`nats-channel.ts`'s `outboundWireSize`). `sendToPeer`
 *    is about to refuse that send fail-closed for the very same reason, so there
 *    is nothing to budget for. Substituting a plaintext estimate would apply a
 *    DIFFERENT bound than the one that governs the wire.
 *  - the limit is unusable (non-integer, negative), or so small that even an
 *    EMPTY frame exceeds it. No subset of rows can help. Returning `[]` there
 *    would publish an empty frame that impersonates an empty conversation to its
 *    owner — the exact thing `history-serve.ts`'s failed-read path is forbidden
 *    to do — so the whole page is handed on and the publish failure is reported.
 */
export function fitHistoryFrame(
  rows: HistoryMessage[],
  options: FitHistoryFrameOptions,
): FittedHistoryFrame {
  const { measure, limit } = options;
  const unchanged = (): FittedHistoryFrame => ({ rows, skipped: [], trimmed: 0 });

  // Same guard idiom as `nats-channel.ts`'s `sendIngressResult`, which treats an
  // unusable advertised limit as "no limit known" rather than as a bound.
  if (!Number.isSafeInteger(limit) || limit < 0) return unchanged();

  const sizeOf = (candidate: HistoryMessage[]): number | undefined => {
    const bytes = measure(candidate);
    return typeof bytes === "number" && Number.isSafeInteger(bytes) && bytes >= 0
      ? bytes
      : undefined;
  };

  // ── 1. THE FAST PATH: one measurement, and the page is on its way. ──
  const whole = sizeOf(rows);
  if (whole === undefined) return unchanged();
  if (whole <= limit) return unchanged();

  // Below here the frame is known not to fit, and every extra measurement is
  // paid only by a page that was going to be LOST entirely.

  // If not even an empty frame fits, no subset does — see case 3 above.
  const emptyFrame = sizeOf([]);
  if (emptyFrame === undefined || emptyFrame > limit) return unchanged();

  // ── 2. THE BUDGET FILL, with boundary-blocker convergence. ──
  //
  // Each pass either returns a page or removes exactly one row, so the pass
  // count is bounded by the row count. The bound is written as a `for` rather
  // than a `while (true)` so the termination argument is checkable at the
  // syntax, not only in prose.
  const skipped: SkippedHistoryRow[] = [];
  // ⚠️ REBOUND, NEVER SPLICED, and that is not a style preference. This array is
  // handed to `measure` as-is, and `measure` is `outboundWireSize` → a frame
  // object holding it. Mutating it in place would edit an array a caller may
  // still be looking at, and a test spy that records what it was called with
  // would record it changing under itself — which is exactly how this was
  // caught.
  let survivors: HistoryMessage[] = [...rows];
  for (let pass = 0; pass <= rows.length; pass++) {
    if (survivors.length === 0) return { rows: [], skipped, trimmed: 0 };

    const survivingWhole = sizeOf(survivors);
    if (survivingWhole === undefined) return unchanged();
    // Dropping an undeliverable row on an earlier pass may have been enough on
    // its own — a whole page can overflow entirely because of one such row.
    if (survivingWhole <= limit) return { rows: [...survivors], skipped, trimmed: 0 };

    // Largest fitting SUFFIX, by bisection. Sealed size is monotone in row
    // count, so the predicate is monotone and the search is exact: ~10
    // measurements at 1000 rows. `lo` fits (the empty frame was checked above),
    // `hi` does not (`survivingWhole`).
    let lo = 0;
    let hi = survivors.length;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      const bytes = sizeOf(survivors.slice(survivors.length - mid));
      if (bytes === undefined) return unchanged();
      if (bytes <= limit) lo = mid;
      else hi = mid;
    }

    // ⚠️ THE BLOCKER — the row immediately OLDER than the largest fitting
    // suffix, i.e. the one that stopped the search. This single measurement is
    // what decides between the two outcomes, and it is why the module needs no
    // separate pass to find undeliverable rows: the blocker either cannot fit
    // ALONE (skip it and search again, so the page spans across it) or it is
    // simply where the budget ran out (serve the suffix). `lo === 0` — nothing
    // fits at all — makes the blocker the NEWEST row, which is the same rule
    // reaching the same place.
    const blockerIndex = survivors.length - lo - 1;
    const blocker = survivors[blockerIndex]!;
    const blockerBytes = sizeOf([blocker]);
    if (blockerBytes === undefined) return unchanged();
    if (blockerBytes > limit) {
      skipped.push({ id: blocker.id, bytes: blockerBytes });
      survivors = [
        ...survivors.slice(0, blockerIndex),
        ...survivors.slice(blockerIndex + 1),
      ];
      continue;
    }

    return {
      rows: survivors.slice(blockerIndex + 1),
      skipped,
      trimmed: blockerIndex + 1,
    };
  }

  // Unreachable: every pass returns or shortens `survivors`, and the pass bound
  // is the row count. Kept as a total function rather than a `throw` — a
  // history read must not become an `uncaughtException` inside
  // `history-serve.ts`'s scheduled callback if that reasoning is ever wrong.
  return { rows: [], skipped, trimmed: survivors.length };
}
