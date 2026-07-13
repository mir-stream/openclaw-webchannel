import { describe, it, expect, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { createInboundDebouncer } from "openclaw/plugin-sdk/reply-runtime";
import { createPersistentDedupe } from "openclaw/plugin-sdk/persistent-dedupe";

import {
  filterFreshInboundItems,
  createIngressOnFlush,
} from "./ingress-dedupe.js";
import { coalesceUserMessages, type UserMessageLike } from "./inbound-queue.js";

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
      const composite = `${opts?.namespace ?? "global"}\u0000${key}`;
      if (seen.has(composite)) return false;
      seen.add(composite);
      return true;
    },
  );
  return { checkAndRecord, calls };
}

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
