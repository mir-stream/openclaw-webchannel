/**
 * v6 #239 half 3 — the INBOUND ACCEPT seam.
 *
 * Doc §15.7: the plugin is the ONLY SSOT for user messages, so a durable journal
 * write is a HARD REQUIREMENT of accepting one. A user message that is not in
 * the journal was not accepted. That makes this seam the deliberate MIRROR IMAGE
 * of the egress seam covered by `nats-channel-delivery-journal.test.ts`: there a
 * journal failure must never change the send result (the text has already left
 * for the client — refusing would lose delivered text, N10); here a journal
 * failure IS an accept failure, because nothing has been confirmed to anyone yet.
 *
 * What these pin, and why each one is here rather than "obvious":
 *
 *  - ORDER, on ONE interleaved log. The fake journal, the fake ack/publish, the
 *    lease and the outcome writes all record into the SAME array, so
 *    "the append happened before the ack" is a fact about a single sequence
 *    rather than an inference from two spies that a hoisted call would satisfy
 *    just as well.
 *  - THE INVALIDATED BATCH, which is the N6b-shaped inversion and the most
 *    important test in the file. The batch can be rolled back wholesale after
 *    every item has been decided, so a `user` row written at the decision point
 *    would describe a message that never ran — a phantom user bubble in history
 *    that live never showed, N8 in the gaining direction. Its `toEqual([])` is
 *    worthless alone, so it also asserts the specific rollbacks that ran; it was
 *    mutation-proved by moving the hook above the `invalidated` check.
 *  - THAT NOTHING PUBLISHES MID-LOOP. `chunkWriter.add()` is not a buffer — it
 *    flushes at `maxIds` and at the wire limit, and `flush()` publishes — so the
 *    results are held in arrays and only reach a writer in the footer, below the
 *    journal. Two tests drive a low `effectiveOutboundLimit` to force the flush
 *    that would otherwise ack ids the journal then refuses.
 *  - THE TWO EXCEPTIONS to "a refused batch publishes nothing" (the
 *    cancelled-inbound fallback's direct ack, and an id-less item's inline
 *    commit), pinned so the absolute cannot creep back into the comments.
 *  - THE ACCEPT FAILURE expressed with the mechanism the function already has:
 *    no ack, no `inbound_rejected`, offers and outcome writes rolled back,
 *    reservations released — asserted positively, not as an empty array.
 *  - THE TWO KNOWN GAPS (id-less and non-string-text items are ADMITTED and run
 *    but are NOT journaled) surfaced as a warn, because they are live text
 *    history will not have.
 *  - One test against a REAL `openDeliveryJournal`, because nothing else proves
 *    the seam and the store compose.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createIngressOnFlush } from "./ingress-dedupe.js";
import { CancelledInboundFallbackTombstones } from "./ingress-dedupe.js";
import {
  openDeliveryJournal,
  type DeliveryJournal,
  type DeliveryJournalRow,
} from "./delivery-journal.js";
import type { JournalEvent } from "./delivery-journal-event.js";
import type { IngressOutcomeStore, OutcomeLookup } from "./ingress-outcome.js";
import { InboundRetentionBudget } from "./inbound-retention.js";
import type { RetainedDebounceEntry } from "./bounded-inbound-debouncer.js";

const ACCOUNT = "acct";
const PEER = "peer-0";

type Item = {
  peerId: string;
  message: { type: "user_message"; text?: string; id?: string; random_id?: string };
};

/**
 * ONE log for every side of the seam. `append`, `ack`, the lease's
 * commit/rollback and the outcome writes land in the same array in the order
 * they actually happened — the only way to assert journal-BEFORE-ack rather than
 * journal-AND-ack, and the only way to show a rollback ran instead of a commit.
 */
type Call =
  | { call: "append"; conversationId: string; event: JournalEvent }
  | { call: "ack"; ids: string[]; committed?: Array<{ random_id: string; messageId: string; seq: number }> }
  | { call: "rejected"; ids: string[] }
  | { call: "offer-commit"; text: string | undefined }
  | { call: "offer-rollback"; text: string | undefined }
  | { call: "write-commit"; key: string }
  | { call: "write-rollback"; key: string }
  | { call: "warn"; message: string };

const item = (text: string | undefined, id?: string, randomId?: string): Item => ({
  peerId: PEER,
  message: {
    type: "user_message",
    ...(text !== undefined ? { text } : {}),
    ...(id !== undefined ? { id } : {}),
    ...(randomId !== undefined ? { random_id: randomId } : {}),
  },
});

