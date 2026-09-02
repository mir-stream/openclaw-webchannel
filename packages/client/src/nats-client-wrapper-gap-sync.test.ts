/**
 * #244 half B — client seq tracking, gap detection, and `get_difference` catch-up.
 *
 * The wrapper folds durable frames through the SAME reducer path history/live use;
 * half B adds a per-conversation seq cursor on top of it:
 *   - seeded from the reconnect snapshot's `highWaterSeq`;
 *   - advanced by every durable frame's `seq` (and the ack's user-message seq);
 *   - a frame beyond the contiguous next seq is a GAP → one `get_difference` →
 *     the server's raw events are folded, the cursor advances, and frames buffered
 *     during the round-trip are drained.
 *
 * The load-bearing property is GAP-HEALS: after a difference, the durable view is
 * byte-identical to the no-gap fold of the same stream (live == history). It is
 * compared through `projectDurableFromClient` — the same durable projection the
 * equivalence anchors in `durable-view-reducer.test.ts` use — because the
 * client-local `working`/`draftOnly` flags are deliberately not part of the
 * durable view (that is exactly what "durable" means here).
 */
import { describe, it, expect, vi } from "vitest";

import { WebChannelNATSClient } from "./nats-client-wrapper.js";
import type { InboundMessage } from "./nats-client.js";
import {
  projectDurableFromClient,
  type DurableView,
} from "./durable-view-reducer.js";

const registration = {
  devicePrivateKey: {} as CryptoKey,
  deviceX25519PrivateKey: {} as CryptoKey,
};

/** The wrapper is side-effect-free to construct (no socket until connect()). */
function newWrapper(): WebChannelNATSClient {
  return new WebChannelNATSClient({
    natsUrl: "wss://nats.example.com",
    bootstrapJwt: "eyJ-bootstrap",
    accountId: "acct-1",
    tenant: "tenant-1",
    peerId: "peer-1",
    registration,
  });
}

type Internals = {
  state: { messages: Array<Record<string, unknown>> } & Record<string, unknown>;
  handleMessage: (msg: InboundMessage) => void;
  lastAppliedSeq: number;
  differenceInFlight: boolean;
  // #337: the `random_id → receiptKey` linkage `mintRandomId` records on a send and
  // both the ack (`adoptCommittedIds`) and the difference fold consume to adopt.
  randomIdToReceiptKey: Map<string, string>;
  client: { getDifference: (afterSeq: number) => void };
};

/**
 * #337 — inject one un-adopted optimistic user bubble (a send whose ack has NOT
 * been folded), plus the `random_id → receiptKey` linkage the real send path
 * records. Mirrors the shape `nextPublishedUserMessages` produces.
 */
function seedOptimisticUser(
  w: Internals,
  opts: { localId: string; receiptKey: string; randomId: string; text: string; wireId: string },
): void {
  w.state.messages = [
    {
      id: opts.localId,
      role: "user",
      text: opts.text,
      turnId: opts.wireId,
      wireId: opts.wireId,
      receiptKey: opts.receiptKey,
      sendState: "sent",
      pending: false,
    },
  ];
  w.randomIdToReceiptKey.set(opts.randomId, opts.receiptKey);
}

const userIds = (w: Internals): string[] =>
  project(w).filter((m) => (m as { role?: string }).role === "user").map((m) => (m as { id: string }).id);

/** A wrapper with `client.getDifference` replaced by a spy — the request seam. */
function spied(): { w: Internals; getDifference: ReturnType<typeof vi.fn> } {
  const w = newWrapper() as unknown as Internals;
  const getDifference = vi.fn();
  w.client.getDifference = getDifference;
  return { w, getDifference };
}

function project(w: Internals): DurableView {
  return projectDurableFromClient(
    w.state.messages as unknown as Parameters<typeof projectDurableFromClient>[0],
  );
}

// ── The durable turn used across the heal tests ──
// progress A (seq 1) → agent_message A (seq 2) → agent_message B (seq 3) →
// turn_snapshot (seq 4). Seqs are per-conversation, monotone, contiguous.
const PROGRESS_A: InboundMessage = {
  type: "progress", id: "A", text: "A working…", turnId: "t1", seq: 1,
};
const BUBBLE_A: InboundMessage = {
  type: "agent_message", id: "A", text: "final A", turnId: "t1", seq: 2,
};
const BUBBLE_B: InboundMessage = {
  type: "agent_message", id: "B", text: "final B", turnId: "t1", seq: 3,
};
const SNAPSHOT: InboundMessage = {
  type: "turn_snapshot",
  turnId: "t1",
  answers: [{ id: "A", text: "final A" }, { id: "B", text: "final B" }],
  remove: [],
  seq: 4,
};

/** The RAW journal events the server serves for `get_difference(afterSeq=1)` —
 *  everything with seq > 1, exactly as `delivery-journal.read` returns them. */
function differenceAfter1(): InboundMessage {
  return {
    type: "difference",
    events: [
      { seq: 2, event: { kind: "bubble", answerId: "A", text: "final A", turnId: "t1" } },
      { seq: 3, event: { kind: "bubble", answerId: "B", text: "final B", turnId: "t1" } },
      {
        seq: 4,
        event: {
          kind: "seal",
          turnId: "t1",
          answers: [{ id: "A", text: "final A" }, { id: "B", text: "final B" }],
          remove: [],
        },
      },
    ],
  };
}

describe("#244 half B — seq cursor seeding", () => {
  it("seeds lastAppliedSeq from the snapshot's highWaterSeq (even an empty snapshot)", () => {
    const { w } = spied();
    expect(w.lastAppliedSeq).toBe(0);
    w.handleMessage({ type: "history", messages: [], highWaterSeq: 5 });
    expect(w.lastAppliedSeq).toBe(5);
  });

  it("advances the cursor to a durable frame's seq, and never backward", () => {
    const { w } = spied();
    w.handleMessage({ type: "history", messages: [], highWaterSeq: 5 });
    w.handleMessage({ type: "agent_message", id: "A", text: "x", turnId: "t1", seq: 6 });
    expect(w.lastAppliedSeq).toBe(6);
    // A repeated/deduped seq (<= cursor) is not a gap and does not move it back.
    w.handleMessage({ type: "agent_message", id: "A", text: "x", turnId: "t1", seq: 6 });
    expect(w.lastAppliedSeq).toBe(6);
  });

  it("advances the cursor from the ack's user-message seq (half A echo)", () => {
    const { w } = spied();
    // The user opener consumes a seq but rides no durable frame; the ack carries it.
    w.handleMessage({
      type: "ack",
      ids: ["u-0"],
      committed: [{ random_id: "r0", messageId: "webchannel-user-3", seq: 3 }],
    });
    expect(w.lastAppliedSeq).toBe(3);
  });
});

