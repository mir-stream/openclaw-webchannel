/**
 * "Load older" — the PAGING LOOP, driven end to end (#242 half 2, review round 1).
 *
 * ⚠️ WHY THIS FILE EXISTS AT ALL, AND WHY IT IS THE ONLY DEMO TEST THAT REACHES
 * INTO `packages/plugin`. The defect it was written for lived in NO single
 * module: the widget's cursor pick was sound on its own, `historyPageBefore` was
 * sound on its own, and `case "history"` was sound on its own — the stall was a
 * property of the three COMPOSED. Every unit suite in the repo was green while
 * older history was permanently unreachable. So this drives the real three:
 *
 *   `oldestHistoryCursor`  (demo)            — which id the widget sends
 *   `historyPageBefore`    (packages/plugin) — which rows the server answers
 *   `case "history"`       (packages/client) — how the client merges them
 *
 * The plugin edge is TEST-ONLY and must stay that way: no file under
 * `demo/web/src` that ships imports `packages/plugin`. It is safe to import here
 * because `journal-history.ts` is a pure, IO-free projection module — its whole
 * value graph is the client's dependency-free reducer, with every store type
 * imported `type`-only, which is exactly the property its own header protects.
 *
 * WHAT IS SIMULATED AND WHAT IS REAL. The transport is simulated (frames are
 * handed to the wrapper's private `handleMessage`, as every wrapper suite does)
 * and the journal is simulated (a `ProjectedHistoryMessage[]` standing in for
 * what a replay produced). Everything that DECIDES anything is real.
 */
import { describe, it, expect } from "vitest";

import { historyPageBefore } from "../../../packages/plugin/src/journal-history.js";
import type { ProjectedHistoryMessage } from "../../../packages/plugin/src/history.js";
import { WebChannelNATSClient } from "../../../packages/client/src/index.js";
import type { ChatMessage } from "../../../packages/client/src/types.js";

import { oldestHistoryCursor, HISTORY_PAGE_SIZE } from "./presentation.js";

const TURN = "t1";

function newClient(): WebChannelNATSClient {
  // Constructor is side-effect-free — no socket until `connect()`.
  return new WebChannelNATSClient({
    natsUrl: "ws://127.0.0.1:4222",
    bootstrapJwt: "eyJ-bootstrap",
    accountId: "a",
    tenant: "t",
    peerId: "p",
    registration: {
      devicePrivateKey: {} as CryptoKey,
      deviceX25519PrivateKey: {} as CryptoKey,
    },
  });
}

type AnyFrame = { type: string; [k: string]: unknown };

function deliver(client: WebChannelNATSClient, frame: AnyFrame): void {
  (client as unknown as { handleMessage: (m: AnyFrame) => void }).handleMessage(frame);
}

/**
 * The widget's own page size — IMPORTED, not copied.
 *
 * It was `const WIDGET_LIMIT = 20;` here while `widget.ts` had `limit: 20`
 * inline, so the two could drift and this file would stay green while measuring
 * a boundary the widget no longer used — which is exactly what the boundary test
 * below promises cannot happen.
 */
const WIDGET_LIMIT = HISTORY_PAGE_SIZE;

/**
 * One "load older" click: pick the cursor the way the widget does, serve the
 * page the way the plugin does, merge it the way the client does.
 */
function clickLoadOlder(
  client: WebChannelNATSClient,
  projection: readonly ProjectedHistoryMessage[],
): { cursor: string | undefined; page: string[] } {
  const cursor = oldestHistoryCursor(client.getState().messages);
  const page =
    cursor === undefined
      ? []
      : historyPageBefore(projection, cursor, WIDGET_LIMIT);
  deliver(client, { type: "history", messages: page });
  return { cursor, page: page.map((m) => m.id) };
}

function ids(client: WebChannelNATSClient): string[] {
  return client.getState().messages.map((m: ChatMessage) => m.id);
}

/**
 * A conversation whose oldest bubble is separated from its newest one by a RUN
 * of reasoning blocks longer than the widget's page size.
 *
 * The run length is the whole point, so it is derived from `WIDGET_LIMIT`
 * rather than written as a number: at `WIDGET_LIMIT` blocks a page ending at
 * `A` contains no bubble at all, which is the exact trigger.
 */
function projectionWithReasoningRun(runLength: number): ProjectedHistoryMessage[] {
  const rows: ProjectedHistoryMessage[] = [
    { id: "u0", role: "user", text: "why?", ts: 1 },
  ];
  for (let i = 1; i <= runLength; i++) {
    rows.push({ kind: "reasoning", id: `r${i}`, turnId: TURN, text: `step ${i}`, ts: 1 + i });
  }
  rows.push({ id: "A", role: "agent", text: "because", ts: 2 + runLength });
  return rows;
}

/** The turn-local tool id the two turns below both mint. */
const REPEATED_TOOL_ID = "tool-activity-1";
const TURN_B = "t2";

/**
 * A projection in which ONE tool id appears in TWO turns, with rows only that
 * span contains between them.
 *
 * `m1`/`m2` are the payload of the test: they exist nowhere else, so if a page
 * anchored at the older match is served, they are exactly what goes missing.
 */
