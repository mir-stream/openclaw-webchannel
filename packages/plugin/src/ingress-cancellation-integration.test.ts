import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPersistentDedupe } from "openclaw/plugin-sdk/persistent-dedupe";
import { createBoundedInboundDebouncer, type RetainedDebounceEntry } from "./bounded-inbound-debouncer.js";
import { isControlLaneMessage, shouldDropBufferedInputOnStop } from "./control-lane.js";
import { openDeliveryJournal } from "./delivery-journal.js";
import { createIngressDebounceCallbacks } from "./ingress-debounce-callbacks.js";
import { CancelledInboundFallbackTombstones, createIngressOnFlush, recordCancelledInboundItems } from "./ingress-dedupe.js";
import { createIngressOutcomeStore, type IngressOutcome } from "./ingress-outcome.js";
import { BoundedOverflowResolver } from "./inbound-overflow-resolver.js";
import { coalesceUserMessages, createSerializedInboundDispatcher, type UserMessageLike } from "./inbound-queue.js";
import { estimateRetainedMessageBytes, InboundRetentionBudget } from "./inbound-retention.js";

type Item = { peerId: string; message: UserMessageLike };
type Echo = Array<{ random_id: string; messageId: string; seq: number }>;
const item = (id: string | undefined, random_id = id): Item => ({
  peerId: "peer", message: { type: "user_message", id, random_id, text: `text-${id}` },
});
const gate = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});

/** Real SDK stores, SQLite journal, bounded owners and production ingress callbacks.
 * Only async returns are held to arrange interleavings; this is not a timing probe
 * against a live gateway. The abort recipient is an observation at the core boundary.
 */
