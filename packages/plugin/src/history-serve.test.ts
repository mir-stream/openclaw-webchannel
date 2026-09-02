/**
 * `history-serve.ts` — the live history read path, driven for real.
 *
 * ⚠️ WHY THIS FILE EXISTS, AND WHAT IT REPLACED. Both read bodies used to be
 * closures inside `buildNatsAccount`, so the only "coverage" they had was a hand
 * TRANSCRIPTION in `session-route-tenant-isolation.test.ts`. MEASURED: changing
 * the production call from `serveHistoryRequest(journal.read, peerId, …)` to
 * `…, accountId, …` — which lets every peer under one `(tenant, accountId)` read
 * every other peer's conversation — left all 21 tests in that file GREEN. These
 * tests call `createHistoryServer` itself, against a real `openDeliveryJournal`
 * in a temp dir, so that mutation now fails here
 * ("serves ONLY the requesting peer's rows").
 *
 * The scheduler is INJECTED throughout rather than awaited. Production passes
 * `setImmediate`; every test here passes a manual queue, so "the fold does not
 * run on the calling turn" and "a second request while one is in flight is
 * dropped" are asserted deterministically instead of raced.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { openDeliveryJournal, type DeliveryJournal } from "./delivery-journal.js";
import type { JournalEvent } from "./delivery-journal-event.js";
import { DEFAULT_HISTORY_CONFIG, type HistoryMessage } from "./history.js";
import {
  createHistoryServer,
  type HistoryChannelSurface,
  type HistoryServerDeps,
} from "./history-serve.js";

const PEER = "peer-a";
const OTHER_PEER = "peer-b";
const T0 = 1_000_000;
const T_STEP = 10;

const openJournals: DeliveryJournal[] = [];
const tempRoots: string[] = [];

afterEach(() => {
  while (openJournals.length > 0) {
    try {
      openJournals.pop()!.close();
    } catch {
      // A test that closed a handle on purpose must not fail the teardown.
    }
  }
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop()!, { recursive: true, force: true });
  }
});

/** A real journal in its own tmpdir, pinned clock so `ts` is assertable. */
function openJournal(): DeliveryJournal {
  const root = mkdtempSync(join(tmpdir(), "webchannel-history-serve-"));
  tempRoots.push(root);
  let tick = 0;
  const journal = openDeliveryJournal({
    databasePath: join(root, "tuple", "delivery-journal.sqlite"),
    now: () => T0 + tick++ * T_STEP,
  });
  openJournals.push(journal);
  return journal;
}

/** A user/agent/user thread for one peer, ids prefixed so peers are separable. */
function thread(prefix: string): JournalEvent[] {
  return [
    { kind: "user", id: `${prefix}1`, text: `${prefix} question`, turnId: `w-${prefix}` },
    {
      kind: "bubble",
      answerId: `${prefix}2`,
      turnId: `turn-${prefix}`,
      text: `${prefix} answer`,
    },
    { kind: "user", id: `${prefix}3`, text: `${prefix} follow-up`, turnId: `w2-${prefix}` },
  ];
}

/**
 * Records every `sendHistory` call; returns `true` like the real channel.
 *
 * #311 widened the surface with the two measurement members. They are answered
 * in PLAINTEXT against a limit nothing in this file approaches, so every page
 * takes the budget's fast path and arrives whole — which is what keeps the
 * assertions below about scoping, deferral and diagnostics rather than bytes.
 * The byte behaviour has its own two files (`history-frame-budget.test.ts`,
 * `history-frame-oversize.test.ts`).
 */
function recordingChannel(limit = 8 * 1024 * 1024): {
  channel: HistoryChannelSurface;
  sent: Array<{ peerId: string; messages: HistoryMessage[]; highWaterSeq?: number }>;
  // #244 half B: the `difference` frames the serve path emitted.
  differences: Array<{ peerId: string; events: Array<{ seq: number; event: unknown }> }>;
} {
  const sent: Array<{ peerId: string; messages: HistoryMessage[]; highWaterSeq?: number }> = [];
  const differences: Array<{ peerId: string; events: Array<{ seq: number; event: unknown }> }> = [];
  return {
    sent,
    differences,
    channel: {
      // #244 half A: capture the high-water baseline the snapshot path stamps.
      sendHistory(peerId: string, messages: HistoryMessage[], highWaterSeq?: number) {
        sent.push({ peerId, messages, highWaterSeq });
        return true;
      },
      sendDifference(peerId, events) {
        differences.push({ peerId, events });
        return true;
      },
      outboundWireSize: (_peerId, payload) =>
        Buffer.byteLength(JSON.stringify(payload), "utf8"),
      effectiveOutboundLimit: () => limit,
    },
  };
}

