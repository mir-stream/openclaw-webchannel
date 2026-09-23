import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createPersistentDedupe } from "openclaw/plugin-sdk/persistent-dedupe";
import { createBoundedInboundDebouncer } from "./bounded-inbound-debouncer.js";
import { openDeliveryJournal } from "./delivery-journal.js";
import { createDispatchRecovery } from "./dispatch-recovery.js";
import { createIngressDebounceCallbacks } from "./ingress-debounce-callbacks.js";
import { CancelledInboundFallbackTombstones, createIngressOnFlush } from "./ingress-dedupe.js";
import { createIngressOutcomeStore, createRateLimitedOutcomeFailureWarning, LegacyIngressOutcomeAmbiguity, type IngressOutcome } from "./ingress-outcome.js";
import { createIngressScopeDedupe, ingressScopeNamespace, type IngressScope } from "./ingress-scope.js";
import { BoundedOverflowResolver, type OverflowResolutionRequest } from "./inbound-overflow-resolver.js";
import { DEFAULT_BUSY_TURN_LIMITS, estimateRetainedMessageBytes, InboundRetentionBudget } from "./inbound-retention.js";
import type { UserMessageLike } from "./inbound-queue.js";
import { tupleStoragePaths } from "./storage-paths.js";
import type { StorageScopeIdentity } from "./storage-identity.js";
import { createStopControl } from "./stop-control.js";
import { isValidSubjectToken } from "./subject-token.js";
import { isValidAccountId } from "./account-id.js";

const A = { tenant: "tenant-A", accountId: "ExactAccount" };
const B = { tenant: "tenant-B", accountId: "ExactAccount" };
const KEY = "peer:logical";
const TTL = 604_800_000;
const prefixes = { accepted: "persistent-dedupe", overloaded: "webchannel-inbound-overloaded", cancelled: "webchannel-inbound-cancelled" };
type Item = { peerId: string; message: UserMessageLike };
const item = (wire = "wire", logical = "logical", peerId = "peer"): Item => ({
  peerId, message: { type: "user_message", text: "hello", id: wire, random_id: logical },
});
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});
function root() {
  const path = mkdtempSync(join(tmpdir(), "ingress-tenant-"));
  cleanups.push(() => rmSync(path, { force: true, recursive: true }));
  return path;
}
function persistence(path: string, createDedupe = createIngressScopeDedupe) {
  const raw = Object.fromEntries(Object.entries(prefixes).map(([outcome, namespacePrefix]) => [outcome, createDedupe({
    pluginId: "webchannel", namespacePrefix, ttlMs: TTL, memoryMaxSize: 32, stateMaxEntries: 100,
    env: { ...process.env, OPENCLAW_STATE_DIR: join(path, "sdk") },
  })])) as Record<IngressOutcome, ReturnType<typeof createPersistentDedupe>>;
  const warnings: string[] = [];
  const store = createIngressOutcomeStore({ ...raw, warnFailure: createRateLimitedOutcomeFailureWarning(message => warnings.push(message)) });
  return { raw, store, warnings };
}
async function record(store: ReturnType<typeof createIngressOutcomeStore>, scope: IngressScope, outcome: IngressOutcome, key = KEY) {
  const result = await store.record(scope, key, outcome);
  expect(result.status).toBe("recorded");
  if (result.status === "recorded") result.write.commit();
}

/** Real SDK state + tuple SQLite + production ingress/recovery/debounce composition.
 * Core dispatch is controlled; this is not a live gateway or browser test. */
