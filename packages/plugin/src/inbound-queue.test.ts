import { describe, it, expect } from "vitest";

import {
  createSerializedInboundDispatcher,
  coalesceUserMessages,
  normalizeInboundUserMessage,
  readCoalescedMemberIds,
  MAX_COALESCED_MEMBER_ID_LENGTH,
  type CoalescedMemberIds,
  type UserMessageLike,
} from "./inbound-queue.js";
import { DEFAULT_BUSY_TURN_LIMITS, InboundRetentionBudget } from "./inbound-retention.js";

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

  it("without coalesce: pendingBuffered/clearPending are inert (legacy FIFO path)", () => {
    // The new introspection/clearing surface exists on every dispatcher, but on
    // the legacy (no-`coalesce`) path there is no busy-time buffer, so both are
    // pure no-ops. Pins that a dispatcher built the old way is unaffected.
    const { pendingBuffered, clearPending } =
      createSerializedInboundDispatcher<UserMessageLike>(async () => {});
    expect(pendingBuffered("s1")).toBe(0);
    expect(clearPending("s1")).toEqual([]);
  });
});

const um = (text: string): UserMessageLike => ({ type: "user_message", text });

/** The dispatcher-boundary shape (#99): a wire user message plus the internal ids. */
type Coalescable = UserMessageLike & CoalescedMemberIds;