/** A manual scheduler: nothing runs until `flush()` is called. */
function manualScheduler(): {
  schedule: (fn: () => void) => void;
  pending: number;
  flush: () => number;
} {
  const queue: Array<() => void> = [];
  return {
    schedule: (fn) => void queue.push(fn),
    get pending() {
      return queue.length;
    },
    flush() {
      let ran = 0;
      while (queue.length > 0) {
        queue.shift()!();
        ran += 1;
      }
      return ran;
    },
  };
}

function harness(
  journal: DeliveryJournal,
  overrides: Partial<HistoryServerDeps> = {},
  channelLimit?: number,
) {
  const { channel, sent, differences } = recordingChannel(channelLimit);
  const scheduler = manualScheduler();
  const errors: string[] = [];
  const warns: string[] = [];
  const server = createHistoryServer({
    journal,
    channel,
    config: DEFAULT_HISTORY_CONFIG,
    logger: {
      error: (m) => void errors.push(m),
      warn: (m) => void warns.push(m),
    },
    schedule: scheduler.schedule,
    ...overrides,
  });
  return { server, sent, differences, scheduler, errors, warns };
}

describe("createHistoryServer — peer scoping (the assertion the old test could not make)", () => {
  it("serves ONLY the requesting peer's rows, from a journal holding two peers", () => {
    const journal = openJournal();
    for (const event of thread("a")) journal.append(PEER, event);
    for (const event of thread("b")) journal.append(OTHER_PEER, event);

    const { server, sent, scheduler } = harness(journal);
    server.sendSnapshot(PEER);
    scheduler.flush();

    // ⚠️ THE MUTATION GUARD. If production passed `accountId` — or any id that
    // is not this peer — instead of `peerId`, this is what goes red.
    expect(sent).toHaveLength(1);
    expect(sent[0].peerId).toBe(PEER);
    expect(sent[0].messages.map((m) => m.id)).toEqual(["a1", "a2", "a3"]);

    // CONTROL: the other peer's rows really are in this file and really are
    // reachable — so the assertion above is a scope, not an empty harness.
    server.sendSnapshot(OTHER_PEER);
    scheduler.flush();
    expect(sent[1].messages.map((m) => m.id)).toEqual(["b1", "b2", "b3"]);
  });

  it("cannot be paged into another peer's rows with THEIR cursor", () => {
    const journal = openJournal();
    for (const event of thread("a")) journal.append(PEER, event);
    for (const event of thread("b")) journal.append(OTHER_PEER, event);

    const { server, sent, scheduler } = harness(journal);
    // `b3` is a real id in this file, owned by the other peer.
    server.servePage(PEER, { before: "b3" });
    scheduler.flush();
    expect(sent[0].messages).toEqual([]);

    // CONTROL: read as its owner, the same cursor pages normally.
    server.servePage(OTHER_PEER, { before: "b3" });
    scheduler.flush();
    expect(sent[1].messages.map((m) => m.id)).toEqual(["b1", "b2"]);
  });
});