describe("#244 half B — gap detection", () => {
  it("a contiguous in-order stream triggers NO get_difference", () => {
    const { w, getDifference } = spied();
    w.handleMessage({ type: "history", messages: [], highWaterSeq: 0 });
    for (const f of [PROGRESS_A, BUBBLE_A, BUBBLE_B, SNAPSHOT]) w.handleMessage(f);
    expect(getDifference).not.toHaveBeenCalled();
    expect(w.lastAppliedSeq).toBe(4);
  });

  it("a frame beyond the contiguous next seq fires exactly one get_difference(afterSeq=lastApplied)", () => {
    const { w, getDifference } = spied();
    w.handleMessage({ type: "history", messages: [], highWaterSeq: 0 });
    w.handleMessage(PROGRESS_A); // seq 1 applied → cursor 1
    // seq 4 with cursor 1: a gap (seqs 2,3 dropped).
    w.handleMessage(SNAPSHOT);
    expect(getDifference).toHaveBeenCalledTimes(1);
    expect(getDifference).toHaveBeenCalledWith(1);
    expect(w.differenceInFlight).toBe(true);
    // A further durable frame while the request is in flight is BUFFERED, not a
    // second request.
    w.handleMessage({ type: "agent_message", id: "C", text: "c", turnId: "t1", seq: 5 });
    expect(getDifference).toHaveBeenCalledTimes(1);
  });
});

describe("#244 half B — gap heals to the no-gap fold", () => {
  it("folds the difference, advances the cursor, drains the buffer — view == no-gap fold", () => {
    // A: the whole stream in order, no drop.
    const a = spied();
    a.w.handleMessage({ type: "history", messages: [], highWaterSeq: 0 });
    for (const f of [PROGRESS_A, BUBBLE_A, BUBBLE_B, SNAPSHOT]) a.w.handleMessage(f);

    // B: seqs 2 and 3 dropped; the snapshot (seq 4) reveals the gap and is buffered
    // until the difference lands.
    const b = spied();
    b.w.handleMessage({ type: "history", messages: [], highWaterSeq: 0 });
    b.w.handleMessage(PROGRESS_A); // seq 1
    b.w.handleMessage(SNAPSHOT); // seq 4 → gap → get_difference(1), buffer this
    expect(b.getDifference).toHaveBeenCalledTimes(1);
    expect(b.getDifference).toHaveBeenCalledWith(1);
    b.w.handleMessage(differenceAfter1()); // fold seq 2,3,4; drain the buffered seq 4

    // The cursor caught up, the round-trip closed, nothing left buffered.
    expect(b.w.lastAppliedSeq).toBe(4);
    expect(b.w.differenceInFlight).toBe(false);

    // ⚠️ THE HEAL. The durable views are byte-identical — the caught-up text is
    // present (not blanked by a stale draft flag) and in the sealed order.
    const av = project(a.w);
    const bv = project(b.w);
    expect(bv).toEqual(av);
    expect(av.map((m) => (m as { text: string }).text)).toEqual(["final A", "final B"]);
    // And B raised exactly one request; A raised none.
    expect(a.getDifference).not.toHaveBeenCalled();
  });

  it("a buffered frame that reveals a FURTHER gap re-enters gap-sync on drain", () => {
    const { w, getDifference } = spied();
    w.handleMessage({ type: "history", messages: [], highWaterSeq: 0 });
    w.handleMessage(PROGRESS_A); // seq 1
    w.handleMessage(SNAPSHOT); // seq 4 → gap → get_difference(1)
    // A PARTIAL difference: only seq 2 (the server capped it). Cursor → 2; the
    // buffered seq-4 snapshot is still beyond 2+1, so drain re-detects the gap.
    w.handleMessage({
      type: "difference",
      events: [{ seq: 2, event: { kind: "bubble", answerId: "A", text: "final A", turnId: "t1" } }],
    });
    expect(w.lastAppliedSeq).toBe(2);
    expect(getDifference).toHaveBeenCalledTimes(2);
    expect(getDifference).toHaveBeenLastCalledWith(2);
    expect(w.differenceInFlight).toBe(true);
  });
});

describe("#244 half B — empty difference", () => {
  it("no-ops on an empty difference (afterSeq already current)", () => {
    const { w, getDifference } = spied();
    w.handleMessage({ type: "history", messages: [], highWaterSeq: 4 });
    w.handleMessage({ type: "agent_message", id: "A", text: "final A", turnId: "t1", seq: 5 });
    const before = project(w);
    const cursorBefore = w.lastAppliedSeq;
    w.handleMessage({ type: "difference", events: [] });
    expect(project(w)).toEqual(before);
    expect(w.lastAppliedSeq).toBe(cursorBefore);
    expect(w.differenceInFlight).toBe(false);
    expect(getDifference).not.toHaveBeenCalled();
  });
});

