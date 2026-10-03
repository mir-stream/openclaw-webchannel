import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createPersistentDedupe } from "openclaw/plugin-sdk/persistent-dedupe";
import { openDeliveryJournal } from "./delivery-journal.js";
import { createIngressOutcomeStore } from "./ingress-outcome.js";
import { createIngressOnFlush } from "./ingress-dedupe.js";
import { createDispatchRecovery } from "./dispatch-recovery.js";
import { createStopControl } from "./stop-control.js";
import { DEFAULT_BUSY_TURN_LIMITS, InboundRetentionBudget } from "./inbound-retention.js";
import { coalesceUserMessages, createSerializedInboundDispatcher, type UserMessageLike } from "./inbound-queue.js";

const cleanup: Array<() => void> = [];
beforeEach(() => vi.useFakeTimers());
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); vi.restoreAllMocks(); vi.useRealTimers(); });
const item = (id: string, logical = id) => ({ peerId: "peer", message: { type: "user_message" as const, id, random_id: logical, text: logical } });
function open(path?: string, capacity = 32, hold?: Promise<void>) {
  if (!path) {
    path = mkdtempSync(join(tmpdir(), "accept-debounce-"));
    const root = path;
    cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  }
  const persistent = (namespacePrefix: string) => createPersistentDedupe({ pluginId: "webchannel", namespacePrefix, ttlMs: 60_000, memoryMaxSize: 100, stateMaxEntries: 100, env: { ...process.env, OPENCLAW_STATE_DIR: path } });
  const outcomeStore = createIngressOutcomeStore({ accepted: persistent("accepted"), overloaded: persistent("overloaded"), cancelled: persistent("cancelled") });
  const journal = openDeliveryJournal({ databasePath: join(path, "journal.sqlite") });
  const budget = new InboundRetentionBudget({ ...DEFAULT_BUSY_TURN_LIMITS, maxMessagesPerSession: capacity });
  const runs: UserMessageLike[] = [];
  const acks: Array<{ ids: string[]; committed?: unknown; cancelled?: string[]; unaccepted?: string[] }> = [];
  const broadcasts: Array<{ id: string; text: string; seq: number }> = [];
  const rejected: string[][] = [];
  const recovery = createDispatchRecovery({ store: journal.dispatch!, acquirePeer: () => () => {}, isActive: () => true,
    notify: () => {}, warn: e => { throw e; }, dispatcherOptions: { budget, debounceMs: 1000 },
    handler: async (_peer, message, settle) => { runs.push(message); if (message.id === "A") await hold; settle("ok"); },
  });
  recovery.start();
  const sendAck = (_peer: string, ids: string[], committed?: unknown, cancelled?: string[], unaccepted?: string[]) => { acks.push({ ids, committed, cancelled, unaccepted }); return true; };
  const flush = createIngressOnFlush<ReturnType<typeof item>>({ accountId: "account", outcomeStore, deliveryJournal: journal,
    dispatchRecovery: recovery, beginBatch: peer => recovery.beginBatch(peer), sendAck,
    sendUserCommitted: (_peer, message) => { broadcasts.push(message); return true; },
    sendInboundRejected: (_peer, ids) => { rejected.push(ids); return true; },
  });
  const stop = createStopControl<{ peerId: string; message: UserMessageLike }>({ journal, recovery, sendAck, debouncer: { retainedItems: () => [], cancelKey: () => false },
    pendingOverflowKey: () => undefined, retireOverflow: () => {}, dispatchControl: async () => {}, isActive: () => true, warn: e => { throw e; },
  });
  let closed = false;
  const close = () => { if (closed) return; closed = true; recovery.dispose(); journal.close(); };
  cleanup.push(close);
  return { path, journal, budget, recovery, runs, acks, broadcasts, rejected, flush, stop, close };
}

it("#441 persists and echoes each input before execution debounce; replay cannot postpone the turn", async () => {
  const h = open();
  await h.flush([item("A")]);
  const rowA = h.journal.dispatch!.lookup("peer", "A")!;
  expect(rowA.state).toBe("queued");
  expect(h.acks[0].committed).toEqual([{ random_id: "A", messageId: rowA.messageId, seq: rowA.seq }]);
  expect(h.broadcasts).toEqual([expect.objectContaining({ id: rowA.messageId, seq: rowA.seq, text: "A" })]);
  expect(h.runs).toEqual([]);
  await vi.advanceTimersByTimeAsync(500);
  await h.flush([item("B")]);
  expect(h.broadcasts).toHaveLength(2);
  expect(h.journal.read("peer").filter(event => event.kind === "user")).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(400);
  await h.flush([item("A-replay", "A")]);
  expect(h.broadcasts).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(599);
  expect(h.runs).toEqual([]);
  await vi.advanceTimersByTimeAsync(1);
  expect(h.runs).toEqual([expect.objectContaining({ text: "A\n\nB", coalescedIds: ["A", "B"] })]);
  expect(h.budget.usage()).toEqual({ messages: 0, bytes: 0 });
});

it("#441 stop cancels an accepted debounce row without declaring it unaccepted, including replay/restart", async () => {
  const h = open();
  await h.flush([item("A")]);
  expect(h.runs).toEqual([]);
  const accepted = h.acks[0].committed;
  h.stop.handle({ peerId: "peer", message: { ...item("stop").message, text: "/stop", cancel_pending: [{ id: "A", random_id: "A" }] } }, true);
  expect(h.journal.dispatch!.lookup("peer", "A")?.state).toBe("cancelled");
  expect(h.acks.every(ack => !ack.unaccepted?.includes("A"))).toBe(true);
  await vi.advanceTimersByTimeAsync(1000);
  expect(h.runs).toEqual([]);
  expect(h.budget.usage().messages).toBe(0);
  h.close();
  const cold = open(h.path);
  await cold.flush([item("A")]);
  expect(cold.acks.at(-1)).toMatchObject({ committed: accepted, cancelled: ["A"], unaccepted: undefined });
  await vi.advanceTimersByTimeAsync(1000);
  expect(cold.runs).toEqual([]);
});