describe("createHistoryServer — #244 half A snapshot high-water", () => {
  it("stamps the SNAPSHOT with highWaterSeq = the conversation's MAX(seq)", () => {
    const journal = openJournal();
    for (const event of thread("a")) journal.append(PEER, event);
    // A durable egress frame after the thread advances the seq further, so the
    // high-water is NOT just the count of served rows — it is the journal max.
    journal.append(PEER, { kind: "bubble", answerId: "a9", text: "later", turnId: "turn-a" });

    const { server, sent, scheduler } = harness(journal);
    server.sendSnapshot(PEER);
    scheduler.flush();

    expect(sent).toHaveLength(1);
    // Four rows written ⇒ MAX(seq) is 4, and that is the authoritative baseline
    // the client resumes gap detection from — independent of how many rows the
    // windowed snapshot actually carried.
    expect(journal.maxSeq(PEER)).toBe(4);
    expect(sent[0].highWaterSeq).toBe(4);
  });

  it("carries NO highWaterSeq on a load_history PAGE (older rows, not the baseline)", () => {
    const journal = openJournal();
    for (const event of thread("a")) journal.append(PEER, event);

    const { server, sent, scheduler } = harness(journal);
    // A tail page still carries no high-water — only the register-time snapshot
    // is the authoritative baseline.
    server.servePage(PEER, {});
    scheduler.flush();

    expect(sent).toHaveLength(1);
    expect(sent[0].highWaterSeq).toBeUndefined();
  });
});

describe("createHistoryServer — deferral", () => {
  it("does nothing on the calling turn; the scheduler owns the fold", () => {
    const journal = openJournal();
    for (const event of thread("a")) journal.append(PEER, event);
    const { server, sent, scheduler } = harness(journal);

    server.sendSnapshot(PEER);
    server.servePage(PEER, {});
    // Both scheduled, neither run: `nats-register.ts` publishes its register
    // reply between these two lines in production.
    expect(scheduler.pending).toBe(2);
    expect(sent).toEqual([]);

    expect(scheduler.flush()).toBe(2);
    expect(sent).toHaveLength(2);
  });

  it("defaults to setImmediate when no scheduler is injected", async () => {
    const journal = openJournal();
    for (const event of thread("a")) journal.append(PEER, event);
    const { channel, sent } = recordingChannel();
    const server = createHistoryServer({
      journal,
      channel,
      config: DEFAULT_HISTORY_CONFIG,
    });

    server.sendSnapshot(PEER);
    expect(sent).toEqual([]);
    await new Promise((r) => setImmediate(r));
    expect(sent).toHaveLength(1);
  });
});

describe("createHistoryServer — plan dispatch and empty results", () => {
  it("routes a cursor to the page selector and no cursor to the tail", () => {
    const journal = openJournal();
    for (const event of thread("a")) journal.append(PEER, event);
    const { server, sent, scheduler } = harness(journal);

    // Flushed BETWEEN the two: back-to-back page requests for one peer are
    // deliberately dropped by the in-flight latch, so a sequential client is
    // what this test has to model.
    server.servePage(PEER, { before: "a3" });
    scheduler.flush();
    server.servePage(PEER, {});
    scheduler.flush();

    expect(sent[0].messages.map((m) => m.id)).toEqual(["a1", "a2"]);
    expect(sent[1].messages.map((m) => m.id)).toEqual(["a1", "a2", "a3"]);
  });

  it("honours the configured limits on both paths", () => {
    const journal = openJournal();
    for (let i = 0; i < 10; i++) {
      journal.append(PEER, { kind: "user", id: `u-${i}`, text: `m${i}` });
    }
    const { server, sent, scheduler } = harness(journal, {
      config: { limit: 2, pageSize: 3 },
    });

    server.sendSnapshot(PEER);
    server.servePage(PEER, { before: "u-9" });
    scheduler.flush();

    // `limit` drives the snapshot tail; `pageSize` drives an unspecified page.
    expect(sent[0].messages.map((m) => m.id)).toEqual(["u-8", "u-9"]);
    expect(sent[1].messages.map((m) => m.id)).toEqual(["u-6", "u-7", "u-8"]);
  });

  it("SUPPRESSES an empty snapshot but SENDS an empty page", () => {
    // The asymmetry is deliberate. An empty snapshot is nothing to hydrate. An
    // empty page is still an ANSWER — a no-op for our own client (its
    // `case "history"` returns early on a zero-length list and `loadHistory`
    // keeps no pending state to clear), and the end-of-history signal for a
    // third-party client that tracks its request. Sending nothing is worse for
    // both.
    const journal = openJournal();
    const { server, sent, scheduler } = harness(journal);

    server.sendSnapshot("peer-who-never-spoke");
    scheduler.flush();
    expect(sent).toEqual([]);

    server.servePage("peer-who-never-spoke", {});
    scheduler.flush();
    expect(sent).toHaveLength(1);
    expect(sent[0].messages).toEqual([]);
  });
});