/** Journal stand-in: records appends into the shared log, and can be told to throw. */
class FakeJournal implements DeliveryJournal {
  /** Append number (1-based) that throws; 0 = never. */
  throwOnAppendNumber = 0;
  throwValue: unknown = Object.assign(new Error("database is locked"), {
    code: "ERR_SQLITE_ERROR",
    errcode: 5,
    errstr: "database is locked",
  });
  private appended = 0;
  /** #243 half 2a: idempotency key → {seq, minted server messageId}. */
  private readonly byKey = new Map<string, { seq: number; messageId: string }>();
  constructor(private readonly calls: Call[]) {}
  append(
    conversationId: string,
    event: JournalEvent,
  ): { seq: number; inserted: boolean } {
    this.appended++;
    if (this.appended === this.throwOnAppendNumber) throw this.throwValue;
    this.calls.push({ call: "append", conversationId, event });
    return { seq: this.appended, inserted: true };
  }
  // #243 half 2a: mirror the real store — idempotent on `randomId ?? turnId`
  // (check-first, no append/throw on a replay), mint the durable id from seq
  // (`webchannel-user-<seq>`), log the append, and remember the mapping.
  appendInboundUser(
    conversationId: string,
    input: { text: string; turnId?: string; randomId?: string },
  ): { seq: number; inserted: boolean; messageId: string } {
    const key = input.randomId ?? input.turnId;
    if (key !== undefined) {
      const existing = this.byKey.get(`${conversationId}:${key}`);
      if (existing !== undefined) {
        return { seq: existing.seq, inserted: false, messageId: existing.messageId };
      }
    }
    this.appended++;
    if (this.appended === this.throwOnAppendNumber) throw this.throwValue;
    const seq = this.appended;
    const messageId = `webchannel-user-${seq}`;
    const event: JournalEvent = {
      kind: "user",
      id: messageId,
      text: input.text,
      ...(input.turnId !== undefined ? { turnId: input.turnId } : {}),
    };
    this.calls.push({ call: "append", conversationId, event });
    if (key !== undefined) this.byKey.set(`${conversationId}:${key}`, { seq, messageId });
    return { seq, inserted: true, messageId };
  }
  lookupUserMessageIdByRandomId(
    conversationId: string,
    randomId: string,
  ): { messageId: string; seq: number } | undefined {
    const row = this.byKey.get(`${conversationId}:${randomId}`);
    return row === undefined ? undefined : { messageId: row.messageId, seq: row.seq };
  }
  read(): DeliveryJournalRow[] {
    return [];
  }
  // #244 half A: the high-water is the last seq this fake allocated.
  maxSeq(): number {
    return this.appended;
  }
  close(): void {
    /* no-op */
  }
}

/**
 * A REAL journal that throws on the Nth append and delegates everything else —
 * so a partial batch genuinely lands rows on disk before the refusal, which a
 * fully faked store cannot reproduce.
 */
class FlakyJournal implements DeliveryJournal {
  private appended = 0;
  constructor(
    private readonly inner: DeliveryJournal,
    private readonly throwOnAppendNumber: number,
  ) {}
  append(
    conversationId: string,
    event: JournalEvent,
  ): { seq: number; inserted: boolean } {
    this.appended++;
    if (this.appended === this.throwOnAppendNumber) {
      throw Object.assign(new Error("database is locked"), {
        code: "ERR_SQLITE_ERROR",
        errcode: 5,
        errstr: "database is locked",
      });
    }
    return this.inner.append(conversationId, event);
  }
  appendInboundUser(
    conversationId: string,
    input: { text: string; turnId?: string; randomId?: string },
  ): { seq: number; inserted: boolean; messageId: string } {
    this.appended++;
    if (this.appended === this.throwOnAppendNumber) {
      throw Object.assign(new Error("database is locked"), {
        code: "ERR_SQLITE_ERROR",
        errcode: 5,
        errstr: "database is locked",
      });
    }
    return this.inner.appendInboundUser(conversationId, input);
  }
  lookupUserMessageIdByRandomId(
    conversationId: string,
    randomId: string,
  ): { messageId: string; seq: number } | undefined {
    return this.inner.lookupUserMessageIdByRandomId(conversationId, randomId);
  }
  read(conversationId: string): DeliveryJournalRow[] {
    return this.inner.read(conversationId);
  }
  maxSeq(conversationId: string): number {
    return this.inner.maxSeq(conversationId);
  }
  close(): void {
    this.inner.close();
  }
}

/**
 * The production outcome/lease branch, wired against fakes that all write into
 * one `calls` array. `lookups` decides each key's classification; everything
 * else takes the ordinary fresh-admission path.
 */
function makeSeam(options?: {
  lookups?: Record<string, OutcomeLookup>;
  onLookup?: (key: string) => void;
  cancelledFallback?: CancelledInboundFallbackTombstones;
  journal?: DeliveryJournal | undefined;
  omitJournal?: boolean;
  /** Ids the dispatcher lease REJECTS — the overloaded (`inbound_rejected`) class. */
  overloaded?: readonly string[];
  /** Force the result chunk writers to flush mid-batch. See the finding-1 tests. */
  effectiveOutboundLimit?: number;
}) {
  const calls: Call[] = [];
  const journal = options?.omitJournal
    ? undefined
    : options?.journal ?? new FakeJournal(calls);
  const store = {
    peek: vi.fn(),
    lookup: vi.fn(async (_accountId: string, key: string): Promise<OutcomeLookup> => {
      options?.onLookup?.(key);
      return options?.lookups?.[key] ?? { status: "not-found" };
    }),
    record: vi.fn(async (_accountId: string, key: string, outcome: "accepted" | "overloaded") => ({
      status: "recorded" as const,
      durability: "durable" as const,
      write: {
        outcome,
        created: true,
        durability: "durable" as const,
        commit: () => calls.push({ call: "write-commit", key }),
        rollback: async () => {
          calls.push({ call: "write-rollback", key });
          return true;
        },
      },
    })),
    forget: vi.fn(),
    hotSize: vi.fn(),
    rollbackRecoverySize: vi.fn(),
  } as unknown as IngressOutcomeStore;

  const onFlush = createIngressOnFlush<Item>({
    accountId: ACCOUNT,
    outcomeStore: store,
    beginBatch: () => ({
      offer: (message, reservation) => {
        if (options?.overloaded?.includes(message.id ?? "")) {
          // The real dispatcher never transfers a reservation it refuses.
          return { status: "rejected" as const, reason: "session-byte-count" as const };
        }
        reservation?.transfer("pending");
        return {
          status: "accepted" as const,
          commit: () => {
            calls.push({ call: "offer-commit", text: message.text });
            reservation?.release();
          },
          rollback: () => {
            calls.push({ call: "offer-rollback", text: message.text });
            reservation?.release();
          },
        };
      },
      finish: vi.fn(),
    }),
    sendAck: (_peerId, ids, committed) => {
      calls.push({
        call: "ack",
        ids: [...ids],
        ...(committed && committed.length > 0 ? { committed: committed.map((c) => ({ ...c })) } : {}),
      });
      return true;
    },
    sendInboundRejected: (_peerId, ids) => {
      calls.push({ call: "rejected", ids: [...ids] });
      return true;
    },
    ...(options?.effectiveOutboundLimit !== undefined
      ? { effectiveOutboundLimit: () => options.effectiveOutboundLimit! }
      : {}),
    ...(journal ? { deliveryJournal: journal } : {}),
    ...(options?.cancelledFallback
      ? { cancelledFallback: options.cancelledFallback }
      : {}),
    logWarn: (message) => calls.push({ call: "warn", message }),
  });
  return { calls, journal: journal as FakeJournal, store, onFlush };
}

