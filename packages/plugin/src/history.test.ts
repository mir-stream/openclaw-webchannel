/**
 * `history.ts` — the wire type + config + request-plan module.
 *
 * ⚠️ THIS FILE USED TO BE ~680 LINES AND IS NOW THIS. #240 half 2 deleted the
 * core-transcript reader (`recent`, `pageBefore`, `readFromStore`, the
 * normalizer, the `AsyncResource` detour, the cursor/shape-drift diagnostics and
 * `history-sanitize.ts`), so every test keyed on the core transcript read lost its
 * mechanism and went with it. A test whose subject no longer exists does not
 * become a weaker test — it becomes a green assertion about nothing — so those
 * were deleted rather than adapted.
 *
 * What survives here is what survives in the module: the operator config block
 * and the pure wire→plan mapping. The history READ is now
 * `journal-history.ts` and is covered in `journal-history.test.ts`; its
 * isolation property is covered in `session-route-tenant-isolation.test.ts`.
 */
import { describe, expect, it } from "vitest";

import {
  planHistoryFetch,
  resolveHistoryConfig,
  DEFAULT_HISTORY_CONFIG,
  MAX_WIRE_HISTORY_LIMIT,
} from "./history.js";

describe("history — resolveHistoryConfig (AC6)", () => {
  it("returns documented defaults when config is missing", () => {
    expect(resolveHistoryConfig(undefined)).toEqual(DEFAULT_HISTORY_CONFIG);
    expect(resolveHistoryConfig({})).toEqual(DEFAULT_HISTORY_CONFIG);
    expect(resolveHistoryConfig({ history: {} })).toEqual(DEFAULT_HISTORY_CONFIG);
  });

  it("fills missing sub-fields with defaults", () => {
    expect(resolveHistoryConfig({ history: { limit: 25 } })).toEqual({
      limit: 25,
      pageSize: DEFAULT_HISTORY_CONFIG.pageSize,
    });
    expect(resolveHistoryConfig({ history: { pageSize: 100 } })).toEqual({
      limit: DEFAULT_HISTORY_CONFIG.limit,
      pageSize: 100,
    });
  });

  it("rejects non-positive / non-finite / non-number values and falls back", () => {
    expect(resolveHistoryConfig({ history: { limit: 0, pageSize: -1 } })).toEqual(
      DEFAULT_HISTORY_CONFIG,
    );
    expect(resolveHistoryConfig({ history: { limit: NaN, pageSize: Infinity } })).toEqual(
      DEFAULT_HISTORY_CONFIG,
    );
    expect(resolveHistoryConfig({ history: { limit: "50", pageSize: "50" } })).toEqual(
      DEFAULT_HISTORY_CONFIG,
    );
  });

  it("floors fractional values so the wire contract is integer-only", () => {
    expect(resolveHistoryConfig({ history: { limit: 50.7, pageSize: 12.3 } })).toEqual({
      limit: 50,
      pageSize: 12,
    });
  });
});

describe("history — planHistoryFetch (load_history wire → fetch mapping)", () => {
  // Pins the wire→plan mapping in isolation. It is no longer the ONLY way to
  // reach it — `history-serve.ts`'s `servePage` calls `planHistoryFetch`, and
  // `history-serve.test.ts` drives that end to end against a real journal — but
  // these cases enumerate the malformed-`limit` edges far more cheaply than a
  // store-backed test can. Regression guard for the bug where the whole request
  // object was passed as `beforeId`.
  it("maps a `before` cursor to a page fetch carrying the STRING id", () => {
    expect(planHistoryFetch({ before: "m-9", limit: 25 }, 50)).toEqual({
      kind: "page",
      beforeId: "m-9",
      limit: 25,
    });
  });

  it("maps a request with no cursor to a recent (tail) fetch", () => {
    expect(planHistoryFetch({ limit: 25 }, 50)).toEqual({ kind: "recent", limit: 25 });
    expect(planHistoryFetch({}, 50)).toEqual({ kind: "recent", limit: 50 });
  });

  it("falls back to the page-size limit for NaN / non-finite / negative wire limits", () => {
    // `NaN <= 0` is false, so these must be rejected here or they slip past the
    // page selectors' own `limit <= 0` guard in `journal-history.ts` — which
    // pins that consequence as a CHARACTERIZATION case, so the two files agree
    // about whose job this is.
    expect(planHistoryFetch({ before: "m-1", limit: NaN }, 50)).toEqual({
      kind: "page",
      beforeId: "m-1",
      limit: 50,
    });
    expect(planHistoryFetch({ before: "m-1", limit: Infinity }, 50).limit).toBe(50);
    expect(planHistoryFetch({ before: "m-1", limit: -5 }, 50).limit).toBe(50);
    expect(planHistoryFetch({ before: "m-1", limit: 0 }, 50).limit).toBe(50);
    expect(planHistoryFetch({ limit: "25" as unknown as number }, 50).limit).toBe(50);
  });

  it("floors a fractional wire limit (integer-only contract)", () => {
    expect(planHistoryFetch({ before: "m-1", limit: 25.9 }, 50).limit).toBe(25);
  });

  /**
   * The peer-supplied `limit` is clamped; the operator-supplied fallback is not.
   *
   * Base capped both plans at 1000, by DIFFERENT means — the `recent` assertion
   * first below is the one that matters, and an earlier revision of this comment
   * got its mechanism wrong by saying base capped it "twice over". Base's
   * `recent()` forwarded `limit` unclamped and was capped only by core inside
   * `getSessionMessages`; `MAX_FETCH_WINDOW` lived in `pageBefore` alone. The
   * cutover removed core from the path entirely, so `{limit: 1e9}` — which
   * carries no cursor and is therefore a `recent` — selected, stringified and
   * sealed a whole conversation in one frame. See `MAX_WIRE_HISTORY_LIMIT` and
   * `planHistoryFetch`'s docblocks.
   */
  it("clamps an oversized wire limit to MAX_WIRE_HISTORY_LIMIT, on both plans", () => {
    expect(planHistoryFetch({ limit: 1e9 }, 50)).toEqual({
      kind: "recent",
      limit: MAX_WIRE_HISTORY_LIMIT,
    });
    expect(planHistoryFetch({ before: "m-1", limit: 1e9 }, 50)).toEqual({
      kind: "page",
      beforeId: "m-1",
      limit: MAX_WIRE_HISTORY_LIMIT,
    });
    // Exactly at the cap is not "oversized".
    expect(planHistoryFetch({ limit: MAX_WIRE_HISTORY_LIMIT }, 50).limit).toBe(
      MAX_WIRE_HISTORY_LIMIT,
    );
  });

  it("passes a wire limit below the cap through unchanged", () => {
    expect(planHistoryFetch({ limit: MAX_WIRE_HISTORY_LIMIT - 1 }, 50).limit).toBe(
      MAX_WIRE_HISTORY_LIMIT - 1,
    );
  });

  it("leaves the OPERATOR fallback unclamped when the wire limit is absent or invalid", () => {
    // Trusted input: an operator raising `history.pageSize` past the wire cap is
    // a deliberate configuration choice, not an attack, and must not be silently
    // overridden.
    const huge = MAX_WIRE_HISTORY_LIMIT * 10;
    expect(planHistoryFetch({}, huge).limit).toBe(huge);
    expect(planHistoryFetch({ limit: NaN }, huge).limit).toBe(huge);
    expect(planHistoryFetch({ before: "m-1", limit: -5 }, huge).limit).toBe(huge);
  });
});
