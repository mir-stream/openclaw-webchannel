import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createPersistentDedupe } from "openclaw/plugin-sdk/persistent-dedupe";
import { createBoundedInboundDebouncer } from "./bounded-inbound-debouncer.js";
import { shouldDropBufferedInputOnStop } from "./control-lane.js";
import { openDeliveryJournal } from "./delivery-journal.js";
import { createDispatchRecovery } from "./dispatch-recovery.js";
import { createIngressDebounceCallbacks } from "./ingress-debounce-callbacks.js";
import { CancelledInboundFallbackTombstones, createIngressOnFlush } from "./ingress-dedupe.js";
import { createIngressOutcomeStore } from "./ingress-outcome.js";
import { BoundedOverflowResolver } from "./inbound-overflow-resolver.js";
import { DEFAULT_BUSY_TURN_LIMITS, estimateRetainedMessageBytes, InboundRetentionBudget } from "./inbound-retention.js";
import type { UserMessageLike } from "./inbound-queue.js";
import { tupleStoragePaths } from "./storage-paths.js";
import { createStopControl } from "./stop-control.js";

type Item = { peerId: string; message: UserMessageLike };
type Ack = { peerId: string; ids: string[]; cancelled?: string[]; committed?: Array<{ random_id: string; messageId: string; seq: number }> };
const item = (key: string, device = "device-1", peerId = "RawPeer"): Item => ({
  peerId, message: { type: "user_message", id: `${device}:${key}`, random_id: `logical-${key}`, text: key === "S" ? "/stop" : key },
});
const gate = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});
const temporaryRoot = () => {
  const root = mkdtempSync(join(tmpdir(), "stop-control-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return root;
};

/** Production coordinator, ingress, retention and SQLite/public SDK stores.
 * Device labels model independent wire correlations in one peer. Core's abort
 * recipient is controlled here; these are not live gateway/transport tests. */
function setup(options: {
  root?: string; tenant?: string; accountId?: string; debounceMs?: number; capacity?: number;
  hold?: string[]; untilAbort?: string; holdCore?: boolean; loseStopAck?: boolean;
  onAck?: (ack: Ack) => void;
} = {}) {
  const root = options.root ?? temporaryRoot();
  const accountId = options.accountId ?? "ExactAccount";
  const paths = tupleStoragePaths({ storageRoot: root, tenant: options.tenant ?? "tenant-a", accountId });
  const journal = openDeliveryJournal({ databasePath: paths.deliveryJournalPath });
  const persistent = (namespacePrefix: string) => createPersistentDedupe({
    pluginId: "webchannel", namespacePrefix, ttlMs: 60_000, memoryMaxSize: 100, stateMaxEntries: 100,
    env: { ...process.env, OPENCLAW_STATE_DIR: join(root, "sdk") },
  });
  const store = createIngressOutcomeStore({ accepted: persistent("accepted"), overloaded: persistent("overloaded"), cancelled: persistent("cancelled") });
  const budget = new InboundRetentionBudget({ ...DEFAULT_BUSY_TURN_LIMITS,
    ...(options.capacity === undefined ? {} : { maxMessagesPerSession: options.capacity, maxMessagesPerProcess: options.capacity }),
  });
  const tokens = new Map<string, symbol>();
  const sessionToken = (peer: string) => {
    if (!tokens.has(peer)) tokens.set(peer, budget.createSessionToken());
    return tokens.get(peer)!;
  };
  let active = true;
  const holds = new Map((options.hold ?? []).map(key => [`logical-${key}`, gate()]));
  const coreHold = gate();
  if (!options.holdCore) coreHold.resolve();
  const runs: Array<{ peerId: string; message: UserMessageLike; signal?: AbortSignal }> = [];
  const acks: Ack[] = [];
  const errors: unknown[] = [];
  const rejected: string[][] = [];
  const sendAck = (peerId: string, ids: string[], committed?: Ack["committed"], cancelled?: string[]) => {
    const ack = { peerId, ids: [...ids], committed, cancelled };
    options.onAck?.(ack);
    acks.push(ack);
    return !(options.loseStopAck && ids.includes("device-2:S"));
  };
  const sendRejected = (_peer: string, ids: string[]) => { rejected.push([...ids]); return true; };
  const recovery = createDispatchRecovery({
    store: journal.dispatch!, isActive: () => active, acquirePeer: () => () => {},
    notify: () => {}, warn: error => errors.push(error), dispatcherOptions: { budget, sessionToken },
    handler: async (peerId, message, settle, ownership) => {
      runs.push({ peerId, message, signal: ownership?.abortSignal });
      if (message.random_id === `logical-${options.untilAbort}` && ownership && !ownership.abortSignal.aborted) {
        await new Promise<void>(resolve => ownership.abortSignal.addEventListener("abort", () => resolve(), { once: true }));
      }
      await holds.get(message.random_id ?? "")?.promise;
      settle("ok");
    },
  });
  recovery.start();
  const fallback = new CancelledInboundFallbackTombstones();
  const resolver = new BoundedOverflowResolver({
    outcomeStore: store, lookupUserRow: ({ peerId }, key) => journal.lookupUserMessageIdByRandomId(peerId, key),
    sendAck: ({ peerId, id }, committed, cancelled) => sendAck(peerId, [id], committed, cancelled ? [id] : undefined),
    sendRejected: ({ peerId, id }) => sendRejected(peerId, [id]),
  });
  const flush = createIngressOnFlush<Item>({
    accountId, outcomeStore: store, deliveryJournal: journal, dispatchRecovery: recovery,
    beginBatch: peer => recovery.beginBatch(peer), cancelledFallback: fallback,
    sendAck, sendInboundRejected: sendRejected, isActive: () => active,
  });
  const onCancel = vi.fn();
  const debouncer = createBoundedInboundDebouncer<Item>({
    debounceMs: options.debounceMs ?? 60_000, buildKey: value => value.peerId,
    sessionToken, budget, measure: value => estimateRetainedMessageBytes(value.message),
    ...createIngressDebounceCallbacks<Item>({
      accountId, outcomeStore: store, overflowResolver: resolver, cancelledFallback: fallback,
      deliveryJournal: journal, sessionToken, sendAck, sendRejected,
    }),
    onFlush: flush, onCancel,
  });
  const core = vi.fn(async (_peer: string, _message: UserMessageLike) => { await coreHold.promise; });
  const stop = createStopControl({ journal, recovery, debouncer, dispatchControl: core, sendAck,
    pendingOverflowKey: peer => resolver.pendingLogicalKey(sessionToken(peer)),
    retireOverflow: peer => { resolver.invalidateSession(sessionToken(peer)); },
    isActive: () => active, warn: error => errors.push(error) });
  const idle = () => vi.waitFor(() => {
    expect(debouncer.usage()).toEqual({ waiting: 0, inflight: 0, keys: 0 });
    expect(debouncer.diagnostics()).toEqual({ capturedEntries: 0, queuedBatches: 0, workers: 0 });
    expect(budget.usage()).toEqual({ messages: 0, bytes: 0 });
    expect(resolver.usage()).toEqual({ tasks: 0, metadataBytes: 0 });
  });
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => {
    active = false;
    debouncer.dispose(); recovery.dispose(); resolver.dispose();
    await stop.dispose();
    await idle();
    journal.close();
  })();
  cleanups.push(async () => {
    for (const hold of holds.values()) hold.resolve();
    coreHold.resolve();
    await close();
  });
  return { root, paths, journal, store, budget, recovery, debouncer, resolver, stop, runs, core, acks, errors, rejected, onCancel,
    fallback, flush, idle, close, release: (key: string) => holds.get(`logical-${key}`)?.resolve(), releaseCore: coreHold.resolve };
}

it("commits another device's debounced target before the stop ACK, surviving immediate teardown and reopen", async () => {
  const h = setup({ onAck: ack => {
    if (!ack.ids.includes("device-2:S")) return;
    const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
    const reader = new DatabaseSync(h.paths.deliveryJournalPath, { readOnly: true });
    try {
      expect(reader.prepare("SELECT target_count FROM journal_stop WHERE logical_key='logical-S'").get()).toMatchObject({ target_count: 1 });
      expect(reader.prepare("SELECT logical_key FROM journal_stop_target").all()).toEqual([{ logical_key: "logical-A" }]);
    } finally { reader.close(); }
  } });
  expect(h.debouncer.push(item("A"))).toEqual({ status: "accepted" });
  expect(h.stop.handle(item("S", "device-2"), true)).toMatchObject({ fresh: true, targetCount: 1 });
  expect(h.acks.map(ack => ack.ids)).toEqual([["device-1:A"], ["device-2:S"]]);
  expect(h.acks.map(ack => ack.cancelled)).toEqual([["device-1:A"], undefined]);
  expect(h.budget.usage()).toEqual({ messages: 0, bytes: 0 });
  await h.close();
  expect(h.onCancel).not.toHaveBeenCalled();
  const fresh = setup({ root: h.root });
  expect(fresh.debouncer.push(item("A", "device-1-retry"))).toEqual({ status: "known-outcome", outcome: "cancelled" });
  await fresh.flush([item("A", "device-1-retry-again")]);
  expect(fresh.runs).toEqual([]);
  expect(fresh.journal.read("RawPeer")).toEqual([]);
  expect(fresh.acks.map(ack => ack.ids)).toEqual([["device-1-retry:A"], ["device-1-retry-again:A"]]);
  expect(fresh.acks.map(ack => ack.cancelled)).toEqual([["device-1-retry:A"], ["device-1-retry-again:A"]]);
});

it("one stop durably covers running, busy-queued and debounce targets without re-running them after reopen", async () => {
  const h = setup({ hold: ["A"] });
  await h.flush([item("A")]);
  await h.flush([item("B")]);
  h.debouncer.push(item("C"));
  expect(h.runs.map(run => run.message.text)).toEqual(["A"]);
  expect(h.stop.handle(item("S", "device-2"), true)).toMatchObject({ targetCount: 3 });
  expect(h.runs[0].signal?.aborted).toBe(true);
  for (const key of ["A", "B"]) expect(h.journal.dispatch!.lookup("RawPeer", `logical-${key}`)?.state).toBe("cancelled");
  expect(h.journal.dispatch!.isCancelled("RawPeer", "logical-C")).toBe(true);
  expect(h.journal.dispatch!.lookup("RawPeer", "logical-C")).toBeUndefined();
  h.release("A");
  await h.idle();
  await h.close();
  const fresh = setup({ root: h.root });
  await fresh.flush([item("A", "retry"), item("B", "retry"), item("C", "retry")]);
  await new Promise(setImmediate);
  expect(fresh.runs).toEqual([]);
  expect(fresh.acks.at(-1)?.committed).toHaveLength(2);
  expect(fresh.acks.at(-1)?.cancelled).toEqual(["retry:A", "retry:B", "retry:C"]);
});

it.each([false, true])("a lost stop ACK cannot cancel new running/buffered work on retransmission (reopen=%s)", async reopen => {
  const original = setup({ loseStopAck: true, hold: ["B"], debounceMs: 10 });
  original.debouncer.push(item("A"));
  const receipt = original.stop.handle(item("S", "device-2"), true)!;
  await new Promise(setImmediate);
  expect(original.core).toHaveBeenCalledOnce();
  if (reopen) await original.close();
  const h = reopen ? setup({ root: original.root, hold: ["B"], debounceMs: 10 }) : original;
  await h.flush([item("B", "device-3")]);
  h.debouncer.push(item("C", "device-3"));
  const charge = h.budget.usage();
  expect(h.stop.handle(item("S", "device-2-retry"), true)).toMatchObject({ key: receipt.key, targetCount: receipt.targetCount });
  expect(h.core).toHaveBeenCalledTimes(reopen ? 0 : 1);
  expect(h.runs[0].signal?.aborted).toBe(false);
  expect(h.journal.dispatch!.lookup("RawPeer", "logical-B")?.state).toBe("started");
  expect(h.debouncer.retainedItems("RawPeer").map(value => value.message.random_id)).toEqual(["logical-C"]);
  expect(h.budget.usage()).toEqual(charge);
  expect(h.journal.dispatch!.isCancelled("RawPeer", "logical-C")).toBe(false);
  expect(h.acks.at(-1)?.ids).toEqual(["device-2-retry:S"]);
  expect(h.acks.at(-1)?.cancelled).toBeUndefined();
  h.release("B");
  await h.idle();
  expect(h.runs.map(run => run.message.text)).toEqual(["B", "C"]);
  expect(h.journal.dispatch!.lookup("RawPeer", "logical-C")?.state).toBe("completed");
});

it("a real SQLite failure midway through stop leaves no partial targets, states, receipt or success ACK", async () => {
  const h = setup({ hold: ["A"] });
  await h.flush([item("A")]); await h.flush([item("B")]);
  h.debouncer.push(item("C"));
  const before = h.journal.read("RawPeer");
  h.acks.length = 0;
  const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
  const db = new DatabaseSync(h.paths.deliveryJournalPath);
  try {
    db.exec(`CREATE TRIGGER fail_second_cancel BEFORE INSERT ON journal_event
      WHEN NEW.kind='requestState' AND NEW.message_id=(SELECT message_id FROM journal_dispatch WHERE peer_id='RawPeer' AND logical_key='logical-B')
        AND json_extract(NEW.payload,'$.state')='cancelled'
      BEGIN SELECT RAISE(ABORT, 'injected middle stop failure'); END`);
    expect(h.stop.handle(item("S", "device-2"), true)).toBeUndefined();
    expect(h.acks).toEqual([]);
    expect(h.core).not.toHaveBeenCalled();
    expect(h.errors.map(String).join("\n")).toContain("injected middle stop failure");
    expect(h.journal.dispatch!.lookupStop("RawPeer", "logical-S")).toBeUndefined();
    expect(db.prepare("SELECT count(*) AS n FROM journal_stop_target").get()).toMatchObject({ n: 0 });
    expect(h.journal.read("RawPeer")).toEqual(before);
    expect(h.journal.dispatch!.lookup("RawPeer", "logical-A")?.state).toBe("started");
    expect(h.journal.dispatch!.lookup("RawPeer", "logical-B")?.state).toBe("queued");
    expect(h.runs[0].signal?.aborted).toBe(false);
    expect(h.debouncer.retainedItems("RawPeer")).toHaveLength(1);
    db.exec("DROP TRIGGER fail_second_cancel");
    expect(h.stop.handle(item("S", "device-2"), true)).toMatchObject({ fresh: true, targetCount: 3 });
    expect(h.acks.at(-1)?.ids).toEqual(["device-2:S"]);
    expect(h.journal.dispatch!.stopChanges("RawPeer", "logical-S")).toHaveLength(2);
  } finally { h.release("A"); db.close(); }
});

it.each(["lookup", "accepted"] as const)("stops retained replay plus fresh work while a later SDK %s return is held", async phase => {
  const h = setup({ debounceMs: 0 });
  await h.flush([item("R")]);
  await vi.waitFor(() => expect(h.journal.dispatch!.lookup("RawPeer", "logical-R")?.state).toBe("completed"));
  const row = h.journal.lookupUserMessageIdByRandomId("RawPeer", "logical-R");
  const entered = gate(); const resume = gate();
  let held = false;
  const pause = async () => { held = true; entered.resolve(); await resume.promise; };
  const lookup = h.store.lookup.bind(h.store);
  const record = h.store.record.bind(h.store);
  const spy = phase === "lookup"
    ? vi.spyOn(h.store, "lookup").mockImplementation(async (...args) => {
      const result = await lookup(...args);
      if (!held && args[1] === "RawPeer:logical-A") await pause();
      return result;
    })
    : vi.spyOn(h.store, "record").mockImplementation(async (...args) => {
      const result = await record(...args);
      if (!held && args[1] === "RawPeer:logical-A" && args[2] === "accepted") await pause();
      return result;
    });
  try {
    h.debouncer.push(item("R", "retry")); h.debouncer.push(item("A"));
    await entered.promise;
    expect(h.budget.usage().messages).toBe(2);
    expect(h.stop.handle(item("S", "device-2"), true)).toMatchObject({ targetCount: 2 });
    expect(h.budget.usage().messages).toBe(2);
    expect(h.journal.dispatch!.isCancelled("RawPeer", "logical-A")).toBe(true);
    expect(h.acks.at(-1)?.ids).toEqual(["device-2:S"]);
    resume.resolve();
    await h.idle();
    expect(h.runs.map(run => run.message.text)).toEqual(["R"]);
    expect(h.journal.lookupUserMessageIdByRandomId("RawPeer", "logical-R")).toEqual(row);
    expect(h.journal.dispatch!.lookup("RawPeer", "logical-R")?.state).toBe("completed");
    expect(h.debouncer.push(item("A", "retry"))).toEqual({ status: "known-outcome", outcome: "cancelled" });
    expect(h.onCancel).not.toHaveBeenCalled();
  } finally { resume.resolve(); spy.mockRestore(); }
});

it.each(["accepted", "overloaded"] as const)("durable cancellation wins over a stale SDK %s outcome, cold and hot", async outcome => {
  const original = setup();
  original.debouncer.push(item("A")); original.stop.handle(item("S", "device-2"), true);
  const written = await original.store.record("ExactAccount", "RawPeer:logical-A", outcome);
  if (written.status !== "recorded") throw written.error;
  written.write.commit();
  await original.close();
  const h = setup({ root: original.root });
  await h.flush([item("A", "cold-retry")]);
  expect(h.runs).toEqual([]); expect(h.rejected).toEqual([]);
  await h.store.lookup("ExactAccount", "RawPeer:logical-A");
  expect(h.debouncer.push(item("A", "hot-retry"))).toEqual({ status: "known-outcome", outcome: "cancelled" });
  expect(h.acks.map(ack => ack.ids)).toEqual([["cold-retry:A"], ["hot-retry:A"]]);
  expect(h.acks.map(ack => ack.cancelled)).toEqual([["cold-retry:A"], ["hot-retry:A"]]);
});

it.each(["flush", "overflow"] as const)("proves a cold durable SDK cancellation through %s and later hot replay without a journal row", async phase => {
  const original = setup();
  const write = await original.store.record("ExactAccount", "RawPeer:logical-B", "cancelled");
  if (write.status !== "recorded") throw write.error;
  expect(write.durability).toBe("durable"); write.write.commit();
  await original.close();
  const h = setup({ root: original.root, capacity: 1 });
  expect(h.store.peek("ExactAccount", "RawPeer:logical-B")).toBeUndefined();
  if (phase === "flush") await h.flush([item("B", "cold")]);
  else {
    h.debouncer.push(item("A"));
    expect(h.debouncer.push(item("B", "cold"))).toMatchObject({ status: "overflow" });
    await vi.waitFor(() => expect(h.resolver.usage().tasks).toBe(0));
  }
  expect(h.acks).toEqual([{ peerId: "RawPeer", ids: ["cold:B"], committed: undefined, cancelled: ["cold:B"] }]);
  expect(h.debouncer.push(item("B", "hot"))).toEqual({ status: "known-outcome", outcome: "cancelled" });
  expect(h.acks.at(-1)?.cancelled).toEqual(["hot:B"]);
  expect(h.journal.lookupUserMessageIdByRandomId("RawPeer", "logical-B")).toBeUndefined();
  expect(h.runs).toEqual([]);
});

it.each(["flush", "overflow"] as const)("withholds cancellation proof for memory-only and unknown fallback writes through %s", async phase => {
  const h = setup({ capacity: 1 });
  h.fallback.add("RawPeer:logical-B", "ExactAccount");
  const commit = vi.fn(); const rollback = vi.fn(async () => true);
  const record = h.store.record.bind(h.store);
  const fault = vi.spyOn(h.store, "record").mockImplementationOnce(async () => ({ status: "recorded",
    durability: "memory-only", write: { outcome: "cancelled", durability: "memory-only", created: true, commit, rollback },
  })).mockImplementationOnce(async () => ({ status: "unknown", error: new Error("write unavailable") }));
  const retry = async (device: string) => {
    if (phase === "flush") await h.flush([item("B", device)]);
    else {
      expect(h.debouncer.push(item("B", device))).toMatchObject({ status: "overflow" });
      await vi.waitFor(() => expect(h.resolver.usage().tasks).toBe(0));
    }
  };
  if (phase === "overflow") h.debouncer.push(item("A"));
  await retry("memory"); await retry("unknown");
  expect(commit).not.toHaveBeenCalled(); expect(rollback).toHaveBeenCalledOnce();
  expect(h.acks).toEqual([]); expect(h.rejected).toEqual([]); expect(h.runs).toEqual([]);
  expect(h.fallback.has("RawPeer:logical-B", "ExactAccount")).toBe(true);
  // A durable retry can now prove cancellation, and the stored marker survives reopen.
  fault.mockImplementation(record);
  await retry("durable");
  expect(h.acks.at(-1)?.cancelled).toEqual(["durable:B"]);
  expect(await h.store.lookup("ExactAccount", "RawPeer:logical-B")).toEqual({ status: "found", outcome: "cancelled" });
});

it("withholds every receipt when the durable cancellation read fails", async () => {
  const h = setup();
  h.debouncer.push(item("A")); h.stop.handle(item("S", "device-2"), true);
  h.acks.length = 0;
  vi.spyOn(h.journal.dispatch!, "isCancelled").mockImplementation(() => { throw new Error("SQLite read unavailable"); });
  await h.flush([item("A", "read-fault")]);
  expect(() => h.debouncer.push(item("A", "hot-read-fault"))).toThrow("SQLite read unavailable");
  expect(h.acks).toEqual([]); expect(h.runs).toEqual([]);
});

it.each(["lookup", "overloaded"] as const)("retires a cold overflow alias held at its SDK %s return before sending the stop ACK", async phase => {
  const h = setup({ capacity: 1, hold: ["A"] });
  // A recovered/expired-marker request can still have a queued SQLite payload
  // when its SDK optimization marker is absent. C consumes the one reservation.
  h.recovery.accept("RawPeer", [{ text: "A", turnId: "device-1:A", randomId: "logical-A" }]);
  h.debouncer.push(item("C"));
  const entered = gate(); const resume = gate();
  const lookup = h.store.lookup.bind(h.store);
  const record = h.store.record.bind(h.store);
  let held = false;
  const pause = async () => { held = true; entered.resolve(); await resume.promise; };
  const spy = phase === "lookup"
    ? vi.spyOn(h.store, "lookup").mockImplementation(async (...args) => {
      const result = await lookup(...args);
      if (!held && args[1] === "RawPeer:logical-A") await pause();
      return result;
    })
    : vi.spyOn(h.store, "record").mockImplementation(async (...args) => {
      const result = await record(...args);
      if (!held && args[1] === "RawPeer:logical-A" && args[2] === "overloaded") await pause();
      return result;
    });
  try {
    expect(h.debouncer.push(item("A", "overflow-alias"))).toMatchObject({ status: "overflow" });
    await entered.promise;
    expect(h.resolver.usage().tasks).toBe(1);
    expect(h.stop.handle(item("S", "device-2"), true)).toMatchObject({ targetCount: 2 });
    // Even while the retired resolver still owns its metadata, a new alias is
    // answered from the SQLite cancellation rather than joining that resolver.
    expect(h.debouncer.push(item("A", "post-stop-retry"))).toEqual({ status: "known-outcome", outcome: "cancelled" });
    expect(h.acks.at(-1)?.ids).toEqual(["post-stop-retry:A"]);
    resume.resolve(); h.release("A");
    await h.idle();
    expect(h.rejected).toEqual([]);
    expect(await h.store.lookup("ExactAccount", "RawPeer:logical-A")).toEqual({ status: "not-found" });
    expect(h.journal.dispatch!.lookup("RawPeer", "logical-A")?.state).toBe("cancelled");
  } finally { resume.resolve(); h.release("A"); spy.mockRestore(); }
});

it.each(["lookup", "overloaded"] as const)("atomically captures overflow-only B held at its SDK %s return before retiring it", async phase => {
  const h = setup({ capacity: 1, onAck: ack => {
    if (ack.ids.includes("device-2:S")) {
      expect(h.journal.dispatch!.isCancelled("RawPeer", "logical-B")).toBe(true);
    }
  } });
  expect(h.debouncer.push(item("A"))).toEqual({ status: "accepted" });
  const entered = gate(); const resume = gate();
  const lookup = h.store.lookup.bind(h.store);
  const record = h.store.record.bind(h.store);
  const pause = async () => { entered.resolve(); await resume.promise; };
  const spy = phase === "lookup"
    ? vi.spyOn(h.store, "lookup").mockImplementation(async (...args) => {
      const result = await lookup(...args);
      if (args[1] === "RawPeer:logical-B") await pause();
      return result;
    })
    : vi.spyOn(h.store, "record").mockImplementation(async (...args) => {
      const result = await record(...args);
      if (args[1] === "RawPeer:logical-B" && args[2] === "overloaded") await pause();
      return result;
    });
  try {
    expect(h.debouncer.push(item("B"))).toMatchObject({ status: "overflow" });
    await entered.promise;
    expect(h.journal.dispatch!.lookup("RawPeer", "logical-B")).toBeUndefined();
    expect(h.debouncer.retainedItems("RawPeer").map(entry => entry.message.text)).toEqual(["A"]);
    expect(h.stop.handle(item("S", "device-2"), true)).toMatchObject({ targetCount: 2 });
    expect(h.journal.dispatch!.isCancelled("RawPeer", "logical-B")).toBe(true);
    expect(h.debouncer.push(item("B", "retry-while-held"))).toEqual({ status: "known-outcome", outcome: "cancelled" });
    resume.resolve(); spy.mockRestore();
    await h.idle();
    expect(await h.store.lookup("ExactAccount", "RawPeer:logical-B")).toEqual({ status: "not-found" });
    expect(h.rejected).toEqual([]);
    expect(h.runs).toEqual([]);
    await h.close();
    const fresh = setup({ root: h.root, debounceMs: 0 });
    expect(fresh.debouncer.push(item("B", "reopen-retry"))).toEqual({ status: "known-outcome", outcome: "cancelled" });
    await fresh.flush([item("B", "cold-flush-retry")]);
    expect(fresh.runs).toEqual([]);
    expect(fresh.journal.read("RawPeer")).toEqual([]);
  } finally { resume.resolve(); spy.mockRestore(); }
});

it("isolates cancellation and command receipts by exact tenant, account and raw peer", async () => {
  const root = temporaryRoot();
  const first = setup({ root, debounceMs: 0 });
  const otherTenant = setup({ root, tenant: "tenant-b", debounceMs: 0 });
  const otherAccount = setup({ root, accountId: "OtherAccount", debounceMs: 0 });
  for (const h of [first, otherTenant, otherAccount]) h.debouncer.push(item("A"));
  first.debouncer.push(item("A", "device-1", "rawpeer"));
  first.stop.handle(item("S", "device-2"), true);
  expect(first.journal.dispatch!.isCancelled("rawpeer", "logical-A")).toBe(false);
  for (const h of [otherTenant, otherAccount]) {
    expect(h.journal.dispatch!.lookupStop("RawPeer", "logical-S")).toBeUndefined();
    expect(h.journal.dispatch!.isCancelled("RawPeer", "logical-A")).toBe(false);
  }
  await vi.waitFor(() => {
    expect(first.runs.map(run => run.peerId)).toEqual(["rawpeer"]);
    expect(otherTenant.runs.map(run => run.message.text)).toEqual(["A"]);
    expect(otherAccount.runs.map(run => run.message.text)).toEqual(["A"]);
  });
  for (const h of [otherTenant, otherAccount]) expect(h.stop.handle(item("S", "device-2"), true)).toMatchObject({ fresh: true, targetCount: 0 });
  expect(first.stop.handle(item("S", "device-2", "rawpeer"), true)).toMatchObject({ fresh: true, targetCount: 0 });
});

it.each(["unlisted", "natural-language"] as const)("retains buffered work when the command policy is %s, including a later retransmission", async policy => {
  const h = setup();
  h.debouncer.push(item("A"));
  const control = item("S", "device-2");
  if (policy === "natural-language") control.message.text = "stop";
  const cancelBuffered = shouldDropBufferedInputOnStop(control.message, { delegated: true, isListed: () => policy !== "unlisted" }, control.peerId);
  expect(cancelBuffered).toBe(false);
  expect(h.stop.handle(control, cancelBuffered)).toMatchObject({ cancelBuffered: false, targetCount: 0 });
  expect(h.stop.handle(item("S", "retry"), true)).toMatchObject({ cancelBuffered: false, targetCount: 0 });
  expect(h.debouncer.retainedItems("RawPeer")).toHaveLength(1);
  expect(h.journal.dispatch!.isCancelled("RawPeer", "logical-A")).toBe(false);
  expect(h.core).toHaveBeenCalledOnce();
});

it("holds a newly accepted turn until the earlier asynchronous core abort has settled", async () => {
  const h = setup({ untilAbort: "A", holdCore: true });
  await h.flush([item("A")]);
  h.stop.handle(item("S", "device-2"), true);
  await h.flush([item("B", "device-3")]);
  await new Promise(setImmediate);
  expect(h.runs.map(run => run.message.text)).toEqual(["A"]);
  expect(h.journal.dispatch!.lookup("RawPeer", "logical-B")?.state).toBe("queued");
  h.releaseCore();
  await vi.waitFor(() => expect(h.runs.map(run => run.message.text)).toEqual(["A", "B"]));
  expect(h.runs[1].signal?.aborted).toBe(false);
});

it("teardown drains the old core control invocation before an account replacement can finish opening", async () => {
  const h = setup({ holdCore: true });
  h.debouncer.push(item("A")); h.stop.handle(item("S", "device-2"), true);
  let closed = false;
  const closing = h.close().then(() => { closed = true; });
  await new Promise(setImmediate);
  expect(closed).toBe(false);
  expect(h.budget.usage()).toEqual({ messages: 0, bytes: 0 });
  const count = h.acks.length;
  h.stop.handle(item("S", "late-retry"), true);
  expect(h.acks).toHaveLength(count);
  h.releaseCore(); await closing;
  const fresh = setup({ root: h.root });
  await fresh.flush([item("B", "device-3")]);
  fresh.stop.handle(item("S", "device-2-retry"), true);
  expect(fresh.core).not.toHaveBeenCalled();
  expect(fresh.runs.map(run => run.message.text)).toEqual(["B"]);
  expect(fresh.journal.dispatch!.isCancelled("RawPeer", "logical-A")).toBe(true);
});

it("upgrades a schema 1 journal without changing existing queued or historical requests", async () => {
  const h = setup();
  h.recovery.accept("RawPeer", [{ text: "B", turnId: "device-1:B", randomId: "logical-B" }]);
  h.journal.appendInboundUser("RawPeer", { text: "old", turnId: "old-wire", randomId: "old-logical" });
  const events = h.journal.read("RawPeer");
  const queued = h.journal.dispatch!.lookup("RawPeer", "logical-B");
  await h.close();
  const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
  const db = new DatabaseSync(h.paths.deliveryJournalPath);
  try {
    db.exec("DROP TABLE journal_stop_target; DROP TABLE journal_stop; UPDATE journal_meta SET value='1' WHERE key='dispatch_schema_version'");
    const migrated = openDeliveryJournal({ databasePath: h.paths.deliveryJournalPath });
    try {
      expect(migrated.read("RawPeer")).toEqual(events);
      expect(migrated.dispatch!.lookup("RawPeer", "logical-B")).toEqual(queued);
      expect(migrated.dispatch!.lookup("RawPeer", "old-logical")).toBeUndefined();
      expect(migrated.dispatch!.lookupStop("RawPeer", "logical-S")).toBeUndefined();
      expect(db.prepare("SELECT value FROM journal_meta WHERE key='dispatch_schema_version'").get()).toMatchObject({ value: "2" });
    } finally { migrated.close(); }
  } finally { db.close(); }
});