function runtime(path: string, storageScope: StorageScopeIdentity, persisted = persistence(path), fallback = new CancelledInboundFallbackTombstones(), options: { debounceMs?: number; capacity?: number } = {}) {
  const { store } = persisted;
  const journal = openDeliveryJournal({ databasePath: tupleStoragePaths({ storageRoot: path, ...storageScope }).deliveryJournalPath });
  const budget = new InboundRetentionBudget({ ...DEFAULT_BUSY_TURN_LIMITS,
    ...(options.capacity === undefined ? {} : { maxMessagesPerSession: options.capacity }),
  });
  const tokens = new Map<string, symbol>();
  const sessionToken = (peer: string) => {
    if (!tokens.has(peer)) tokens.set(peer, budget.createSessionToken());
    return tokens.get(peer)!;
  };
  const runs: UserMessageLike[] = [];
  const acks: Array<{ ids: string[]; cancelled?: string[]; committed?: Array<{ random_id: string; messageId: string; seq: number }> }> = [];
  const rejected: string[][] = [];
  const errors: unknown[] = [];
  const sendAck = (_peer: string, ids: string[], committed?: typeof acks[number]["committed"], cancelled?: string[]) => {
    expect((cancelled ?? []).every(id => ids.includes(id))).toBe(true);
    acks.push({ ids, committed, cancelled }); return true;
  };
  const sendRejected = (_peer: string, ids: string[]) => { rejected.push(ids); return true; };
  const recovery = createDispatchRecovery({
    store: journal.dispatch!, acquirePeer: () => () => {}, notify: () => {}, isActive: () => true,
    warn: error => { errors.push(error); },
    dispatcherOptions: { budget, sessionToken },
    handler: async (_peer, message, settle) => { runs.push(message); settle("ok"); },
  });
  recovery.start();
  const resolver = new BoundedOverflowResolver({ outcomeStore: store,
    lookupUserRow: ({ peerId }, key) => journal.lookupUserMessageIdByRandomId(peerId, key),
    sendAck: ({ peerId, id }, committed, cancelled) => sendAck(peerId, [id], committed, cancelled ? [id] : undefined),
    sendRejected: ({ peerId, id }) => sendRejected(peerId, [id]),
    onCancelledRecovered: ({ storageScope, key }) => fallback.delete(key, storageScope),
  });
  const flush = createIngressOnFlush<Item>({
    accountId: storageScope.accountId, storageScope, outcomeStore: store, deliveryJournal: journal,
    dispatchRecovery: recovery, beginBatch: peer => recovery.beginBatch(peer), cancelledFallback: fallback,
    sendAck, sendInboundRejected: sendRejected,
  });
  const callbacks = createIngressDebounceCallbacks<Item>({
    accountId: storageScope.accountId, storageScope, outcomeStore: store, deliveryJournal: journal,
    overflowResolver: resolver, cancelledFallback: fallback, sessionToken, sendAck, sendRejected,
  });
  const debouncer = createBoundedInboundDebouncer<Item>({ debounceMs: options.debounceMs ?? 0, buildKey: value => value.peerId,
    budget, sessionToken, measure: value => estimateRetainedMessageBytes(value.message), ...callbacks, onFlush: flush });
  const control = vi.fn(async () => {});
  const stop = createStopControl({ journal, recovery, debouncer, sendAck, dispatchControl: control,
    pendingOverflowKey: peer => {
      const token = tokens.get(peer);
      return token ? resolver.pendingLogicalKey(token) : undefined;
    },
    retireOverflow: peer => { const token = tokens.get(peer); if (token) resolver.invalidateSession(token); },
    isActive: () => true, warn: error => { errors.push(error); },
  });
  const idle = () => vi.waitFor(() => {
    expect(resolver.usage()).toEqual({ tasks: 0, metadataBytes: 0 });
    expect(budget.usage()).toEqual({ messages: 0, bytes: 0 });
    expect(errors).toEqual([]);
  });
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    debouncer.dispose(); resolver.dispose(); recovery.dispose();
    await stop.dispose(); await idle(); journal.close();
  };
  cleanups.push(close);
  const overflow = (wire = "overflow") => callbacks.onOverflow!({
    key: "peer", item: item(wire), reason: "session-message-count", chargedBytes: 512,
    recoverCancelled: fallback.has(KEY, storageScope), deferToRetained: false,
  });
  return { ...persisted, journal, recovery, resolver, callbacks, debouncer, stop, control, flush, runs, acks, rejected, fallback, idle, close, overflow };
}

