import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  __approvalAccountBindingTestHook, __pendingApprovalsTestHook, __resolvedApprovalsTestHook,
  createClawApprovalNativeRuntimeSpec, listPendingApprovalsForPeer, listResolvedApprovalsForPeer,
  startClawApprovalMonitor,
} from "./approvals.js";
import { NatsChannel, getApprovalResolution } from "./nats-channel.js";
import { APPROVAL_OUTPUT_PENDING_BYTES, APPROVAL_OUTPUT_PENDING_CAP, APPROVAL_OUTPUT_RETRY_DELAYS_MS, APPROVAL_OUTPUT_RETRY_BATCH } from "./approval-output-recovery.js";
import { generateKeyPair } from "./e2e-crypto.js";
import { openEnvelope } from "./e2e-session.js";
import type { NatsTransport } from "./nats-transport.js";
import { openDeliveryJournal } from "./delivery-journal.js";
import { serveHistoryRequest, serveHistoryRequestStep } from "./journal-history.js";
import type { ApprovalRequestPayload, WebChannelPeerChannel } from "./channel-contract.js";

const { gatewayResolve } = vi.hoisted(() => ({ gatewayResolve: vi.fn(async () => {}) }));
vi.mock("openclaw/plugin-sdk/approval-handler-runtime", async importOriginal => ({
  ...await importOriginal<typeof import("openclaw/plugin-sdk/approval-handler-runtime")>(),
  resolveApprovalOverGateway: gatewayResolve,
}));

const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
const ACCOUNT = "Team-A";
const PEER = "Raw.Peer+Case";
const cleanup: Array<() => void> = [];
class ControlledTransport extends EventEmitter {
  connected = true;
  effectiveOutboundLimit = 1_000_000;
  published: Array<{ subject: string; payload: Record<string, unknown> }> = [];
  private sid = 0;
  key?: Uint8Array;
  subscribe() { return ++this.sid; }
  unsubscribe() {}
  publish(subject: string, payload: string | Uint8Array) {
    const wire = typeof payload === "string" ? Buffer.from(payload) : payload;
    this.published.push({ subject, payload: this.key ? openEnvelope(wire, this.key).message as Record<string, unknown> : JSON.parse(Buffer.from(wire).toString()) });
  }
}

function fixture(options?: { encrypted?: boolean; context?: unknown; maxResolutions?: number }) {
  const dir = mkdtempSync(join(tmpdir(), "approval-output-recovery-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const databasePath = join(dir, "journal.sqlite");
  const journal = openDeliveryJournal({ databasePath });
  cleanup.push(() => journal.close());
  const db = new DatabaseSync(databasePath);
  cleanup.push(() => db.close());
  const transport = new ControlledTransport();
  const key = new Uint8Array(32).fill(7);
  if (options?.encrypted) transport.key = key;
  const channel = new NatsChannel(transport as unknown as NatsTransport, ACCOUNT, "tenant",
    options?.encrypted ? { keyStore: { getOrCreate: () => key } as never, identityKeyPair: generateKeyPair() } : undefined,
    { maxApprovalResolutions: options?.maxResolutions }, { deliveryJournal: journal });
  cleanup.push(() => channel.dispose());
  if (options?.encrypted) channel.registerPeer(PEER);
  let current: WebChannelPeerChannel | undefined = channel;
  const resolve = vi.fn((_accountId: string | null | undefined) => current);
  const spec = createClawApprovalNativeRuntimeSpec(channel, resolve);
  const card: ApprovalRequestPayload = {
    id: "approval-original", kind: "exec", title: "Approval", prompt: "Original request",
    options: [{ decision: "allow-once", label: "Allow", style: "success" }],
    expiresAtMs: Date.now() + 60_000,
  };
  const deliver = (request = card, peer = PEER) => spec.transport.deliverPending({
    cfg: {}, accountId: ACCOUNT, context: options?.context, plannedTarget: { target: { to: peer } },
    preparedTarget: { sessionKey: peer }, request: {}, approvalKind: "exec", view: {}, pendingPayload: request,
  } as Parameters<typeof spec.transport.deliverPending>[0]);
  const finalize = (entry: Awaited<ReturnType<typeof deliver>>, decision: "allow-once" | "deny" = "allow-once", phase: "resolved" | "expired" = "resolved") => spec.transport.updateEntry!({
    cfg: {}, accountId: ACCOUNT, entry: entry!, payload: { decision }, phase,
  });
  const fault = (kind: "approval" | "approvalResolution") => {
    db.exec("DROP TRIGGER IF EXISTS reject_approval_output");
    db.exec(`CREATE TRIGGER reject_approval_output BEFORE INSERT ON journal_event WHEN NEW.kind = '${kind}' BEGIN SELECT RAISE(ABORT, 'injected approval storage failure'); END`);
  };
  const recover = () => db.exec("DROP TRIGGER reject_approval_output");
  const history = () => {
    const plan = { kind: "recent" as const, limit: 50 };
    const materialized = serveHistoryRequestStep(journal, PEER, plan);
    expect(materialized.pending).toBe(false);
    if (materialized.pending) throw new Error("Unexpected catch-up for two rows");
    const replay = serveHistoryRequest(journal.read, PEER, plan);
    expect(materialized.messages).toEqual(replay.messages);
    return materialized.messages;
  };
  return { journal, db, transport, channel, spec, card, deliver, finalize, fault, recover, history, resolve,
    maintenanceTimers: vi.getTimerCount(), // Real SQLite SDK WAL checkpoint maintenance remains active.
    replace: (next: WebChannelPeerChannel | undefined) => { current = next; } };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  __approvalAccountBindingTestHook.clear();
  __pendingApprovalsTestHook.clear();
  __resolvedApprovalsTestHook.clear();
  gatewayResolve.mockClear();
});
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
  vi.useRealTimers();
  vi.restoreAllMocks();
  expect(gatewayResolve).not.toHaveBeenCalled(); // Output recovery never re-resolves the approved action.
});