/** A retained entry with a controllable lifecycle fence and a real reservation. */
function retained(
  budget: InboundRetentionBudget,
  token: ReturnType<InboundRetentionBudget["createSessionToken"]>,
  value: Item,
  isActive: () => boolean = () => true,
): RetainedDebounceEntry<Item> {
  const reserved = budget.tryReserve(token, 1, "debounce-inflight");
  if (reserved.status !== "accepted") throw new Error("unexpected rejection");
  return {
    item: value,
    reservation: reserved.reservation,
    ...(value.message.id !== undefined ? { id: value.message.id } : {}),
    isActive,
    isCancellationRequested: () => false,
    isRetired: () => false,
    waitForCancellation: async () => {},
  };
}

const kinds = (calls: Call[]) => calls.map((entry) => entry.call);
const appends = (calls: Call[]) =>
  calls.filter((entry): entry is Extract<Call, { call: "append" }> =>
    entry.call === "append");
const warns = (calls: Call[]) =>
  calls.filter((entry): entry is Extract<Call, { call: "warn" }> =>
    entry.call === "warn");

describe("#239 — the inbound accept journals before it acks", () => {
  it("appends the user event BEFORE the ack reaches the wire", async () => {
    const { calls, onFlush } = makeSeam();

    await onFlush([item("hello", "u-1")]);

    // ONE interleaved sequence, asserted whole: the append is first and the ack
    // is last. Moving the hook below the footer's result block reorders exactly
    // this array.
    expect(calls).toEqual([
      {
        call: "append",
        conversationId: PEER,
        // conversationId === peerId (doc §16.2-7). #243 half 2a: the durable `id`
        // is now SERVER-MINTED (`webchannel-user-<seq>`), NOT the wire id; `turnId`
        // stays the wire id — see the mirror argument below.
        event: { kind: "user", id: "webchannel-user-1", text: "hello", turnId: "u-1" },
      },
      { call: "write-commit", key: `${PEER}:u-1` },
      { call: "offer-commit", text: "hello" },
      { call: "ack", ids: ["u-1"] },
    ]);
    // `turnId` is this message's OWN wire id — the client's
    // `nextPublishedUserMessages` stamps exactly that on its live user bubble,
    // and `inbound.ts` derives the plugin's turn id from `message.id` too. The
    // durable `id` is the server mint, distinct from both.
    expect(appends(calls)[0]!.event).toMatchObject({ id: "webchannel-user-1", turnId: "u-1" });
  });

  it("writes ONE row per accepted item, in arrival order — never one coalesced row", async () => {
    const { calls, onFlush } = makeSeam();

    await onFlush([item("first", "u-1"), item("second", "u-2"), item("third", "u-3")]);

    // P1-8b collapses the batch into ONE turn carrying the LAST frame's id, but
    // the client drew three user bubbles. Three rows is what makes history equal
    // live (N8).
    expect(appends(calls).map((entry) => entry.event)).toEqual([
      { kind: "user", id: "webchannel-user-1", text: "first", turnId: "u-1" },
      { kind: "user", id: "webchannel-user-2", text: "second", turnId: "u-2" },
      { kind: "user", id: "webchannel-user-3", text: "third", turnId: "u-3" },
    ]);
    // …and every append precedes the single ack frame.
    expect(kinds(calls).lastIndexOf("append")).toBeLessThan(
      kinds(calls).indexOf("ack"),
    );
  });

  it("publishes NO result frame mid-loop, even when the chunk writer flushes eagerly", async () => {
    // `createIngressResultChunkWriter.add()` is NOT a buffer: it flushes at
    // `maxIds` and again when the next id would exceed the effective wire limit,
    // and `flush()` publishes. `effectiveOutboundLimit: 30` fits exactly one id
    // per `ack` frame, so under an in-loop `add` this batch publishes acks for
    // u-1 and u-2 BEFORE the journal has written anything.
    const { calls, onFlush } = makeSeam({ effectiveOutboundLimit: 30 });

    await onFlush([item("first", "u-1"), item("second", "u-2"), item("third", "u-3")]);

    // The limit really did chunk — three separate frames, not one. Without this
    // the test would pass vacuously if the limit stopped taking effect.
    expect(calls.filter((entry) => entry.call === "ack")).toEqual([
      { call: "ack", ids: ["u-1"] },
      { call: "ack", ids: ["u-2"] },
      { call: "ack", ids: ["u-3"] },
    ]);
    // …and EVERY append still precedes the FIRST ack, on the one interleaved log.
    expect(kinds(calls).lastIndexOf("append")).toBeLessThan(
      kinds(calls).indexOf("ack"),
    );
  });

  it("loses nothing when the journal fails after the chunk writer would have flushed", async () => {
    // The data-loss scenario behind the test above, run end to end: an ack
    // published mid-loop drains the client's unacked ledger, so a batch rolled
    // back afterwards is user text that is never replayed and never journaled.
    const seam = makeSeam({ effectiveOutboundLimit: 30 });
    seam.journal.throwOnAppendNumber = 1;

    await seam.onFlush([item("first", "u-1"), item("second", "u-2"), item("third", "u-3")]);

    expect(seam.calls).not.toContainEqual(
      expect.objectContaining({ call: "ack" }),
    );
    expect(kinds(seam.calls).filter((kind) => kind === "offer-rollback")).toHaveLength(3);
  });

  it("journals NOTHING and acks NOTHING when the batch is invalidated after the accepts", async () => {
    // THE N6b-SHAPED INVERSION. `/stop` or peer retirement invalidates an
    // already-accepted offer while a LATER item is still awaiting its lookup.
    // Everything the batch decided is then rolled back — so a row written at the
    // decision point would describe a message that never ran.
    const budget = new InboundRetentionBudget();
    const token = budget.createSessionToken();
    let firstStillActive = true;
    const seam = makeSeam({
      // Processing the SECOND item retires the first one's generation.
      onLookup: (key) => {
        if (key === `${PEER}:u-2`) firstStillActive = false;
      },
    });
    const entries = [
      retained(budget, token, item("first", "u-1"), () => firstStillActive),
      retained(budget, token, item("second", "u-2")),
    ];

    await seam.onFlush(entries);

    expect(appends(seam.calls)).toEqual([]);
    // `toEqual([])` alone proves nothing — an early return anywhere above the
    // guard would satisfy it. These say WHY nothing was journaled: the batch
    // really did reach the footer and really did roll back.
    expect(kinds(seam.calls)).toEqual([
      "write-rollback",
      "write-rollback",
      "offer-rollback",
      "offer-rollback",
    ]);
    expect(seam.calls).not.toContainEqual(
      expect.objectContaining({ call: "ack" }),
    );
    expect(seam.store.record).toHaveBeenCalledTimes(2);
    expect(budget.usage()).toEqual({ messages: 0, bytes: 0 });
  });

  it("re-acks an already-accepted outcome WITHOUT appending a second row", async () => {
    // A replay of a message admitted — and journaled — earlier. Re-journaling it
    // would be a no-op on `journal_user_once` and would only add a second call
    // site; the ack still has to go out so the client's ledger entry drains.
    const { calls, onFlush } = makeSeam({
      lookups: { [`${PEER}:u-1`]: { status: "found", outcome: "accepted" } },
    });

    await onFlush([item("hello", "u-1")]);

    expect(appends(calls)).toEqual([]);
    // Positive: the replay really did take the found/accepted branch — it acked,
    // and it never offered or recorded anything.
    expect(calls).toEqual([{ call: "ack", ids: ["u-1"] }]);
  });

  it("acks the cancelled-inbound fallback WITHOUT appending", async () => {
    // Text `/stop` already KILLED. A durable row for it would be history showing
    // what live killed.
    const fallback = new CancelledInboundFallbackTombstones();
    fallback.add(`${PEER}:u-1`, ACCOUNT);
    const { calls, onFlush } = makeSeam({ cancelledFallback: fallback });

    await onFlush([item("/stop-killed text", "u-1")]);

    expect(appends(calls)).toEqual([]);
    // Positive: the fallback branch is the one that ran — it committed the
    // replacement outcome write and acked, and never offered the item.
    expect(calls).toEqual([
      { call: "write-commit", key: `${PEER}:u-1` },
      { call: "ack", ids: ["u-1"] },
    ]);
    expect(fallback.has(`${PEER}:u-1`, ACCOUNT)).toBe(false);
  });

  it("admits an id-less item, does NOT journal it, and warns once", async () => {
    // KNOWN GAP: the item runs and the client shows its bubble, but there is no
    // id to key a durable row on. Two id-less items in one batch produce ONE
    // warn — the sink is rate-limited because this is peer-driven at full
    // ingress rate.
    const { calls, onFlush } = makeSeam();

    await onFlush([item("no id here"), item("nor here")]);

    expect(appends(calls)).toEqual([]);
    // Positive: both items really were ADMITTED (that is the gap), and the
    // reason is named.
    expect(calls.filter((entry) => entry.call === "offer-commit")).toHaveLength(2);
    expect(warns(calls)).toHaveLength(1);
    expect(warns(calls)[0]!.message).toContain("admitted but NOT journaled");
    expect(warns(calls)[0]!.message).toContain("reason=no-usable-id");
    expect(warns(calls)[0]!.message).toContain("issue-243");
    expect(warns(calls)[0]!.message).toContain("suppressed=0");
  });

  it("admits an item whose text is not a string, does NOT journal it, and warns", async () => {
    // The other half of the same gap. `normalizeInboundUserMessage` copies
    // `raw.text` unvalidated off a frame decoded with a cast, so a non-string
    // genuinely arrives; the shared reducer types `user.text` as `string`, so a
    // row holding one is a durable row no reader can render.
    const { calls, onFlush } = makeSeam();
    const malformed = item(undefined, "u-1");
    (malformed.message as { text?: unknown }).text = 42;

    await onFlush([malformed]);

    expect(appends(calls)).toEqual([]);
    expect(calls.filter((entry) => entry.call === "ack")).toEqual([
      { call: "ack", ids: ["u-1"] },
    ]);
    expect(warns(calls)[0]!.message).toContain("reason=non-string-text");
  });

  it("does not report a non-string-text gap for a batch that is rolled back", async () => {
    // The gap claim is "live shows this, history will not". A batch the footer
    // rolls back never ran, so there is no live bubble to be missing — which is
    // why the text is validated in the footer and not at the collection site.
    const budget = new InboundRetentionBudget();
    const token = budget.createSessionToken();
    let firstStillActive = true;
    const seam = makeSeam({
      onLookup: (key) => {
        if (key === `${PEER}:u-2`) firstStillActive = false;
      },
    });
    const malformed = item(undefined, "u-1");
    (malformed.message as { text?: unknown }).text = 42;
    const entries = [
      retained(budget, token, malformed, () => firstStillActive),
      retained(budget, token, item("second", "u-2")),
    ];

    await seam.onFlush(entries);

    expect(warns(seam.calls)).toEqual([]);
    // Positive: the batch really was rolled back, i.e. we reached the branch
    // where a collection-site warn would already have fired.
    expect(kinds(seam.calls)).toEqual([
      "write-rollback",
      "write-rollback",
      "offer-rollback",
      "offer-rollback",
    ]);
  });

  it("does not warn about unjournalable items when no journal is wired at all", async () => {
    // Without a journal nothing is journaled, so an id-less item is not a gap
    // specific to that item — the warn would be pure noise on the test surface.
    const { calls, onFlush } = makeSeam({ omitJournal: true });

    await onFlush([item("no id here")]);

    expect(warns(calls)).toEqual([]);
    expect(calls.filter((entry) => entry.call === "offer-commit")).toHaveLength(1);
  });
});