it.each(["cancelled", "overloaded"] as const)("isolates %s from a same-account tenant in hot, cold and reopened ingress", async outcome => {
  const path = root();
  const shared = persistence(path);
  await record(shared.store, A, outcome);
  const a = runtime(path, A, shared);
  const b = runtime(path, B, shared);
  expect(a.callbacks.peekOutcome!("peer", KEY)).toBe(outcome);
  expect(b.callbacks.peekOutcome!("peer", KEY)).toBeUndefined();
  expect(await b.store.lookup(B, KEY)).toEqual({ status: "not-found" });
  await b.flush([item()]); await b.idle();
  expect(b.runs).toHaveLength(1); expect(b.journal.read("peer").filter(row => row.event.kind === "user")).toHaveLength(1);
  await a.close(); await b.close();
  const coldA = runtime(path, A);
  const coldB = runtime(path, B);
  expect(coldA.store.peek(A, KEY)).toBeUndefined();
  await coldA.flush([item("replay-A")]); await coldB.flush([item("replay-B")]);
  expect(coldA.runs).toEqual([]); expect(coldA.journal.read("peer")).toEqual([]);
  expect(coldA.acks.map(x => x.ids)).toEqual(outcome === "cancelled" ? [["replay-A"]] : []);
  expect(coldA.rejected).toEqual(outcome === "overloaded" ? [["replay-A"]] : []);
  if (outcome === "cancelled") expect(coldA.acks[0].cancelled).toEqual(["replay-A"]);
  expect(coldB.runs).toEqual([]); expect(coldB.rejected).toEqual([]);
  expect(coldB.acks[0].committed).toEqual(b.acks[0].committed);
  expect(b.acks[0].cancelled).toBeUndefined();
  expect(coldB.acks[0].cancelled).toBeUndefined();
});

it.each(["flush", "overflow"] as const)("keeps cancellation proof and committed echo for a scoped SDK cancellation with a journal row through %s", async phase => {
  const path = root(); const p = persistence(path);
  const a = runtime(path, A, p);
  const row = a.journal.appendInboundUser("peer", { text: "killed", turnId: "original", randomId: "logical" });
  await record(p.store, A, "cancelled");
  await a.close();
  const cold = runtime(path, A);
  const b = runtime(path, B);
  if (phase === "flush") await cold.flush([item("cold-replay")]);
  else { cold.overflow("cold-replay"); await cold.idle(); }
  expect(cold.acks).toEqual([{ ids: ["cold-replay"], cancelled: ["cold-replay"],
    committed: [{ random_id: "logical", messageId: row.messageId, seq: row.seq }] }]);
  expect(cold.debouncer.push(item("hot-replay"))).toEqual({ status: "known-outcome", outcome: "cancelled" });
  expect(cold.acks.at(-1)?.cancelled).toEqual(["hot-replay"]);
  expect(cold.runs).toEqual([]);
  await b.flush([item("other-tenant")]); await b.idle();
  expect(b.runs).toHaveLength(1); expect(b.acks[0].cancelled).toBeUndefined();
});

it("keeps account and authenticated peer separation inside each tenant", async () => {
  const p = persistence(root());
  await record(p.store, A, "cancelled");
  expect(await p.store.lookup({ ...A, accountId: "other" }, KEY)).toEqual({ status: "not-found" });
  expect(await p.store.lookup(A, "other-peer:logical")).toEqual({ status: "not-found" });
  expect(ingressScopeNamespace(A)).not.toBe(ingressScopeNamespace({ ...A, accountId: "exactaccount" }));
});

