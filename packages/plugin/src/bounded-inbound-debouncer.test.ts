import { describe, expect, it } from "vitest";
import {
  createBoundedInboundDebouncer,
  type RetainedDebounceEntry,
} from "./bounded-inbound-debouncer.js";
import {
  DEFAULT_BUSY_TURN_LIMITS,
  estimateRetainedMessageBytes,
  InboundRetentionBudget,
} from "./inbound-retention.js";
import {
  coalesceUserMessages,
  createSerializedInboundDispatcher,
  type UserMessageLike,
} from "./inbound-queue.js";

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("createBoundedInboundDebouncer", () => {
  it("charges a production-shaped wrapper by its exact wire message at the 1 MiB boundary", () => {
    type ProductionItem = {
      peerId: string;
      message: { type: "user_message"; text: string; id: string };
    };
    const emptyMessage: ProductionItem["message"] = {
      type: "user_message",
      text: "",
      id: "exact",
    };
    const message = {
      ...emptyMessage,
      text: "x".repeat(
        DEFAULT_BUSY_TURN_LIMITS.maxBytesPerSession
          - estimateRetainedMessageBytes(emptyMessage),
      ),
    };
    const item: ProductionItem = { peerId: "routing-peer", message };
    expect(estimateRetainedMessageBytes(message)).toBe(
      DEFAULT_BUSY_TURN_LIMITS.maxBytesPerSession,
    );
    expect(estimateRetainedMessageBytes(item)).toBeGreaterThan(
      DEFAULT_BUSY_TURN_LIMITS.maxBytesPerSession,
    );

    const budget = new InboundRetentionBudget();
    const token = budget.createSessionToken();
    const debouncer = createBoundedInboundDebouncer<ProductionItem>({
      debounceMs: 60_000,
      buildKey: (value) => value.peerId,
      sessionToken: () => token,
      budget,
      measure: (value) => estimateRetainedMessageBytes(value.message),
      getId: (value) => value.message.id,
      onFlush: () => {},
    });

    expect(debouncer.push(item)).toEqual({ status: "accepted" });
    expect(budget.usage()).toEqual({
      messages: 1,
      bytes: DEFAULT_BUSY_TURN_LIMITS.maxBytesPerSession,
    });
    expect(debouncer.push({
      peerId: item.peerId,
      message: { type: "user_message", text: "next", id: "next" },
    })).toMatchObject({ status: "overflow", reason: "session-byte-count" });
    debouncer.dispose();
    expect(budget.usage()).toEqual({ messages: 0, bytes: 0 });
  });

  it("bounds a stalled zero-ms flush and drops an in-flight duplicate without reserving", async () => {
    const budget = new InboundRetentionBudget({
      maxMessagesPerSession: 2, maxBytesPerSession: 10,
      maxMessagesPerProcess: 2, maxBytesPerProcess: 10,
    });
    const token = budget.createSessionToken();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const d = createBoundedInboundDebouncer<{ peer: string; id: string }>({
      debounceMs: 0, buildKey: (x) => x.peer, sessionToken: () => token,
      getId: (x) => x.id, measure: () => 1, budget,
      onFlush: async () => gate,
    });
    expect(d.push({ peer: "p", id: "a" }).status).toBe("accepted");
    await tick();
    expect(d.push({ peer: "p", id: "a" }).status).toBe("duplicate-inflight");
    expect(d.push({ peer: "p", id: "b" }).status).toBe("accepted");
    expect(d.push({ peer: "p", id: "c" })).toMatchObject({ status: "overflow", reason: "session-message-count" });
    expect(budget.usage()).toEqual({ messages: 2, bytes: 2 });
    release();
    await tick();
    await tick();
    expect(budget.usage()).toEqual({ messages: 0, bytes: 0 });
    d.dispose();
    expect(budget.usage()).toEqual({ messages: 0, bytes: 0 });
  });

  it("dispose is terminal and idempotently releases waiting work", () => {
    const budget = new InboundRetentionBudget();
    const token = budget.createSessionToken();
    const d = createBoundedInboundDebouncer<{ peer: string }>({
      debounceMs: 100, buildKey: (x) => x.peer, sessionToken: () => token,
      measure: () => 1, budget, onFlush: () => {},
    });
    d.push({ peer: "p" });
    expect(d.dispose()).toEqual({ waiting: 1, inflight: 0 });
    expect(d.dispose()).toEqual({ waiting: 0, inflight: 0 });
    expect(d.push({ peer: "p" })).toEqual({ status: "disposed" });
  });

  it("invalidates entries before releasing a stalled in-flight flush", async () => {
    const budget = new InboundRetentionBudget();
    const token = budget.createSessionToken();
    let resume!: () => void;
    const gate = new Promise<void>((resolve) => { resume = resolve; });
    let activeAfterGate = true;
    const d = createBoundedInboundDebouncer<{ peer: string }>({
      debounceMs: 0,
      buildKey: (x) => x.peer,
      sessionToken: () => token,
      measure: () => 1,
      budget,
      onFlush: async ([entry]) => {
        await gate;
        activeAfterGate = entry.isActive();
      },
    });
    d.push({ peer: "p" });
    await tick();
    expect(d.dispose()).toEqual({ waiting: 0, inflight: 1 });
    expect(budget.usage()).toEqual({ messages: 1, bytes: 1 });
    expect(d.usage()).toEqual({ waiting: 0, inflight: 1, keys: 1 });
    expect(d.dispose()).toEqual({ waiting: 0, inflight: 1 });
    resume();
    await tick();
    expect(activeAfterGate).toBe(false);
    expect(budget.usage()).toEqual({ messages: 0, bytes: 0 });
    expect(d.usage()).toEqual({ waiting: 0, inflight: 0, keys: 0 });
  });

  it("peer retirement invalidates a stalled callback but keeps its copied entry charged", async () => {
    const budget = new InboundRetentionBudget();
    const token = budget.createSessionToken();
    let resume!: () => void;
    const gate = new Promise<void>((resolve) => { resume = resolve; });
    const d = createBoundedInboundDebouncer<{ peer: string }>({
      debounceMs: 0,
      buildKey: (x) => x.peer,
      sessionToken: () => token,
      measure: () => 1,
      budget,
      onFlush: async () => gate,
    });
    d.push({ peer: "p" });
    await tick();
    expect(budget.usage()).toEqual({ messages: 1, bytes: 1 });
    expect(d.cancelKey("p", { notify: false })).toBe(true);
    expect(budget.usage()).toEqual({ messages: 1, bytes: 1 });
    expect(d.usage()).toEqual({ waiting: 0, inflight: 1, keys: 1 });
    resume();
    await tick();
    expect(budget.usage()).toEqual({ messages: 0, bytes: 0 });
  });

  it("peer retirement releases queued batches but keeps the one running batch charged", async () => {
    const budget = new InboundRetentionBudget();
    const token = budget.createSessionToken();
    let resume!: () => void;
    const gate = new Promise<void>((resolve) => { resume = resolve; });
    let flushes = 0;
    const d = createBoundedInboundDebouncer<{ peer: string; n: number }>({
      debounceMs: 0,
      buildKey: (x) => x.peer,
      sessionToken: () => token,
      measure: () => 1,
      budget,
      onFlush: async () => {
        flushes++;
        if (flushes === 1) await gate;
      },
    });
    d.push({ peer: "p", n: 1 });
    await tick();
    d.push({ peer: "p", n: 2 });
    await tick();
    expect(budget.snapshot(token).breakdown["debounce-inflight"]).toEqual({ messages: 2, bytes: 2 });
    expect(d.cancelKey("p", { notify: false })).toBe(true);
    expect(budget.usage()).toEqual({ messages: 1, bytes: 1 });
    expect(d.usage()).toEqual({ waiting: 0, inflight: 1, keys: 1 });
    resume();
    await tick();
    await tick();
    expect(flushes).toBe(1);
    expect(budget.usage()).toEqual({ messages: 0, bytes: 0 });
  });

  it("notify-cancels a sole stalled zero-ms flush exactly once and holds its lease through delivery", async () => {
    const budget = new InboundRetentionBudget();
    const token = budget.createSessionToken();
    let resumeFlush!: () => void;
    let finishCancellation!: () => void;
    const flushGate = new Promise<void>((resolve) => { resumeFlush = resolve; });
    const cancellationGate = new Promise<void>((resolve) => { finishCancellation = resolve; });
    const outcomes: string[] = [];
    const acks: string[] = [];
    const handled: string[] = [];
    const d = createBoundedInboundDebouncer<{ peer: string; id: string }>({
      debounceMs: 0,
      buildKey: (x) => x.peer,
      sessionToken: () => token,
      getId: (x) => x.id,
      measure: () => 1,
      budget,
      onFlush: async ([entry]) => {
        await flushGate;
        if (entry.isActive()) handled.push(entry.item.id);
      },
      onCancel: async (entries) => {
        outcomes.push(...entries.map((entry) => entry.item.id));
        await cancellationGate;
        acks.push(...entries.map((entry) => entry.item.id));
      },
    });

    expect(d.push({ peer: "p", id: "a" }).status).toBe("accepted");
    await tick();
    expect(d.cancelKey("p", { notify: true })).toBe(true);
    expect(d.cancelKey("p", { notify: true })).toBe(false);
    await Promise.resolve();
    expect(outcomes).toEqual(["a"]);
    expect(budget.usage()).toEqual({ messages: 1, bytes: 1 });

    // The normal continuation may unwind first, but cancellation still owns the
    // retained lease until its persistence/result path settles.
    resumeFlush();
    await tick();
    expect(handled).toEqual([]);
    expect(budget.usage()).toEqual({ messages: 1, bytes: 1 });

    finishCancellation();
    await tick();
    expect(acks).toEqual(["a"]);
    expect(budget.usage()).toEqual({ messages: 0, bytes: 0 });
    expect(handled).toEqual([]);
    expect(budget.usage()).toEqual({ messages: 0, bytes: 0 });
  });

  it("notify-cancels waiting plus an older stalled flush as one exact union", async () => {
    const budget = new InboundRetentionBudget();
    const token = budget.createSessionToken();
    let resumeFlush!: () => void;
    let finishCancellation!: () => void;
    const flushGate = new Promise<void>((resolve) => { resumeFlush = resolve; });
    const cancellationGate = new Promise<void>((resolve) => { finishCancellation = resolve; });
    const cancelled: string[][] = [];
    const acked: string[] = [];
    const handled: string[] = [];
    const d = createBoundedInboundDebouncer<{ peer: string; id: string }>({
      debounceMs: 0,
      buildKey: (x) => x.peer,
      sessionToken: () => token,
      getId: (x) => x.id,
      measure: () => 1,
      budget,
      onFlush: async (entries) => {
        await flushGate;
        for (const entry of entries) if (entry.isActive()) handled.push(entry.item.id);
      },
      onCancel: async (entries) => {
        cancelled.push(entries.map((entry) => entry.item.id));
        await cancellationGate;
        acked.push(...entries.map((entry) => entry.item.id));
      },
    });

    d.push({ peer: "p", id: "old" });
    await tick();
    d.push({ peer: "p", id: "waiting" });
    expect(d.cancelKey("p", { notify: true })).toBe(true);
    await tick(); // detached waiting microtask is fenced by bucket removal
    expect(cancelled).toEqual([["old", "waiting"]]);
    expect(budget.usage()).toEqual({ messages: 2, bytes: 2 });

    finishCancellation();
    await tick();
    expect(acked).toEqual(["old", "waiting"]);
    // The cancellation callback settled, but the older normal callback still
    // owns its copied/parameter batch until its separate await settles.
    expect(budget.usage()).toEqual({ messages: 1, bytes: 1 });
    resumeFlush();
    await tick();
    await tick();
    expect(handled).toEqual([]);
    expect(cancelled).toHaveLength(1);
    expect(budget.usage()).toEqual({ messages: 0, bytes: 0 });
  });

  it("peer retirement revokes delivery but charges a started notify-cancellation callback", async () => {
    const budget = new InboundRetentionBudget();
    const token = budget.createSessionToken();
    let finishCancellation!: () => void;
    const cancellationGate = new Promise<void>((resolve) => { finishCancellation = resolve; });
    const published: string[] = [];
    let cancellationEntry: RetainedDebounceEntry<{ peer: string; id: string }> | undefined;
    const d = createBoundedInboundDebouncer<{ peer: string; id: string }>({
      debounceMs: 100,
      buildKey: (x) => x.peer,
      sessionToken: () => token,
      getId: (x) => x.id,
      measure: () => 1,
      budget,
      onFlush: () => {},
      onCancel: async ([entry]) => {
        cancellationEntry = entry;
        await cancellationGate;
        if (!entry.isRetired()) published.push(entry.item.id);
      },
    });
    d.push({ peer: "p", id: "a" });
    expect(d.cancelKey("p", { notify: true })).toBe(true);
    await Promise.resolve();
    expect(cancellationEntry?.isRetired()).toBe(false);
    expect(budget.usage()).toEqual({ messages: 1, bytes: 1 });

    expect(d.cancelKey("p", { notify: false })).toBe(true);
    expect(cancellationEntry?.isRetired()).toBe(true);
    expect(budget.usage()).toEqual({ messages: 1, bytes: 1 });
    expect(d.usage()).toEqual({ waiting: 0, inflight: 1, keys: 1 });
    await expect(cancellationEntry!.waitForCancellation()).resolves.toBeUndefined();
    finishCancellation();
    await tick();
    expect(published).toEqual([]);
    expect(budget.usage()).toEqual({ messages: 0, bytes: 0 });
    expect(d.push({ peer: "p", id: "replacement" }).status).toBe("accepted");
    d.dispose();
  });

  it("severs a queued notify-cancellation callback retired before it begins", async () => {
    const budget = new InboundRetentionBudget();
    const token = budget.createSessionToken();
    const cancelled: string[] = [];
    const d = createBoundedInboundDebouncer<{ peer: string; id: string }>({
      debounceMs: 100,
      buildKey: (item) => item.peer,
      sessionToken: () => token,
      getId: (item) => item.id,
      measure: () => 1,
      budget,
      onFlush: () => {},
      onCancel: async (entries) => {
        cancelled.push(...entries.map((entry) => entry.item.id));
      },
    });
    expect(d.push({ peer: "p", id: "a" })).toEqual({ status: "accepted" });
    expect(d.cancelKey("p", { notify: true })).toBe(true);
    expect(d.diagnostics()).toEqual({ capturedEntries: 1, queuedBatches: 1, workers: 0 });
    expect(d.cancelKey("p", { notify: false })).toBe(true);
    expect(budget.usage()).toEqual({ messages: 0, bytes: 0 });
    expect(d.diagnostics()).toEqual({ capturedEntries: 0, queuedBatches: 0, workers: 0 });
    await Promise.resolve();
    expect(cancelled).toEqual([]);
    expect(d.usage()).toEqual({ waiting: 0, inflight: 0, keys: 0 });
  });

  it("dispose revokes delivery but charges a started notify-cancellation callback", async () => {
    const budget = new InboundRetentionBudget();
    const token = budget.createSessionToken();
    let finishCancellation!: () => void;
    const cancellationGate = new Promise<void>((resolve) => { finishCancellation = resolve; });
    const published: string[] = [];
    const d = createBoundedInboundDebouncer<{ peer: string; id: string }>({
      debounceMs: 100,
      buildKey: (x) => x.peer,
      sessionToken: () => token,
      getId: (x) => x.id,
      measure: () => 1,
      budget,
      onFlush: () => {},
      onCancel: async ([entry]) => {
        await cancellationGate;
        if (!entry.isRetired()) published.push(entry.item.id);
      },
    });
    d.push({ peer: "p", id: "a" });
    expect(d.cancelKey("p", { notify: true })).toBe(true);
    await Promise.resolve();
    expect(budget.usage()).toEqual({ messages: 1, bytes: 1 });
    expect(d.dispose()).toEqual({ waiting: 0, inflight: 1 });
    expect(budget.usage()).toEqual({ messages: 1, bytes: 1 });
    expect(d.dispose()).toEqual({ waiting: 0, inflight: 1 });
    expect(d.push({ peer: "p", id: "later" })).toEqual({ status: "disposed" });
    finishCancellation();
    await tick();
    expect(published).toEqual([]);
    expect(budget.usage()).toEqual({ messages: 0, bytes: 0 });
    expect(d.dispose()).toEqual({ waiting: 0, inflight: 0 });
  });

  it("account teardown releases a cancellation-held reservation shared with an open dispatcher lease", async () => {
    const budget = new InboundRetentionBudget();
    const token = budget.createSessionToken();
    const handled: string[] = [];
    const dispatcher = createSerializedInboundDispatcher<UserMessageLike>(
      async (_key, message) => { handled.push(message.text); },
      { coalesce: coalesceUserMessages, budget, sessionToken: () => token, measure: () => 1 },
    );
    let offered = false;
    let finishFlush!: () => void;
    const flushGate = new Promise<void>((resolve) => { finishFlush = resolve; });
    let finishCancellation!: () => void;
    const cancellationGate = new Promise<void>((resolve) => { finishCancellation = resolve; });
    const published: string[] = [];
    const d = createBoundedInboundDebouncer<{ peer: string; id: string }>({
      debounceMs: 0,
      buildKey: (x) => x.peer,
      sessionToken: () => token,
      getId: (x) => x.id,
      measure: () => 1,
      budget,
      onFlush: async ([entry]) => {
        const lease = dispatcher.beginBatch(entry.item.peer);
        const offer = lease.offer(
          { type: "user_message", text: entry.item.id, id: entry.item.id },
          entry.reservation,
        );
        if (offer.status !== "accepted") throw new Error("unexpected dispatcher rejection");
        offer.commit();
        offered = true;
        await flushGate;
        lease.finish();
      },
      onCancel: async ([entry]) => {
        await cancellationGate;
        if (!entry.isRetired()) published.push(entry.item.id);
      },
    });
    d.push({ peer: "p", id: "a" });
    await tick();
    expect(offered).toBe(true);
    expect(d.cancelKey("p", { notify: true })).toBe(true);
    await Promise.resolve();
    expect(budget.snapshot(token).breakdown.pending).toEqual({ messages: 1, bytes: 1 });

    expect(d.dispose()).toEqual({ waiting: 0, inflight: 1 });
    expect(budget.usage()).toEqual({ messages: 1, bytes: 1 });
    expect(dispatcher.dispose()).toEqual({ pending: 0, provisional: 1 });
    expect(budget.usage()).toEqual({ messages: 1, bytes: 1 });
    finishCancellation();
    finishFlush();
    await tick();
    await tick();
    expect(published).toEqual([]);
    expect(handled).toEqual([]);
    expect(budget.usage()).toEqual({ messages: 0, bytes: 0 });
  });

  it("keeps one worker and no captured retired batches behind a never-settling flush", async () => {
    const budget = new InboundRetentionBudget();
    const token = budget.createSessionToken();
    let finishFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { finishFirst = resolve; });
    const started: number[] = [];
    const d = createBoundedInboundDebouncer<{ peer: string; generation: number }>({
      debounceMs: 0,
      buildKey: (x) => x.peer,
      sessionToken: () => token,
      measure: () => 1,
      budget,
      onFlush: async (entries) => {
        const generation = entries[0]?.item.generation;
        if (generation === undefined) return;
        started.push(generation);
        if (generation === 0) await firstGate;
      },
    });
    d.push({ peer: "p", generation: 0 });
    await tick();
    expect(started).toEqual([0]);
    expect(d.cancelKey("p", { notify: false })).toBe(true);
    expect(budget.usage()).toEqual({ messages: 1, bytes: 1 });

    for (let generation = 1; generation <= 50; generation++) {
      expect(d.push({ peer: "p", generation }).status).toBe("accepted");
      await tick();
      expect(d.diagnostics()).toEqual({ capturedEntries: 2, queuedBatches: 1, workers: 1 });
      expect(d.cancelKey("p", { notify: false })).toBe(true);
      expect(budget.usage()).toEqual({ messages: 1, bytes: 1 });
      expect(d.diagnostics()).toEqual({ capturedEntries: 1, queuedBatches: 0, workers: 1 });
    }

    finishFirst();
    await tick();
    await tick();
    expect(started).toEqual([0]);
    expect(d.diagnostics()).toEqual({ capturedEntries: 0, queuedBatches: 0, workers: 0 });
    expect(budget.usage()).toEqual({ messages: 0, bytes: 0 });
  });

  it.each([
    {
      cap: "message-count",
      maxMessagesPerProcess: 3,
      maxBytesPerProcess: 100,
      reason: "process-message-count",
    },
    {
      cap: "byte-count",
      maxMessagesPerProcess: 100,
      maxBytesPerProcess: 3,
      reason: "process-byte-count",
    },
  ])("keeps copied callbacks across retired keys at the exact process $cap cap", async ({
    maxMessagesPerProcess,
    maxBytesPerProcess,
    reason,
  }) => {
    const budget = new InboundRetentionBudget({
      maxMessagesPerSession: 100,
      maxBytesPerSession: 100,
      maxMessagesPerProcess,
      maxBytesPerProcess,
    });
    const tokens = new Map<string, symbol>();
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const started: string[] = [];
    const dispatched: string[] = [];
    const d = createBoundedInboundDebouncer<{ peer: string; id: string }>({
      debounceMs: 0,
      buildKey: (item) => item.peer,
      sessionToken: (key) => {
        let token = tokens.get(key);
        if (!token) {
          token = budget.createSessionToken();
          tokens.set(key, token);
        }
        return token;
      },
      getId: (item) => item.id,
      measure: () => 1,
      budget,
      onFlush: async (entries) => {
        // Match production createIngressOnFlush: copy before the first await.
        const copied = [...entries];
        started.push(...copied.map((entry) => entry.item.id));
        await gate;
        for (const entry of copied) {
          if (entry.isActive()) dispatched.push(entry.item.id);
        }
      },
    });

    for (let n = 0; n < 3; n++) {
      const peer = `peer-${n}`;
      expect(d.push({ peer, id: `id-${n}` })).toEqual({ status: "accepted" });
      await tick();
      expect(d.cancelKey(peer, { notify: false })).toBe(true);
    }
    expect(started).toEqual(["id-0", "id-1", "id-2"]);
    expect(budget.usage()).toEqual({ messages: 3, bytes: 3 });
    expect(d.usage()).toEqual({ waiting: 0, inflight: 3, keys: 3 });
    expect(d.diagnostics()).toEqual({ capturedEntries: 3, queuedBatches: 0, workers: 3 });

    expect(d.push({ peer: "peer-over", id: "id-over" })).toMatchObject({
      status: "overflow",
      reason,
    });
    expect(started).toHaveLength(3);
    expect(budget.usage()).toEqual({ messages: 3, bytes: 3 });
    expect(d.usage()).toEqual({ waiting: 0, inflight: 3, keys: 3 });

    finish();
    await tick();
    await tick();
    expect(dispatched).toEqual([]);
    expect(budget.usage()).toEqual({ messages: 0, bytes: 0 });
    expect(d.usage()).toEqual({ waiting: 0, inflight: 0, keys: 0 });
    expect(d.diagnostics()).toEqual({ capturedEntries: 0, queuedBatches: 0, workers: 0 });
  });

  it("transfers a settled flush reservation to a real dispatcher's pending queue", async () => {
    const budget = new InboundRetentionBudget({
      maxMessagesPerSession: 4,
      maxBytesPerSession: 4,
      maxMessagesPerProcess: 4,
      maxBytesPerProcess: 4,
    });
    const token = budget.createSessionToken();
    let finishRunning!: () => void;
    const running = new Promise<void>((resolve) => { finishRunning = resolve; });
    const handled: string[] = [];
    const dispatcher = createSerializedInboundDispatcher<UserMessageLike>(
      async (_key, message) => {
        handled.push(message.text);
        if (message.text === "running") await running;
      },
      { coalesce: coalesceUserMessages, budget, sessionToken: () => token, measure: () => 1 },
    );
    expect(dispatcher.dispatch("p", { type: "user_message", text: "running" })).toBe("accepted");
    await tick();
    expect(handled).toEqual(["running"]);

    const d = createBoundedInboundDebouncer<{ peer: string; id: string }>({
      debounceMs: 0,
      buildKey: (item) => item.peer,
      sessionToken: () => token,
      getId: (item) => item.id,
      measure: () => 1,
      budget,
      onFlush: (entries) => {
        const lease = dispatcher.beginBatch("p");
        for (const entry of entries) {
          const offer = lease.offer(
            { type: "user_message", text: entry.item.id, id: entry.item.id },
            entry.reservation,
          );
          if (offer.status !== "accepted") throw new Error("unexpected dispatcher rejection");
          offer.commit();
        }
        lease.finish();
      },
    });
    expect(d.push({ peer: "p", id: "pending" })).toEqual({ status: "accepted" });
    await tick();
    await tick();
    expect(dispatcher.pendingBuffered("p")).toBe(1);
    expect(budget.snapshot(token).breakdown.pending).toEqual({ messages: 1, bytes: 1 });
    expect(d.usage()).toEqual({ waiting: 0, inflight: 0, keys: 0 });

    finishRunning();
    await tick();
    await tick();
    expect(handled).toEqual(["running", "pending"]);
    expect(dispatcher.pendingBuffered("p")).toBe(0);
    expect(budget.usage()).toEqual({ messages: 0, bytes: 0 });
    d.dispose();
    dispatcher.dispose();
  });
});