describe("coalesceUserMessages", () => {
  it("returns a single message unchanged (identity — no-burst pass-through)", () => {
    const m = um("solo");
    // Same reference, not just structural equality: the common case allocates
    // nothing.
    expect(coalesceUserMessages([m])).toBe(m);
  });

  it("joins several texts with a blank line, preserving the frame type", () => {
    expect(coalesceUserMessages([um("a"), um("b"), um("c")])).toEqual({
      type: "user_message",
      text: "a\n\nb\n\nc",
    });
  });

  it("preserves the FIRST message's non-text fields", () => {
    type Extended = UserMessageLike & { at?: number };
    const merged = coalesceUserMessages<Extended>([
      { type: "user_message", text: "a", at: 111 },
      { type: "user_message", text: "b", at: 222 },
    ]);
    expect(merged).toEqual({ type: "user_message", text: "a\n\nb", at: 111 });
  });

  it("carries the LAST message's id (turnId anchors on the latest user bubble)", () => {
    // The merged id becomes the turn's turnId; the widget anchors reasoning and
    // typing-text suppression to the LATEST user bubble, so the last id — not the
    // first — must survive the merge.
    const merged = coalesceUserMessages([
      { type: "user_message", text: "a", id: "id-1" },
      { type: "user_message", text: "b", id: "id-2" },
      { type: "user_message", text: "c", id: "id-3" },
    ]);
    expect(merged).toEqual({
      type: "user_message",
      text: "a\n\nb\n\nc",
      id: "id-3",
      // #99: the anchor is also the last member of the group (see below).
      coalescedIds: ["id-1", "id-2", "id-3"],
    });
  });

  /**
   * #99 — the merge must not lose the non-anchor wireIds.
   *
   * Each buffered message was ACKed and holds its own P0-4 send receipt, which
   * only a `turn_settled` naming that exact id can move off `accepted`. The
   * merge is where the other ids used to disappear, so `inbound.ts` had nothing
   * to settle them with.
   */
  describe("#99 coalesced member ids", () => {
    it("carries EVERY member id in arrival order, anchor last", () => {
      const merged = coalesceUserMessages<Coalescable>([
        { type: "user_message", text: "a", id: "id-1" },
        { type: "user_message", text: "b", id: "id-2" },
        { type: "user_message", text: "c", id: "id-3" },
      ]);
      expect(merged.coalescedIds).toEqual(["id-1", "id-2", "id-3"]);
      // The anchor is the last member, so the settle path can emit it last
      // without reordering anything.
      expect(merged.coalescedIds?.at(-1)).toBe(merged.id);
    });

    it("leaves a single message with NO member list (identity, byte-identical)", () => {
      const solo: Coalescable = { type: "user_message", text: "solo", id: "id-1" };
      const merged = coalesceUserMessages<Coalescable>([solo]);
      expect(merged).toBe(solo);
      expect(merged).not.toHaveProperty("coalescedIds");
    });

    it("contributes nothing for messages that carry no id", () => {
      const merged = coalesceUserMessages<Coalescable>([
        { type: "user_message", text: "a" },
        { type: "user_message", text: "b", id: "id-2" },
        { type: "user_message", text: "c" },
      ]);
      // Only the one real id; an id-less message has no receipt to settle.
      expect(merged.coalescedIds).toEqual(["id-2"]);
    });

    it("omits the field entirely when NO member carries an id", () => {
      const merged = coalesceUserMessages<Coalescable>([um("a"), um("b")]);
      expect(merged).not.toHaveProperty("coalescedIds");
    });

    it("unions pre-existing member ids instead of dropping them (associative)", () => {
      // Not reachable today — coalesce runs once, over raw pending entries — but
      // folding a merged message into a later merge must not strand the members
      // it already speaks for.
      const merged = coalesceUserMessages<Coalescable>([
        { type: "user_message", text: "ab", id: "id-2", coalescedIds: ["id-1", "id-2"] },
        { type: "user_message", text: "c", id: "id-3" },
      ]);
      expect(merged.coalescedIds).toEqual(["id-1", "id-2", "id-3"]);
      expect(merged.id).toBe("id-3");
    });

    it("dedupes a repeated id (each receipt is settled exactly once)", () => {
      const merged = coalesceUserMessages<Coalescable>([
        { type: "user_message", text: "a", id: "dup" },
        { type: "user_message", text: "b", id: "dup" },
      ]);
      expect(merged.coalescedIds).toEqual(["dup"]);
    });

    it("does NOT carry an empty list in from an input (field present only for a real group)", () => {
      const merged = coalesceUserMessages<Coalescable>([
        { type: "user_message", text: "a", coalescedIds: [] },
        { type: "user_message", text: "b" },
      ]);
      expect(merged).not.toHaveProperty("coalescedIds");
    });

    it("drops an over-long member id and caps the merged list at the session bound", () => {
      const cap = DEFAULT_BUSY_TURN_LIMITS.maxMessagesPerSession;
      const merged = coalesceUserMessages<Coalescable>([
        {
          type: "user_message",
          text: "a",
          id: "id-1",
          coalescedIds: [
            "x".repeat(MAX_COALESCED_MEMBER_ID_LENGTH + 1),
            ...Array.from({ length: cap * 4 }, (_, i) => `flood-${i}`),
          ],
        },
        { type: "user_message", text: "b", id: "id-2" },
      ]);
      expect(merged.coalescedIds).toHaveLength(cap);
      expect(merged.coalescedIds).not.toContain("x".repeat(MAX_COALESCED_MEMBER_ID_LENGTH + 1));
      expect(merged.coalescedIds?.[0]).toBe("flood-0");
    });

    /**
     * Hostile shapes. `coalescedIds` used to be reachable from the wire (the
     * decode path casts instead of validating), and a throw here is NOT a safe
     * failure: `startTurn` catches it with `maybeForget(); return;`, so the
     * whole turn is discarded — ACKed, never run, never answered, never settled.
     * Strictly worse than the bug #99 fixes.
     */
    describe("#99 hostile `coalescedIds` shapes never throw", () => {
      const hostile: Array<[string, unknown]> = [
        ["a number", 5],
        ["a string (would iterate as characters)", "abc"],
        ["null", null],
        ["an object", { length: 2 }],
        ["non-string members", [{}, 7, null]],
        ["empty-string members", ["", ""]],
      ];

      for (const [label, value] of hostile) {
        it(`merges a burst carrying ${label} without throwing, keeping only real ids`, () => {
          const merge = () =>
            coalesceUserMessages<Coalescable>([
              { type: "user_message", text: "a", id: "id-1", coalescedIds: value as never },
              { type: "user_message", text: "b", id: "id-2" },
            ]);
          expect(merge).not.toThrow();
          const merged = merge();
          // The turn still runs and still knows its real members.
          expect(merged.text).toBe("a\n\nb");
          expect(merged.id).toBe("id-2");
          expect(merged.coalescedIds).toEqual(["id-1", "id-2"]);
        });
      }
    });
  });
});

