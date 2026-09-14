import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createPersistentDedupe } from "openclaw/plugin-sdk/persistent-dedupe";
import { createBoundedInboundDebouncer } from "./bounded-inbound-debouncer.js";
import { openDeliveryJournal } from "./delivery-journal.js";
import { createIngressDebounceCallbacks } from "./ingress-debounce-callbacks.js";
import { CancelledInboundFallbackTombstones, createIngressOnFlush, ingressDedupeKey, recordCancelledInboundItems } from "./ingress-dedupe.js";
import { createIngressOutcomeStore } from "./ingress-outcome.js";
import { BoundedOverflowResolver } from "./inbound-overflow-resolver.js";
import { estimateRetainedMessageBytes, InboundRetentionBudget } from "./inbound-retention.js";
import { coalesceUserMessages, createSerializedInboundDispatcher, type UserMessageLike } from "./inbound-queue.js";

type Item = { peerId: string; message: UserMessageLike & { random_id?: string } };
type Echo = Array<{ random_id: string; messageId: string; seq: number }>;
const item = (id: string, random_id?: string, peerId = "peer"): Item => ({
  peerId, message: { type: "user_message", text: `text-${id}`, id, random_id },
});

it.each([undefined, "", "x".repeat(129), 7, {}])("falls back to wire identity for absent/invalid random_id %j", async (randomId) => {
  const h = setup();
  const message = item("legacy", randomId as string | undefined);
  expect(ingressDedupeKey(message)).toBe("peer:legacy");
  await h.flush([message]);
  h.acks.length = 0;
  h.fill();
  for (let i = 0; i < 2; i++) {
    expect(h.debouncer.push(message).status).toBe("overflow");
    await h.idle();
    expect(h.acks.at(-1)).toEqual({ peerId: "peer", ids: ["legacy"], committed: undefined });
  }
  expect(h.rejected).toEqual([]);
  expect(h.runs).toHaveLength(1);
  expect(h.journal.read("peer")).toHaveLength(1);
});

it.each([undefined, "", "x".repeat(129), 7, {}])("does not create a logical key without a usable wire ID %j", async (wireId) => {
  const h = setup();
  const message = item(wireId as string, "logical");
  expect(ingressDedupeKey(message)).toBeUndefined();
  h.fill();
  expect(h.debouncer.push(message).status).toBe("overflow");
  await h.idle();
  expect(h.acks).toEqual([]);
  expect(h.rejected).toEqual([]);
  expect(await h.store.lookup("account", "peer:logical")).toEqual({ status: "not-found" });
});

it.each(["same", "x".repeat(128)])("echoes an explicit valid random_id equal to the wire ID (%s)", async (id) => {
  const h = setup();
  await h.flush([item(id, id)]);
  const echo = h.acks[0].committed;
  expect(echo).toHaveLength(1);
  h.fill();
  expect(h.debouncer.push(item(id, id)).status).toBe("overflow");
  await h.idle();
  expect(h.acks.at(-1)).toEqual({ peerId: "peer", ids: [id], committed: echo });
  expect(h.rejected).toEqual([]);
});

it("shares one fresh admission across same-batch wire correlations and second retries", async () => {
  const h = setup();
  expect(h.debouncer.push(item("first", "logical")).status).toBe("accepted");
  expect(h.debouncer.push(item("retry", "logical")).status).toBe("accepted");
  expect(h.debouncer.push(item("retry", "logical")).status).toBe("duplicate-inflight");
  await h.idle();
  expect(h.acks[0].ids).toEqual(["first", "retry"]);
  expect(h.acks[0].committed).toHaveLength(1);
  expect(h.runs.map((message) => message.text)).toEqual(["text-first"]);
  expect(h.journal.read("peer")).toHaveLength(1);
  expect(h.budget.usage()).toEqual({ messages: 0, bytes: 0 });
  for (const id of ["retry", "second-retry"]) {
    expect(h.debouncer.push(item(id, "logical")).status).toBe("accepted");
    await h.idle();
    expect(h.acks.at(-1)?.ids).toEqual([id]);
    expect(h.acks.at(-1)?.committed).toEqual(h.acks[0].committed);
  }
  expect(h.runs).toHaveLength(1);
});

