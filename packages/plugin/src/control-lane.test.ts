import { describe, it, expect } from "vitest";

import { isControlLaneMessage } from "./control-lane.js";
import { createSerializedInboundDispatcher } from "./inbound-queue.js";
import type { InboundWsMessage } from "./transport.js";

/**
 * P1-8a — the out-of-band control lane. Two seams are covered here:
 *
 *  1. `isControlLaneMessage` — the routing PREDICATE that decides whether an
 *     inbound frame is an abort ("/stop") that must bypass the FIFO. We call the
 *     real `isAbortRequestText` through it (no mocking), so this also pins that
 *     the vocabulary we rely on ("/stop", "stop", …) actually matches.
 *
 *  2. The BYPASS itself — a control-lane message routed out-of-band must run
 *     even while a normal turn is still occupying the per-session FIFO. We mirror
 *     index-nats.ts's routing branch exactly and prove the abort handler runs
 *     while a never-resolving queued turn holds the chain.
 */

const userMessage = (text: string): InboundWsMessage => ({ type: "user_message", text });

describe("isControlLaneMessage", () => {
  it("is true for abort requests ('/stop', 'stop', 'Stop.')", () => {
    expect(isControlLaneMessage(userMessage("/stop"))).toBe(true);
    expect(isControlLaneMessage(userMessage("stop"))).toBe(true);
    expect(isControlLaneMessage(userMessage("Stop."))).toBe(true);
  });

  it("is false for ordinary user text", () => {
    expect(isControlLaneMessage(userMessage("what is the weather"))).toBe(false);
    expect(isControlLaneMessage(userMessage("please continue"))).toBe(false);
    expect(isControlLaneMessage(userMessage(""))).toBe(false);
  });

  it("is false for non-user_message frames (approvals, history)", () => {
    expect(
      isControlLaneMessage({ type: "approval_decision", id: "a1", decision: "allow-once" }),
    ).toBe(false);
    expect(isControlLaneMessage({ type: "load_history", limit: 20 })).toBe(false);
  });
});

describe("control-lane bypass of the per-session FIFO", () => {
  /**
   * The exact routing branch index-nats.ts runs per inbound frame: abort frames
   * go straight to a fire-and-forget control-lane handler; everything else is
   * enqueued on the per-session serializing dispatcher.
   */
  function route(
    message: InboundWsMessage,
    seam: {
      dispatch: (sessionKey: string, message: InboundWsMessage) => void;
      controlLane: (message: InboundWsMessage) => void;
    },
  ): void {
    if (message.type !== "user_message") return;
    if (isControlLaneMessage(message)) {
      seam.controlLane(message);
      return;
    }
    seam.dispatch("s1", message);
  }

  it("runs a control-lane abort even while a normal turn holds the FIFO", async () => {
    const ran: string[] = [];

    // A normal turn that NEVER settles — it occupies the session's FIFO chain
    // for the rest of the test, so anything queued behind it can't run.
    const { dispatch, pendingSessions } = createSerializedInboundDispatcher<InboundWsMessage>(
      (_sessionKey, message) => {
        ran.push(`fifo:${(message as { text: string }).text}`);
        return new Promise<void>(() => {}); // never resolves
      },
    );

    const controlLane = (message: InboundWsMessage): void => {
      ran.push(`abort:${(message as { text: string }).text}`);
    };

    // A normal message starts and wedges the chain.
    route(userMessage("run a long task"), { dispatch, controlLane });
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(ran).toEqual(["fifo:run a long task"]);
    expect(pendingSessions()).toBe(1); // the never-resolving turn holds the chain

    // The abort is routed out-of-band: it runs immediately, NOT queued behind
    // the wedged turn.
    route(userMessage("/stop"), { dispatch, controlLane });
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(ran).toEqual(["fifo:run a long task", "abort:/stop"]);
  });
});