it("#441 recovers accepted unstarted debounce input with its original server ID", async () => {
  const h = open();
  await h.flush([item("A")]);
  expect(h.runs).toEqual([]);
  const accepted = h.acks[0].committed;
  h.close();
  const cold = open(h.path);
  await cold.flush([item("A")]);
  expect(cold.acks[0].committed).toEqual(accepted);
  expect(cold.broadcasts).toEqual([]);
  await vi.advanceTimersByTimeAsync(1000);
  expect(cold.runs.map(m => m.text)).toEqual(["A"]);
  expect(cold.journal.dispatch!.lookup("peer", "A")?.state).toBe("completed");
});

it("#441 retains bounded capacity during debounce and tail-rejects without accepting overflow", async () => {
  const h = open(undefined, 2);
  await h.flush([item("A")]); await h.flush([item("B")]); await h.flush([item("C")]);
  expect(h.runs).toEqual([]);
  expect(h.budget.usage().messages).toBe(2);
  expect(h.rejected).toEqual([["C"]]);
  expect(h.journal.dispatch!.lookup("peer", "C")).toBeUndefined();
  expect(h.acks.map(a => a.ids)).toEqual([["A"], ["B"]]);
  await vi.advanceTimersByTimeAsync(1000);
  expect(h.runs.map(m => m.text)).toEqual(["A\n\nB"]);
});

it("#441 a failed journal acceptance never ACKs, broadcasts or arms execution", async () => {
  const h = open();
  vi.spyOn(h.recovery, "accept").mockImplementationOnce(() => { throw new Error("storage fault"); });
  await h.flush([item("A")]);
  expect(h.acks).toEqual([]); expect(h.broadcasts).toEqual([]);
  await vi.advanceTimersByTimeAsync(1000);
  expect(h.runs).toEqual([]);
  await h.flush([item("A")]);
  expect(h.acks).toHaveLength(1);
  expect(h.runs).toEqual([]);
  await vi.advanceTimersByTimeAsync(1000);
  expect(h.runs).toHaveLength(1);
});

it("#441 busy followups wait for both the current turn and their own quiet interval", async () => {
  let release!: () => void;
  const h = open(undefined, 32, new Promise<void>(resolve => { release = resolve; }));
  await h.flush([item("A")]);
  await vi.advanceTimersByTimeAsync(1000);
  expect(h.runs.map(m => m.id)).toEqual(["A"]);
  await h.flush([item("B")]);
  await vi.advanceTimersByTimeAsync(500);
  await h.flush([item("C")]);
  release();
  await vi.advanceTimersByTimeAsync(999);
  expect(h.runs.map(m => m.id)).toEqual(["A"]);
  await vi.advanceTimersByTimeAsync(1);
  expect(h.runs.map(m => m.text)).toEqual(["A", "B\n\nC"]);
});

it("#441 empty/rolled-back leases cannot extend debounce, and an open lease still fences execution", async () => {
  const runs: string[] = [];
  const d = createSerializedInboundDispatcher<UserMessageLike>(async (_peer, m) => { runs.push(m.text); }, { coalesce: coalesceUserMessages, debounceMs: 1000 });
  cleanup.push(() => d.dispose());
  d.dispatch("peer", item("A").message);
  await vi.advanceTimersByTimeAsync(900);
  const lease = d.beginBatch("peer");
  const offer = lease.offer(item("rollback").message);
  if (offer.status !== "accepted") throw new Error("unexpected offer");
  offer.rollback();
  await vi.advanceTimersByTimeAsync(100);
  expect(runs).toEqual([]);
  lease.finish();
  await vi.advanceTimersByTimeAsync(0);
  expect(runs).toEqual(["A"]);
  expect(d.pendingSessions()).toBe(0);
});

it("#441 cancelling one peer or disposing releases timer/budget ownership without disturbing another peer", async () => {
  const runs: string[] = [];
  const budget = new InboundRetentionBudget();
  const d = createSerializedInboundDispatcher<UserMessageLike>(async (_peer, m) => { runs.push(m.text); }, { coalesce: coalesceUserMessages, debounceMs: 1000, budget });
  cleanup.push(() => d.dispose());
  d.dispatch("one", item("A").message); d.dispatch("two", item("B").message);
  await vi.advanceTimersByTimeAsync(500);
  expect(d.clearPending("one").map(m => m.id)).toEqual(["A"]);
  expect(budget.usage().messages).toBe(1);
  await vi.advanceTimersByTimeAsync(500);
  expect(runs).toEqual(["B"]);
  d.dispatch("two", item("C").message);
  expect(d.dispose()).toEqual({ pending: 1, provisional: 0 });
  expect(budget.usage()).toEqual({ messages: 0, bytes: 0 });
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(1000);
  expect(runs).toEqual(["B"]);
});

it("#441 production resolves execution debounce but puts no timed delay before durable admission", () => {
  const source = readFileSync(new URL("./nats-account-runtime.ts", import.meta.url), "utf8");
  expect(source).toMatch(/dispatcherOptions: \{[^}]*debounceMs: inboundDebounceMs/);
  expect(source).toMatch(/createBoundedInboundDebouncer<DebounceItem>\(\{\s*debounceMs: 0,/);
});