describe("createHistoryServer — the COMPOSITE cursor, end to end (#320)", () => {
  const TOOL_ID = "tool-activity-1";
  const TURN_A = "turn-a";
  const TURN_B = "turn-b";

  /**
   * ⚠️ WHAT THIS COVERS, AND WHERE IT STARTS. `beforeTurnId` crosses five hops on
   * this side — `nats-channel.ts` → `servePage` → `planHistoryFetch` →
   * `serveHistoryRequest` → `historyPageBefore` — and every existing test
   * touched only the last one, directly, with a positional argument.
   *
   * This body enters at `servePage`, so it pins hops 2 THROUGH 5, through the
   * real `createHistoryServer` against a real journal. It does NOT reach hop 1:
   * `nats-channel.ts`'s inbound `load_history` dispatch is pinned separately, by
   * `nats-channel-typing.test.ts`'s `#320` case. (An earlier revision of this
   * paragraph listed the five hops and then claimed "this pins the rest", which
   * read as covering all four of the ones `history.test.ts` does not — it never
   * touched the transport hop.) `history.test.ts` pins the plan hop on its own.
   * Between the three files every plugin-side hop goes red when it stops
   * forwarding the field, instead of degrading the tool cursor back to id-only
   * in production.
   *
   * ONE tool id in TWO turns, with rows only that span contains between them:
   * `m1`/`m2` exist nowhere else, so a page anchored at the OLDER match is
   * exactly what loses them.
   */
  function repeatedToolThread(journal: DeliveryJournal): void {
    const toolRow = (turnId: string): JournalEvent => ({
      kind: "tool",
      id: TOOL_ID,
      turnId,
      name: "read_file",
      phase: "end",
      status: "completed",
      argKeys: ["path"],
    });
    journal.append(PEER, { kind: "user", id: "u0", text: "why?", turnId: "w-u0" });
    journal.append(PEER, toolRow(TURN_A));
    journal.append(PEER, { kind: "bubble", answerId: "m1", text: "first", turnId: TURN_A });
    journal.append(PEER, { kind: "bubble", answerId: "m2", text: "second", turnId: TURN_A });
    journal.append(PEER, toolRow(TURN_B));
    journal.append(PEER, { kind: "bubble", answerId: "A", text: "because", turnId: TURN_B });
  }

  it("anchors the page at the NAMED turn's row, where an id-only cursor gets nothing", () => {
    const journal = openJournal();
    repeatedToolThread(journal);
    const { server, sent, scheduler } = harness(journal);

    // Flushed between requests: back-to-back pages for one peer are dropped by
    // the in-flight latch, so a sequential client is what this has to model.
    server.servePage(PEER, { before: TOOL_ID, beforeTurnId: TURN_B });
    scheduler.flush();
    expect(sent[0].messages.map((m) => m.id)).toEqual(["u0", TOOL_ID, "m1", "m2"]);

    // ⚠️ THE CONTROL THAT MAKES THE LINE ABOVE A MEASUREMENT OF THE PLUMBING
    // RATHER THAN OF THE FIXTURE. The same request WITHOUT the second half is
    // the older peer's id-only cursor: the id names two rows, the ambiguity
    // guard refuses it, and the answer is the empty page. So if any hop drops
    // `beforeTurnId`, the first assertion collapses onto this one.
    server.servePage(PEER, { before: TOOL_ID });
    scheduler.flush();
    expect(sent[1].messages).toEqual([]);

    // And the OTHER turn is a DIFFERENT anchor — the field is COMPARED end to
    // end, not merely carried as far as the selector.
    server.servePage(PEER, { before: TOOL_ID, beforeTurnId: TURN_A });
    scheduler.flush();
    expect(sent[2].messages.map((m) => m.id)).toEqual(["u0"]);

    // A pair naming no row is the ordinary honest miss, like an unknown id.
    server.servePage(PEER, { before: TOOL_ID, beforeTurnId: "turn-absent" });
    scheduler.flush();
    expect(sent[3].messages).toEqual([]);
  });
});

