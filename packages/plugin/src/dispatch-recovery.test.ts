import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createPersistentDedupe } from "openclaw/plugin-sdk/persistent-dedupe";
import { openDeliveryJournal } from "./delivery-journal.js";
import { createIngressOutcomeStore } from "./ingress-outcome.js";
import { createIngressOnFlush } from "./ingress-dedupe.js";
import { createDispatchRecovery } from "./dispatch-recovery.js";
import { projectJournalHistory } from "./journal-history.js";
import { DEFAULT_BUSY_TURN_LIMITS, InboundRetentionBudget } from "./inbound-retention.js";
import type { UserMessageLike } from "./inbound-queue.js";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });
const message = (id: string, peerId = "RawPeer", text = id) => ({ peerId, message: { type: "user_message" as const, id, random_id: `logical-${id}`, text } });
const dirFor = () => { const dir = mkdtempSync(join(tmpdir(), "dispatch369-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true })); return dir; };
function open(dir = dirFor(), options: { hold?: Promise<void>; fail?: string; budget?: InboundRetentionBudget; key?: boolean } = {}) {
  const persistent = (namespacePrefix: string) => createPersistentDedupe({ pluginId: "webchannel", namespacePrefix, ttlMs: 60_000, memoryMaxSize: 100, stateMaxEntries: 100, env: { ...process.env, OPENCLAW_STATE_DIR: dir } });
  const store = createIngressOutcomeStore({ accepted: persistent("accepted"), overloaded: persistent("overloaded"), cancelled: persistent("cancelled") });
  const journal = openDeliveryJournal({ databasePath: join(dir, "journal.sqlite") });
  const runs: UserMessageLike[] = [];
  const acks: Array<{ ids: string[]; committed: unknown }> = [];
  const changes: unknown[] = [];
  const errors: unknown[] = [];
  const recovery = createDispatchRecovery({ store: journal.dispatch!, handler: async (peer, m, settle) => {
    expect(peer).toBe("RawPeer"); runs.push(m);
    if (m.id === "A") await options.hold;
    if (options.fail !== undefined && options.fail === m.id) throw new Error("injected after effect");
    journal.append(peer, { kind: "bubble", answerId: `answer-${m.id}`, text: `result ${m.text}`, turnId: m.id });
    settle("ok");
  }, acquirePeer: () => options.key === false ? undefined : () => {}, notify: c => changes.push(c), isActive: () => true, warn: e => errors.push(e), dispatcherOptions: { budget: options.budget } });
  recovery.start();
  const flush = createIngressOnFlush<{ peerId: string; message: UserMessageLike }>({ accountId: "ExactAccount", outcomeStore: store, deliveryJournal: journal, dispatchRecovery: recovery, beginBatch: p => recovery.beginBatch(p), sendAck: (_, ids, committed) => { acks.push({ ids, committed }); return true; } });
  const close = () => { recovery.dispose(); journal.close(); };
  cleanup.push(close);
  return { dir, journal, recovery, store, runs, acks, changes, errors, flush, close };
}

it("recovers B automatically behind interrupted A, preserving IDs and recorded output across repeated recovery", async () => {
  const h = open(undefined, { hold: new Promise(() => {}) });
  await h.flush([message("A")]); await h.flush([message("B")]);
  expect(h.runs.map(m => m.id)).toEqual(["A"]);
  const row = h.journal.dispatch!.lookup("RawPeer", "logical-B")!;
  h.close();
  const fresh = open(h.dir);
  await vi.waitFor(() => expect(fresh.runs.map(m => m.id)).toEqual(["B"]));
  expect(fresh.journal.dispatch!.lookup("RawPeer", "logical-B")).toMatchObject({ messageId: row.messageId, seq: row.seq, state: "completed" });
  expect(fresh.journal.dispatch!.lookup("RawPeer", "logical-A")?.state).toBe("interrupted");
  expect(projectJournalHistory(fresh.journal.read, "RawPeer").messages).toEqual(expect.arrayContaining([expect.objectContaining({ id: "webchannel-user-1", requestState: "interrupted" }), expect.objectContaining({ id: "answer-B", text: "result B" })]));
  fresh.close();
  const again = open(h.dir);
  await again.flush([message("A"), message("B")]);
  expect(again.runs).toEqual([]);
  expect(again.acks.at(-1)?.committed).toEqual(expect.arrayContaining([expect.objectContaining({ messageId: row.messageId, seq: row.seq })]));
});

it("a failed start fence cannot execute; durable queued work is retried when storage recovers", async () => {
  const h = open();
  const claim = vi.spyOn(h.journal.dispatch!, "claim").mockImplementationOnce(() => { throw new Error("fence unavailable"); });
  await h.flush([message("B")]);
  expect(h.runs).toEqual([]);
  expect(h.journal.dispatch!.lookup("RawPeer", "logical-B")?.state).toBe("queued");
  await vi.waitFor(() => expect(h.runs).toHaveLength(1));
  expect(claim).toHaveBeenCalledTimes(2);
});

it("stop suppresses the scheduled-before-handler boundary and every merged member across restart", async () => {
  const h = open();
  const accept = h.recovery.accept.bind(h.recovery);
  vi.spyOn(h.recovery, "accept").mockImplementation((...args) => {
    const result = accept(...args);
    h.recovery.cancel("RawPeer");
    return result;
  });
  await h.flush([message("A"), message("B"), message("C")]);
  expect(h.runs).toEqual([]);
  for (const id of ["A", "B", "C"]) expect(h.journal.dispatch!.lookup("RawPeer", `logical-${id}`)?.state).toBe("cancelled");
  h.close();
  const fresh = open(h.dir);
  await fresh.flush([message("A"), message("B"), message("C")]);
  expect(fresh.runs).toEqual([]);
});

it("stale owners cannot start, settle, or overwrite a replacement's state", async () => {
  let release!: () => void;
  const h = open(undefined, { hold: new Promise(resolve => { release = resolve; }) });
  await h.flush([message("A")]);
  const oldOwner = h.journal.dispatch!.lookup("RawPeer", "logical-A")!.owner!;
  const fresh = open(h.dir);
  expect(() => h.journal.dispatch!.claim(oldOwner, "RawPeer", ["logical-A"])).toThrow("retired");
  release(); await new Promise(setImmediate);
  expect(fresh.journal.dispatch!.lookup("RawPeer", "logical-A")?.state).toBe("interrupted");
  expect(h.changes).toEqual([expect.objectContaining({ state: "started" })]);
});

it("history without lifecycle and expired markers never manufactures unstarted proof", async () => {
  const h = open();
  const row = h.journal.appendInboundUser("RawPeer", { text: "old", turnId: "B", randomId: "logical-B" });
  await h.flush([message("B")]);
  expect(h.runs).toEqual([]);
  expect(h.journal.dispatch!.lookup("RawPeer", "logical-B")).toBeUndefined();
  expect(h.acks[0].committed).toEqual([{ random_id: "logical-B", messageId: row.messageId, seq: row.seq }]);
});

it("preserves id-less legacy dispatch through the new wrapper", async () => {
  const h = open();
  await h.flush([{ peerId: "RawPeer", message: { type: "user_message", text: "legacy" } }]);
  expect(h.runs.map(m => m.text)).toEqual(["legacy"]);
  expect(h.journal.dispatch!.peers()).toEqual([]);
});

it("does not execute with a missing exact-peer key and retains queued work", async () => {
  const h = open(undefined, { key: false });
  await h.flush([message("B")]);
  expect(h.runs).toEqual([]);
  expect(h.journal.dispatch!.lookup("RawPeer", "logical-B")?.state).toBe("queued");
});

it("failed handler effects become durable interrupted work and are never automatically repeated", async () => {
  const h = open(undefined, { fail: "B" });
  await h.flush([message("B")]); await new Promise(setImmediate);
  expect(h.runs).toHaveLength(1);
  expect(h.journal.dispatch!.lookup("RawPeer", "logical-B")?.state).toBe("interrupted");
  h.close(); const fresh = open(h.dir); await fresh.flush([message("B")]);
  expect(fresh.runs).toEqual([]);
});

it("intentional retry is a new request with provenance; original transport replays remain suppressed", async () => {
  const h = open(undefined, { fail: "B" });
  await h.flush([message("B")]); await new Promise(setImmediate);
  const old = h.journal.dispatch!.lookup("RawPeer", "logical-B")!;
  await h.flush([{ ...message("retry"), message: { ...message("retry").message, text: "B", retry_of: old.messageId } }]);
  expect(h.runs.map(m => m.id)).toEqual(["B", "retry"]);
  expect(h.journal.dispatch!.lookup("RawPeer", "logical-retry")?.input.retryOf).toBe(old.messageId);
  await h.flush([message("B")]); expect(h.runs).toHaveLength(2);
});

it("atomically rolls back user rows and recoverable payloads when a later batch insert fails", async () => {
  const h = open();
  const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
  const db = new DatabaseSync(join(h.dir, "journal.sqlite"));
  cleanup.push(() => db.close());
  db.exec("CREATE TRIGGER refuse_second BEFORE INSERT ON journal_dispatch WHEN NEW.logical_key='logical-B' BEGIN SELECT RAISE(ABORT, 'injected dispatch insert failure'); END");
  await h.flush([message("A"), message("B")]);
  expect(h.runs).toEqual([]); expect(h.acks).toEqual([]);
  expect(h.journal.read("RawPeer")).toEqual([]);
  expect(h.journal.dispatch!.queued("RawPeer")).toEqual([]);
  db.exec("DROP TRIGGER refuse_second");
  await h.flush([message("A"), message("B")]);
  expect(h.runs.map(m => m.text)).toEqual(["A\n\nB"]);
});

it("materialized history updates an existing user row to interrupted after a warm started snapshot", async () => {
  const h = open(undefined, { hold: new Promise(() => {}) });
  await h.flush([message("A")]);
  const page = () => {
    for (let i = 0; i < 100; i++) {
      const result = h.journal.historyPage!("RawPeer", { kind: "recent", limit: 50 });
      if (!result.pending) return result;
    }
    throw new Error("history did not converge");
  };
  expect(page().messages).toContainEqual(expect.objectContaining({ requestState: "started" }));
  h.journal.dispatch!.recoverInterrupted(h.journal.dispatch!.activate());
  expect(page().messages).toContainEqual(expect.objectContaining({ id: "webchannel-user-1", requestState: "interrupted" }));
});

it("recovery honors the shared admission budget and drains a backlog in order", async () => {
  const h = open(undefined, { key: false });
  await h.flush([message("A"), message("B"), message("C")]); h.close();
  const budget = new InboundRetentionBudget({ ...DEFAULT_BUSY_TURN_LIMITS, maxMessagesPerSession: 1, maxMessagesPerProcess: 1 });
  const fresh = open(h.dir, { budget });
  await vi.waitFor(() => expect(fresh.runs).toHaveLength(3));
  expect(fresh.runs.map(m => m.id)).toEqual(["A", "B", "C"]);
  expect(budget.usage().messages).toBe(0);
});

it("refuses future dispatch schemas before modifying their metadata", () => {
  const h = open(); h.close();
  const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
  const path = join(h.dir, "journal.sqlite");
  const db = new DatabaseSync(path); cleanup.push(() => db.close());
  db.prepare("UPDATE journal_meta SET value='999' WHERE key='dispatch_schema_version'").run();
  const schema = db.prepare("SELECT sql FROM sqlite_master ORDER BY name").all();
  expect(() => openDeliveryJournal({ databasePath: path })).toThrow("unsupported dispatch schema");
  expect(db.prepare("SELECT sql FROM sqlite_master ORDER BY name").all()).toEqual(schema);
  expect(db.prepare("SELECT value FROM journal_meta WHERE key='dispatch_schema_version'").get()).toMatchObject({ value: "999" });
});


it.each([false, true])("keeps every legacy member in a mixed batch in original order: legacy first=%s", async first => {
  const h = open();
  const legacy = { peerId: "RawPeer", message: { type: "user_message" as const, text: "legacy C" } };
  await h.flush(first ? [legacy, message("B")] : [message("B"), legacy]);
  expect(h.runs.map(m => m.text)).toEqual([first ? "legacy C\n\nB" : "B\n\nlegacy C"]);
  expect(h.journal.dispatch!.lookup("RawPeer", "logical-B")?.state).toBe("completed");
});

it("stop in the mixed batch's pre-handler gap suppresses legacy and tracked members", async () => {
  const h = open();
  const accept = h.recovery.accept.bind(h.recovery);
  vi.spyOn(h.recovery, "accept").mockImplementation((...args) => {
    const result = accept(...args); h.recovery.cancel("RawPeer"); return result;
  });
  await h.flush([message("B"), { peerId: "RawPeer", message: { type: "user_message", text: "legacy C" } }]);
  expect(h.runs).toEqual([]);
});
