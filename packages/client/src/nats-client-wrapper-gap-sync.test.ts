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