describe("createHistoryServer — read failure sends NO frame", () => {
  /**
   * The production failure named in the code: the account is disposed (journal
   * closed) between scheduling and firing. Uses the real store's own
   * closed-handle throw rather than a stub, so the test cannot pass against a
   * failure shape the store does not actually produce.
   */
  function closedJournalHarness() {
    const journal = openJournal();
    for (const event of thread("a")) journal.append(PEER, event);
    const h = harness(journal);
    return { ...h, journal };
  }

  it("snapshot: logs once at error and never calls sendHistory", () => {
    const { server, sent, scheduler, errors, journal } = closedJournalHarness();
    server.sendSnapshot(PEER);
    journal.close();
    scheduler.flush();

    // ⚠️ NOT an empty frame. With the journal as the only store, `[]` would
    // impersonate an empty conversation to its owner (doc §15.6).
    expect(sent).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("history snapshot journal read failed");
    expect(errors[0]).toContain(PEER);
  });

  it("page: logs once at error and never calls sendHistory", () => {
    const { server, sent, scheduler, errors, journal } = closedJournalHarness();
    server.servePage(PEER, {});
    journal.close();
    scheduler.flush();

    expect(sent).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("history page journal read failed");
  });

  it("releases the in-flight latch after a failure, so the peer can retry", () => {
    // The `finally` matters: without it one transient read failure would latch
    // the peer out of its own history for the life of the process.
    const journal = openJournal();
    for (const event of thread("a")) journal.append(PEER, event);
    const { server, sent, scheduler, errors, warns } = harness(journal, {
      journal: {
        ...journal,
        read: (() => {
          let first = true;
          return (conversationId: string, options?: { afterSeq?: number; limit?: number }) => {
            if (first) {
              first = false;
              throw new Error("transient sqlite fault");
            }
            return journal.read(conversationId, options);
          };
        })(),
      } as DeliveryJournal,
    });

    server.sendSnapshot(PEER);
    scheduler.flush();
    expect(errors).toHaveLength(1);
    expect(sent).toEqual([]);

    server.sendSnapshot(PEER);
    scheduler.flush();
    expect(warns).toEqual([]);
    expect(sent).toHaveLength(1);
    expect(sent[0].messages.map((m) => m.id)).toEqual(["a1", "a2", "a3"]);
  });
});

describe("createHistoryServer — the per-peer in-flight CONCURRENCY bound (not #286)", () => {
  it("drops a concurrent SNAPSHOT for the same peer and warns", () => {
    const journal = openJournal();
    for (const event of thread("a")) journal.append(PEER, event);
    const { server, sent, scheduler, warns } = harness(journal);

    server.sendSnapshot(PEER);
    server.sendSnapshot(PEER); // first is still queued → dropped
    expect(scheduler.pending).toBe(1);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain("history snapshot dropped");
    expect(warns[0]).toContain("suppressed=0");

    scheduler.flush();
    expect(sent).toHaveLength(1);
  });

  it("drops a concurrent PAGE for the same peer and warns", () => {
    const journal = openJournal();
    for (const event of thread("a")) journal.append(PEER, event);
    const { server, sent, scheduler, warns } = harness(journal);

    server.servePage(PEER, {});
    server.servePage(PEER, { before: "a3" });
    expect(scheduler.pending).toBe(1);
    expect(warns[0]).toContain("history page dropped");

    scheduler.flush();
    expect(sent).toHaveLength(1);
  });

  it("⚠️ a page in flight NEVER drops that peer's snapshot (separate latches)", () => {
    // THE reason the bound is two sets rather than one. A page answers with
    // OLDER messages, so a reconnecting tab whose snapshot was dropped behind a
    // page would lose its TAIL and never recover it.
    const journal = openJournal();
    for (const event of thread("a")) journal.append(PEER, event);
    const { server, sent, scheduler, warns } = harness(journal);

    server.servePage(PEER, { before: "a3" });
    server.sendSnapshot(PEER);
    expect(scheduler.pending).toBe(2);
    expect(warns).toEqual([]);

    scheduler.flush();
    expect(sent).toHaveLength(2);
    expect(sent[0].messages.map((m) => m.id)).toEqual(["a1", "a2"]);
    expect(sent[1].messages.map((m) => m.id)).toEqual(["a1", "a2", "a3"]);
  });

  it("bounds per PEER, not globally — another peer is never blocked", () => {
    const journal = openJournal();
    for (const event of thread("a")) journal.append(PEER, event);
    for (const event of thread("b")) journal.append(OTHER_PEER, event);
    const { server, sent, scheduler, warns } = harness(journal);

    server.sendSnapshot(PEER);
    server.sendSnapshot(OTHER_PEER);
    expect(scheduler.pending).toBe(2);
    expect(warns).toEqual([]);
    scheduler.flush();
    expect(sent.map((s) => s.peerId)).toEqual([PEER, OTHER_PEER]);
  });

  it("frees the latch once the fold completes, so the next request runs", () => {
    const journal = openJournal();
    for (const event of thread("a")) journal.append(PEER, event);
    const { server, sent, scheduler, warns } = harness(journal);

    server.sendSnapshot(PEER);
    scheduler.flush();
    server.sendSnapshot(PEER);
    scheduler.flush();

    expect(warns).toEqual([]);
    expect(sent).toHaveLength(2);
  });

  it("throttles the drop warning to one line per window, carrying suppressed=N", () => {
    const journal = openJournal();
    for (const event of thread("a")) journal.append(PEER, event);
    let clock = 0;
    const { server, scheduler, warns } = harness(journal, { now: () => clock });

    server.sendSnapshot(PEER);
    for (let i = 0; i < 5; i++) server.sendSnapshot(PEER);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain("suppressed=0");

    // Past the window, the next drop reports the four it swallowed.
    clock += 60_001;
    server.sendSnapshot(PEER);
    expect(warns).toHaveLength(2);
    expect(warns[1]).toContain("suppressed=4");

    scheduler.flush();
  });
});