/**
 * #99 layer (b): both read sites treat `coalescedIds` as untrusted, so a path
 * that forgets to strip it degrades to "only the anchor settles" instead of a
 * thrown (and therefore silently discarded) turn.
 */
describe("readCoalescedMemberIds", () => {
  it("returns the ids of a well-formed list unchanged", () => {
    expect(readCoalescedMemberIds({ coalescedIds: ["a", "b"] })).toEqual(["a", "b"]);
  });

  it("is inert for an absent field or a non-object source", () => {
    expect(readCoalescedMemberIds({ type: "user_message", text: "hi" })).toEqual([]);
    expect(readCoalescedMemberIds(undefined)).toEqual([]);
    expect(readCoalescedMemberIds(null)).toEqual([]);
  });

  it("is inert (never throws) for every non-array shape", () => {
    for (const value of [5, "abc", true, {}, { length: 3 }, null]) {
      expect(readCoalescedMemberIds({ coalescedIds: value })).toEqual([]);
    }
  });

  it("drops members that are not plausible wire ids", () => {
    expect(
      readCoalescedMemberIds({
        coalescedIds: [{}, 7, null, "", "ok", "x".repeat(MAX_COALESCED_MEMBER_ID_LENGTH + 1)],
      }),
    ).toEqual(["ok"]);
    // The boundary length itself is admitted.
    const atLimit = "x".repeat(MAX_COALESCED_MEMBER_ID_LENGTH);
    expect(readCoalescedMemberIds({ coalescedIds: [atLimit] })).toEqual([atLimit]);
  });

  it("caps the list at the same per-session bound the merge itself obeys", () => {
    const cap = DEFAULT_BUSY_TURN_LIMITS.maxMessagesPerSession;
    const flood = Array.from({ length: cap * 100 }, (_, i) => `id-${i}`);
    const read = readCoalescedMemberIds({ coalescedIds: flood });
    // Unbounded here would mean that many seal+publish calls (and warn lines)
    // synchronously in the turn's `finally`.
    expect(read).toHaveLength(cap);
    expect(read[0]).toBe("id-0");
  });
});

/**
 * #99 layer (a): the field is stripped where the wire frame enters, so
 * `coalesceUserMessages` is its only producer. Wired at the runtime's message
 * handler (pinned by `index-nats-wiring.test.ts`).
 */
describe("normalizeInboundUserMessage", () => {
  it("keeps ONLY the known wire fields", () => {
    const raw = {
      type: "user_message",
      text: "hi",
      id: "wire-1",
      coalescedIds: ["victim-1", "victim-2"],
      somethingElse: "junk",
    } as unknown as UserMessageLike;
    expect(normalizeInboundUserMessage(raw)).toEqual({
      type: "user_message",
      text: "hi",
      id: "wire-1",
    });
  });

  it("strips a peer-supplied member list of EVERY shape", () => {
    for (const value of [["victim"], 5, "abc", [{}], [""], null, { a: 1 }]) {
      const raw = { type: "user_message", text: "hi", coalescedIds: value } as unknown as UserMessageLike;
      const normalized = normalizeInboundUserMessage(raw);
      expect(normalized).not.toHaveProperty("coalescedIds");
      expect(readCoalescedMemberIds(normalized)).toEqual([]);
    }
  });

  it("a stripped frame cannot name ids the plugin never coalesced", () => {
    // The end-to-end property: a peer floods a member list, the frame is
    // normalized at ingress, and the merge that follows speaks only for the
    // wireIds actually sent.
    const raw = {
      type: "user_message",
      text: "hi",
      id: "mine-1",
      coalescedIds: ["someone-elses-1", "someone-elses-2"],
    } as unknown as UserMessageLike;
    const merged = coalesceUserMessages<Coalescable>([
      normalizeInboundUserMessage(raw),
      { type: "user_message", text: "hi again", id: "mine-2" },
    ]);
    expect(merged.coalescedIds).toEqual(["mine-1", "mine-2"]);
  });

  it("drops a non-string id (retention already ignores one)", () => {
    const raw = { type: "user_message", text: "hi", id: 5 } as unknown as UserMessageLike;
    expect(normalizeInboundUserMessage(raw)).toEqual({ type: "user_message", text: "hi" });
  });
});

