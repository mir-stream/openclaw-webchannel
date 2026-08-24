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
 * What catches it is this file, via two assertions that bound the LIKELY
 * spellings. "No statement anywhere compares an ordinal to a lane generation"
 * fires on any form that names `assistantMessageIndex` and `generation` inside
 * the same `;`-delimited statement — which is how the deleted predicate was
 * written, and how the shortest re-basing of it would be written again. "The
 * queued-block seam picks its barrier lane from lane state only" fires on a
 * generation comparison written INSIDE that seam, wherever its operands came
 * from — the seam being where a mapping has to land to affect attachment at all.
 *
 * Their reach is bounded, and the bound is measured rather than assumed — and
 * the two forms fare DIFFERENTLY, so do not read them as one hole.
 *
 * A comparison routed through a local alias defeats the FIRST assertion:
 * writing `const idx = input.assistantMessageIndex;` and comparing
 * `lane.generation` to `idx - 1` puts the two names in different statements, so
 * `offenders` sees nothing. The second assertion still catches it, because the
 * comparison itself is written inside the seam (measured: that injection goes
 * red, and it passed all five assertions before the seam assertion existed).
 *
 * What defeats BOTH is a comparison hidden inside a helper DEFINED OUTSIDE the
 * seam and merely called from it. In that form the wrong fix passes this file
 * just as it passes the fixtures. That is the known, unclosed hole.
 *
 * So read what follows as a TRIPWIRE on the tempting spellings, not as a proof
 * that no ordinal→lane mapping exists. That is still worth having, because the
 * alternative is no signal at all: the deleted `assistantMessageIndexMatchesLane`
 * looked locally reasonable and carried a correct-sounding comment for its whole
 * life, and re-basing it is the forbidden move dressed as a bugfix — it binds us
 * to an observed core version instead of a contract, and there is no sound
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
 *
 * ONE EXCEPTION, because the seam assertion is deliberately operand-agnostic and
 * therefore also refuses a generation-to-generation comparison (say
 * `barrierLane.generation === currentLane().generation`). That is pure lane
 * state, exactly what this design endorses, and it is neither a regression nor a
 * revision of the rule. Narrow the pattern to exclude that shape — do not widen
 * it into permitting an ordinal operand.
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

    // An alias defeats the file-wide identifier test (`const idx = input.assistantMessageIndex`
    // puts the two names in different statements), so ban the COMPARISON itself
    // inside the seam, where a mapping must land to have any effect.
    expect(queuedBlock).not.toMatch(/generation\s*===|===\s*[A-Za-z_$.]*generation/);
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