describe("createHistoryServer — no depth bound: long conversations still page", () => {
  /**
   * ⚠️ WHAT THIS REPLACED. A pre-fold gate on total conversation length shipped
   * here briefly and was reverted: length is checkable before a fold, DEPTH is
   * not (locating a cursor is the fold), so the gate did not reproduce the
   * deleted 1 000-message wall — it gave any conversation past the threshold a
   * reach of ZERO. These tests pin the reverted behaviour so a "cheap bound"
   * cannot come back without going red. See the module header.
   */
  function seedEvents(journal: DeliveryJournal, peerId: string, count: number): void {
    for (let i = 0; i < count; i++) {
      journal.append(peerId, { kind: "user", id: `u-${i}`, text: `m${i}` });
    }
  }

  it("serves a real page from a conversation far past any plausible bound", () => {
    const journal = openJournal();
    seedEvents(journal, PEER, 2_400);
    const { server, sent, scheduler } = harness(journal);

    server.servePage(PEER, { before: "u-2399" });
    scheduler.flush();

    // A length gate at ~2 000 events answered `[]` here, unreachably.
    expect(sent).toHaveLength(1);
    expect(sent[0].messages).toHaveLength(50);
    expect(sent[0].messages[49].id).toBe("u-2398");
  });

  it("keeps the snapshot whole at the same length", () => {
    const journal = openJournal();
    seedEvents(journal, PEER, 2_400);
    const { server, sent, scheduler } = harness(journal);

    server.sendSnapshot(PEER);
    scheduler.flush();

    expect(sent[0].messages).toHaveLength(50);
    expect(sent[0].messages[49].id).toBe("u-2399");
  });
});