describe("createSerializedInboundDispatcher with coalesce (P1-8b layer b)", () => {
  /**
   * A handler that records each turn's merged text and blocks on a fresh gate
   * per call, so a test can hold each turn "running" and observe what buffers
   * behind it. `gates[i]` releases the i-th turn (in call order).
   */
  function gatedDispatcher() {
    const calls: string[] = [];
    const gates: ReturnType<typeof deferred>[] = [];
    const dispatcher = createSerializedInboundDispatcher<UserMessageLike>(
      async (_sessionKey, message) => {
        calls.push(message.text);
        const gate = deferred();
        gates.push(gate);
        await gate.promise;
      },
      { coalesce: coalesceUserMessages },
    );
    return { ...dispatcher, calls, gates };
  }

  it("coalesces messages arriving DURING a running turn into ONE follow-up turn (and re-buffers a third wave)", async () => {
    const { dispatch, pendingBuffered, pendingSessions, calls, gates } =
      gatedDispatcher();

    // M1 starts and holds the session busy; nothing buffered yet.
    dispatch("s1", um("m1"));
    await flush();
    expect(calls).toEqual(["m1"]);
    expect(pendingBuffered("s1")).toBe(0);

    // M2, M3 arrive while M1 runs: buffered, NOT run as separate turns.
    dispatch("s1", um("m2"));
    dispatch("s1", um("m3"));
    await flush();
    expect(calls).toEqual(["m1"]);
    expect(pendingBuffered("s1")).toBe(2);

    // Finish M1: EXACTLY ONE merged follow-up turn runs for M2+M3; buffer empties.
    gates[0].resolve();
    await flush();
    expect(calls).toEqual(["m1", "m2\n\nm3"]);
    expect(pendingBuffered("s1")).toBe(0);

    // A message arriving during the MERGED turn buffers again (third wave).
    dispatch("s1", um("m4"));
    await flush();
    expect(calls).toEqual(["m1", "m2\n\nm3"]);
    expect(pendingBuffered("s1")).toBe(1);

    // Drain the merged turn: M4 runs on its own; then drain it → session idle.
    gates[1].resolve();
    await flush();
    expect(calls).toEqual(["m1", "m2\n\nm3", "m4"]);
    gates[2].resolve();
    await flush();
    expect(pendingSessions()).toBe(0);
    expect(pendingBuffered("s1")).toBe(0);
  });

  it("clearPending drops the busy-time buffer; the running turn then drains clean with no follow-up", async () => {
    const { dispatch, clearPending, pendingBuffered, pendingSessions, calls, gates } =
      gatedDispatcher();

    dispatch("s1", um("m1"));
    await flush();
    dispatch("s1", um("m2"));
    dispatch("s1", um("m3"));
    await flush();
    expect(pendingBuffered("s1")).toBe(2);

    // /stop path: drop the buffer, reporting the count.
    expect(clearPending("s1")).toEqual([um("m2"), um("m3")]);
    expect(pendingBuffered("s1")).toBe(0);

    // M1 settles with nothing buffered → NO merged follow-up turn; session idle.
    gates[0].resolve();
    await flush();
    expect(calls).toEqual(["m1"]);
    expect(pendingSessions()).toBe(0);
  });

  it("clearPending honors cancellation holds on committed and provisional open-lease entries", async () => {
    const gate = deferred();
    const budget = new InboundRetentionBudget({
      maxMessagesPerSession: 8, maxBytesPerSession: 8,
      maxMessagesPerProcess: 8, maxBytesPerProcess: 8,
    });
    const token = budget.createSessionToken();
    const dispatcher = createSerializedInboundDispatcher<UserMessageLike>(
      async (_key, message) => { if (message.text === "running") await gate.promise; },
      { coalesce: coalesceUserMessages, budget, sessionToken: () => token, measure: () => 1 },
    );
    dispatcher.dispatch("s1", um("running"));
    await flush();

    const prior = budget.tryReserve(token, 1, "pending");
    const committed = budget.tryReserve(token, 1, "debounce-inflight");
    const provisional = budget.tryReserve(token, 1, "debounce-inflight");
    if (prior.status !== "accepted" || committed.status !== "accepted" || provisional.status !== "accepted") {
      throw new Error("unexpected retention rejection");
    }
    dispatcher.dispatch("s1", um("prior"), prior.reservation);
    const lease = dispatcher.beginBatch("s1");
    const committedOffer = lease.offer(um("committed"), committed.reservation);
    const provisionalOffer = lease.offer(um("provisional"), provisional.reservation);
    if (committedOffer.status !== "accepted" || provisionalOffer.status !== "accepted") {
      throw new Error("unexpected dispatcher rejection");
    }
    committedOffer.commit();
    const releaseCommittedHold = committed.reservation.hold();
    const releaseProvisionalHold = provisional.reservation.hold();

    expect(dispatcher.clearPending("s1").map((message) => message.text).sort()).toEqual([
      "committed", "prior", "provisional",
    ]);
    expect(budget.usage()).toEqual({ messages: 2, bytes: 2 });
    releaseCommittedHold();
    expect(budget.usage()).toEqual({ messages: 1, bytes: 1 });
    releaseProvisionalHold();
    expect(budget.usage()).toEqual({ messages: 0, bytes: 0 });
    lease.finish();
    gate.resolve();
    await flush();
  });

  it("clearPending on an idle/unknown session returns 0", () => {
    const { clearPending } = createSerializedInboundDispatcher<UserMessageLike>(
      async () => {},
      { coalesce: coalesceUserMessages },
    );
    expect(clearPending("never-seen")).toEqual([]);
  });

  it("a throwing merged follow-up turn does not poison the session (next dispatch runs)", async () => {
    const calls: string[] = [];
    const gates: ReturnType<typeof deferred>[] = [];
    const { dispatch, pendingSessions } =
      createSerializedInboundDispatcher<UserMessageLike>(
        async (_sessionKey, message) => {
          calls.push(message.text);
          // The merged follow-up ("boom") throws; M1 and the later "after" block
          // on a gate so we can observe ordering.
          if (message.text.includes("boom")) throw new Error("merged turn failed");
          const gate = deferred();
          gates.push(gate);
          await gate.promise;
        },
        { coalesce: coalesceUserMessages },
      );

    // M1 runs and blocks; "boom" buffers behind it.
    dispatch("s1", um("m1"));
    await flush();
    dispatch("s1", um("boom"));
    await flush();

    // Release M1 → merged follow-up ("boom") runs and throws.
    gates[0].resolve();
    await flush();
    expect(calls).toEqual(["m1", "boom"]);
    // The throw did not wedge the session: it returned to idle.
    expect(pendingSessions()).toBe(0);

    // A fresh dispatch runs normally on the un-poisoned session.
    dispatch("s1", um("after"));
    await flush();
    expect(calls).toEqual(["m1", "boom", "after"]);
  });
});

describe("SerializedInboundDispatcher close gate", () => {
  it("skips a turn queued in the same tick and clears recursive coalesce follow-up", async () => {
    const handled: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const dispatcher = createSerializedInboundDispatcher<{ text: string }>(async (_key, message) => {
      handled.push(message.text);
      await gate;
    }, { coalesce: (messages) => ({ text: messages.map((m) => m.text).join("+") }) });
    dispatcher.dispatch("a", { text: "first" });
    await Promise.resolve();
    dispatcher.dispatch("a", { text: "second" });
    dispatcher.close();
    release();
    await Promise.resolve();
    await Promise.resolve();
    expect(handled).toEqual(["first"]);
    expect(dispatcher.pendingSessions()).toBe(0);
    expect(dispatcher.pendingBuffered("a")).toBe(0);

    const sameTick = createSerializedInboundDispatcher<{ text: string }>(async (_key, message) => { handled.push(message.text); });
    sameTick.dispatch("b", { text: "never" });
    sameTick.close();
    await Promise.resolve();
    expect(handled).not.toContain("never");
  });
});
