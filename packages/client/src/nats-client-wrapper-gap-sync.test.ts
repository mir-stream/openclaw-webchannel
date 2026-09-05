/**
 * #244 half B / #356 — the client seq cursor: Telegram's update state machine.
 *
 * The wrapper folds durable frames through the SAME reducer path history/live
 * use; on top of that it runs the cursor `SeqCursor` describes:
 *   - `unseeded` until the register-time snapshot's `highWaterSeq` (Telegram's
 *     `updates.getState`) arrives — held frames, nothing requested;
 *   - `synced`, where every seq goes through the three-way apply/ignore/gap test;
 *   - `catching-up`, one `get_difference(afterSeq, nonce)` outstanding, everything
 *     seq-bearing held, and only a reply echoing THAT `(afterSeq, nonce)` folded.
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

/** The cursor's shape, mirrored for the probes below (`SeqCursor` is module-private). */
type Cursor =
  | { state: "unseeded"; buffer: InboundMessage[] }
  | { state: "synced"; last: number }
  | {
      state: "catching-up";
      afterSeq: number;
      nonce: string;
      buffer: InboundMessage[];
      retries: number;
    };

type Internals = {
  state: { messages: Array<Record<string, unknown>> } & Record<string, unknown>;
  handleMessage: (msg: InboundMessage) => void;
  cursor: Cursor;
  // #337: the `random_id → receiptKey` linkage `mintRandomId` records on a send and
  // both the ack (`adoptCommittedIds`) and the difference fold consume to adopt.
  randomIdToReceiptKey: Map<string, string>;
  client: { getDifference: (afterSeq: number, nonce: string) => void };
};

/** `last` in whichever state the cursor is in; `undefined` while unseeded. */
function cursorLast(w: Internals): number | undefined {
  const c = w.cursor;
  if (c.state === "unseeded") return undefined;
  return c.state === "synced" ? c.last : c.afterSeq;
}

const isCatchingUp = (w: Internals): boolean => w.cursor.state === "catching-up";

/** The outstanding request's retry count — the budget a stall now shares. */
function retriesOf(w: Internals): number {
  const c = w.cursor;
  return c.state === "catching-up" ? c.retries : 0;
}

/** Mirrors `nats-client-wrapper.ts`'s constant (not exported — it is internal). */
const GET_DIFFERENCE_MAX_RETRIES = 3;

/** The nonce of the outstanding request — what a reply has to echo. */
function outstandingNonce(w: Internals): string {
  const c = w.cursor;
  if (c.state !== "catching-up") throw new Error("no request outstanding");
  return c.nonce;
}

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

/** The register-time snapshot — Telegram's `updates.getState`. Seeds the cursor. */
const seed = (w: Internals, highWaterSeq: number): void =>
  w.handleMessage({ type: "history", messages: [], highWaterSeq });

/**
 * A well-formed `difference` answering the request currently outstanding on `w`.
 * Every reply the server sends echoes the request, so every reply a test sends
 * has to as well — passing the envelope by hand is how #351 was possible.
 */