describe("createHistoryServer — a non-authoritative projection is never silent", () => {
  it("logs at error when rows this build cannot fold were skipped", () => {
    // ⚠️ THE ROLLBACK SHAPE, END TO END. #241 widens the event union, rows are
    // written, the release is rolled back: every row is now an unknown kind, the
    // projection is empty, and the snapshot's `length > 0` gate suppresses the
    // frame. Without the counter the peer would see a brand-new empty
    // conversation and NOTHING would be logged anywhere — the same silent
    // empty-session impersonation the failed-read path is forbidden to produce.
    const journal = openJournal();
    for (let i = 0; i < 3; i++) {
      journal.append(PEER, {
        kind: "sticker",
        id: `s-${i}`,
        pack: "cats",
      } as unknown as JournalEvent);
    }
    const { server, sent, scheduler, errors } = harness(journal);

    server.sendSnapshot(PEER);
    scheduler.flush();

    // The frame is still suppressed — that part is unchanged and correct.
    expect(sent).toEqual([]);
    // But it is no longer silent, and the line names the count.
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("projection is NOT authoritative");
    expect(errors[0]).toContain("skipped 3 journal event(s)");
    expect(errors[0]).toContain(PEER);
  });

  it("reports a ts FALLBACK at warn, where an unfoldable row is error", () => {
    // ⚠️ THE LEVELS DIFFER ON PURPOSE. An unsupported event means content is
    // MISSING; a `ts` fallback means a message that IS present was dated from
    // the last row read instead of the row that introduced it. `ts` is hydration
    // metadata nothing orders on, so the blast radius is a timestamp reading
    // early — a real "this build is behind the journal" signal, but not a claim
    // that the user was shown less than they said.
    //
    // Same trigger `journal-history.test.ts` uses: a numeric `answerId` reaches
    // the view (the store validates only USER ids) but `recordFirstSeen`'s
    // `note` skips non-strings, so nothing dates it.
    const journal = openJournal();
    journal.append(PEER, {
      kind: "bubble",
      answerId: 7,
      text: "numeric id",
    } as unknown as JournalEvent);
    const { server, sent, scheduler, errors, warns } = harness(journal);

    server.sendSnapshot(PEER);
    scheduler.flush();

    expect(sent).toHaveLength(1);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain("dated 1 message(s)");
    expect(warns[0]).toContain("timestamps may read early");
    expect(warns[0]).toContain(PEER);
    // Not escalated: nothing is missing.
    expect(errors).toEqual([]);
  });

  it("says nothing when every row folded cleanly", () => {
    const journal = openJournal();
    for (const event of thread("a")) journal.append(PEER, event);
    const { server, sent, scheduler, errors, warns } = harness(journal);

    server.sendSnapshot(PEER);
    scheduler.flush();

    expect(sent).toHaveLength(1);
    expect(errors).toEqual([]);
    expect(warns).toEqual([]);
  });

  it("reports on the PAGE path too, and throttles it", () => {
    const journal = openJournal();
    for (let i = 0; i < 3; i++) {
      journal.append(PEER, { kind: "sticker", id: `s-${i}` } as unknown as JournalEvent);
    }
    let clock = 0;
    const { server, scheduler, errors } = harness(journal, { now: () => clock });

    for (let i = 0; i < 4; i++) {
      server.servePage(PEER, {});
      scheduler.flush();
    }
    expect(errors).toHaveLength(1);

    clock += 60_001;
    server.servePage(PEER, {});
    scheduler.flush();
    expect(errors).toHaveLength(2);
    expect(errors[1]).toContain("suppressed=3");
  });
});

describe("createHistoryServer — a publish failure is not blamed on the journal", () => {
  it("labels a throwing sendHistory as a publish failure, not a read failure", () => {
    // `channel.sendHistory` can throw (the publish path does). Logging that as
    // "journal read failed" points an operator at a database that is fine.
    const journal = openJournal();
    for (const event of thread("a")) journal.append(PEER, event);
    const queue: Array<() => void> = [];
    const errors: string[] = [];
    const server = createHistoryServer({
      journal,
      channel: {
        sendHistory() {
          throw new Error("transport closed");
        },
        sendDifference() {
          throw new Error("transport closed");
        },
        outboundWireSize: (_peerId, payload) =>
          Buffer.byteLength(JSON.stringify(payload), "utf8"),
        effectiveOutboundLimit: () => 8 * 1024 * 1024,
      },
      config: DEFAULT_HISTORY_CONFIG,
      logger: { error: (m) => void errors.push(m) },
      schedule: (fn) => void queue.push(fn),
    });

    server.sendSnapshot(PEER);
    while (queue.length > 0) queue.shift()!();

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("history snapshot publish failed");
    expect(errors[0]).not.toContain("journal read failed");
    expect(errors[0]).toContain("transport closed");
  });
});

