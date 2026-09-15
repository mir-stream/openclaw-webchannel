import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { openDeliveryJournal } from "./delivery-journal.js";
import { projectJournalHistory } from "./journal-history.js";
import { createProgressDraftController } from "./message-adapter.js";
import { createHistoryServer } from "./history-serve.js";
import { DEFAULT_HISTORY_CONFIG } from "./history.js";
import { generateKeyPair } from "./e2e-crypto.js";
import * as sessionCrypto from "./e2e-session.js";
import { openEnvelope } from "./e2e-session.js";
import { createClawMessageAdapter, createReasoningDraftController } from "./message-adapter.js";
import { NatsChannel } from "./nats-channel.js";
import type { NatsTransport } from "./nats-transport.js";
import { reduceDurableView } from "../../client/src/durable-view-reducer.js";
import type { JournalEvent } from "./delivery-journal-event.js";
import { journalEventForOutbound } from "./delivery-journal-event.js";
import type { OutboundWsMessage } from "./channel-contract.js";

const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); vi.restoreAllMocks(); });

function setup(options?: { encrypted?: boolean; reasoningDurable?: boolean }) {
  const dir = mkdtempSync(join(tmpdir(), "durable-send-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const databasePath = join(dir, "journal.sqlite");
  const journal = openDeliveryJournal({ databasePath });
  cleanup.push(() => journal.close());
  const db = new DatabaseSync(databasePath);
  cleanup.push(() => db.close());
  const transport = Object.assign(new EventEmitter(), {
    connected: true, subscribe: () => 1, unsubscribe: () => {},
    publish: vi.fn(), effectiveOutboundLimit: 1_000_000,
  });
  const key = new Uint8Array(32).fill(7);
  const channel = new NatsChannel(transport as unknown as NatsTransport, "acct", "tenant",
    options?.encrypted ? { keyStore: { getOrCreate: () => key } as never, identityKeyPair: generateKeyPair() } : undefined,
    undefined, { deliveryJournal: journal, reasoningDurable: options?.reasoningDurable });
  channel.registerPeer("peer");
  cleanup.push(() => channel.dispose());
  const draft = createProgressDraftController({ transport: channel, sessionKey: "peer", turnId: "turn", channelConfig: {}, throttleMs: 0 });
  draft.handleAssistantMessageBoundary();
  cleanup.push(() => draft.stop());
  const history = () => projectJournalHistory(journal.read.bind(journal), "peer").messages;
  const fail = () => db.exec("CREATE TRIGGER fail_write BEFORE INSERT ON journal_event BEGIN SELECT RAISE(ABORT, 'injected failure'); END");
  return { journal, db, transport, channel, draft, history, fail, key, databasePath };
}

it("#262: compensating final dedupe cannot overwrite either independently streamed answer ID", async () => {
  const { draft, channel, journal, history, transport, key } = setup({ encrypted: true });
  const finals = vi.spyOn(channel, "finalizeDraft");
  const snapshots = vi.spyOn(channel, "sendTurnSnapshot");
  draft.pushAnswerText({ text: "Repeated answer" });
  await draft.flush();
  draft.handleAssistantMessageBoundary();
  draft.pushAnswerText({ text: "Repeated answer" });
  await draft.flush();
  draft.handleAssistantMessageBoundary(); // B acquires text only at core message-end.
  draft.handleAssistantMessageBoundary(); // Textless terminal message prevents collapse.
  const authoredIds = finals.mock.calls.map((args) => args[1]);
  expect(new Set(authoredIds).size).toBe(2);
  // Reachability: embedded message-end does not invoke onPartialReply, and the
  // dispatcher dedupes [A,A,B] to [A,B] before calling channel delivery.
  expect(await draft.finalize("Repeated answer")).toBe(true);
  expect(await draft.finalize("New final-only answer")).toBe(true);
  await draft.drain();
  draft.stop();
  expect(snapshots.mock.calls.at(-1)![2]).toContainEqual({ id: authoredIds[1], text: "Repeated answer" });
  for (const id of authoredIds) {
    expect(finals.mock.calls.filter((args) => args[1] === id).map((args) => args[2])).toEqual(["Repeated answer"]);
    expect(snapshots.mock.calls.at(-1)![2]).toContainEqual({ id, text: "Repeated answer" });
    expect(history()).toContainEqual(expect.objectContaining({ id, text: "Repeated answer" }));
  }
  const finalOnlyId = finals.mock.calls.find((args) => args[2] === "New final-only answer")![1];
  expect(authoredIds).not.toContain(finalOnlyId);
  expect(history()).toContainEqual(expect.objectContaining({ id: finalOnlyId, text: "New final-only answer" }));
  const events = journal.read("peer", { afterSeq: 0, limit: 100 }).map(({ event }) => event);
  expect(events.every((event) => ["placement", "bubble", "seal"].includes(event.kind))).toBe(true);
  const view = reduceDurableView(events as JournalEvent[]);
  expect(view.filter((entry) => entry.kind === "text").map(({ id, text }) => ({ id, text })))
    .toEqual(history().map((entry) => ({ id: entry.id, text: "text" in entry ? entry.text : undefined })));
  for (const id of authoredIds) expect(view.find((entry) => entry.id === id)).toMatchObject({ text: "Repeated answer" });
  expect(view.find((entry) => entry.id === finalOnlyId)).toMatchObject({ text: "New final-only answer" });
  const liveEvents = transport.publish.mock.calls
    .map((call) => journalEventForOutbound(openEnvelope(call[1] as Uint8Array, key).message as OutboundWsMessage))
    .filter((event): event is JournalEvent => event !== null);
  expect(reduceDurableView(liveEvents)).toEqual(view);
  const tasks: Array<() => void> = [];
  const server = createHistoryServer({ journal, channel, config: DEFAULT_HISTORY_CONFIG, schedule: (fn) => { tasks.push(fn); } });
  server.serveDifference("peer", 0, "identity-difference");
  for (const task of tasks.splice(0)) task();
  const difference = openEnvelope(transport.publish.mock.calls.at(-1)![1] as Uint8Array, key).message as OutboundWsMessage;
  expect(difference).toMatchObject({ type: "difference", nonce: "identity-difference" });
  if (difference.type !== "difference") throw new Error("expected difference frame");
  expect(reduceDurableView(difference.events.map(({ event }) => event))).toEqual(view);
});

it.each([false, true])("#262: buffered finals retain delivery order after a rejected head (persistent=%s)", async (persistent) => {
  const { draft, channel, journal, db, fail, history, transport, key } = setup({ encrypted: true });
  const finals = vi.spyOn(channel, "finalizeDraft");
  for (const text of ["A", "B"]) {
    draft.pushAnswerText({ text });
    await draft.flush();
    draft.handleAssistantMessageBoundary();
  }
  expect(await draft.finalize("A-full")).toBe(true);
  expect(await draft.finalize("B-full")).toBe(true);
  let rejectHead = true;
  const append = journal.append.bind(journal);
  vi.spyOn(journal, "append").mockImplementation((...args) => {
    if (!rejectHead || args[1].kind !== "bubble" || args[1].text !== "A-full") return append(...args);
    if (!persistent) rejectHead = false;
    fail();
    try { return append(...args); }
    finally { db.exec("DROP TRIGGER fail_write"); }
  });

  await draft.drain();
  const headAttempts = () => finals.mock.calls.filter((args) => args[2] === "A-full");
  const suffixAttempts = () => finals.mock.calls.filter((args) => args[2] === "B-full");
  const headId = headAttempts()[0]![1];
  expect(headAttempts()).toHaveLength(2);
  if (persistent) {
    expect(draft.deliveryFailed).toBe(true);
    expect(history().map((message) => "text" in message ? message.text : undefined)).toEqual(["A", "B"]);
    expect(suffixAttempts()).toEqual([]);
    await draft.drain();
    expect(draft.deliveryFailed).toBe(true);
    expect(headAttempts()).toHaveLength(3);
    expect(suffixAttempts()).toEqual([]);
    rejectHead = false;
    await draft.drain();
  }

  expect(draft.deliveryFailed).toBe(false);
  expect(history().map((message) => "text" in message ? message.text : undefined)).toEqual(["A", "B", "A-full", "B-full"]);
  expect(new Set(headAttempts().map((args) => args[1]))).toEqual(new Set([headId]));
  expect(suffixAttempts()).toHaveLength(1);
  expect(suffixAttempts()[0]![1]).not.toBe(headId);
  const finalCalls = [...finals.mock.calls];
  await draft.drain();
  draft.stop();
  draft.stop();
  expect(finals.mock.calls).toEqual(finalCalls);
  const events = journal.read("peer", { afterSeq: 0, limit: 100 }).map(({ event }) => event);
  expect(events.filter((event) => event.kind === "bubble")).toHaveLength(4);
  const liveEvents = transport.publish.mock.calls
    .map((call) => journalEventForOutbound(openEnvelope(call[1] as Uint8Array, key).message as OutboundWsMessage))
    .filter((event): event is JournalEvent => event !== null);
  expect(reduceDurableView(liveEvents)).toEqual(reduceDurableView(events as JournalEvent[]));
  expect(reduceDurableView(liveEvents).map((entry) => "text" in entry ? entry.text : undefined)).toEqual(["A", "B", "A-full", "B-full"]);
});

it.each([false, true])("stores an authored final during relay loss (streamed=%s) with one history identity", async (streamed) => {
  const { transport, draft, history, journal } = setup();
  if (streamed) { draft.pushAnswerText({ text: "partial" }); await draft.flush(); }
  transport.connected = false;
  expect(await draft.finalize("complete answer")).toBe(true);
  await draft.drain();
  await draft.drain();
  draft.stop();
  expect(history().map((message) => "text" in message ? message.text : undefined)).toEqual(["complete answer"]);
  const id = history()[0]!.id;
  expect(journal.read("peer", { afterSeq: 0, limit: 100 }).filter(({ event }) => event.kind === "bubble").map(({ event }) => event.kind === "bubble" && event.answerId)).toEqual([id]);
});

it("refuses a successful live send when a real SQLite insert fails", () => {
  const { channel, transport, journal, fail } = setup();
  fail();
  expect(() => channel.sendText("peer", "answer", "same-id")).toThrow();
  expect(transport.publish).not.toHaveBeenCalled();
  expect(journal.maxSeq("peer")).toBe(0);
});

it.each(["immediate", "notice", "buffered", "snapshot"] as const)("recovers %s output after first store failure on the same ID and clears the failure latch", async (kind) => {
  const { channel, draft, db, fail, history, journal } = setup();
  const finalAttempts = vi.spyOn(channel, "finalizeDraft");
  const snapshotAttempts = vi.spyOn(channel, "sendTurnSnapshot");
  if (kind === "buffered" || kind === "snapshot") {
    draft.pushAnswerText({ text: "first answer" });
    await draft.flush();
    if (kind === "buffered") draft.handleAssistantMessageBoundary();
    else expect(await draft.finalize("first answer")).toBe(true);
  }
  fail();
  if (kind === "notice") expect(await draft.deliverIndependentFinal({ text: "notice", isStatusNotice: true })).toBe(false);
  else if (kind === "buffered") expect(await draft.finalize("second answer")).toBe(true); // held until drain
  else if (kind === "immediate") expect(await draft.finalize("answer")).toBe(false);
  await draft.drain();
  expect(draft.deliveryFailed).toBe(true);
  if (kind === "snapshot") {
    expect(snapshotAttempts).toHaveBeenCalledTimes(2);
    await draft.drain();
    expect(snapshotAttempts).toHaveBeenCalledTimes(3); // one retry of the older pending snapshot
    expect(draft.deliveryFailed).toBe(true);
  }
  const idsBefore = finalAttempts.mock.calls.map((args) => args[1]);
  const snapshotsBefore = snapshotAttempts.mock.calls.map((args) => args[2]);
  db.exec("DROP TRIGGER fail_write");
  await draft.drain();
  expect(draft.deliveryFailed).toBe(false);
  await draft.drain();
  draft.stop();
  expect(draft.deliveryFailed).toBe(false);
  const expected = kind === "buffered" ? ["first answer", "second answer"]
    : kind === "snapshot" ? ["first answer"] : [kind === "notice" ? "notice" : "answer"];
  expect(history().map((m) => "text" in m ? m.text : undefined)).toEqual(expected);
  expect(new Set(finalAttempts.mock.calls.map((args) => args[1]))).toEqual(new Set(idsBefore));
  if (kind === "snapshot") expect(snapshotAttempts.mock.calls.every((args) => JSON.stringify(args[2]) === JSON.stringify(snapshotsBefore[0]))).toBe(true);
  const bubbles = journal.read("peer", { afterSeq: 0, limit: 100 }).filter(({ event }) => event.kind === "bubble");
  expect(bubbles).toHaveLength(expected.length);
});

it.each([false, true])("one drain retries its first snapshot failure after output recovery (buffered=%s)", async (buffered) => {
  const { channel, draft, journal, db, fail, history } = setup();
  const finals = vi.spyOn(channel, "finalizeDraft");
  const snapshots = vi.spyOn(channel, "sendTurnSnapshot");
  draft.pushAnswerText({ text: "first answer" });
  await draft.flush();
  if (buffered) {
    draft.handleAssistantMessageBoundary();
    expect(await draft.finalize("second answer")).toBe(true);
  } else {
    expect(await draft.finalize("first answer")).toBe(true);
  }
  const firstId = finals.mock.calls[0]![1];
  const rejectFirst = new Set(buffered ? ["bubble", "seal"] : ["seal"]);
  const append = journal.append.bind(journal);
  vi.spyOn(journal, "append").mockImplementation((...args) => {
    if (!rejectFirst.delete(args[1].kind)) return append(...args);
    fail();
    try { return append(...args); }
    finally { db.exec("DROP TRIGGER fail_write"); }
  });

  await draft.drain();
  draft.stop();

  expect(draft.deliveryFailed).toBe(false);
  expect(rejectFirst.size).toBe(0);
  expect(snapshots.mock.calls).toEqual([snapshots.mock.calls[0], snapshots.mock.calls[0]]);
  const secondFinals = finals.mock.calls.filter((args) => args[2] === "second answer");
  expect(secondFinals).toHaveLength(buffered ? 2 : 0);
  if (buffered) expect(secondFinals[1]).toEqual(secondFinals[0]);
  expect(history()).toEqual(buffered ? [
    expect.objectContaining({ id: firstId, text: "first answer" }),
    expect.objectContaining({ id: secondFinals[0]![1], text: "second answer" }),
  ] : [expect.objectContaining({ id: firstId, text: "first answer" })]);
  expect(journal.read("peer", { afterSeq: 0, limit: 100 }).filter(({ event }) => event.kind === "seal")).toEqual([
    expect.objectContaining({ event: { kind: "seal", turnId: "turn", answers: snapshots.mock.calls[0]![2], remove: snapshots.mock.calls[0]![3] } }),
  ]);
});

it("identical independent finals stay distinct after the first final's store failure", async () => {
  const { channel, draft, db, fail, history } = setup();
  const attempts = vi.spyOn(channel, "finalizeDraft");
  fail();
  expect(await draft.finalize("identical answer")).toBe(false);
  expect(await draft.finalize("identical answer")).toBe(false);
  const originalIds = attempts.mock.calls.map((args) => args[1]);
  expect(new Set(originalIds).size).toBe(2);
  db.exec("DROP TRIGGER fail_write");
  await draft.drain();
  await draft.drain();
  expect(new Set(attempts.mock.calls.map((args) => args[1]))).toEqual(new Set(originalIds));
  expect(draft.deliveryFailed).toBe(false);
  expect(history().map((m) => m.id)).toEqual(originalIds);
  expect(history().map((m) => "text" in m ? m.text : undefined)).toEqual(["identical answer", "identical answer"]);
});

it("keeps committed identity on first and repeated post-commit publish failures", async () => {
  const { channel, transport, journal, draft, history } = setup();
  transport.publish.mockImplementation(() => { throw new Error("relay write failed"); });
  expect(channel.sendText("peer", "independent", "fixed-id")).toBe(true);
  expect(channel.sendText("peer", "independent", "fixed-id")).toBe(true);
  draft.pushAnswerText({ text: "partial" });
  await draft.flush();
  expect(await draft.finalize("full answer")).toBe(true);
  await draft.drain();
  await draft.drain();
  expect(draft.deliveryFailed).toBe(false);
  expect(history().map((m) => "text" in m ? m.text : undefined)).toEqual(["independent", "full answer"]);
  expect(new Set(journal.read("peer", { afterSeq: 0, limit: 100 }).flatMap(({ event }) => event.kind === "bubble" ? [event.answerId] : [])).size).toBe(2);
});

it("does not synthesize an answer from a failed, unfinalized progress frame", async () => {
  const { draft, fail, history, journal } = setup();
  fail();
  draft.pushAnswerText({ text: "unfinished partial" });
  await draft.flush();
  await draft.drain();
  draft.stop();
  expect(draft.deliveryFailed).toBe(true);
  expect(history()).toEqual([]);
  expect(journal.maxSeq("peer")).toBe(0);
});

it("stop preserves an already-authored buffered final without finalizing new partial text", async () => {
  const { draft, history } = setup();
  draft.pushAnswerText({ text: "first" });
  await draft.flush();
  draft.handleAssistantMessageBoundary();
  expect(await draft.finalize("buffered final")).toBe(true);
  draft.stop();
  draft.stop();
  expect(history().map((m) => "text" in m ? m.text : undefined)).toEqual(["first", "buffered final"]);
});

it("recovers the same encrypted final through difference and reopened history after a relay outage", async () => {
  const { channel, transport, draft, journal, key, databasePath } = setup({ encrypted: true });
  const finals = vi.spyOn(channel, "finalizeDraft");
  transport.connected = false;
  expect(await draft.finalize("authored while disconnected")).toBe(true);
  await draft.drain();
  draft.stop();
  expect(transport.publish).not.toHaveBeenCalled();
  const id = finals.mock.calls[0]![1];
  transport.connected = true;
  const tasks: Array<() => void> = [];
  const server = createHistoryServer({ journal, channel, config: DEFAULT_HISTORY_CONFIG, schedule: (fn) => { tasks.push(fn); } });
  server.serveDifference("peer", 0, "request-1");
  for (const task of tasks.splice(0)) task();
  const wire = transport.publish.mock.calls.at(-1)![1] as Uint8Array;
  const { message: frame } = openEnvelope(wire, key);
  expect(frame).toMatchObject({ type: "difference", nonce: "request-1", events: [expect.objectContaining({ event: { kind: "bubble", answerId: id, text: "authored while disconnected", turnId: "turn" } })] });
  const reopened = openDeliveryJournal({ databasePath });
  try {
    expect(projectJournalHistory(reopened.read.bind(reopened), "peer").messages).toEqual([expect.objectContaining({ id, text: "authored while disconnected" })]);
  } finally { reopened.close(); }
});

it("missing keys, unregistered peers and disposed channels cannot accept ordinary output", () => {
  const { channel, journal, transport } = setup({ encrypted: true });
  expect(channel.sendText("unknown", "refused", "id-1")).toBe(false);
  channel.unregisterPeer("peer");
  transport.connected = false;
  expect(channel.sendText("peer", "refused", "id-2")).toBe(false);
  channel.registerPeer("peer");
  channel.dispose();
  expect(channel.sendText("peer", "retired", "id-3")).toBe(false);
  expect(channel.sendApprovalRequest("peer", { id: "approval", title: "approval" } as never)).toEqual({ delivered: false, journaled: false });
  expect(channel.sendApprovalResolved("peer", "approval", "allow-once")).toBe(false);
  expect(journal.maxSeq("peer")).toBe(0);
  expect(transport.publish).not.toHaveBeenCalled();
});

it("does not return an outbound receipt after store failure", async () => {
  const { channel, fail } = setup();
  fail();
  const adapter = createClawMessageAdapter(channel);
  await expect(adapter.send.text({ to: "peer", text: "answer" } as never)).rejects.toMatchObject({ name: "DurableSendError", messageId: expect.any(String) });
});

it.each([false, true])("reasoning durability policy remains explicit on store failure (durable=%s)", (durable) => {
  const { channel, journal, transport, fail, db } = setup({ reasoningDurable: durable });
  const reasoning = createReasoningDraftController({ transport: channel, sessionKey: "peer", turnId: "turn" });
  const attempts = vi.spyOn(channel, "sendReasoning");
  fail();
  reasoning.pushDurableBlock({ text: "complete reasoning" });
  expect(reasoning.deliveryFailed).toBe(durable);
  expect(transport.publish).toHaveBeenCalledTimes(durable ? 0 : 1);
  const originalId = attempts.mock.calls[0]![1];
  db.exec("DROP TRIGGER fail_write");
  reasoning.stop();
  reasoning.stop();
  expect(reasoning.deliveryFailed).toBe(false);
  expect(new Set(attempts.mock.calls.map((args) => args[1]))).toEqual(new Set([originalId]));
  expect(journal.read("peer", { afterSeq: 0, limit: 100 }).filter(({ event }) => event.kind === "reasoning")).toHaveLength(durable ? 1 : 0);
});

it.each([false, true])("one reasoning stop retries its newly rejected close once (persistent=%s)", (persistent) => {
  const { channel, journal, transport, fail, db } = setup({ reasoningDurable: true });
  const reasoning = createReasoningDraftController({ transport: channel, sessionKey: "peer", turnId: "turn" });
  const attempts = vi.spyOn(channel, "sendReasoning");
  reasoning.push({ text: "  displayed reasoning\n" });
  const originalId = attempts.mock.calls[0]![1];
  attempts.mockClear();
  transport.publish.mockClear();
  fail();
  if (!persistent) {
    const append = journal.append.bind(journal);
    vi.spyOn(journal, "append").mockImplementationOnce((...args) => {
      try { return append(...args); }
      finally { db.exec("DROP TRIGGER fail_write"); }
    });
  }

  reasoning.stop();

  const closeArgs = ["peer", originalId, "turn", "  displayed reasoning\n", true];
  expect(attempts.mock.calls).toEqual([closeArgs, closeArgs]);
  expect(reasoning.deliveryFailed).toBe(persistent);
  expect(transport.publish).toHaveBeenCalledTimes(persistent ? 0 : 1);
  const rows = journal.read("peer", { afterSeq: 0, limit: 100 });
  expect(rows).toHaveLength(persistent ? 0 : 1);
  if (!persistent) {
    expect(rows[0]!.event).toMatchObject({ kind: "reasoning", id: originalId, text: "  displayed reasoning\n" });
    reasoning.stop();
    expect(attempts.mock.calls).toEqual([closeArgs, closeArgs]);
  }
});

it.each(["Check the file.", "Check the file. Then run tests."])(
  "#373: independent native reasoning survives close storage retry without prefix loss: %s",
  (secondText) => {
    const { channel, journal, fail, db, history } = setup({ reasoningDurable: true });
    const reasoning = createReasoningDraftController({ transport: channel, sessionKey: "peer", turnId: "turn" });
    const attempts = vi.spyOn(channel, "sendReasoning");
    reasoning.startRun("native");
    reasoning.startMessage();
    reasoning.push({ text: "Check the file." });
    fail();
    reasoning.endBurst(); // The first message's rejected close keeps its ID/text.
    reasoning.startMessage();
    reasoning.push({ text: secondText });
    reasoning.stop(); // First close failure for message 2 arises inside stop.
    const pending = attempts.mock.calls.filter((args) => args[4] === true);
    expect(new Set(pending.map((args) => args[1])).size).toBe(2);
    expect(reasoning.deliveryFailed).toBe(true);
    expect(journal.maxSeq("peer")).toBe(0);
    db.exec("DROP TRIGGER fail_write");
    attempts.mockClear();
    reasoning.stop();
    reasoning.stop();
    expect(reasoning.deliveryFailed).toBe(false);
    expect(attempts.mock.calls).toEqual([pending[0], pending.find((args) => args[1] !== pending[0][1])]);
    const expected = [{ id: attempts.mock.calls[0][1], text: "Check the file." }, { id: attempts.mock.calls[1][1], text: secondText }];
    expect(history().map((entry) => ({ id: entry.id, text: "text" in entry ? entry.text : undefined }))).toEqual(expected);
    const events = journal.read("peer", { afterSeq: 0, limit: 100 }).map(({ event }) => event);
    expect(events.every((event) => event.kind === "reasoning")).toBe(true);
    expect(reduceDurableView(events as JournalEvent[]).map((entry) => ({ id: entry.id, text: "text" in entry ? entry.text : undefined }))).toEqual(expected);
  },
);

it.each([false, true])("#373: native repeated reasoning keeps the same live policy and durable opt-in (durable=%s)", (durable) => {
  const { channel, journal, history } = setup({ reasoningDurable: durable });
  const reasoning = createReasoningDraftController({ transport: channel, sessionKey: "peer", turnId: "turn" });
  const attempts = vi.spyOn(channel, "sendReasoning");
  for (const text of ["Check the file.", "Check the file."]) {
    reasoning.startMessage();
    reasoning.push({ text });
    reasoning.endBurst();
  }
  reasoning.stop();
  const finals = attempts.mock.calls.filter((args) => args[4] === true);
  expect(finals.map((args) => args[3])).toEqual(["Check the file.", "Check the file."]);
  expect(new Set(finals.map((args) => args[1])).size).toBe(2);
  expect(history()).toHaveLength(durable ? 2 : 0);
  expect(journal.read("peer", { afterSeq: 0, limit: 100 })).toHaveLength(durable ? 2 : 0);
});

it("reasoning stop retries older pending output first and bounds attempts for its new close", () => {
  const { channel, journal, fail, db } = setup({ reasoningDurable: true });
  const reasoning = createReasoningDraftController({ transport: channel, sessionKey: "peer", turnId: "turn" });
  const attempts = vi.spyOn(channel, "sendReasoning");
  fail();
  reasoning.pushDurableBlock({ text: "earlier reasoning" });
  const olderArgs = attempts.mock.calls[0]!;
  reasoning.push({ text: "current reasoning" });
  const currentId = attempts.mock.calls[1]![1];
  const closeArgs = ["peer", currentId, "turn", "current reasoning", true];
  attempts.mockClear();

  reasoning.stop();

  expect(attempts.mock.calls).toEqual([olderArgs, closeArgs, closeArgs]);
  expect(reasoning.deliveryFailed).toBe(true);
  expect(journal.maxSeq("peer")).toBe(0);
  db.exec("DROP TRIGGER fail_write");
  attempts.mockClear();
  reasoning.stop();
  expect(attempts.mock.calls).toEqual([olderArgs, closeArgs]);
  expect(reasoning.deliveryFailed).toBe(false);
  expect(journal.read("peer", { afterSeq: 0, limit: 100 }).map(({ event }) => event)).toEqual([
    expect.objectContaining({ kind: "reasoning", id: olderArgs[1], text: "earlier reasoning" }),
    expect.objectContaining({ kind: "reasoning", id: currentId, text: "current reasoning" }),
  ]);
});

it("tool events fail closed and an explicit same-event retry retains its ID", () => {
  const { channel, fail, db, journal, transport } = setup();
  const activity = { id: "tool-id", turnId: "turn", name: "read_file", phase: "result" };
  fail();
  expect(() => channel.sendToolActivity("peer", activity)).toThrow();
  expect(transport.publish).not.toHaveBeenCalled();
  db.exec("DROP TRIGGER fail_write");
  expect(channel.sendToolActivity("peer", activity)).toBe(true);
  expect(journal.read("peer", { afterSeq: 0, limit: 100 })).toEqual([expect.objectContaining({ event: expect.objectContaining({ kind: "tool", id: "tool-id" }) })]);
});

it("approval catch-up retries a failed resolution without duplicating its committed request", () => {
  const { channel, db, journal, transport } = setup();
  const request = { id: "approval-id", title: "Run command", kind: "exec", description: "test", prompt: "run command", options: [] } as never;
  db.exec("CREATE TRIGGER fail_resolution BEFORE INSERT ON journal_event WHEN json_extract(NEW.payload, '$.kind') = 'approvalResolution' BEGIN SELECT RAISE(ABORT, 'injected failure'); END");
  expect(channel.sendApprovalResolved("peer", "approval-id", "allow-once", { journalRequestFirst: request })).toBe(false);
  expect(transport.publish).not.toHaveBeenCalled();
  expect(channel.sendApprovalResolved("other-peer", "approval-id", "deny", { journalRequestFirst: request })).toBe(false);
  db.exec("DROP TRIGGER fail_resolution");
  expect(channel.sendApprovalResolved("peer", "approval-id", "allow-once", { journalRequestFirst: request })).toBe(true);
  expect(channel.sendApprovalResolved("peer", "approval-id", "allow-once", { journalRequestFirst: request })).toBe(true);
  expect(journal.read("peer", { afterSeq: 0, limit: 100 }).map(({ event }) => event.kind)).toEqual(["approval", "approvalResolution"]);
});


it("preserves committed identity when encryption throws on first and repeated pushes", () => {
  const { channel, transport, history } = setup({ encrypted: true });
  vi.spyOn(sessionCrypto, "sealEnvelope").mockImplementation(() => { throw new Error("injected sealing error"); });
  expect(channel.sendText("peer", "already stored", "seal-failure-id")).toBe(true);
  expect(channel.sendText("peer", "already stored", "seal-failure-id")).toBe(true);
  expect(transport.publish).not.toHaveBeenCalled();
  expect(history()).toEqual([expect.objectContaining({ id: "seal-failure-id", text: "already stored" })]);
});