function projectionWithRepeatedToolId(): ProjectedHistoryMessage[] {
  const toolRow = (turnId: string, ts: number): ProjectedHistoryMessage => ({
    kind: "tool",
    id: REPEATED_TOOL_ID,
    turnId,
    name: "read_file",
    phase: "end",
    status: "completed",
    argKeys: ["path"],
    ts,
  });
  return [
    { id: "u0", role: "user", text: "why?", ts: 1 },
    toolRow(TURN, 2),
    { id: "m1", role: "agent", text: "first", ts: 3 },
    { id: "m2", role: "agent", text: "second", ts: 4 },
    toolRow(TURN_B, 5),
    { id: "A", role: "agent", text: "because", ts: 6 },
  ];
}

/**
 * Where each row the client holds sits in the projection — `-1` if nowhere.
 *
 * ⚠️ TOOL ROWS ARE LOCATED BY THE PAIR `(turnId, id)`, which is the whole point:
 * an id-keyed lookup here would map both turns' calls to the same slot and hide
 * the very ambiguity under test.
 */
function projectionSpan(
  projection: readonly ProjectedHistoryMessage[],
  client: WebChannelNATSClient,
): number[] {
  return client.getState().messages.map((m: ChatMessage) =>
    projection.findIndex((p) =>
      p.kind === "tool" || m.kind === "tool"
        ? p.kind === "tool" &&
          m.kind === "tool" &&
          p.id === m.id &&
          p.turnId === m.turnId
        : p.kind === m.kind && p.id === m.id,
    ),
  );
}

