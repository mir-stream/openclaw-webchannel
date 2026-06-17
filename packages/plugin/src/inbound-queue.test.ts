import { describe, it, expect } from "vitest";

import { createSerializedInboundDispatcher } from "./inbound-queue.js";

/**
 * A manually-resolvable promise, so a test can hold a turn "in flight" and
 * assert what has/hasn't started before releasing it.
 */
function deferred() {
  let resolve!: () => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = () => res();
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Drain all pending microtasks (the chained `.then` hops between queue links)
 * before asserting. A single macrotask boundary lets every already-queued
 * microtask run to completion, which is what we need to observe one turn fully
 * settling and the next starting.
 */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("createSerializedInboundDispatcher", () => {
  it("runs same-session messages strictly sequentially (FIFO)", async () => {
    const order: string[] = [];
    const gates = [deferred(), deferred()];
    let call = 0;

    const { dispatch } = createSerializedInboundDispatcher(
      async (_sessionKey: string, message: { text: string }) => {
        const gate = gates[call++];
        order.push(`start:${message.text}`);
        await gate.promise;
        order.push(`end:${message.text}`);
      },
    );

    dispatch("s1", { text: "a" });
    dispatch("s1", { text: "b" });
    await flush();

    // Only the first turn has started; the second waits behind it.
    expect(order).toEqual(["start:a"]);

    // Release the first; only then does the second start.
    gates[0].resolve();
    await flush();
    expect(order).toEqual(["start:a", "end:a", "start:b"]);

    gates[1].resolve();
    await flush();
    expect(order).toEqual(["start:a", "end:a", "start:b", "end:b"]);
  });

  it("runs different sessions concurrently (not blocked by each other)", async () => {
    const started: string[] = [];
    const gates = new Map<string, ReturnType<typeof deferred>>([
      ["s1", deferred()],
      ["s2", deferred()],
    ]);

    const { dispatch } = createSerializedInboundDispatcher(
      async (sessionKey: string) => {
        started.push(sessionKey);
        await gates.get(sessionKey)!.promise;
      },
    );

    // Start s1 and hold it in flight; s2 must NOT wait for s1.
    dispatch("s1", { text: "x" });
    dispatch("s2", { text: "y" });
    await flush();

    expect(started).toEqual(["s1", "s2"]);

    gates.get("s1")!.resolve();
    gates.get("s2")!.resolve();
    await flush();
  });

  it("a rejected turn does not block the next same-session turn", async () => {
    const order: string[] = [];
    const gate = deferred();
    let call = 0;

    const { dispatch } = createSerializedInboundDispatcher(
      async (_sessionKey: string, message: { text: string }) => {
        if (call++ === 0) {
          order.push("first-throws");
          throw new Error("turn failed");
        }
        await gate.promise;
        order.push(`second:${message.text}`);
      },
    );

    dispatch("s1", { text: "boom" });
    dispatch("s1", { text: "ok" });
    // Let the first turn reject and the chain advance to the second.
    await flush();

    // The second turn ran despite the first rejecting.
    expect(order).toContain("first-throws");
    gate.resolve();
    await flush();
    expect(order).toContain("second:ok");
  });

  it("cleans up the map entry when a session drains (no unbounded growth)", async () => {
    // Directly assert the internal map size via the `pendingSessions()`
    // introspection accessor, so the drain/cleanup invariant is OBSERVABLE
    // rather than inferred from re-dispatch behavior (which a drained-but-
    // undeleted entry would satisfy just as well — a false positive). The
    // identity-guard assertion below proves the entry survives while a newer
    // same-session message is still queued, and only hits 0 after full drain.
    const events: string[] = [];
    const gates = [deferred(), deferred()];
    let call = 0;

    const { dispatch, pendingSessions } = createSerializedInboundDispatcher(
      async (_sessionKey: string, m: { text: string }) => {
        const gate = gates[call++];
        events.push(`start:${m.text}`);
        await gate.promise;
        events.push(`end:${m.text}`);
      },
    );

    // Idle: nothing tracked.
    expect(pendingSessions()).toBe(0);

    // Two same-session messages: the second replaces the tail while the first
    // is still in flight, so exactly one entry exists.
    dispatch("s1", { text: "first" });
    dispatch("s1", { text: "second" });
    await flush();
    expect(events).toEqual(["start:first"]);
    expect(pendingSessions()).toBe(1);

    // Drain the first turn. The second is now in flight; the entry must STILL
    // exist (the identity guard must not delete it on the first turn's
    // settlement, because a newer message already replaced the tail).
    gates[0].resolve();
    await flush();
    expect(events).toEqual(["start:first", "end:first", "start:second"]);
    expect(pendingSessions()).toBe(1);

    // Drain the second (final) turn: now the chain fully drains and the entry
    // is removed — the map returns to 0.
    gates[1].resolve();
    await flush();
    expect(events).toEqual([
      "start:first",
      "end:first",
      "start:second",
      "end:second",
    ]);
    expect(pendingSessions()).toBe(0);
  });

  it("a SYNCHRONOUSLY-thrown handler does not block the next same-session turn or leak its map entry", async () => {
    // Covers the sync-throw path: a non-async handler that throws BEFORE
    // returning a promise must be funneled into the chain's rejection-swallow,
    // not escape it. If it escaped, the chain tail would be poisoned (wedging
    // the next turn) and the success-only cleanup would be skipped (leaking the
    // map entry).
    const order: string[] = [];
    let call = 0;

    const { dispatch, pendingSessions } = createSerializedInboundDispatcher(
      // Deliberately NON-async: it throws synchronously on the first call.
      (_sessionKey: string, message: { text: string }): Promise<void> => {
        if (call++ === 0) {
          order.push("first-throws-sync");
          throw new Error("sync turn failed");
        }
        order.push(`second:${message.text}`);
        return Promise.resolve();
      },
    );

    dispatch("s1", { text: "boom" });
    dispatch("s1", { text: "ok" });
    await flush();

    // The second turn ran despite the first throwing synchronously...
    expect(order).toEqual(["first-throws-sync", "second:ok"]);
    // ...and the session fully drained: no leaked entry.
    expect(pendingSessions()).toBe(0);
  });
});