it("cancels a same-batch alias while a later logical lookup is pending", async () => {
  const h = setup();
  const lookup = h.store.lookup.bind(h.store);
  let resume!: () => void;
  let laterLookupPending = false;
  const gate = new Promise<void>((resolve) => { resume = resolve; });
  vi.spyOn(h.store, "lookup").mockImplementation(async (...args) => {
    const result = await lookup(...args);
    if (args[1] === "peer:later") {
      laterLookupPending = true;
      await gate;
    }
    return result;
  });
  try {
    for (const value of [item("wire-first", "logical"), item("wire-alias", "logical"), item("wire-later", "later")]) {
      expect(h.debouncer.push(value).status).toBe("accepted");
    }
    await vi.waitFor(() => expect(laterLookupPending).toBe(true));
    expect(h.debouncer.usage()).toEqual({ waiting: 0, inflight: 3, keys: 1 });
    expect(h.budget.usage().messages).toBe(3);
    expect(() => {
      expect(h.debouncer.cancelKey("peer", { notify: true })).toBe(true);
      h.dispatcher.clearPending("peer");
    }).not.toThrow();
    expect(h.acks).toEqual([]);
    expect(h.runs).toEqual([]);
    expect(h.journal.read("peer")).toEqual([]);
  } finally {
    resume();
    await h.idle();
  }
  expect(h.acks).toEqual([{ peerId: "peer", ids: ["wire-first", "wire-alias", "wire-later"], committed: undefined }]);
  expect(h.debouncer.diagnostics()).toEqual({ capturedEntries: 0, queuedBatches: 0, workers: 0 });
  expect(h.budget.usage()).toEqual({ messages: 0, bytes: 0 });
  for (const logicalId of ["logical", "later"]) {
    expect(await h.store.lookup("account", `peer:${logicalId}`)).toEqual({ status: "found", outcome: "cancelled" });
    const wireId = `${logicalId}-retry`;
    expect(h.debouncer.push(item(wireId, logicalId))).toEqual({ status: "known-outcome", outcome: "cancelled" });
    expect(h.acks.at(-1)).toEqual({ peerId: "peer", ids: [wireId], committed: undefined });
  }
  expect(h.rejected).toEqual([]);
  expect(h.runs).toEqual([]);
  expect(h.journal.read("peer")).toEqual([]);
  expect(h.budget.usage()).toEqual({ messages: 0, bytes: 0 });
});

it.each([
  ["waiting", "count"], ["inflight", "count"],
  ["waiting", "measurement"], ["inflight", "measurement"],
])("leaves an over-limit alias for retry while its original is %s (%s)", async (stage, limit) => {
  let failMeasurement = false;
  const h = setup({ measure: (value) => {
    if (failMeasurement) throw new Error("measurement failed");
    return estimateRetainedMessageBytes(value.message);
  } });
  let resumeLookup = () => {};
  let lookupFinished = false;
  if (stage === "inflight") {
    const lookup = h.store.lookup.bind(h.store);
    const gate = new Promise<void>((resolve) => { resumeLookup = resolve; });
    vi.spyOn(h.store, "lookup").mockImplementationOnce(async (...args) => {
      const result = await lookup(...args);
      lookupFinished = true;
      await gate;
      return result;
    });
  }
  if (limit === "count") h.fill(31);
  try {
    expect(h.debouncer.push(item("wire-first", "logical")).status).toBe("accepted");
    if (stage === "inflight") {
      await vi.waitFor(() => expect(lookupFinished).toBe(true));
      expect(h.debouncer.usage().inflight).toBe(1);
    } else {
      expect(h.debouncer.usage().waiting).toBe(1);
    }
    expect(h.debouncer.push(item("wire-first", "logical")).status).toBe("duplicate-inflight");
    const retained = h.budget.usage();
    failMeasurement = limit === "measurement";
    expect(h.debouncer.push(item("wire-retry", "logical"))).toMatchObject({
      status: "overflow", reason: limit === "count" ? "session-message-count" : "session-byte-count",
    });
    failMeasurement = false;
    expect(h.pressure).toHaveBeenCalledOnce();
    expect(h.pressure).toHaveBeenCalledWith(expect.objectContaining({ deferToRetained: true }));
    expect(h.budget.usage()).toEqual(retained);
    expect(h.resolver.usage()).toEqual({ tasks: 0, metadataBytes: 0 });
    expect(h.acks).toEqual([]);
    expect(h.rejected).toEqual([]);
  } finally {
    resumeLookup();
    await h.idle();
  }
  expect(h.runs).toHaveLength(1);
  expect(h.journal.read("peer")).toHaveLength(1);
  const row = h.journal.lookupUserMessageIdByRandomId("peer", "logical")!;
  const committed = [{ random_id: "logical", ...row }];
  expect(h.acks).toEqual([{ peerId: "peer", ids: ["wire-first"], committed }]);
  expect(await h.store.lookup("account", "peer:logical")).toEqual({ status: "found", outcome: "accepted" });
  expect(h.budget.usage()).toEqual(limit === "count" ? { messages: 31, bytes: 31 * 512 } : { messages: 0, bytes: 0 });
  h.release();
  for (const wireId of ["wire-retry", "wire-second-retry"]) {
    expect(h.debouncer.push(item(wireId, "logical")).status).toBe("accepted");
    await h.idle();
    expect(h.acks.at(-1)).toEqual({ peerId: "peer", ids: [wireId], committed });
  }
  expect(h.rejected).toEqual([]);
  expect(h.runs).toHaveLength(1);
  expect(h.journal.read("peer")).toHaveLength(1);
  expect(h.budget.usage()).toEqual({ messages: 0, bytes: 0 });
  expect(await h.store.lookup("account", "peer:logical")).toEqual({ status: "found", outcome: "accepted" });
});