it.each(["cancelled", "overloaded"] as const)("does not apply a legacy %s marker through an SDK cache-key collision", async outcome => {
  const path = root();
  const legacyScope = { tenant: "legacy-tenant", accountId: "tenant" };
  const legacyPeer = ingressScopeNamespace(A).slice("tenant:".length);
  const legacyKey = `${legacyPeer}:${KEY}`;
  expect(isValidAccountId(legacyScope.accountId)).toBe(true);
  expect(isValidSubjectToken(legacyPeer)).toBe(true);
  // The public SDK joins namespace and key with ':', so these valid inputs
  // collide in memory even though they address different durable namespaces.
  expect(`${legacyScope.accountId}:${legacyKey}`).toBe(`${ingressScopeNamespace(A)}:${KEY}`);
  await persistence(path, createPersistentDedupe).raw[outcome].checkAndRecord(legacyKey, { namespace: legacyScope.accountId });

  const p = persistence(path);
  expect(await p.store.lookup(A, KEY)).toEqual({ status: "not-found" });
  expect(await p.store.lookup(legacyScope, legacyKey)).toMatchObject({
    status: "unknown", error: expect.any(LegacyIngressOutcomeAmbiguity),
  });
  const target = runtime(path, A, p);
  await target.flush([item()]); await target.idle();
  expect(target.runs).toHaveLength(1);
  expect(target.rejected).toEqual([]);
  expect(target.acks).toHaveLength(1);
  expect(target.acks[0].cancelled).toBeUndefined();
  expect(target.journal.read("peer").filter(row => row.event.kind === "user")).toHaveLength(1);

  await target.close();
  const cold = runtime(path, A);
  await cold.flush([item("replay")]); cold.overflow(); await cold.idle();
  expect(cold.runs).toEqual([]); expect(cold.rejected).toEqual([]);
  expect(cold.acks.map(ack => ack.committed)).toEqual([target.acks[0].committed, target.acks[0].committed]);
  expect(cold.acks.every(ack => ack.cancelled === undefined)).toBe(true);
  expect(await cold.store.lookup(legacyScope, legacyKey)).toMatchObject({ status: "unknown" });
});

it.each(["cancelled", "overloaded"] as const)("does not treat a scoped %s cache entry as a legacy marker", async outcome => {
  const p = persistence(root());
  const legacyScope = { tenant: "legacy-tenant", accountId: "tenant" };
  const legacyKey = `${ingressScopeNamespace(A).slice("tenant:".length)}:${KEY}`;
  await record(p.store, A, outcome);
  expect(await p.store.lookup(legacyScope, legacyKey)).toEqual({ status: "not-found" });
  expect(await p.store.lookup(A, KEY)).toEqual({ status: "found", outcome });
});

it("isolates an unsettled write gate and rollback from another tenant's same logical key", async () => {
  const p = persistence(root());
  const a = await p.store.record(A, KEY, "cancelled");
  expect(a.status).toBe("recorded");
  try {
    await record(p.store, B, "overloaded");
  } finally {
    if (a.status === "recorded") expect(await a.write.rollback()).toBe(true);
  }
  expect(await p.store.lookup(A, KEY)).toEqual({ status: "not-found" });
  expect(await p.store.lookup(B, KEY)).toEqual({ status: "found", outcome: "overloaded" });
});

it.each(["accepted", "cancelled", "overloaded"] as const)("holds ambiguous legacy %s IDs in both tenants without adopting, deleting or refreshing markers", async outcome => {
  const path = root();
  const old = persistence(path);
  await record(old.store, A.accountId, outcome);
  // A mixed historical namespace can also contain a weaker marker. Reads must not clean it up.
  await old.raw.accepted.checkAndRecord(KEY, { namespace: A.accountId });
  const p = persistence(path);
  const mutations = Object.values(p.raw).flatMap(store => [vi.spyOn(store, "checkAndRecord"), vi.spyOn(store, "forget")]);
  const a = runtime(path, A, p); const b = runtime(path, B, p);
  for (const h of [a, b]) {
    await h.flush([item()]); h.overflow(); await h.idle();
    expect(h.acks).toEqual([]); expect(h.rejected).toEqual([]); expect(h.runs).toEqual([]);
    expect(h.journal.read("peer")).toEqual([]);
  }
  expect(p.store.peek(A, KEY)).toBeUndefined(); expect(p.store.peek(B, KEY)).toBeUndefined();
  expect(await p.store.lookup(A, KEY)).toMatchObject({ status: "unknown", error: expect.any(LegacyIngressOutcomeAmbiguity) });
  expect(await p.store.record(B, KEY, "overloaded")).toMatchObject({ status: "unknown" });
  expect(await p.store.record(A, KEY, "accepted")).toMatchObject({ status: "unknown" });
  expect(mutations.every(spy => spy.mock.calls.length === 0)).toBe(true);
  expect(p.warnings).toHaveLength(1);
  expect(p.warnings[0]).toContain("legacy tenant ownership ambiguous");
  expect(p.warnings[0]).not.toContain("logical");
  await a.flush([item("new-A", "fresh")]); await b.flush([item("new-B", "fresh")]);
  await a.idle(); await b.idle();
  expect(a.runs).toHaveLength(1); expect(b.runs).toHaveLength(1);
  expect(mutations.flatMap(spy => spy.mock.calls).every(call => call[1]?.namespace !== A.accountId)).toBe(true);
  const cold = persistence(path);
  expect(await cold.raw[outcome].hasRecent(KEY, { namespace: A.accountId })).toBe(true);
  expect(await cold.raw.accepted.hasRecent(KEY, { namespace: A.accountId })).toBe(true);
  expect(await cold.store.lookup(B, KEY)).toMatchObject({ status: "unknown" });
});

