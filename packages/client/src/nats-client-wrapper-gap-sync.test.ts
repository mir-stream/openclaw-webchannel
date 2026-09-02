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
  client: { getDifference: (afterSeq: number) => void };
};

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
