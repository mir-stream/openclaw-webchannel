import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPersistentDedupe, type PersistentDedupe } from "openclaw/plugin-sdk/persistent-dedupe";
import {
  MAX_INGRESS_OUTCOME_HOT_BYTES,
  MAX_INGRESS_OUTCOME_HOT_ENTRIES,
  createIngressOutcomeStore,
  createRateLimitedOutcomeFailureWarning,
  createRateLimitedOutcomeInvariantWarning,
  type IngressOutcomeStore,
  type OutcomeRecordResult,
} from "./ingress-outcome.js";
import { BoundedOverflowResolver } from "./inbound-overflow-resolver.js";
import { InboundRetentionBudget } from "./inbound-retention.js";
import { CancelledInboundFallbackTombstones } from "./ingress-dedupe.js";

function fake() {
  const values = new Set<string>();
  const scoped = (key: string, options?: { namespace?: string }) => `${options?.namespace}:${key}`;
  return {
    values,
    store: {
      hasRecent: vi.fn(async (key: string, options?: { namespace?: string }) => values.has(scoped(key, options))),
      checkAndRecord: vi.fn(async (key: string, options?: { namespace?: string }) => {
        const k = scoped(key, options); const fresh = !values.has(k); values.add(k); return fresh;
      }),
      forget: vi.fn(async (key: string, options?: { namespace?: string }) => values.delete(scoped(key, options))),
      warmup: vi.fn(), clearMemory: vi.fn(), memorySize: vi.fn(),
    } as unknown as PersistentDedupe,
  };
}

/**
 * #344 added a third outcome store (`cancelled`). Tests that do not exercise it
 * get a fresh empty one instead of restating it at every construction site; the
 * ones that DO exercise it pass their own.
 */
type StoreOptions = Parameters<typeof createIngressOutcomeStore>[0];
function makeStore(
  options: Omit<StoreOptions, "cancelled"> & { cancelled?: PersistentDedupe },
): IngressOutcomeStore {
  return createIngressOutcomeStore({ cancelled: fake().store, ...options });
}

async function commit(
  store: IngressOutcomeStore,
  accountId: string,
  key: string,
  outcome: "accepted" | "overloaded",
): Promise<OutcomeRecordResult> {
  const result = await store.record(accountId, key, outcome);
  if (result.status === "recorded") result.write.commit();
  return result;
}

