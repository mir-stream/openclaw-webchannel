/**
 * THE CONTAINMENT RUNBOOK'S DISK INVENTORY MUST NAME EVERY DURABLE KIND.
 *
 * ⚠️ THIS TEST EXISTS BECAUSE A PROSE RULE FAILED FOUR TIMES, TWICE AGAINST ITS
 * OWN WORDING. `docs/CREDENTIAL_CONTAINMENT_RUNBOOK.md` §0.2 is the single
 * authority for what this plugin writes to disk — `ISSUE_72_CONTAINMENT_PLAN.md`
 * defers to it, and an operator running the §0.1 exposure assessment reads that
 * list and stops. The list has been wrong four times in the same direction:
 * the journal file missing entirely; the INGRESS seam missing so every message
 * users typed was unlisted; then **#242 half 3** shipping `tool_activity` rows;
 * then **#242 half 4** shipping approval rows, which are the first class to put
 * command ARGUMENT VALUES on disk with no opt-in.
 *
 * The last two are the reason this file is code rather than a firmer sentence:
 * the rule "a slice that teaches either seam to write a new kind must edit THIS
 * list in the same change" was ALREADY IN the paragraph both of them left stale.
 * Wording was never the missing part.
 *
 * ⚠️ WHAT IT CHECKS, STATED HONESTLY — IT IS DELIBERATELY DUMB. For each durable
 * kind it looks for one SUBSTRING inside the §0.2 inventory block. It does not
 * read the prose, does not verify the description is correct, and cannot tell a
 * thorough paragraph from the word appearing once. What it does guarantee is the
 * failure mode that actually happened twice: **add a durable kind, forget the
 * runbook, go red.** Two independent gates produce that:
 *
 *   1. `RUNBOOK_TOKENS` is a `Record<JournalEvent["kind"], string>` derived from
 *      the SAME union `KNOWN_EVENT_KINDS` is derived from, so a new kind is a
 *      COMPILE error here (missing property) before any assertion runs. That is
 *      the same device `KNOWN_EVENT_KINDS` itself uses, and it has now fired for
 *      `reasoning`, `tool`, `approval` and `approvalResolution`;
 *   2. the token must then actually appear in the section, which is what forces
 *      the author to the doc rather than to a one-word edit here.
 *
 * ⚠️ THE RESIDUAL HOLE, NAMED SO NOBODY MISTAKES THIS FOR MORE THAN IT IS: gate
 * 2 can be satisfied by choosing a token that already appears in the section for
 * an unrelated reason. That is a deliberate circumvention, not a forget, and the
 * class of failure this file targets is the forget. Do not "fix" a red by
 * loosening a token — the runbook paragraph says so too.
 *
 * ⚠️ THE SECTION IS BOUNDED, NOT THE WHOLE FILE. Searching the whole document
 * would pass on accidents: `"tool"` matches `"tooling"` twice elsewhere in this
 * very runbook (measured — that is exactly how half 3's omission stayed
 * invisible), and `"user"` matches on nearly every page. The bounds below are
 * the inventory bullet itself.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { KNOWN_EVENT_KINDS } from "./journal-history.js";
import type { JournalEvent } from "./delivery-journal-event.js";

const RUNBOOK_PATH = new URL(
  "../../../docs/CREDENTIAL_CONTAINMENT_RUNBOOK.md",
  import.meta.url,
);

/** First line of the §0.2 disk inventory bullet. */
const SECTION_START = "- **What this plugin writes**";
/** The bullet that follows it — the inventory ends here. */
const SECTION_END = "- **Rotating K does not disconnect anyone";

/**
 * One substring per durable kind that the inventory section must contain.
 *
 * ⚠️ THE TOKENS ARE THE OPERATOR'S WORDS, NOT THE EVENT KIND NAMES, and that is
 * on purpose. A runbook that had to spell `placement`, `seal` and
 * `approvalResolution` would be written for this test instead of for the person
 * reading it at 3am; the wire frame names are what the inventory naturally uses
 * and what an operator can grep a log for. The BINDING is the `Record` type, not
 * the strings.
 */