describe("#244 half B — HIGH-1: an ack mid-flight must not gate out the catch-up", () => {
  it("folds the ENTIRE difference even when an ack advanced the user seq past its range", () => {
    // The exact data-loss sequence: cursor=5; an agent frame at seq10 (6-9 dropped)
    // opens a gap → get_difference(5), buffering seq10; a user follow-up's ack
    // echoes seq11 while the request is in flight; the difference then carries
    // 6..10. If the fold keyed off the LIVE cursor, the ack's advance to 11 would
    // gate every caught-up event out (`seq > 11` false) → all five lost.
    const { w, getDifference } = spied();
    w.handleMessage({ type: "history", messages: [], highWaterSeq: 5 });
    // seq10 opens the gap and is buffered.
    w.handleMessage({ type: "agent_message", id: "a10", text: "answer 10", turnId: "t1", seq: 10 });
    expect(getDifference).toHaveBeenCalledTimes(1);
    expect(getDifference).toHaveBeenCalledWith(5);
    // The user follow-up's ack — NOT buffered (not seq-bearing) — carries seq11.
    w.handleMessage({
      type: "ack",
      ids: ["u-0"],
      committed: [{ random_id: "r0", messageId: "webchannel-user-11", seq: 11 }],
    });
    // The catch-up: seqs 6..10, five agent answers.
    w.handleMessage({
      type: "difference",
      events: [6, 7, 8, 9, 10].map((seq) => ({
        seq,
        event: { kind: "bubble", answerId: `a${seq}`, text: `answer ${seq}`, turnId: "t1" },
      })),
    });

    // ⚠️ ALL FIVE present, in seq order — none gated out by the ack's seq11.
    expect(project(w).map((m) => (m as { text: string }).text)).toEqual([
      "answer 6", "answer 7", "answer 8", "answer 9", "answer 10",
    ]);
    // The cursor reflects BOTH the folded range and the deferred ack advance.
    expect(w.lastAppliedSeq).toBe(11);
    expect(w.differenceInFlight).toBe(false);
  });
});