describe("IngressOutcomeStore", () => {
  it("a failed cancellation replacement keeps the existing durable accept", async () => {
    const accepted = fake(); const overloaded = fake(); const cancelled = fake();
    const store = makeStore({ accepted: accepted.store, overloaded: overloaded.store, cancelled: cancelled.store });
    await commit(store, "a", "p:i", "accepted");
    (cancelled.store.checkAndRecord as any).mockImplementationOnce(async () => {
      throw new Error("cancelled database unavailable");
    });
    expect((await store.record("a", "p:i", "cancelled", { replaceOthers: true })).status).toBe("unknown");
    const restarted = makeStore({ accepted: accepted.store, overloaded: overloaded.store, cancelled: cancelled.store });
    expect(await restarted.lookup("a", "p:i")).toEqual({ status: "found", outcome: "accepted" });
  });

  it.each(["write", "lookup callback", "lookup throw"] as const)(
    "preserves a cold durable cancellation when %s fails",
    async (fault) => {
      const dir = mkdtempSync(join(tmpdir(), "wc-existing-cancellation-"));
      const dedupe = () => createPersistentDedupe({
        pluginId: "webchannel",
        namespacePrefix: "cancelled",
        ttlMs: 60_000,
        memoryMaxSize: 100,
        stateMaxEntries: 100,
        env: { ...process.env, OPENCLAW_STATE_DIR: dir },
      });
      try {
        await dedupe().checkAndRecord("p:i", { namespace: "a" });
        const cancelled = dedupe();
        expect(cancelled.memorySize()).toBe(0);
        const diskError = new Error("transient cancellation storage failure");
        // A cold SDK write can return true+onDiskError although the old durable
        // marker exists. This attempt must never reach that destructive path.
        const record = vi.spyOn(cancelled, "checkAndRecord").mockImplementationOnce(async (_key, options) => {
          options?.onDiskError?.(diskError);
          return true;
        });
        const forget = vi.spyOn(cancelled, "forget");
        if (fault !== "write") {
          vi.spyOn(cancelled, "hasRecent").mockImplementationOnce(async (_key, options) => {
            if (fault === "lookup throw") throw diskError;
            options?.onDiskError?.(diskError);
            return false;
          });
        }
        const store = makeStore({ accepted: fake().store, overloaded: fake().store, cancelled });
        const result = await store.record("a", "p:i", "cancelled", { replaceOthers: true });
        if (fault === "write") {
          if (result.status !== "recorded") throw new Error("existing cancellation unexpectedly unknown");
          expect(result.durability).toBe("durable");
          expect(result.write.created).toBe(false);
          expect(await result.write.rollback()).toBe(false);
        } else {
          expect(result).toEqual({ status: "unknown", error: diskError });
        }
        expect(record).not.toHaveBeenCalled();
        expect(forget).not.toHaveBeenCalled();
        expect(store.rollbackRecoverySize().entries).toBe(0);
        expect(await dedupe().hasRecent("p:i", { namespace: "a" })).toBe(true);
        // Both outcomes release their key gate and retain the suppression.
        expect(await store.lookup("a", "p:i")).toEqual({ status: "found", outcome: "cancelled" });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it("quarantines SDK cancellation write and cleanup faults without erasing the durable accept", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wc-cancellation-outcome-"));
    const blocked = join(dir, "blocked-state");
    writeFileSync(blocked, "not a directory");
    const dedupe = (namespacePrefix: string, stateDir = dir) => createPersistentDedupe({
      pluginId: "webchannel",
      namespacePrefix,
      ttlMs: 60_000,
      memoryMaxSize: 100,
      stateMaxEntries: 100,
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
    });
    try {
      const accepted = dedupe("accepted");
      const cancelled = dedupe("cancelled", blocked);
      const store = makeStore({ accepted, overloaded: dedupe("overloaded"), cancelled });
      await commit(store, "a", "p:i", "accepted");

      // Absence was established before storage failed. Keep subsequent write
      // and cleanup on the real SDK's blocked-state disk-error paths.
      vi.spyOn(cancelled, "hasRecent").mockResolvedValueOnce(false);
      // The real SDK inserts memory on write failure; forget clears memory but
      // reports its disk failure through onDiskError, without throwing.
      expect((await store.record("a", "p:i", "cancelled", { replaceOthers: true })).status).toBe("unknown");
      expect(store.rollbackRecoverySize()).toMatchObject({ entries: 1, poisoned: false });
      expect(store.peek("a", "p:i")).toBeUndefined();
      expect((await store.lookup("a", "p:i")).status).toBe("unknown");
      expect(await dedupe("accepted").hasRecent("p:i", { namespace: "a" })).toBe(true);

      rmSync(blocked);
      const restarted = makeStore({
        accepted: dedupe("accepted"), overloaded: dedupe("overloaded"),
        cancelled: dedupe("cancelled", blocked),
      });
      expect(await restarted.lookup("a", "p:i")).toEqual({ status: "found", outcome: "accepted" });
      expect(await store.lookup("a", "p:i")).toEqual({ status: "found", outcome: "accepted" });
      expect(store.rollbackRecoverySize().entries).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([false, true])("preserves the previous verdict when cancellation rollback cleanup fails=%s", async (failCleanup) => {
    const accepted = fake(); const overloaded = fake(); const cancelled = fake();
    const store = makeStore({ accepted: accepted.store, overloaded: overloaded.store, cancelled: cancelled.store });
    await commit(store, "a", "p:i", "accepted");
    const suppression = await store.record("a", "p:i", "cancelled", { replaceOthers: true });
    if (suppression.status !== "recorded") throw new Error("suppression unexpectedly unknown");
    expect(suppression.write.created).toBe(true);
    expect(accepted.values.has("a:p:i")).toBe(true);
    if (failCleanup) {
      vi.mocked(cancelled.store.forget).mockImplementationOnce(async (_key, options) => {
        options?.onDiskError?.(new Error("cleanup failed"));
        return false;
      });
    }
    expect(await suppression.write.rollback()).toBe(!failCleanup);
    expect(accepted.values.has("a:p:i")).toBe(true);
    expect(await store.lookup("a", "p:i")).toEqual({ status: "found", outcome: "accepted" });
    expect(cancelled.values.has("a:p:i")).toBe(false);
  });

  it("reclaims an orphan under the key gate and quarantines failed erasure before recording", async () => {
    const accepted = fake();
    const store = makeStore({ accepted: accepted.store, overloaded: fake().store });
    await commit(store, "a", "p:i", "accepted");
    vi.mocked(accepted.store.forget).mockImplementationOnce(async (_key, options) => {
      options?.onDiskError?.(new Error("orphan erasure failed"));
      return false;
    });
    expect((await store.record("a", "p:i", "accepted", { reclaimAccepted: true })).status).toBe("unknown");
    expect(accepted.store.checkAndRecord).toHaveBeenCalledTimes(1);
    expect(store.peek("a", "p:i")).toBeUndefined();
    expect(store.rollbackRecoverySize().entries).toBe(1);

    const retry = await store.record("a", "p:i", "accepted", { reclaimAccepted: true });
    if (retry.status !== "recorded") throw new Error("reclaim unexpectedly unknown");
    expect(retry.write.created).toBe(true);
    const lookup = store.lookup("a", "p:i");
    expect(await retry.write.rollback()).toBe(true);
    expect(await lookup).toEqual({ status: "not-found" });
    expect(store.rollbackRecoverySize().entries).toBe(0);
  });

  it("warns for cold lookup and accepted/overloaded record storage failures without error data", async () => {
    const accepted = fake(); const overloaded = fake();
    const warned: string[] = [];
    const warnFailure = createRateLimitedOutcomeFailureWarning((message) => warned.push(message));
    (overloaded.store.hasRecent as any).mockImplementationOnce(async (_key: string, options: any) => {
      options.onDiskError(new Error("secret lookup peer:id"));
      return false;
    });
    const store = makeStore({
      accepted: accepted.store,
      overloaded: overloaded.store,
      warnFailure,
    });
    expect((await store.lookup("acct", "secret-key")).status).toBe("unknown");

    for (const [outcome, target] of [
      ["accepted", accepted],
      ["overloaded", overloaded],
    ] as const) {
      (target.store.checkAndRecord as any).mockImplementationOnce(async (_key: string, options: any) => {
        options.onDiskError(new Error(`secret ${outcome} content`));
        return true;
      });
      expect((await store.record("acct", `secret-${outcome}`, outcome)).status).toBe(
        outcome === "accepted" ? "recorded" : "unknown",
      );
    }

    expect(warned.join(" ")).toContain("category=lookup-overloaded");
    expect(warned.join(" ")).toContain("category=record-accepted");
    expect(warned.join(" ")).toContain("category=record-overloaded");
    expect(warned.join(" ")).not.toMatch(/secret|peer:id|content/);
  });

  it("#344: a faulted `cancelled` write fails CLOSED and leaves no memory-only marker", async () => {
    // Round 3 extended `record()`'s disk-error cleanup from `overloaded` alone to
    // BOTH refusals. The reason is the one this whole slice exists for: the SDK
    // has already inserted a memory marker, and a memory-only suppression dies
    // with the process — so a restart would let the client's replay run the turn
    // `/stop` killed. `accepted` deliberately stays memory-only-tolerant: losing
    // an accept marker only re-admits, which the journal's idempotency collapses.
    const accepted = fake(); const overloaded = fake(); const cancelled = fake();
    const store = makeStore({
      accepted: accepted.store,
      overloaded: overloaded.store,
      cancelled: cancelled.store,
    });

    (cancelled.store.checkAndRecord as any).mockImplementationOnce(async (key: string, options: any) => {
      options.onDiskError(new Error("disk full"));
      cancelled.values.add(`${options.namespace}:${key}`); // the SDK's memory marker
      return true;
    });
    const suppression = await store.record("a", "p:i", "cancelled", { replaceOthers: true });

    // UNKNOWN, not a memory-only `recorded`: every cancellation writer treats that
    // as "retry later" (fallback tombstone / peer FIFO / publish nothing), which
    // is what keeps the suppression alive across the fault.
    expect(suppression.status).toBe("unknown");
    // And the memory marker the SDK inserted is gone, so a later lookup cannot
    // rediscover a suppression that was never durable.
    expect(cancelled.values.has("a:p:i")).toBe(false);
    expect(await store.lookup("a", "p:i")).toEqual({ status: "not-found" });

    // The contrast, in the same test so the asymmetry cannot be read as an
    // oversight: `accepted` still returns a usable memory-only receipt.
    (accepted.store.checkAndRecord as any).mockImplementationOnce(async (_key: string, options: any) => {
      options.onDiskError(new Error("disk full"));
      return true;
    });
    const admit = await store.record("a", "p:j", "accepted");
    if (admit.status !== "recorded") throw new Error("accepted unexpectedly failed closed");
    expect(admit.durability).toBe("memory-only");
  });

  it("namespaces accounts and gives overloaded precedence over impossible dual markers", async () => {
    const accepted = fake(); const overloaded = fake();
    const warn = vi.fn();
    const store = makeStore({ accepted: accepted.store, overloaded: overloaded.store, warnInvariant: warn });
    await commit(store, "a", "p:i", "accepted");
    expect(await store.lookup("b", "p:i")).toEqual({ status: "not-found" });
    overloaded.values.add("a:p:i");
    expect(await store.lookup("a", "p:i")).toEqual({ status: "found", outcome: "overloaded" });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("forgets a memory-only overload and returns unknown", async () => {
    const accepted = fake(); const overloaded = fake();
    (overloaded.store.checkAndRecord as any).mockImplementation(async (key: string, options: any) => {
      overloaded.values.add(`${options.namespace}:${key}`);
      options.onDiskError(new Error("disk"));
      return true;
    });
    const store = makeStore({ accepted: accepted.store, overloaded: overloaded.store });
    expect((await store.record("a", "k", "overloaded")).status).toBe("unknown");
    expect(overloaded.values.has("a:k")).toBe(false);
    expect(store.peek("a", "k")).toBeUndefined();
  });

  it("fails closed when replacing the opposite marker reports a disk error", async () => {
    const accepted = fake(); const overloaded = fake();
    const warnFailure = vi.fn();
    const store = makeStore({
      accepted: accepted.store,
      overloaded: overloaded.store,
      warnFailure,
    });
    await commit(store, "a", "k", "overloaded");
    expect(store.peek("a", "k")).toBe("overloaded");
    const disk = new Error("forget failed");
    (overloaded.store.forget as any).mockImplementation(async (_key: string, options: any) => {
      options.onDiskError(disk);
      return false;
    });

    const result = await store.record("a", "k", "accepted", { replaceOthers: true });
    expect(result).toEqual({ status: "unknown", error: disk });
    expect(warnFailure).toHaveBeenCalledWith("a", "replace-with-accepted");
    expect(accepted.store.checkAndRecord).not.toHaveBeenCalled();
    expect(overloaded.values.has("a:k")).toBe(true);
    expect(store.peek("a", "k")).toBe("overloaded");
    // Unknown must still release the per-key operation gate.
    await expect(store.lookup("a", "k")).resolves.toEqual({
      status: "found",
      outcome: "overloaded",
    });
  });

  it("ACKs durable cancellation even when later weaker-marker cleanup fails", async () => {
    const accepted = fake(); const overloaded = fake();
    const store = makeStore({ accepted: accepted.store, overloaded: overloaded.store });
    await commit(store, "a", "p:i", "overloaded");
    (overloaded.store.forget as any).mockImplementation(async (_key: string, options: any) => {
      options.onDiskError(new Error("durable overload remains"));
      return false;
    });
    const fallback = new CancelledInboundFallbackTombstones();
    fallback.add("p:i", "a");
    const sendAck = vi.fn(() => true);
    const resolver = new BoundedOverflowResolver({
      outcomeStore: store,
      sendAck,
      sendRejected: vi.fn(),
      onCancelledRecovered: (request) => fallback.delete(request.key, request.accountId),
    });
    expect(resolver.tryStart({
      accountId: "a",
      peerId: "p",
      key: "p:i",
      id: "i",
      sessionToken: new InboundRetentionBudget().createSessionToken(),
      recoverCancelled: true,
    })).toEqual({ status: "started" });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(sendAck).toHaveBeenCalledWith(expect.objectContaining({ peerId: "p", id: "i" }));
    expect(fallback.has("p:i", "a")).toBe(false);
    expect(await store.lookup("a", "p:i")).toEqual({ status: "found", outcome: "cancelled" });
    expect(overloaded.values.has("a:p:i")).toBe(true);
    expect(accepted.values.has("a:p:i")).toBe(false);
    expect(resolver.usage()).toEqual({ tasks: 0, metadataBytes: 0 });
  });

  it("bounds the hot cache globally by count", async () => {
    const accepted = fake(); const overloaded = fake();
    const store = makeStore({ accepted: accepted.store, overloaded: overloaded.store, maxHotEntries: 2 });
    await commit(store, "a", "1", "accepted");
    await commit(store, "b", "2", "accepted");
    await commit(store, "c", "3", "accepted");
    expect(store.hotSize().entries).toBe(2);
    expect(store.peek("a", "1")).toBeUndefined();
  });

  it("enforces the default 2,048-entry hot-cache cap across accounts", async () => {
    const accepted = fake(); const overloaded = fake();
    const store = makeStore({ accepted: accepted.store, overloaded: overloaded.store });
    for (let index = 0; index <= MAX_INGRESS_OUTCOME_HOT_ENTRIES; index++) {
      await commit(store, `account-${index % 3}`, `key-${index}`, "accepted");
    }
    expect(store.hotSize().entries).toBe(MAX_INGRESS_OUTCOME_HOT_ENTRIES);
    expect(store.peek("account-0", "key-0")).toBeUndefined();
  });

  it("enforces the default 2 MiB hot-cache byte cap across accounts", async () => {
    const accepted = fake(); const overloaded = fake();
    const store = makeStore({
      accepted: accepted.store,
      overloaded: overloaded.store,
      maxHotEntries: MAX_INGRESS_OUTCOME_HOT_ENTRIES,
    });
    const account = "a";
    const exactKey = "k".repeat(MAX_INGRESS_OUTCOME_HOT_BYTES - Buffer.byteLength(account) - 64);
    await commit(store, account, exactKey, "accepted");
    expect(store.hotSize()).toEqual({ entries: 1, bytes: MAX_INGRESS_OUTCOME_HOT_BYTES });
    await commit(store, "other", "next", "accepted");
    expect(store.hotSize().bytes).toBeLessThanOrEqual(MAX_INGRESS_OUTCOME_HOT_BYTES);
    expect(store.peek(account, exactKey)).toBeUndefined();
  });

  it("holds replacement accepted writes behind exact rollback of an old generation", async () => {
    const accepted = fake(); const overloaded = fake();
    let finishOld!: () => void;
    const oldGate = new Promise<void>((resolve) => { finishOld = resolve; });
    let calls = 0;
    (accepted.store.checkAndRecord as any).mockImplementation(async (key: string, options: any) => {
      calls++;
      if (calls === 1) await oldGate;
      const scoped = `${options.namespace}:${key}`;
      const fresh = !accepted.values.has(scoped);
      accepted.values.add(scoped);
      return fresh;
    });
    const store = makeStore({ accepted: accepted.store, overloaded: overloaded.store });

    const oldPending = store.record("a", "p:i", "accepted");
    await Promise.resolve();
    const replacementPending = store.record("a", "p:i", "accepted");
    finishOld();
    const old = await oldPending;
    if (old.status !== "recorded") throw new Error("old write unexpectedly unknown");
    await Promise.resolve();
    expect(calls).toBe(1);
    await old.write.rollback();

    const replacement = await replacementPending;
    if (replacement.status !== "recorded") throw new Error("replacement unexpectedly unknown");
    expect(replacement.write.created).toBe(true);
    replacement.write.commit();
    expect(await store.lookup("a", "p:i")).toEqual({ status: "found", outcome: "accepted" });
  });

  it("cancelled replacements retain weaker markers until lookup and suppress them after restart", async () => {
    // The two halves of making `cancelled` a first-class terminal outcome.
    const accepted = fake(); const overloaded = fake(); const cancelled = fake();
    const invariants: string[] = [];
    const store = createIngressOutcomeStore({
      accepted: accepted.store,
      overloaded: overloaded.store,
      cancelled: cancelled.store,
      warnInvariant: (message) => invariants.push(message),
    });

    // Keep old markers until the replacement receipt settles; cancellation's
    // higher precedence makes the pair safe even across a process restart.
    accepted.values.add("a:p:i");
    overloaded.values.add("a:p:i");
    const suppression = await store.record("a", "p:i", "cancelled", { replaceOthers: true });
    if (suppression.status !== "recorded") throw new Error("suppression unexpectedly unknown");
    suppression.write.commit();
    expect(accepted.values.has("a:p:i")).toBe(true);
    expect(overloaded.values.has("a:p:i")).toBe(true);
    expect(cancelled.values.has("a:p:i")).toBe(true);
    const restarted = makeStore({
      accepted: accepted.store, overloaded: overloaded.store, cancelled: cancelled.store,
      warnInvariant: (winner) => invariants.push(winner),
    });
    expect(await restarted.lookup("a", "p:i")).toEqual({ status: "found", outcome: "cancelled" });
    expect(accepted.values.has("a:p:i")).toBe(false);
    expect(overloaded.values.has("a:p:i")).toBe(false);
    expect(invariants).toEqual([]);

    // Cleanup may also be retried with the same precedence.
    // `cancelled` over `overloaded` is the decision documented on
    // OUTCOME_PRECEDENCE: killed text must not be reported as backpressure.
    overloaded.values.add("a:p:i");
    accepted.values.add("a:p:i");
    expect(await store.lookup("a", "p:i")).toEqual({ status: "found", outcome: "cancelled" });
    // The store reports the WINNER; the line is built by the limiter (see
    // "names the WINNING outcome…" below, which asserts the console text).
    expect(invariants).toEqual([]);
    expect(overloaded.values.has("a:p:i")).toBe(false);
    expect(accepted.values.has("a:p:i")).toBe(false);

    // And the pre-existing rung is untouched: overloaded still beats accepted.
    const other = fake(); const otherOverloaded = fake();
    const second = createIngressOutcomeStore({
      accepted: other.store,
      overloaded: otherOverloaded.store,
      cancelled: fake().store,
      warnInvariant: (message) => invariants.push(message),
    });
    other.values.add("a:p:j");
    otherOverloaded.values.add("a:p:j");
    expect(await second.lookup("a", "p:j")).toEqual({ status: "found", outcome: "overloaded" });
    expect(invariants.at(-1)).toBe("overloaded");
  });

  it("re-recording an EXISTING accepted marker still reports `recorded`, as a follower", async () => {
    // Ordinary repeat writes remain followers. Journal-proven orphan recovery
    // explicitly opts into reclaimAccepted and owns a new receipt instead.
    const accepted = fake(); const overloaded = fake();
    const store = makeStore({ accepted: accepted.store, overloaded: overloaded.store });

    const first = await store.record("a", "p:i", "accepted");
    if (first.status !== "recorded") throw new Error("first write unexpectedly unknown");
    expect(first.write.created).toBe(true);
    first.write.commit();

    const again = await store.record("a", "p:i", "accepted");
    if (again.status !== "recorded") throw new Error("re-record unexpectedly unknown");
    // A FOLLOWER: durable and usable, but it did not create the marker...
    expect(again.durability).toBe("durable");
    expect(again.write.created).toBe(false);
    // ...so its rollback has no authority to delete it.
    expect(await again.write.rollback()).toBe(false);
    expect(accepted.values.has("a:p:i")).toBe(true);
    expect(await store.lookup("a", "p:i")).toEqual({ status: "found", outcome: "accepted" });
  });

  it.each(["accepted", "overloaded"] as const)(
    "quarantines a %s marker after rollback deletion fails until exact cleanup recovers",
    async (outcome) => {
      const accepted = fake(); const overloaded = fake();
      const target = outcome === "accepted" ? accepted : overloaded;
      const disk = new Error("rollback delete failed");
      let failDelete = true;
      (target.store.forget as any).mockImplementation(async (key: string, options: any) => {
        if (failDelete) {
          options.onDiskError?.(disk);
          return false;
        }
        return target.values.delete(`${options.namespace}:${key}`);
      });
      const warnFailure = vi.fn();
      const store = makeStore({
        accepted: accepted.store,
        overloaded: overloaded.store,
        warnFailure,
      });

      const pending = await store.record("a", "p:i", outcome);
      if (pending.status !== "recorded") throw new Error("write unexpectedly unknown");
      expect(pending.write.created).toBe(true);
      expect(await pending.write.rollback()).toBe(false);
      expect(warnFailure).toHaveBeenCalledWith("a", `rollback-${outcome}`);

      // The durable marker still exists but neither the synchronous hot path nor
      // a same-process cold lookup may classify it as a completed result.
      expect(target.values.has("a:p:i")).toBe(true);
      expect(store.peek("a", "p:i")).toBeUndefined();
      expect(store.hotSize()).toEqual({ entries: 0, bytes: 0 });
      expect(store.rollbackRecoverySize()).toMatchObject({ entries: 1, poisoned: false });
      await expect(store.lookup("a", "p:i")).resolves.toEqual({ status: "unknown", error: disk });
      expect(warnFailure).toHaveBeenCalledWith("a", `rollback-recovery-${outcome}`);
      expect(target.store.hasRecent).not.toHaveBeenCalled();

      // A later retry first removes that exact generation, then performs a fresh
      // classification. No ACK/rejection result is authorized before this point.
      failDelete = false;
      await expect(store.lookup("a", "p:i")).resolves.toEqual({ status: "not-found" });
      expect(target.values.has("a:p:i")).toBe(false);
      expect(store.rollbackRecoverySize()).toEqual({ entries: 0, bytes: 0, poisoned: false });

      const retry = await store.record("a", "p:i", outcome);
      if (retry.status !== "recorded") throw new Error("recovery write unexpectedly unknown");
      expect(retry.write.created).toBe(true);
      retry.write.commit();
      await expect(store.lookup("a", "p:i")).resolves.toEqual({ status: "found", outcome });
    },
  );

  it("fails the process store closed without growing recovery metadata past its cap", async () => {
    const accepted = fake(); const overloaded = fake();
    const warnFailure = vi.fn();
    (accepted.store.forget as any).mockImplementation(async (_key: string, options: any) => {
      options.onDiskError?.(new Error("disk unavailable"));
      return false;
    });
    const store = makeStore({
      accepted: accepted.store,
      overloaded: overloaded.store,
      maxRollbackRecoveryEntries: 1,
      maxRollbackRecoveryBytes: 1_024,
      warnFailure,
    });

    for (const key of ["one", "two"]) {
      const result = await store.record("a", key, "accepted");
      if (result.status !== "recorded") throw new Error("write unexpectedly unknown");
      await result.write.rollback();
    }

    expect(store.rollbackRecoverySize()).toMatchObject({ entries: 1, poisoned: true });
    expect(warnFailure).toHaveBeenCalledWith("a", "rollback-recovery-poisoned");
    expect(store.peek("a", "one")).toBeUndefined();
    expect(store.peek("a", "two")).toBeUndefined();
    expect((await store.lookup("a", "unrelated")).status).toBe("unknown");
    expect((await store.record("a", "three", "accepted")).status).toBe("unknown");
    expect(store.rollbackRecoverySize().entries).toBe(1);
  });

  it("serializes concurrent overload owners so disk failure cannot create a durable follower", async () => {
    const accepted = fake(); const overloaded = fake();
    let finishFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { finishFirst = resolve; });
    let calls = 0;
    let concurrent = 0;
    let maxConcurrent = 0;
    (overloaded.store.checkAndRecord as any).mockImplementation(async (key: string, options: any) => {
      calls++;
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      if (calls === 1) await firstGate;
      overloaded.values.add(`${options.namespace}:${key}`);
      options.onDiskError(new Error("disk"));
      concurrent--;
      return true;
    });
    const store = makeStore({ accepted: accepted.store, overloaded: overloaded.store });
    const first = store.record("a", "p:i", "overloaded");
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const follower = store.record("a", "p:i", "overloaded");
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(calls).toBe(1);
    finishFirst();
    expect((await first).status).toBe("unknown");
    expect((await follower).status).toBe("unknown");
    expect(maxConcurrent).toBe(1);
    expect(overloaded.values.has("a:p:i")).toBe(false);
  });

  it("names the WINNING outcome in the emitted dual-marker line, throttled per winner", () => {
    // #344 round 3: this limiter used to take a `message`, DISCARD it, and print
    // a hardcoded "overloaded wins". Measured before the fix: passing
    // "…cancelled wins" emitted "…overloaded wins" — the log told the operator
    // the peer had been sent `inbound_rejected` when it had been silently acked.
    // So the assertion that matters is the CONSOLE TEXT, not what the store built.
    let now = 0;
    const warn = vi.fn();
    const limited = createRateLimitedOutcomeInvariantWarning(warn, () => now, 100);

    limited("cancelled");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toBe(
      "webchannel: ingress outcome invariant violation (dual marker); cancelled wins (suppressed=0)",
    );

    // Per-WINNER windows: a different winner is not suppressed by this one, so a
    // burst of one shape cannot hide the other — the same reason
    // `JournalWarning` splits its members in `ingress-dedupe.ts`.
    limited("overloaded");
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[1]?.[0]).toBe(
      "webchannel: ingress outcome invariant violation (dual marker); overloaded wins (suppressed=0)",
    );

    // Within one window, same winner: counted, not emitted.
    limited("cancelled");
    expect(warn).toHaveBeenCalledTimes(2);
    now = 100;
    limited("cancelled");
    expect(warn).toHaveBeenCalledTimes(3);
    expect(warn.mock.calls[2]?.[0]).toBe(
      "webchannel: ingress outcome invariant violation (dual marker); cancelled wins (suppressed=1)",
    );

    // The state is three static entries keyed by a closed union, so nothing off
    // the wire can reach it. The old signature took an arbitrary string and only
    // stayed safe by discarding it; this one cannot be handed a peer value at all
    // (`limited("peer:id")` does not typecheck), which is why the previous
    // version of this test — three secret-looking strings and a redaction check —
    // is gone rather than rewritten.
    expect(warn.mock.calls.flat().join(" ")).not.toMatch(/peer|secret/);
  });

  it("rate-limits fixed failure categories and redacts unsafe account labels", () => {
    let now = 0;
    const warn = vi.fn();
    const limited = createRateLimitedOutcomeFailureWarning(warn, () => now, 100);
    limited("acct-safe", "lookup-accepted");
    limited("acct-safe", "lookup-accepted");
    limited("acct-safe", "record-accepted");
    expect(warn).toHaveBeenCalledTimes(2);
    now = 100;
    limited("secret peer/id\nciphertext", "lookup-accepted");
    expect(warn).toHaveBeenCalledTimes(3);
    expect(warn.mock.calls[2]?.[0]).toContain("account=<redacted>");
    expect(warn.mock.calls[2]?.[0]).toContain("suppressed=1");
    expect(warn.mock.calls.flat().join(" ")).not.toMatch(/secret peer|ciphertext/);
  });
});
