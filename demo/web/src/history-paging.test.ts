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

import { oldestHistoryCursor } from "./presentation.js";

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

/** The widget's own page size (`widget.ts`'s `historyBtn.onclick`). */
const WIDGET_LIMIT = 20;

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

describe('"load older" reaches the start of the conversation', () => {
  it("makes progress past a reasoning run LONGER than one page", () => {
    // ⚠️ THE REGRESSION TEST. With a cursor pick that skips reasoning rows, the
    // oldest CURSORABLE entry stays `A` forever once the twenty rows before it
    // are all reasoning: every click re-serves the same page, every row tier-1
    // matches, nothing moves, and `u0` is unreachable. Measured before the fix:
    //
    //   click 1: cursor=A page=[r11..r30]  rows 20 -> 21
    //   click 2: cursor=A page=[r11..r30]  rows 21 -> 21
    //   click 3..5: identical.  u0 ever reached? false
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

  it("the run length that stalls is exactly `limit`, so the boundary is pinned", () => {
    // A run of `limit - 1` leaves one bubble inside the first page, so even a
    // reasoning-skipping cursor advances. The defect only appears at `limit`.
    // Both directions are asserted so a future page-size change cannot silently
    // move the cliff without moving this test.
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