describe('"load older" reaches the start of the conversation', () => {
  it("makes progress past a reasoning run LONGER than one page", () => {
    // ⚠️ THE REGRESSION TEST. With a cursor pick that skips reasoning rows, the
    // oldest CURSORABLE entry stays `A` forever once the twenty rows before it
    // are all reasoning: every click re-serves the same page, every row tier-1
    // matches, nothing moves, and `u0` is unreachable. Measured before the fix:
    //
    //   click 1: cursor=A page=[r11..r30]  rows 1 -> 21
    //   click 2: cursor=A page=[r11..r30]  rows 21 -> 21
    //   click 3..5: identical.  u0 ever reached? false
    //
    // (The first line read "rows 20 -> 21". The device holds exactly ONE row
    // before the first click — the `agent_message` below — so 1 -> 21 is the
    // only arithmetic this fixture supports: 1 held + 20 served.)
    const projection = projectionWithReasoningRun(30);
    const client = newClient();
    // The device has watched the live turn's last answer and nothing else.
    deliver(client, { type: "agent_message", id: "A", turnId: TURN, text: "because" });

    const cursors: Array<string | undefined> = [];
    for (let click = 0; click < 5; click++) {
      cursors.push(clickLoadOlder(client, projection).cursor);
      if (ids(client).includes("u0")) break;
    }

    expect(ids(client)).toContain("u0");
    // Non-vacuity: the cursor must actually MOVE. A test that only checked the
    // final contents would pass on a single lucky page and miss a stall that
    // begins one page later.
    expect(new Set(cursors).size).toBeGreaterThan(1);
    // And the whole conversation is present, in order, exactly once.
    expect(ids(client)).toEqual(projection.map((m) => m.id));
  });

  it("the run length that stalls is exactly `limit` — the cliff, with its control", () => {
    // A run of `limit - 1` leaves one bubble inside the first page, so even a
    // reasoning-skipping cursor advances. The defect only appears at `limit`.
    //
    // ⚠️ THE TWO LEGS ARE NOT SYMMETRIC, AND THE TITLE USED TO IMPLY THEY WERE.
    // Only the `WIDGET_LIMIT` leg carries regression value: it is the one that
    // goes red under a reasoning-skipping picker. The `WIDGET_LIMIT - 1` leg
    // passes under the BUGGY picker too — that is precisely what makes it a
    // CONTROL rather than a second assertion. It is what locates the cliff at
    // `limit` instead of somewhere below it; without it, a failure at
    // `WIDGET_LIMIT` would not tell you the boundary.
    //
    // This also said "a future page-size change cannot silently move the cliff
    // without moving this test", which was false while `WIDGET_LIMIT` was a
    // literal copied from the widget. It is now IMPORTED (see its declaration),
    // so the sentence holds: change the page size and both legs follow.
    for (const runLength of [WIDGET_LIMIT - 1, WIDGET_LIMIT]) {
      const projection = projectionWithReasoningRun(runLength);
      const client = newClient();
      deliver(client, { type: "agent_message", id: "A", turnId: TURN, text: "because" });
      for (let click = 0; click < 5 && !ids(client).includes("u0"); click++) {
        clickLoadOlder(client, projection);
      }
      expect(ids(client), `run length ${runLength}`).toContain("u0");
    }
  });

  it("a reasoning id IS a resolvable cursor — the property the fix rests on", () => {
    // Verified against the REAL pager rather than assumed: `historyPageBefore`
    // resolves by `findIndex` over the emitted list and never reads `kind`, so a
    // plugin-minted reasoning id pages exactly like a bubble id.
    const projection = projectionWithReasoningRun(3);
    expect(historyPageBefore(projection, "r2", 10).map((m) => m.id)).toEqual(["u0", "r1"]);
    // The honest miss is unchanged, and it is not new to reasoning: a published
    // local user echo keeps its `u-<n>` id (the accept seam journals the inbound
    // WIRE id), so the client has always been able to hold an id the journal
    // does not serve.
    expect(historyPageBefore(projection, "u-0", 10)).toEqual([]);
  });

  it("an AMBIGUOUS tool cursor never silently skips the rows between the two matches", () => {
    // ⚠️ THE REGRESSION TEST FOR THE THIRD CURSOR OUTCOME (#242 half 3). Tool ids
    // are TURN-LOCAL — `createAgentToolActivitySink` is built per inbound turn, so
    // the correlation's sequence restarts and mints `tool-activity-1` again — while
    // the paging cursor carries an ID ALONE. Resolving it with a bare `findIndex`
    // picks the OLDER match and serves the slice ending THERE, so everything
    // between the two matches is skipped and the client renders one continuous
    // conversation with no gap marker. Measured before the guard:
    //
    //   click 1: cursor="tool-activity-1"  page=["u0"]   <- resolved to the OLDER match
    //   click 2..5: cursor="u0"            page=[]
    //   final client transcript: ["u0","tool-activity-1","A"]   (m1, m2 unreachable)
    //
    // A dropped RANGE that looks contiguous is worse than an honest stop (N10),
    // so `historyPageBefore` refuses an ambiguous cursor exactly as it refuses one
    // that is not in the projection at all.
    const projection = projectionWithRepeatedToolId();
    const client = newClient();
    // The device watched the SECOND turn live: the tool call, then the answer.
    deliver(client, {
      type: "tool_activity",
      id: REPEATED_TOOL_ID,
      turnId: TURN_B,
      name: "read_file",
      phase: "start",
      argKeys: ["path"],
    });
    deliver(client, {
      type: "tool_activity",
      id: REPEATED_TOOL_ID,
      turnId: TURN_B,
      phase: "end",
      status: "completed",
    });
    deliver(client, { type: "agent_message", id: "A", turnId: TURN_B, text: "because" });

    // Non-vacuity: the widget really does hand us the AMBIGUOUS id. If the picker
    // ever stops choosing it this test would pass while measuring nothing — and
    // making it stop is itself forbidden (skipping tool rows reinstates the
    // deadlock the cases above pin).
    const first = clickLoadOlder(client, projection);
    expect(first.cursor).toBe(REPEATED_TOOL_ID);
    for (let click = 0; click < 4; click++) clickLoadOlder(client, projection);

    // The property: whatever the client ends up holding is a CONTIGUOUS span of
    // the projection. `["u0", tool, "A"]` — the first row plus the last two, with
    // `m1`/`m2` missing and nothing marking the hole — is the corruption.
    const span = projectionSpan(projection, client);
    // Every held row is a projection row (an unlocatable one would make the
    // contiguity check vacuous rather than false).
    expect(span.every((i) => i >= 0)).toBe(true);
    expect(span).toEqual(span.map((_, k) => span[0] + k));
  });

  it("`historyPageBefore` resolves an ambiguous cursor to no page at all", () => {
    // The unit-level statement of the same rule, against the real pager: a
    // duplicated id is UNRESOLVABLE, which is the empty page a miss already gets.
    // The guard is not tool-specific — it fires on any repeated id — but tool is
    // the kind that makes repetition ordinary.
    const projection = projectionWithRepeatedToolId();
    expect(historyPageBefore(projection, REPEATED_TOOL_ID, 20)).toEqual([]);
    // Control: a unique id in the SAME projection still pages normally, so the
    // guard is not simply refusing everything.
    expect(historyPageBefore(projection, "m2", 20).map((m) => m.id)).toEqual([
      "u0",
      REPEATED_TOOL_ID,
      "m1",
    ]);
  });

  it("still refuses a held or retracted bubble as the cursor (P1-9)", () => {
    // The exclusion that is real: those ids were never on the wire and are never
    // in the journal, so sending one asks for a page the server cannot resolve.
    const held: ChatMessage[] = [
      { id: "u-1", role: "user", text: "queued", pending: true },
      { id: "u-2", role: "user", text: "not sent", retracted: true },
      { id: "A", role: "agent", text: "answer" },
    ];
    expect(oldestHistoryCursor(held)).toBe("A");
    // A live progress draft is skipped for the same reason.
    expect(
      oldestHistoryCursor([
        { id: "B", role: "agent", text: "Working…", working: true, draftOnly: true },
        { id: "A", role: "agent", text: "answer" },
      ]),
    ).toBe("A");
    // A reasoning row is NOT skipped — see the stall cases above.
    expect(
      oldestHistoryCursor([
        { kind: "reasoning", id: "r1", turnId: TURN, text: "thinking" },
        { id: "A", role: "agent", text: "answer" },
      ]),
    ).toBe("r1");
  });
});
