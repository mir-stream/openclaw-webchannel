import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createPersistentDedupe } from "openclaw/plugin-sdk/persistent-dedupe";
import { readChannelAllowFromStoreSync } from "openclaw/plugin-sdk/channel-pairing";
import { addChannelAllowFromStoreEntry } from "openclaw/plugin-sdk/conversation-runtime";
import { openDeliveryJournal } from "./delivery-journal.js";
import { createIngressOutcomeStore } from "./ingress-outcome.js";
import { createIngressOnFlush } from "./ingress-dedupe.js";
import { createDispatchRecovery } from "./dispatch-recovery.js";
import { createIngressPolicyGate } from "./ingress-policy.js";
import { createStopControl } from "./stop-control.js";
import { createDmIngressPolicy, MAX_INGRESS_PAIRING_CHALLENGES, resolveDmAdmission } from "./dm-allowlist.js";
import type { UserMessageLike } from "./inbound-queue.js";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); vi.restoreAllMocks(); });
const item = (id: string, peerId = "peer", text = id, logical = id) => ({ peerId, message: { type: "user_message" as const, id, random_id: logical, text } });
function open(path?: string, dm?: Partial<Parameters<typeof createDmIngressPolicy>[0]>) {
  if (!path) { path = mkdtempSync(join(tmpdir(), "ingress-policy-")); const root = path; cleanup.push(() => rmSync(root, { recursive: true, force: true })); }
  const journal = openDeliveryJournal({ databasePath: join(path, "journal.sqlite") });
  const persistent = (namespacePrefix: string) => createPersistentDedupe({ pluginId: "webchannel", namespacePrefix, ttlMs: 60_000, memoryMaxSize: 100, stateMaxEntries: 100, env: { ...process.env, OPENCLAW_STATE_DIR: path } });
  const outcomeStore = createIngressOutcomeStore({ accepted: persistent("accepted"), overloaded: persistent("overloaded"), cancelled: persistent("cancelled") });
  const policy = { dmSecurity: "allowlist", allowFrom: [] as string[] };
  const acks: unknown[] = []; const broadcasts: unknown[] = []; const runs: unknown[] = []; const rejected: unknown[] = []; const errors: unknown[] = [];
  const recovery = createDispatchRecovery({ store: journal.dispatch!, acquirePeer: () => () => {}, isActive: () => true, notify: () => {}, warn: e => errors.push(e),
    handler: async (_peer, message, settle) => { runs.push(message); settle("ok"); },
  });
  recovery.start();
  const sendAck = (_peer: string, ids: string[], committed?: unknown, cancelled?: string[], unaccepted?: string[]) => { acks.push({ ids, committed, cancelled, unaccepted }); return true; };
  let active = true;
  const readStore = vi.fn<typeof readChannelAllowFromStoreSync>().mockReturnValue([]);
  const upsertPairingRequest = vi.fn().mockResolvedValue({ code: "PAIR1234", created: true });
  const sendPairingReply = vi.fn().mockResolvedValue(undefined);
  const dmPolicy = dm ? createDmIngressPolicy({ accountId: "account", config: { dmPolicy: "pairing" },
    isActive: () => active, readStore, upsertPairingRequest, sendPairingReply, warn: e => errors.push(e), ...dm }) : undefined;
  const gate = createIngressPolicyGate({ journal, isAllowed: peer => resolveDmAdmission(peer, policy).allowed, ...dmPolicy,
    sendAck, sendRejected: (peerId, ids) => { rejected.push({ peerId, ids }); return true; }, warn: e => errors.push(e),
  });
  const flush = createIngressOnFlush<ReturnType<typeof item>>({ accountId: "account", outcomeStore, deliveryJournal: journal, dispatchRecovery: recovery,
    beginBatch: peer => recovery.beginBatch(peer), sendAck, sendUserCommitted: (_peer, message) => { broadcasts.push(message); return true; },
  });
  const controls: unknown[] = [];
  const stop = createStopControl<{ peerId: string; message: UserMessageLike }>({ journal, recovery, sendAck, debouncer: { retainedItems: () => [], cancelKey: () => false },
    pendingOverflowKey: () => undefined, retireOverflow: () => {}, dispatchControl: async (_peer, message) => { controls.push(message); }, isActive: () => true, warn: e => errors.push(e),
  });
  const receive = async (value: ReturnType<typeof item>) => {
    if (!gate(value)) return;
    if (value.message.text === "/stop") stop.handle(value, true);
    else await flush([value]);
  };
  let closed = false;
  const close = () => { if (closed) return; closed = true; active = false; recovery.dispose(); journal.close(); };
  cleanup.push(close);
  return { path, journal, recovery, policy, acks, broadcasts, runs, rejected, errors, gate, receive, controls, close,
    readStore, upsertPairingRequest, sendPairingReply };
}