function reply(
  w: Internals,
  events: Array<{ seq: number; event: unknown }>,
  opts: { partial?: boolean; maxSeq?: number } = {},
): InboundMessage {
  const c = w.cursor;
  if (c.state !== "catching-up") throw new Error("no request outstanding");
  const seqs = events.map((e) => e.seq);
  return {
    type: "difference",
    afterSeq: c.afterSeq,
    nonce: c.nonce,
    events,
    partial: opts.partial ?? false,
    maxSeq: opts.maxSeq ?? Math.max(c.afterSeq, ...(seqs.length > 0 ? seqs : [c.afterSeq])),
  };
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

/** The RAW journal events the server serves for `get_difference(afterSeq=1)`. */
const EVENTS_AFTER_1: Array<{ seq: number; event: unknown }> = [
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
];

describe("#356 — unseeded: no pts, so no gap can be invented", () => {
  it("#350 — a live frame BEFORE the snapshot SEEDS the cursor instead of gap-detecting from 0", () => {
    // THE DEFECT. `lastAppliedSeq` started at 0 and the gap test fired for any
    // seq > 1, so a reload mid-turn asked for `get_difference(0)` and pulled the
    // ENTIRE conversation back through the fold in 500-event pages. Telegram's
    // client never calls `getDifference` before it holds a `pts`; this client now
    // ADOPTS its first observation as one, and renders the frame that carried it.
    const { w, getDifference } = spied();
    expect(cursorLast(w)).toBeUndefined();

    w.handleMessage({ type: "agent_message", id: "a900", text: "answer 900", turnId: "t1", seq: 900 });

    expect(getDifference).not.toHaveBeenCalled();
    expect(project(w).map((m) => (m as { text: string }).text)).toEqual(["answer 900"]);
    expect(cursorLast(w)).toBe(900);
  });

  it("#350 — the snapshot that lands afterwards is BELOW the adopted baseline and asks for nothing", () => {
    // The race the defect lived in: live frames reach the wrapper before the
    // register-time snapshot (the client subscribes `.out` before the register
    // hop; the snapshot is `setImmediate`-deferred on the plugin). The snapshot's
    // rows still hydrate the transcript; its high-water is simply not news.
    const { w, getDifference } = spied();
    w.handleMessage({ type: "agent_message", id: "a900", text: "answer 900", turnId: "t1", seq: 900 });
    seed(w, 899);
    expect(cursorLast(w)).toBe(900);
    expect(getDifference).not.toHaveBeenCalled();
  });

  it("#350 — once seeded, a real hole is ONE bounded request, not the whole journal", () => {
    const { w, getDifference } = spied();
    w.handleMessage({ type: "agent_message", id: "a900", text: "answer 900", turnId: "t1", seq: 900 });
    w.handleMessage({ type: "agent_message", id: "a903", text: "answer 903", turnId: "t1", seq: 903 });
    expect(getDifference).toHaveBeenCalledTimes(1);
    // From 900, not from 0.
    expect(getDifference).toHaveBeenCalledWith(900, outstandingNonce(w));
  });

  it("#350 — the snapshot is the ORDINARY seed, and an empty conversation still works", () => {
    // ⚠️ WHY THE FIRST DURABLE FRAME MAY SEED AT ALL, rather than being held until
    // a snapshot arrives: `history-serve.ts` SUPPRESSES an empty snapshot, so a
    // brand-new conversation never receives one. A client that waited for it would
    // hold every frame of the user's first turn forever.
    const { w, getDifference } = spied();
    seed(w, 0);
    expect(cursorLast(w)).toBe(0);
    w.handleMessage({ type: "agent_message", id: "a1", text: "answer 1", turnId: "t1", seq: 1 });
    expect(cursorLast(w)).toBe(1);
    expect(getDifference).not.toHaveBeenCalled();
    expect(project(w).map((m) => (m as { text: string }).text)).toEqual(["answer 1"]);
  });

  it("#246 — a REFUSED first frame seeds one short, so the next frame re-serves it", () => {
    // The seed adopts `seq - 1` and lets the frame go through the ordinary apply
    // path, gate included: a frame the fold refuses leaves the cursor below its
    // seq, exactly as it does in `synced`.
    const { w, getDifference } = spied();
    w.handleMessage({
      type: "user_committed", id: "", text: "hello", turnId: "t1", seq: 5, random_id: "rand-1",
    });
    expect(userIds(w)).toEqual([]);
    expect(cursorLast(w)).toBe(4);
    w.handleMessage({ type: "agent_message", id: "a6", text: "answer 6", turnId: "t1", seq: 6 });
    expect(getDifference).toHaveBeenCalledTimes(1);
    expect(getDifference).toHaveBeenCalledWith(4, outstandingNonce(w));
  });

  it("a seq-bearing TYPE with no seq establishes nothing and simply folds", () => {
    // A live reasoning draft / an id-less agent_message carries no durable row, so
    // there is no baseline in it — it must not be held, and must not become one.
    const { w, getDifference } = spied();
    w.handleMessage({ type: "agent_message", id: "a1", text: "no seq here", turnId: "t1" });
    expect(cursorLast(w)).toBeUndefined();
    expect(getDifference).not.toHaveBeenCalled();
    expect(project(w).map((m) => (m as { text: string }).text)).toEqual(["no seq here"]);
  });

  it("an ack from ANOTHER device cannot seed the cursor", () => {
    // An ack whose `random_id` names no local send is not this device's receipt
    // (#345), so it is ignored outright — including as a baseline.
    const { w, getDifference } = spied();
    w.handleMessage({
      type: "ack",
      ids: ["u-0"],
      committed: [{ random_id: "r0", messageId: "webchannel-user-3", seq: 3 }],
    });
    expect(cursorLast(w)).toBeUndefined();
    expect(getDifference).not.toHaveBeenCalled();
  });
});

describe("#244 half B — the three-way check in `synced`", () => {
  it("seeds the cursor from the snapshot's highWaterSeq (even an empty snapshot)", () => {
    const { w } = spied();
    seed(w, 5);
    expect(cursorLast(w)).toBe(5);
  });

  it("advances the cursor to a durable frame's seq, and never backward", () => {
    const { w } = spied();
    seed(w, 5);
    w.handleMessage({ type: "agent_message", id: "A", text: "x", turnId: "t1", seq: 6 });
    expect(cursorLast(w)).toBe(6);
    // A repeated/deduped seq (<= cursor) is not a gap and does not move it back.
    w.handleMessage({ type: "agent_message", id: "A", text: "x", turnId: "t1", seq: 6 });
    expect(cursorLast(w)).toBe(6);
  });

  it("#356 — a REPEATED seq is still FOLDED: our seq numbers rows, not events", () => {
    // ⚠️ THE ONE PLACE WE DO NOT DO WHAT TELEGRAM SAYS, and this pins why.
    // `delivery-journal.ts` dedupes `placement` on its answer id, so every
    // `progress` frame of a streaming answer carries the SAME seq as the first.
    // Telegram's "already applied, must be ignored" would freeze every draft at
    // its first chunk. The CURSOR ignores the repeat; the FRAME still folds.
    const { w, getDifference } = spied();
    seed(w, 0);
    w.handleMessage({ type: "progress", id: "A", text: "Wor", turnId: "t1", seq: 1 });
    w.handleMessage({ type: "progress", id: "A", text: "Working on i", turnId: "t1", seq: 1 });
    w.handleMessage({ type: "progress", id: "A", text: "Working on it…", turnId: "t1", seq: 1 });

    const draft = w.state.messages.find((m) => m.id === "A") as { text?: string } | undefined;
    expect(draft?.text).toBe("Working on it…");
    expect(cursorLast(w)).toBe(1);
    expect(getDifference).not.toHaveBeenCalled();
  });

  it("a contiguous in-order stream triggers NO get_difference", () => {
    const { w, getDifference } = spied();
    seed(w, 0);
    for (const f of [PROGRESS_A, BUBBLE_A, BUBBLE_B, SNAPSHOT]) w.handleMessage(f);
    expect(getDifference).not.toHaveBeenCalled();
    expect(cursorLast(w)).toBe(4);
  });

  it("a frame beyond the contiguous next seq fires exactly one get_difference(afterSeq=last)", () => {
    const { w, getDifference } = spied();
    seed(w, 0);
    w.handleMessage(PROGRESS_A); // seq 1 applied → cursor 1
    // seq 4 with cursor 1: a gap (seqs 2,3 dropped).
    w.handleMessage(SNAPSHOT);
    expect(getDifference).toHaveBeenCalledTimes(1);
    expect(getDifference).toHaveBeenCalledWith(1, outstandingNonce(w));
    expect(isCatchingUp(w)).toBe(true);
    // A further durable frame while the request is outstanding is HELD, not a
    // second request.
    w.handleMessage({ type: "agent_message", id: "C", text: "c", turnId: "t1", seq: 5 });
    expect(getDifference).toHaveBeenCalledTimes(1);
  });
});

describe("#244 half B — gap heals to the no-gap fold", () => {
  it("folds the difference, advances the cursor, re-dispatches the buffer — view == no-gap fold", () => {
    // A: the whole stream in order, no drop.
    const a = spied();
    seed(a.w, 0);
    for (const f of [PROGRESS_A, BUBBLE_A, BUBBLE_B, SNAPSHOT]) a.w.handleMessage(f);

    // B: seqs 2 and 3 dropped; the snapshot (seq 4) reveals the gap and is held
    // until the difference lands.
    const b = spied();
    seed(b.w, 0);
    b.w.handleMessage(PROGRESS_A); // seq 1
    b.w.handleMessage(SNAPSHOT); // seq 4 → gap → get_difference(1), hold this
    expect(b.getDifference).toHaveBeenCalledTimes(1);
    expect(b.getDifference).toHaveBeenCalledWith(1, outstandingNonce(b.w));
    b.w.handleMessage(reply(b.w, EVENTS_AFTER_1)); // fold 2,3,4; drop the held seq 4

    // The cursor caught up, the round-trip closed, nothing left held.
    expect(cursorLast(b.w)).toBe(4);
    expect(isCatchingUp(b.w)).toBe(false);

    // ⚠️ THE HEAL. The durable views are byte-identical — the caught-up text is
    // present (not blanked by a stale draft flag) and in the sealed order.
    const av = project(a.w);
    const bv = project(b.w);
    expect(bv).toEqual(av);
    expect(av.map((m) => (m as { text: string }).text)).toEqual(["final A", "final B"]);
    // And B raised exactly one request; A raised none.
    expect(a.getDifference).not.toHaveBeenCalled();
  });

  it("a held frame that reveals a FURTHER gap re-enters gap-sync on re-dispatch", () => {
    const { w, getDifference } = spied();
    seed(w, 0);
    w.handleMessage(PROGRESS_A); // seq 1
    w.handleMessage(SNAPSHOT); // seq 4 → gap → get_difference(1)
    // A COMPLETE reply that happens to carry only seq 2 (the server's own view of
    // the range) — the held seq-4 snapshot is still beyond 2+1, so the
    // re-dispatch re-detects the gap.
    w.handleMessage(
      reply(w, [{ seq: 2, event: { kind: "bubble", answerId: "A", text: "final A", turnId: "t1" } }]),
    );
    expect(cursorLast(w)).toBe(2);
    expect(getDifference).toHaveBeenCalledTimes(2);
    expect(getDifference).toHaveBeenLastCalledWith(2, outstandingNonce(w));
    expect(isCatchingUp(w)).toBe(true);
  });
});

describe("#356 — partial replies (Telegram's differenceSlice)", () => {
  it("#352 — a PARTIAL reply re-requests immediately, with a fresh nonce, from where it got to", () => {
    // "The intermediate status must be saved on the client and the query must be
    // repeated, using the intermediate status as the current status."
    const { w, getDifference } = spied();
    seed(w, 100);
    w.handleMessage({ type: "agent_message", id: "a400", text: "answer 400", turnId: "t1", seq: 400 });
    const firstNonce = outstandingNonce(w);
    expect(getDifference).toHaveBeenCalledWith(100, firstNonce);

    w.handleMessage(
      reply(
        w,
        [101, 102, 103].map((seq) => ({
          seq,
          event: { kind: "bubble", answerId: `a${seq}`, text: `answer ${seq}`, turnId: "t1" },
        })),
        { partial: true, maxSeq: 103 },
      ),
    );

    // Still catching up, from the intermediate status, under a NEW nonce.
    expect(isCatchingUp(w)).toBe(true);
    expect(cursorLast(w)).toBe(103);
    expect(getDifference).toHaveBeenCalledTimes(2);
    expect(getDifference).toHaveBeenLastCalledWith(103, outstandingNonce(w));
    expect(outstandingNonce(w)).not.toBe(firstNonce);
  });

  it("#343/#356 — a partial reply's maxSeq carries the cursor past rows the server could not send", () => {
    // The degenerate slice: the server examined a window and found every row
    // undeliverable at this peer's `max_payload`, so it ships zero events and
    // reports how far it looked. Advancing to that boundary is what stops the
    // pair re-asking about the same floor forever.
    const { w, getDifference } = spied();
    seed(w, 100);
    w.handleMessage({ type: "agent_message", id: "a400", text: "answer 400", turnId: "t1", seq: 400 });
    w.handleMessage(reply(w, [], { partial: true, maxSeq: 200 }));

    expect(cursorLast(w)).toBe(200);
    expect(isCatchingUp(w)).toBe(true);
    expect(getDifference).toHaveBeenCalledTimes(2);
    expect(getDifference).toHaveBeenLastCalledWith(200, outstandingNonce(w));
  });

  it("#352 — THE REPRO: a partial reply plus a mid-flight ack no longer skips the range between them", () => {
    // The confirmed defect. Floor 100; the user sends during the gap so the ack
    // echoes seq 350; the reply covers only 101..300. The old code applied the
    // DEFERRED ack seq on top of the partial reply (`max(last, maxSeq,
    // pendingDeferredSeq)`) → cursor 350, and the drain then DISCARDED the held
    // 301..349. Nothing re-requested them.
    const { w, getDifference } = spied();
    seed(w, 100);
    // This device is the origin of the send, so its ack is its own receipt.
    seedOptimisticUser(w, {
      localId: "u-0", receiptKey: "r-0", randomId: "rand-1", text: "hello", wireId: "t9",
    });
    // A live frame at 400 opens the gap and is held.
    w.handleMessage({ type: "agent_message", id: "a400", text: "answer 400", turnId: "t1", seq: 400 });
    expect(getDifference).toHaveBeenCalledWith(100, outstandingNonce(w));

    // The ack lands MID-FLIGHT, carrying seq 350.
    w.handleMessage({
      type: "ack",
      ids: ["u-0"],
      committed: [{ random_id: "rand-1", messageId: "webchannel-user-350", seq: 350 }],
    });
    // The adoption still ran live…
    expect(userIds(w)).toEqual(["webchannel-user-350"]);
    // …and the cursor did NOT move: while a reply is owed, nothing else may move it.
    expect(cursorLast(w)).toBe(100);

    // The partial reply: 101..300.
    w.handleMessage(
      reply(
        w,
        [101, 300].map((seq) => ({
          seq,
          event: { kind: "bubble", answerId: `a${seq}`, text: `answer ${seq}`, turnId: "t1" },
        })),
        { partial: true, maxSeq: 300 },
      ),
    );

    // ⚠️ THE FIX: the cursor is at the reply's coverage, NOT at the ack's 350, and
    // the next request asks for exactly the un-fetched remainder.
    expect(cursorLast(w)).toBe(300);
    expect(getDifference).toHaveBeenCalledTimes(2);
    expect(getDifference).toHaveBeenLastCalledWith(300, outstandingNonce(w));

    // And the range completes with nothing skipped.
    w.handleMessage(
      reply(
        w,
        [301, 400].map((seq) => ({
          seq,
          event: { kind: "bubble", answerId: `a${seq}`, text: `answer ${seq}`, turnId: "t1" },
        })),
      ),
    );
    expect(cursorLast(w)).toBe(400);
    expect(isCatchingUp(w)).toBe(false);
    expect(project(w).map((m) => (m as { text: string }).text)).toEqual([
      "hello", "answer 101", "answer 300", "answer 301", "answer 400",
    ]);
  });

  it("#343 — a NON-partial reply settles at maxSeq, so an undeliverable row cannot wedge the device", () => {
    // The server SKIPS a row that alone exceeds this peer's max_payload and says
    // the reply is complete. The seq is inside the served range, so the client
    // advances past it: it is undeliverable, not missing. Freezing on it would
    // re-request the same unusable row forever.
    const { w, getDifference } = spied();
    seed(w, 1);
    w.handleMessage({ type: "agent_message", id: "a4", text: "answer 4", turnId: "t1", seq: 4 });
    w.handleMessage(
      reply(
        w,
        [
          { seq: 2, event: { kind: "bubble", answerId: "a2", text: "answer 2", turnId: "t1" } },
          // seq 3 is absent — the server could never send it to this peer.
          { seq: 4, event: { kind: "bubble", answerId: "a4", text: "answer 4", turnId: "t1" } },
        ],
        { maxSeq: 4 },
      ),
    );
    expect(cursorLast(w)).toBe(4);
    expect(isCatchingUp(w)).toBe(false);
    // The next live frame is contiguous — no re-request for the hole.
    w.handleMessage({ type: "agent_message", id: "a5", text: "answer 5", turnId: "t1", seq: 5 });
    expect(getDifference).toHaveBeenCalledTimes(1);
    expect(cursorLast(w)).toBe(5);
  });

  it("#356 — an empty COMPLETE reply with a frame still HELD is a stall, not an unwind", () => {
    // ⚠️ ROUND 2'S STORM, ARRIVING THROUGH THE `partial: false` DOOR. Settling on
    // a reply that covers nothing re-dispatches the buffer, the held frame
    // re-opens the same gap on the spot, and `openCatchUp` hands out a fresh
    // retry budget. Measured before this fix: 50 empty complete replies → 51
    // requests, no time passing. A held frame is evidence the gap was REAL, so an
    // answer that covers nothing is a stall whatever the flag says — the
    // spurious-gap unwind turns on the BUFFER, not on `partial`.
    vi.useFakeTimers();
    try {
      const { w, getDifference } = spied();
      seed(w, 4);
      w.handleMessage({ type: "agent_message", id: "a9", text: "answer 9", turnId: "t1", seq: 9 });
      expect(getDifference).toHaveBeenCalledTimes(1);

      for (let i = 0; i < 50; i++) w.handleMessage(reply(w, [], { maxSeq: 4 }));

      expect(getDifference).toHaveBeenCalledTimes(1);
      expect(isCatchingUp(w)).toBe(true);
      expect(cursorLast(w)).toBe(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it("THE REPRO: a live bubble the reply could not carry survives the catch-up", () => {
    // Cursor 1; the live `agent_message{seq:3}` ARRIVED (so its own send fit this
    // peer's wire) and is held behind the gap. The reply carries seq 2 and says
    // it covers through 3 — because the server SKIPPED row 3 as undeliverable
    // (#343). Dropping the held frame against the CURSOR loses a bubble the user
    // is already looking at, for the rest of the session.
    //
    // The band is real: a `difference` envelope around the same content is larger
    // than the live frame's that carried it, so a row inside that band is
    // live-deliverable and difference-undeliverable — #343's own razor edge,
    // arriving from the other side.
    const { w, getDifference } = spied();
    seed(w, 1);
    w.handleMessage({ type: "agent_message", id: "a3", text: "answer 3", turnId: "t1", seq: 3 });
    expect(getDifference).toHaveBeenCalledWith(1, outstandingNonce(w));
    w.handleMessage(
      reply(
        w,
        [{ seq: 2, event: { kind: "bubble", answerId: "a2", text: "answer 2", turnId: "t1" } }],
        { maxSeq: 3 },
      ),
    );

    // ⚠️ BOTH BUBBLES. seq 2 came from the reply; seq 3 was re-folded from the
    // buffer because no event in the reply carried it.
    expect(project(w).map((m) => (m as { text: string }).text)).toEqual([
      "answer 2", "answer 3",
    ]);
    expect(cursorLast(w)).toBe(3);
    expect(isCatchingUp(w)).toBe(false);
  });

  it("an INTERIOR skipped seq is not dropped either — the rule is the set, not a high-water", () => {
    // Events [2, 4] with row 3 skipped. A last-carried-seq high-water would be 4
    // and would drop a held frame at 3, which is the same loss one position over.
    const { w } = spied();
    seed(w, 1);
    w.handleMessage({ type: "agent_message", id: "a3", text: "answer 3", turnId: "t1", seq: 3 });
    w.handleMessage({ type: "agent_message", id: "a4", text: "answer 4", turnId: "t1", seq: 4 });
    w.handleMessage(
      reply(
        w,
        [
          { seq: 2, event: { kind: "bubble", answerId: "a2", text: "answer 2", turnId: "t1" } },
          { seq: 4, event: { kind: "bubble", answerId: "a4", text: "answer 4", turnId: "t1" } },
        ],
        { maxSeq: 4 },
      ),
    );

    // ⚠️ AND IN SEQ ORDER, NOT ARRIVAL ORDER. The held seq-3 frame folds BETWEEN
    // the reply's seq-2 and seq-4 events, which is where a reload's seq-ordered
    // projection puts it — rounds 3 and 4 re-dispatched it last and carried a
    // documented live≠history residual for it.
    expect(project(w).map((m) => (m as { text: string }).text)).toEqual([
      "answer 2", "answer 3", "answer 4",
    ]);
  });

  it("a frame carried by a PARTIAL slice is not re-folded after the next one lands", () => {
    // The buffer survives a slice boundary, so filtering it only on the final
    // re-dispatch would let a frame the FIRST reply carried fold after the
    // SECOND — and a `progress` is where that is visible rather than absorbed:
    // its live handler writes the DRAFT text, so re-folding it after the durable
    // `bubble` has landed overwrites an authored answer with a stale prefix.
    const { w } = spied();
    seed(w, 1);
    // seq 9 opens the gap; the live progress for lane A (seq 5) is then held.
    w.handleMessage({ type: "agent_message", id: "z9", text: "answer 9", turnId: "t1", seq: 9 });
    w.handleMessage({ type: "progress", id: "A", text: "Wor", turnId: "t1", seq: 5 });

    // Slice 1 carries seq 5 — the `placement` for that very lane — and stops.
    w.handleMessage(
      reply(
        w,
        [{ seq: 5, event: { kind: "placement", answerId: "A", turnId: "t1" } }],
        { partial: true, maxSeq: 5 },
      ),
    );
    expect(isCatchingUp(w)).toBe(true);

    // Slice 2 authors the answer and completes the range.
    w.handleMessage(
      reply(w, [
        { seq: 6, event: { kind: "bubble", answerId: "A", text: "final A", turnId: "t1" } },
        { seq: 9, event: { kind: "bubble", answerId: "z9", text: "answer 9", turnId: "t1" } },
      ], { maxSeq: 9 }),
    );

    // ⚠️ THE AUTHORED TEXT SURVIVES. Carried forward unfiltered, the held
    // progress re-folds here and takes A back to "Wor".
    const a = project(w).find((m) => (m as { id: string }).id === "A");
    expect((a as { text: string }).text).toBe("final A");
    expect(cursorLast(w)).toBe(9);
  });

  it("a `progress` at a CARRIED seq is kept — a placement carries no text", () => {
    // ⚠️ THE SEQ RULE ALONE BLANKS THE DRAFT THE USER IS WATCHING. A `progress`
    // maps to a `placement` row, which claims the slot and journals no text
    // (§15.9). So when the reply carries that seq, "already delivered" is true of
    // the SLOT and false of the TEXT — and dropping the held drafts leaves the
    // lane empty until the next frame, permanently if the answer stalls.
    // Re-folding one is an idempotent draft upsert on the same id.
    const { w } = spied();
    seed(w, 10);
    // seq 14 opens the gap; three drafts for lane A then arrive, all at the
    // placement's seq 12 (the journal dedupes `placement` on its answer id).
    w.handleMessage({ type: "agent_message", id: "z14", text: "answer 14", turnId: "t1", seq: 14 });
    w.handleMessage({ type: "progress", id: "A", text: "Wor", turnId: "t1", seq: 12 });
    w.handleMessage({ type: "progress", id: "A", text: "Working on", turnId: "t1", seq: 12 });
    w.handleMessage({ type: "progress", id: "A", text: "Working on it…", turnId: "t1", seq: 12 });

    // The reply carries the placement for that lane — and nothing that authors it.
    w.handleMessage(
      reply(w, [
        { seq: 11, event: { kind: "user", id: "webchannel-user-11", text: "go", turnId: "t1" } },
        { seq: 12, event: { kind: "placement", answerId: "A", turnId: "t1" } },
        { seq: 14, event: { kind: "bubble", answerId: "z14", text: "answer 14", turnId: "t1" } },
      ]),
    );

    // ⚠️ THE DRAFT SURVIVES, at its latest text.
    const draft = w.state.messages.find((m) => m.id === "A") as { text?: string } | undefined;
    expect(draft?.text).toBe("Working on it…");
    expect(cursorLast(w)).toBe(14);
  });

  it("#246 — a seq the reply could not DECODE does not drop the held frame that carries it", () => {
    // The reply carried an event for seq 2 and this build refused it, so nothing
    // was delivered for that seq. The held live frame at seq 2 is the only usable
    // copy; dropping it against "the reply carried this seq" loses it.
    const { w } = spied();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      seed(w, 1);
      w.handleMessage({ type: "agent_message", id: "a4", text: "answer 4", turnId: "t1", seq: 4 });
      // The live frame for seq 2 arrives and is held.
      w.handleMessage({
        type: "user_committed",
        id: "webchannel-user-2", text: "hello", turnId: "t1", seq: 2, random_id: "rand-1",
      });
      w.handleMessage(
        reply(w, [
          // Known kind, unusable shape — refused by `decodeDurableEvent`.
          { seq: 2, event: { kind: "user", id: "webchannel-user-2", turnId: "t1" } },
          { seq: 4, event: { kind: "bubble", answerId: "a4", text: "answer 4", turnId: "t1" } },
        ]),
      );

      // The held broadcast folded in the merge: the question is on the view.
      expect(userIds(w)).toEqual(["webchannel-user-2"]);
      // ⚠️ AND ABOVE THE ANSWER, WHERE IT BELONGS. Rounds 3 and 4 folded it after
      // the reply's rows and carried that as a documented live≠history residual;
      // the seq-ordered merge closes it — the held frame IS the row for seq 2, so
      // it folds in seq 2's place.
      expect(project(w).map((m) => (m as { text: string }).text)).toEqual(["hello", "answer 4"]);
    } finally {
      warn.mockRestore();
    }
  });

  it("#343/#356 — a seq-BEARING held frame is governed by its seq alone, never by its id", () => {
    // ⚠️ AN ID-AUTHORED DROP IS UNBOUNDED ABOVE THE RANGE THE REPLY COVERED, and a
    // tool card is the proof: tool rows are NOT deduped, so every phase is its own
    // row. A slice carrying `tool{T, phase:"start"}@12` must not drop a held
    // `tool_activity{T, phase:"end"}@20` — the next slice then skips row 20 as
    // undeliverable (#343) and the card stays "running" for the session.
    const { w } = spied();
    seed(w, 10);
    // seq 20 opens the gap and is held: the tool's END phase, already rendered.
    w.handleMessage({
      type: "tool_activity",
      id: "T", turnId: "t1", name: "bash", phase: "end", status: "ok", seq: 20,
    });
    // A slice carries the START phase for the SAME id, at a lower seq.
    w.handleMessage(
      reply(
        w,
        [{ seq: 12, event: { kind: "tool", id: "T", turnId: "t1", name: "bash", phase: "start" } }],
        { partial: true, maxSeq: 12 },
      ),
    );
    expect(isCatchingUp(w)).toBe(true);
    // The next slice completes the range WITHOUT row 20 (the server skipped it).
    w.handleMessage(
      reply(
        w,
        [{ seq: 15, event: { kind: "bubble", answerId: "a15", text: "answer 15", turnId: "t1" } }],
        { maxSeq: 20 },
      ),
    );

    // ⚠️ THE END PHASE SURVIVED, so the card is not stuck running.
    const tool = w.state.messages.find((m) => m.id === "T") as { phase?: string } | undefined;
    expect(tool?.phase).toBe("end");
    expect(cursorLast(w)).toBe(20);
  });

  it("#356 — a held NEWER row is not dropped because the reply authored an OLDER one for its id", () => {
    // ⚠️ THE DICHOTOMY ON ITS OWN. `bubble` rows are not deduped, so one answer id
    // can own several — an answer re-finalized after an edit is a second row at a
    // higher seq. The held `agent_message@20` IS that newer row, already rendered;
    // the reply carries the OLDER `bubble@12` for the same id. An id-keyed drop
    // would discard the newer text and leave the older one on the view.
    const { w } = spied();
    seed(w, 10);
    w.handleMessage({ type: "agent_message", id: "A", text: "final A (revised)", turnId: "t1", seq: 20 });
    w.handleMessage(
      reply(
        w,
        [{ seq: 12, event: { kind: "bubble", answerId: "A", text: "final A", turnId: "t1" } }],
        { maxSeq: 20 },
      ),
    );

    // ⚠️ THE NEWER TEXT WINS, because the held frame is governed by its SEQ (20,
    // which the reply never carried) and not by its id.
    const a = project(w).find((m) => (m as { id: string }).id === "A");
    expect((a as { text: string }).text).toBe("final A (revised)");
    expect(cursorLast(w)).toBe(20);
  });

  it("#343/#356 — an `approvalResolution` does not author the card, so a held request survives", () => {
    // ⚠️ THE `default: return [event.id]` DEFECT. `approvalResolution` carries no
    // content of its own and its id is the APPROVAL's, so a reply serving one
    // looked like it had authored the card — and the held `approval_request` the
    // user was looking at was dropped. Measured: view `[{id:"z20"}]`, card gone
    // for the session.
    const { w } = spied();
    seed(w, 9);
    w.handleMessage({ type: "agent_message", id: "z20", text: "answer 20", turnId: "t1", seq: 20 });
    // The live card arrives and is held.
    w.handleMessage({
      type: "approval_request",
      id: "ap1", kind: "exec", title: "run it", prompt: "ok?", options: [], seq: 11,
    });
    // The server skips row 11 as undeliverable (#343 — a free-form prompt) and
    // serves only the resolution for that same id.
    w.handleMessage(
      reply(
        w,
        [{ seq: 12, event: { kind: "approvalResolution", id: "ap1", decision: "allow-once" } }],
        { maxSeq: 20 },
      ),
    );

    // ⚠️ THE CARD IS STILL THERE *AND* IT IS RESOLVED. Presence alone passed on
    // the wrong state: re-applying the held request AFTER the folded resolution
    // appended a card with no `resolvedDecision`, i.e. a CLICKABLE prompt for an
    // approval the server had already answered. The seq-ordered merge folds the
    // request at seq 11 and the resolution at seq 12, in that order.
    const card = (w.state as unknown as {
      approvals: Array<{ id: string; resolvedDecision?: string; actionable?: boolean }>;
    }).approvals.find((a) => a.id === "ap1");
    expect(card).toBeDefined();
    expect(card?.resolvedDecision).toBe("allow-once");
    expect(card?.actionable).toBe(false);
    expect(cursorLast(w)).toBe(20);
  });

  it("#356 — a held tool phase BELOW the reply's rows does not overwrite the phase it delivered", () => {
    // P1 shape 1. Cursor 9; the live START phase opens the gap and is held; the
    // server skips row 11 as undeliverable (#343) and serves the END phase at 12.
    // Re-dispatched after the fold, the stale START overwrote the END through the
    // last-write-wins upsert and the card sat at `{phase:"start", status:"ok"}`
    // for the session — round 3 dropped it by id, round 4 reopened it in the
    // mirror direction. The merge folds seq 11 then seq 12.
    const { w } = spied();
    seed(w, 9);
    w.handleMessage({ type: "agent_message", id: "z20", text: "answer 20", turnId: "t1", seq: 20 });
    w.handleMessage({
      type: "tool_activity",
      id: "T", turnId: "t1", name: "bash", phase: "start", seq: 11,
    });
    w.handleMessage(
      reply(
        w,
        [
          {
            seq: 12,
            event: { kind: "tool", id: "T", turnId: "t1", name: "bash", phase: "end", status: "ok" },
          },
        ],
        { maxSeq: 20 },
      ),
    );

    const tool = w.state.messages.find((m) => m.id === "T") as {
      phase?: string; status?: string;
    } | undefined;
    expect(tool?.phase).toBe("end");
    expect(tool?.status).toBe("ok");
    expect(cursorLast(w)).toBe(20);
  });

  it("#356 — a held answer BELOW a folded seal does not survive the seal's `remove`", () => {
    // P1 shape 3, and the one where the old order silently RESURRECTED content.
    // The seal at seq 12 removes answer A; the held `agent_message{A}@11` — the
    // live rendering of the row the server skipped — re-applied after it and
    // brought A back. In seq order the answer folds first and the seal removes it.
    const { w } = spied();
    seed(w, 9);
    w.handleMessage({ type: "agent_message", id: "z20", text: "answer 20", turnId: "t1", seq: 20 });
    w.handleMessage({ type: "agent_message", id: "A", text: "abandoned", turnId: "t1", seq: 11 });
    w.handleMessage(
      reply(
        w,
        [
          {
            seq: 12,
            event: {
              kind: "seal",
              turnId: "t1",
              answers: [{ id: "B", text: "kept" }],
              remove: ["A"],
            },
          },
        ],
        { maxSeq: 20 },
      ),
    );

    expect(project(w).map((m) => (m as { id: string }).id)).not.toContain("A");
    expect(cursorLast(w)).toBe(20);
  });

  it("a held frame the reply DID carry is still dropped — no double-apply", () => {
    // The property the buffer exists for, unchanged: the reply is authoritative
    // for a row it carried, so the held copy of that same row must not re-fold.
    const { w } = spied();
    seed(w, 1);
    seedOptimisticUser(w, {
      localId: "u-0", receiptKey: "r-0", randomId: "rand-1", text: "hello", wireId: "t1",
    });
    w.handleMessage({ type: "agent_message", id: "a4", text: "answer 4", turnId: "t1", seq: 4 });
    // The multi-device broadcast for the same user row arrives DURING the
    // catch-up and is held; the reply then carries that very row.
    w.handleMessage({
      type: "user_committed",
      id: "webchannel-user-2", text: "hello", turnId: "t1", seq: 2, random_id: "rand-1",
    });
    w.handleMessage(
      reply(w, [
        { seq: 2, event: { kind: "user", id: "webchannel-user-2", text: "hello", turnId: "t1", randomId: "rand-1" } },
        { seq: 4, event: { kind: "bubble", answerId: "a4", text: "answer 4", turnId: "t1" } },
      ]),
    );

    expect(userIds(w)).toEqual(["webchannel-user-2"]);
    expect(project(w).map((m) => (m as { text: string }).text)).toEqual(["hello", "answer 4"]);
  });

  it("#343 — the give-up path carries nothing, so it drops nothing", () => {
    // No reply ever landed, so "the reply already delivered it" is false of every
    // held frame — including a repeated-seq `progress`, which the cursor ignores
    // and the view still needs.
    vi.useFakeTimers();
    try {
      const { w } = spied();
      seed(w, 5);
      seedOptimisticUser(w, {
        localId: "u-0", receiptKey: "r-0", randomId: "rand-1", text: "hello", wireId: "t1",
      });
      w.handleMessage({
        type: "ack",
        ids: ["u-0"],
        committed: [{ random_id: "rand-1", messageId: "webchannel-user-9", seq: 9 }],
      });
      // seq 6 opens the answer's lane, then two more draft frames REUSE seq 6
      // (the journal dedupes `placement` on its answer id).
      w.handleMessage({ type: "progress", id: "A", text: "Wor", turnId: "t1", seq: 6 });
      w.handleMessage({ type: "progress", id: "A", text: "Working on it…", turnId: "t1", seq: 6 });
      for (let i = 0; i < 4; i++) vi.advanceTimersByTime(5_000);

      const draft = w.state.messages.find((m) => m.id === "A") as { text?: string } | undefined;
      expect(draft?.text).toBe("Working on it…");
      expect(cursorLast(w)).toBe(6);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("#356 — a seq-less frame is HELD, and the reply's durable row supersedes it", () => {
  it("ORDER: a seq-less reasoning draft lands BELOW the rows the reply delivers", () => {
    // ⚠️ `reasoningDurable` IS OFF BY DEFAULT, so EVERY reasoning frame is
    // seq-less. Applying one immediately during a catch-up puts it above
    // everything the reply is about to fold — here, above the user question that
    // opened the turn — and `applyReasoning` upserts by id, so it stays there for
    // the session. A reload re-projects from seq order and disagrees: live ≠
    // history on the ordinary gap path.
    const { w } = spied();
    seed(w, 10);
    // seq 13 opens the gap and is held.
    w.handleMessage({ type: "agent_message", id: "a13", text: "answer 13", turnId: "t1", seq: 13 });
    expect(isCatchingUp(w)).toBe(true);
    // A seq-less reasoning draft arrives DURING the round-trip.
    w.handleMessage({ type: "reasoning", id: "r1", turnId: "t1", text: "thinking" });
    // Held, not applied: nothing is on the view yet.
    expect(w.state.messages).toHaveLength(0);

    // The reply delivers the rows BELOW it: the user opener and the first answer.
    w.handleMessage(
      reply(w, [
        { seq: 11, event: { kind: "user", id: "webchannel-user-11", text: "hello", turnId: "t1" } },
        { seq: 12, event: { kind: "bubble", answerId: "a12", text: "answer 12", turnId: "t1" } },
        { seq: 13, event: { kind: "bubble", answerId: "a13", text: "answer 13", turnId: "t1" } },
      ]),
    );

    // ⚠️ THE REASONING IS BELOW THE QUESTION THAT STARTED THE TURN, which is the
    // order a reload re-projects from seq.
    expect(w.state.messages.map((m) => m.id)).toEqual([
      "webchannel-user-11", "a12", "a13", "r1",
    ]);
    expect(cursorLast(w)).toBe(13);
  });

  it("NO OVERWRITE: a held draft whose id the reply AUTHORED is dropped, not re-folded", () => {
    // The other half, and the reason holding one is safe. A cumulative draft
    // re-folded after the durable row would take the text back to a prefix of
    // itself. `uncarried`'s first rule drops it: the reply authored that id.
    const { w } = spied();
    seed(w, 1);
    w.handleMessage({ type: "agent_message", id: "a4", text: "answer 4", turnId: "t1", seq: 4 });
    w.handleMessage({ type: "reasoning", id: "r1", turnId: "t1", text: "thinking par" });

    w.handleMessage(
      reply(w, [
        {
          seq: 2,
          event: { kind: "reasoning", id: "r1", turnId: "t1", text: "thinking paragraph, complete" },
        },
        { seq: 4, event: { kind: "bubble", answerId: "a4", text: "answer 4", turnId: "t1" } },
      ]),
    );

    const healed = w.state.messages.find((m) => m.id === "r1") as { text?: string } | undefined;
    expect(healed?.text).toBe("thinking paragraph, complete");
    expect(cursorLast(w)).toBe(4);
  });

  it("a held draft the reply did NOT author still folds, after the reply's rows", () => {
    // The complement: with `reasoningDurable` off there IS no durable reasoning
    // row, so nothing supersedes the draft and dropping it would lose the lane.
    const { w } = spied();
    seed(w, 1);
    w.handleMessage({ type: "agent_message", id: "a4", text: "answer 4", turnId: "t1", seq: 4 });
    w.handleMessage({ type: "reasoning", id: "r1", turnId: "t1", text: "thinking" });
    w.handleMessage(
      reply(w, [
        { seq: 2, event: { kind: "bubble", answerId: "a2", text: "answer 2", turnId: "t1" } },
        { seq: 4, event: { kind: "bubble", answerId: "a4", text: "answer 4", turnId: "t1" } },
      ]),
    );

    const held = w.state.messages.find((m) => m.id === "r1") as { text?: string } | undefined;
    expect(held?.text).toBe("thinking");
    expect(w.state.messages.map((m) => m.id)).toEqual(["a2", "a4", "r1"]);
  });

  it("a seq-less frame moves no cursor and opens no gap", () => {
    const { w, getDifference } = spied();
    seed(w, 1);
    w.handleMessage({ type: "agent_message", id: "a4", text: "answer 4", turnId: "t1", seq: 4 });
    expect(getDifference).toHaveBeenCalledTimes(1);
    w.handleMessage({ type: "reasoning", id: "r1", turnId: "t1", text: "thinking" });
    expect(getDifference).toHaveBeenCalledTimes(1);
    expect(cursorLast(w)).toBe(1);
    expect(isCatchingUp(w)).toBe(true);
  });
});

describe("#356 — a reply that answers NOTHING is a stall, not a settle", () => {
  it("THE REPRO: non-advancing partial replies cost ONE request, not one per reply", () => {
    // ⚠️ ROUND 2 GUARDED THIS AND THE GUARD WAS INERT IN THE ORDINARY CASE.
    // Settling at the unchanged floor re-dispatches the BUFFER; the held frame
    // that opened the gap is still beyond the cursor, so `observeSeq` re-opens
    // the catch-up on the spot — with `retries` back at 0, because `openCatchUp`
    // mints a fresh cursor. Measured before this fix: 50 replies → 51 requests,
    // `retries: 0`, no time passing, each one costing the server a read and a
    // byte fit. The guard only helped when the buffer was EMPTY.
    vi.useFakeTimers();
    try {
      const { w, getDifference } = spied();
      seed(w, 100);
      // A HELD FRAME IN THE BUFFER — the configuration round 2's guard missed.
      w.handleMessage({ type: "agent_message", id: "a400", text: "answer 400", turnId: "t1", seq: 400 });
      expect(getDifference).toHaveBeenCalledTimes(1);

      // A responding peer that answers nothing, 50 times, with no clock.
      for (let i = 0; i < 50; i++) {
        w.handleMessage(reply(w, [], { partial: true, maxSeq: 100 }));
      }

      // ⚠️ STILL ONE REQUEST. The round-trip never ended, so nothing re-opened it.
      expect(getDifference).toHaveBeenCalledTimes(1);
      expect(isCatchingUp(w)).toBe(true);
      expect(cursorLast(w)).toBe(100);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ["faster than the timeout", 50],
    ["at a second", 1_000],
    ["just inside the timeout", 4_999],
  ])("a stall at ANY cadence (%s) costs at most one request per timeout", (_label, cadence) => {
    // ⚠️ THE ROUND-3 BUG THIS REPLACES, AND WHY THE OLD TEST MISSED IT. Round 3
    // re-armed the timer on every stall, which is a FRESH
    // `GET_DIFFERENCE_TIMEOUT_MS` — so a peer stalling faster than that pushed
    // the deadline back forever and the timeout never fired: over 10 simulated
    // minutes at a 50 ms cadence, ONE request, still catching-up, nothing ever
    // re-asked. The old test advanced exactly 5 000 ms per stall, which is the one
    // cadence at which re-arming and not re-arming look the same. This one sweeps
    // three.
    //
    // ⚠️ WHAT IS BOUNDED IS THE REQUEST RATE, NOT THE BUFFER. Frames arriving
    // during a catch-up are held until a reply answers, however long that takes —
    // that is the design, and it is what makes the view correct when the answer
    // finally comes. The defect was not "frames accumulate"; it was that NOTHING
    // was ever asked again, so the answer could not come at all.
    vi.useFakeTimers();
    try {
      const { w, getDifference } = spied();
      seed(w, 100);
      // A HELD FRAME IN THE BUFFER — the configuration round 2's guard missed.
      w.handleMessage({ type: "agent_message", id: "a400", text: "answer 400", turnId: "t1", seq: 400 });
      expect(getDifference).toHaveBeenCalledTimes(1);

      // Ten simulated minutes of a peer that answers nothing, at this cadence.
      const elapsed = 10 * 60 * 1_000;
      for (let t = 0; t < elapsed; t += cadence) {
        if (isCatchingUp(w)) w.handleMessage(reply(w, [], { partial: true, maxSeq: 100 }));
        vi.advanceTimersByTime(cadence);
      }

      // ⚠️ THE BOUND IS THE TIMEOUT, NOT THE STALL CADENCE. Each give-up cycle is
      // `MAX_RETRIES + 1` requests over `MAX_RETRIES + 1` timeouts, so the rate
      // never exceeds one request per `GET_DIFFERENCE_TIMEOUT_MS` however fast
      // the peer replies.
      const ceiling = Math.ceil(elapsed / 5_000) + 1;
      expect(getDifference.mock.calls.length).toBeLessThanOrEqual(ceiling);
      // And it is not wedged either: the give-up cycles kept running, so the
      // stream is trying rather than frozen.
      expect(getDifference.mock.calls.length).toBeGreaterThan(ceiling / 2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a stall spends the ordinary budget and then gives up, re-dispatching the buffer", () => {
    vi.useFakeTimers();
    try {
      const { w, getDifference } = spied();
      seed(w, 100);
      w.handleMessage({ type: "agent_message", id: "a400", text: "answer 400", turnId: "t1", seq: 400 });

      // Each cycle: the peer answers nothing, then the ORIGINAL deadline fires.
      for (let i = 0; i < GET_DIFFERENCE_MAX_RETRIES; i++) {
        w.handleMessage(reply(w, [], { partial: true, maxSeq: 100 }));
        vi.advanceTimersByTime(5_000);
      }
      // Initial + MAX_RETRIES re-issues, exactly as a SILENT peer would cost.
      expect(getDifference).toHaveBeenCalledTimes(GET_DIFFERENCE_MAX_RETRIES + 1);
      expect(retriesOf(w)).toBe(GET_DIFFERENCE_MAX_RETRIES);

      // The budget is spent. Further stalls change nothing — only the DEADLINE
      // ends the round-trip, which is what keeps the rate at one request per
      // timeout however fast the peer answers.
      for (let i = 0; i < 20; i++) w.handleMessage(reply(w, [], { partial: true, maxSeq: 100 }));
      expect(getDifference).toHaveBeenCalledTimes(GET_DIFFERENCE_MAX_RETRIES + 1);

      // At the next deadline it gives up: settle, re-dispatch the held frame,
      // which re-opens the gap with a fresh budget. That is the steady state —
      // one cycle per (MAX_RETRIES + 1) timeouts.
      vi.advanceTimersByTime(5_000);
      expect(getDifference).toHaveBeenCalledTimes(GET_DIFFERENCE_MAX_RETRIES + 2);
      expect(retriesOf(w)).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("an EMPTY COMPLETE reply is not a stall — the spurious-gap unwind still closes", () => {
    // `partial: false` with no events is the server saying "there is nothing past
    // your floor". It moves no floor either, and it must still settle or a raced
    // detection would never close.
    const { w, getDifference } = spied();
    seed(w, 4);
    // A bare carrier opens the gap, so the buffer is empty and the settle is
    // observable on its own.
    seedOptimisticUser(w, {
      localId: "u-0", receiptKey: "r-0", randomId: "rand-1", text: "hello", wireId: "t1",
    });
    w.handleMessage({
      type: "ack",
      ids: ["u-0"],
      committed: [{ random_id: "rand-1", messageId: "webchannel-user-9", seq: 9 }],
    });
    expect(getDifference).toHaveBeenCalledTimes(1);

    w.handleMessage(reply(w, [], { maxSeq: 4 }));
    expect(isCatchingUp(w)).toBe(false);
    expect(getDifference).toHaveBeenCalledTimes(1);
    expect(cursorLast(w)).toBe(4);
  });
});

describe("#351 — a reply is folded only by the device that asked for it", () => {
  it("THE REPRO: another device's reply on the shared .out is ignored; this device's own reply heals", () => {
    // Device A is catching up from floor 1; device B, on the same peer and the
    // same `.out` subject, is catching up from floor 300. B's reply lands here
    // first. Before #356 the only gate was "is a request in flight", so A folded
    // B's events, jumped its cursor to B's max, and lost 2..300 in-session (N8).
    const { w, getDifference } = spied();
    seed(w, 1);
    w.handleMessage({ type: "agent_message", id: "a4", text: "answer 4", turnId: "t1", seq: 4 });
    const mine = outstandingNonce(w);
    expect(getDifference).toHaveBeenCalledWith(1, mine);

    // ── B's reply: same subject, a different request. Ignored whole. ──
    w.handleMessage({
      type: "difference",
      afterSeq: 300,
      nonce: "device-b-nonce",
      events: [
        { seq: 301, event: { kind: "bubble", answerId: "b301", text: "B's answer", turnId: "t9" } },
      ],
      partial: false,
      maxSeq: 301,
    });
    expect(project(w)).toEqual([]);
    expect(cursorLast(w)).toBe(1);
    expect(isCatchingUp(w)).toBe(true);
    expect(outstandingNonce(w)).toBe(mine);

    // ── A's own reply: same nonce AND same afterSeq. Folded. ──
    w.handleMessage(
      reply(w, [
        { seq: 2, event: { kind: "bubble", answerId: "a2", text: "answer 2", turnId: "t1" } },
        { seq: 3, event: { kind: "bubble", answerId: "a3", text: "answer 3", turnId: "t1" } },
        { seq: 4, event: { kind: "bubble", answerId: "a4", text: "answer 4", turnId: "t1" } },
      ]),
    );
    expect(project(w).map((m) => (m as { text: string }).text)).toEqual([
      "answer 2", "answer 3", "answer 4",
    ]);
    expect(cursorLast(w)).toBe(4);
  });

  it("a matching nonce with the WRONG afterSeq is still ignored", () => {
    // Both halves of the echo are checked: a reply that answers a different floor
    // is not the answer to this request even if the token collided.
    const { w } = spied();
    seed(w, 1);
    w.handleMessage({ type: "agent_message", id: "a4", text: "answer 4", turnId: "t1", seq: 4 });
    w.handleMessage({
      type: "difference",
      afterSeq: 2,
      nonce: outstandingNonce(w),
      events: [{ seq: 3, event: { kind: "bubble", answerId: "a3", text: "answer 3", turnId: "t1" } }],
      partial: false,
      maxSeq: 3,
    });
    expect(project(w)).toEqual([]);
    expect(cursorLast(w)).toBe(1);
    expect(isCatchingUp(w)).toBe(true);
  });

  it("drops a difference that lands with no request outstanding — no state change", () => {
    const { w, getDifference } = spied();
    seed(w, 5);
    const before = project(w);
    w.handleMessage({
      type: "difference",
      afterSeq: 5,
      nonce: "ghost",
      events: [
        { seq: 6, event: { kind: "user", id: "webchannel-user-6", text: "ghost", turnId: "t1" } },
      ],
      partial: false,
      maxSeq: 6,
    });
    expect(project(w)).toEqual(before);
    expect(cursorLast(w)).toBe(5);
    expect(getDifference).not.toHaveBeenCalled();
  });
});

describe("#244 half B — HIGH-2: get_difference is not fire-and-forget", () => {
  it("re-issues on timeout with a FRESH nonce, and a later difference heals", () => {
    vi.useFakeTimers();
    try {
      const { w, getDifference } = spied();
      seed(w, 5);
      w.handleMessage({ type: "agent_message", id: "a10", text: "answer 10", turnId: "t1", seq: 10 });
      const first = outstandingNonce(w);
      expect(getDifference).toHaveBeenCalledTimes(1);
      expect(getDifference).toHaveBeenCalledWith(5, first);

      // No difference arrives → after the timeout, exactly ONE re-request: same
      // afterSeq, a NEW nonce (so the two replies of the race stay separable).
      vi.advanceTimersByTime(5_000);
      expect(getDifference).toHaveBeenCalledTimes(2);
      const second = outstandingNonce(w);
      expect(second).not.toBe(first);
      expect(getDifference).toHaveBeenLastCalledWith(5, second);
      expect(isCatchingUp(w)).toBe(true);

      // A successful difference now heals it and STOPS the timer — no further
      // re-requests however long we wait.
      w.handleMessage(
        reply(w, [6, 7, 8, 9, 10].map((seq) => ({
          seq,
          event: { kind: "bubble", answerId: `a${seq}`, text: `answer ${seq}`, turnId: "t1" },
        }))),
      );
      expect(isCatchingUp(w)).toBe(false);
      vi.advanceTimersByTime(60_000);
      expect(getDifference).toHaveBeenCalledTimes(2);
      expect(project(w).map((m) => (m as { text: string }).text)).toEqual([
        "answer 6", "answer 7", "answer 8", "answer 9", "answer 10",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a reply to the SUPERSEDED nonce after a retry is ignored; the current one heals", () => {
    vi.useFakeTimers();
    try {
      const { w } = spied();
      seed(w, 1);
      w.handleMessage({ type: "agent_message", id: "a3", text: "answer 3", turnId: "t1", seq: 3 });
      const first = outstandingNonce(w);
      vi.advanceTimersByTime(5_000);
      const second = outstandingNonce(w);

      const events = [
        { seq: 2, event: { kind: "user", id: "webchannel-user-2", text: "hello", turnId: "t1" } },
        { seq: 3, event: { kind: "bubble", answerId: "a3", text: "answer 3", turnId: "t1" } },
      ];
      // The FIRST request's reply finally arrives — stale, and dropped whole.
      w.handleMessage({
        type: "difference", afterSeq: 1, nonce: first, events, partial: false, maxSeq: 3,
      });
      expect(project(w)).toEqual([]);
      expect(cursorLast(w)).toBe(1);

      // The current request's reply heals, exactly once.
      w.handleMessage({
        type: "difference", afterSeq: 1, nonce: second, events, partial: false, maxSeq: 3,
      });
      expect(project(w).map((m) => (m as { text: string }).text)).toEqual(["hello", "answer 3"]);
      // ⚠️ APPLIED TWICE (the #308 rule): re-delivering the same reply changes
      // nothing, because no request is outstanding any more.
      const healed = project(w);
      w.handleMessage({
        type: "difference", afterSeq: 1, nonce: second, events, partial: false, maxSeq: 3,
      });
      expect(project(w)).toEqual(healed);
      expect(userIds(w)).toEqual(["webchannel-user-2"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("#343 — gives up after bounded retries WITHOUT dropping the frames it can still fold", () => {
    // The old give-up DROPPED the buffer outright, so frames that had actually
    // arrived — and that the cursor could fold the moment it unfroze — were
    // thrown away and had to be re-fetched. Here the gap is opened by the ack's
    // seq (no frame to hold), and the two frames that arrive during the catch-up
    // are exactly the range the cursor was missing.
    vi.useFakeTimers();
    try {
      const { w, getDifference } = spied();
      seed(w, 5);
      seedOptimisticUser(w, {
        localId: "u-0", receiptKey: "r-0", randomId: "rand-1", text: "hello", wireId: "t1",
      });
      // This device's own ack echoes seq 9 — a gap against a cursor of 5.
      w.handleMessage({
        type: "ack",
        ids: ["u-0"],
        committed: [{ random_id: "rand-1", messageId: "webchannel-user-9", seq: 9 }],
      });
      expect(getDifference).toHaveBeenCalledTimes(1);
      // Two live frames arrive while the request is outstanding, and are held.
      w.handleMessage({ type: "agent_message", id: "a6", text: "answer 6", turnId: "t1", seq: 6 });
      w.handleMessage({ type: "agent_message", id: "a7", text: "answer 7", turnId: "t1", seq: 7 });
      // Initial + 3 retries = 4 requests, then it gives up.
      for (let i = 0; i < 4; i++) vi.advanceTimersByTime(5_000);

      // ⚠️ THE HELD FRAMES ARE RE-DISPATCHED, NOT DROPPED. seq 6 is contiguous
      // with the frozen cursor, so it folds; seq 7 is then contiguous with THAT.
      expect(project(w).map((m) => (m as { text: string }).text)).toEqual([
        "hello", "answer 6", "answer 7",
      ]);
      expect(cursorLast(w)).toBe(7);
      // Nothing is still gapped, so the give-up asked for nothing further.
      expect(getDifference).toHaveBeenCalledTimes(4);
      expect(isCatchingUp(w)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("after a give-up, a frame still beyond the cursor re-requests with a fresh budget", () => {
    vi.useFakeTimers();
    try {
      const { w, getDifference } = spied();
      seed(w, 5);
      w.handleMessage({ type: "agent_message", id: "a10", text: "answer 10", turnId: "t1", seq: 10 });
      for (let i = 0; i < 4; i++) vi.advanceTimersByTime(5_000);
      // The give-up re-dispatched the held seq-10 frame, which re-opened the gap
      // immediately with a fresh retry budget — the stream keeps trying to heal
      // rather than freezing until the next live frame.
      expect(getDifference).toHaveBeenCalledTimes(5);
      expect(isCatchingUp(w)).toBe(true);
      expect(cursorLast(w)).toBe(5);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("#345 — an ack's committed seq belongs to the device that sent it", () => {
  it("ORIGIN: an ack whose random_id resolves a local send advances the cursor", () => {
    const { w, getDifference } = spied();
    seed(w, 1);
    seedOptimisticUser(w, {
      localId: "u-0", receiptKey: "r-0", randomId: "rand-1", text: "hello", wireId: "t1",
    });
    w.handleMessage({
      type: "ack",
      ids: ["u-0"],
      committed: [{ random_id: "rand-1", messageId: "webchannel-user-2", seq: 2 }],
    });
    // The row IS held here — the optimistic bubble, re-keyed onto the server id —
    // so the cursor may cover it, and the turn's first agent frame is contiguous.
    expect(userIds(w)).toEqual(["webchannel-user-2"]);
    expect(cursorLast(w)).toBe(2);
    w.handleMessage({ type: "agent_message", id: "a3", text: "answer 3", turnId: "t1", seq: 3 });
    expect(getDifference).not.toHaveBeenCalled();
    expect(cursorLast(w)).toBe(3);
  });

  it("SHAPE A — NON-ORIGIN: the origin's ack must NOT close this device's gap", () => {
    // THE DEFECT. The ack rides the per-peer `.out`, which is the multi-device
    // fan-out, so every device receives the origin's ack. A non-origin device
    // that ALSO missed the `user_committed` broadcast advanced to seq 2 without
    // folding it — the turn's first agent frame at seq 3 was then contiguous, no
    // `get_difference` was ever sent, and the device rendered the answer with no
    // question until reconnect. This device has NO linkage for `rand-1`.
    const { w, getDifference } = spied();
    seed(w, 1);
    w.handleMessage({
      type: "ack",
      ids: ["u-0"],
      committed: [{ random_id: "rand-1", messageId: "webchannel-user-2", seq: 2 }],
    });
    expect(userIds(w)).toEqual([]);
    // The seq is ignored: it names a row this device has never seen.
    expect(cursorLast(w)).toBe(1);

    // …so the turn's first agent frame opens the gap that heals it.
    w.handleMessage({ type: "agent_message", id: "a3", text: "answer 3", turnId: "t1", seq: 3 });
    expect(getDifference).toHaveBeenCalledTimes(1);
    expect(getDifference).toHaveBeenCalledWith(1, outstandingNonce(w));
    w.handleMessage(
      reply(w, [
        { seq: 2, event: { kind: "user", id: "webchannel-user-2", text: "hello", turnId: "t1" } },
        { seq: 3, event: { kind: "bubble", answerId: "a3", text: "answer 3", turnId: "t1" } },
      ]),
    );
    // ⚠️ THE QUESTION IS BACK, above its answer.
    expect(project(w).map((m) => (m as { text: string }).text)).toEqual(["hello", "answer 3"]);
  });

  it("SHAPE B — an ack seq ABOVE the contiguous next seq is a GAP, not an advance", () => {
    // The origin device after a gap-sync gave up: the cursor sits at 1 with seqs
    // 2..5 un-fetched. The user sends; the ack echoes seq 6. Advance-only closed
    // the hole (`agent_message seq 7` was then contiguous) and 2..5 were never
    // re-fetched in-session. Under the three-way check the ack is a GAP.
    const { w, getDifference } = spied();
    seed(w, 1);
    seedOptimisticUser(w, {
      localId: "u-0", receiptKey: "r-0", randomId: "rand-1", text: "hello", wireId: "t1",
    });
    w.handleMessage({
      type: "ack",
      ids: ["u-0"],
      committed: [{ random_id: "rand-1", messageId: "webchannel-user-6", seq: 6 }],
    });
    expect(getDifference).toHaveBeenCalledTimes(1);
    expect(getDifference).toHaveBeenCalledWith(1, outstandingNonce(w));
    expect(cursorLast(w)).toBe(1);
  });

  it("an ack whose committed entry is malformed adopts nothing and moves no cursor", () => {
    const { w, getDifference } = spied();
    seed(w, 1);
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
    expect(cursorLast(w)).toBe(1);
    expect(getDifference).not.toHaveBeenCalled();
    // The linkage is NOT consumed: the echo never happened, so a real one still
    // has to be able to adopt this bubble.
    expect(w.randomIdToReceiptKey.has("rand-1")).toBe(true);
  });
});

describe("#345 — a snapshot high-water goes through the same check", () => {
  it("a reconnect snapshot above the contiguous next seq re-fetches instead of skipping", () => {
    // The cursor survives a reconnect (Telegram's app keeps its `pts`), so the
    // fresh snapshot's high-water is an ordinary observation. Above `last + 1` it
    // is a GAP: the traffic missed while disconnected gets fetched, where the old
    // advance-only rule jumped the cursor straight over it.
    const { w, getDifference } = spied();
    seed(w, 5);
    seed(w, 20);
    expect(getDifference).toHaveBeenCalledTimes(1);
    expect(getDifference).toHaveBeenCalledWith(5, outstandingNonce(w));
  });

  it("an unchanged or contiguous high-water asks for nothing", () => {
    const { w, getDifference } = spied();
    seed(w, 5);
    seed(w, 5);
    seed(w, 6);
    expect(getDifference).not.toHaveBeenCalled();
    expect(cursorLast(w)).toBe(6);
  });
});

describe("#244 half B — MED-3: a fold placement never blanks an authored answer", () => {
  it("keeps the authored text when a placement lands on an already-authored bubble", () => {
    // bubble A authored (seq2), then a placement for A re-served in a difference
    // (seq3). The live `progress` handler claims `draftOnly` only for an absent or
    // still-draft bubble; the fold must mirror that, or projectDurableFromClient
    // blanks the answer to "" (the "answer destroyed" case).
    const { w, getDifference } = spied();
    seed(w, 1);
    w.handleMessage({ type: "agent_message", id: "A", text: "final A", turnId: "t1", seq: 2 });
    // A gap-opening frame (seq4) is held; the difference re-delivers placement A (seq3).
    w.handleMessage({ type: "agent_message", id: "D", text: "final D", turnId: "t1", seq: 4 });
    expect(getDifference).toHaveBeenCalledWith(2, outstandingNonce(w));
    w.handleMessage(
      reply(w, [{ seq: 3, event: { kind: "placement", answerId: "A", turnId: "t1" } }], { maxSeq: 3 }),
    );

    // A keeps its authored text — NOT blanked to "".
    const a = project(w).find((m) => (m as { id: string }).id === "A");
    expect((a as { text: string }).text).toBe("final A");
    // And the held D re-dispatched in cleanly.
    expect(project(w).map((m) => (m as { text: string }).text)).toEqual(["final A", "final D"]);
  });
});

describe("#337 — a difference user event adopts an un-adopted optimistic bubble by random_id", () => {
  it("LOST ACK: re-keys the held bubble to the server id — exactly ONE user bubble", () => {
    // The ack for the send NEVER arrives, so the optimistic bubble stays at its
    // LOCAL id (`u-0`) — adoption runs only on the ack. The turn's first agent
    // frame (seq3) opens a gap, and the difference re-delivers the SAME user event
    // under the SERVER id `webchannel-user-2` carrying its `randomId`.
    const { w, getDifference } = spied();
    seed(w, 1);
    seedOptimisticUser(w, { localId: "u-0", receiptKey: "r-0", randomId: "rand-1", text: "hello", wireId: "t1" });
    expect(userIds(w)).toEqual(["u-0"]); // held at the local id, un-adopted

    w.handleMessage({ type: "agent_message", id: "a3", text: "answer 3", turnId: "t1", seq: 3 });
    expect(getDifference).toHaveBeenCalledWith(1, outstandingNonce(w));
    w.handleMessage(
      reply(w, [
        { seq: 2, event: { kind: "user", id: "webchannel-user-2", text: "hello", turnId: "t1", randomId: "rand-1" } },
        { seq: 3, event: { kind: "bubble", answerId: "a3", text: "answer 3", turnId: "t1" } },
      ]),
    );

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
    seed(w, 1);
    seedOptimisticUser(w, { localId: "u-0", receiptKey: "r-0", randomId: "rand-1", text: "hello", wireId: "t1" });

    w.handleMessage({ type: "agent_message", id: "a3", text: "answer 3", turnId: "t1", seq: 3 });
    expect(getDifference).toHaveBeenCalledWith(1, outstandingNonce(w));
    w.handleMessage(
      reply(w, [
        { seq: 2, event: { kind: "user", id: "webchannel-user-2", text: "hello", turnId: "t1" } },
        { seq: 3, event: { kind: "bubble", answerId: "a3", text: "answer 3", turnId: "t1" } },
      ]),
    );

    // The optimistic bubble is untouched (still `u-0`) and the final appended.
    expect(userIds(w)).toEqual(["u-0", "webchannel-user-2"]);
    // The linkage is left intact for a later ack to adopt.
    expect(w.randomIdToReceiptKey.get("rand-1")).toBe("r-0");
  });

  it("HAPPY PATH: ack adopted first drains the linkage — a re-delivered difference stays ONE bubble", () => {
    const { w, getDifference } = spied();
    seed(w, 1);
    seedOptimisticUser(w, { localId: "u-0", receiptKey: "r-0", randomId: "rand-1", text: "hello", wireId: "t1" });

    // seq4 opens the gap → get_difference(1) outstanding.
    w.handleMessage({ type: "agent_message", id: "a4", text: "answer 4", turnId: "t1", seq: 4 });
    expect(getDifference).toHaveBeenCalledWith(1, outstandingNonce(w));
    // The ack arrives mid-flight: adoptCommittedIds re-keys the bubble AND drains
    // the linkage (adoption runs live; the cursor stays frozen at the floor).
    w.handleMessage({
      type: "ack",
      ids: ["u-0"],
      committed: [{ random_id: "rand-1", messageId: "webchannel-user-2", seq: 2 }],
    });
    expect(userIds(w)).toEqual(["webchannel-user-2"]);
    expect(w.randomIdToReceiptKey.has("rand-1")).toBe(false);
    expect(cursorLast(w)).toBe(1);

    // The difference re-delivers the user event; the drained linkage → no re-key,
    // applyUser no-ops on the already-held id.
    w.handleMessage(
      reply(w, [
        { seq: 2, event: { kind: "user", id: "webchannel-user-2", text: "hello", turnId: "t1", randomId: "rand-1" } },
        { seq: 4, event: { kind: "bubble", answerId: "a4", text: "answer 4", turnId: "t1" } },
      ]),
    );
    expect(userIds(w)).toEqual(["webchannel-user-2"]);
  });

  it("LATE ACK: the fold adopts first — a later ack finds the linkage drained and skips", () => {
    const { w, getDifference } = spied();
    seed(w, 1);
    seedOptimisticUser(w, { localId: "u-0", receiptKey: "r-0", randomId: "rand-1", text: "hello", wireId: "t1" });

    w.handleMessage({ type: "agent_message", id: "a3", text: "answer 3", turnId: "t1", seq: 3 });
    expect(getDifference).toHaveBeenCalledWith(1, outstandingNonce(w));
    w.handleMessage(
      reply(w, [
        { seq: 2, event: { kind: "user", id: "webchannel-user-2", text: "hello", turnId: "t1", randomId: "rand-1" } },
        { seq: 3, event: { kind: "bubble", answerId: "a3", text: "answer 3", turnId: "t1" } },
      ]),
    );
    expect(userIds(w)).toEqual(["webchannel-user-2"]);

    // The late ack: adoptCommittedIds resolves rand-1 to undefined (fold drained
    // it) and skips. No second adopt, no throw — and no cursor move either, since
    // an entry with no linkage is not this device's receipt.
    w.handleMessage({
      type: "ack",
      ids: ["u-0"],
      committed: [{ random_id: "rand-1", messageId: "webchannel-user-2", seq: 2 }],
    });
    expect(userIds(w)).toEqual(["webchannel-user-2"]);
    expect(cursorLast(w)).toBe(3);
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
    const { w, getDifference } = spied();
    seed(w, 1);
    w.handleMessage(userCommitted(2));

    expect(userIds(w)).toEqual(["webchannel-user-2"]);
    const users = project(w).filter((m) => (m as { role?: string }).role === "user");
    expect((users[0] as { text: string }).text).toBe("hello");
    // The cursor advanced to the user opener's seq — so the turn's first agent
    // frame at seq3 is CONTIGUOUS, not a phantom gap.
    expect(cursorLast(w)).toBe(2);
    w.handleMessage({ type: "agent_message", id: "a3", text: "answer 3", turnId: "t1", seq: 3 });
    expect(getDifference).not.toHaveBeenCalled();
    expect(cursorLast(w)).toBe(3);
    expect(project(w).map((m) => (m as { text: string }).text)).toEqual(["hello", "answer 3"]);
  });

  it("ORIGIN, broadcast BEFORE ack: adopts the optimistic bubble; the later ack skips — ONE bubble", () => {
    const { w } = spied();
    seed(w, 1);
    seedOptimisticUser(w, { localId: "u-0", receiptKey: "r-0", randomId: "rand-1", text: "hello", wireId: "t1" });
    expect(userIds(w)).toEqual(["u-0"]);

    // The broadcast arrives first: adopt-by-random_id re-keys u-0 → server id and
    // drains the linkage; applyUser then no-ops on the now-held id.
    w.handleMessage(userCommitted(2));
    expect(userIds(w)).toEqual(["webchannel-user-2"]);
    expect(w.randomIdToReceiptKey.has("rand-1")).toBe(false);
    expect(cursorLast(w)).toBe(2);

    // The ack lands after: the linkage is drained, so it adopts nothing and moves
    // nothing. Still ONE bubble, cursor unchanged.
    w.handleMessage({
      type: "ack",
      ids: ["u-0"],
      committed: [{ random_id: "rand-1", messageId: "webchannel-user-2", seq: 2 }],
    });
    expect(userIds(w)).toEqual(["webchannel-user-2"]);
    expect(cursorLast(w)).toBe(2);
  });

  it("ORIGIN, ack BEFORE broadcast: ack adopts; the broadcast no-ops — ONE bubble", () => {
    const { w } = spied();
    seed(w, 1);
    seedOptimisticUser(w, { localId: "u-0", receiptKey: "r-0", randomId: "rand-1", text: "hello", wireId: "t1" });

    // The ack lands first: adopts u-0 → server id and drains the linkage.
    w.handleMessage({
      type: "ack",
      ids: ["u-0"],
      committed: [{ random_id: "rand-1", messageId: "webchannel-user-2", seq: 2 }],
    });
    expect(userIds(w)).toEqual(["webchannel-user-2"]);
    expect(cursorLast(w)).toBe(2);

    // The broadcast follows: adopt resolves rand-1 → undefined (drained) → no re-key,
    // and applyUser no-ops on the already-held server id. Still ONE bubble.
    w.handleMessage(userCommitted(2));
    expect(userIds(w)).toEqual(["webchannel-user-2"]);
    expect(cursorLast(w)).toBe(2);
  });

  it("MISSED broadcast: the gap-sync fallback still converges (non-origin), ack included", () => {
    // ⚠️ THE ACK IS PART OF THIS TEST NOW, AND ITS ABSENCE IS WHY THE OLD VERSION
    // PASSED OVER #345. Production emits the broadcast AND the ack for the same
    // send; a non-origin device that missed only the broadcast still receives the
    // ack, and under the old advance-only rule that ack closed the gap.
    const { w, getDifference } = spied();
    seed(w, 1);
    // NO userCommitted(2) delivered — the broadcast was missed. The ack is not.
    w.handleMessage({
      type: "ack",
      ids: ["u-0"],
      committed: [{ random_id: "rand-1", messageId: "webchannel-user-2", seq: 2 }],
    });
    w.handleMessage({ type: "agent_message", id: "a3", text: "answer 3", turnId: "t1", seq: 3 });
    expect(getDifference).toHaveBeenCalledWith(1, outstandingNonce(w));
    w.handleMessage(
      reply(w, [
        { seq: 2, event: { kind: "user", id: "webchannel-user-2", text: "hello", turnId: "t1", randomId: "rand-1" } },
        { seq: 3, event: { kind: "bubble", answerId: "a3", text: "answer 3", turnId: "t1" } },
      ]),
    );

    expect(userIds(w)).toEqual(["webchannel-user-2"]);
    expect(project(w).map((m) => (m as { text: string }).text)).toEqual(["hello", "answer 3"]);
    expect(cursorLast(w)).toBe(3);
    expect(isCatchingUp(w)).toBe(false);
  });

  it("broadcast THEN a later difference re-delivering the same event → still ONE bubble", () => {
    const { w, getDifference } = spied();
    seed(w, 1);
    w.handleMessage(userCommitted(2));
    expect(userIds(w)).toEqual(["webchannel-user-2"]);
    expect(cursorLast(w)).toBe(2);

    // A later agent frame at seq5 opens a gap (seqs 3,4 dropped) → get_difference(2),
    // and the server's difference re-carries seq2's user event alongside the missed
    // range.
    w.handleMessage({ type: "agent_message", id: "a5", text: "answer 5", turnId: "t1", seq: 5 });
    expect(getDifference).toHaveBeenCalledWith(2, outstandingNonce(w));
    w.handleMessage(
      reply(w, [
        { seq: 2, event: { kind: "user", id: "webchannel-user-2", text: "hello", turnId: "t1", randomId: "rand-1" } },
        { seq: 3, event: { kind: "bubble", answerId: "a3", text: "answer 3", turnId: "t1" } },
        { seq: 4, event: { kind: "bubble", answerId: "a4", text: "answer 4", turnId: "t1" } },
        { seq: 5, event: { kind: "bubble", answerId: "a5", text: "answer 5", turnId: "t1" } },
      ]),
    );

    // The re-delivered user event did NOT duplicate — one user bubble, held id.
    expect(userIds(w)).toEqual(["webchannel-user-2"]);
    expect(project(w).map((m) => (m as { text: string }).text)).toEqual([
      "hello", "answer 3", "answer 4", "answer 5",
    ]);
    expect(cursorLast(w)).toBe(5);
  });

  it("a user_committed that never arrives still converges through gap-sync (at-most-once drop)", () => {
    // The frame is never delivered — which is what an at-most-once core-NATS drop
    // looks like from the wrapper's side: no cursor advance, no fold, no signal.
    //
    // ⚠️ THIS USED TO BE NAMED FOR AN "OLDER CLIENT" AND IT IS THE SAME TEST, ONLY
    // HONESTLY LABELLED. #246 took the wire to v4 with an exact-match register
    // gate, so a client that does not handle `user_committed` is REFUSED and is no
    // longer a reachable peer; the behaviour pinned here is not back-compat but the
    // at-most-once guarantee (`channel-contract.ts`'s `user_committed` docblock),
    // which is why it is still worth pinning. Do not delete it as "dead compat".
    const { w, getDifference } = spied();
    seed(w, 1);
    w.handleMessage({ type: "agent_message", id: "a3", text: "answer 3", turnId: "t1", seq: 3 });
    expect(getDifference).toHaveBeenCalledWith(1, outstandingNonce(w));
    w.handleMessage(
      reply(w, [
        { seq: 2, event: { kind: "user", id: "webchannel-user-2", text: "hello", turnId: "t1", randomId: "rand-1" } },
        { seq: 3, event: { kind: "bubble", answerId: "a3", text: "answer 3", turnId: "t1" } },
      ]),
    );
    expect(project(w).map((m) => (m as { text: string }).text)).toEqual(["hello", "answer 3"]);
  });
});

/**
 * #246 half A — THE CURSOR INVARIANT: a seq-bearing frame advances the cursor
 * IFF it was folded.
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
    seed(w, 1);
    w.handleMessage(malformedUserCommitted(2));

    // Nothing folded — and, the load-bearing half, nothing advanced.
    expect(userIds(w)).toEqual([]);
    expect(cursorLast(w)).toBe(1);
    // Refusing is not itself a gap: the frame simply did not happen.
    expect(getDifference).not.toHaveBeenCalled();
  });

  it("the NEXT well-formed frame then reads as a gap and requests get_difference(afterSeq=N)", () => {
    const { w, getDifference } = spied();
    seed(w, 1);
    w.handleMessage(malformedUserCommitted(2)); // refused; cursor stays 1
    w.handleMessage({ type: "agent_message", id: "a3", text: "answer 3", turnId: "t1", seq: 3 });

    expect(getDifference).toHaveBeenCalledTimes(1);
    expect(getDifference).toHaveBeenCalledWith(1, outstandingNonce(w));
    expect(isCatchingUp(w)).toBe(true);
  });

  it("the difference re-serves the canonical row → the view equals a clean delivery", () => {
    // A: the well-formed stream, no refusal anywhere.
    const a = spied();
    seed(a.w, 1);
    a.w.handleMessage({
      type: "user_committed",
      id: "webchannel-user-2", text: "hello", turnId: "t1", seq: 2, random_id: "rand-1",
    });
    a.w.handleMessage({ type: "agent_message", id: "a3", text: "answer 3", turnId: "t1", seq: 3 });

    // B: the same stream, but the broadcast arrives malformed and is refused.
    const b = spied();
    seed(b.w, 1);
    b.w.handleMessage(malformedUserCommitted(2));
    b.w.handleMessage({ type: "agent_message", id: "a3", text: "answer 3", turnId: "t1", seq: 3 });
    expect(b.getDifference).toHaveBeenCalledWith(1, outstandingNonce(b.w));
    const difference = reply(b.w, [
      { seq: 2, event: { kind: "user", id: "webchannel-user-2", text: "hello", turnId: "t1", randomId: "rand-1" } },
      { seq: 3, event: { kind: "bubble", answerId: "a3", text: "answer 3", turnId: "t1" } },
    ]);
    b.w.handleMessage(difference);

    // ⚠️ THE HEAL: the row the malformed frame carried is back, exactly once, and
    // the two devices' durable views are byte-identical.
    expect(project(b.w)).toEqual(project(a.w));
    expect(userIds(b.w)).toEqual(["webchannel-user-2"]);
    expect(cursorLast(b.w)).toBe(3);
    expect(isCatchingUp(b.w)).toBe(false);

    // APPLIED TWICE (the rule from #308): re-deliver the identical difference.
    // It changes nothing because no request is outstanding — the stale-reply
    // guard drops it whole — which is the property that has to survive, since a
    // retry double-reply delivers exactly this.
    const healed = project(b.w);
    b.w.handleMessage(difference);
    expect(project(b.w)).toEqual(healed);
    expect(userIds(b.w)).toEqual(["webchannel-user-2"]);
    expect(cursorLast(b.w)).toBe(3);
  });

  it("a malformed KNOWN-kind event inside a difference is SKIPPED and its seq still advances", () => {
    // The catch-up door's OPPOSITE rule: a difference is the authoritative answer
    // to a gap, so a row it cannot fold must not freeze the cursor — that would
    // re-request the same unusable row forever.
    const { w, getDifference } = spied();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      seed(w, 1);
      w.handleMessage({ type: "agent_message", id: "a4", text: "answer 4", turnId: "t1", seq: 4 });
      expect(getDifference).toHaveBeenCalledWith(1, outstandingNonce(w));
      w.handleMessage(
        reply(w, [
          // Known kind, unusable shape: a `bubble` with no text.
          { seq: 2, event: { kind: "bubble", answerId: "a2", turnId: "t1" } },
          { seq: 3, event: { kind: "bubble", answerId: "a3", text: "answer 3", turnId: "t1" } },
          { seq: 4, event: { kind: "bubble", answerId: "a4", text: "answer 4", turnId: "t1" } },
        ]),
      );

      // seq2 was not folded, seq3/seq4 were, and the cursor cleared the whole range.
      expect(project(w).map((m) => (m as { text: string }).text)).toEqual([
        "answer 3", "answer 4",
      ]);
      expect(cursorLast(w)).toBe(4);
      expect(isCatchingUp(w)).toBe(false);
      // No re-request loop: the catch-up closed on the first round-trip.
      expect(getDifference).toHaveBeenCalledTimes(1);
      // The skip is REPORTED — an unknown kind is version skew, a malformed known
      // kind is a defect upstream and must not be silent.
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("skipping malformed bubble event"));
    } finally {
      warn.mockRestore();
    }
  });

  it("a difference carrying a seal with no answers cannot wedge gap-sync", () => {
    // `foldDifferenceEvent`'s `case "seal"` iterates `event.answers` BEFORE the
    // reducer sees it, so a missing `answers` threw INSIDE the fold. The throw is
    // swallowed by the client's listener dispatch, which would leave the cursor
    // stuck in `catching-up` with its liveness timer already cancelled — every
    // later durable frame held forever, in silence.
    const { w, getDifference } = spied();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      seed(w, 1);
      w.handleMessage({ type: "agent_message", id: "a4", text: "answer 4", turnId: "t1", seq: 4 });
      expect(getDifference).toHaveBeenCalledWith(1, outstandingNonce(w));

      expect(() =>
        w.handleMessage(
          reply(w, [
            { seq: 2, event: { kind: "bubble", answerId: "a2", text: "answer 2", turnId: "t1" } },
            // The wedge: a `seal` with no `answers` at all.
            { seq: 3, event: { kind: "seal", turnId: "t1" } },
            { seq: 4, event: { kind: "bubble", answerId: "a4", text: "answer 4", turnId: "t1" } },
          ]),
        ),
      ).not.toThrow();

      // Skipped, not folded — and the whole range still cleared.
      expect(cursorLast(w)).toBe(4);
      expect(isCatchingUp(w)).toBe(false);
      expect(project(w).map((m) => (m as { text: string }).text)).toEqual([
        "answer 2", "answer 4",
      ]);

      // And the stream is LIVE again: the next contiguous frame folds normally
      // rather than being held behind a stuck cursor.
      w.handleMessage({ type: "agent_message", id: "a5", text: "answer 5", turnId: "t1", seq: 5 });
      expect(cursorLast(w)).toBe(5);
      expect(getDifference).toHaveBeenCalledTimes(1);
      expect(project(w).map((m) => (m as { text: string }).text)).toEqual([
        "answer 2", "answer 4", "answer 5",
      ]);
    } finally {
      warn.mockRestore();
    }
  });

  it("#356 — a listener that closes the client during the fold is not overridden by the transition", () => {
    // `applyDurable` runs reducers and public listeners, and a listener may call
    // `close()` — which runs `resetCursorForConnection` and lands a valid `synced`
    // cursor with no timer and no buffer. The `finally` then transitioned on top
    // of it and re-entered `catching-up` ON A CLOSED CLIENT: a request nothing
    // will answer, a timer nothing will clear. Object identity is the same test
    // the timer uses.
    const { w, getDifference } = spied();
    seed(w, 1);
    w.handleMessage({ type: "agent_message", id: "a4", text: "answer 4", turnId: "t1", seq: 4 });
    expect(getDifference).toHaveBeenCalledTimes(1);

    const instance = w as unknown as {
      foldDifferenceEvent?: () => void;
      close: () => void;
    };
    instance.foldDifferenceEvent = () => {
      instance.close();
    };
    // A PARTIAL reply, so the un-guarded path would re-open the catch-up.
    w.handleMessage(
      reply(
        w,
        [{ seq: 2, event: { kind: "bubble", answerId: "a2", text: "answer 2", turnId: "t1" } }],
        { partial: true, maxSeq: 2 },
      ),
    );

    expect(isCatchingUp(w)).toBe(false);
    expect(getDifference).toHaveBeenCalledTimes(1);
  });

  it("a fold that throws cannot wedge gap-sync — it stalls, on the timer's cadence", () => {
    // The test above proves the VALIDATOR keeps the known throw out of the arm.
    // This one DEFEATS the validator — a perfectly well-formed event, a fold made
    // to throw — because the property that must hold is not "this event shape is
    // handled" but "no throw from the fold can wedge gap-sync".
    //
    // ⚠️ AND A THROW BEFORE THE FIRST EVENT LANDS IS A STALL, NOT A SETTLE. The
    // client learned nothing, so the request is in effect still outstanding: the
    // cursor, its retry budget AND its deadline all stay untouched, and NOTHING is
    // re-issued on this turn. Settling instead would re-dispatch the
    // buffer, re-open the gap and re-request immediately with a fresh budget —
    // and a deterministic throw makes that a loop at round-trip speed (measured:
    // 21 requests over 20 replies).
    //
    // ⚠️ THE SERVER'S `maxSeq` MUST NOT PAPER OVER IT EITHER. The reply says "you
    // are synced to 2"; the fold of seq 2 threw, so the client is NOT, and the
    // cursor stays at 1. `completed` is what makes the difference between
    // degrading honestly and claiming a range that was never applied.
    vi.useFakeTimers();
    try {
      const { w, getDifference } = spied();
      seed(w, 1);
      w.handleMessage({ type: "agent_message", id: "a3", text: "answer 3", turnId: "t1", seq: 3 });
      expect(getDifference).toHaveBeenCalledTimes(1);
      const first = outstandingNonce(w);

      const instance = w as unknown as { foldDifferenceEvent?: () => void };
      const thrower = reply(
        w,
        [{ seq: 2, event: { kind: "bubble", answerId: "a2", text: "answer 2", turnId: "t1" } }],
        { maxSeq: 2 },
      );
      instance.foldDifferenceEvent = () => {
        throw new Error("fold blew up");
      };
      // The throw escapes THIS call because the test drives `handleMessage`
      // directly; in production `notifyMessageListeners` swallows it, which is
      // exactly why the cleanup cannot live after the loop.
      expect(() => w.handleMessage(thrower)).toThrow("fold blew up");

      // Nothing folded, so the cursor did NOT move past the failed event…
      expect(cursorLast(w)).toBe(1);
      // …and nothing was re-issued on this turn: the round-trip is still open.
      expect(getDifference).toHaveBeenCalledTimes(1);
      expect(isCatchingUp(w)).toBe(true);

      // The re-issue comes from the TIMER, with a fresh nonce, on the ordinary
      // cadence. THAT is the difference between degrading and wedging.
      delete instance.foldDifferenceEvent;
      vi.advanceTimersByTime(5_000);
      expect(getDifference).toHaveBeenCalledTimes(2);
      expect(getDifference).toHaveBeenLastCalledWith(1, outstandingNonce(w));
      expect(outstandingNonce(w)).not.toBe(first);

      // End to end: with the fold working again, the re-issued request heals the
      // stream exactly as an ordinary one does.
      w.handleMessage(
        reply(w, [
          { seq: 2, event: { kind: "bubble", answerId: "a2", text: "answer 2", turnId: "t1" } },
          { seq: 3, event: { kind: "bubble", answerId: "a3", text: "answer 3", turnId: "t1" } },
        ]),
      );
      expect(project(w).map((m) => (m as { text: string }).text)).toEqual([
        "answer 2", "answer 3",
      ]);
      expect(cursorLast(w)).toBe(3);
      expect(isCatchingUp(w)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