it.each(["accepted", "cancelled", "overloaded"] as const)("uses only exact tuple journal acceptance ahead of legacy %s, including overflow and cold reopen", async outcome => {
  const path = root(); const p = persistence(path);
  await record(p.store, A.accountId, outcome);
  const a = runtime(path, A, p); const b = runtime(path, B, p);
  const row = a.journal.appendInboundUser("peer", { text: "old", turnId: "first", randomId: "logical" });
  await a.close();
  const cold = runtime(path, A);
  await cold.flush([item("replay")]); cold.overflow(); await cold.idle();
  expect(cold.acks.map(x => x.ids)).toEqual([["replay"], ["overflow"]]);
  for (const ack of cold.acks) {
    expect(ack.committed).toEqual([{ random_id: "logical", messageId: row.messageId, seq: row.seq }]);
    expect(ack.cancelled).toBeUndefined();
  }
  expect(cold.runs).toEqual([]); expect(cold.rejected).toEqual([]);
  await b.flush([item()]); b.overflow(); await b.idle();
  expect(b.acks).toEqual([]); expect(b.rejected).toEqual([]); expect(b.runs).toEqual([]);
  expect(await cold.store.lookup(A, KEY)).toMatchObject({ status: "unknown" }); // No adoption.
});

it.each(["accepted", "cancelled", "overloaded"] as const)("uses durable tuple cancellation ahead of legacy %s after reopen without affecting the other tenant", async outcome => {
  const path = root(); const p = persistence(path);
  await record(p.store, A.accountId, outcome);
  const a = runtime(path, A, p);
  a.recovery.recordStop("peer", "stop", ["logical"], true);
  await a.close();
  const cold = runtime(path, A); const other = runtime(path, B);
  expect(cold.debouncer.push(item("hot-replay"))).toEqual({ status: "known-outcome", outcome: "cancelled" });
  await cold.flush([item("cold-replay")]);
  await other.flush([item()]);
  expect(cold.acks.map(x => x.ids)).toEqual([["hot-replay"], ["cold-replay"]]);
  expect(cold.acks.map(x => x.cancelled)).toEqual([["hot-replay"], ["cold-replay"]]);
  expect(cold.journal.read("peer")).toEqual([]); expect(cold.runs).toEqual([]);
  expect(other.acks).toEqual([]); expect(other.runs).toEqual([]);
});

it("repairs a new scoped accepted orphan once and keeps the journal authoritative without a marker", async () => {
  const path = root(); const p = persistence(path);
  await record(p.store, A, "accepted");
  const h = runtime(path, A, persistence(path));
  await h.flush([item()]); await h.idle();
  expect(h.runs).toHaveLength(1); expect(h.journal.read("peer").filter(row => row.event.kind === "user")).toHaveLength(1);
  const echo = h.acks[0].committed;
  await h.store.forget(A, KEY, "accepted");
  await h.close();
  const cold = runtime(path, A);
  await cold.flush([item("again")]); cold.overflow(); await cold.idle();
  expect(cold.runs).toEqual([]); expect(cold.rejected).toEqual([]);
  expect(cold.acks.every(ack => JSON.stringify(ack.committed) === JSON.stringify(echo))).toBe(true);
});

