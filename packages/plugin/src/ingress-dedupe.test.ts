import { describe, it, expect, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { createInboundDebouncer } from "openclaw/plugin-sdk/reply-runtime";
import {
  createPersistentDedupe,
  type PersistentDedupe,
} from "openclaw/plugin-sdk/persistent-dedupe";

import {
  CancelledInboundFallbackTombstones,
  filterFreshInboundItems,
  createIngressOnFlush,
  recordCancelledInboundItems,
} from "./ingress-dedupe.js";
import { coalesceUserMessages, type UserMessageLike } from "./inbound-queue.js";
import { createSerializedInboundDispatcher } from "./inbound-queue.js";
import { createBoundedInboundDebouncer } from "./bounded-inbound-debouncer.js";
import { InboundRetentionBudget } from "./inbound-retention.js";
import {
  createIngressOutcomeStore,
  type IngressOutcome,
  type IngressOutcomeStore,
} from "./ingress-outcome.js";

/**
 * P0-7a — browser→agent ingress idempotency (first half).
 *
 *  1. `filterFreshInboundItems` in isolation: fresh-vs-duplicate decisions, order
 *     preservation, id-less pass-through (never touching the checker), the
 *     `${peerId}:${id}` / namespace=accountId key shape, and fail-open on a check
 *     rejection (now logged at WARN, not info).
 *  2. The REAL `createIngressOnFlush` factory — the exact onFlush index-nats.ts
 *     wires (extracted so it is tsc-checked + tested directly, not reimplemented
 *     here): duplicate dropped, id-less passthrough, fail-open on throw,
 *     all-duplicates dispatches nothing, coalesced dispatch to the first peer,
 *     and per-id recording BEFORE the coalesce. Plus one integration test driving
 *     it through a REAL `createInboundDebouncer`.
 *  3. One hermetic test against a REAL `createPersistentDedupe` (isolated tmp
 *     state dir) pinning the double-record → true-then-false contract we rely on.
 */

type Item = {
  peerId: string;
  message: { type: "user_message"; text: string; id?: string };
};

const item = (peerId: string, text: string, id?: string): Item => ({
  peerId,
  message: {
    type: "user_message",
    text,
    ...(id !== undefined ? { id } : {}),
  },
});

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const recordedOutcome = (outcome: IngressOutcome = "accepted") => {
  const write = {
    outcome,
    created: true,
    durability: "durable" as const,
    commit: vi.fn(),
    rollback: vi.fn(async () => true),
  };
  return { result: { status: "recorded" as const, durability: "durable" as const, write }, write };
};

/**
 * A namespace-aware fake of `PersistentDedupe.checkAndRecord`: returns true the
 * first time a `(namespace,key)` pair is seen (recording it), false afterwards.
 * Records every call's args so tests can pin the key/namespace shape.
 */
function fakeChecker() {
  const seen = new Set<string>();
  const calls: Array<{ key: string; namespace?: string }> = [];
  const checkAndRecord = vi.fn(
    async (key: string, opts?: { namespace?: string }) => {
      calls.push({ key, namespace: opts?.namespace });
      const composite = `${opts?.namespace ?? "global"}:${key}`;
      if (seen.has(composite)) return false;
      seen.add(composite);
      return true;
    },
  );
  return { checkAndRecord, calls };
}

describe("cancelled inbound fallback tombstones", () => {
  it("does not register when only the ack fails, and warns once", async () => {
    const fallback = new CancelledInboundFallbackTombstones();
    const warn = vi.fn();
    await recordCancelledInboundItems(
      [item("p", "killed", "id")], "acct", async () => true, () => false, warn, fallback,
    );
    expect(fallback.size).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("record-only failure registers, suppresses replay, and removes only after record+ack succeed", async () => {
    const fallback = new CancelledInboundFallbackTombstones();
    await recordCancelledInboundItems(
      [item("p", "killed", "id")], "acct",
      async () => { throw new Error("disk"); }, () => true, undefined, fallback,
    );
    expect(fallback.size).toBe(1);
    const dispatch = vi.fn();
    const onFlush = createIngressOnFlush<Item>({
      accountId: "acct", checkAndRecord: async () => true, dispatch,
      coalesce: coalesceUserMessages, sendAck: () => true, cancelledFallback: fallback,
    });
    await onFlush([item("p", "replay", "id")]);
    expect(dispatch).not.toHaveBeenCalled();
    expect(fallback.size).toBe(0);
  });

  it("simultaneous failure remains until a later replay has both successes", async () => {
    const fallback = new CancelledInboundFallbackTombstones();
    await recordCancelledInboundItems(
      [item("p", "killed", "id")], "acct",
      async () => { throw new Error("disk"); }, () => false, undefined, fallback,
    );
    const dispatch = vi.fn();
    const failedReplay = createIngressOnFlush<Item>({
      accountId: "acct", checkAndRecord: async () => true, dispatch,
      coalesce: coalesceUserMessages, sendAck: () => false, cancelledFallback: fallback,
    });
    await failedReplay([item("p", "replay", "id")]);
    expect(fallback.size).toBe(1);
    const recoveredReplay = createIngressOnFlush<Item>({
      accountId: "acct", checkAndRecord: async () => true, dispatch,
      coalesce: coalesceUserMessages, sendAck: () => true, cancelledFallback: fallback,
    });
    await recoveredReplay([item("p", "replay", "id")]);
    expect(fallback.size).toBe(0);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("isolates accounts, rejects oversized ids, and evicts the oldest at cap with one warn", async () => {
    const warn = vi.fn();
    const accountA = new CancelledInboundFallbackTombstones(warn, 2);
    const accountB = new CancelledInboundFallbackTombstones(undefined, 2);
    const fail = async () => { throw new Error("disk"); };
    await recordCancelledInboundItems([item("p", "x", "same")], "a", fail, () => true, undefined, accountA);
    expect(accountA.size).toBe(1);
    expect(accountB.size).toBe(0);
    await recordCancelledInboundItems([item("p", "x", "x".repeat(129))], "a", fail, () => true, undefined, accountA);
    expect(accountA.size).toBe(1);
    await recordCancelledInboundItems([item("p", "x", "second")], "a", fail, () => true, undefined, accountA);
    await recordCancelledInboundItems([item("p", "x", "third")], "a", fail, () => true, undefined, accountA);
    expect(accountA.size).toBe(2);
    expect(accountA.has("p:same")).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("filterFreshInboundItems", () => {
  it("keeps every item, in order, when all are fresh", async () => {
    const { checkAndRecord } = fakeChecker();
    const items = [
      item("p1", "a", "id1"),
      item("p1", "b", "id2"),
      item("p1", "c", "id3"),
    ];
    const out = await filterFreshInboundItems(items, "acct", checkAndRecord);
    expect(out).toEqual(items);
  });

  it("drops a duplicate mid-batch and preserves the surviving order", async () => {
    const { checkAndRecord } = fakeChecker();
    // Pre-record id2 so the middle item is a known duplicate.
    await checkAndRecord("p1:id2", { namespace: "acct" });

    const items = [
      item("p1", "a", "id1"),
      item("p1", "b", "id2"), // duplicate → dropped
      item("p1", "c", "id3"),
    ];
    const out = await filterFreshInboundItems(items, "acct", checkAndRecord);
    expect(out).toEqual([items[0], items[2]]);
  });

  it("keeps an id-less item WITHOUT consulting the checker (back-compat)", async () => {
    const { checkAndRecord } = fakeChecker();
    const items = [item("p1", "no-id-here")];
    const out = await filterFreshInboundItems(items, "acct", checkAndRecord);
    expect(out).toEqual(items);
    expect(checkAndRecord).not.toHaveBeenCalled();
  });

  it("drops the SECOND of two identical ids inside ONE batch (double-submit in one window)", async () => {
    // A rapid double-submit can land both copies in the same debounce window —
    // the sequential await loop must record the first and drop the second
    // within a single filterFreshInboundItems call.
    const { checkAndRecord } = fakeChecker();
    const items = [item("p1", "same", "idX"), item("p1", "same", "idX")];
    const out = await filterFreshInboundItems(items, "acct", checkAndRecord);
    expect(out).toEqual([items[0]]);
  });

  it("returns empty when the whole batch is duplicates", async () => {
    const { checkAndRecord } = fakeChecker();
    await checkAndRecord("p1:id1", { namespace: "acct" });
    await checkAndRecord("p1:id2", { namespace: "acct" });

    const out = await filterFreshInboundItems(
      [item("p1", "a", "id1"), item("p1", "b", "id2")],
      "acct",
      checkAndRecord,
    );
    expect(out).toEqual([]);
  });

  it("dedupes a 128-char id normally (at the length bound)", async () => {
    const { checkAndRecord } = fakeChecker();
    const id128 = "a".repeat(128);
    const out = await filterFreshInboundItems(
      [item("p1", "first", id128), item("p1", "second", id128)],
      "acct",
      checkAndRecord,
    );
    // In bounds → dedupe-able → the second copy is dropped.
    expect(out).toEqual([{ peerId: "p1", message: { type: "user_message", text: "first", id: id128 } }]);
  });

  it("passes an OVER-LENGTH id (129 chars) through un-deduped, never recording it", async () => {
    const { checkAndRecord } = fakeChecker();
    const id129 = "a".repeat(129);
    const out = await filterFreshInboundItems(
      [item("p1", "a", id129), item("p1", "b", id129)],
      "acct",
      checkAndRecord,
    );
    // Over-length id is treated as id-less: both pass, checker never consulted.
    expect(out).toHaveLength(2);
    expect(checkAndRecord).not.toHaveBeenCalled();
  });

  it("passes a NON-STRING id through un-deduped, never recording it", async () => {
    const { checkAndRecord } = fakeChecker();
    // A hostile/non-conforming peer can send a non-string id despite the type.
    const bad: Item = { peerId: "p1", message: { type: "user_message", text: "a", id: 123 as unknown as string } };
    const out = await filterFreshInboundItems([bad], "acct", checkAndRecord);
    expect(out).toEqual([bad]);
    expect(checkAndRecord).not.toHaveBeenCalled();
  });

  it("keys as `${peerId}:${id}` with namespace = accountId", async () => {
    const { checkAndRecord, calls } = fakeChecker();
    await filterFreshInboundItems(
      [item("peerX", "hi", "abc")],
      "acctY",
      checkAndRecord,
    );
    expect(calls).toEqual([{ key: "peerX:abc", namespace: "acctY" }]);
  });

  it("does NOT dedupe the same id across different peers (peer-scoped key)", async () => {
    const { checkAndRecord } = fakeChecker();
    const out = await filterFreshInboundItems(
      [item("p1", "x", "dup"), item("p2", "y", "dup")],
      "acct",
      checkAndRecord,
    );
    // Different peer prefixes → different keys → neither is a duplicate.
    expect(out).toHaveLength(2);
  });

  it("fails open: a checker rejection KEEPS the message and logs at WARN (not info)", async () => {
    const checkAndRecord = vi.fn(async () => {
      throw new Error("disk boom");
    });
    const info = vi.fn();
    const warn = vi.fn();
    const items = [item("p1", "a", "id1")];
    const out = await filterFreshInboundItems(items, "acct", checkAndRecord, { info, warn });
    expect(out).toEqual(items);
    // The fault goes to warn, NOT the info drop sink.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain("fail-open");
    expect(info).not.toHaveBeenCalled();
  });

  it("logs a routine duplicate DROP at INFO (not warn)", async () => {
    const { checkAndRecord } = fakeChecker();
    await checkAndRecord("p1:dup", { namespace: "acct" });
    const info = vi.fn();
    const warn = vi.fn();
    const out = await filterFreshInboundItems(
      [item("p1", "a", "dup")],
      "acct",
      checkAndRecord,
      { info, warn },
    );
    expect(out).toEqual([]);
    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0]![0]).toContain("dropped duplicate");
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("createIngressOnFlush — the REAL onFlush index-nats.ts wires", () => {
  /**
   * Build the real factory with a captured dispatch sink. `dispatched` records
   * every `(peerId, coalesced message)` the onFlush routes, so we can assert both
   * WHAT was dispatched and to WHICH peer — using the SAME `coalesceUserMessages`
   * the production wiring passes.
   */
  function makeOnFlush(
    accountId: string,
    checkAndRecord: (key: string, opts?: { namespace?: string }) => Promise<boolean>,
  ) {
    const dispatched: Array<{ peerId: string; message: UserMessageLike }> = [];
    const info = vi.fn();
    const warn = vi.fn();
    const onFlush = createIngressOnFlush<Item>({
      accountId,
      checkAndRecord,
      dispatch: (peerId, message) => dispatched.push({ peerId, message }),
      coalesce: coalesceUserMessages,
      logInfo: info,
      logWarn: warn,
    });
    return { onFlush, dispatched, info, warn };
  }

  it("drops a duplicate across two flushes: same id dispatches only once", async () => {
    const { checkAndRecord } = fakeChecker();
    const { onFlush, dispatched } = makeOnFlush("acct", checkAndRecord);

    await onFlush([item("p1", "hello", "idA")]);
    await onFlush([item("p1", "hello", "idA")]); // replay in a later window

    expect(dispatched.map((d) => d.message.text)).toEqual(["hello"]);
  });

  it("passes id-less frames through un-deduped (never consults the checker)", async () => {
    const { checkAndRecord } = fakeChecker();
    const { onFlush, dispatched } = makeOnFlush("acct", checkAndRecord);

    await onFlush([item("p1", "hi")]);
    await onFlush([item("p1", "hi")]);

    expect(dispatched.map((d) => d.message.text)).toEqual(["hi", "hi"]);
    expect(checkAndRecord).not.toHaveBeenCalled();
  });

  it("fails open on a throwing checker: still dispatches, and warns", async () => {
    const checkAndRecord = vi.fn(async () => {
      throw new Error("boom");
    });
    const { onFlush, dispatched, info, warn } = makeOnFlush("acct", checkAndRecord);

    await onFlush([item("p1", "important", "idX")]);

    expect(dispatched.map((d) => d.message.text)).toEqual(["important"]);
    expect(warn).toHaveBeenCalledTimes(1); // fault → warn
    expect(info).not.toHaveBeenCalled();
  });

  it("dispatches NOTHING when the whole batch is duplicates", async () => {
    const { checkAndRecord } = fakeChecker();
    await checkAndRecord("p1:id1", { namespace: "acct" });
    await checkAndRecord("p1:id2", { namespace: "acct" });
    const { onFlush, dispatched } = makeOnFlush("acct", checkAndRecord);

    await onFlush([item("p1", "a", "id1"), item("p1", "b", "id2")]);

    expect(dispatched).toEqual([]);
  });

  it("coalesces the surviving batch into ONE message dispatched to the first peer", async () => {
    const { checkAndRecord } = fakeChecker();
    const { onFlush, dispatched } = makeOnFlush("acct", checkAndRecord);

    await onFlush([item("p1", "one", "id1"), item("p1", "two", "id2")]);

    // One coalesced dispatch, joined in arrival order, routed to the first
    // survivor's peer (the whole same-peer batch's peer).
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]!.peerId).toBe("p1");
    expect(dispatched[0]!.message.text).toBe("one\n\ntwo");
  });

  it("records EACH id before the coalesce, so a later replay of a merged id is dropped", async () => {
    const { checkAndRecord } = fakeChecker();
    const { onFlush, dispatched } = makeOnFlush("acct", checkAndRecord);

    // First batch: id1 + id2 both fresh → merged into one coalesced turn.
    await onFlush([item("p1", "a", "id1"), item("p1", "b", "id2")]);
    // id2 was recorded per-item (not just the coalesce anchor id1): a later
    // replay carrying id2 is now a known duplicate and dispatches nothing.
    await onFlush([item("p1", "b-again", "id2")]);

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]!.message.text).toBe("a\n\nb");
  });
});

describe("ingress lifecycle fences", () => {
  it("drops a flush that becomes inactive inside an awaited dedupe operation", async () => {
    let active = true;
    let resolveCheck!: (fresh: boolean) => void;
    const dispatch = vi.fn();
    const sendAck = vi.fn(() => true);
    const onFlush = createIngressOnFlush<Item>({
      accountId: "a",
      checkAndRecord: () => new Promise<boolean>((resolve) => { resolveCheck = resolve; }),
      dispatch,
      coalesce: (messages) => messages[0]!,
      sendAck,
      isActive: () => active,
    });
    const pending = onFlush([item("p", "hello", "id")]);
    expect(sendAck).toHaveBeenCalledOnce();
    active = false;
    resolveCheck(true);
    await pending;
    expect(sendAck).toHaveBeenCalledOnce();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("does not ACK a cancelled item after its dedupe await crosses disposal", async () => {
    let active = true;
    let resolveCheck!: (fresh: boolean) => void;
    const sendAck = vi.fn(() => true);
    const pending = recordCancelledInboundItems(
      [item("p", "hello", "id")],
      "a",
      () => new Promise<boolean>((resolve) => { resolveCheck = resolve; }),
      sendAck,
      undefined,
      undefined,
      () => active,
    );
    active = false;
    resolveCheck(true);
    await pending;
    expect(sendAck).not.toHaveBeenCalled();
  });
});

describe("createIngressOnFlush — integration through a REAL createInboundDebouncer", () => {
  it("plugs into the debouncer: same id across two windows dispatches once", async () => {
    const { checkAndRecord } = fakeChecker();
    const dispatched: UserMessageLike[] = [];
    const debouncer = createInboundDebouncer<Item>({
      debounceMs: 10,
      serializeImmediate: true,
      buildKey: (i) => i.peerId,
      onFlush: createIngressOnFlush<Item>({
        accountId: "acct",
        checkAndRecord,
        dispatch: (_peerId, message) => dispatched.push(message),
        coalesce: coalesceUserMessages,
      }),
    });

    void debouncer.enqueue(item("p1", "hello", "idA"));
    await wait(30);
    void debouncer.enqueue(item("p1", "hello", "idA"));
    await wait(30);

    expect(dispatched.map((d) => d.text)).toEqual(["hello"]);
  });
});

describe("recordCancelledInboundItems — P0-7b (/stop-cancelled buffered messages)", () => {
  it("records `${peerId}:${id}` (namespace=accountId) AND acks id-carrying items", async () => {
    const { checkAndRecord, calls } = fakeChecker();
    const acks: Array<{ peerId: string; ids: string[] }> = [];
    await recordCancelledInboundItems(
      [item("p1", "killed-a", "idA"), item("p1", "killed-b", "idB")],
      "acctZ",
      checkAndRecord,
      (peerId, ids) => { acks.push({ peerId, ids }); return true; },
    );
    expect(calls).toEqual([
      { key: "p1:idA", namespace: "acctZ" },
      { key: "p1:idB", namespace: "acctZ" },
    ]);
    expect(acks).toEqual([{ peerId: "p1", ids: ["idA", "idB"] }]);
  });

  it("records BEFORE acking (killed text can't slip through a replay)", async () => {
    const order: string[] = [];
    const checkAndRecord = vi.fn(async (key: string) => {
      order.push(`record:${key}`);
      return true;
    });
    await recordCancelledInboundItems(
      [item("p1", "killed", "idA")],
      "acct",
      checkAndRecord,
      (_peerId, ids) => { order.push(`ack:${ids.join(",")}`); return true; },
    );
    expect(order).toEqual(["record:p1:idA", "ack:idA"]);
  });

  it("skips id-less items entirely (nothing recorded, nothing acked)", async () => {
    const { checkAndRecord } = fakeChecker();
    const acks: Array<{ peerId: string; ids: string[] }> = [];
    await recordCancelledInboundItems(
      [item("p1", "no-id")],
      "acct",
      checkAndRecord,
      (peerId, ids) => { acks.push({ peerId, ids }); return true; },
    );
    expect(checkAndRecord).not.toHaveBeenCalled();
    expect(acks).toEqual([]);
  });

  it("fails open: a throwing checkAndRecord still acks (best-effort) and logs", async () => {
    const checkAndRecord = vi.fn(async () => {
      throw new Error("disk boom");
    });
    const acks: Array<{ peerId: string; ids: string[] }> = [];
    const log = vi.fn();
    await recordCancelledInboundItems(
      [item("p1", "killed", "idA")],
      "acct",
      checkAndRecord,
      (peerId, ids) => { acks.push({ peerId, ids }); return true; },
      log,
    );
    // Record threw, but the ack still fires (drains the ledger) and a warn is logged.
    expect(acks).toEqual([{ peerId: "p1", ids: ["idA"] }]);
    expect(log).toHaveBeenCalledTimes(1);
  });

  it("groups ids by peer into one ack frame each", async () => {
    const { checkAndRecord } = fakeChecker();
    const acks: Array<{ peerId: string; ids: string[] }> = [];
    await recordCancelledInboundItems(
      [item("p1", "a", "id1"), item("p2", "b", "id2"), item("p1", "c", "id3")],
      "acct",
      checkAndRecord,
      (peerId, ids) => { acks.push({ peerId, ids }); return true; },
    );
    expect(acks).toEqual([
      { peerId: "p1", ids: ["id1", "id3"] },
      { peerId: "p2", ids: ["id2"] },
    ]);
  });

  it("suppresses result delivery when peer retirement wins a stalled record", async () => {
    let finishRecord!: () => void;
    const recordGate = new Promise<void>((resolve) => { finishRecord = resolve; });
    let live = true;
    const sendAck = vi.fn(() => true);
    const pending = recordCancelledInboundItems(
      [item("p", "cancelled", "id")],
      "acct",
      async () => { await recordGate; return true; },
      sendAck,
      undefined,
      undefined,
      () => live,
    );
    await Promise.resolve();
    live = false;
    finishRecord();
    await pending;
    expect(sendAck).not.toHaveBeenCalled();
  });
});

describe("createIngressOnFlush — P0-7b ingress ACK (fresh + duplicate ids acked before dispatch)", () => {
  /**
   * Drive the REAL `createIngressOnFlush` (with its `sendAck` dep) through the REAL
   * debouncer. The factory acks ALL id-carrying items — fresh AND deduped
   * duplicates — in ONE frame per flush, BEFORE dispatch, then dispatches only the
   * survivors. `sendAck`/`dispatch` both record into `order`, so we still observe
   * the ack-precedes-dispatch guarantee even though it now lives inside the factory.
   */
  function buildSeam(
    accountId: string,
    checkAndRecord: (key: string, opts?: { namespace?: string }) => Promise<boolean>,
    debounceMs = 10,
  ) {
    const dispatched: UserMessageLike[] = [];
    const acks: Array<{ peerId: string; ids: string[] }> = [];
    const order: string[] = []; // records "ack" / "dispatch" interleaving
    const debouncer = createInboundDebouncer<Item>({
      debounceMs,
      serializeImmediate: true,
      buildKey: (i) => i.peerId,
      onFlush: createIngressOnFlush<Item>({
        accountId,
        checkAndRecord,
        dispatch: (_peerId, message) => {
          dispatched.push(message);
          order.push("dispatch");
        },
        coalesce: coalesceUserMessages,
        sendAck: (peerId, ids) => {
          acks.push({ peerId, ids });
          order.push("ack");
          return true;
        },
      }),
    });
    return { debouncer, dispatched, acks, order };
  }

  it("acks a fresh batch in one frame, BEFORE dispatch", async () => {
    const { checkAndRecord } = fakeChecker();
    const { debouncer, dispatched, acks, order } = buildSeam("acct", checkAndRecord);

    void debouncer.enqueue(item("p1", "a", "id1"));
    void debouncer.enqueue(item("p1", "b", "id2"));
    await wait(30);

    expect(acks).toEqual([{ peerId: "p1", ids: ["id1", "id2"] }]);
    expect(dispatched.map((d) => d.text)).toEqual(["a\n\nb"]); // coalesced (blank-line join)
    expect(order).toEqual(["ack", "dispatch"]); // ack precedes dispatch
  });

  it("acks a DUPLICATE too (so the client's ledger drains) but dispatches nothing", async () => {
    const { checkAndRecord } = fakeChecker();
    // Pre-record idDup so the whole later batch is a duplicate.
    await checkAndRecord("p1:idDup", { namespace: "acct" });
    const { debouncer, dispatched, acks } = buildSeam("acct", checkAndRecord);

    void debouncer.enqueue(item("p1", "again", "idDup"));
    await wait(30);

    // The duplicate is still acked (the original arrived — without the ack the
    // client would replay it forever), but no turn runs.
    expect(acks).toEqual([{ peerId: "p1", ids: ["idDup"] }]);
    expect(dispatched).toEqual([]);
  });

  it("acks fresh + duplicate ids together in one frame", async () => {
    const { checkAndRecord } = fakeChecker();
    await checkAndRecord("p1:idOld", { namespace: "acct" }); // pre-seen
    const { debouncer, dispatched, acks } = buildSeam("acct", checkAndRecord);

    // A window carrying one duplicate (idOld) and one fresh (idNew).
    void debouncer.enqueue(item("p1", "dup", "idOld"));
    void debouncer.enqueue(item("p1", "new", "idNew"));
    await wait(30);

    expect(acks).toEqual([{ peerId: "p1", ids: ["idOld", "idNew"] }]);
    expect(dispatched.map((d) => d.text)).toEqual(["new"]); // only the fresh one runs
  });

  it("excludes id-less items from the ack (nothing to ack, no frame)", async () => {
    const { checkAndRecord } = fakeChecker();
    const { debouncer, acks } = buildSeam("acct", checkAndRecord);

    void debouncer.enqueue(item("p1", "no-id"));
    await wait(30);

    expect(acks).toEqual([]); // id-less → no ack frame at all
  });

  it("acks UNIQUE ids only (a same-window double-submit of one id acks once)", async () => {
    const { checkAndRecord } = fakeChecker();
    const { debouncer, acks } = buildSeam("acct", checkAndRecord);

    void debouncer.enqueue(item("p1", "x", "idX"));
    void debouncer.enqueue(item("p1", "x", "idX"));
    await wait(30);

    expect(acks).toEqual([{ peerId: "p1", ids: ["idX"] }]); // deduped in the ack set
  });

  it("does NOT throw and still dispatches when NO sendAck dep is wired (P0-7a first half)", async () => {
    const { checkAndRecord } = fakeChecker();
    const dispatched: UserMessageLike[] = [];
    // No `sendAck` — the P0-7a shape. The factory must simply skip the ack step.
    const onFlush = createIngressOnFlush<Item>({
      accountId: "acct",
      checkAndRecord,
      dispatch: (_peerId, message) => dispatched.push(message),
      coalesce: coalesceUserMessages,
    });

    await expect(onFlush([item("p1", "hi", "id1")])).resolves.toBeUndefined();
    expect(dispatched.map((d) => d.text)).toEqual(["hi"]);
  });
});

describe("real createPersistentDedupe (hermetic, isolated state dir)", () => {
  it("records once: same key → true then false", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "webchannel-dedupe-"));
    const dedupe = createPersistentDedupe({
      pluginId: "webchannel",
      ttlMs: 7 * 24 * 60 * 60 * 1000,
      memoryMaxSize: 8,
      stateMaxEntries: 32,
      env: { ...process.env, OPENCLAW_STATE_DIR: dir },
    });

    const first = await dedupe.checkAndRecord("p1:idZ", { namespace: "acct" });
    const second = await dedupe.checkAndRecord("p1:idZ", { namespace: "acct" });
    expect(first).toBe(true);
    expect(second).toBe(false);

    // A different key in the same namespace is unaffected.
    expect(await dedupe.checkAndRecord("p1:idY", { namespace: "acct" })).toBe(
      true,
    );
  });
});

describe("protocol-v2 outcome/lease ingress ordering", () => {
  it("releases every held outcome gate before awaiting multi-item /stop cancellation", async () => {
    const budget = new InboundRetentionBudget({
      maxMessagesPerSession: 8,
      maxBytesPerSession: 8,
      maxMessagesPerProcess: 8,
      maxBytesPerProcess: 8,
    });
    const token = budget.createSessionToken();
    let resolveBLookup!: (value: { status: "not-found" }) => void;
    const bLookup = new Promise<{ status: "not-found" }>((resolve) => {
      resolveBLookup = resolve;
    });
    let resolveCancellationA!: (value: ReturnType<typeof recordedOutcome>["result"]) => void;
    const cancellationAWait = new Promise<ReturnType<typeof recordedOutcome>["result"]>((resolve) => {
      resolveCancellationA = resolve;
    });
    const normalA = recordedOutcome();
    const cancelledA = recordedOutcome();
    const cancelledB = recordedOutcome();
    normalA.write.rollback.mockImplementation(async () => {
      resolveCancellationA(cancelledA.result);
      return true;
    });
    const store = {
      peek: vi.fn(),
      lookup: vi.fn(async (_accountId: string, key: string) =>
        key === "p:b" ? bLookup : { status: "not-found" as const }),
      record: vi.fn(async (
        _accountId: string,
        key: string,
        _outcome: IngressOutcome,
        options?: { replaceOpposite?: boolean },
      ) => {
        if (!options?.replaceOpposite) return normalA.result;
        return key === "p:a" ? cancellationAWait : cancelledB.result;
      }),
      forget: vi.fn(), hotSize: vi.fn(), rollbackRecoverySize: vi.fn(),
    } as unknown as IngressOutcomeStore;
    const dispatch = vi.fn();
    const sendAck = vi.fn(() => true);
    const onFlush = createIngressOnFlush<Item>({
      accountId: "acct",
      outcomeStore: store,
      beginBatch: () => ({
        offer: (message, reservation) => {
          reservation!.transfer("pending");
          return {
            status: "accepted" as const,
            commit: () => { dispatch(message); reservation!.requestRelease(); },
            rollback: () => reservation!.requestRelease(),
          };
        },
        finish: vi.fn(),
      }),
      sendAck,
      sendInboundRejected: vi.fn(() => true),
    });
    const debouncer = createBoundedInboundDebouncer<Item>({
      debounceMs: 0,
      buildKey: (value) => value.peerId,
      sessionToken: () => token,
      budget,
      measure: () => 1,
      getId: (value) => value.message.id,
      onFlush,
      onCancel: async (entries) => {
        for (const entry of entries) {
          const result = await store.record(
            "acct",
            `${entry.item.peerId}:${entry.id}`,
            "accepted",
            { replaceOpposite: true },
          );
          if (result.status === "recorded") result.write.commit();
        }
      },
    });

    expect(debouncer.push(item("p", "A", "a"))).toEqual({ status: "accepted" });
    expect(debouncer.push(item("p", "B", "b"))).toEqual({ status: "accepted" });
    await vi.waitFor(() => expect(store.lookup).toHaveBeenCalledWith("acct", "p:b"));
    expect(budget.usage()).toEqual({ messages: 2, bytes: 2 });
    expect(debouncer.cancelKey("p", { notify: true })).toBe(true);
    await vi.waitFor(() => expect(store.record).toHaveBeenCalledWith(
      "acct", "p:a", "accepted", { replaceOpposite: true },
    ));

    // Cancellation(A) is now queued behind normal receipt(A). Resolving B's
    // lookup must let the flush roll back A before it waits for cancellation.
    resolveBLookup({ status: "not-found" });
    await vi.waitFor(() => expect(normalA.write.rollback).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(cancelledB.write.commit).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(budget.usage()).toEqual({ messages: 0, bytes: 0 }));
    expect(cancelledA.write.commit).toHaveBeenCalledTimes(1);
    expect(dispatch).not.toHaveBeenCalled();
    expect(sendAck).not.toHaveBeenCalled();
    expect(debouncer.usage()).toEqual({ waiting: 0, inflight: 0, keys: 0 });
  });

  it("treats lookup unknown as a FIFO barrier while committing the classified prefix", async () => {
    const budget = new InboundRetentionBudget();
    const token = budget.createSessionToken();
    const entries = ["prefix", "unknown", "suffix"].map((id) => {
      const reserved = budget.tryReserve(token, 1, "debounce-inflight");
      if (reserved.status !== "accepted") throw new Error("unexpected rejection");
      return {
        item: item("p", id, id), id, reservation: reserved.reservation,
        isActive: () => true, isCancellationRequested: () => false,
        isRetired: () => false, waitForCancellation: async () => {},
      };
    });
    const store = {
      peek: vi.fn(),
      lookup: vi.fn()
        .mockResolvedValueOnce({ status: "found", outcome: "accepted" })
        .mockResolvedValueOnce({ status: "unknown", error: new Error("disk") }),
      record: vi.fn(), forget: vi.fn(), hotSize: vi.fn(), rollbackRecoverySize: vi.fn(),
    } as unknown as IngressOutcomeStore;
    const offer = vi.fn();
    const sendAck = vi.fn(() => true);
    const onFlush = createIngressOnFlush<Item>({
      accountId: "acct", outcomeStore: store,
      beginBatch: () => ({ offer, finish: vi.fn() }),
      sendAck, sendInboundRejected: vi.fn(() => true),
    });

    await onFlush(entries);
    expect(store.lookup).toHaveBeenCalledTimes(2);
    expect(store.lookup).not.toHaveBeenCalledWith("acct", "p:suffix");
    expect(store.record).not.toHaveBeenCalled();
    expect(offer).not.toHaveBeenCalled();
    expect(sendAck).toHaveBeenCalledWith("p", ["prefix"]);
    expect(budget.usage()).toEqual({ messages: 0, bytes: 0 });
  });

  it("treats accepted-record unknown as a FIFO barrier and commits only the prefix", async () => {
    const budget = new InboundRetentionBudget();
    const token = budget.createSessionToken();
    const entries = ["prefix", "unknown", "suffix"].map((id) => {
      const reserved = budget.tryReserve(token, 1, "debounce-inflight");
      if (reserved.status !== "accepted") throw new Error("unexpected rejection");
      return {
        item: item("p", id, id), id, reservation: reserved.reservation,
        isActive: () => true, isCancellationRequested: () => false,
        isRetired: () => false, waitForCancellation: async () => {},
      };
    });
    const prefixWrite = recordedOutcome();
    const store = {
      peek: vi.fn(), lookup: vi.fn(async () => ({ status: "not-found" as const })),
      record: vi.fn()
        .mockResolvedValueOnce(prefixWrite.result)
        .mockResolvedValueOnce({ status: "unknown", error: new Error("disk") }),
      forget: vi.fn(), hotSize: vi.fn(), rollbackRecoverySize: vi.fn(),
    } as unknown as IngressOutcomeStore;
    const committed: string[] = [];
    const rolledBack: string[] = [];
    const offer = vi.fn((message: Item["message"], reservation: any) => {
      reservation.transfer("pending");
      return {
        status: "accepted" as const,
        commit: () => { committed.push(message.text); reservation.requestRelease(); },
        rollback: () => { rolledBack.push(message.text); reservation.requestRelease(); },
      };
    });
    const sendAck = vi.fn(() => true);
    const onFlush = createIngressOnFlush<Item>({
      accountId: "acct", outcomeStore: store,
      beginBatch: () => ({ offer, finish: vi.fn() }),
      sendAck, sendInboundRejected: vi.fn(() => true),
    });

    await onFlush(entries);
    expect(store.lookup).toHaveBeenCalledTimes(2);
    expect(store.record).toHaveBeenCalledTimes(2);
    expect(offer).toHaveBeenCalledTimes(2);
    expect(prefixWrite.write.commit).toHaveBeenCalledTimes(1);
    expect(committed).toEqual(["prefix"]);
    expect(rolledBack).toEqual(["unknown"]);
    expect(sendAck).toHaveBeenCalledWith("p", ["prefix"]);
    expect(budget.usage()).toEqual({ messages: 0, bytes: 0 });
  });

  it("treats overload-record unknown as a FIFO barrier without touching the suffix", async () => {
    const budget = new InboundRetentionBudget();
    const token = budget.createSessionToken();
    const entries = ["prefix", "overflow", "suffix"].map((id) => {
      const reserved = budget.tryReserve(token, 1, "debounce-inflight");
      if (reserved.status !== "accepted") throw new Error("unexpected rejection");
      return {
        item: item("p", id, id), id, reservation: reserved.reservation,
        isActive: () => true, isCancellationRequested: () => false,
        isRetired: () => false, waitForCancellation: async () => {},
      };
    });
    const store = {
      peek: vi.fn(),
      lookup: vi.fn()
        .mockResolvedValueOnce({ status: "found", outcome: "accepted" })
        .mockResolvedValueOnce({ status: "not-found" }),
      record: vi.fn(async () => ({ status: "unknown", error: new Error("disk") })),
      forget: vi.fn(), hotSize: vi.fn(), rollbackRecoverySize: vi.fn(),
    } as unknown as IngressOutcomeStore;
    const offer = vi.fn(() => ({ status: "rejected" as const, reason: "session-byte-count" as const }));
    const sendAck = vi.fn(() => true);
    const sendRejected = vi.fn(() => true);
    const onFlush = createIngressOnFlush<Item>({
      accountId: "acct", outcomeStore: store,
      beginBatch: () => ({ offer, finish: vi.fn() }),
      sendAck, sendInboundRejected: sendRejected,
    });

    await onFlush(entries);
    expect(store.lookup).toHaveBeenCalledTimes(2);
    expect(store.record).toHaveBeenCalledTimes(1);
    expect(offer).toHaveBeenCalledTimes(1);
    expect(sendAck).toHaveBeenCalledWith("p", ["prefix"]);
    expect(sendRejected).not.toHaveBeenCalled();
    expect(budget.usage()).toEqual({ messages: 0, bytes: 0 });
  });

  it("pins a cancelled provisional lease while clearing pre-existing committed pending work", async () => {
    let finishRunning!: () => void;
    const running = new Promise<void>((resolve) => { finishRunning = resolve; });
    const handled: string[] = [];
    const budget = new InboundRetentionBudget({
      maxMessagesPerSession: 8,
      maxBytesPerSession: 8,
      maxMessagesPerProcess: 8,
      maxBytesPerProcess: 8,
    });
    const token = budget.createSessionToken();
    const dispatcher = createSerializedInboundDispatcher<UserMessageLike>(
      async (_peerId, message) => {
        handled.push(message.text);
        if (message.text === "running") await running;
      },
      { coalesce: coalesceUserMessages, budget, sessionToken: () => token, measure: () => 1 },
    );
    expect(dispatcher.dispatch("p", { type: "user_message", text: "running", id: "run" })).toBe("accepted");
    await Promise.resolve();

    const prior = budget.tryReserve(token, 1, "pending");
    if (prior.status !== "accepted") throw new Error("unexpected prior rejection");
    expect(dispatcher.dispatch(
      "p",
      { type: "user_message", text: "pre-existing", id: "prior" },
      prior.reservation,
    )).toBe("accepted");
    expect(dispatcher.pendingBuffered("p")).toBe(1);

    let finishNormalRecord!: (value: ReturnType<typeof recordedOutcome>["result"]) => void;
    const normalRecord = new Promise<ReturnType<typeof recordedOutcome>["result"]>((resolve) => {
      finishNormalRecord = resolve;
    });
    let finishCancellationAck!: () => void;
    const cancellationAck = new Promise<void>((resolve) => { finishCancellationAck = resolve; });
    const normalWrite = recordedOutcome();
    const cancellationWrite = recordedOutcome();
    const sendCancelledAck = vi.fn((_peerId: string, _ids: string[]) => true);
    const store = {
      peek: vi.fn(),
      lookup: vi.fn(async () => ({ status: "not-found" as const })),
      record: vi.fn()
        .mockImplementationOnce(() => normalRecord)
        .mockResolvedValueOnce(cancellationWrite.result),
      forget: vi.fn(), hotSize: vi.fn(),
    } as unknown as IngressOutcomeStore;
    const onFlush = createIngressOnFlush<Item>({
      accountId: "acct",
      outcomeStore: store,
      beginBatch: (peerId) => dispatcher.beginBatch(peerId),
      sendAck: () => true,
      sendInboundRejected: () => true,
    });
    const debouncer = createBoundedInboundDebouncer<Item>({
      debounceMs: 0,
      buildKey: (value) => value.peerId,
      sessionToken: () => token,
      budget,
      measure: () => 1,
      getId: (value) => value.message.id,
      onFlush,
      onCancel: async (entries) => {
        for (const entry of entries) {
          const key = `${entry.item.peerId}:${entry.id}`;
          const result = await store.record("acct", key, "accepted", { replaceOpposite: true });
          if (result.status === "recorded") result.write.commit();
        }
        await cancellationAck;
        sendCancelledAck("p", entries.map((entry) => entry.id!));
      },
    });
    expect(debouncer.push(item("p", "cancelled", "target"))).toEqual({ status: "accepted" });
    await vi.waitFor(() => expect(store.record).toHaveBeenCalledTimes(1));
    expect(budget.usage()).toEqual({ messages: 2, bytes: 2 });

    expect(debouncer.cancelKey("p", { notify: true })).toBe(true);
    const dropped = dispatcher.clearPending("p");
    expect(dropped.map((message) => message.text).sort()).toEqual(["cancelled", "pre-existing"]);
    // The ordinary pending item releases immediately; the cancelled item stays
    // charged even though clearPending requested release on its open lease.
    expect(budget.usage()).toEqual({ messages: 1, bytes: 1 });
    await vi.waitFor(() => expect(store.record).toHaveBeenCalledTimes(2));
    finishNormalRecord(normalWrite.result);
    await vi.waitFor(() => expect(normalWrite.write.rollback).toHaveBeenCalledTimes(1));
    expect(budget.usage()).toEqual({ messages: 1, bytes: 1 });
    expect(sendCancelledAck).not.toHaveBeenCalled();

    finishCancellationAck();
    await vi.waitFor(() => expect(budget.usage()).toEqual({ messages: 0, bytes: 0 }));
    expect(cancellationWrite.write.commit).toHaveBeenCalledTimes(1);
    expect(sendCancelledAck).toHaveBeenCalledWith("p", ["target"]);
    finishRunning();
    await Promise.resolve();
    expect(handled).toEqual(["running"]);
  });

  it("offers, records accepted, commits, then ACKs without a reservation gap", async () => {
    const events: string[] = [];
    const budget = new InboundRetentionBudget();
    const token = budget.createSessionToken();
    const reserved = budget.tryReserve(token, 1, "debounce-inflight");
    if (reserved.status !== "accepted") throw new Error("unexpected rejection");
    const store = {
      peek: vi.fn(),
      lookup: vi.fn(async () => ({ status: "not-found" })),
      record: vi.fn(async () => {
        events.push("record");
        const value = recordedOutcome();
        value.write.commit.mockImplementation(() => { events.push("write-commit"); });
        return value.result;
      }),
      forget: vi.fn(), hotSize: vi.fn(),
    } as unknown as IngressOutcomeStore;
    const onFlush = createIngressOnFlush<{
      peerId: string;
      message: { id?: string; type: string; text: string };
    }>({
      accountId: "acct", outcomeStore: store,
      beginBatch: () => ({
        offer: (_message, reservation) => {
          events.push("offer"); reservation!.transfer("pending");
          return {
            status: "accepted" as const,
            commit: () => { events.push("commit"); reservation!.release(); },
            rollback: () => reservation!.release(),
          };
        },
        finish: () => events.push("finish"),
      }),
      sendAck: (_peer, ids) => { events.push(`ack:${ids.join(",")}`); return true; },
      sendInboundRejected: () => true,
    });
    await onFlush([{
      item: { peerId: "p", message: { id: "i", type: "user_message", text: "x" } },
      id: "i", reservation: reserved.reservation, isActive: () => true,
      isCancellationRequested: () => false,
      isRetired: () => false,
      waitForCancellation: async () => {},
    }]);
    expect(events).toEqual(["offer", "record", "write-commit", "commit", "ack:i", "finish"]);
    expect(budget.usage()).toEqual({ messages: 0, bytes: 0 });
  });

  it("does not record, dispatch, or publish after teardown invalidates a stalled lookup", async () => {
    let resolveLookup!: (value: { status: "not-found" }) => void;
    const lookup = new Promise<{ status: "not-found" }>((resolve) => { resolveLookup = resolve; });
    let active = true;
    const budget = new InboundRetentionBudget();
    const token = budget.createSessionToken();
    const reserved = budget.tryReserve(token, 1, "debounce-inflight");
    if (reserved.status !== "accepted") throw new Error("unexpected rejection");
    const store = {
      peek: vi.fn(),
      lookup: vi.fn(() => lookup),
      record: vi.fn(),
      forget: vi.fn(),
      hotSize: vi.fn(),
    } as unknown as IngressOutcomeStore;
    const offer = vi.fn();
    const sendAck = vi.fn(() => true);
    const sendRejected = vi.fn(() => true);
    const onFlush = createIngressOnFlush<{
      peerId: string;
      message: { id?: string; type: string; text: string };
    }>({
      accountId: "acct",
      outcomeStore: store,
      beginBatch: () => ({ offer, finish: vi.fn() }),
      sendAck,
      sendInboundRejected: sendRejected,
    });
    const pending = onFlush([{
      item: { peerId: "p", message: { id: "i", type: "user_message", text: "x" } },
      id: "i",
      reservation: reserved.reservation,
      isActive: () => active,
      isCancellationRequested: () => false,
      isRetired: () => false,
      waitForCancellation: async () => {},
    }]);
    active = false;
    reserved.reservation.release();
    resolveLookup({ status: "not-found" });
    await pending;

    expect(offer).not.toHaveBeenCalled();
    expect(store.record).not.toHaveBeenCalled();
    expect(sendAck).not.toHaveBeenCalled();
    expect(sendRejected).not.toHaveBeenCalled();
    expect(budget.usage()).toEqual({ messages: 0, bytes: 0 });
  });

  it("preserves a cancellation-owned accepted marker when a normal write settles late", async () => {
    let finishRecord!: (value: any) => void;
    const record = new Promise<any>((resolve) => { finishRecord = resolve; });
    let active = true;
    let cancelled = false;
    const budget = new InboundRetentionBudget();
    const token = budget.createSessionToken();
    const reserved = budget.tryReserve(token, 1, "debounce-inflight");
    if (reserved.status !== "accepted") throw new Error("unexpected rejection");
    const store = {
      peek: vi.fn(),
      lookup: vi.fn(async () => ({ status: "not-found" })),
      record: vi.fn(() => record),
      forget: vi.fn(async () => true),
      hotSize: vi.fn(),
    } as unknown as IngressOutcomeStore;
    const rollback = vi.fn(() => reserved.reservation.release());
    const commit = vi.fn();
    const sendAck = vi.fn(() => true);
    const onFlush = createIngressOnFlush<{
      peerId: string;
      message: { id?: string; type: string; text: string };
    }>({
      accountId: "acct",
      outcomeStore: store,
      beginBatch: () => ({
        offer: () => ({ status: "accepted" as const, commit, rollback }),
        finish: vi.fn(),
      }),
      sendAck,
      sendInboundRejected: vi.fn(() => true),
    });
    const pending = onFlush([{
      item: { peerId: "p", message: { id: "i", type: "user_message", text: "x" } },
      id: "i",
      reservation: reserved.reservation,
      isActive: () => active,
      isCancellationRequested: () => cancelled,
      isRetired: () => false,
      waitForCancellation: async () => {},
    }]);
    await Promise.resolve();
    await Promise.resolve();
    active = false;
    cancelled = true;
    const late = recordedOutcome();
    finishRecord(late.result);
    await pending;

    expect(rollback).toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
    expect(late.write.rollback).toHaveBeenCalledTimes(1);
    expect(store.forget).not.toHaveBeenCalledWith("acct", "p:i", "accepted");
    expect(sendAck).not.toHaveBeenCalled();
    expect(budget.usage()).toEqual({ messages: 0, bytes: 0 });
  });

  it("does not ACK or dispatch a replay while an invalidated accepted write awaits rollback cleanup", async () => {
    const acceptedValues = new Set<string>();
    const overloadedValues = new Set<string>();
    const scoped = (key: string, options?: { namespace?: string }) =>
      `${options?.namespace}:${key}`;
    const disk = new Error("rollback delete failed");
    let failDelete = true;
    let invalidateOnRecord = true;
    let active = true;
    const accepted = {
      hasRecent: vi.fn(async (key: string, options?: { namespace?: string }) =>
        acceptedValues.has(scoped(key, options))),
      checkAndRecord: vi.fn(async (key: string, options?: { namespace?: string }) => {
        const value = scoped(key, options);
        const fresh = !acceptedValues.has(value);
        acceptedValues.add(value);
        if (invalidateOnRecord) active = false;
        return fresh;
      }),
      forget: vi.fn(async (key: string, options?: {
        namespace?: string;
        onDiskError?: (error: unknown) => void;
      }) => {
        if (failDelete) {
          options?.onDiskError?.(disk);
          return false;
        }
        return acceptedValues.delete(scoped(key, options));
      }),
    } as unknown as PersistentDedupe;
    const overloaded = {
      hasRecent: vi.fn(async (key: string, options?: { namespace?: string }) =>
        overloadedValues.has(scoped(key, options))),
      checkAndRecord: vi.fn(async (key: string, options?: { namespace?: string }) => {
        const value = scoped(key, options);
        const fresh = !overloadedValues.has(value);
        overloadedValues.add(value);
        return fresh;
      }),
      forget: vi.fn(async (key: string, options?: { namespace?: string }) =>
        overloadedValues.delete(scoped(key, options))),
    } as unknown as PersistentDedupe;
    const outcomeStore = createIngressOutcomeStore({ accepted, overloaded });
    let dispatches = 0;
    const offer = vi.fn((_message: Item["message"], reservation?: {
      release(): void;
    }) => ({
      status: "accepted" as const,
      commit: vi.fn(() => { dispatches++; reservation?.release(); }),
      rollback: vi.fn(() => reservation?.release()),
    }));
    const sendAck = vi.fn(() => true);
    const sendRejected = vi.fn(() => true);
    const onFlush = createIngressOnFlush<Item>({
      accountId: "acct",
      outcomeStore,
      beginBatch: () => ({ offer, finish: vi.fn() }),
      sendAck,
      sendInboundRejected: sendRejected,
    });
    const replay = async () => {
      active = true;
      const budget = new InboundRetentionBudget();
      const token = budget.createSessionToken();
      const reserved = budget.tryReserve(token, 1, "debounce-inflight");
      if (reserved.status !== "accepted") throw new Error("unexpected rejection");
      await onFlush([{
        item: item("p", "payload", "i"),
        id: "i",
        reservation: reserved.reservation,
        isActive: () => active,
        isCancellationRequested: () => false,
        isRetired: () => !active,
        waitForCancellation: async () => {},
      }]);
      expect(budget.usage()).toEqual({ messages: 0, bytes: 0 });
    };

    // Accepted persistence wins, then teardown invalidates the generation. Its
    // rollback delete fails: the offer is rolled back and no result is emitted.
    await replay();
    expect(acceptedValues.has("acct:p:i")).toBe(true);
    expect(outcomeStore.peek("acct", "p:i")).toBeUndefined();
    expect(outcomeStore.rollbackRecoverySize()).toMatchObject({ entries: 1, poisoned: false });
    expect(dispatches).toBe(0);
    expect(sendAck).not.toHaveBeenCalled();
    expect(sendRejected).not.toHaveBeenCalled();

    // A same-process cold replay retries exact cleanup. While disk deletion is
    // still failing it remains unknown: no ACK, rejection, offer, or dispatch.
    invalidateOnRecord = false;
    await replay();
    expect(offer).toHaveBeenCalledTimes(1);
    expect(dispatches).toBe(0);
    expect(sendAck).not.toHaveBeenCalled();
    expect(sendRejected).not.toHaveBeenCalled();

    // Once deletion recovers, lookup becomes not-found and this replay receives
    // a genuinely fresh accepted classification, admission, dispatch, and ACK.
    failDelete = false;
    await replay();
    expect(outcomeStore.rollbackRecoverySize()).toEqual({ entries: 0, bytes: 0, poisoned: false });
    expect(offer).toHaveBeenCalledTimes(2);
    expect(dispatches).toBe(1);
    expect(sendAck).toHaveBeenCalledWith("p", ["i"]);
    expect(sendRejected).not.toHaveBeenCalled();
  });

  it("production outcome branch suppresses fallback replays through record/ACK failure and recovery", async () => {
    const fallback = new CancelledInboundFallbackTombstones();
    fallback.add("p:i", "acct");
    const store = {
      peek: vi.fn(),
      lookup: vi.fn(),
      record: vi.fn()
        .mockResolvedValueOnce({ status: "unknown", error: new Error("disk") })
        .mockResolvedValueOnce(recordedOutcome().result),
      forget: vi.fn(async () => true),
      hotSize: vi.fn(),
    } as unknown as IngressOutcomeStore;
    const offer = vi.fn();
    const sendAck = vi.fn(() => true);
    const beginBatch = vi.fn(() => ({ offer, finish: vi.fn() }));
    const onFlush = createIngressOnFlush<{
      peerId: string;
      message: { id?: string; type: string; text: string };
    }>({
      accountId: "acct",
      outcomeStore: store,
      beginBatch,
      sendAck,
      sendInboundRejected: vi.fn(() => true),
      cancelledFallback: fallback,
    });

    for (let attempt = 0; attempt < 2; attempt++) {
      const budget = new InboundRetentionBudget();
      const token = budget.createSessionToken();
      const reserved = budget.tryReserve(token, 1, "debounce-inflight");
      if (reserved.status !== "accepted") throw new Error("unexpected rejection");
      await onFlush([{
        item: { peerId: "p", message: { id: "i", type: "user_message", text: "killed" } },
        id: "i",
        reservation: reserved.reservation,
        isActive: () => true,
        isCancellationRequested: () => false,
        isRetired: () => false,
        waitForCancellation: async () => {},
      }]);
      expect(budget.usage()).toEqual({ messages: 0, bytes: 0 });
      expect(fallback.has("p:i", "acct")).toBe(attempt === 0);
      expect(sendAck).toHaveBeenCalledTimes(attempt);
    }

    expect(store.lookup).not.toHaveBeenCalled();
    expect(offer).not.toHaveBeenCalled();
    expect(store.record).toHaveBeenCalledTimes(2);
    expect(store.record).toHaveBeenNthCalledWith(2, "acct", "p:i", "accepted", {
      replaceOpposite: true,
    });
    expect(sendAck).toHaveBeenCalledWith("p", ["i"]);
  });
});