// ---------------------------------------------------------------------------
// #244 half B — serveDifference (get_difference catch-up)
// ---------------------------------------------------------------------------
describe("createHistoryServer.serveDifference — #244 half B", () => {
  it("serves RAW events with seq > afterSeq, in seq order, WITHOUT running the reducer", () => {
    const journal = openJournal();
    // thread("a") = [user a1, bubble a2, user a3] → seqs 1, 2, 3.
    const appended = thread("a");
    for (const event of appended) journal.append(PEER, event);

    const { server, differences } = harness(journal);
    server.serveDifference(PEER, 1);

    expect(differences).toHaveLength(1);
    const { peerId, events } = differences[0];
    expect(peerId).toBe(PEER);
    // seq > 1 only: the bubble (seq 2) and the follow-up user (seq 3).
    expect(events.map((e) => e.seq)).toEqual([2, 3]);

    // ⚠️ RAW events, NOT a projected page. A reducer/projection would hand back
    // `HistoryMessage`s — a bubble as `{id, role:"agent", text, ts}`. These are
    // the JOURNAL EVENTS verbatim: a `bubble` with `answerId`, a `user` with
    // `kind`. This is the assertion that proves half B is #286-free.
    expect(events[0].event).toEqual(appended[1]); // { kind:"bubble", answerId:"a2", ... }
    expect(events[1].event).toEqual(appended[2]); // { kind:"user", id:"a3", ... }
    expect((events[0].event as { kind: string }).kind).toBe("bubble");
    expect((events[0].event as { role?: unknown }).role).toBeUndefined();
  });

  it("afterSeq=0 returns the whole journal, oldest first", () => {
    const journal = openJournal();
    for (const event of thread("a")) journal.append(PEER, event);
    const { server, differences } = harness(journal);
    server.serveDifference(PEER, 0);
    expect(differences[0].events.map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it("answers an already-current afterSeq with an EMPTY difference (not silence)", () => {
    // The client's `case "difference"` no-ops the fold and drains its buffer on an
    // empty response; sending nothing would strand a client that buffered.
    const journal = openJournal();
    for (const event of thread("a")) journal.append(PEER, event);
    const { server, differences } = harness(journal);
    server.serveDifference(PEER, 3);
    expect(differences).toHaveLength(1);
    expect(differences[0].events).toEqual([]);
  });

  it("scopes to the requesting peer — never another peer's rows", () => {
    const journal = openJournal();
    for (const event of thread("a")) journal.append(PEER, event);
    for (const event of thread("b")) journal.append(OTHER_PEER, event);
    const { server, differences } = harness(journal);
    server.serveDifference(PEER, 0);
    const ids = differences[0].events.map((e) => {
      const ev = e.event as { answerId?: string; id?: string };
      return ev.answerId ?? ev.id;
    });
    // a's ids only (a1/a2/a3), never b's.
    expect(ids).toEqual(["a1", "a2", "a3"]);
  });

  it("byte-fits an oversize difference to the OLDEST contiguous prefix, re-requestable", () => {
    const journal = openJournal();
    // Ten bubbles → seqs 1..10, each carrying its own text.
    for (let i = 1; i <= 10; i++) {
      journal.append(PEER, {
        kind: "bubble",
        answerId: `a${i}`,
        turnId: `t${i}`,
        text: `answer number ${i} with some padding text`,
      });
    }
    // A tiny limit so the whole set cannot fit — but a single event still can.
    const { server, differences } = harness(journal, {}, 220);
    server.serveDifference(PEER, 0);

    expect(differences).toHaveLength(1);
    const seqs = differences[0].events.map((e) => e.seq);
    // Non-empty (forward progress guaranteed) and the OLDEST prefix (starts at 1).
    expect(seqs.length).toBeGreaterThan(0);
    expect(seqs.length).toBeLessThan(10);
    expect(seqs[0]).toBe(1);
    // Contiguous ascending from 1 — no permutation, no hole.
    expect(seqs).toEqual(seqs.map((_, i) => i + 1));
  });

  it("on a read failure, logs and sends NOTHING (never an empty frame that would falsely advance)", () => {
    const journal = openJournal();
    for (const event of thread("a")) journal.append(PEER, event);
    const { server, differences, errors } = harness(journal);
    // Close the handle so the next read throws (database is not open).
    journal.close();
    server.serveDifference(PEER, 0);
    expect(differences).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("difference read failed");
  });
});