it.each(["flush", "overflow"] as const)("keeps failed cancellation fallback and durable recovery within its tenant through %s", async phase => {
  const path = root(); const p = persistence(path); const fallback = new CancelledInboundFallbackTombstones();
  await record(p.store, A, "accepted");
  const check = p.raw.cancelled.checkAndRecord.bind(p.raw.cancelled);
  const fault = vi.spyOn(p.raw.cancelled, "checkAndRecord").mockImplementation(async (key, options) => {
    const fresh = await check(key, options);
    options?.onDiskError?.(new Error("cancel write failed"));
    return fresh;
  });
  const failed = await p.store.record(A, KEY, "cancelled", { replaceOthers: true });
  expect(failed.status).toBe("unknown"); fallback.add(KEY, A);
  expect(await p.store.lookup(A, KEY)).toEqual({ status: "found", outcome: "accepted" });
  const a = runtime(path, A, p, fallback); const b = runtime(path, B, p, fallback);
  await a.flush([item()]);
  expect(a.acks).toEqual([]); expect(a.runs).toEqual([]);
  expect(b.callbacks.isCancelledFallback!("peer", KEY)).toBe(false);
  await b.flush([item()]); await b.idle(); expect(b.runs).toHaveLength(1);
  fault.mockRestore();
  if (phase === "flush") await a.flush([item("recovered")]);
  else a.overflow("recovered");
  await a.idle();
  expect(a.acks.map(x => x.ids)).toEqual([["recovered"]]);
  expect(a.acks[0].cancelled).toEqual(["recovered"]);
  expect(b.acks[0].cancelled).toBeUndefined();
  expect(fallback.has(KEY, A)).toBe(false);
  await a.close();
  expect(await persistence(path).store.lookup(A, KEY)).toEqual({ status: "found", outcome: "cancelled" });
  expect(await persistence(path).store.lookup(B, KEY)).toEqual({ status: "found", outcome: "accepted" });
  fallback.add(KEY); fallback.add(KEY, A.accountId);
  expect(fallback.has(KEY, A)).toBe(false); expect(fallback.has(KEY, B)).toBe(false);
});

it("separates pending overflow claims and invalidation for the same wire account across tenants", async () => {
  const p = persistence(root());
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const lookup = p.store.lookup.bind(p.store);
  vi.spyOn(p.store, "lookup").mockImplementation(async (...args) => { await pending; return lookup(...args); });
  const rejected: string[] = [];
  const resolver = new BoundedOverflowResolver({ outcomeStore: p.store, sendAck: () => true,
    sendRejected: request => { rejected.push(request.storageScope!.tenant); return true; } });
  cleanups.push(() => { resolver.dispose(); });
  const request = (storageScope: StorageScopeIdentity): OverflowResolutionRequest => ({
    storageScope, accountId: storageScope.accountId, peerId: "peer", key: KEY, id: "wire", randomId: "logical", sessionToken: Symbol(),
  });
  expect(resolver.tryStart(request(A))).toEqual({ status: "started" });
  expect(resolver.tryStart(request(B))).toEqual({ status: "started" });
  expect(resolver.hasActiveClaim(A, KEY)).toBe(true); expect(resolver.hasActiveClaim(B, KEY)).toBe(true);
  expect(resolver.invalidateAccount(A)).toBe(1);
  release(); await vi.waitFor(() => expect(resolver.usage().tasks).toBe(0));
  expect(rejected).toEqual([B.tenant]);
  expect(await p.store.lookup(A, KEY)).toEqual({ status: "not-found" });
  expect(await p.store.lookup(B, KEY)).toEqual({ status: "found", outcome: "overloaded" });
});

it.each(["callback", "throw"])("holds unproven replay on legacy read %s failure without contaminating a scoped verdict", async fault => {
  const path = root(); const p = persistence(path);
  await record(p.store, B, "overloaded");
  const hasRecent = p.raw.cancelled.hasRecent.bind(p.raw.cancelled);
  vi.spyOn(p.raw.cancelled, "hasRecent").mockImplementation(async (key, options) => {
    if (options?.namespace !== A.accountId) return hasRecent(key, options);
    const error = new Error("legacy state unavailable");
    if (fault === "throw") throw error;
    options.onDiskError?.(error); return false;
  });
  const a = runtime(path, A, p); const b = runtime(path, B, p);
  await a.flush([item()]); a.overflow(); await a.idle();
  expect(a.acks).toEqual([]); expect(a.rejected).toEqual([]); expect(a.runs).toEqual([]);
  await b.flush([item()]); expect(b.rejected).toEqual([["wire"]]);
  expect(p.warnings.some(line => line.includes("category=lookup-legacy"))).toBe(true);
});

