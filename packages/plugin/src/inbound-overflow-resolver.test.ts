import { afterEach, describe, expect, it, vi } from "vitest";
import type { PersistentDedupe } from "openclaw/plugin-sdk/persistent-dedupe";
import {
  BoundedOverflowResolver,
  overflowResolverMetadataBytes,
} from "./inbound-overflow-resolver.js";
import { InboundRetentionBudget } from "./inbound-retention.js";
import {
  createIngressOutcomeStore,
  type IngressOutcome,
  type IngressOutcomeStore,
} from "./ingress-outcome.js";
import { createBoundedInboundDebouncer } from "./bounded-inbound-debouncer.js";
import {
  CancelledInboundFallbackTombstones,
  createIngressOnFlush,
  recordCancelledInboundItems,
} from "./ingress-dedupe.js";
import { openDeliveryJournal, type DeliveryJournal } from "./delivery-journal.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** In-memory `PersistentDedupe`, so tests can drive the REAL outcome store. */
function memoryDedupe(): PersistentDedupe {
  const values = new Set<string>();
  const scoped = (key: string, options?: { namespace?: string }) => `${options?.namespace}:${key}`;
  return {
    hasRecent: async (key: string, options?: { namespace?: string }) => values.has(scoped(key, options)),
    checkAndRecord: async (key: string, options?: { namespace?: string }) => {
      const scopedKey = scoped(key, options);
      const fresh = !values.has(scopedKey);
      values.add(scopedKey);
      return fresh;
    },
    forget: async (key: string, options?: { namespace?: string }) => values.delete(scoped(key, options)),
    warmup: vi.fn(), clearMemory: vi.fn(), memorySize: vi.fn(),
  } as unknown as PersistentDedupe;
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const recorded = (outcome: IngressOutcome = "overloaded") => {
  const write = {
    outcome,
    created: true,
    durability: "durable" as const,
    commit: vi.fn(),
    rollback: vi.fn(async () => true),
  };
  return { result: { status: "recorded" as const, durability: "durable" as const, write }, write };
};

describe("BoundedOverflowResolver", () => {
  it("requires a durable overload marker and enforces one task per session", async () => {
    let finish!: (value: any) => void;
    const lookup = new Promise<any>((resolve) => { finish = resolve; });
    const store = { lookup: vi.fn(() => lookup), record: vi.fn(), peek: vi.fn(), forget: vi.fn(), hotSize: vi.fn() } as unknown as IngressOutcomeStore;
    const sendRejected = vi.fn(() => true);
    const resolver = new BoundedOverflowResolver({ outcomeStore: store, sendAck: () => true, sendRejected });
    const token = new InboundRetentionBudget().createSessionToken();
    const request = { accountId: "a", peerId: "p", key: "p:i", id: "i", sessionToken: token };
    expect(resolver.tryStart(request)).toEqual({ status: "started" });
    expect(resolver.tryStart(request)).toEqual({ status: "busy-session" });
    finish({ status: "not-found" });
    (store.record as any).mockResolvedValue(recorded().result);
    await tick(); await tick();
    expect(sendRejected).toHaveBeenCalledTimes(1);
    expect(resolver.usage()).toEqual({ tasks: 0, metadataBytes: 0 });
  });

  it("rolls back the exact overload write when it settles after session retirement", async () => {
    let finishRecord!: (value: any) => void;
    const record = new Promise<any>((resolve) => { finishRecord = resolve; });
    const store = {
      lookup: vi.fn(async () => ({ status: "not-found" })),
      record: vi.fn(() => record),
      peek: vi.fn(),
      forget: vi.fn(async () => true),
      hotSize: vi.fn(),
    } as unknown as IngressOutcomeStore;
    const sendRejected = vi.fn(() => true);
    const resolver = new BoundedOverflowResolver({
      outcomeStore: store,
      sendAck: () => true,
      sendRejected,
    });
    const token = new InboundRetentionBudget().createSessionToken();
    expect(resolver.tryStart({
      accountId: "a", peerId: "p", key: "p:i", id: "i", sessionToken: token,
    })).toEqual({ status: "started" });
    await tick();
    expect(resolver.invalidateSession(token)).toBe(true);
    expect(resolver.usage().tasks).toBe(1);
    expect(resolver.hasActiveClaim("a", "p:i")).toBe(true);
    const late = recorded();
    finishRecord(late.result);
    await tick();
    await tick();
    expect(late.write.rollback).toHaveBeenCalledTimes(1);
    expect(store.forget).not.toHaveBeenCalled();
    expect(sendRejected).not.toHaveBeenCalled();
    expect(resolver.usage()).toEqual({ tasks: 0, metadataBytes: 0 });
    expect(resolver.hasActiveClaim("a", "p:i")).toBe(false);
  });

  it("rolls back an exact cancelled-recovery write when retirement wins", async () => {
    let finishRecord!: (value: any) => void;
    const record = new Promise<any>((resolve) => { finishRecord = resolve; });
    const store = {
      lookup: vi.fn(),
      record: vi.fn(() => record),
      peek: vi.fn(), forget: vi.fn(), hotSize: vi.fn(),
    } as unknown as IngressOutcomeStore;
    const sendAck = vi.fn(() => true);
    const recovered = vi.fn();
    const resolver = new BoundedOverflowResolver({
      outcomeStore: store,
      sendAck,
      sendRejected: vi.fn(),
      onCancelledRecovered: recovered,
    });
    const token = new InboundRetentionBudget().createSessionToken();
    expect(resolver.tryStart({
      accountId: "a", peerId: "p", key: "p:i", id: "i", sessionToken: token,
      recoverCancelled: true,
    })).toEqual({ status: "started" });
    // #344: the cancelled-recovery write records `cancelled`, not `accepted` —
    // it writes no journal row on purpose, and under `accepted` the accept seam
    // read that as its crash window and re-ran the killed text.
    expect(store.record).toHaveBeenCalledWith("a", "p:i", "cancelled", {
      replaceOthers: true,
    });
    expect(resolver.invalidateSession(token)).toBe(true);
    const late = recorded("cancelled");
    finishRecord(late.result);
    await tick();
    await tick();
    expect(late.write.rollback).toHaveBeenCalledTimes(1);
    expect(late.write.commit).not.toHaveBeenCalled();
    expect(sendAck).not.toHaveBeenCalled();
    expect(recovered).not.toHaveBeenCalled();
    expect(store.lookup).not.toHaveBeenCalled();
    expect(resolver.usage()).toEqual({ tasks: 0, metadataBytes: 0 });
  });

  it("enforces exact task and metadata caps without queueing rejected work", async () => {
    const pending: Array<(value: any) => void> = [];
    const store = {
      lookup: vi.fn(() => new Promise((resolve) => pending.push(resolve))),
      record: vi.fn(), peek: vi.fn(), forget: vi.fn(), hotSize: vi.fn(),
    } as unknown as IngressOutcomeStore;
    const budget = new InboundRetentionBudget();
    const base = { accountId: "a", peerId: "p", key: "p:i", id: "i" };
    const exactBytes = overflowResolverMetadataBytes({ ...base, sessionToken: budget.createSessionToken() });
    const resolver = new BoundedOverflowResolver({
      outcomeStore: store, sendAck: () => true, sendRejected: () => true,
      maxTasks: 2, maxMetadataBytes: exactBytes * 2,
    });
    const request = (suffix: string) => ({
      accountId: "a", peerId: "p", key: `p:${suffix}`, id: suffix,
      sessionToken: budget.createSessionToken(),
    });
    // Keep byte sizes identical to the base request used to compute the exact cap.
    expect(resolver.tryStart(request("i"))).toEqual({ status: "started" });
    expect(resolver.tryStart(request("j"))).toEqual({ status: "started" });
    expect(resolver.usage()).toEqual({ tasks: 2, metadataBytes: exactBytes * 2 });
    expect(resolver.tryStart(request("k"))).toEqual({ status: "process-count" });
    expect(store.lookup).toHaveBeenCalledTimes(2);
    pending.splice(0).forEach((resolve) => resolve({ status: "unknown", error: new Error("done") }));
    await tick();
    expect(store.lookup).toHaveBeenCalledTimes(2);

    const bytesOnly = new BoundedOverflowResolver({
      outcomeStore: store, sendAck: () => true, sendRejected: () => true,
      maxTasks: 2, maxMetadataBytes: exactBytes - 1,
    });
    expect(bytesOnly.tryStart(request("i"))).toEqual({ status: "process-bytes" });
    expect(store.lookup).toHaveBeenCalledTimes(2);
  });

  it("cannot let an invalidated old overload cleanup erase its replacement", async () => {
    const acceptedValues = new Set<string>();
    const overloadedValues = new Set<string>();
    const persistent = (values: Set<string>): PersistentDedupe => ({
      hasRecent: vi.fn(async (key: string, options?: { namespace?: string }) =>
        values.has(`${options?.namespace}:${key}`)),
      checkAndRecord: vi.fn(async (key: string, options?: { namespace?: string }) => {
        const scoped = `${options?.namespace}:${key}`;
        const fresh = !values.has(scoped);
        values.add(scoped);
        return fresh;
      }),
      forget: vi.fn(async (key: string, options?: { namespace?: string }) =>
        values.delete(`${options?.namespace}:${key}`)),
      warmup: vi.fn(), clearMemory: vi.fn(), memorySize: vi.fn(),
    } as unknown as PersistentDedupe);
    const accepted = persistent(acceptedValues);
    const overloaded = persistent(overloadedValues);
    let finishOld!: () => void;
    const oldGate = new Promise<void>((resolve) => { finishOld = resolve; });
    let recordCalls = 0;
    (overloaded.checkAndRecord as any).mockImplementation(async (key: string, options: any) => {
      recordCalls++;
      if (recordCalls === 1) await oldGate;
      const scoped = `${options.namespace}:${key}`;
      const fresh = !overloadedValues.has(scoped);
      overloadedValues.add(scoped);
      return fresh;
    });
    // #344: a third outcome store. This test never records `cancelled`, so an
    // empty one is enough.
    const store = createIngressOutcomeStore({
      accepted,
      overloaded,
      cancelled: persistent(new Set<string>()),
    });
    const sendRejected = vi.fn(() => true);
    const resolver = new BoundedOverflowResolver({
      outcomeStore: store, sendAck: () => true, sendRejected,
    });
    const budget = new InboundRetentionBudget();
    const request = (sessionToken: ReturnType<typeof budget.createSessionToken>) => ({
      accountId: "a", peerId: "p", key: "p:i", id: "i", sessionToken,
    });
    const oldToken = budget.createSessionToken();
    expect(resolver.tryStart(request(oldToken))).toEqual({ status: "started" });
    await vi.waitFor(() => expect(recordCalls).toBe(1));
    expect(resolver.invalidateSession(oldToken)).toBe(true);

    const replacementToken = budget.createSessionToken();
    expect(resolver.tryStart(request(replacementToken))).toEqual({ status: "busy-key" });
    finishOld();
    await vi.waitFor(() => expect(resolver.hasActiveClaim("a", "p:i")).toBe(false));
    expect(resolver.tryStart(request(replacementToken))).toEqual({ status: "started" });
    await vi.waitFor(() => expect(sendRejected).toHaveBeenCalledTimes(1));
    expect(recordCalls).toBe(2);
    expect(await store.lookup("a", "p:i")).toEqual({ status: "found", outcome: "overloaded" });
    expect(sendRejected).toHaveBeenCalledWith(expect.objectContaining({ sessionToken: replacementToken }));
  });

  it("keeps invalidated unresolved tasks charged at the exact cap with no hidden queue", async () => {
    const pending: Array<(value: any) => void> = [];
    const store = {
      lookup: vi.fn(() => new Promise((resolve) => pending.push(resolve))),
      record: vi.fn(), peek: vi.fn(), forget: vi.fn(), hotSize: vi.fn(),
    } as unknown as IngressOutcomeStore;
    const sendAck = vi.fn();
    const sendRejected = vi.fn();
    const budget = new InboundRetentionBudget();
    const request = (suffix: string) => ({
      accountId: "a", peerId: `p${suffix}`, key: `p${suffix}:i`, id: "i",
      sessionToken: budget.createSessionToken(),
    });
    const exactBytes = overflowResolverMetadataBytes(request("0"));
    const resolver = new BoundedOverflowResolver({
      outcomeStore: store, sendAck, sendRejected,
      maxTasks: 2, maxMetadataBytes: exactBytes * 2,
    });
    const first = request("0");
    const second = request("1");
    expect(resolver.tryStart(first)).toEqual({ status: "started" });
    expect(resolver.invalidateSession(first.sessionToken)).toBe(true);
    expect(resolver.tryStart(second)).toEqual({ status: "started" });
    expect(resolver.invalidateSession(second.sessionToken)).toBe(true);
    expect(resolver.usage()).toEqual({ tasks: 2, metadataBytes: exactBytes * 2 });
    for (let attempt = 2; attempt < 20; attempt++) {
      expect(resolver.tryStart(request(String(attempt)))).toEqual({ status: "process-count" });
    }
    expect(store.lookup).toHaveBeenCalledTimes(2);
    expect(resolver.hasActiveClaim(first.accountId, first.key)).toBe(true);
    pending.splice(0).forEach((resolve) => resolve({ status: "not-found" }));
    await tick();
    expect(sendAck).not.toHaveBeenCalled();
    expect(sendRejected).not.toHaveBeenCalled();
    expect(resolver.usage()).toEqual({ tasks: 0, metadataBytes: 0 });
    expect(resolver.hasActiveClaim(first.accountId, first.key)).toBe(false);
  });

  it("keeps account-invalidated and disposed tasks charged until their awaits settle", async () => {
    const pending: Array<(value: any) => void> = [];
    const store = {
      lookup: vi.fn(() => new Promise((resolve) => pending.push(resolve))),
      record: vi.fn(), peek: vi.fn(), forget: vi.fn(), hotSize: vi.fn(),
    } as unknown as IngressOutcomeStore;
    const sendAck = vi.fn();
    const sendRejected = vi.fn();
    const budget = new InboundRetentionBudget();
    const resolver = new BoundedOverflowResolver({
      outcomeStore: store, sendAck, sendRejected, maxTasks: 3,
    });
    const request = (accountId: string, suffix: string) => ({
      accountId, peerId: `p${suffix}`, key: `p${suffix}:i`, id: "i",
      sessionToken: budget.createSessionToken(),
    });
    for (const value of [request("a", "1"), request("a", "2"), request("b", "3")]) {
      expect(resolver.tryStart(value)).toEqual({ status: "started" });
    }
    expect(resolver.invalidateAccount("a")).toBe(2);
    expect(resolver.invalidateAccount("a")).toBe(0);
    expect(resolver.usage().tasks).toBe(3);
    expect(resolver.dispose()).toBe(3);
    expect(resolver.usage().tasks).toBe(3);
    expect(resolver.tryStart(request("c", "4"))).toEqual({ status: "disposed" });
    pending.splice(0).forEach((resolve) => resolve({ status: "not-found" }));
    await tick();
    expect(resolver.usage()).toEqual({ tasks: 0, metadataBytes: 0 });
    expect(sendAck).not.toHaveBeenCalled();
    expect(sendRejected).not.toHaveBeenCalled();
  });

  it("arbitrates a same-id retry to the active raw-overflow claim", async () => {
    let finishLookup!: (value: any) => void;
    const firstLookup = new Promise<any>((resolve) => { finishLookup = resolve; });
    const accepted = new Set<string>();
    const overloaded = new Set<string>();
    let lookupCalls = 0;
    const store = {
      peek: vi.fn((accountId: string, key: string) =>
        overloaded.has(`${accountId}:${key}`) ? "overloaded"
          : accepted.has(`${accountId}:${key}`) ? "accepted" : undefined),
      lookup: vi.fn(async (accountId: string, key: string) => {
        lookupCalls++;
        if (lookupCalls === 1) return firstLookup;
        if (overloaded.has(`${accountId}:${key}`)) return { status: "found", outcome: "overloaded" };
        if (accepted.has(`${accountId}:${key}`)) return { status: "found", outcome: "accepted" };
        return { status: "not-found" };
      }),
      record: vi.fn(async (accountId: string, key: string, outcome: "accepted" | "overloaded") => {
        const target = outcome === "accepted" ? accepted : overloaded;
        const scoped = `${accountId}:${key}`;
        const write = {
          outcome, created: !target.has(scoped), durability: "durable" as const,
          commit: vi.fn(() => target.add(scoped)),
          rollback: vi.fn(async () => target.delete(scoped)),
        };
        return { status: "recorded" as const, durability: "durable" as const, write };
      }),
      forget: vi.fn(), hotSize: vi.fn(),
    } as unknown as IngressOutcomeStore;
    const rejected = vi.fn(() => true);
    const resolver = new BoundedOverflowResolver({ outcomeStore: store, sendAck: () => true, sendRejected: rejected });
    const budget = new InboundRetentionBudget();
    const token = budget.createSessionToken();
    expect(resolver.tryStart({ accountId: "a", peerId: "p", key: "p:i", id: "i", sessionToken: token }))
      .toEqual({ status: "started" });
    await vi.waitFor(() => expect(store.lookup).toHaveBeenCalledTimes(1));

    const dispatched = vi.fn();
    const acked = vi.fn();
    const debouncer = createBoundedInboundDebouncer<{ peer: string; id: string }>({
      debounceMs: 0, buildKey: (item) => item.peer, sessionToken: () => token,
      getId: (item) => item.id, measure: () => 1, budget,
      isOverflowClaimed: (peer, id) => resolver.hasActiveClaim("a", `${peer}:${id}`),
      onFlush: async ([entry]) => {
        const result = await store.record("a", `${entry.item.peer}:${entry.item.id}`, "accepted");
        if (result.status === "recorded") result.write.commit();
        dispatched(entry.item.id);
        acked(entry.item.id);
      },
    });
    expect(debouncer.push({ peer: "p", id: "i" })).toEqual({ status: "overflow-inflight" });
    expect(budget.usage()).toEqual({ messages: 0, bytes: 0 });
    expect(debouncer.push({ peer: "p", id: "j" })).toEqual({ status: "accepted" });
    await tick();
    expect(dispatched).toHaveBeenCalledWith("j");
    expect(acked).toHaveBeenCalledWith("j");
    finishLookup({ status: "not-found" });
    await vi.waitFor(() => expect(rejected).toHaveBeenCalledTimes(1));
    expect(accepted).toEqual(new Set(["a:p:j"]));
    expect(accepted.has("a:p:i")).toBe(false);
    expect(overloaded).toEqual(new Set(["a:p:i"]));
    expect(dispatched).toHaveBeenCalledTimes(1);
    expect(acked).toHaveBeenCalledTimes(1);
    expect(resolver.hasActiveClaim("a", "p:i")).toBe(false);
  });

  it("recovers a stopped replay as CANCELLED through the bounded overflow gate", async () => {
    const accountId = "acct";
    const peerId = "peer";
    const id = "stopped";
    const key = `${peerId}:${id}`;
    const fallback = new CancelledInboundFallbackTombstones();
    const lostCancellationAck = vi.fn(() => false);
    await recordCancelledInboundItems(
      [{ peerId, message: { type: "user_message", text: "killed", id } }],
      accountId,
      async () => { throw new Error("suppression store unavailable"); },
      lostCancellationAck,
      undefined,
      fallback,
    );
    expect(fallback.has(key, accountId)).toBe(true);
    expect(lostCancellationAck).toHaveBeenCalledWith(peerId, [id]);

    const accepted = new Set<string>();
    const overloaded = new Set<string>([`${accountId}:${key}`]);
    let finishRecord!: (value: any) => void;
    const recordGate = new Promise<any>((resolve) => { finishRecord = resolve; });
    const recovery = recorded("cancelled");
    recovery.write.commit.mockImplementation(() => {
      accepted.add(`${accountId}:${key}`);
    });
    const store = {
      peek: vi.fn(() => "overloaded" as const),
      lookup: vi.fn(),
      record: vi.fn((recordAccount: string, recordKey: string, outcome: string, options?: { replaceOthers?: boolean }) => {
        if (options?.replaceOthers && outcome === "cancelled") {
          overloaded.delete(`${recordAccount}:${recordKey}`);
        }
        return recordGate;
      }),
      forget: vi.fn(), hotSize: vi.fn(),
    } as unknown as IngressOutcomeStore;
    const acked = vi.fn(() => true);
    const rejected = vi.fn(() => true);
    const resolver = new BoundedOverflowResolver({
      outcomeStore: store,
      sendAck: acked,
      sendRejected: rejected,
      onCancelledRecovered: (request) => fallback.delete(request.key, request.accountId),
    });
    const budget = new InboundRetentionBudget({
      maxMessagesPerSession: 2, maxBytesPerSession: 2,
      maxMessagesPerProcess: 1, maxBytesPerProcess: 1,
    });
    const occupied = budget.tryReserve(budget.createSessionToken(), 1, "pending");
    if (occupied.status !== "accepted") throw new Error("unexpected blocker rejection");
    const retryToken = budget.createSessionToken();
    const dispatched = vi.fn();
    let overflowRequest: Parameters<BoundedOverflowResolver["tryStart"]>[0] | undefined;
    const debouncer = createBoundedInboundDebouncer<{
      peerId: string;
      message: { type: "user_message"; text: string; id: string };
    }>({
      debounceMs: 0,
      buildKey: (item) => item.peerId,
      sessionToken: () => retryToken,
      getId: (item) => item.message.id,
      measure: () => 1,
      budget,
      isOverflowClaimed: (peer, messageId) =>
        resolver.hasActiveClaim(accountId, `${peer}:${messageId}`),
      isCancelledFallback: (peer, messageId) =>
        fallback.has(`${peer}:${messageId}`, accountId),
      peekOutcome: (peer, messageId) => store.peek(accountId, `${peer}:${messageId}`),
      onKnownOutcome: vi.fn(),
      onOverflow: ({ key: overflowPeer, id: overflowId, recoverCancelled }) => {
        if (!overflowId) return;
        overflowRequest = {
          accountId,
          peerId: overflowPeer,
          key: `${overflowPeer}:${overflowId}`,
          id: overflowId,
          sessionToken: retryToken,
          recoverCancelled,
        };
        expect(resolver.tryStart(overflowRequest)).toEqual({ status: "started" });
      },
      onFlush: async () => { dispatched(); },
    });

    expect(debouncer.push({
      peerId,
      message: { type: "user_message", text: "replay", id },
    })).toMatchObject({ status: "overflow", reason: "process-message-count" });
    expect(overflowRequest?.recoverCancelled).toBe(true);
    expect(store.peek).not.toHaveBeenCalled();
    expect(store.lookup).not.toHaveBeenCalled();
    // #344: `cancelled` — see the resolver's own comment on why this id must
    // never be reclassified, and why borrowing `accepted` for it was the bug.
    expect(store.record).toHaveBeenCalledWith(accountId, key, "cancelled", {
      replaceOthers: true,
    });
    expect(resolver.usage()).toEqual({
      tasks: 1,
      metadataBytes: overflowResolverMetadataBytes(overflowRequest!),
    });
    expect(fallback.has(key, accountId)).toBe(true);
    expect(acked).not.toHaveBeenCalled();
    expect(rejected).not.toHaveBeenCalled();
    expect(dispatched).not.toHaveBeenCalled();

    finishRecord(recovery.result);
    await tick();
    await tick();
    expect(recovery.write.commit).toHaveBeenCalledTimes(1);
    expect(recovery.write.rollback).not.toHaveBeenCalled();
    expect(accepted).toEqual(new Set([`${accountId}:${key}`]));
    expect(overloaded).toEqual(new Set());
    expect(acked).toHaveBeenCalledWith(expect.objectContaining({
      accountId, peerId, id, key, recoverCancelled: true,
    }));
    expect(rejected).not.toHaveBeenCalled();
    expect(dispatched).not.toHaveBeenCalled();
    expect(fallback.has(key, accountId)).toBe(false);
    expect(resolver.usage()).toEqual({ tasks: 0, metadataBytes: 0 });
    occupied.reservation.release();
    debouncer.dispose();
  });
});

/**
 * #344 round 3 — THE SECOND DOOR ONTO AN ORPHANED `accepted` MARKER.
 *
 * Round 2 taught `ingress-dedupe.ts`'s found branch that the journal is the
 * accept authority, and stopped there. This resolver reaches the SAME marker by a
 * different route — an id whose raw frame could not be retained — and its
 * accepted arm still read the marker as a terminal accept. The consequence is
 * strictly worse than the bug round 2 fixed: the resolver ACKS, so the client
 * drains its ledger entry and never replays, and the message is lost for good.
 *
 * Reachable without a crash: §15.6's destructive cutover regenerates the journal
 * file and orphans EVERY surviving marker, and `DEFAULT_BUSY_TURN_LIMITS` caps a
 * session at 32 messages, so a reconnect that replays an offline backlog
 * overflows past entry 32 straight into `onOverflow` → `tryStart` → `resolve()`.
 */
describe("BoundedOverflowResolver — the journal is the accept authority (#344)", () => {
  const dirs: string[] = [];
  const openIn = (): DeliveryJournal => {
    const dir = mkdtempSync(join(tmpdir(), "wc-overflow-journal-"));
    dirs.push(dir);
    return openDeliveryJournal({ databasePath: join(dir, "journal.db") });
  };
  afterEach(() => {
    while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  const ACCOUNT = "acct";
  const PEER = "peer-0";

  /** The real outcome store, seeded with a committed `accepted` marker. */
  const seedAcceptedMarker = async (key: string) => {
    const store = createIngressOutcomeStore({
      accepted: memoryDedupe(),
      overloaded: memoryDedupe(),
      cancelled: memoryDedupe(),
    });
    const seeded = await store.record(ACCOUNT, key, "accepted");
    if (seeded.status !== "recorded") throw new Error("could not seed the marker");
    seeded.write.commit();
    return store;
  };

  it("publishes NOTHING for an accepted marker with no journal row, so the replay survives", async () => {
    const journal = openIn();
    try {
      const outcomeStore = await seedAcceptedMarker(`${PEER}:r-1`);
      expect(journal.read(PEER)).toEqual([]);
      const acks: Array<{ id: string; committed: unknown }> = [];
      const rejects: string[] = [];
      const resolver = new BoundedOverflowResolver({
        outcomeStore,
        lookupUserRow: ({ peerId }, idempotencyKey) =>
          journal.lookupUserMessageIdByRandomId(peerId, idempotencyKey),
        sendAck: ({ id }, committed) => { acks.push({ id, committed }); return true; },
        sendRejected: ({ id }) => { rejects.push(id); return true; },
      });

      expect(resolver.tryStart({
        accountId: ACCOUNT, peerId: PEER, key: `${PEER}:r-1`, id: "u-1",
        sessionToken: new InboundRetentionBudget().createSessionToken(),
      })).toEqual({ status: "started" });
      await tick(); await tick();

      // The whole point: no ack, so the client's ledger entry stays and the
      // message comes back — and no rejection either, since it was not refused.
      expect(acks).toEqual([]);
      expect(rejects).toEqual([]);
      expect(journal.read(PEER)).toEqual([]);
      expect(resolver.usage()).toEqual({ tasks: 0, metadataBytes: 0 });
    } finally {
      journal.close();
    }
  });

  it("and the replay it preserved is then journaled, dispatched and echoed by the flush path", async () => {
    // The end-to-end claim the withheld ack rests on. Same orphan, same store —
    // once retention frees, the ordinary seam admits it for real.
    const journal = openIn();
    try {
      const outcomeStore = await seedAcceptedMarker(`${PEER}:r-1`);
      const dispatched: string[] = [];
      const acked: Array<{ ids: string[]; committed: unknown }> = [];
      const onFlush = createIngressOnFlush<{
        peerId: string;
        message: { type: "user_message"; text: string; id: string; random_id: string };
      }>({
        accountId: ACCOUNT,
        outcomeStore,
        beginBatch: () => ({
          offer: (message) => ({
            status: "accepted" as const,
            commit: () => dispatched.push(message.text),
            rollback: () => {},
          }),
          finish: vi.fn(),
        }),
        sendAck: (_peerId, ids, committed) => { acked.push({ ids: [...ids], committed }); return true; },
        sendInboundRejected: () => true,
        deliveryJournal: journal,
        logWarn: () => {},
      });

      await onFlush([{
        peerId: PEER,
        message: { type: "user_message", text: "hello", id: "u-1", random_id: "r-1" },
      }]);

      expect(journal.read(PEER).map((row) => row.event)).toEqual([
        { kind: "user", id: "webchannel-user-1", text: "hello", turnId: "u-1", randomId: "r-1" },
      ]);
      expect(dispatched).toEqual(["hello"]);
      expect(acked).toEqual([{
        ids: ["u-1"],
        committed: [{ random_id: "r-1", messageId: "webchannel-user-1", seq: 1 }],
      }]);
    } finally {
      journal.close();
    }
  });

  it("acks WITH the committed echo when the row exists (#333 path 6)", async () => {
    const journal = openIn();
    try {
      const outcomeStore = await seedAcceptedMarker(`${PEER}:r-1`);
      const { messageId, seq } = journal.appendInboundUser(PEER, {
        text: "hello", turnId: "u-1", randomId: "r-1",
      });
      const acks: Array<{ id: string; committed: unknown }> = [];
      const resolver = new BoundedOverflowResolver({
        outcomeStore,
        lookupUserRow: ({ peerId }, idempotencyKey) =>
          journal.lookupUserMessageIdByRandomId(peerId, idempotencyKey),
        sendAck: ({ id }, committed) => { acks.push({ id, committed }); return true; },
        sendRejected: () => true,
      });

      resolver.tryStart({
        accountId: ACCOUNT, peerId: PEER, key: `${PEER}:r-1`, id: "u-1",
        sessionToken: new InboundRetentionBudget().createSessionToken(),
      });
      await tick(); await tick();

      // Before round 3 this arm acked BARE, so a replay resolved through overflow
      // left the client's optimistic bubble un-adopted until the next gap-sync.
      expect(acks).toEqual([{
        id: "u-1",
        committed: [{ random_id: "r-1", messageId, seq }],
      }]);
    } finally {
      journal.close();
    }
  });

  it("keeps the pre-#344 ack when no journal is wired at all", async () => {
    // The resolver is built at module scope, before any account opens a journal,
    // and callers that predate it still construct one. No authority to consult ⇒
    // the marker decides, exactly as it did.
    const outcomeStore = await seedAcceptedMarker(`${PEER}:r-1`);
    const acks: string[] = [];
    const resolver = new BoundedOverflowResolver({
      outcomeStore,
      sendAck: ({ id }) => { acks.push(id); return true; },
      sendRejected: () => true,
    });

    resolver.tryStart({
      accountId: ACCOUNT, peerId: PEER, key: `${PEER}:r-1`, id: "u-1",
      sessionToken: new InboundRetentionBudget().createSessionToken(),
    });
    await tick(); await tick();

    expect(acks).toEqual(["u-1"]);
  });
});