it("keeps an overflow-first verdict when an alias arrives after normal capacity returns", async () => {
  const h = setup();
  h.fill();
  const lookup = h.store.lookup.bind(h.store);
  let resume!: () => void;
  const gate = new Promise<void>((resolve) => { resume = resolve; });
  vi.spyOn(h.store, "lookup").mockImplementationOnce(async (...args) => { await gate; return lookup(...args); });
  try {
    expect(h.debouncer.push(item("wire-first", "logical")).status).toBe("overflow");
    expect(h.resolver.hasActiveClaim("account", "peer:logical")).toBe(true);
    h.release();
    expect(h.debouncer.push(item("wire-retry", "logical")).status).toBe("overflow-inflight");
    expect(h.resolver.usage().tasks).toBe(1);
    expect(h.debouncer.usage()).toEqual({ waiting: 0, inflight: 0, keys: 0 });
    expect(h.budget.usage()).toEqual({ messages: 0, bytes: 0 });
  } finally {
    resume();
    await h.idle();
  }
  expect(h.acks).toEqual([]);
  expect(h.rejected.map((value) => value.ids)).toEqual([["wire-first"], ["wire-retry"]]);
  expect(h.runs).toEqual([]);
  expect(h.journal.read("peer")).toEqual([]);
  expect(await h.store.lookup("account", "peer:logical")).toEqual({ status: "found", outcome: "overloaded" });
  expect(h.debouncer.push(item("wire-second-retry", "logical"))).toEqual({ status: "known-outcome", outcome: "overloaded" });
  expect(h.rejected.at(-1)?.ids).toEqual(["wire-second-retry"]);
});

it("leaves an over-limit alias to the original's pending cancellation", async () => {
  const h = setup();
  h.fill(31);
  const record = h.store.record.bind(h.store);
  let resume!: () => void;
  const gate = new Promise<void>((resolve) => { resume = resolve; });
  const cancellation = vi.spyOn(h.store, "record").mockImplementationOnce(async (...args) => { await gate; return record(...args); });
  try {
    expect(h.debouncer.push(item("wire-first", "logical")).status).toBe("accepted");
    expect(h.debouncer.cancelKey("peer", { notify: true })).toBe(true);
    await vi.waitFor(() => expect(cancellation).toHaveBeenCalledOnce());
    const retained = h.budget.usage();
    expect(h.debouncer.push(item("wire-retry", "logical")).status).toBe("overflow");
    expect(h.pressure).toHaveBeenCalledWith(expect.objectContaining({ deferToRetained: true }));
    expect(h.resolver.usage()).toEqual({ tasks: 0, metadataBytes: 0 });
    expect(h.budget.usage()).toEqual(retained);
    expect(h.acks).toEqual([]);
    expect(h.rejected).toEqual([]);
  } finally {
    resume();
    await h.idle();
  }
  expect(h.budget.usage()).toEqual({ messages: 31, bytes: 31 * 512 });
  h.release();
  expect(h.debouncer.push(item("wire-retry", "logical"))).toEqual({ status: "known-outcome", outcome: "cancelled" });
  expect(h.acks.map((value) => value.ids)).toEqual([["wire-first"], ["wire-retry"]]);
  expect(h.rejected).toEqual([]);
  expect(h.runs).toEqual([]);
  expect(h.journal.read("peer")).toEqual([]);
  expect(await h.store.lookup("account", "peer:logical")).toEqual({ status: "found", outcome: "cancelled" });
  expect(h.budget.usage()).toEqual({ messages: 0, bytes: 0 });
});