describe("#244 half B — HIGH-2: get_difference is not fire-and-forget", () => {
  it("re-issues on timeout when no difference arrives, and a later difference heals", () => {
    vi.useFakeTimers();
    try {
      const { w, getDifference } = spied();
      w.handleMessage({ type: "history", messages: [], highWaterSeq: 5 });
      // Open a gap; the request goes out once.
      w.handleMessage({ type: "agent_message", id: "a10", text: "answer 10", turnId: "t1", seq: 10 });
      expect(getDifference).toHaveBeenCalledTimes(1);
      expect(getDifference).toHaveBeenCalledWith(5);
      expect(w.differenceInFlight).toBe(true);

      // No difference arrives → after the timeout, exactly ONE re-request (same
      // afterSeq). Without the timer this never fires and the stream is wedged.
      vi.advanceTimersByTime(5_000);
      expect(getDifference).toHaveBeenCalledTimes(2);
      expect(getDifference).toHaveBeenLastCalledWith(5);
      expect(w.differenceInFlight).toBe(true);

      // A successful difference now heals it and STOPS the timer — no further
      // re-requests however long we wait.
      w.handleMessage({
        type: "difference",
        events: [6, 7, 8, 9, 10].map((seq) => ({
          seq,
          event: { kind: "bubble", answerId: `a${seq}`, text: `answer ${seq}`, turnId: "t1" },
        })),
      });
      expect(w.differenceInFlight).toBe(false);
      vi.advanceTimersByTime(60_000);
      expect(getDifference).toHaveBeenCalledTimes(2);
      expect(project(w).map((m) => (m as { text: string }).text)).toEqual([
        "answer 6", "answer 7", "answer 8", "answer 9", "answer 10",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up into a re-detect after bounded retries, so a later frame can re-request", () => {
    vi.useFakeTimers();
    try {
      const { w, getDifference } = spied();
      w.handleMessage({ type: "history", messages: [], highWaterSeq: 5 });
      w.handleMessage({ type: "agent_message", id: "a10", text: "answer 10", turnId: "t1", seq: 10 });
      // Initial + 3 retries = 4 requests, then it gives up (stops buffering).
      for (let i = 0; i < 4; i++) vi.advanceTimersByTime(5_000);
      expect(getDifference).toHaveBeenCalledTimes(4);
      expect(w.differenceInFlight).toBe(false);
      // A fresh durable frame still showing a gap re-requests with a fresh budget.
      w.handleMessage({ type: "agent_message", id: "a12", text: "answer 12", turnId: "t1", seq: 12 });
      expect(getDifference).toHaveBeenCalledTimes(5);
      expect(w.differenceInFlight).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("#244 half B — MED-3: a fold placement never blanks an authored answer", () => {
  it("keeps the authored text when a placement lands on an already-authored bubble", () => {
    // bubble A authored (seq2), then a placement for A re-served in a difference
    // (seq3). The live `progress` handler claims `draftOnly` only for an absent or
    // still-draft bubble; the fold must mirror that, or projectDurableFromClient
    // blanks the answer to "" (the "answer destroyed" case).
    const { w, getDifference } = spied();
    w.handleMessage({ type: "history", messages: [], highWaterSeq: 1 });
    w.handleMessage({ type: "agent_message", id: "A", text: "final A", turnId: "t1", seq: 2 });
    // A gap-opening frame (seq4) buffers; the difference re-delivers placement A (seq3).
    w.handleMessage({ type: "agent_message", id: "D", text: "final D", turnId: "t1", seq: 4 });
    expect(getDifference).toHaveBeenCalledWith(2);
    w.handleMessage({
      type: "difference",
      events: [{ seq: 3, event: { kind: "placement", answerId: "A", turnId: "t1" } }],
    });

    // A keeps its authored text — NOT blanked to "".
    const a = project(w).find((m) => (m as { id: string }).id === "A");
    expect((a as { text: string }).text).toBe("final A");
    // And the buffered D drained in cleanly.
    expect(project(w).map((m) => (m as { text: string }).text)).toEqual(["final A", "final D"]);
  });
});

describe("#244 half B — a re-delivered/stale difference never corrupts the view", () => {
  it("the proven repro: a retry double-reply does NOT duplicate the user bubble", () => {
    vi.useFakeTimers();
    try {
      const { w, getDifference } = spied();
      w.handleMessage({ type: "history", messages: [], highWaterSeq: 1 });
      // A durable frame at seq3 opens a gap → get_difference(1).
      w.handleMessage({ type: "agent_message", id: "a3", text: "answer 3", turnId: "t1", seq: 3 });
      expect(getDifference).toHaveBeenCalledTimes(1);
      // The 5s timeout re-issues the SAME request (same afterSeq).
      vi.advanceTimersByTime(5_000);
      expect(getDifference).toHaveBeenCalledTimes(2);
      expect(getDifference).toHaveBeenLastCalledWith(1);

      // Both the original and the retry answer with the SAME events (the user
      // opener at seq2 rode no live frame; the difference carries it).
      const reply: InboundMessage = {
        type: "difference",
        events: [
          { seq: 2, event: { kind: "user", id: "webchannel-user-2", text: "hello", turnId: "t1" } },
          { seq: 3, event: { kind: "bubble", answerId: "a3", text: "answer 3", turnId: "t1" } },
        ],
      };
      // First reply heals.
      w.handleMessage(reply);
      expect(w.differenceInFlight).toBe(false);
      // Retry reply lands AFTER the heal — must be dropped, not re-folded.
      w.handleMessage(reply);

      const users = project(w).filter((m) => (m as { role?: string }).role === "user");
      expect(users).toHaveLength(1);
      expect((users[0] as { text: string }).text).toBe("hello");
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops a difference that lands with no request in flight — no state change", () => {
    // Isolates the in-flight guard: with no outstanding request, a (stale) reply
    // must not fold anything or advance the cursor.
    const { w, getDifference } = spied();
    w.handleMessage({ type: "history", messages: [], highWaterSeq: 5 });
    const before = project(w);
    const cursorBefore = w.lastAppliedSeq;
    w.handleMessage({
      type: "difference",
      events: [
        { seq: 6, event: { kind: "user", id: "webchannel-user-6", text: "ghost", turnId: "t1" } },
      ],
    });
    expect(project(w)).toEqual(before);
    expect(w.lastAppliedSeq).toBe(cursorBefore);
    expect(w.differenceInFlight).toBe(false);
    expect(getDifference).not.toHaveBeenCalled();
  });
});

describe("#337 — a difference user event adopts an un-adopted optimistic bubble by random_id", () => {
  it("LOST ACK: re-keys the held bubble to the server id — exactly ONE user bubble", () => {
    // The core bug. The ack for the send NEVER arrives, so the optimistic bubble
    // stays at its LOCAL id (`u-0`) — adoption runs only on the ack. The turn's
    // first agent frame (seq3) opens a gap, and the difference re-delivers the SAME
    // user event under the SERVER id `webchannel-user-2` carrying its `randomId`.
    const { w, getDifference } = spied();
    w.handleMessage({ type: "history", messages: [], highWaterSeq: 1 });
    seedOptimisticUser(w, { localId: "u-0", receiptKey: "r-0", randomId: "rand-1", text: "hello", wireId: "t1" });
    expect(userIds(w)).toEqual(["u-0"]); // held at the local id, un-adopted

    // seq3 with cursor 1 → gap → get_difference(1); the frame is buffered.
    w.handleMessage({ type: "agent_message", id: "a3", text: "answer 3", turnId: "t1", seq: 3 });
    expect(getDifference).toHaveBeenCalledWith(1);
    w.handleMessage({
      type: "difference",
      events: [
        { seq: 2, event: { kind: "user", id: "webchannel-user-2", text: "hello", turnId: "t1", randomId: "rand-1" } },
        { seq: 3, event: { kind: "bubble", answerId: "a3", text: "answer 3", turnId: "t1" } },
      ],
    });

    // ⚠️ ONE user bubble, re-keyed to the server id — NOT two (u-0 + webchannel-user-2).
    expect(userIds(w)).toEqual(["webchannel-user-2"]);
    const users = project(w).filter((m) => (m as { role?: string }).role === "user");
    expect((users[0] as { text: string }).text).toBe("hello");
    // The linkage was consumed by the fold.
    expect(w.randomIdToReceiptKey.has("rand-1")).toBe(false);
  });

  it("NO random_id: falls back to append (today's behavior) — never text-matches", () => {
    // An older client sent no random_id, so the row carries none. Without a
    // correlation the fold CANNOT adopt (and must never guess by text): the held
    // bubble keeps its local id and the re-delivered final appends. This is the
    // deliberately-kept safe fallback, not a regression.
    const { w, getDifference } = spied();
    w.handleMessage({ type: "history", messages: [], highWaterSeq: 1 });
    seedOptimisticUser(w, { localId: "u-0", receiptKey: "r-0", randomId: "rand-1", text: "hello", wireId: "t1" });

    w.handleMessage({ type: "agent_message", id: "a3", text: "answer 3", turnId: "t1", seq: 3 });
    expect(getDifference).toHaveBeenCalledWith(1);
    w.handleMessage({
      type: "difference",
      events: [
        { seq: 2, event: { kind: "user", id: "webchannel-user-2", text: "hello", turnId: "t1" } },
        { seq: 3, event: { kind: "bubble", answerId: "a3", text: "answer 3", turnId: "t1" } },
      ],
    });

    // The optimistic bubble is untouched (still `u-0`) and the final appended.
    expect(userIds(w)).toEqual(["u-0", "webchannel-user-2"]);
    // The linkage is left intact for a later ack to adopt.
    expect(w.randomIdToReceiptKey.get("rand-1")).toBe("r-0");
  });

  it("HAPPY PATH: ack adopted first drains the linkage — a re-delivered difference stays ONE bubble", () => {
    // The ack lands (adopting the bubble to the server id and draining the
    // linkage) WHILE a get_difference is in flight; the difference then re-delivers
    // the same user event. The drained linkage means no re-adopt, and applyUser
    // no-ops on the already-held id — one bubble, no double-adopt.
    const { w, getDifference } = spied();
    w.handleMessage({ type: "history", messages: [], highWaterSeq: 1 });
    seedOptimisticUser(w, { localId: "u-0", receiptKey: "r-0", randomId: "rand-1", text: "hello", wireId: "t1" });

    // seq4 opens the gap → get_difference(1) in flight (floor stays 1).
    w.handleMessage({ type: "agent_message", id: "a4", text: "answer 4", turnId: "t1", seq: 4 });
    expect(getDifference).toHaveBeenCalledWith(1);
    // The ack arrives mid-flight: adoptCommittedIds re-keys the bubble AND drains
    // the linkage (its seq advance is deferred; adoption still runs live).
    w.handleMessage({
      type: "ack",
      ids: ["u-0"],
      committed: [{ random_id: "rand-1", messageId: "webchannel-user-2", seq: 2 }],
    });
    expect(userIds(w)).toEqual(["webchannel-user-2"]);
    expect(w.randomIdToReceiptKey.has("rand-1")).toBe(false);

    // The difference re-delivers the user event; the drained linkage → no re-key,
    // applyUser no-ops on the already-held id.
    w.handleMessage({
      type: "difference",
      events: [
        { seq: 2, event: { kind: "user", id: "webchannel-user-2", text: "hello", turnId: "t1", randomId: "rand-1" } },
        { seq: 4, event: { kind: "bubble", answerId: "a4", text: "answer 4", turnId: "t1" } },
      ],
    });
    expect(userIds(w)).toEqual(["webchannel-user-2"]);
  });

  it("LATE ACK: the fold adopts first — a later ack finds the linkage drained and skips (no double, no crash)", () => {
    // The mirror of the happy path: the difference fold adopts the bubble and
    // drains the linkage; a LATE ack for the same send then finds nothing to adopt
    // and is a clean no-op — the bubble is already correct.
    const { w, getDifference } = spied();
    w.handleMessage({ type: "history", messages: [], highWaterSeq: 1 });
    seedOptimisticUser(w, { localId: "u-0", receiptKey: "r-0", randomId: "rand-1", text: "hello", wireId: "t1" });

    w.handleMessage({ type: "agent_message", id: "a3", text: "answer 3", turnId: "t1", seq: 3 });
    expect(getDifference).toHaveBeenCalledWith(1);
    w.handleMessage({
      type: "difference",
      events: [
        { seq: 2, event: { kind: "user", id: "webchannel-user-2", text: "hello", turnId: "t1", randomId: "rand-1" } },
        { seq: 3, event: { kind: "bubble", answerId: "a3", text: "answer 3", turnId: "t1" } },
      ],
    });
    expect(userIds(w)).toEqual(["webchannel-user-2"]);

    // The late ack: adoptCommittedIds resolves rand-1 to undefined (fold drained
    // it) and skips. No second adopt, no throw.
    w.handleMessage({
      type: "ack",
      ids: ["u-0"],
      committed: [{ random_id: "rand-1", messageId: "webchannel-user-2", seq: 2 }],
    });
    expect(userIds(w)).toEqual(["webchannel-user-2"]);
  });
});

describe("#245 Part B — the multi-device user_committed broadcast", () => {
  // The immediate mirror: a user's own send is broadcast on the shared `.out`
  // subject so their OTHER devices render it NOW. It is seq-bearing on the client
  // (drives the cursor); the origin reconciles by random_id, a non-origin device
  // appends. The gap-sync path (#244 hB / #337) stays the correctness fallback.
  const userCommitted = (seq: number): InboundMessage => ({
    type: "user_committed",
    id: "webchannel-user-2",
    text: "hello",
    turnId: "t1",
    seq,
    random_id: "rand-1",
  });

  it("NON-ORIGIN: appends the user bubble and advances the cursor (no gap, no request)", () => {
    // This device did NOT send the message — no optimistic bubble, no random_id
    // linkage. The broadcast at seq2 is contiguous with the seeded cursor (1), so
    // it folds live: applyUser appends (the adopt is a no-op — no linkage).
    const { w, getDifference } = spied();
    w.handleMessage({ type: "history", messages: [], highWaterSeq: 1 });
    w.handleMessage(userCommitted(2));

    expect(userIds(w)).toEqual(["webchannel-user-2"]);
    const users = project(w).filter((m) => (m as { role?: string }).role === "user");
    expect((users[0] as { text: string }).text).toBe("hello");
    // The cursor advanced to the user opener's seq — so the turn's first agent
    // frame at seq3 is CONTIGUOUS, not a phantom gap.
    expect(w.lastAppliedSeq).toBe(2);
    w.handleMessage({ type: "agent_message", id: "a3", text: "answer 3", turnId: "t1", seq: 3 });
    expect(getDifference).not.toHaveBeenCalled();
    expect(w.lastAppliedSeq).toBe(3);
    // One user bubble + one agent bubble, in seq order.
    expect(project(w).map((m) => (m as { text: string }).text)).toEqual(["hello", "answer 3"]);
  });

  it("ORIGIN, broadcast BEFORE ack: adopts the optimistic bubble; the later ack skips — ONE bubble", () => {
    const { w } = spied();
    w.handleMessage({ type: "history", messages: [], highWaterSeq: 1 });
    seedOptimisticUser(w, { localId: "u-0", receiptKey: "r-0", randomId: "rand-1", text: "hello", wireId: "t1" });
    expect(userIds(w)).toEqual(["u-0"]);

    // The broadcast arrives first: adopt-by-random_id re-keys u-0 → server id and
    // drains the linkage; applyUser then no-ops on the now-held id.
    w.handleMessage(userCommitted(2));
    expect(userIds(w)).toEqual(["webchannel-user-2"]);
    expect(w.randomIdToReceiptKey.has("rand-1")).toBe(false);
    expect(w.lastAppliedSeq).toBe(2);

    // The ack (origin's authoritative receipt) lands after: the linkage is drained,
    // so adoptCommittedIds skips; advanceCursor(2) is a no-op. Still ONE bubble.
    w.handleMessage({
      type: "ack",
      ids: ["u-0"],
      committed: [{ random_id: "rand-1", messageId: "webchannel-user-2", seq: 2 }],
    });
    expect(userIds(w)).toEqual(["webchannel-user-2"]);
    expect(w.lastAppliedSeq).toBe(2);
  });

  it("ORIGIN, ack BEFORE broadcast: ack adopts; the broadcast no-ops — ONE bubble", () => {
    const { w } = spied();
    w.handleMessage({ type: "history", messages: [], highWaterSeq: 1 });
    seedOptimisticUser(w, { localId: "u-0", receiptKey: "r-0", randomId: "rand-1", text: "hello", wireId: "t1" });

    // The ack lands first: adopts u-0 → server id and drains the linkage.
    w.handleMessage({
      type: "ack",
      ids: ["u-0"],
      committed: [{ random_id: "rand-1", messageId: "webchannel-user-2", seq: 2 }],
    });
    expect(userIds(w)).toEqual(["webchannel-user-2"]);
    expect(w.lastAppliedSeq).toBe(2);

    // The broadcast follows: adopt resolves rand-1 → undefined (drained) → no re-key,
    // and applyUser no-ops on the already-held server id. Still ONE bubble.
    w.handleMessage(userCommitted(2));
    expect(userIds(w)).toEqual(["webchannel-user-2"]);
    expect(w.lastAppliedSeq).toBe(2);
  });

  it("MISSED broadcast: the gap-sync fallback still converges (non-origin)", () => {
    // The at-most-once broadcast is DROPPED, so this non-origin device never sees
    // the user_committed. The turn's first agent frame (seq3) then opens a gap →
    // get_difference(1) → the difference carries the user event (#337 appends it
    // for a device with no linkage). Convergence is preserved by the fallback.
    const { w, getDifference } = spied();
    w.handleMessage({ type: "history", messages: [], highWaterSeq: 1 });
    // NO userCommitted(2) delivered — the broadcast was missed.
    w.handleMessage({ type: "agent_message", id: "a3", text: "answer 3", turnId: "t1", seq: 3 });
    expect(getDifference).toHaveBeenCalledWith(1);
    w.handleMessage({
      type: "difference",
      events: [
        { seq: 2, event: { kind: "user", id: "webchannel-user-2", text: "hello", turnId: "t1", randomId: "rand-1" } },
        { seq: 3, event: { kind: "bubble", answerId: "a3", text: "answer 3", turnId: "t1" } },
      ],
    });

    expect(userIds(w)).toEqual(["webchannel-user-2"]);
    expect(project(w).map((m) => (m as { text: string }).text)).toEqual(["hello", "answer 3"]);
    expect(w.lastAppliedSeq).toBe(3);
    expect(w.differenceInFlight).toBe(false);
  });

  it("broadcast THEN a later difference re-delivering the same event → still ONE bubble", () => {
    // Non-origin sees the broadcast (appends webchannel-user-2, cursor→2). Later a
    // gap re-fetches a range that re-carries the same user event; applyUser is
    // id-idempotent, so the second fold is a no-op — no duplicate.
    const { w, getDifference } = spied();
    w.handleMessage({ type: "history", messages: [], highWaterSeq: 1 });
    w.handleMessage(userCommitted(2));
    expect(userIds(w)).toEqual(["webchannel-user-2"]);
    expect(w.lastAppliedSeq).toBe(2);

    // A later agent frame at seq5 opens a gap (seqs 3,4 dropped) → get_difference(2),
    // and the server's difference re-carries seq2's user event alongside the missed
    // range.
    w.handleMessage({ type: "agent_message", id: "a5", text: "answer 5", turnId: "t1", seq: 5 });
    expect(getDifference).toHaveBeenCalledWith(2);
    w.handleMessage({
      type: "difference",
      events: [
        { seq: 2, event: { kind: "user", id: "webchannel-user-2", text: "hello", turnId: "t1", randomId: "rand-1" } },
        { seq: 3, event: { kind: "bubble", answerId: "a3", text: "answer 3", turnId: "t1" } },
        { seq: 4, event: { kind: "bubble", answerId: "a4", text: "answer 4", turnId: "t1" } },
        { seq: 5, event: { kind: "bubble", answerId: "a5", text: "answer 5", turnId: "t1" } },
      ],
    });

    // The re-delivered user event did NOT duplicate — one user bubble, held id.
    expect(userIds(w)).toEqual(["webchannel-user-2"]);
    expect(project(w).map((m) => (m as { text: string }).text)).toEqual([
      "hello", "answer 3", "answer 4", "answer 5",
    ]);
    expect(w.lastAppliedSeq).toBe(5);
  });

  it("a user_committed that never arrives still converges through gap-sync (at-most-once drop)", () => {
    // The frame is never delivered — which is what an at-most-once core-NATS drop
    // looks like from the wrapper's side: no cursor advance, no fold, no signal.
    // Confirm the stream still converges through the gap path.
    //
    // ⚠️ THIS USED TO BE NAMED FOR AN "OLDER CLIENT" AND IT IS THE SAME TEST, ONLY
    // HONESTLY LABELLED. #246 took the wire to v4 with an exact-match register
    // gate, so a client that does not handle `user_committed` is REFUSED and is no
    // longer a reachable peer; the behaviour pinned here is not back-compat but the
    // at-most-once guarantee (`channel-contract.ts`'s `user_committed` docblock),
    // which is why it is still worth pinning. Do not delete it as "dead compat".
    const { w, getDifference } = spied();
    w.handleMessage({ type: "history", messages: [], highWaterSeq: 1 });
    w.handleMessage({ type: "agent_message", id: "a3", text: "answer 3", turnId: "t1", seq: 3 });
    expect(getDifference).toHaveBeenCalledWith(1);
    w.handleMessage({
      type: "difference",
      events: [
        { seq: 2, event: { kind: "user", id: "webchannel-user-2", text: "hello", turnId: "t1", randomId: "rand-1" } },
        { seq: 3, event: { kind: "bubble", answerId: "a3", text: "answer 3", turnId: "t1" } },
      ],
    });
    expect(project(w).map((m) => (m as { text: string }).text)).toEqual(["hello", "answer 3"]);
  });
});

/**
 * #246 half A — THE CURSOR INVARIANT: a seq-bearing frame advances
 * `lastAppliedSeq` IFF it was folded.
 *
 * Every shape check inside `handleFrame` used to be a bare early `return`, which
 * the caller could not tell from a successful fold — so the cursor advanced past
 * a frame that had just been REFUSED. That is unrecoverable data loss, not a
 * cosmetic slip: the event is gone AND the gap that would have re-fetched it is
 * closed by the same statement, so no later frame ever reads a hole there.
 *
 * ⚠️ THESE DRIVE `handleMessage` DIRECTLY, NOT THE DECODED DOOR, AND THAT IS THE
 * POINT. `decodeInboundMessage` refuses most of these frames before the wrapper
 * ever sees them, which is exactly why the cursor must not be wired to it: a
 * decoder that misses a case must degrade to "one wasted round-trip", never back
 * to silent loss. The malformed frames below are the ones that reach the reducer
 * when the door is bypassed — the shape `handleFrame` itself has to refuse.
 */
describe("#246 half A — a refused seq-bearing frame must not advance the cursor", () => {
  /** The confirmed defect's frame: `user_committed` with an empty id. */
  const malformedUserCommitted = (seq: number): InboundMessage => ({
    type: "user_committed",
    id: "",
    text: "hello",
    turnId: "t1",
    seq,
    random_id: "rand-1",
  });

  it("drops a malformed user_committed and leaves the cursor where it was", () => {
    const { w, getDifference } = spied();
    w.handleMessage({ type: "history", messages: [], highWaterSeq: 1 });
    w.handleMessage(malformedUserCommitted(2));

    // Nothing folded — and, the load-bearing half, nothing advanced.
    expect(userIds(w)).toEqual([]);
    expect(w.lastAppliedSeq).toBe(1);
    // Refusing is not itself a gap: the frame simply did not happen.
    expect(getDifference).not.toHaveBeenCalled();
  });

  it("the NEXT well-formed frame then reads as a gap and requests get_difference(afterSeq=N)", () => {
    const { w, getDifference } = spied();
    w.handleMessage({ type: "history", messages: [], highWaterSeq: 1 });
    w.handleMessage(malformedUserCommitted(2)); // refused; cursor stays 1
    // seq3 against a cursor of 1 is beyond the contiguous next seq ⇒ the refused
    // seq2 shows up as the hole it is.
    w.handleMessage({ type: "agent_message", id: "a3", text: "answer 3", turnId: "t1", seq: 3 });

    expect(getDifference).toHaveBeenCalledTimes(1);
    expect(getDifference).toHaveBeenCalledWith(1);
    expect(w.differenceInFlight).toBe(true);
  });

  it("the difference re-serves the canonical row → the view equals a clean delivery", () => {
    // A: the well-formed stream, no refusal anywhere.
    const a = spied();
    a.w.handleMessage({ type: "history", messages: [], highWaterSeq: 1 });
    a.w.handleMessage({
      type: "user_committed",
      id: "webchannel-user-2", text: "hello", turnId: "t1", seq: 2, random_id: "rand-1",
    });
    a.w.handleMessage({ type: "agent_message", id: "a3", text: "answer 3", turnId: "t1", seq: 3 });

    // B: the same stream, but the broadcast arrives malformed and is refused.
    const b = spied();
    b.w.handleMessage({ type: "history", messages: [], highWaterSeq: 1 });
    b.w.handleMessage(malformedUserCommitted(2));
    b.w.handleMessage({ type: "agent_message", id: "a3", text: "answer 3", turnId: "t1", seq: 3 });
    expect(b.getDifference).toHaveBeenCalledWith(1);
    const difference: InboundMessage = {
      type: "difference",
      events: [
        { seq: 2, event: { kind: "user", id: "webchannel-user-2", text: "hello", turnId: "t1", randomId: "rand-1" } },
        { seq: 3, event: { kind: "bubble", answerId: "a3", text: "answer 3", turnId: "t1" } },
      ],
    };
    b.w.handleMessage(difference);

    // ⚠️ THE HEAL: the row the malformed frame carried is back, exactly once, and
    // the two devices' durable views are byte-identical.
    expect(project(b.w)).toEqual(project(a.w));
    expect(userIds(b.w)).toEqual(["webchannel-user-2"]);
    expect(b.w.lastAppliedSeq).toBe(3);
    expect(b.w.differenceInFlight).toBe(false);

    // APPLIED TWICE (the rule from #308): re-deliver the identical difference.
    // It changes nothing because no request is outstanding — the stale-reply
    // guard drops it whole — which is the property that has to survive, since a
    // retry double-reply delivers exactly this.
    const healed = project(b.w);
    b.w.handleMessage(difference);
    expect(project(b.w)).toEqual(healed);
    expect(userIds(b.w)).toEqual(["webchannel-user-2"]);
    expect(b.w.lastAppliedSeq).toBe(3);
  });

  it("a malformed KNOWN-kind event inside a difference is SKIPPED and its seq still advances", () => {
    // The catch-up door's OPPOSITE rule: a difference is the authoritative answer
    // to a gap, so a row it cannot fold must not freeze the cursor — that would
    // re-request the same unusable row forever.
    const { w, getDifference } = spied();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      w.handleMessage({ type: "history", messages: [], highWaterSeq: 1 });
      w.handleMessage({ type: "agent_message", id: "a4", text: "answer 4", turnId: "t1", seq: 4 });
      expect(getDifference).toHaveBeenCalledWith(1);
      w.handleMessage({
        type: "difference",
        events: [
          // Known kind, unusable shape: a `bubble` with no text.
          { seq: 2, event: { kind: "bubble", answerId: "a2", turnId: "t1" } },
          { seq: 3, event: { kind: "bubble", answerId: "a3", text: "answer 3", turnId: "t1" } },
          { seq: 4, event: { kind: "bubble", answerId: "a4", text: "answer 4", turnId: "t1" } },
        ],
      });

      // seq2 was not folded, seq3/seq4 were, and the cursor cleared the whole range.
      expect(project(w).map((m) => (m as { text: string }).text)).toEqual([
        "answer 3", "answer 4",
      ]);
      expect(w.lastAppliedSeq).toBe(4);
      expect(w.differenceInFlight).toBe(false);
      // No re-request loop: the catch-up closed on the first round-trip.
      expect(getDifference).toHaveBeenCalledTimes(1);
      // The skip is REPORTED — an unknown kind is version skew, a malformed known
      // kind is a defect upstream and must not be silent.
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("skipping malformed bubble event"));
    } finally {
      warn.mockRestore();
    }
  });

  it("an ack whose committed entry is malformed adopts nothing and moves no cursor", () => {
    const { w } = spied();
    w.handleMessage({ type: "history", messages: [], highWaterSeq: 1 });
    seedOptimisticUser(w, {
      localId: "u-0", receiptKey: "r-0", randomId: "rand-1", text: "hello", wireId: "t1",
    });

    // A well-formed `seq` riding an entry whose identity is not: the seq is only
    // evidence that a user row was committed if the entry naming that row is
    // intact, so neither the re-key nor the cursor may act on it.
    w.handleMessage({
      type: "ack",
      ids: ["u-0"],
      committed: [{ random_id: "rand-1", messageId: "", seq: 4 } as unknown as {
        random_id: string; messageId: string; seq?: number;
      }],
    });

    expect(userIds(w)).toEqual(["u-0"]);
    expect(w.lastAppliedSeq).toBe(1);
    // The linkage is NOT consumed: the echo never happened, so a real one still
    // has to be able to adopt this bubble.
    expect(w.randomIdToReceiptKey.has("rand-1")).toBe(true);
  });

  it("a difference carrying a seal with no answers cannot wedge gap-sync", () => {
    // `foldDifferenceEvent`'s `case "seal"` iterates `event.answers` BEFORE the
    // reducer sees it, so a missing `answers` threw INSIDE the fold. The throw is
    // swallowed by the client's listener dispatch, leaving `differenceInFlight`
    // stuck true with its liveness timer already cancelled — every later durable
    // frame buffered forever, in silence.
    const { w, getDifference } = spied();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      w.handleMessage({ type: "history", messages: [], highWaterSeq: 1 });
      w.handleMessage({ type: "agent_message", id: "a4", text: "answer 4", turnId: "t1", seq: 4 });
      expect(getDifference).toHaveBeenCalledWith(1);

      expect(() =>
        w.handleMessage({
          type: "difference",
          events: [
            { seq: 2, event: { kind: "bubble", answerId: "a2", text: "answer 2", turnId: "t1" } },
            // The wedge: a `seal` with no `answers` at all.
            { seq: 3, event: { kind: "seal", turnId: "t1" } },
            { seq: 4, event: { kind: "bubble", answerId: "a4", text: "answer 4", turnId: "t1" } },
          ],
        }),
      ).not.toThrow();

      // Skipped, not folded — and the whole range still cleared.
      expect(w.lastAppliedSeq).toBe(4);
      expect(w.differenceInFlight).toBe(false);
      expect(project(w).map((m) => (m as { text: string }).text)).toEqual([
        "answer 2", "answer 4",
      ]);

      // And the stream is LIVE again: the next contiguous frame folds normally
      // rather than being buffered behind a stuck in-flight flag.
      w.handleMessage({ type: "agent_message", id: "a5", text: "answer 5", turnId: "t1", seq: 5 });
      expect(w.lastAppliedSeq).toBe(5);
      expect(getDifference).toHaveBeenCalledTimes(1);
      expect(project(w).map((m) => (m as { text: string }).text)).toEqual([
        "answer 2", "answer 4", "answer 5",
      ]);
    } finally {
      warn.mockRestore();
    }
  });

  it("a fold that throws cannot wedge gap-sync — the round-trip closes out and re-detects", () => {
    // The test above proves the VALIDATOR keeps the known throw out of the arm.
    // This one DEFEATS the validator — a perfectly well-formed event, a fold made
    // to throw — because the property that must hold is not "this event shape is
    // handled" but "no throw from the fold can wedge gap-sync".
    //
    // ⚠️ WHAT "NOT WEDGED" MEANS HERE, MEASURED RATHER THAN ASSUMED. The
    // `try/finally` in `applyDifference` does NOT pretend the fold succeeded: it
    // runs the bookkeeping (in-flight cleared, cursor advanced only as far as the
    // loop actually got — seq 2 never counted, so it stays at 1) and DRAINS the
    // buffer. The buffered frame then re-detects the same gap and issues a FRESH
    // request with a fresh retry budget, which is the self-heal. Without the
    // `finally`, none of that runs: `differenceInFlight` stays true with its
    // liveness timer already cancelled, the buffer is never drained, and every
    // later durable frame is buffered in silence until the transport drops.
    const { w, getDifference } = spied();
    w.handleMessage({ type: "history", messages: [], highWaterSeq: 1 });
    w.handleMessage({ type: "agent_message", id: "a3", text: "answer 3", turnId: "t1", seq: 3 });
    expect(getDifference).toHaveBeenCalledTimes(1);
    expect(getDifference).toHaveBeenCalledWith(1);

    const instance = w as unknown as { foldDifferenceEvent?: () => void };
    instance.foldDifferenceEvent = () => {
      throw new Error("fold blew up");
    };
    // The throw escapes THIS call because the test drives `handleMessage`
    // directly; in production `notifyMessageListeners` swallows it, which is
    // exactly why the cleanup cannot live after the loop.
    expect(() =>
      w.handleMessage({
        type: "difference",
        events: [{ seq: 2, event: { kind: "bubble", answerId: "a2", text: "answer 2", turnId: "t1" } }],
      }),
    ).toThrow("fold blew up");

    // Nothing folded, so the cursor did NOT move past the failed event…
    expect(w.lastAppliedSeq).toBe(1);
    // …and the buffer was drained: the seq-3 frame re-detected the gap and asked
    // again. THAT is the difference between degrading and wedging.
    expect(getDifference).toHaveBeenCalledTimes(2);
    expect(getDifference).toHaveBeenLastCalledWith(1);

    // End to end: with the fold working again, the re-issued request heals the
    // stream exactly as an ordinary one does.
    delete instance.foldDifferenceEvent;
    w.handleMessage({
      type: "difference",
      events: [
        { seq: 2, event: { kind: "bubble", answerId: "a2", text: "answer 2", turnId: "t1" } },
        { seq: 3, event: { kind: "bubble", answerId: "a3", text: "answer 3", turnId: "t1" } },
      ],
    });
    expect(project(w).map((m) => (m as { text: string }).text)).toEqual([
      "answer 2", "answer 3",
    ]);
    expect(w.lastAppliedSeq).toBe(3);
    expect(w.differenceInFlight).toBe(false);
  });
});
