import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPersistentDedupe } from "openclaw/plugin-sdk/persistent-dedupe";
import { createBoundedInboundDebouncer } from "../src/bounded-inbound-debouncer.ts";
import { openDeliveryJournal } from "../src/delivery-journal.ts";
import { createDispatchRecovery } from "../src/dispatch-recovery.ts";
import { createIngressDebounceCallbacks } from "../src/ingress-debounce-callbacks.ts";
import { CancelledInboundFallbackTombstones, createIngressOnFlush } from "../src/ingress-dedupe.ts";
import { createIngressOutcomeStore } from "../src/ingress-outcome.ts";
import { BoundedOverflowResolver } from "../src/inbound-overflow-resolver.ts";
import { InboundRetentionBudget, estimateRetainedMessageBytes } from "../src/inbound-retention.ts";
import type { UserMessageLike } from "../src/inbound-queue.ts";
import { createStopControl } from "../src/stop-control.ts";
import { tupleStoragePaths } from "../src/storage-paths.ts";

const [root, phase, boundary] = process.argv.slice(2);
type Item = { peerId: string; message: UserMessageLike };
const message = (key: string, device = "device-1"): Item => ({ peerId: "RawPeer", message: {
  type: "user_message", id: `${device}:${key}`, random_id: `logical-${key}`, text: key === "S" ? "/stop" : key,
} });
const log = (file: string, data: unknown) => appendFileSync(join(root, file), JSON.stringify(data) + "\n");
const crash = () => { log("boundaries.jsonl", { boundary }); process.kill(process.pid, "SIGKILL"); throw new Error("SIGKILL failed"); };

// Kill after all SQL writes, including the command receipt, but before the
// surrounding immediate transaction commits. This intercepts a real SQLite
// statement; it does not model persistence by returning a fabricated result.
if (phase === "crash" && boundary === "before-commit") {
  const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
  const prepare = DatabaseSync.prototype.prepare;
  DatabaseSync.prototype.prepare = function (sql) {
    const statement = prepare.call(this, sql);
    if (sql === "INSERT INTO journal_stop VALUES(?,?,?,?)") {
      const run = statement.run.bind(statement);
      statement.run = (...args) => { const result = run(...args); crash(); return result; };
    }
    return statement;
  };
}

const paths = tupleStoragePaths({ storageRoot: root, tenant: "tenant-a", accountId: "ExactAccount" });
const journal = openDeliveryJournal({ databasePath: paths.deliveryJournalPath });
const persistent = (namespacePrefix: string) => createPersistentDedupe({
  pluginId: "webchannel", namespacePrefix, ttlMs: 60_000, memoryMaxSize: 100, stateMaxEntries: 100,
  env: { ...process.env, OPENCLAW_STATE_DIR: join(root, "sdk") },
});
const outcomes = createIngressOutcomeStore({ accepted: persistent("accepted"), overloaded: persistent("overloaded"), cancelled: persistent("cancelled") });
const budget = new InboundRetentionBudget();
const session = budget.createSessionToken();
const calls: string[] = [];
const controls: string[] = [];
const errors: string[] = [];
let releaseD!: () => void;
const holdD = new Promise<void>(resolve => { releaseD = resolve; });
let signalD: AbortSignal | undefined;
const recovery = createDispatchRecovery({
  store: journal.dispatch!, isActive: () => true, acquirePeer: () => () => {}, notify: () => {}, warn: error => errors.push(String(error)),
  dispatcherOptions: { budget, sessionToken: () => session },
  handler: async (_peer, value, settle, ownership) => {
    calls.push(value.text);
    log("effects.jsonl", { phase, text: value.text });
    if (phase === "crash" && value.text === "A") await new Promise(() => {});
    if (phase === "recover" && value.text === "D") { signalD = ownership?.abortSignal; await holdD; }
    settle("ok");
  },
});
const snapshot = () => ({
  stop: journal.dispatch!.lookupStop("RawPeer", "logical-S") ?? null,
  targets: ["A", "B", "C", "D", "E"].map(key => journal.dispatch!.isCancelled("RawPeer", `logical-${key}`)),
  dispatch: ["A", "B", "C", "D", "E"].map(key => journal.dispatch!.lookup("RawPeer", `logical-${key}`) ?? null),
  events: journal.read("RawPeer"),
});
const initial = snapshot();
recovery.start();
const sendAck = (_peer: string, ids: string[], committed?: unknown[]) => {
  log("acks.jsonl", { phase, ids, committed });
  if (phase === "crash" && boundary === "inside-stop-ack" && ids.includes("device-2:S")) crash();
  return true;
};
const flush = createIngressOnFlush<Item>({ accountId: "ExactAccount", deliveryJournal: journal, outcomeStore: outcomes,
  dispatchRecovery: recovery, beginBatch: peer => recovery.beginBatch(peer), sendAck });