it("preserves a later explicit random_id echo when a same-batch original used wire fallback", async () => {
  const h = setup();
  h.debouncer.push(item("logical"));
  h.debouncer.push(item("retry", "logical"));
  await h.idle();
  const row = h.journal.lookupUserMessageIdByRandomId("peer", "logical")!;
  expect(h.acks).toEqual([{ peerId: "peer", ids: ["logical", "retry"], committed: [{ random_id: "logical", ...row }] }]);
  expect(h.runs).toHaveLength(1);
});

it("keeps distinct logical requests even when they reuse or exchange wire values", async () => {
  const h = setup();
  for (const message of [item("wire", "one"), item("wire", "two"), item("one", "wire")]) {
    expect(h.debouncer.push(message).status).toBe("accepted");
  }
  await h.idle();
  expect(h.journal.read("peer")).toHaveLength(3);
  const rows = ["one", "two", "wire"].map((key) => h.journal.lookupUserMessageIdByRandomId("peer", key));
  expect(new Set(rows.map((row) => row?.messageId)).size).toBe(3);
  h.fill();
  for (const message of [item("two", "one"), item("one", "two"), item("wire", "wire")]) {
    h.debouncer.push(message);
    await h.idle();
    expect(h.acks.at(-1)?.ids).toEqual([message.message.id]);
    expect(h.acks.at(-1)?.committed?.[0].random_id).toBe(message.message.random_id);
  }
  expect(h.rejected).toEqual([]);
});

it("keeps a new wire correlation through a stalled overflow lookup", async () => {
  const h = setup();
  await h.flush([item("first", "logical")]);
  h.acks.length = 0;
  h.fill();
  const lookup = h.store.lookup.bind(h.store);
  let resume!: () => void;
  const gate = new Promise<void>((resolve) => { resume = resolve; });
  vi.spyOn(h.store, "lookup").mockImplementationOnce(async (...args) => { await gate; return lookup(...args); });
  h.debouncer.push(item("first", "logical"));
  expect(h.resolver.hasActiveClaim("account", "peer:logical")).toBe(true);
  expect(h.resolver.hasActiveClaim("account", "peer:first")).toBe(false);
  expect(h.debouncer.push(item("retry", "logical")).status).toBe("overflow-inflight");
  expect(h.resolver.usage().tasks).toBe(1);
  resume();
  await h.idle();
  expect(h.acks.map((ack) => ack.ids)).toEqual([["first"], ["retry"]]);
  expect(h.acks[1].committed).toEqual(h.acks[0].committed);
  expect(h.rejected).toEqual([]);
  expect(h.runs).toHaveLength(1);
});

it("records overflow under the canonical key and preserves rejection correlation on normal retries", async () => {
  const h = setup();
  h.fill();
  h.debouncer.push(item("first", "logical"));
  await h.idle();
  h.release();
  for (const id of ["retry", "second-retry"]) {
    expect(h.debouncer.push(item(id, "logical"))).toEqual({ status: "known-outcome", outcome: "overloaded" });
    expect(h.rejected.at(-1)?.ids).toEqual([id]);
  }
  expect(await h.store.lookup("account", "peer:logical")).toEqual({ status: "found", outcome: "overloaded" });
  expect(await h.store.lookup("account", "peer:first")).toEqual({ status: "not-found" });
  expect(h.runs).toEqual([]);
  expect(h.budget.usage()).toEqual({ messages: 0, bytes: 0 });
});

it("leaves accepted orphans unresolved under pressure and re-admits once after pressure clears", async () => {
  const h = setup();
  const recorded = await h.store.record("account", "peer:logical", "accepted");
  if (recorded.status !== "recorded") throw new Error("seed failed");
  recorded.write.commit();
  h.fill();
  for (const id of ["first", "retry"]) {
    h.debouncer.push(item(id, "logical"));
    await h.idle();
    expect(h.acks).toEqual([]);
    expect(h.rejected).toEqual([]);
  }
  h.release();
  h.debouncer.push(item("recovered", "logical"));
  await h.idle();
  expect(h.acks[0].ids).toEqual(["recovered"]);
  expect(h.acks[0].committed).toHaveLength(1);
  h.debouncer.push(item("second-retry", "logical"));
  await h.idle();
  expect(h.runs).toHaveLength(1);
  expect(h.journal.read("peer")).toHaveLength(1);
});

