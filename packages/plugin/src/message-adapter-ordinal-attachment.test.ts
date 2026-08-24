import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";

/**
 * Source-contract guard for ONE rule: no ordinal decides which lane a block
 * reservation attaches to.
 *
 * Plan §0.2 N5, in its precise form (§16.5, precision note 1): core's
 * `assistantMessageIndex` may serve as a block-ROTATION hint — core's own
 * Telegram extension uses it that way — but never as an identity key, and never
 * as the thing that decides which lane a record belongs to. Ordinal-as-identity
 * is the self-inflicted #215/#223 defect.
 *
 * WHY A SOURCE GUARD, when M238a/M238b/M238c in `message-adapter.test.ts` cover
 * the behaviour executably — this is measured, not a preference. Inject the
 * TEMPTING wrong fix, the one a future reader arrives at in good faith:
 *
 *     lane.generation === assistantMessageIndex - 1   // "just fix the base"
 *
 * falling through to the lane-state path when it matches nothing. All eight
 * M238 rows stay GREEN, and so does the rest of the plugin suite. A re-based
 * mapping is behaviourally invisible to every fixture we have, because on the
 * shapes those fixtures build it happens to select the same lane the state rule
 * does.
 *
 * What catches it is this file, and specifically "no statement anywhere compares
 * an ordinal to a lane generation" below — that one fires on every injection
 * form tried, because a re-based mapping is still a comparison. ("The
 * queued-block seam picks its barrier lane from lane state only" also fires when
 * the injection is written as a branch at that seam, but it is shape-sensitive
 * and a differently-spelled reintroduction can slip past it; do not treat it as
 * the primary net.)
 *
 * So this file is not belt-and-braces over the fixtures; on the single most
 * likely regression it is the ONLY thing standing between us and "just fix the
 * off-by-one". The deleted `assistantMessageIndexMatchesLane` looked locally
 * reasonable and carried a correct-sounding comment for its whole life, and
 * re-basing it is the forbidden move dressed as a bugfix: it binds us to an
 * observed core version instead of a contract, and there is no sound
 * ordinal→lane mapping to bind to in the first place.
 *
 * The ordinal itself is NOT banned. `reservation.assistantMessageIndex` and
 * `noticeTokens[].assistantMessageIndex` are still how a settlement finds the
 * record that settled (`outstandingRecordsAtIndex`, `retireOneRecordAtIndex`),
 * and `lane.assistantMessageIndex` is still the sound per-message stamp #172's
 * block suppression reads. Those are lifecycle and rendering. What is banned is
 * an ordinal choosing a LANE.
 *
 * If one of these assertions fails, do not relax it to match new code. Either
 * the change is a regression, or the rule itself is being revisited — and that
 * is a design decision for the plan doc, not an edit here.
 */

const SOURCE = readFileSync(
  fileURLToPath(new URL("./message-adapter.ts", import.meta.url)),
  "utf8",
);

/**
 * Comments discuss the deleted mapping on purpose, so they must not be searched
 * for it. Strip them before matching, and match against CODE only.
 */
const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

/** Locate by a semantic anchor and slice — never pin an exact multi-line literal. */
const sliceBetween = (startAnchor: string, endAnchor: string): string => {
  const start = CODE.indexOf(startAnchor);
  expect(start, `start anchor missing: ${startAnchor}`).toBeGreaterThanOrEqual(0);
  const end = CODE.indexOf(endAnchor, start);
  expect(end, `end anchor missing: ${endAnchor}`).toBeGreaterThan(start);
  return CODE.slice(start, end);
};

describe("message-adapter — barrier attachment never keys off an ordinal (#238, plan §0.2 N5)", () => {
  it("the deleted ordinal→lane matcher and its rotation-time retry stay deleted", () => {
    expect(CODE).not.toContain("assistantMessageIndexMatchesLane");
    expect(CODE).not.toContain("attachIndexedReservations");
  });

  it("no statement anywhere compares an ordinal to a lane generation", () => {
    // Either direction, and via any intermediate: a statement that mentions both
    // an `assistantMessageIndex` and a `generation` is the shape of the deleted
    // predicate, whatever base arithmetic it applies.
    const offenders = CODE.split(";").filter(
      (statement) =>
        statement.includes("assistantMessageIndex") && /\bgeneration\b/.test(statement),
    );
    expect(offenders).toEqual([]);
  });

  it("the queued-block seam picks its barrier lane from lane state only", () => {
    const queuedBlock = sliceBetween(
      "noteBlockReplyQueued: (input) => {",
      "deliverAuthorizedBlock:",
    );

    // The lane is chosen by state: an already-armed lane, else the earliest
    // unresolved lane, else the lane being streamed now.
    expect(queuedBlock).toMatch(/lane\.resolution === "unresolved"/);
    expect(queuedBlock).toMatch(/lane\.acceptsLateIndexlessReservations\s*\)/);
    expect(queuedBlock).toMatch(/\?\?\s*currentLane\(\)/);

    // ONE attachment path. A second branch keyed on the ordinal's presence is
    // exactly what was removed; a `state.lanes[...]` lookup is the same move
    // written as an index.
    expect(queuedBlock).not.toMatch(/state\.lanes\s*\[/);
    expect(queuedBlock).not.toMatch(
      /assistantMessageIndex !== undefined[\s\S]{0,400}?state\.lanes/,
    );
  });

  it("the lane a reservation attached to is recorded from that lane, not from an ordinal", () => {
    const queuedBlock = sliceBetween(
      "noteBlockReplyQueued: (input) => {",
      "deliverAuthorizedBlock:",
    );
    expect(queuedBlock).toMatch(/barrierGeneration = barrierLane\.generation/);
  });

  it("the ordinal survives where it is legitimate — settlement lookup and the #172 stamp", () => {
    // Guard the guard: the assertions above must not be satisfiable by deleting
    // the ordinal wholesale, which would break settlement retirement instead.
    expect(CODE).toContain("outstandingRecordsAtIndex");
    expect(CODE).toContain("retireOneRecordAtIndex");
    expect(CODE).toContain("laneForAssistantMessageIndex");
  });
});
