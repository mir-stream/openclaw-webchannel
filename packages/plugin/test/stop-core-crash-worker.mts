import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dispatchReplyWithBufferedBlockDispatcher } from "openclaw/plugin-sdk/reply-runtime";
import { getSessionEntry, upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { openDeliveryJournal } from "../src/delivery-journal.ts";
import { createDispatchRecovery } from "../src/dispatch-recovery.ts";
import { prepareCoreDispatch, retireInterruptedCoreDispatches } from "../src/dispatch-core-recovery.ts";
import { createStopControl } from "../src/stop-control.ts";
import { createBoundedInboundDebouncer } from "../src/bounded-inbound-debouncer.ts";
import { createIngressOnFlush } from "../src/ingress-dedupe.ts";
import { createIngressOutcomeStore } from "../src/ingress-outcome.ts";
import { createPersistentDedupe } from "openclaw/plugin-sdk/persistent-dedupe";
import { InboundRetentionBudget } from "../src/inbound-retention.ts";
import type { UserMessageLike } from "../src/inbound-queue.ts";
import { tupleStoragePaths } from "../src/storage-paths.ts";

const [root, phase] = process.argv.slice(2);
const accountId = "account", peerId = "peer";
const storePath = join(root, "sessions.json");
const workspace = join(root, "workspace");
mkdirSync(workspace, { recursive: true });
const cfg = { session: { store: storePath }, agents: { defaults: { workspace } },
  channels: { webchannel: { accounts: { account: { tenant: "tenant", storageRoot: root } } } } } as unknown as OpenClawConfig;
// This SDK-only process does not register a channel plugin with the gateway's
// config validator. Keep its ambient SDK config minimal; retirement receives
// the exact WebChannel serving plan explicitly through cfg below.
writeFileSync(join(root, "openclaw.json"), JSON.stringify({ session: cfg.session, agents: cfg.agents }));
const sessionKey = "agent:main:webchannel:account:direct:peer:tenant:review:peer-v2";
const scope = { storePath, sessionKey };
const paths = tupleStoragePaths({ tenant: "tenant", accountId, storageRoot: root });
const journal = openDeliveryJournal({ databasePath: paths.deliveryJournalPath });
const budget = new InboundRetentionBudget(), token = budget.createSessionToken();
const errors: string[] = [], runs: string[] = [], controls: string[] = [], acks: string[] = [];
let entered = false, underlyingSettled = false, handlerReturned = false;
const held = new Promise<void>(() => {});
const coreEntry = (abortedLastRun: boolean) => ({ sessionId: "held-core-session", updatedAt: Date.now(),
  status: "running" as const, abortedLastRun, restartRecoveryDeliveryRunId: "held-core-run",
  restartRecoveryDeliveryContext: { channel: "webchannel", accountId, to: peerId } });
const recovery = createDispatchRecovery({ store: journal.dispatch!, isActive: () => true,
  acquirePeer: () => () => {}, notify: () => {}, warn: error => errors.push(String(error)),
  dispatcherOptions: { budget, sessionToken: () => token },
  handler: async (peer, message, settle, ownership) => {
    runs.push(message.text);
    if (!ownership) throw new Error("expected durable dispatch ownership");
    prepareCoreDispatch(cfg, "main", sessionKey, { owner: ownership.owner, batch: ownership.batch, peerId: peer }, journal);
    // The actual pinned public dispatcher races this resolver against abort.
    // Its return is deliberately NOT the resolver/core termination boundary.
    await dispatchReplyWithBufferedBlockDispatcher({ cfg,
      ctx: { Body: message.text, RawBody: message.text, CommandBody: message.text,
        SessionKey: sessionKey, From: peer, To: peer, Provider: "webchannel", Surface: "webchannel",
        ChatType: "direct", AccountId: accountId, MessageSid: "held-core-input" },
      dispatcherOptions: { deliver: async () => {} }, replyOptions: { abortSignal: ownership.abortSignal },
      replyResolver: async () => {
        await upsertSessionEntry({ ...scope, entry: coreEntry(false) });
        entered = true;
        await held;
        underlyingSettled = true;
        return [];
      },
    });
    settle("ok"); // The same settlement seam handleInboundMessage calls.
    handlerReturned = true;
  },
});
type Item = { peerId: string; message: UserMessageLike };
const debouncer = createBoundedInboundDebouncer<Item>({ debounceMs: 0, budget,
  buildKey: item => item.peerId, sessionToken: () => token, onFlush: () => {} });
const sendAck = (_peer: string, ids: string[]) => { acks.push(...ids); return true; };
const stop = createStopControl({ journal, recovery, debouncer, sendAck, retireOverflow: () => {},
  pendingOverflowKey: () => undefined,
  isActive: () => true, warn: error => errors.push(String(error)), dispatchControl: async (_peer, message) => {
    controls.push(message.id!);
    // Model the persisted abort/restart flag through the public SDK; the core
    // resolver and dispatch-abort race above are real SDK calls. No provider or
    // network stop is claimed by this controlled session-state mutation.
    await upsertSessionEntry({ ...scope, entry: coreEntry(true) });
  },
});
const snapshot = () => ({ runs, controls, acks, errors, underlyingSettled, handlerReturned,
  bindings: journal.dispatch!.coreBindings(), dispatch: journal.dispatch!.lookup(peerId, "A"),
  receipt: journal.dispatch!.lookupStop(peerId, "S"),
  core: getSessionEntry({ ...scope, readConsistency: "latest" }) });
const waitUntil = async (condition: () => boolean) => {
  for (let i = 0; i < 500; i++) {
    if (condition()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("core boundary not reached: " + JSON.stringify(snapshot()));
};
const stopItem: Item = { peerId, message: { type: "user_message", text: "/stop", id: "S", random_id: "S" } };
if (phase === "crash") {
  recovery.start();
  recovery.accept(peerId, [{ text: "A", turnId: "A", randomId: "A" }]);
  const lease = recovery.beginBatch(peerId);
  const offer = lease.offer({ type: "user_message", text: "A", id: "A", random_id: "A" });
  if (offer.status !== "accepted") throw new Error("initial offer refused");
  offer.commit(); lease.finish();
  await waitUntil(() => entered);
  stop.handle(stopItem, true);
  await waitUntil(() => handlerReturned);
  await stop.dispose();
  writeFileSync(join(root, "crash.json"), JSON.stringify(snapshot()));
  process.kill(process.pid, "SIGKILL");
  throw new Error("SIGKILL failed");
} else {
  // A genuinely different OS process owns startup retirement, with no test
  // override of the recorded process ID or binding metadata.
  await retireInterruptedCoreDispatches(cfg);
  recovery.start();
  const persistent = (namespacePrefix: string) => createPersistentDedupe({ pluginId: "webchannel",
    namespacePrefix, ttlMs: 60_000, memoryMaxSize: 100, stateMaxEntries: 100 });
  const outcomes = createIngressOutcomeStore({ accepted: persistent("accepted"), overloaded: persistent("overloaded"), cancelled: persistent("cancelled") });
  const flush = createIngressOnFlush<Item>({ accountId, deliveryJournal: journal, outcomeStore: outcomes,
    dispatchRecovery: recovery, beginBatch: peer => recovery.beginBatch(peer), sendAck });
  await flush([{ peerId, message: { type: "user_message", text: "A", id: `${phase}-A`, random_id: "A" } }]);
  stop.handle({ peerId, message: { ...stopItem.message, id: `${phase}-S` } }, true);
  writeFileSync(join(root, `${phase}.json`), JSON.stringify(snapshot()));
  recovery.dispose(); debouncer.dispose(); await stop.dispose(); journal.close();
}
