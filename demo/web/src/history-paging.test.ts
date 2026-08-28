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

/** The cursor identity the picker returns — `turnId` set for a tool row only. */
type Cursor = { id: string; turnId?: string } | undefined;

/**
 * A cursor as a comparable VALUE.
 *
 * ⚠️ IT EXISTS SO THE "THE CURSOR MOVED" CHECKS STAY NON-VACUOUS. #320 turned
 * the picker's return into an object, and `new Set([...objects]).size` counts
 * IDENTITIES — every click would look like a new cursor and a total stall would
 * pass. Comparing the flattened pair is what actually measures movement.
 */
function cursorKey(cursor: Cursor): string {
  return cursor === undefined ? "<none>" : `${cursor.turnId ?? "-"}/${cursor.id}`;
}

/**
 * One "load older" click: pick the cursor the way the widget does, serve the
 * page the way the plugin does, merge it the way the client does.
 *
 * Both halves of the cursor travel, exactly as `widget.ts` sends them — an
 * id-only call here would test a wire the widget no longer speaks.
 */
function clickLoadOlder(
  client: WebChannelNATSClient,
  projection: readonly ProjectedHistoryMessage[],
): { cursor: Cursor; page: string[] } {
  const cursor = oldestHistoryCursor(client.getState().messages);
  const page =
    cursor === undefined
      ? []
      : historyPageBefore(projection, cursor.id, WIDGET_LIMIT, cursor.turnId);
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

    const cursors: string[] = [];
    for (let click = 0; click < 5; click++) {
      cursors.push(cursorKey(clickLoadOlder(client, projection).cursor));
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
    // resolves by `findIndex` over the emitted list with no policy branch on
    // `kind`, so a plugin-minted reasoning id pages exactly like a bubble id —
    // and it does so from an ID ALONE, which is why the picker sends no `turnId`
    // for one (#320).
    const projection = projectionWithReasoningRun(3);
    expect(historyPageBefore(projection, "r2", 10).map((m) => m.id)).toEqual(["u0", "r1"]);
    // The honest miss is unchanged, and it is not new to reasoning: a published
    // local user echo keeps its `u-<n>` id (the accept seam journals the inbound
    // WIRE id), so the client has always been able to hold an id the journal
    // does not serve.
    expect(historyPageBefore(projection, "u-0", 10)).toEqual([]);
  });

  it("a REPEATED tool id is paged past, not stopped at — the composite cursor (#320)", () => {
    // ⚠️ THE REGRESSION TEST FOR THE TOOL CURSOR. Tool ids are TURN-LOCAL on BOTH
    // paths — `createAgentToolActivitySink` is built per inbound turn, so the
    // generated sequence restarts and can mint `tool-activity-1` again in a turn
    // that took the id-less path, and an upstream `toolCallId`/`itemId` is
    // documented run-local too. So one ID can name two rows, and the two wrong
    // answers to that are both measured facts of this fixture:
    //
    //   bare `findIndex` (no guard):  click 1 served ["u0"] anchored at the OLDER
    //     match, m1/m2 skipped with no gap marker — a dropped RANGE (N10).
    //   id-only cursor + guard (#242 half 3): every click answered [], the cursor
    //     never left "tool-activity-1", and u0/m1/m2 were UNREACHABLE. Honest,
    //     but a paging stop — the base regression this test now pins closed.
    //
    // The cursor carries the PAIR `(turnId, id)` — the identity `applyTool`
    // already keys on — so the anchor resolves to the row the client actually
    // holds and paging continues.
    //
    // ⚠️ REACHABILITY IS THE PROPERTY, NOT CONTIGUITY. An earlier revision of this
    // test asserted only that the held span was contiguous, which SERVING NOTHING
    // satisfies — that is exactly how it stayed green across the stall. The
    // assertions below are about which rows ARRIVED.
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

    // Non-vacuity: the widget really does hand us the REPEATED id, paired with
    // the turn the device actually watched. If the picker ever stopped choosing
    // it this test would pass while measuring nothing — and making it stop is
    // itself forbidden (skipping tool rows reinstates the deadlock the cases
    // above pin).
    const first = clickLoadOlder(client, projection);
    expect(first.cursor).toEqual({ id: REPEATED_TOOL_ID, turnId: TURN_B });

    // ── (a) REACHABILITY — the page ARRIVED, and it is the right one. ──
    // Anchored at the SECOND turn's row, so the four older rows come back. A
    // page of `[]` (the stall) or of `["u0"]` (the older-match mis-anchor) both
    // fail here, which is what distinguishes this from the contiguity check.
    expect(first.page).toEqual(["u0", REPEATED_TOOL_ID, "m1", "m2"]);

    const clicks = [first];
    for (let click = 0; click < 4 && !ids(client).includes("u0"); click++) {
      clicks.push(clickLoadOlder(client, projection));
    }
    // The start of the conversation is reached, and `m1`/`m2` — which exist
    // nowhere but that span — are held. Whole projection, in order, once each.
    expect(ids(client)).toContain("u0");
    expect(ids(client)).toEqual(projection.map((m) => m.id));

    // One click was enough — recorded, because a fix that needed five would be a
    // different behaviour wearing the same green.
    expect(clicks).toHaveLength(1);
    // The cursor MOVED off the repeated id (compared by value — see `cursorKey`).
    const afterwards = clickLoadOlder(client, projection);
    expect(cursorKey(afterwards.cursor)).not.toBe(cursorKey(first.cursor));
    // And the top of the conversation is an honest stop, not a loop.
    expect(afterwards.page).toEqual([]);

    // ── (b) CONTIGUITY — retained, as the weaker companion property. It cannot
    //     substitute for (a): serving nothing satisfies it too.
    const span = projectionSpan(projection, client);
    // Every held row is a projection row (an unlocatable one would make the
    // contiguity check vacuous rather than false).
    expect(span.every((i) => i >= 0)).toBe(true);
    expect(span).toEqual(span.map((_, k) => span[0] + k));
  });

  it("an OLDER PEER — `before` alone, no `beforeTurnId` — gets exactly today's behaviour", () => {
    // ⚠️ THE WIRE-ADDITIVITY CLAIM, MEASURED RATHER THAN ASSERTED. `beforeTurnId`
    // is optional on the wire, so a peer that predates #320 sends the id-only
    // cursor — which is the 3-argument call below. It must resolve exactly as it
    // did before this slice: the ambiguity guard fires and the page is empty.
    // (Honest, and still a stop — that is precisely why the CLIENT was taught to
    // send the pair rather than the server taught to guess.)
    const projection = projectionWithRepeatedToolId();
    expect(historyPageBefore(projection, REPEATED_TOOL_ID, 20)).toEqual([]);
    // An explicitly-undefined 4th argument is the same request, not a third case.
    expect(historyPageBefore(projection, REPEATED_TOOL_ID, 20, undefined)).toEqual([]);
    // Control: a unique id in the SAME projection still pages normally, so the
    // guard is not simply refusing everything.
    expect(historyPageBefore(projection, "m2", 20).map((m) => m.id)).toEqual([
      "u0",
      REPEATED_TOOL_ID,
      "m1",
    ]);

    // And the composite is what changes the answer — both turns resolve, each to
    // its own anchor. This is the pair of cases the id-only cursor cannot express.
    expect(historyPageBefore(projection, REPEATED_TOOL_ID, 20, TURN).map((m) => m.id)).toEqual([
      "u0",
    ]);
    expect(historyPageBefore(projection, REPEATED_TOOL_ID, 20, TURN_B).map((m) => m.id)).toEqual([
      "u0",
      REPEATED_TOOL_ID,
      "m1",
      "m2",
    ]);
    // A pair naming no row is the ordinary honest miss, like an unknown id.
    expect(historyPageBefore(projection, REPEATED_TOOL_ID, 20, "t-absent")).toEqual([]);
    // A `turnId` against a row that HAS none (the text variant carries no such
    // field) is a miss too, not an accidental match on `undefined`.
    expect(historyPageBefore(projection, "m2", 20, TURN_B)).toEqual([]);
  });

  it("still refuses a held or retracted bubble as the cursor (P1-9)", () => {
    // The exclusion that is real: those ids were never on the wire and are never
    // in the journal, so sending one asks for a page the server cannot resolve.
    const held: ChatMessage[] = [
      { id: "u-1", role: "user", text: "queued", pending: true },
      { id: "u-2", role: "user", text: "not sent", retracted: true },
      { id: "A", role: "agent", text: "answer" },
    ];
    expect(oldestHistoryCursor(held)).toEqual({ id: "A" });
    // A live progress draft is skipped for the same reason.
    expect(
      oldestHistoryCursor([
        { id: "B", role: "agent", text: "Working…", working: true, draftOnly: true },
        { id: "A", role: "agent", text: "answer" },
      ]),
    ).toEqual({ id: "A" });
    // A reasoning row is NOT skipped — see the stall cases above.
    expect(
      oldestHistoryCursor([
        { kind: "reasoning", id: "r1", turnId: TURN, text: "thinking" },
        { id: "A", role: "agent", text: "answer" },
      ]),
    ).toEqual({ id: "r1" });
  });

  it("`turnId` rides the cursor for a TOOL row and for nothing else (#320)", () => {
    // The picker returns an IDENTITY. A tool row is addressed by the pair, so
    // both halves travel.
    expect(
      oldestHistoryCursor([
        {
          kind: "tool",
          id: REPEATED_TOOL_ID,
          turnId: TURN_B,
          name: "read_file",
          phase: "end",
          status: "completed",
        },
        { id: "A", role: "agent", text: "answer" },
      ]),
    ).toEqual({ id: REPEATED_TOOL_ID, turnId: TURN_B });

    // ⚠️ A REASONING ROW CARRIES A `turnId` TOO AND STILL MUST NOT PAIR IT. Its id
    // is `nextMessageId()`-minted and globally unique, so pairing disambiguates
    // nothing while adding a second field the projection must agree with for the
    // cursor to resolve at all. `toEqual` would pass on a stray `turnId`
    // (undefined-valued keys are ignored), so this is checked as a property.
    const reasoning = oldestHistoryCursor([
      { kind: "reasoning", id: "r1", turnId: TURN, text: "thinking" },
      { id: "A", role: "agent", text: "answer" },
    ]);
    expect(reasoning?.turnId).toBeUndefined();
    // A plain bubble has no `turnId` field at all in `ChatMessage`'s text arm.
    expect(
      oldestHistoryCursor([{ id: "A", role: "agent", text: "answer" }])?.turnId,
    ).toBeUndefined();
  });
});