describe("#381 production approval finalization with SQLite storage faults", () => {
  it.each(["approval", "approvalResolution"] as const)("recovers output after failure at %s without another finalization", async kind => {
    const f = fixture({ encrypted: true });
    f.fault("approval");
    const entry = await f.deliver();
    expect(f.journal.read(PEER)).toEqual([]);
    f.fault(kind);
    await f.finalize(entry);
    expect(listPendingApprovalsForPeer(ACCOUNT, PEER)).toEqual([]);
    expect(listResolvedApprovalsForPeer(ACCOUNT, PEER)).toEqual([{ id: f.card.id, decision: "allow-once" }]);
    expect(f.journal.read(PEER).map(row => row.event.kind)).toEqual(kind === "approval" ? [] : ["approval"]);
    expect(f.transport.published).toEqual([{ subject: `webchannel.tenant.${ACCOUNT}.${PEER}.out`, payload: { type: "approval_snapshot", approvals: [], resolved: [{ id: f.card.id, decision: "allow-once" }] } }]);
    f.history(); // Materialize the incomplete prefix before recovery.
    f.recover();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.journal.read(PEER).map(row => row.event.kind)).toEqual(["approval", "approvalResolution"]);
    expect(f.journal.read(PEER).map(row => ("id" in row.event ? row.event.id : undefined))).toEqual([f.card.id, f.card.id]);
    expect(f.history()).toEqual([expect.objectContaining({ kind: "approval", id: f.card.id, resolvedDecision: "allow-once", prompt: "Original request" })]);
    expect(f.channel.getApprovalOutputRecoveryStatus()).toEqual({ pending: 0, exhausted: 0, abandoned: 0, retainedBytes: 0 });
    expect(f.transport.published.at(-1)).toEqual({ subject: `webchannel.tenant.${ACCOUNT}.${PEER}.out`, payload: { type: "approval_resolved", id: f.card.id, decision: "allow-once", seq: 2 } });
    expect(f.resolve.mock.calls.every(args => args[0] === ACCOUNT)).toBe(true);
  });

  it("coalesces simultaneous finalizers and preserves the first peer, decision and request copy", async () => {
    const f = fixture();
    f.fault("approval");
    const entry = await f.deliver();
    const duplicate = await f.deliver();
    const otherPeer = await f.deliver(f.card, "other-peer");
    const append = vi.spyOn(f.journal, "append");
    await Promise.all([f.finalize(entry), f.finalize(entry, "deny"), f.finalize(duplicate, "deny"), f.finalize(otherPeer, "deny")]);
    expect(append).toHaveBeenCalledTimes(1);
    expect(getApprovalResolution(f.channel, f.card.id)).toBe(PEER);
    expect(f.channel.sendApprovalResolved(PEER, f.card.id, "deny")).toMatchObject({ accepted: false, status: "conflict" });
    expect(f.channel.sendApprovalResolved(PEER, f.card.id, "allow-once")).toMatchObject({ accepted: true, status: "pending", journaled: false });
    f.card.id = "changed-id";
    f.card.prompt = "Changed request";
    f.card.options[0]!.label = "Changed option";
    f.recover();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(f.history()).toEqual([expect.objectContaining({ id: "approval-original", prompt: "Original request", options: [{ decision: "allow-once", label: "Allow", style: "success" }], resolvedDecision: "allow-once" })]);
    expect(f.journal.read("other-peer")).toEqual([]);
    expect(listResolvedApprovalsForPeer(ACCOUNT, PEER)).toEqual([{ id: "approval-original", decision: "allow-once" }]);
    expect(listResolvedApprovalsForPeer(ACCOUNT, "other-peer")).toEqual([]);
    expect(f.channel.sendApprovalResolved(PEER, "approval-original", "allow-once")).toMatchObject({ accepted: true, journaled: true, delivered: true });
    expect(f.journal.read(PEER)).toHaveLength(2);
  });

  it("updates pending/resolved snapshots before a successful resolution is published", async () => {
    const f = fixture();
    const entry = await f.deliver();
    const publish = f.transport.publish.bind(f.transport);
    const observed: Array<{
      pending: ReturnType<typeof listPendingApprovalsForPeer>;
      resolved: ReturnType<typeof listResolvedApprovalsForPeer>;
    }> = [];
    vi.spyOn(f.transport, "publish").mockImplementation((subject, payload) => {
      if (JSON.parse(typeof payload === "string" ? payload : Buffer.from(payload).toString()).type === "approval_resolved") {
        observed.push({ pending: listPendingApprovalsForPeer(ACCOUNT, PEER), resolved: listResolvedApprovalsForPeer(ACCOUNT, PEER) });
      }
      publish(subject, payload);
    });
    await f.finalize(entry);
    // Assert outside publish: its errors are intentionally caught by the channel.
    expect(observed).toEqual([{ pending: [], resolved: [{ id: f.card.id, decision: "allow-once" }] }]);
    expect(f.history()[0]).toMatchObject({ resolvedDecision: "allow-once" });
  });

  it("retains the caught-up request across repeated faults and recovers on the last bounded attempt", async () => {
    const f = fixture();
    f.fault("approval");
    const entry = await f.deliver();
    await f.finalize(entry);
    await vi.advanceTimersByTimeAsync(APPROVAL_OUTPUT_RETRY_DELAYS_MS[0]);
    f.fault("approvalResolution");
    await vi.advanceTimersByTimeAsync(APPROVAL_OUTPUT_RETRY_DELAYS_MS[1]);
    expect(f.journal.read(PEER).map(row => row.event.kind)).toEqual(["approval"]);
    f.history();
    f.recover();
    await vi.advanceTimersByTimeAsync(APPROVAL_OUTPUT_RETRY_DELAYS_MS[2]);
    expect(f.journal.read(PEER).map(row => row.seq)).toEqual([1, 2]);
    expect(f.history()[0]).toMatchObject({ resolvedDecision: "allow-once" });
    expect(vi.getTimerCount()).toBe(f.maintenanceTimers);
  });

  it.each(["relay-down", "publish-throws", "unregistered"] as const)("does not retry journaled output when live delivery is %s", async reason => {
    const f = fixture({ encrypted: true });
    const entry = await f.deliver();
    if (reason === "relay-down") f.transport.connected = false;
    if (reason === "publish-throws") vi.spyOn(f.transport, "publish").mockImplementation(() => { throw new Error("relay unavailable"); });
    if (reason === "unregistered") f.channel.unregisterPeer(PEER);
    const send = vi.spyOn(f.channel, "sendApprovalResolved");
    const append = vi.spyOn(f.journal, "append");
    await f.finalize(entry);
    expect(send.mock.results[0]!.value).toEqual({ accepted: true, delivered: false, journaled: true, status: "journaled" });
    expect(f.channel.getApprovalOutputRecoveryStatus().pending).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(append).toHaveBeenCalledTimes(1);
    expect(f.history()[0]).toMatchObject({ resolvedDecision: "allow-once" });
    expect(vi.getTimerCount()).toBe(f.maintenanceTimers);
  });

  it.each(["unregistered-warning", "publish-error"] as const)("preserves a committed resolution when the %s diagnostic throws", async reason => {
    const f = fixture({ encrypted: true });
    const entry = await f.deliver();
    const diagnosticError = new Error("diagnostic unavailable");
    if (reason === "unregistered-warning") {
      f.channel.unregisterPeer(PEER);
      vi.mocked(console.warn).mockImplementation(() => { throw diagnosticError; });
    } else {
      vi.spyOn(f.transport, "publish").mockImplementation(() => { throw new Error("relay unavailable"); });
      vi.mocked(console.error).mockImplementation(() => { throw diagnosticError; });
    }
    const send = vi.spyOn(f.channel, "sendApprovalResolved");
    const append = vi.spyOn(f.journal, "append");
    const finalizerErrors: unknown[] = [];
    // The SDK catches finalizer errors without retrying. The later ephemeral
    // snapshot still uses the ordinary send path and its diagnostic can throw.
    await f.finalize(entry).catch(error => { finalizerErrors.push(error); });
    expect(finalizerErrors).toEqual([diagnosticError]);
    const accepted = { accepted: true, delivered: false, journaled: true, status: "journaled" };
    expect(send.mock.results[0]!.value).toEqual(accepted);
    expect(f.channel.getApprovalOutputRecoveryStatus()).toEqual({ pending: 0, exhausted: 0, abandoned: 0, retainedBytes: 0 });
    expect(listPendingApprovalsForPeer(ACCOUNT, PEER)).toEqual([]);
    expect(listResolvedApprovalsForPeer(ACCOUNT, PEER)).toEqual([{ id: f.card.id, decision: "allow-once" }]);
    expect(f.journal.read(PEER).map(row => row.event.kind)).toEqual(["approval", "approvalResolution"]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.channel.sendApprovalResolved(PEER, f.card.id, "allow-once")).toEqual(accepted);
    expect(append).toHaveBeenCalledTimes(1);
    expect(f.journal.read(PEER).map(row => row.event.kind)).toEqual(["approval", "approvalResolution"]);
    expect(f.history()).toEqual([expect.objectContaining({ id: f.card.id, prompt: "Original request", resolvedDecision: "allow-once" })]);
    expect(f.channel.getApprovalOutputRecoveryStatus()).toEqual({ pending: 0, exhausted: 0, abandoned: 0, retainedBytes: 0 });
    expect(vi.getTimerCount()).toBe(f.maintenanceTimers);
  });

  it("bounds persistent failures and reports exhausted output without claiming journal success", async () => {
    const f = fixture();
    const entry = await f.deliver();
    f.fault("approvalResolution");
    const append = vi.spyOn(f.journal, "append");
    await f.finalize(entry);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(append).toHaveBeenCalledTimes(4);
    expect(f.channel.getApprovalOutputRecoveryStatus()).toMatchObject({ pending: 0, exhausted: 1, abandoned: 0 });
    expect(f.channel.sendApprovalResolved(PEER, f.card.id, "allow-once")).toEqual({ accepted: true, delivered: false, journaled: false, status: "exhausted" });
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('reason="exhausted"'));
    f.recover();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(append).toHaveBeenCalledTimes(4);
    expect(f.history()[0]).not.toHaveProperty("resolvedDecision");
    expect(vi.getTimerCount()).toBe(f.maintenanceTimers);
  });

  it("a throwing diagnostic cannot prevent the initial failed output from being scheduled", async () => {
    const f = fixture();
    const entry = await f.deliver();
    f.fault("approvalResolution");
    vi.mocked(console.warn).mockImplementation(() => { throw new Error("diagnostic unavailable"); });
    await expect(f.finalize(entry)).resolves.toBeUndefined();
    expect(f.channel.getApprovalOutputRecoveryStatus().pending).toBe(1);
    f.recover();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(f.history()[0]).toMatchObject({ resolvedDecision: "allow-once" });
    expect(vi.getTimerCount()).toBe(f.maintenanceTimers);
  });

  it("throwing exhaustion/disposal diagnostics cannot strand other retained outputs or abort listeners", async () => {
    const abort = new AbortController();
    const f = fixture({ context: { approvalAbortSignal: abort.signal } });
    const first = await f.deliver();
    const second = await f.deliver({ ...f.card, id: "second" });
    f.fault("approvalResolution");
    await f.finalize(first);
    await f.finalize(second);
    vi.mocked(console.warn).mockImplementation(() => { throw new Error("diagnostic unavailable"); });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.channel.getApprovalOutputRecoveryStatus()).toMatchObject({ exhausted: 2, pending: 0 });
    expect(() => f.channel.dispose()).not.toThrow();
    expect(f.channel.getApprovalOutputRecoveryStatus()).toEqual({ pending: 0, exhausted: 0, abandoned: 2, retainedBytes: 0 });
    abort.abort();
    expect(f.channel.getApprovalOutputRecoveryStatus().abandoned).toBe(2);
    expect(vi.getTimerCount()).toBe(f.maintenanceTimers);
  });

  it.each(["dispose", "close"] as const)("%s cancels queued work and an already-dequeued callback cannot publish into a replacement", async close => {
    const f = fixture();
    f.fault("approval");
    const entry = await f.deliver();
    const scheduled = vi.spyOn(globalThis, "setTimeout");
    await f.finalize(entry);
    const callback = scheduled.mock.calls.at(-1)![0] as () => void;
    f.channel[close]();
    expect(vi.getTimerCount()).toBe(f.maintenanceTimers);
    const next = fixture();
    f.replace(next.channel);
    const current = await next.deliver();
    await next.finalize(current, "deny");
    const published = next.transport.published.length;
    f.recover();
    callback();
    await f.finalize(entry, "deny");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.journal.read(PEER)).toEqual([]);
    expect(next.transport.published).toHaveLength(published);
    expect(next.history()[0]).toMatchObject({ resolvedDecision: "deny" });
    expect(f.channel.getApprovalOutputRecoveryStatus()).toEqual({ pending: 0, exhausted: 0, abandoned: 1, retainedBytes: 0 });
  });

  it("fences a late first finalizer from a replacement generation and ignores a different hook account", async () => {
    const f = fixture();
    f.fault("approval");
    const old = await f.deliver();
    f.channel.dispose();
    const next = fixture();
    f.replace(next.channel);
    await next.deliver();
    await f.spec.transport.updateEntry!({ cfg: {}, accountId: "different-account", entry: old!, payload: { decision: "deny" }, phase: "resolved" });
    expect(listPendingApprovalsForPeer(ACCOUNT, PEER)).toHaveLength(1);
    expect(next.journal.read(PEER).map(row => row.event.kind)).toEqual(["approval"]);
    expect(next.transport.published.every(row => row.payload.type === "approval_request")).toBe(true);
    expect(f.resolve.mock.calls.every(args => args[0] === ACCOUNT)).toBe(true);
  });

  it("the real approval monitor's abort cancels pending output while its channel remains alive", async () => {
    const abort = new AbortController();
    let context: unknown;
    const monitor = startClawApprovalMonitor({ accountId: ACCOUNT, abortSignal: abort.signal,
      channelRuntime: { runtimeContexts: { register: (params: { context: unknown }) => { context = params.context; return { dispose() {} }; } } },
    } as unknown as Parameters<typeof startClawApprovalMonitor>[0]);
    cleanup.push(() => abort.abort());
    const f = fixture({ context });
    f.fault("approval");
    const entry = await f.deliver();
    const lateEntry = await f.deliver({ ...f.card, id: "late" });
    await f.finalize(entry);
    abort.abort();
    await monitor;
    expect(vi.getTimerCount()).toBe(f.maintenanceTimers);
    expect(f.channel.getApprovalOutputRecoveryStatus()).toMatchObject({ abandoned: 1, retainedBytes: 0 });
    f.recover();
    await f.finalize(lateEntry);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.journal.read(PEER)).toEqual([]);
    expect(f.channel.sendText(PEER, "Channel still active", "ordinary-output")).toBe(true);
  });

  it("distinguishes no active channel at finalization from a recoverable store fault", async () => {
    const f = fixture();
    f.replace(undefined);
    const entry = await f.deliver();
    await f.finalize(entry, "deny");
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("no active output recovery owner"));
    expect(listPendingApprovalsForPeer(ACCOUNT, PEER)).toEqual([]);
    expect(listResolvedApprovalsForPeer(ACCOUNT, PEER)).toEqual([{ id: f.card.id, decision: "deny" }]);
    f.replace(f.channel);
    await f.finalize(entry);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.journal.read(PEER)).toEqual([]);
    expect(vi.getTimerCount()).toBe(f.maintenanceTimers);
  });

  it.each(["resolved", "expired"] as const)("catches up an unavailable delivery, then recovers a %s denial", async phase => {
    const f = fixture();
    f.replace(undefined);
    const entry = await f.deliver();
    f.replace(f.channel);
    f.fault("approvalResolution");
    await f.finalize(entry, "deny", phase);
    f.recover();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(f.journal.read(PEER).map(row => row.event.kind)).toEqual(["approval", "approvalResolution"]);
    expect(f.history()[0]).toMatchObject({ resolvedDecision: "deny" });
  });

  it("keeps the entry's original request after snapshot-store eviction", async () => {
    const f = fixture();
    f.fault("approval");
    const entry = await f.deliver();
    __pendingApprovalsTestHook.clear(); // Same state seen after the bounded store evicts this entry.
    await f.finalize(entry);
    f.recover();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(f.history()[0]).toMatchObject({ id: f.card.id, prompt: "Original request", resolvedDecision: "allow-once" });
  });

  it("caps retained bytes and leaves an abandoned first-winner tombstone", async () => {
    const f = fixture();
    f.fault("approval");
    const entry = await f.deliver({ ...f.card, prompt: "x".repeat(APPROVAL_OUTPUT_PENDING_BYTES + 1) });
    await f.finalize(entry);
    expect(f.channel.getApprovalOutputRecoveryStatus()).toEqual({ pending: 0, exhausted: 0, abandoned: 1, retainedBytes: 0 });
    f.recover();
    expect(f.channel.sendApprovalResolved(PEER, f.card.id, "allow-once")).toMatchObject({ status: "abandoned", journaled: false });
    expect(f.channel.sendApprovalResolved(PEER, f.card.id, "deny")).toMatchObject({ status: "conflict", accepted: false });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.journal.read(PEER)).toEqual([]);
  });

  it("caps retained output count with one timer and reports capacity eviction as failure", async () => {
    const f = fixture();
    f.fault("approval");
    for (let i = 0; i <= APPROVAL_OUTPUT_PENDING_CAP; i++) {
      await f.finalize(await f.deliver({ ...f.card, id: `bounded-${i}` }));
      f.transport.published.length = 0;
    }
    expect(vi.getTimerCount()).toBe(f.maintenanceTimers + 1);
    expect(f.channel.getApprovalOutputRecoveryStatus()).toMatchObject({ pending: APPROVAL_OUTPUT_PENDING_CAP, abandoned: 1 });
    expect(f.channel.getApprovalOutputRecoveryStatus().retainedBytes).toBeLessThanOrEqual(APPROVAL_OUTPUT_PENDING_BYTES);
    f.recover();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(f.channel.getApprovalOutputRecoveryStatus()).toEqual({ pending: 0, exhausted: 0, abandoned: 1, retainedBytes: 0 });
    expect(f.journal.maxSeq(PEER)).toBe(APPROVAL_OUTPUT_PENDING_CAP * 2);
    expect(f.channel.sendApprovalResolved(PEER, "bounded-0", "allow-once")).toMatchObject({ status: "abandoned", journaled: false });
  });

  it("processes at most the visible retry batch in one scheduled callback", async () => {
    const f = fixture();
    f.fault("approval");
    const scheduled = vi.spyOn(globalThis, "setTimeout");
    for (let i = 0; i <= APPROVAL_OUTPUT_RETRY_BATCH; i++) await f.finalize(await f.deliver({ ...f.card, id: `batch-${i}` }));
    const callback = scheduled.mock.calls.at(-1)![0] as () => void;
    f.recover();
    vi.setSystemTime(Date.now() + 1_000);
    callback();
    expect(f.journal.maxSeq(PEER)).toBe(APPROVAL_OUTPUT_RETRY_BATCH * 2);
    expect(f.channel.getApprovalOutputRecoveryStatus().pending).toBe(1);
    callback(); // The old callback's timer identity cannot acquire the queue again.
    expect(f.journal.maxSeq(PEER)).toBe(APPROVAL_OUTPUT_RETRY_BATCH * 2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(f.channel.getApprovalOutputRecoveryStatus().pending).toBe(0);
  });
});