it.each(["accepted", "cancelled", "overloaded"] as const)("does not renew the existing legacy %s TTL while holding ambiguous replay", async outcome => {
  const path = root(); const start = Date.now();
  const now = vi.spyOn(Date, "now").mockReturnValue(start);
  await persistence(path).raw[outcome].checkAndRecord(KEY, { namespace: A.accountId, now: start });
  now.mockReturnValue(start + TTL - 1);
  const warm = persistence(path);
  expect(await warm.store.lookup(A, KEY)).toMatchObject({ status: "unknown" });
  expect(await warm.store.lookup(B, KEY)).toMatchObject({ status: "unknown" });
  now.mockReturnValue(start + TTL);
  expect(await warm.store.lookup(A, KEY)).toEqual({ status: "not-found" });
  expect(await persistence(path).store.lookup(B, KEY)).toEqual({ status: "not-found" });
});


it.each(["lookup", "write"] as const)("keeps initial and reopened cancellation proof for a tenant's overflow-only target held at %s", async phase => {
  const path = root(); const p = persistence(path);
  const a = runtime(path, A, p, undefined, { debounceMs: 60_000, capacity: 1 });
  const b = runtime(path, B, p);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let reached = false;
  const lookup = p.store.lookup.bind(p.store);
  const recordOutcome = p.store.record.bind(p.store);
  if (phase === "lookup") {
    vi.spyOn(p.store, "lookup").mockImplementation(async (...args) => {
      const result = await lookup(...args);
      if (typeof args[0] !== "string" && args[0].tenant === A.tenant && args[1] === KEY) { reached = true; await held; }
      return result;
    });
  } else {
    vi.spyOn(p.store, "record").mockImplementation(async (...args) => {
      const result = await recordOutcome(...args);
      if (typeof args[0] !== "string" && args[0].tenant === A.tenant && args[1] === KEY && args[2] === "overloaded") { reached = true; await held; }
      return result;
    });
  }
  const stopMessage = item("stop-wire", "stop-logical"); stopMessage.message.text = "/stop";
  try {
    expect(a.debouncer.push(item("retained-wire", "retained"))).toEqual({ status: "accepted" });
    expect(a.debouncer.push(item("overflow-wire"))).toMatchObject({ status: "overflow" });
    await vi.waitFor(() => expect(reached).toBe(true));
    expect(a.stop.handle(stopMessage, true)).toMatchObject({ fresh: true, targetCount: 2 });
    expect(a.journal.dispatch!.isCancelled("peer", "logical")).toBe(true);
    expect(a.journal.dispatch!.lookup("peer", "logical")).toBeUndefined();
    expect(a.acks.map(ack => ({ ids: ack.ids, cancelled: ack.cancelled }))).toEqual([
      { ids: ["retained-wire"], cancelled: ["retained-wire"] }, { ids: ["stop-wire"], cancelled: undefined },
    ]);
    expect(a.debouncer.push(item("held-retry"))).toEqual({ status: "known-outcome", outcome: "cancelled" });
    expect(a.acks.at(-1)?.cancelled).toEqual(["held-retry"]);
    await b.flush([item("other-tenant")]); await b.idle();
    expect(b.runs).toHaveLength(1); expect(b.acks[0].cancelled).toBeUndefined();
  } finally { release(); }
  await a.idle(); expect(a.runs).toEqual([]); expect(a.rejected).toEqual([]); expect(a.control).toHaveBeenCalledOnce();
  await a.close();
  const cold = runtime(path, A);
  await cold.flush([item("reopened-retained", "retained"), item("reopened-overflow")]);
  expect(cold.acks[0].cancelled).toEqual(["reopened-retained", "reopened-overflow"]);
  expect(cold.runs).toEqual([]); expect(cold.journal.read("peer")).toEqual([]);
  expect(cold.stop.handle(stopMessage, true)).toMatchObject({ targetCount: 2 });
  expect(cold.control).not.toHaveBeenCalled(); expect(cold.acks.at(-1)?.cancelled).toBeUndefined();
});
