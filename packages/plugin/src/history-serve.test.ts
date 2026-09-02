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
import type { DifferenceReply } from "./channel-contract.js";
import {
  createHistoryServer,
  MAX_DIFFERENCE_EVENTS,
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
  // #244 half B / #356: the `difference` frames the serve path emitted, with the
  // whole reply body — the echo and the two catch-up signals are as much of the
  // contract as the events are.
  differences: Array<{ peerId: string } & DifferenceReply>;
  /** #348: every `outboundWireSize` call, i.e. every seal the byte fit paid for. */
  measurements: number;
  /**
   * #348: the sum of `events.length` over those calls — the quantity that
   * actually reaches `sealEnvelope`. A call measuring one row and a call
   * measuring 500 are both ONE call and are not the same work, which is the
   * distinction the original "125 000 seals" claim collapsed.
   */
  rowMeasurements: number;
} {
  const sent: Array<{ peerId: string; messages: HistoryMessage[]; highWaterSeq?: number }> = [];
  const differences: Array<{ peerId: string } & DifferenceReply> = [];
  const counter = { n: 0, rows: 0 };
  return {
    sent,
    differences,
    get measurements() {
      return counter.n;
    },
    get rowMeasurements() {
      return counter.rows;
    },
    channel: {
      // #244 half A: capture the high-water baseline the snapshot path stamps.
      sendHistory(peerId: string, messages: HistoryMessage[], highWaterSeq?: number) {
        sent.push({ peerId, messages, highWaterSeq });
        return true;
      },
      sendDifference(peerId, reply) {
        differences.push({ peerId, ...reply });
        return true;
      },
      outboundWireSize: (_peerId, payload) => {
        counter.n += 1;
        const events = (payload as { events?: unknown[] }).events;
        counter.rows += Array.isArray(events) ? events.length : 0;
        return Buffer.byteLength(JSON.stringify(payload), "utf8");
      },
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
  const recording = recordingChannel(channelLimit);
  const { channel, sent, differences } = recording;
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
  return { server, sent, differences, scheduler, errors, warns, recording };
}

/**
 * #356 — drive one `get_difference` end to end. `serveDifference` is DEFERRED
 * now (it was inline before this slice), so every call site has to flush.
 */
function serveDifference(
  h: ReturnType<typeof harness>,
  afterSeq: number,
  nonce = "nonce-a",
): void {
  h.server.serveDifference(PEER, afterSeq, nonce);
  h.scheduler.flush();
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
// #244 half B / #356 — serveDifference (get_difference catch-up)
// ---------------------------------------------------------------------------
describe("createHistoryServer.serveDifference — #244 half B / #356", () => {
  it("serves RAW events with seq > afterSeq, in seq order, WITHOUT running the reducer", () => {
    const journal = openJournal();
    // thread("a") = [user a1, bubble a2, user a3] → seqs 1, 2, 3.
    const appended = thread("a");
    for (const event of appended) journal.append(PEER, event);

    const h = harness(journal);
    serveDifference(h, 1);

    expect(h.differences).toHaveLength(1);
    const { peerId, events } = h.differences[0];
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

  it("#351 — echoes the request's afterSeq and nonce verbatim, so a device can recognise its own reply", () => {
    // The shared `.out` fan-out means every device of the peer receives this
    // frame. The echo is the ONLY thing that tells them apart, so it must be
    // exactly what was asked, not a value the server re-derived.
    const journal = openJournal();
    for (const event of thread("a")) journal.append(PEER, event);
    const h = harness(journal);
    serveDifference(h, 1, "device-a-7f3c");
    expect(h.differences[0].afterSeq).toBe(1);
    expect(h.differences[0].nonce).toBe("device-a-7f3c");

    serveDifference(h, 2, "device-b-91aa");
    expect(h.differences[1].afterSeq).toBe(2);
    expect(h.differences[1].nonce).toBe("device-b-91aa");
  });

  it("#356 — a complete reply is partial:false and carries the journal's maxSeq", () => {
    const journal = openJournal();
    for (const event of thread("a")) journal.append(PEER, event);
    const h = harness(journal);
    serveDifference(h, 1);
    expect(h.differences[0].partial).toBe(false);
    expect(h.differences[0].maxSeq).toBe(3);
  });

  it("afterSeq=0 returns the whole journal, oldest first", () => {
    const journal = openJournal();
    for (const event of thread("a")) journal.append(PEER, event);
    const h = harness(journal);
    serveDifference(h, 0);
    expect(h.differences[0].events.map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it("answers an already-current afterSeq with an EMPTY, non-partial difference (not silence)", () => {
    // The client's `case "difference"` settles at `maxSeq` and re-dispatches its
    // buffer on an empty non-partial reply; sending nothing would strand a client
    // that buffered until its request times out.
    const journal = openJournal();
    for (const event of thread("a")) journal.append(PEER, event);
    const h = harness(journal);
    serveDifference(h, 3);
    expect(h.differences).toHaveLength(1);
    expect(h.differences[0].events).toEqual([]);
    expect(h.differences[0].partial).toBe(false);
    expect(h.differences[0].maxSeq).toBe(3);
  });

  it("scopes to the requesting peer — never another peer's rows", () => {
    const journal = openJournal();
    for (const event of thread("a")) journal.append(PEER, event);
    for (const event of thread("b")) journal.append(OTHER_PEER, event);
    const h = harness(journal);
    serveDifference(h, 0);
    const ids = h.differences[0].events.map((e) => {
      const ev = e.event as { answerId?: string; id?: string };
      return ev.answerId ?? ev.id;
    });
    // a's ids only (a1/a2/a3), never b's.
    expect(ids).toEqual(["a1", "a2", "a3"]);
  });

  it("byte-fits an oversize difference to the OLDEST contiguous prefix, and says partial", () => {
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
    const h = harness(journal, {}, 260);
    serveDifference(h, 0);

    expect(h.differences).toHaveLength(1);
    const seqs = h.differences[0].events.map((e) => e.seq);
    // Non-empty (forward progress guaranteed) and the OLDEST prefix (starts at 1).
    expect(seqs.length).toBeGreaterThan(0);
    expect(seqs.length).toBeLessThan(10);
    expect(seqs[0]).toBe(1);
    // Contiguous ascending from 1 — no permutation, no hole.
    expect(seqs).toEqual(seqs.map((_, i) => i + 1));
    // ⚠️ AND IT SAYS SO. Before #356 the client had to wait for the NEXT durable
    // frame to notice the remainder was missing; `partial` makes it re-request now.
    expect(h.differences[0].partial).toBe(true);
    // `maxSeq` is what this reply ACCOUNTS FOR, not the journal's high-water: the
    // trimmed events are still owed, so coverage stops at the last one served.
    expect(h.differences[0].maxSeq).toBe(seqs[seqs.length - 1]);
    // ⚠️ THE INVARIANT THAT KEEPS A PARTIAL REPLY FROM SPINNING IN PLACE.
    expect(h.differences[0].maxSeq).toBeGreaterThan(h.differences[0].afterSeq);
    // A warn, not an error: the trimmed events are re-requestable, not lost.
    expect(h.warns.some((w) => w.includes("difference for") && w.includes("shortened"))).toBe(true);
  });

  it("#356 — a read capped at MAX_DIFFERENCE_EVENTS is partial even when every event fits", () => {
    // The two halves of `partial` are independent: this one is the ROW CAP, with
    // a byte limit nothing here approaches. It is why the read asks for
    // MAX_DIFFERENCE_EVENTS + 1 rows — "there is more" is observed, not inferred.
    const journal = openJournal();
    for (let i = 1; i <= MAX_DIFFERENCE_EVENTS + 5; i++) {
      journal.append(PEER, { kind: "bubble", answerId: `a${i}`, turnId: "t1", text: "x" });
    }
    const h = harness(journal);
    serveDifference(h, 0);
    expect(h.differences[0].events).toHaveLength(MAX_DIFFERENCE_EVENTS);
    expect(h.differences[0].partial).toBe(true);
    // Coverage is the WINDOW boundary, not the journal's high-water: the five
    // rows beyond the cap are exactly what the client re-requests.
    expect(h.differences[0].maxSeq).toBe(MAX_DIFFERENCE_EVENTS);

    // And the exact boundary is not off by one: a read that exactly fills the cap
    // with nothing behind it is COMPLETE.
    const exact = openJournal();
    for (let i = 1; i <= MAX_DIFFERENCE_EVENTS; i++) {
      exact.append(PEER, { kind: "bubble", answerId: `a${i}`, turnId: "t1", text: "x" });
    }
    const h2 = harness(exact);
    serveDifference(h2, 0);
    expect(h2.differences[0].events).toHaveLength(MAX_DIFFERENCE_EVENTS);
    expect(h2.differences[0].partial).toBe(false);
  });

  it("#343 — ONE undeliverable row is SKIPPED and the rest are served (it used to wedge the device)", () => {
    // The measured shape from the issue: a row whose SEALED size alone exceeds
    // this peer's max_payload. `nats-channel.ts` journals before it publishes, so
    // such a row is in the store precisely because its own live send was refused —
    // the peer never saw it live, and omitting it is what preserves live==history.
    //
    // BEFORE: `fitDifference` bottomed out at `slice(0, 1)` and handed the single
    // oversize row to the channel, which refused the whole frame. The device got
    // NOTHING, on this request and on every retry, for the rest of the session.
    const journal = openJournal();
    journal.append(PEER, { kind: "bubble", answerId: "a1", turnId: "t1", text: "one" });
    journal.append(PEER, { kind: "bubble", answerId: "a2", turnId: "t2", text: "X".repeat(4000) });
    journal.append(PEER, { kind: "bubble", answerId: "a3", turnId: "t3", text: "three" });
    journal.append(PEER, { kind: "bubble", answerId: "a4", turnId: "t4", text: "four" });

    const h = harness(journal, {}, 1000);
    serveDifference(h, 0);

    expect(h.differences).toHaveLength(1);
    // The reply SPANS the undeliverable row: 1, then 3 and 4.
    expect(h.differences[0].events.map((e) => e.seq)).toEqual([1, 3, 4]);
    // ⚠️ NOT partial. Seq 2 is undeliverable, not deferred — the client advances
    // past it (`maxSeq`), and re-requesting it would wedge the device on it
    // forever, which is exactly the defect.
    expect(h.differences[0].partial).toBe(false);
    expect(h.differences[0].maxSeq).toBe(4);
    // The operator gets one actionable line naming the row and its size.
    const skipLine = h.errors.find((e) => e.includes("undeliverable"));
    expect(skipLine).toBeDefined();
    expect(skipLine).toContain("seq 2");
  });

  it("#356 — a partial reply ALWAYS covers past afterSeq, even when every row it examined was undeliverable", () => {
    // ⚠️ THE ONE WAY A PARTIAL REPLY COULD HAVE SPUN IN PLACE. A window whose
    // every row is undeliverable ships ZERO events; if `maxSeq` were the journal's
    // high-water the client would jump past rows it never saw, and if it were the
    // fold's max it would re-request the same floor forever. It is the window
    // boundary: the client advances past the undeliverable run and asks for the
    // rest.
    const journal = openJournal();
    for (let i = 1; i <= MAX_DIFFERENCE_EVENTS + 3; i++) {
      journal.append(PEER, { kind: "bubble", answerId: `a${i}`, turnId: "t1", text: "padding" });
    }
    // Small enough that no single row fits, large enough that an EMPTY frame does
    // (below that the budget hands the reply on whole instead, by design).
    const h = harness(journal, {}, 120);
    serveDifference(h, 0);

    expect(h.differences).toHaveLength(1);
    expect(h.differences[0].events).toEqual([]);
    expect(h.differences[0].partial).toBe(true);
    expect(h.differences[0].maxSeq).toBe(MAX_DIFFERENCE_EVENTS);
    expect(h.differences[0].maxSeq).toBeGreaterThan(h.differences[0].afterSeq);
  });

  it("#343 — a difference whose ONLY row is undeliverable answers empty rather than sending nothing", () => {
    // The degenerate case of the same rule. The old code shipped the oversize row
    // and the channel refused the frame; now the client gets an honest "you are
    // synced to maxSeq", which is what lets its cursor move past the hole.
    const journal = openJournal();
    journal.append(PEER, { kind: "bubble", answerId: "a1", turnId: "t1", text: "X".repeat(4000) });
    const h = harness(journal, {}, 1000);
    serveDifference(h, 0);
    expect(h.differences).toHaveLength(1);
    expect(h.differences[0].events).toEqual([]);
    expect(h.differences[0].partial).toBe(false);
    expect(h.differences[0].maxSeq).toBe(1);
  });

  it("#348 — an oversize 500-row difference is fitted without re-measuring the prefix per row", () => {
    // `outboundWireSize` is a full `sealEnvelope`, and the unit that matters is
    // how much gets serialized, not how many calls are made — a call measuring
    // ONE row is not a call measuring 500.
    //
    // MEASURED on exactly this page (500 rows, ~180 B of text each, limit 20 000),
    // against this file's own stub:
    //   this fit                512 calls /   2 392 row-measurements / 0.74 MB
    //   develop (modelled)      424 calls / 122 324 row-measurements / 31.75 MB
    // More calls, 51× fewer row-measurements, 43× fewer bytes. Develop's row is
    // MODELLED — its loop is not in the tree to run — and is corroborated by the
    // reviewer who measured it independently. The assertion is on
    // row-measurements because that is the unit that tracks the work.
    const journal = openJournal();
    for (let i = 1; i <= MAX_DIFFERENCE_EVENTS; i++) {
      journal.append(PEER, {
        kind: "bubble",
        answerId: `a${i}`,
        turnId: "t1",
        text: `answer ${i} `.repeat(20),
      });
    }
    const h = harness(journal, {}, 20_000);
    serveDifference(h, 0);

    expect(h.differences).toHaveLength(1);
    expect(h.differences[0].partial).toBe(true);
    // ⚠️ THE ASSERTION IS ON ROW-MEASUREMENTS, NOT CALLS. Develop's loop pays
    // Σ prefix lengths ≈ n²/2 here; this fit pays one row per row plus a
    // logarithmic bisection. A bound of 5 000 is ~24× under develop's 122 324 and
    // ~2× over the measured 2 392, so it survives a small change of page shape
    // and still fails loudly if the per-row pass ever grows a loop around it.
    expect(h.recording.rowMeasurements).toBeLessThanOrEqual(5_000);
    expect(h.recording.rowMeasurements).toBeGreaterThan(0);
    // The call count is recorded too, so a future edit that trades one for the
    // other is visible rather than silent.
    expect(h.recording.measurements).toBeLessThanOrEqual(600);
  });

  it("#348 — an ALL-UNDELIVERABLE 500-row window is bounded too (the peer-drivable one)", () => {
    // ⚠️ THIS IS THE CASE A BISECTION-PER-SKIP LOSES, AND IT IS REACHABLE BY A
    // PEER: `get_difference{afterSeq:0}` on a conversation whose rows are all
    // oversize for this peer's `max_payload`. Re-running the bisection after
    // every skip costs one pass per row — 4 500 calls, 249 278 row-measurements,
    // 22.05 MB serialized (modelled against this stub; the reviewer measured the
    // same shape at ~9 s of blocked event loop on one scheduled callback). One
    // per-row pass answers the same question in 502 calls / 1 000
    // row-measurements / 0.13 MB, which is what the bounds below pin.
    const journal = openJournal();
    for (let i = 1; i <= MAX_DIFFERENCE_EVENTS; i++) {
      journal.append(PEER, { kind: "bubble", answerId: `a${i}`, turnId: "t1", text: "padding" });
    }
    // No single row fits; an EMPTY frame still does (below that the budget hands
    // the reply on whole instead, by design).
    const h = harness(journal, {}, 120);
    serveDifference(h, 0);

    expect(h.recording.measurements).toBeLessThanOrEqual(600);
    expect(h.recording.rowMeasurements).toBeLessThanOrEqual(2_000);
    // And it is still a correct answer, not a cheap one.
    expect(h.differences).toHaveLength(1);
    expect(h.differences[0].events).toEqual([]);
    expect(h.differences[0].partial).toBe(false);
    expect(h.differences[0].maxSeq).toBeGreaterThan(h.differences[0].afterSeq);
  });

  it("#348/#356 — a burst is QUEUED and every request gets its own reply, one read at a time", () => {
    // ⚠️ EVERY REQUEST IS ANSWERED, AND THAT IS THE MULTI-DEVICE PROPERTY. N tabs
    // of one account share one `.out` subject, gap on the SAME dropped frame in
    // the same instant, and each asks from its own floor under its own nonce.
    // Newest-wins coalescing would answer one and silence N−1 — and since their
    // timers were armed together, their retries re-collide in lockstep, so each
    // silenced device eats 4 × 5 s and then gives up. A device folds only the
    // reply echoing its own `(afterSeq, nonce)`, so N replies are what N devices
    // need.
    const journal = openJournal();
    for (const event of thread("a")) journal.append(PEER, event);
    const h = harness(journal);

    h.server.serveDifference(PEER, 0, "tab-1");
    h.server.serveDifference(PEER, 1, "tab-2");
    h.server.serveDifference(PEER, 2, "tab-3");
    // ONE read scheduled, not three: concurrency is what the queue bounds.
    expect(h.scheduler.pending).toBe(1);
    h.scheduler.flush();

    // Three replies, in request order, each echoing its own request.
    expect(h.differences).toHaveLength(3);
    expect(h.differences.map((d) => d.nonce)).toEqual(["tab-1", "tab-2", "tab-3"]);
    expect(h.differences.map((d) => d.afterSeq)).toEqual([0, 1, 2]);
    expect(h.differences[0].events.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(h.differences[2].events.map((e) => e.seq)).toEqual([3]);

    // The queue RELEASES: a later request is served normally.
    serveDifference(h, 0, "tab-4");
    expect(h.differences).toHaveLength(4);
    expect(h.differences[3].nonce).toBe("tab-4");
  });

  it("#356 — the queue is bounded: past it the NEWEST request displaces the newest queued one", () => {
    // Answering every request cannot mean an unbounded backlog. Past the bound a
    // new request replaces the newest QUEUED one — never the head, which would
    // spend the budget on stale floors while the current one waits — and the
    // displaced device re-issues on its own timeout.
    const journal = openJournal();
    for (const event of thread("a")) journal.append(PEER, event);
    const h = harness(journal);

    // EIGHT un-answered requests per peer, the one about to run included.
    for (let i = 1; i <= 10; i++) h.server.serveDifference(PEER, 0, `n-${i}`);
    expect(h.scheduler.pending).toBe(1);
    h.scheduler.flush();

    expect(h.differences).toHaveLength(8);
    const answered = h.differences.map((d) => d.nonce);
    // The head and the middle survive in order; each of `n-8`/`n-9` was
    // displaced in turn by the request behind it, and the NEWEST floor is the
    // one still holding the last slot.
    expect(answered.slice(0, 7)).toEqual([
      "n-1", "n-2", "n-3", "n-4", "n-5", "n-6", "n-7",
    ]);
    expect(answered[7]).toBe("n-10");
    expect(answered).not.toContain("n-8");
    expect(answered).not.toContain("n-9");
    expect(h.warns.some((w) => w.includes("displaced the newest of 8"))).toBe(true);
  });

  it("#348 — nothing runs on the dispatch turn (the fit is no longer free)", () => {
    const journal = openJournal();
    for (const event of thread("a")) journal.append(PEER, event);
    const h = harness(journal);
    h.server.serveDifference(PEER, 0, "n-1");
    // The byte fit is a sequence of seals; it must not ride the inbound dispatch.
    expect(h.differences).toHaveLength(0);
    expect(h.scheduler.pending).toBe(1);
    h.scheduler.flush();
    expect(h.differences).toHaveLength(1);
  });

  it("#356 — a THROWING byte fit cannot escape the scheduled callback", () => {
    // ⚠️ AN ESCAPE HERE IS AN `uncaughtException`, NOT A DROPPED FRAME. On develop
    // `serveDifference` ran inline on the inbound dispatch turn, inside
    // `nats-transport.ts`'s `safeEmitFor` catch. This slice defers it, so there
    // is nothing left on the stack: a throw out of `outboundWireSize` (i.e.
    // `sealEnvelope`) takes the gateway down. The route is real —
    // `JSON.stringify` of a 500-row page raises `RangeError: Invalid string
    // length` on exactly the oversize population this fit exists for.
    const journal = openJournal();
    for (const event of thread("a")) journal.append(PEER, event);
    const h = harness(journal, {
      channel: {
        sendHistory: () => true,
        sendDifference: () => true,
        outboundWireSize: () => {
          throw new RangeError("Invalid string length");
        },
        effectiveOutboundLimit: () => 8 * 1024 * 1024,
      } as HistoryChannelSurface,
    });

    h.server.serveDifference(PEER, 0, "n-1");
    // The body runs on a LATER turn, so the property is that running it does not
    // throw at all — not that the caller survives.
    expect(() => h.scheduler.flush()).not.toThrow();
    expect(h.errors).toHaveLength(1);
    expect(h.errors[0]).toContain("difference publish failed");
    expect(h.errors[0]).toContain("Invalid string length");
    // NOT mislabelled as a journal fault — the read succeeded.
    expect(h.errors[0]).not.toContain("read failed");
  });

  it("#356 — a THROWING sendDifference cannot escape the scheduled callback either", () => {
    // The other half of the same hazard: `sendToPeer`'s fail-closed diagnostic
    // sits outside its own `try`, so the send itself can throw.
    const journal = openJournal();
    for (const event of thread("a")) journal.append(PEER, event);
    const h = harness(journal, {
      channel: {
        sendHistory: () => true,
        sendDifference: () => {
          throw new Error("transport closed");
        },
        outboundWireSize: (_peerId, payload) =>
          Buffer.byteLength(JSON.stringify(payload), "utf8"),
        effectiveOutboundLimit: () => 8 * 1024 * 1024,
      } as HistoryChannelSurface,
    });

    h.server.serveDifference(PEER, 0, "n-1");
    expect(() => h.scheduler.flush()).not.toThrow();
    expect(h.errors).toHaveLength(1);
    expect(h.errors[0]).toContain("difference publish failed");
    expect(h.errors[0]).toContain("transport closed");
    expect(h.errors[0]).not.toContain("read failed");
  });

  it("#356 — a FAILED publish does not latch the peer out of its own catch-up", () => {
    // The queue entry is held across the whole read+publish, so releasing it is
    // not automatic: a reply that throws must still release, or one bad send
    // silences this peer for the life of the process. (This is the CATCH path,
    // which is the reachable one — the drain loop's `finally` is unreachable
    // defence and its docblock says so.)
    const journal = openJournal();
    for (const event of thread("a")) journal.append(PEER, event);
    let fail = true;
    const delivered: string[] = [];
    const h = harness(journal, {
      channel: {
        sendHistory: () => true,
        sendDifference: (_peerId, reply) => {
          if (fail) throw new Error("transport closed");
          delivered.push(reply.nonce);
          return true;
        },
        outboundWireSize: (_peerId, payload) =>
          Buffer.byteLength(JSON.stringify(payload), "utf8"),
        effectiveOutboundLimit: () => 8 * 1024 * 1024,
      } as HistoryChannelSurface,
    });

    h.server.serveDifference(PEER, 0, "n-1");
    h.scheduler.flush();
    expect(delivered).toEqual([]);
    fail = false;
    serveDifference(h, 0, "n-2");
    expect(delivered).toEqual(["n-2"]);
  });

  it("on a read failure, logs and sends NOTHING (never an empty frame that would falsely advance)", () => {
    const journal = openJournal();
    for (const event of thread("a")) journal.append(PEER, event);
    const h = harness(journal);
    // Close the handle so the next read throws (database is not open).
    journal.close();
    serveDifference(h, 0);
    expect(h.differences).toHaveLength(0);
    expect(h.errors).toHaveLength(1);
    expect(h.errors[0]).toContain("difference read failed");
    // #343: it goes through the same throttle as every other failure line here.
    expect(h.errors[0]).toContain("suppressed=");
  });
});