async function setup(seed: IngressOutcome | "none" = "accepted", capacity = 3) {
  const dir = mkdtempSync(join(tmpdir(), "ingress-cancellation-"));
  const stores = () => {
    const persistent = (namespacePrefix: string) => createPersistentDedupe({
      pluginId: "webchannel", namespacePrefix, ttlMs: 604_800_000,
      memoryMaxSize: 8, stateMaxEntries: 32,
      env: { ...process.env, OPENCLAW_STATE_DIR: dir },
    });
    return createIngressOutcomeStore({
      accepted: persistent("persistent-dedupe"),
      overloaded: persistent("webchannel-inbound-overloaded"),
      cancelled: persistent("webchannel-inbound-cancelled"),
    });
  };
  const journal = openDeliveryJournal({ databasePath: join(dir, "journal.sqlite") });
  const budget = new InboundRetentionBudget({
    maxMessagesPerSession: capacity, maxMessagesPerProcess: capacity,
    maxBytesPerSession: 4096, maxBytesPerProcess: 4096,
  });
  const tokens = new Map<string, symbol>();
  const sessionToken = (peerId: string) => {
    let token = tokens.get(peerId);
    if (!token) { token = budget.createSessionToken(); tokens.set(peerId, token); }
    return token;
  };
  const runs: UserMessageLike[] = [];
  const dispatcher = createSerializedInboundDispatcher<UserMessageLike>(async (_peer, message) => {
    runs.push(message);
  }, { coalesce: coalesceUserMessages, budget, sessionToken });
  const acks: Array<{ peerId: string; ids: string[]; committed?: Echo }> = [];
  const rejected: string[][] = [];
  const sendAck = (peerId: string, ids: string[], committed?: Echo) => {
    acks.push({ peerId, ids: [...ids], committed });
    return true;
  };
  const sendRejected = (_peer: string, ids: string[]) => { rejected.push([...ids]); return true; };
  const seedStore = stores();
  if (seed === "accepted") {
    await createIngressOnFlush<Item>({
      accountId: "account", outcomeStore: seedStore, deliveryJournal: journal,
      beginBatch: (peer) => dispatcher.beginBatch(peer), sendAck,
    })([item("seed", "replay")]);
    await vi.waitFor(() => expect(dispatcher.pendingSessions()).toBe(0));
  } else if (seed !== "none") {
    const result = await seedStore.record("account", "peer:replay", seed);
    if (result.status !== "recorded") throw result.error;
    result.write.commit();
  }
  acks.length = 0;
  // A fresh reader exercises persisted refusals through the item loop, without
  // overriding peek or lookup verdicts to bypass the production fast path.
  const store = stores();
  const fallback = new CancelledInboundFallbackTombstones();
  const resolver = new BoundedOverflowResolver({
    outcomeStore: store,
    lookupUserRow: ({ peerId }, key) => journal.lookupUserMessageIdByRandomId(peerId, key),
    sendAck: ({ peerId, id }, committed) => sendAck(peerId, [id], committed),
    sendRejected: ({ peerId, id }) => sendRejected(peerId, [id]),
    onCancelledRecovered: ({ accountId, key }) => fallback.delete(key, accountId),
  });
  let active = true;
  const flush = createIngressOnFlush<Item>({
    accountId: "account", outcomeStore: store, deliveryJournal: journal,
    beginBatch: (peer) => dispatcher.beginBatch(peer), sendAck,
    sendInboundRejected: sendRejected, cancelledFallback: fallback, isActive: () => active,
  });
  const captured: RetainedDebounceEntry<Item>[] = [];
  const cancellationBatches: RetainedDebounceEntry<Item>[][] = [];
  let flushReturn: { entered: ReturnType<typeof gate>; resume: ReturnType<typeof gate> } | undefined;
  const pauseFlushReturn = () => {
    const pause = { entered: gate(), resume: gate() };
    flushReturn = pause;
    return { entered: pause.entered.promise, resume: pause.resume.resolve };
  };
  const debouncer = createBoundedInboundDebouncer<Item>({
    debounceMs: 0, buildKey: (value) => value.peerId, sessionToken, budget,
    measure: (value) => estimateRetainedMessageBytes(value.message),
    ...createIngressDebounceCallbacks<Item>({
      accountId: "account", outcomeStore: store, overflowResolver: resolver,
      cancelledFallback: fallback, deliveryJournal: journal, sessionToken, sendAck, sendRejected,
    }),
    onFlush: async (entries) => {
      captured.push(...entries);
      await flush(entries);
      if (flushReturn) {
        const pause = flushReturn;
        flushReturn = undefined;
        pause.entered.resolve();
        await pause.resume.promise;
      }
    },
    onCancel: async (entries) => {
      cancellationBatches.push([...entries]);
      await recordCancelledInboundItems(
        entries.map((entry) => entry.item), "account", async (key) => {
          const result = await store.record("account", key, "cancelled", { replaceOthers: true });
          if (result.status !== "recorded") throw result.error;
          result.write.commit();
          return true;
        }, sendAck, undefined, fallback, () => entries.every((entry) => !entry.isRetired()),
      );
    },
  });
  const abort = vi.fn();
  const clearPending = vi.spyOn(dispatcher, "clearPending");
  const stop = () => {
    const message = { type: "user_message" as const, text: "/stop", id: "stop" };
    expect(isControlLaneMessage(message)).toBe(true);
    expect(shouldDropBufferedInputOnStop(message, { delegated: false, isListed: () => true }, "peer")).toBe(true);
    // Same synchronous ordering as the account runtime's authorized control lane.
    const cancelled = debouncer.cancelKey("peer", { notify: true });
    dispatcher.clearPending("peer");
    abort(message);
    return cancelled;
  };
  const retire = (scope: "peer" | "account") => {
    if (scope === "account") { active = false; debouncer.dispose(); dispatcher.dispose(); resolver.dispose(); }
    else {
      debouncer.cancelKey("peer", { notify: false });
      dispatcher.clearPending("peer");
      resolver.invalidateSession(sessionToken("peer"));
      tokens.delete("peer");
    }
  };
  const idle = () => vi.waitFor(() => {
    expect(debouncer.usage()).toEqual({ waiting: 0, inflight: 0, keys: 0 });
    expect(debouncer.diagnostics()).toEqual({ capturedEntries: 0, queuedBatches: 0, workers: 0 });
    expect(dispatcher.pendingSessions()).toBe(0);
    expect(resolver.usage()).toEqual({ tasks: 0, metadataBytes: 0 });
    expect(budget.usage()).toEqual({ messages: 0, bytes: 0 });
    expect(budget.sessionCount()).toBe(0);
  });
  cleanups.push(async () => {
    retire("account");
    await idle();
    journal.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { store, journal, budget, dispatcher, debouncer, resolver, fallback, flush,
    captured, cancellationBatches, runs, acks, rejected, stop, abort, clearPending, retire, idle, pauseFlushReturn };
}

function holdReturn(h: Awaited<ReturnType<typeof setup>>, phase: "lookup" | "accepted" | "cancelled", key: string) {
  const entered = gate();
  const resume = gate();
  let held = false;
  const wait = async () => { held = true; entered.resolve(); await resume.promise; };
  const lookup = vi.mocked(h.store.lookup).getMockImplementation?.() ?? h.store.lookup.bind(h.store);
  const record = vi.mocked(h.store.record).getMockImplementation?.() ?? h.store.record.bind(h.store);
  const spy = phase === "lookup"
    ? vi.spyOn(h.store, "lookup").mockImplementation(async (...args) => {
        const result = await lookup(...args);
        if (!held && args[1] === key) await wait();
        return result;
      })
    : vi.spyOn(h.store, "record").mockImplementation(async (...args) => {
        const result = await record(...args);
        if (!held && args[1] === key && args[2] === phase) await wait();
        return result;
      });
  return { entered: entered.promise, resume: resume.resolve, restore: () => spy.mockRestore() };
}

describe("retained replay cancellation (#382)", () => {
  it.each([
    ["fresh-first", "lookup"], ["replay-first", "lookup"],
    ["fresh-first", "accepted"], ["replay-first", "accepted"],
  ] as const)("settles %s cancellation during a later %s return", async (order, phase) => {
    const values = [
      ...(order === "fresh-first" ? [item("fresh-a")] : []),
      item("replay-b", "replay"), item("fresh-c"),
    ];
    const h = await setup("accepted", values.length);
    const original = h.journal.read("peer");
    const later = holdReturn(h, phase, "peer:fresh-c");
    let cancellation: ReturnType<typeof holdReturn> | undefined;
    try {
      for (const value of values) expect(h.debouncer.push(value)).toEqual({ status: "accepted" });
      await later.entered;
      const charge = { messages: values.length, bytes: values.reduce((sum, value) => sum + estimateRetainedMessageBytes(value.message), 0) };
      expect(h.budget.usage()).toEqual(charge);
      expect(h.debouncer.usage()).toEqual({ waiting: 0, inflight: values.length, keys: 1 });
      // The replay already requested release. The reservation guard stays
      // strict; cancellation succeeds using ownership acquired before release.
      expect(() => h.captured.find((entry) => entry.item.message.id === "replay-b")!.reservation.hold())
        .toThrow("cannot hold a released retention reservation");
      cancellation = holdReturn(h, "cancelled", `peer:${values[0].message.random_id}`);
      expect(h.stop()).toBe(true);
      expect(h.clearPending).toHaveBeenCalledOnce();
      expect(h.abort).toHaveBeenCalledOnce();
      expect(h.acks).toEqual([]);
      expect(h.runs.map((message) => message.id)).toEqual(["seed"]);
      later.resume();
      await cancellation.entered;
      expect(h.stop()).toBe(false);
      expect(h.cancellationBatches).toHaveLength(1);
      expect(h.budget.usage()).toEqual(charge);
      // No released capacity while suppression/result delivery still owns copies.
      expect(h.debouncer.push(item("over-limit-alias", "fresh-c"))).toMatchObject({ status: "overflow" });
      expect(h.resolver.usage()).toEqual({ tasks: 0, metadataBytes: 0 });
      expect(h.acks).toEqual([]);
      cancellation.resume();
      await h.idle();
      expect(h.acks).toEqual([{ peerId: "peer", ids: values.map((value) => value.message.id), committed: undefined }]);
      expect(h.journal.read("peer")).toEqual(original);
      expect(h.runs.map((message) => message.id)).toEqual(["seed"]);
      expect(h.rejected).toEqual([]);
      for (const entry of h.captured) {
        expect(entry.reservation.released).toBe(true);
        await expect(entry.waitForCancellation()).resolves.toBeUndefined();
        expect(() => entry.reservation.hold()).toThrow("cannot hold a released retention reservation");
        expect(await h.store.lookup("account", `peer:${entry.item.message.random_id}`)).toEqual({ status: "found", outcome: "cancelled" });
      }
      expect(h.debouncer.push(item("replay-again", "replay"))).toEqual({ status: "known-outcome", outcome: "cancelled" });
      expect(h.acks.at(-1)?.committed).toEqual([{ random_id: "replay", ...h.journal.lookupUserMessageIdByRandomId("peer", "replay")! }]);
      expect(h.debouncer.push(item("next"))).toEqual({ status: "accepted" });
      await h.idle();
      expect(h.runs.map((message) => message.id)).toEqual(["seed", "next"]);
    } finally {
      later.resume(); cancellation?.resume();
      // Also settles the deliberately broken base during red reproduction.
      h.retire("account");
      await h.idle();
      cancellation?.restore(); later.restore();
    }
  });

  it.each(["cancelled", "overloaded", "fallback", "no-id", "disposed", "disposed-no-id"] as const)(
    "cancels after the %s item-loop path requested release or committed its offer", async (path) => {
      const h = await setup(path === "cancelled" || path === "overloaded" ? path : "none", 2);
      if (path === "fallback") h.fallback.add("peer:replay", "account");
      if (path.startsWith("disposed")) h.dispatcher.dispose();
      const first = path.endsWith("no-id") ? item(undefined) : item("replay-b", "replay");
      const later = holdReturn(h, "lookup", "peer:fresh-c");
      try {
        expect(h.debouncer.push(first)).toEqual({ status: "accepted" });
        expect(h.debouncer.push(item("fresh-c"))).toEqual({ status: "accepted" });
        await later.entered;
        expect(h.budget.usage().messages).toBe(2);
        expect(h.stop()).toBe(true);
        expect(h.abort).toHaveBeenCalledOnce();
        later.resume();
        await h.idle();
        expect(h.cancellationBatches).toHaveLength(1);
        expect(h.acks.at(-1)?.ids).toEqual(first.message.id ? ["replay-b", "fresh-c"] : ["fresh-c"]);
        expect(h.runs).toEqual([]);
        expect(h.rejected).toEqual([]);
        expect(h.journal.read("peer")).toEqual([]);
        expect(await h.store.lookup("account", "peer:fresh-c")).toEqual({ status: "found", outcome: "cancelled" });
        expect(h.captured.every((entry) => entry.reservation.released)).toBe(true);
      } finally {
        later.resume();
        h.retire("account");
        await h.idle();
        later.restore();
      }
    },
  );

  it.each(["normal", "stop"] as const)("returns index ownership after an already finished replay flush (%s)", async (end) => {
    const h = await setup("accepted", 1);
    const finished = h.pauseFlushReturn();
    let cancellation: ReturnType<typeof holdReturn> | undefined;
    try {
      expect(h.debouncer.push(item("replay-b", "replay"))).toEqual({ status: "accepted" });
      await finished.entered;
      expect(h.budget.usage().messages).toBe(1);
      expect(h.captured[0].reservation.released).toBe(false);
      if (end === "stop") {
        cancellation = holdReturn(h, "cancelled", "peer:replay");
        expect(h.stop()).toBe(true);
        await cancellation.entered;
      }
      finished.resume();
      if (cancellation) {
        await vi.waitFor(() => expect(h.debouncer.diagnostics().workers).toBe(0));
        // Only the running cancellation callback still retains this entry.
        expect(h.budget.usage().messages).toBe(1);
        expect(h.debouncer.diagnostics().capturedEntries).toBe(1);
        cancellation.resume();
      }
      await h.idle();
      expect(h.captured[0].reservation.released).toBe(true);
      expect(h.runs.map((message) => message.id)).toEqual(["seed"]);
      expect(h.journal.read("peer")).toHaveLength(1);
    } finally {
      finished.resume(); cancellation?.resume();
      h.retire("account");
      await h.idle();
      cancellation?.restore();
    }
  });

  it.each(["peer", "account"] as const)("keeps a running cancellation charged after %s retirement lets the flush settle", async (scope) => {
    const h = await setup("accepted", 2);
    const original = h.journal.read("peer");
    const later = holdReturn(h, "lookup", "peer:fresh-c");
    const cancellation = holdReturn(h, "cancelled", "peer:replay");
    try {
      h.debouncer.push(item("replay-b", "replay"));
      h.debouncer.push(item("fresh-c"));
      await later.entered;
      expect(h.stop()).toBe(true);
      await cancellation.entered;
      const charge = h.budget.usage();
      h.retire(scope);
      expect(h.cancellationBatches[0].every((entry) => entry.isRetired())).toBe(true);
      for (const entry of h.cancellationBatches[0]) await entry.waitForCancellation();
      later.resume();
      await vi.waitFor(() => expect(h.debouncer.diagnostics().workers).toBe(0));
      expect(h.budget.usage()).toEqual(charge);
      expect(h.debouncer.diagnostics().capturedEntries).toBe(2);
      expect(h.captured.every((entry) => !entry.reservation.released)).toBe(true);
      expect(h.acks).toEqual([]);
      cancellation.resume();
      await h.idle();
      expect(h.acks).toEqual([]);
      expect(h.runs.map((message) => message.id)).toEqual(["seed"]);
      expect(h.journal.read("peer")).toEqual(original);
      expect(h.captured.every((entry) => entry.reservation.released)).toBe(true);
      if (scope === "peer") {
        expect(h.debouncer.push(item("next"))).toEqual({ status: "accepted" });
        await h.idle();
        expect(h.runs.map((message) => message.id)).toEqual(["seed", "next"]);
      } else expect(h.debouncer.push(item("next"))).toEqual({ status: "disposed" });
    } finally {
      later.resume(); cancellation.resume();
      h.retire("account");
      await h.idle();
      cancellation.restore(); later.restore();
    }
  });

  it.each(["peer", "account"] as const)("severs a cancellation retired by %s before its callback starts", async (scope) => {
    const h = await setup("accepted", 2);
    const later = holdReturn(h, "lookup", "peer:fresh-c");
    try {
      h.debouncer.push(item("replay-b", "replay"));
      h.debouncer.push(item("fresh-c"));
      await later.entered;
      expect(h.stop()).toBe(true);
      h.retire(scope);
      expect(h.debouncer.diagnostics()).toEqual({ capturedEntries: 2, queuedBatches: 0, workers: 1 });
      expect(h.budget.usage().messages).toBe(2);
      later.resume();
      await h.idle();
      expect(h.cancellationBatches).toEqual([]);
      expect(h.acks).toEqual([]);
      expect(h.captured.every((entry) => entry.reservation.released)).toBe(true);
      expect(await h.store.lookup("account", "peer:fresh-c")).toEqual({ status: "not-found" });
      expect(h.runs.map((message) => message.id)).toEqual(["seed"]);
    } finally {
      later.resume(); h.retire("account");
      await h.idle(); later.restore();
    }
  });

  it.each(["stop", "peer", "account"] as const)("settles queued batches invalidated by %s before their flush starts", async (end) => {
    const h = await setup("accepted", 3);
    const later = holdReturn(h, "lookup", "peer:fresh-c");
    try {
      h.debouncer.push(item("replay-b", "replay"));
      h.debouncer.push(item("fresh-c"));
      await later.entered;
      expect(h.debouncer.push(item("queued"))).toEqual({ status: "accepted" });
      await vi.waitFor(() => expect(h.debouncer.diagnostics().queuedBatches).toBe(1));
      if (end === "stop") {
        expect(h.stop()).toBe(true);
        await vi.waitFor(() => expect(h.acks).toHaveLength(1));
        expect(h.acks[0].ids).toEqual(["replay-b", "fresh-c", "queued"]);
      } else h.retire(end);
      // Queued work can be severed; the two entries copied by onFlush cannot.
      expect(h.budget.usage().messages).toBe(2);
      expect(h.debouncer.diagnostics()).toEqual({ capturedEntries: 2, queuedBatches: 0, workers: 1 });
      if (end === "stop") {
        for (let n = 0; n < 3; n++) {
          expect(h.debouncer.push(item(`queued-${n}`))).toEqual({ status: "accepted" });
          await vi.waitFor(() => expect(h.debouncer.diagnostics().queuedBatches).toBe(1));
          expect(h.stop()).toBe(true);
          await vi.waitFor(() => expect(h.acks).toHaveLength(n + 2));
          expect(h.budget.usage().messages).toBe(2);
          expect(h.debouncer.diagnostics()).toEqual({ capturedEntries: 2, queuedBatches: 0, workers: 1 });
        }
      }
      later.resume();
      await h.idle();
      expect(h.captured.map((entry) => entry.item.message.id)).toEqual(["replay-b", "fresh-c"]);
      expect(h.runs.map((message) => message.id)).toEqual(["seed"]);
      expect(h.journal.read("peer")).toHaveLength(1);
      expect(await h.store.lookup("account", "peer:queued")).toEqual(end === "stop"
        ? { status: "found", outcome: "cancelled" } : { status: "not-found" });
      if (end !== "account") {
        expect(h.debouncer.push(item("next"))).toEqual({ status: "accepted" });
        await h.idle();
        expect(h.runs.map((message) => message.id)).toEqual(["seed", "next"]);
      }
    } finally {
      later.resume(); h.retire("account");
      await h.idle(); later.restore();
    }
  });

  it("cancels a replay while a journal-failure rollback return is pending", async () => {
    const h = await setup();
    const rolledBack = gate();
    const resumeRollback = gate();
    const record = h.store.record.bind(h.store);
    vi.spyOn(h.store, "record").mockImplementation(async (...args) => {
      const result = await record(...args);
      if (args[1] === "peer:fresh-a" && args[2] === "accepted" && result.status === "recorded") {
        const rollback = result.write.rollback;
        result.write.rollback = async () => {
          const removed = await rollback();
          rolledBack.resolve();
          await resumeRollback.promise;
          return removed;
        };
      }
      return result;
    });
    vi.spyOn(h.journal, "appendInboundUser").mockImplementationOnce(() => { throw new Error("journal unavailable"); });
    try {
      h.debouncer.push(item("fresh-a"));
      h.debouncer.push(item("replay-b", "replay"));
      await rolledBack.promise;
      expect(h.stop()).toBe(true);
      expect(h.abort).toHaveBeenCalledOnce();
      await vi.waitFor(() => expect(h.acks).toHaveLength(1));
      expect(h.budget.usage().messages).toBe(2);
      resumeRollback.resolve();
      await h.idle();
      expect(h.acks[0].ids).toEqual(["fresh-a", "replay-b"]);
      expect(await h.store.lookup("account", "peer:fresh-a")).toEqual({ status: "found", outcome: "cancelled" });
      expect(h.journal.read("peer")).toHaveLength(1);
      expect(h.runs.map((message) => message.id)).toEqual(["seed"]);
      expect(h.debouncer.push(item("next"))).toEqual({ status: "accepted" });
      await h.idle();
      expect(h.runs.map((message) => message.id)).toEqual(["seed", "next"]);
    } finally {
      resumeRollback.resolve(); h.retire("account");
      await h.idle();
    }
  });
});
