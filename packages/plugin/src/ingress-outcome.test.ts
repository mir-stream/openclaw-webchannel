import { describe, expect, it, vi } from "vitest";
import type { PersistentDedupe } from "openclaw/plugin-sdk/persistent-dedupe";
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
  it("warns for cold lookup and accepted/overloaded record storage failures without error data", async () => {
    const accepted = fake(); const overloaded = fake();
    const warned: string[] = [];
    const warnFailure = createRateLimitedOutcomeFailureWarning((message) => warned.push(message));
    (overloaded.store.hasRecent as any).mockImplementationOnce(async (_key: string, options: any) => {
      options.onDiskError(new Error("secret lookup peer:id"));
      return false;
    });
    const store = createIngressOutcomeStore({
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

  it("namespaces accounts and gives overloaded precedence over impossible dual markers", async () => {
    const accepted = fake(); const overloaded = fake();
    const warn = vi.fn();
    const store = createIngressOutcomeStore({ accepted: accepted.store, overloaded: overloaded.store, warnInvariant: warn });
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
    const store = createIngressOutcomeStore({ accepted: accepted.store, overloaded: overloaded.store });
    expect((await store.record("a", "k", "overloaded")).status).toBe("unknown");
    expect(overloaded.values.has("a:k")).toBe(false);
    expect(store.peek("a", "k")).toBeUndefined();
  });

  it("fails closed when replacing the opposite marker reports a disk error", async () => {
    const accepted = fake(); const overloaded = fake();
    const warnFailure = vi.fn();
    const store = createIngressOutcomeStore({
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

    const result = await store.record("a", "k", "accepted", { replaceOpposite: true });
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

  it("keeps cancelled fallback and emits no ACK when opposite replacement fails", async () => {
    const accepted = fake(); const overloaded = fake();
    const store = createIngressOutcomeStore({ accepted: accepted.store, overloaded: overloaded.store });
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

    expect(sendAck).not.toHaveBeenCalled();
    expect(fallback.has("p:i", "a")).toBe(true);
    expect(overloaded.values.has("a:p:i")).toBe(true);
    expect(accepted.values.has("a:p:i")).toBe(false);
    expect(resolver.usage()).toEqual({ tasks: 0, metadataBytes: 0 });
  });

  it("bounds the hot cache globally by count", async () => {
    const accepted = fake(); const overloaded = fake();
    const store = createIngressOutcomeStore({ accepted: accepted.store, overloaded: overloaded.store, maxHotEntries: 2 });
    await commit(store, "a", "1", "accepted");
    await commit(store, "b", "2", "accepted");
    await commit(store, "c", "3", "accepted");
    expect(store.hotSize().entries).toBe(2);
    expect(store.peek("a", "1")).toBeUndefined();
  });

  it("enforces the default 2,048-entry hot-cache cap across accounts", async () => {
    const accepted = fake(); const overloaded = fake();
    const store = createIngressOutcomeStore({ accepted: accepted.store, overloaded: overloaded.store });
    for (let index = 0; index <= MAX_INGRESS_OUTCOME_HOT_ENTRIES; index++) {
      await commit(store, `account-${index % 3}`, `key-${index}`, "accepted");
    }
    expect(store.hotSize().entries).toBe(MAX_INGRESS_OUTCOME_HOT_ENTRIES);
    expect(store.peek("account-0", "key-0")).toBeUndefined();
  });

  it("enforces the default 2 MiB hot-cache byte cap across accounts", async () => {
    const accepted = fake(); const overloaded = fake();
    const store = createIngressOutcomeStore({
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
    const store = createIngressOutcomeStore({ accepted: accepted.store, overloaded: overloaded.store });

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

  it("re-recording an EXISTING accepted marker still reports `recorded`, as a follower", async () => {
    // #344's accept path depends on this shape. When the journal has no row for
    // a marked `random_id`, `ingress-dedupe.ts` re-admits the message down the
    // FRESH path — which calls `record(…, "accepted")` for a key that is already
    // marked. If that answered anything but `status: "recorded"` the seam would
    // stall on its FIFO barrier and the message would never be journaled, so the
    // recovery rests on this contract rather than on a fresh insert.
    const accepted = fake(); const overloaded = fake();
    const store = createIngressOutcomeStore({ accepted: accepted.store, overloaded: overloaded.store });

    const first = await store.record("a", "p:i", "accepted");
    if (first.status !== "recorded") throw new Error("first write unexpectedly unknown");
    expect(first.write.created).toBe(true);
    first.write.commit();

    const again = await store.record("a", "p:i", "accepted");
    if (again.status !== "recorded") throw new Error("re-record unexpectedly unknown");
    // A FOLLOWER: durable and usable, but it did not create the marker...
    expect(again.durability).toBe("durable");
    expect(again.write.created).toBe(false);
    // ...so its rollback has no authority to delete it. That is what makes a
    // refused re-admission batch safe: the marker survives, and the next replay
    // takes the same recovery path instead of hitting a wiped outcome store.
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
      const store = createIngressOutcomeStore({
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
    const store = createIngressOutcomeStore({
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
    const store = createIngressOutcomeStore({ accepted: accepted.store, overloaded: overloaded.store });
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

  it("rate-limits the process dual-marker warning with bounded content-free state", () => {
    let now = 0;
    const warn = vi.fn();
    const limited = createRateLimitedOutcomeInvariantWarning(warn, () => now, 100);
    limited("secret-peer:id-one");
    limited("other-peer:id-two");
    expect(warn).toHaveBeenCalledTimes(1);
    now = 100;
    limited("third-secret");
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[1]?.[0]).toContain("suppressed=1");
    expect(warn.mock.calls.flat().join(" ")).not.toMatch(/secret|peer|id-one|id-two/);
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
