import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPersistentDedupe } from "openclaw/plugin-sdk/persistent-dedupe";
import { openDeliveryJournal } from "../src/delivery-journal.ts";
import { createIngressOutcomeStore } from "../src/ingress-outcome.ts";
import { createIngressOnFlush } from "../src/ingress-dedupe.ts";
import { createDispatchRecovery } from "../src/dispatch-recovery.ts";
import { projectJournalHistory } from "../src/journal-history.ts";
const [dir, phase, boundary] = process.argv.slice(2);
const crash = () => { process.kill(process.pid, "SIGKILL"); throw new Error("SIGKILL failed"); };
const journal = openDeliveryJournal({ databasePath: join(dir, "journal.sqlite") });
const persistent = (namespacePrefix: string) => createPersistentDedupe({ pluginId: "webchannel", namespacePrefix, ttlMs: 60_000, memoryMaxSize: 100, stateMaxEntries: 100, env: { ...process.env, OPENCLAW_STATE_DIR: dir } });
const outcomes = createIngressOutcomeStore({ accepted: persistent("accepted"), overloaded: persistent("overloaded"), cancelled: persistent("cancelled") });
const calls: string[] = [];
const recovery = createDispatchRecovery({ store: journal.dispatch!, isActive: () => true, acquirePeer: () => () => {}, notify: () => {}, warn: error => { throw error; }, handler: async (peer, m, settle) => {
  calls.push(m.id!);
  appendFileSync(join(dir, "effects.jsonl"), JSON.stringify({ peer, id: m.id, text: m.text }) + "\n");
  if (phase === "crash" && m.id === "A") {
    if (boundary === "effect") crash();
    if (boundary === "queued" || boundary === "cancelled") await new Promise(() => {});
  }
  journal.append(peer, { kind: "bubble", answerId: `result-${m.id}`, text: `answer ${m.text}`, turnId: m.id });
  settle("ok");
} });
if (phase === "crash" && (boundary === "before-start" || boundary === "after-start")) {
  const claim = journal.dispatch!.claim;
  journal.dispatch!.claim = (...args) => {
    if (boundary === "before-start") crash();
    const result = claim(...args); crash(); return result;
  };
}
recovery.start();
const accept = recovery.accept;
if (phase === "crash" && boundary === "accept") recovery.accept = (...args) => { const result = accept(...args); crash(); return result; };
const flush = createIngressOnFlush({ accountId: "ExactAccount", deliveryJournal: journal, outcomeStore: outcomes, dispatchRecovery: recovery, beginBatch: peer => recovery.beginBatch(peer), sendAck: (_, ids, committed) => {
  appendFileSync(join(dir, "acks.jsonl"), JSON.stringify({ ids, committed }) + "\n"); return true;
} });
const message = (id: string) => ({ peerId: "RawPeer", message: { type: "user_message" as const, id, text: id, random_id: `logical-${id}` } });
if (phase === "crash") {
  await flush([message("A")]);
  if (boundary === "queued" || boundary === "cancelled") {
    await flush([message("B"), message("C")]);
    if (boundary === "cancelled") recovery.cancel("RawPeer");
    crash();
  }
  await new Promise(() => {});
} else {
  // No client resend drives recovery. Wait only for its bounded startup callback.
  await new Promise(resolve => setTimeout(resolve, 350));
  if (phase === "repeat") await flush([message("A"), message("B"), message("C")]);
  writeFileSync(join(dir, `${phase}.json`), JSON.stringify({ calls, rows: journal.read("RawPeer"), history: projectJournalHistory(journal.read, "RawPeer").messages, dispatch: ["A", "B", "C"].map(id => journal.dispatch!.lookup("RawPeer", `logical-${id}`)) }));
  recovery.dispose(); journal.close();
}