it.each(["private text", "/stop"])("#442 rejects fresh %s before receipt, journal, broadcast or execution", async text => {
  const h = open();
  await h.receive(item("blocked", "peer", text));
  expect(h.rejected).toEqual([{ peerId: "peer", ids: ["blocked"] }]);
  expect(h.journal.read("peer")).toEqual([]);
  expect(h.journal.dispatch!.lookupStop("peer", "blocked")).toBeUndefined();
  expect(h.acks).toEqual([]); expect(h.broadcasts).toEqual([]); expect(h.runs).toEqual([]); expect(h.controls).toEqual([]);
});

it("#442 denial is per attempt: policy change can admit a previously rejected ID", async () => {
  const h = open();
  await h.receive(item("retry"));
  expect(h.rejected).toHaveLength(1);
  h.policy.allowFrom = ["peer"];
  await h.receive(item("retry"));
  expect(h.acks).toHaveLength(1); expect(h.broadcasts).toHaveLength(1); expect(h.runs).toHaveLength(1);
  h.policy.allowFrom = [];
  await h.receive(item("replay", "peer", "different payload", "retry"));
  expect(h.rejected).toHaveLength(1); expect(h.acks).toHaveLength(2); expect(h.runs).toHaveLength(1);
});

it("#442 accepted message and stop replays keep original receipts after policy change and restart", async () => {
  const h = open(); h.policy.allowFrom = ["peer"];
  await h.receive(item("accepted"));
  await h.receive(item("stop", "peer", "/stop"));
  const receipt = h.acks[0];
  h.close();
  const cold = open(h.path);
  await cold.receive(item("accepted")); await cold.receive(item("stop", "peer", "/stop"));
  expect(cold.rejected).toEqual([]);
  expect(cold.acks[0]).toEqual(receipt); expect(cold.acks).toHaveLength(2);
  expect(cold.runs).toEqual([]); expect(cold.controls).toEqual([]);
  await cold.receive(item("new"));
  expect(cold.rejected).toHaveLength(1);
});

it("#442 does not reinterpret cancelled targets or exact converged retry aliases as fresh denial", () => {
  const h = open(); const store = h.journal.dispatch!; const owner = store.activate();
  store.recordStop(owner, "peer", "stop", ["cancelled"], true);
  expect(h.gate(item("cancelled"))).toBe(false);
  expect(h.acks).toHaveLength(1);
  expect(h.acks[0]).toMatchObject({ ids: ["cancelled"], cancelled: ["cancelled"], unaccepted: ["cancelled"] });
  const [original] = store.accept(owner, "peer", [{ text: "original", turnId: "original", randomId: "original" }]);
  const [claimed] = store.claim(owner, "peer", ["original"]);
  store.settle(owner, "peer", claimed.batch!, "interrupted");
  store.accept(owner, "peer", [{ text: "retry", turnId: "R1", randomId: "R1", retryOf: original.messageId }]);
  store.accept(owner, "peer", [{ text: "retry", turnId: "R2", randomId: "R2", retryOf: original.messageId }]);
  expect(store.convergence("peer", "R2")).toBeDefined();
  expect(h.gate(item("R2"))).toBe(false);
  expect(h.acks.at(-1)).toMatchObject({ ids: ["R2"], committed: [{ random_id: "R2", messageId: expect.any(String), converged: true }] });
  expect(h.gate(item("R2", "other-peer"))).toBe(false);
  expect(h.rejected).toEqual([{ peerId: "other-peer", ids: ["R2"] }]);
});

it("#442 storage read failure withholds both denial and admission because acceptance is unknown", () => {
  const h = open();
  vi.spyOn(h.journal, "lookupUserMessageIdByRandomId").mockImplementation(() => { throw new Error("read unavailable"); });
  expect(h.gate(item("unknown"))).toBe(false);
  expect(h.rejected).toEqual([]); expect(h.errors).toHaveLength(1);
});

it("#442 legacy id-less input is denied without inventing a correlatable receipt", () => {
  const h = open();
  expect(h.gate({ peerId: "peer", message: { text: "legacy" } })).toBe(false);
  expect(h.rejected).toEqual([]); expect(h.errors).toEqual([]);
});

it("#442 rejection delivery failure stays closed and observable", () => {
  const h = open();
  const errors: unknown[] = [];
  const gate = createIngressPolicyGate({ journal: h.journal, isAllowed: () => false, sendAck: () => false, sendRejected: () => false, warn: e => errors.push(e) });
  expect(gate(item("blocked"))).toBe(false);
  expect(errors).toHaveLength(1);
});

