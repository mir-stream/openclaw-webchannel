import { describe, it, expect, vi } from "vitest";
import { createInboundDebouncer } from "openclaw/plugin-sdk/reply-runtime";

import {
  coalesceUserMessages,
  createSerializedInboundDispatcher,
  type UserMessageLike,
} from "./inbound-queue.js";
import { isControlLaneMessage } from "./control-lane.js";
import type { InboundWsMessage } from "./channel-contract.js";

/**
 * P1-8b — the two inbound-smoothing seams as wired in index-nats.ts.
 *
 *  1. Layer (a): core's `createInboundDebouncer` sitting IN FRONT of the FIFO.
 *     We drive the REAL debouncer (no mock) so this pins the exact behavior the
 *     wiring relies on: same-peer messages inside the window flush together as
 *     one merged turn, and `cancelKey` drops them before they flush.
 *
 *  2. The /stop routing seam: a control-lane abort must drop this peer's buffered
 *     input on BOTH layers (`debouncer.cancelKey` + `dispatcher.clearPending`)
 *     before the abort turn dispatches. We mirror index-nats.ts's routing branch
 *     exactly (like control-lane.test.ts does for the P1-8a bypass) and assert
 *     the drains fire for /stop but not for ordinary text.
 */

const um = (text: string): UserMessageLike => ({ type: "user_message", text });
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("inbound debounce layer (a) — real createInboundDebouncer", () => {
  type Item = { peerId: string; message: UserMessageLike };
  const item = (peerId: string, text: string): Item => ({
    peerId,
    message: um(text),
  });

  it("coalesces two same-peer enqueues within the window into ONE merged flush", async () => {
    const flushes: UserMessageLike[] = [];
    const debouncer = createInboundDebouncer<Item>({
      debounceMs: 20,
      serializeImmediate: true,
      buildKey: (i) => i.peerId,
      onFlush: async (items) => {
        flushes.push(coalesceUserMessages(items.map((i) => i.message)));
      },
    });

    void debouncer.enqueue(item("p1", "a"));
    void debouncer.enqueue(item("p1", "b"));

    // Still inside the debounce window: nothing has flushed yet.
    await wait(5);
    expect(flushes).toEqual([]);

    // After the window elapses, both land in a single merged flush.
    await wait(40);
    expect(flushes).toEqual([{ type: "user_message", text: "a\n\nb" }]);
  });

  it("keeps different peers on independent windows (no cross-peer merge)", async () => {
    const flushes: UserMessageLike[] = [];
    const debouncer = createInboundDebouncer<Item>({
      debounceMs: 20,
      serializeImmediate: true,
      buildKey: (i) => i.peerId,
      onFlush: async (items) => {
        flushes.push(coalesceUserMessages(items.map((i) => i.message)));
      },
    });

    void debouncer.enqueue(item("p1", "a"));
    void debouncer.enqueue(item("p2", "z"));
    await wait(40);

    // Two flushes, one per peer — never merged across peers.
    expect(flushes).toEqual([um("a"), um("z")]);
  });

  it("cancelKey drops a peer's buffered items before they flush", async () => {
    const flushes: UserMessageLike[] = [];
    const debouncer = createInboundDebouncer<Item>({
      debounceMs: 20,
      serializeImmediate: true,
      buildKey: (i) => i.peerId,
      onFlush: async (items) => {
        flushes.push(coalesceUserMessages(items.map((i) => i.message)));
      },
    });

    void debouncer.enqueue(item("p1", "a"));
    void debouncer.enqueue(item("p1", "b"));
    expect(debouncer.cancelKey("p1")).toBe(true);

    await wait(40);
    // Nothing flushed — the buffered burst was discarded.
    expect(flushes).toEqual([]);
    // Cancelling an idle key reports false.
    expect(debouncer.cancelKey("p1")).toBe(false);
  });
});

describe("inbound /stop routing seam (both buffer layers drained)", () => {
  /**
   * The exact routing branch index-nats.ts runs per inbound `user_message`
   * frame: a control-lane abort drops this peer's buffered input on BOTH layers
   * (the pre-run debounce buffer AND the busy-time coalesce buffer) before
   * dispatching the abort turn; ordinary text is enqueued onto the debouncer
   * (layer a → FIFO → layer b).
   */
  function route(
    peerId: string,
    message: InboundWsMessage,
    seam: {
      debouncer: { cancelKey: (key: string) => boolean };
      dispatcher: { clearPending: (key: string) => unknown[] };
      controlLane: (peerId: string, message: InboundWsMessage) => void;
      enqueue: (peerId: string, message: InboundWsMessage) => void;
    },
  ): void {
    if (message.type !== "user_message") return;
    if (isControlLaneMessage(message)) {
      seam.debouncer.cancelKey(peerId);
      seam.dispatcher.clearPending(peerId);
      seam.controlLane(peerId, message);
      return;
    }
    seam.enqueue(peerId, message);
  }

  it("routes /stop to cancelKey + clearPending + the control handler (never the debouncer)", () => {
    const seam = {
      debouncer: { cancelKey: vi.fn(() => true) },
      dispatcher: { clearPending: vi.fn(() => [{}, {}]) },
      controlLane: vi.fn(),
      enqueue: vi.fn(),
    };

    route("p1", um("/stop"), seam);

    expect(seam.debouncer.cancelKey).toHaveBeenCalledWith("p1");
    expect(seam.dispatcher.clearPending).toHaveBeenCalledWith("p1");
    expect(seam.controlLane).toHaveBeenCalledTimes(1);
    expect(seam.enqueue).not.toHaveBeenCalled();
  });

  it("routes ordinary text to the debouncer (no buffer drop, no control handler)", () => {
    const seam = {
      debouncer: { cancelKey: vi.fn(() => false) },
      dispatcher: { clearPending: vi.fn(() => []) },
      controlLane: vi.fn(),
      enqueue: vi.fn(),
    };

    route("p1", um("what is the weather"), seam);

    expect(seam.enqueue).toHaveBeenCalledTimes(1);
    expect(seam.enqueue).toHaveBeenCalledWith("p1", um("what is the weather"));
    expect(seam.debouncer.cancelKey).not.toHaveBeenCalled();
    expect(seam.dispatcher.clearPending).not.toHaveBeenCalled();
    expect(seam.controlLane).not.toHaveBeenCalled();
  });

  it("clearPending on the real coalescing dispatcher reports the dropped count for /stop", () => {
    // End-to-end shape of the drain the seam performs: a real coalescing
    // dispatcher with a buffered burst reports the count clearPending discards.
    const dispatcher = createSerializedInboundDispatcher<UserMessageLike>(
      // Never settles: the first turn stays running so M2/M3 buffer.
      () => new Promise<void>(() => {}),
      { coalesce: coalesceUserMessages },
    );
    dispatcher.dispatch("p1", um("m1"));
    dispatcher.dispatch("p1", um("m2"));
    dispatcher.dispatch("p1", um("m3"));
    expect(dispatcher.pendingBuffered("p1")).toBe(2);
    expect(dispatcher.clearPending("p1")).toEqual([um("m2"), um("m3")]);
    expect(dispatcher.pendingBuffered("p1")).toBe(0);
  });
});