const fallback = new CancelledInboundFallbackTombstones();
const resolver = new BoundedOverflowResolver({ outcomeStore: outcomes,
  lookupUserRow: ({ peerId }, key) => journal.lookupUserMessageIdByRandomId(peerId, key),
  sendAck: ({ peerId, id }, committed) => sendAck(peerId, [id], committed), sendRejected: () => true });
const debouncer = createBoundedInboundDebouncer<Item>({
  debounceMs: phase === "crash" ? 60_000 : 10, buildKey: value => value.peerId, sessionToken: () => session,
  budget, measure: value => estimateRetainedMessageBytes(value.message), onFlush: flush,
  ...createIngressDebounceCallbacks<Item>({ accountId: "ExactAccount", outcomeStore: outcomes, overflowResolver: resolver,
    cancelledFallback: fallback, deliveryJournal: journal, sessionToken: () => session, sendAck, sendRejected: () => true }),
});
const stop = createStopControl({ journal, recovery, debouncer, sendAck, isActive: () => true, warn: error => errors.push(String(error)),
  retireOverflow: () => { resolver.invalidateSession(session); },
  pendingOverflowKey: () => resolver.pendingLogicalKey(session),
  dispatchControl: async (_peer, value) => { controls.push(value.id!); log("controls.jsonl", { phase, id: value.id }); },
});
if (phase === "crash" && boundary === "after-commit") {
  const recordStop = journal.dispatch!.recordStop;
  journal.dispatch!.recordStop = (...args) => { const receipt = recordStop(...args); crash(); return receipt; };
}
const pause = (ms = 150) => new Promise(resolve => setTimeout(resolve, ms));

if (phase === "crash") {
  await flush([message("A")]); await flush([message("B")]);
  debouncer.push(message("C"));
  writeFileSync(join(root, "before.json"), JSON.stringify(snapshot()));
  stop.handle(message("S", "device-2"), true);
  throw new Error("crash boundary was not reached");
} else {
  await pause();
  const recovered = snapshot();
  await flush([message("A", "original-retry"), message("B", "original-retry"), message("C", "original-retry")]);
  await pause();
  const originalReplays = { calls: [...calls], snapshot: snapshot() };
  let duplicate: unknown;
  if (phase === "recover") {
    await flush([message("D", "device-3")]);
    debouncer.push(message("E", "device-3"));
    const receipt = stop.handle(message("S", "device-2-retry"), true);
    duplicate = { receipt, controls: [...controls], signalD: signalD?.aborted, retained: debouncer.retainedItems("RawPeer").map(value => value.message.text), snapshot: snapshot() };
    releaseD();
    await pause();
  } else {
    const receipt = stop.handle(message("S", "device-2-repeat"), true);
    duplicate = { receipt, controls: [...controls] };
  }
  writeFileSync(join(root, `${phase}.json`), JSON.stringify({ initial, recovered, originalReplays, duplicate, calls, controls, errors, final: snapshot(), budget: budget.usage() }));
  debouncer.dispose(); resolver.dispose(); recovery.dispose(); await stop.dispose(); journal.close();
}