it("#442 production policy gate uses the resolved account and precedes both stop and retention", () => {
  const source = readFileSync(new URL("./nats-account-runtime.ts", import.meta.url), "utf8");
  const adapter = source.slice(source.indexOf("const dmIngressPolicy = createDmIngressPolicy({"), source.indexOf("const admitInbound = createIngressPolicyGate({"));
  expect(adapter).toContain("accountId,\n        config: account,");
  expect(adapter).toContain("isActive: () => runtimeActive,");
  expect(adapter).toContain("channel.sendText(peerId, text, nextMessageId())");
  const wiring = source.slice(source.indexOf("const admitInbound = createIngressPolicyGate({"), source.indexOf("channel.setMessageHandler((peerId, rawMessage)"));
  expect(wiring).toContain("...dmIngressPolicy,");
  const handler = source.slice(source.indexOf("channel.setMessageHandler((peerId, rawMessage)"));
  const gate = handler.indexOf("if (!admitInbound({ peerId, message })) return;");
  expect(gate).toBeGreaterThan(handler.indexOf("normalizeInboundUserMessage(rawMessage)"));
  expect(gate).toBeLessThan(handler.indexOf("stopControl!.handle("));
  expect(gate).toBeLessThan(handler.indexOf(".enqueue({ peerId, message })"));
});

// Let bounded fire-and-forget SDK issuance settle without polling or timers.
const settlePairing = () => new Promise<void>(resolve => setImmediate(resolve));

it.each(["private text", "/stop"])("#406 fresh pairing %s gets SDK challenge and refusal without acceptance", async text => {
  const h = open(undefined, {});
  await h.receive(item("blocked", "peer", text));
  await settlePairing();
  expect(h.readStore).toHaveBeenCalledWith("webchannel", process.env, "account");
  expect(h.upsertPairingRequest).toHaveBeenCalledWith(expect.objectContaining({ channel: "webchannel", accountId: "account", id: "peer" }));
  expect(h.sendPairingReply).toHaveBeenCalledWith("peer", expect.stringContaining("PAIR1234"));
  expect(h.rejected).toEqual([{ peerId: "peer", ids: ["blocked"] }]);
  expect(h.journal.read("peer")).toEqual([]);
  expect(h.journal.dispatch!.lookupStop("peer", "blocked")).toBeUndefined();
  expect(h.acks).toEqual([]); expect(h.broadcasts).toEqual([]); expect(h.runs).toEqual([]); expect(h.controls).toEqual([]);
});

it("#406 SDK approvals admit this account's normal and stop input but not sibling approvals", async () => {
  const h = open(undefined, {});
  const env = { ...process.env, OPENCLAW_STATE_DIR: h.path };
  h.readStore.mockImplementation((channel, _env, accountId) => readChannelAllowFromStoreSync(channel, env, accountId));
  await addChannelAllowFromStoreEntry({ channel: "webchannel", accountId: "sibling", entry: "peer", env });
  await h.receive(item("retry"));
  await settlePairing();
  expect(h.rejected).toHaveLength(1); expect(h.acks).toEqual([]);
  await addChannelAllowFromStoreEntry({ channel: "webchannel", accountId: "account", entry: "peer", env });
  await h.receive(item("retry"));
  await h.receive(item("stop", "peer", "/stop"));
  await settlePairing();
  expect(h.acks).toHaveLength(2); expect(h.broadcasts).toHaveLength(1); expect(h.runs).toHaveLength(1); expect(h.controls).toHaveLength(1);
  expect(h.upsertPairingRequest).toHaveBeenCalledTimes(1);
});

it.each(["open", "allowlist", "disabled"] as const)("#406 %s never reads pairing approvals or issues challenges", async dmPolicy => {
  const h = open(undefined, { config: { dmPolicy, allowFrom: ["*"] } });
  await h.receive(item("input"));
  await settlePairing();
  expect(h.readStore).not.toHaveBeenCalled(); expect(h.upsertPairingRequest).not.toHaveBeenCalled();
  expect(h.acks).toHaveLength(dmPolicy === "disabled" ? 0 : 1);
  expect(h.rejected).toHaveLength(dmPolicy === "disabled" ? 1 : 0);
});

it("#406 pairing configured allowlist admits without consulting approvals", async () => {
  const h = open(undefined, { config: { dmPolicy: "pairing", allowFrom: ["webchannel:peer"] } });
  await h.receive(item("allowed"));
  await settlePairing();
  expect(h.acks).toHaveLength(1); expect(h.readStore).not.toHaveBeenCalled(); expect(h.upsertPairingRequest).not.toHaveBeenCalled();
});