const RUNBOOK_TOKENS: Record<JournalEvent["kind"], string> = {
  user: 'kind:"user"',
  placement: "`progress` placements",
  bubble: "`agent_message`",
  seal: "`turn_snapshot`",
  reasoning: "REASONING",
  tool: "`tool_activity`",
  approval: "`approval_request`",
  approvalResolution: "`approval_resolved`",
  // #241 half 1: typed edit/delete kinds. Dormant — no producer emits them yet,
  // so the runbook names them as model-only rows not on disk today, but the
  // inventory must still name them because this map binds to the union.
  messageEdited: "`messageEdited`",
  messageDeleted: "`messageDeleted`",
};

function inventorySection(): string {
  const text = readFileSync(RUNBOOK_PATH, "utf8");
  const start = text.indexOf(SECTION_START);
  const end = text.indexOf(SECTION_END, start + 1);
  // Both bounds are asserted rather than defaulted: a renamed heading would
  // otherwise silently shrink the section to "" and turn every case below into a
  // trivially failing — or, with a `?? text` fallback, a trivially passing —
  // check. Fail loudly at the seam instead.
  expect(start, `runbook section start not found: ${SECTION_START}`).toBeGreaterThanOrEqual(0);
  expect(end, `runbook section end not found: ${SECTION_END}`).toBeGreaterThan(start);
  return text.slice(start, end);
}

describe("the containment runbook's §0.2 disk inventory names every durable kind", () => {
  const section = inventorySection();

  it("has a plausibly-sized inventory section (guards the bounds above)", () => {
    // Non-vacuity. If a future edit collapses the bullet, every `toContain` below
    // would fail with a confusing message; this one names the real cause.
    expect(section.length).toBeGreaterThan(2000);
  });

  it("covers exactly the kinds this build can write — no more, no less", () => {
    // Ties the token map to the SAME enumeration `isKnownJournalEvent` uses, so
    // the two cannot drift into two opinions about what is durable.
    expect(Object.keys(RUNBOOK_TOKENS).sort()).toEqual(
      Object.keys(KNOWN_EVENT_KINDS).sort(),
    );
  });

  it.each(Object.keys(KNOWN_EVENT_KINDS) as Array<JournalEvent["kind"]>)(
    "names the `%s` rows",
    (kind) => {
      expect(
        section,
        `docs/CREDENTIAL_CONTAINMENT_RUNBOOK.md §0.2 does not mention the durable ` +
          `\`${kind}\` kind (looked for ${JSON.stringify(RUNBOOK_TOKENS[kind])}). ` +
          `That list is the single authority for what this plugin writes to disk ` +
          `and an operator reads it to run the §0.1 exposure assessment — add the ` +
          `new content class there, in THIS change, and say whether it is gated by ` +
          `an opt-in.`,
      ).toContain(RUNBOOK_TOKENS[kind]);
    },
  );

  it("states that approval rows carry argument VALUES, unlike tool rows", () => {
    // The one CONTENT claim worth pinning, because it is the sharpest line in the
    // inventory and the easiest to soften into nothing on a later edit: tool rows
    // hold argument key NAMES only, approval rows hold the command line WITH its
    // argument values, and the approval class has no opt-in.
    //
    // ⚠️ MATCHED AGAINST A WHITESPACE-COLLAPSED COPY. Markdown prose is
    // hard-wrapped, so every phrase worth asserting straddles a newline and a
    // run of indentation; matching the raw text would make this case fail on a
    // REFLOW — a green-to-red with no meaning, which is how a test like this
    // gets deleted rather than fixed.
    const flat = section.replace(/\s+/g, " ");
    expect(flat).toContain("NEVER ARGUMENT VALUES");
    expect(flat).toContain("INCLUDING ITS ARGUMENT VALUES");
    expect(flat).toContain("no opt-in");
  });
});