describe("#239 — a journal failure is an ACCEPT failure (doc §15.7)", () => {
  it("refuses the accept: no ack, no inbound_rejected, offers and writes rolled back", async () => {
    const budget = new InboundRetentionBudget();
    const token = budget.createSessionToken();
    const seam = makeSeam();
    seam.journal.throwOnAppendNumber = 1;
    const entries = [
      retained(budget, token, item("first", "u-1")),
      retained(budget, token, item("second", "u-2")),
    ];

    // Nothing escapes `onFlush` as a rejection. The debouncer's worker swallows
    // a rejected flush with NO log, so an escaping throw would roll the batch
    // back silently and lose the only line explaining the refusal.
    await expect(seam.onFlush(entries)).resolves.toBeUndefined();

    expect(appends(seam.calls)).toEqual([]);
    // Positive, not an empty array: the batch reached the footer, the journal
    // refused it, and the ROLLBACKS ran. A hook that logged and continued would
    // show `write-commit`/`offer-commit`/`ack` here instead.
    expect(kinds(seam.calls)).toEqual([
      "warn",
      "write-rollback",
      "write-rollback",
      "offer-rollback",
      "offer-rollback",
    ]);
    expect(seam.calls).not.toContainEqual(
      expect.objectContaining({ call: "ack" }),
    );
    expect(seam.calls).not.toContainEqual(
      expect.objectContaining({ call: "rejected" }),
    );
    // Reservations really were released, not merely un-committed.
    expect(budget.usage()).toEqual({ messages: 0, bytes: 0 });

    const warn = warns(seam.calls)[0]!.message;
    expect(warn).toContain("delivery journal append failed at the inbound accept");
    expect(warn).toContain(`peer="${PEER}"`);
    expect(warn).toContain("journalable=2");
    expect(warn).toContain("action=reject-accept-client-retries");
    // The value-free status the shared `journalFailureDiagnostic` extracts —
    // never the free-form message, never message text.
    expect(warn).toContain('code="ERR_SQLITE_ERROR"');
    expect(warn).toContain("errcode=5");
    expect(warn).not.toContain("first");
    expect(warn).not.toContain("second");
  });

  it("rolls back the OVERLOADED item too, and suppresses its inbound_rejected", async () => {
    // Before this slice `rollbackBatch()` was reachable only by an escaping
    // exception; the journal-failure `return` makes it a routine path, so the
    // branch that only the OVERLOADED class exercises — `deferredReleases` —
    // needs a test that can actually produce one. Nothing else in this file can:
    // the lease used to accept everything.
    //
    // It also forces a decision worth stating: A's journal failure suppresses
    // B's rejection notice and rolls back B's outcome write. That is deliberate.
    // The batch is ONE peer's debounce window and it retries WHOLE — the same
    // rule the `invalidated` branch already applies — so publishing a partial
    // verdict would leave the client holding an `inbound_rejected` for an id
    // whose durable classification we just undid.
    const budget = new InboundRetentionBudget();
    const token = budget.createSessionToken();
    const seam = makeSeam({ overloaded: ["u-2"] });
    seam.journal.throwOnAppendNumber = 1;
    const entries = [
      retained(budget, token, item("accepted", "u-1")),
      retained(budget, token, item("refused", "u-2")),
    ];

    await seam.onFlush(entries);

    // The overloaded item really was classified — its outcome write exists and
    // is rolled back, not merely absent.
    expect(seam.calls).toContainEqual({ call: "write-rollback", key: `${PEER}:u-2` });
    expect(seam.calls).toContainEqual({ call: "write-rollback", key: `${PEER}:u-1` });
    expect(seam.calls).not.toContainEqual(
      expect.objectContaining({ call: "rejected" }),
    );
    expect(seam.calls).not.toContainEqual(
      expect.objectContaining({ call: "ack" }),
    );
    // The overloaded item's reservation is released ONLY by `rollbackBatch`'s
    // `deferredReleases` loop — the accepted item's rides on its offer rollback.
    // Deleting that loop leaves this at `{ messages: 1, bytes: 1 }`.
    expect(budget.usage()).toEqual({ messages: 0, bytes: 0 });
    expect(warns(seam.calls)[0]!.message).toContain("journalable=1");
  });

  it("does NOT unwind the cancelled-inbound fallback's ack — the one result that outruns the journal", async () => {
    // EXCEPTION 1 to "a refused batch publishes nothing". The fallback branch
    // commits its outcome write and calls `deps.sendAck` DIRECTLY, inside the
    // item loop, bypassing the chunk writers entirely — so a result frame does
    // reach the wire before the journal runs, and neither it nor its write is
    // undone by `rollbackBatch()`.
    //
    // Correct, and left alone deliberately: the item is text `/stop` already
    // KILLED. It is not a fresh admission, it has no durable row to lose, and
    // its ack is what stops the client replaying a dead message forever.
    const fallback = new CancelledInboundFallbackTombstones();
    fallback.add(`${PEER}:u-0`, ACCOUNT);
    const seam = makeSeam({ cancelledFallback: fallback });
    seam.journal.throwOnAppendNumber = 1;

    await seam.onFlush([item("killed", "u-0"), item("fresh", "u-1")]);

    expect(seam.calls).toEqual([
      { call: "write-commit", key: `${PEER}:u-0` },
      // …on the wire, before the journal was ever consulted.
      { call: "ack", ids: ["u-0"] },
      { call: "warn", message: expect.stringContaining("append failed") },
      { call: "write-rollback", key: `${PEER}:u-1` },
      { call: "offer-rollback", text: "fresh" },
    ]);
    // The fresh item — the only one this seam is the SSOT for — is fully undone.
    expect(seam.calls).not.toContainEqual(
      expect.objectContaining({ call: "ack", ids: ["u-1"] }),
    );
  });

  it("does NOT roll back an id-less item's offer — it still runs the turn", async () => {
    // EXCEPTION 2 to the same absolute. The id-less branch calls `offer.commit()`
    // INLINE and never pushes a rollback onto `rollbackOffers`, so on a refused
    // batch that entry survives; `inbound-queue.ts`'s `finish()` then promotes
    // every `committed` entry to `attached` and drains it. The item runs.
    //
    // Also correct: only a non-conforming client produces an id-less frame, and
    // refusing to run text we already accepted for dispatch would lose it
    // outright. It is exactly the case `journalGap` reports.
    const seam = makeSeam();
    seam.journal.throwOnAppendNumber = 1;

    await seam.onFlush([item("no id here"), item("fresh", "u-1")]);

    expect(seam.calls).toContainEqual({ call: "offer-commit", text: "no id here" });
    expect(seam.calls).not.toContainEqual({ call: "offer-rollback", text: "no id here" });
    // …while the id-carrying sibling is rolled back.
    expect(seam.calls).toContainEqual({ call: "offer-rollback", text: "fresh" });
  });

  it("rolls the whole batch back even when an EARLIER append in it succeeded", async () => {
    // The partial-write case. It is safe because of what the CALLER does: the
    // client replays an unacked `user_message` under the SAME id, so the row
    // already committed comes back as an `inserted: false` no-op rather than a
    // duplicate bubble. (`nats-client.ts` `flushQueue()` re-queues
    // `entry.message` from the ledger keyed by that id, and `retryDueUnacked()`
    // re-publishes the same entry in-session.) The real-journal test below
    // exercises that no-op end to end.
    const seam = makeSeam();
    seam.journal.throwOnAppendNumber = 2;

    await seam.onFlush([item("first", "u-1"), item("second", "u-2")]);

    // The first append happened inside the store; this seam still refuses the
    // ENTIRE batch rather than acking a prefix.
    expect(seam.calls).not.toContainEqual(
      expect.objectContaining({ call: "ack" }),
    );
    expect(kinds(seam.calls).filter((kind) => kind === "offer-rollback")).toHaveLength(2);
    expect(warns(seam.calls)[0]!.message).toContain("journalable=2");
  });

  it("does not report a non-string-text gap for a batch the APPEND then refuses", async () => {
    // Same claim as the `invalidated` sibling above ("live shows this, history
    // will not"), on the OTHER return that abandons a batch: that test pins the
    // rollback-on-invalidation path, this one pins the append-failure path. A
    // refused batch never ran, so its malformed item has no live bubble for
    // history to be missing — which is why the `non-string-text` lines are
    // emitted only after the append loop has committed, not while `journalable`
    // is being built. (`no-usable-id` still reports from the item loop, because
    // that item runs even when the batch is refused.)
    const seam = makeSeam();
    seam.journal.throwOnAppendNumber = 1;
    const malformed = item(undefined, "u-2");
    (malformed.message as { text?: unknown }).text = 42;

    await seam.onFlush([item("first", "u-1"), malformed]);

    // Positive on both halves: the gap line is ABSENT…
    expect(
      warns(seam.calls).filter((entry) =>
        entry.message.includes("admitted but NOT journaled")),
    ).toHaveLength(0);
    // …and the batch really did reach the append-failure return. `journalable=1`
    // shows the malformed item was filtered out of this 2-item batch; "admits an
    // item whose text is not a string" is what pins WHICH item was filtered.
    const refusals = warns(seam.calls).filter((entry) =>
      entry.message.includes("delivery journal append failed at the inbound accept"));
    expect(refusals).toHaveLength(1);
    expect(refusals[0]!.message).toContain("journalable=1");
    expect(seam.calls).not.toContainEqual(expect.objectContaining({ call: "ack" }));
  });
});