it("#406 accepted, stop, cancelled and converged receipts replay without a new pairing request", async () => {
  const h = open(undefined, {}); h.readStore.mockReturnValue(["peer"]);
  await h.receive(item("accepted"));
  await h.receive(item("stop", "peer", "/stop"));
  const originalAcks = [...h.acks];
  const store = h.journal.dispatch!; const owner = store.activate();
  store.recordStop(owner, "peer", "cancelling-stop", ["cancelled"], true);
  const [original] = store.accept(owner, "peer", [{ text: "original", turnId: "original", randomId: "original" }]);
  const [claimed] = store.claim(owner, "peer", ["original"]);
  store.settle(owner, "peer", claimed.batch!, "interrupted");
  store.accept(owner, "peer", [{ text: "retry", turnId: "R1", randomId: "R1", retryOf: original.messageId }]);
  store.accept(owner, "peer", [{ text: "retry", turnId: "R2", randomId: "R2", retryOf: original.messageId }]);
  h.readStore.mockReturnValue([]);
  await h.receive(item("accepted", "peer", "/stop"));
  await h.receive(item("stop", "peer", "different payload"));
  await h.receive(item("cancelled")); await h.receive(item("R2"));
  await settlePairing();
  expect(h.acks.slice(2, 4)).toEqual(originalAcks);
  expect(h.acks[4]).toMatchObject({ cancelled: ["cancelled"], unaccepted: ["cancelled"] });
  expect(h.acks[5]).toMatchObject({ committed: [{ random_id: "R2", converged: true }] });
  expect(h.rejected).toEqual([]); expect(h.upsertPairingRequest).not.toHaveBeenCalled();
  expect(h.runs).toHaveLength(1); expect(h.controls).toHaveLength(1);
});

it("#406 uncertain receipts and id-less attempts cannot start pairing", async () => {
  const h = open(undefined, {});
  vi.spyOn(h.journal, "lookupUserMessageIdByRandomId").mockImplementation(() => { throw new Error("read unavailable"); });
  expect(h.gate(item("unknown"))).toBe(false);
  expect(h.gate({ peerId: "peer", message: { text: "legacy" } })).toBe(false);
  await settlePairing();
  expect(h.rejected).toEqual([]); expect(h.upsertPairingRequest).not.toHaveBeenCalled(); expect(h.acks).toEqual([]);
});

it("#406 pre-retention pairing work is coalesced and bounded, then releases its slots", async () => {
  let release!: (value: { code: string; created: boolean }) => void;
  const waiting = new Promise<{ code: string; created: boolean }>(resolve => { release = resolve; });
  const h = open(undefined, {}); h.upsertPairingRequest.mockReturnValue(waiting);
  for (let i = 0; i < MAX_INGRESS_PAIRING_CHALLENGES + 3; i++) {
    h.gate(item(`input-${i}`, `peer-${i}`)); h.gate(item(`duplicate-${i}`, `peer-${i}`));
  }
  await settlePairing();
  expect(h.upsertPairingRequest).toHaveBeenCalledTimes(MAX_INGRESS_PAIRING_CHALLENGES);
  expect(h.rejected).toHaveLength((MAX_INGRESS_PAIRING_CHALLENGES + 3) * 2);
  expect(h.acks).toEqual([]);
  release({ code: "PAIR1234", created: false });
  await settlePairing();
  h.gate(item("retry", "peer-new")); await settlePairing();
  expect(h.upsertPairingRequest).toHaveBeenCalledTimes(MAX_INGRESS_PAIRING_CHALLENGES + 1);
  expect(h.sendPairingReply).not.toHaveBeenCalled(); // SDK suppresses an existing pending challenge.
});

it.each([false, true])("#406 retired runtime cannot deliver a challenge (SDK write started=%s)", async started => {
  let release!: (value: { code: string; created: boolean }) => void;
  const waiting = new Promise<{ code: string; created: boolean }>(resolve => { release = resolve; });
  const h = open(undefined, {}); h.upsertPairingRequest.mockReturnValue(waiting);
  h.gate(item("blocked"));
  if (started) await settlePairing();
  h.close();
  release({ code: "PAIR1234", created: true });
  await settlePairing();
  expect(h.upsertPairingRequest).toHaveBeenCalledTimes(started ? 1 : 0);
  expect(h.sendPairingReply).not.toHaveBeenCalled();
});

it("#442 denied peers replay receipts without changing a normal input into a new stop or a stop into new text", async () => {
  const h = open(); h.policy.allowFrom = ["peer"];
  await h.receive(item("accepted"));
  await h.receive(item("stop", "peer", "/stop"));
  const originalAcks = [...h.acks];
  const calls = h.controls.length;
  h.policy.allowFrom = [];
  await h.receive(item("accepted", "peer", "/stop"));
  await h.receive(item("stop", "peer", "new text"));
  expect(h.acks.slice(2)).toEqual(originalAcks);
  expect(h.controls).toHaveLength(calls);
  expect(h.runs).toHaveLength(1);
  expect(h.journal.dispatch!.lookupStop("peer", "accepted")).toBeUndefined();
  expect(h.journal.dispatch!.lookup("peer", "stop")).toBeUndefined();
  expect(h.rejected).toEqual([]);
});