it.each([[false, false], [false, true], [true, false], [true, true]])("recovers /stop fallback across stages and later retries (journaled: %s, pressure: %s)", async (journaled, pressure) => {
  const h = setup();
  if (journaled) h.journal.appendInboundUser("peer", { text: "killed", turnId: "first", randomId: "logical" });
  h.loseAck(true);
  const record = vi.spyOn(h.store, "record").mockRejectedValueOnce(new Error("suppression write failed"));
  h.debouncer.push(item("first", "logical"));
  h.debouncer.push(item("retry", "logical"));
  h.debouncer.cancelKey("peer", { notify: true });
  await h.idle();
  expect(h.fallback.has("peer:logical", "account")).toBe(true);
  record.mockRestore();
  h.acks.length = 0;
  if (pressure) h.fill();
  h.debouncer.push(item("overflow-retry", "logical"));
  await h.idle();
  expect(h.fallback.has("peer:logical", "account")).toBe(true);
  h.loseAck(false);
  h.debouncer.push(item("overflow-second", "logical"));
  await h.idle();
  expect(h.fallback.size).toBe(0);
  expect(h.fallback.byteSize).toBe(0);
  h.release();
  expect(h.debouncer.push(item("after-recovery", "logical"))).toEqual({ status: "known-outcome", outcome: "cancelled" });
  expect(h.acks.map((ack) => ack.ids)).toEqual([["overflow-retry"], ["overflow-second"], ["after-recovery"]]);
  for (const ack of h.acks) expect(ack.committed?.length ?? 0).toBe(journaled ? 1 : 0);
  expect(h.rejected).toEqual([]);
  expect(h.runs).toEqual([]);
  expect(h.resolver.hasActiveClaim("account", "peer:logical")).toBe(false);
  expect(await h.store.lookup("account", "peer:logical")).toEqual({ status: "found", outcome: "cancelled" });
});

it("isolates account and peer outcomes when logical and wire IDs match", async () => {
  const h = setup();
  await h.flush([item("wire", "logical")]);
  const other = setup({ accountId: "other-account", store: h.store });
  other.fill();
  other.debouncer.push(item("wire", "logical"));
  await other.idle();
  expect(other.rejected).toEqual([{ peerId: "peer", ids: ["wire"] }]);
  h.fill();
  h.debouncer.push(item("wire", "logical", "other-peer"));
  await h.idle();
  expect(h.rejected).toEqual([{ peerId: "other-peer", ids: ["wire"] }]);
  h.debouncer.push(item("retry", "logical"));
  await h.idle();
  expect(h.acks.at(-1)?.ids).toEqual(["retry"]);
  expect(h.acks.at(-1)?.committed).toHaveLength(1);
  expect(other.journal.read("peer")).toEqual([]);
});
const cleanup: Array<() => void> = [];
afterEach(() => { cleanup.splice(0).reverse().forEach((close) => close()); });