describe("#239 — the accept seam against a REAL delivery journal", () => {
  const dirs: string[] = [];
  const openIn = (): { journal: DeliveryJournal; dir: string } => {
    const dir = mkdtempSync(join(tmpdir(), "wc-accept-journal-"));
    dirs.push(dir);
    return {
      journal: openDeliveryJournal({ databasePath: join(dir, "journal.db") }),
      dir,
    };
  };
  afterEach(() => {
    while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  it("stores each accepted message under the peerId, readable back in arrival order", async () => {
    const { journal } = openIn();
    try {
      const { calls, onFlush } = makeSeam({ journal });

      await onFlush([item("first", "u-1"), item("second", "u-2")]);

      expect(calls).toContainEqual({ call: "ack", ids: ["u-1", "u-2"] });
      const rows = journal.read(PEER);
      expect(rows.map((row) => row.event)).toEqual([
        { kind: "user", id: "webchannel-user-1", text: "first", turnId: "u-1" },
        { kind: "user", id: "webchannel-user-2", text: "second", turnId: "u-2" },
      ]);
      expect(rows.map((row) => row.seq)).toEqual([1, 2]);
      expect(rows.every((row) => row.kind === "user")).toBe(true);
    } finally {
      journal.close();
    }
  });

  it("a same-id replay after a genuinely REFUSED partial batch is an idempotent no-op", async () => {
    const { journal } = openIn();
    try {
      // Round 1, the refusal: `u-1` really does land in the REAL store, then the
      // second append throws, so the footer refuses the whole batch and nothing
      // is acked. That is the partial-write state the seam's comment claims is
      // recoverable — this is the test that actually produces it.
      const flaky = new FlakyJournal(journal, 2);
      const first = makeSeam({ journal: flaky });
      await first.onFlush([item("first", "u-1"), item("second", "u-2")]);

      expect(first.calls).not.toContainEqual(
        expect.objectContaining({ call: "ack" }),
      );
      expect(kinds(first.calls).filter((kind) => kind === "offer-rollback")).toHaveLength(2);
      // The partial row is on disk — exactly the state that has to be safe.
      expect(journal.read(PEER).map((row) => row.seq)).toEqual([1]);

      // Round 2: the client replays BOTH under the SAME ids (what `flushQueue()`
      // and `retryDueUnacked()` both do), against a healthy store.
      const second = makeSeam({ journal });
      await second.onFlush([item("first", "u-1"), item("second", "u-2")]);

      expect(second.calls).toContainEqual({ call: "ack", ids: ["u-1", "u-2"] });
      const rows = journal.read(PEER);
      // TWO rows, not three: the replayed `u-1` collapsed onto its existing row.
      // #243 half 2a: the collapse now works via `appendInboundUser`'s
      // idempotency on the STABLE key (here the wire id `u-1`, since these items
      // carry no `random_id`) rather than the old `journal_user_once`-on-wire-id —
      // the durable id is server-minted, so `u-1`'s replay finds seq 1 and mints
      // no second id. (See the `random_id`-carrying test for the conforming path.)
      expect(rows.map((row) => row.event)).toEqual([
        { kind: "user", id: "webchannel-user-1", text: "first", turnId: "u-1" },
        { kind: "user", id: "webchannel-user-2", text: "second", turnId: "u-2" },
      ]);
    } finally {
      journal.close();
    }
  });

  it("refuses the accept when the REAL store is unusable", async () => {
    const { journal } = openIn();
    // A closed handle is the `ERR_INVALID_STATE` shape half 2 measured.
    journal.close();
    const seam = makeSeam({ journal });

    await expect(seam.onFlush([item("first", "u-1")])).resolves.toBeUndefined();

    expect(seam.calls).not.toContainEqual(
      expect.objectContaining({ call: "ack" }),
    );
    expect(kinds(seam.calls)).toContain("offer-rollback");
    expect(warns(seam.calls)[0]!.message).toContain(
      "delivery journal append failed at the inbound accept",
    );
  });
});

describe("#243 half 2a — the server assigns the durable user id and echoes it", () => {
  const dirs: string[] = [];
  const openIn = (): { journal: DeliveryJournal } => {
    const dir = mkdtempSync(join(tmpdir(), "wc-243-journal-"));
    dirs.push(dir);
    return { journal: openDeliveryJournal({ databasePath: join(dir, "journal.db") }) };
  };
  afterEach(() => {
    while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  const ackOf = (calls: Call[]): Extract<Call, { call: "ack" }> => {
    const ack = calls.find((entry) => entry.call === "ack");
    if (!ack || ack.call !== "ack") throw new Error("no ack frame emitted");
    return ack;
  };

  it("journals a fresh message under a SERVER id (not the wire id) and echoes it on the ack", async () => {
    const { journal } = openIn();
    try {
      const { calls, onFlush } = makeSeam({ journal });

      await onFlush([item("hello", "u-1", "r-1")]);

      // Durable id is the server mint; `turnId` is the wire id; #337 also carries
      // the client `random_id` in the payload (a distinct field) for the client's
      // difference-fold adopt-by-random_id.
      expect(journal.read(PEER).map((row) => row.event)).toEqual([
        { kind: "user", id: "webchannel-user-1", text: "hello", turnId: "u-1", randomId: "r-1" },
      ]);
      // The ack carries the random_id → server messageId mapping.
      expect(ackOf(calls)).toEqual({
        call: "ack",
        ids: ["u-1"],
        // #244 half A: the echo also carries the user message's seq (its only
        // wire carrier — the user opener rides no durable frame).
        committed: [{ random_id: "r-1", messageId: "webchannel-user-1", seq: 1 }],
      });
    } finally {
      journal.close();
    }
  });

  it("a deduped retry (same random_id) echoes the SAME server id and writes no second row", async () => {
    const { journal } = openIn();
    try {
      // First admission: minted and journaled under the server id.
      const first = makeSeam({ journal });
      await first.onFlush([item("hello", "u-1", "r-1")]);
      expect(ackOf(first.calls).committed).toEqual([
        { random_id: "r-1", messageId: "webchannel-user-1", seq: 1 },
      ]);
      expect(journal.read(PEER).map((row) => row.seq)).toEqual([1]);

      // The retry is caught by the outcome store (found/accepted) BEFORE any
      // re-append — the seam must recover and re-echo the FIRST id, and must NOT
      // mint a fresh one or write a second row.
      const second = makeSeam({
        journal,
        // key is `${PEER}:${random_id}` (ingressDedupeKey uses the random_id body).
        lookups: { [`${PEER}:r-1`]: { status: "found", outcome: "accepted" } },
      });
      await second.onFlush([item("hello", "u-1", "r-1")]);

      expect(ackOf(second.calls)).toEqual({
        call: "ack",
        ids: ["u-1"],
        // The retry re-echoes the SAME first-admission seq, never a fresh one.
        committed: [{ random_id: "r-1", messageId: "webchannel-user-1", seq: 1 }],
      });
      // Still exactly one row — the SAME id, no duplicate.
      expect(journal.read(PEER).map((row) => row.event)).toEqual([
        { kind: "user", id: "webchannel-user-1", text: "hello", turnId: "u-1", randomId: "r-1" },
      ]);
    } finally {
      journal.close();
    }
  });

  it("a partial-write replay that reaches the append is idempotent on the random_id", async () => {
    // The #283 partial-batch case, now with a conforming client: round 1 lands
    // one row then the batch is refused (outcome rolled back), so round 2's retry
    // is NOT caught by the outcome store and reaches `appendInboundUser` again.
    // Its idempotency on the random_id is what prevents a duplicate now that the
    // durable id is server-minted (the old `journal_user_once`-on-wire-id net is
    // gone). It also re-echoes the same server id.
    const { journal } = openIn();
    try {
      const flaky = new FlakyJournal(journal, 2);
      const round1 = makeSeam({ journal: flaky });
      await round1.onFlush([item("first", "u-1", "r-1"), item("second", "u-2", "r-2")]);
      expect(round1.calls).not.toContainEqual(expect.objectContaining({ call: "ack" }));
      expect(journal.read(PEER).map((row) => row.seq)).toEqual([1]);

      // Round 2 against the healthy store: fresh path (outcome not-found), so
      // `appendInboundUser` runs for both — and `r-1` finds its existing row.
      const round2 = makeSeam({ journal });
      await round2.onFlush([item("first", "u-1", "r-1"), item("second", "u-2", "r-2")]);

      expect(journal.read(PEER).map((row) => row.event)).toEqual([
        { kind: "user", id: "webchannel-user-1", text: "first", turnId: "u-1", randomId: "r-1" },
        { kind: "user", id: "webchannel-user-2", text: "second", turnId: "u-2", randomId: "r-2" },
      ]);
      // The ack re-echoes BOTH, `r-1` under its already-minted id.
      expect(ackOf(round2.calls).committed).toEqual(
        expect.arrayContaining([
          { random_id: "r-1", messageId: "webchannel-user-1", seq: 1 },
          { random_id: "r-2", messageId: "webchannel-user-2", seq: 2 },
        ]),
      );
    } finally {
      journal.close();
    }
  });
});
