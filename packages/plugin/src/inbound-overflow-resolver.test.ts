import { describe, expect, it, vi } from "vitest";
import type { PersistentDedupe } from "openclaw/plugin-sdk/persistent-dedupe";
import {
  BoundedOverflowResolver,
  overflowResolverMetadataBytes,
} from "./inbound-overflow-resolver.js";
import { InboundRetentionBudget } from "./inbound-retention.js";
import { createIngressOutcomeStore, type IngressOutcomeStore } from "./ingress-outcome.js";
import { createBoundedInboundDebouncer } from "./bounded-inbound-debouncer.js";
import {
  CancelledInboundFallbackTombstones,
  recordCancelledInboundItems,
} from "./ingress-dedupe.js";

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const recorded = (outcome: "accepted" | "overloaded" = "overloaded") => {
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
    expect(store.record).toHaveBeenCalledWith("a", "p:i", "accepted", {
      replaceOpposite: true,
    });
    expect(resolver.invalidateSession(token)).toBe(true);
    const late = recorded("accepted");
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
    const store = createIngressOutcomeStore({ accepted, overloaded });
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

  it("recovers a stopped replay as accepted through the bounded overflow gate", async () => {
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
    const recovery = recorded("accepted");
    recovery.write.commit.mockImplementation(() => {
      accepted.add(`${accountId}:${key}`);
    });
    const store = {
      peek: vi.fn(() => "overloaded" as const),
      lookup: vi.fn(),
      record: vi.fn((recordAccount: string, recordKey: string, outcome: string, options?: { replaceOpposite?: boolean }) => {
        if (options?.replaceOpposite && outcome === "accepted") {
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
    expect(store.record).toHaveBeenCalledWith(accountId, key, "accepted", {
      replaceOpposite: true,
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