function setup(options: { accountId?: string; store?: ReturnType<typeof createIngressOutcomeStore>; cold?: boolean; measure?: (value: Item) => number } = {}) {
  const accountId = options.accountId ?? "account";
  const dir = mkdtempSync(join(tmpdir(), "ingress-identity-"));
  const persistent = (namespacePrefix: string) => createPersistentDedupe({
    pluginId: "webchannel", namespacePrefix, ttlMs: 604_800_000,
    memoryMaxSize: 8, stateMaxEntries: 32,
    env: { ...process.env, OPENCLAW_STATE_DIR: dir },
  });
  const store = options.store ?? createIngressOutcomeStore({
    accepted: persistent("persistent-dedupe"),
    overloaded: persistent("webchannel-inbound-overloaded"),
    cancelled: persistent("webchannel-inbound-cancelled"),
  });
  const admissionStore = options.cold ? { ...store, peek: () => undefined } : store;
  const journal = openDeliveryJournal({ databasePath: join(dir, "journal.sqlite") });
  const budget = new InboundRetentionBudget();
  const token = budget.createSessionToken();
  const fallback = new CancelledInboundFallbackTombstones();
  const acks: Array<{ peerId: string; ids: string[]; committed?: Echo }> = [];
  const rejected: Array<{ peerId: string; ids: string[] }> = [];
  const pressure = vi.fn();
  let ackSuccess = true;
  const sendAck = (peerId: string, ids: string[], committed?: Echo) => {
    acks.push({ peerId, ids: [...ids], committed });
    return ackSuccess;
  };
  const sendRejected = (peerId: string, ids: string[]) => { rejected.push({ peerId, ids }); return true; };
  const resolver = new BoundedOverflowResolver({
    outcomeStore: store,
    lookupUserRow: ({ peerId }, key) => journal.lookupUserMessageIdByRandomId(peerId, key),
    sendAck: ({ peerId, id }, committed) => sendAck(peerId, [id], committed),
    sendRejected: ({ peerId, id }) => sendRejected(peerId, [id]),
    onCancelledRecovered: ({ accountId, key }) => fallback.delete(key, accountId),
  });
  const runs: UserMessageLike[] = [];
  const dispatcher = createSerializedInboundDispatcher<UserMessageLike>(async (_peer, message) => {
    runs.push(message);
  }, { coalesce: coalesceUserMessages, budget, sessionToken: () => token });
  const flush = createIngressOnFlush<Item>({
    accountId, outcomeStore: store, deliveryJournal: journal,
    beginBatch: (peer) => dispatcher.beginBatch(peer), sendAck, sendInboundRejected: sendRejected,
    cancelledFallback: fallback,
  });
  const debouncer = createBoundedInboundDebouncer<Item>({
    debounceMs: 0, buildKey: (value) => value.peerId, sessionToken: () => token, budget,
    measure: options.measure ?? ((value) => estimateRetainedMessageBytes(value.message)),
    ...createIngressDebounceCallbacks<Item>({
      accountId, outcomeStore: admissionStore, overflowResolver: resolver,
      cancelledFallback: fallback, deliveryJournal: journal, sessionToken: () => token, sendAck, sendRejected,
      onPressure: pressure,
    }),
    onFlush: flush,
    onCancel: async (entries) => recordCancelledInboundItems(
      entries.map((entry) => entry.item), accountId, async (key) => {
        const result = await store.record(accountId, key, "cancelled", { replaceOthers: true });
        if (result.status !== "recorded") throw result.error;
        result.write.commit();
        return true;
      }, sendAck, undefined, fallback,
    ),
  });
  const reservations: Array<{ requestRelease(): unknown }> = [];
  const fill = (count = 32) => {
    for (let i = 0; i < count; i++) {
      const result = budget.tryReserve(token, 512, "pending");
      expect(result.status).toBe("accepted");
      if (result.status === "accepted") reservations.push(result.reservation);
    }
  };
  const release = () => reservations.splice(0).forEach((reservation) => reservation.requestRelease());
  cleanup.push(() => {
    debouncer.dispose(); resolver.dispose(); dispatcher.dispose(); release(); journal.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const idle = async () => vi.waitFor(() => {
    expect(resolver.usage()).toEqual({ tasks: 0, metadataBytes: 0 });
    expect(debouncer.usage()).toEqual({ waiting: 0, inflight: 0, keys: 0 });
  });
  return { store, journal, budget, token, fallback, resolver, dispatcher, debouncer, flush, runs, acks, rejected, pressure,
    fill, release, idle, accountId, loseAck: (lose: boolean) => { ackSuccess = !lose; } };
}

it.each([false, true])("re-acks a journaled random_id after lost ACK and full-budget retries using their wire IDs (cold cache: %s)", async (cold) => {
  const h = setup({ cold });
  h.loseAck(true);
  await h.flush([item("wire-first", "logical")]);
  await vi.waitFor(() => expect(h.runs).toHaveLength(1));
  const row = h.journal.lookupUserMessageIdByRandomId("peer", "logical")!;
  h.acks.length = 0;
  h.loseAck(false);
  h.fill();
  for (const wire of ["wire-first", "wire-retry", "wire-second-retry"]) {
    expect(h.debouncer.push(item(wire, "logical")).status).toBe("overflow");
    await h.idle();
    expect(h.rejected).toEqual([]);
    expect(h.acks.at(-1)).toEqual({ peerId: "peer", ids: [wire], committed: [{ random_id: "logical", ...row }] });
    expect(await h.store.lookup("account", `peer:${wire}`)).toEqual({ status: "not-found" });
    expect(h.resolver.hasActiveClaim("account", "peer:logical")).toBe(false);
  }
  expect(h.runs).toHaveLength(1);
  expect(h.journal.read("peer")).toHaveLength(1);
  expect(await h.store.lookup("account", "peer:logical")).toEqual({ status: "found", outcome: "accepted" });
});
