import type { DispatchChange, DispatchInput, DispatchRow, DispatchStore } from "./dispatch-store.js";
import { coalesceUserMessages, createSerializedInboundDispatcher, type BatchOffer, type DispatcherBatchLease, type SerializedInboundDispatcher, type SerializedInboundDispatcherOptions, type UserMessageLike, type CoalescedMemberIds } from "./inbound-queue.js";

type DispatchMember = { key: string } | { legacy: UserMessageLike; token: { active: boolean } };
type Message = UserMessageLike & CoalescedMemberIds & { dispatchKeys?: readonly string[]; dispatchMembers?: readonly DispatchMember[] };
const keyFor = (m: Message) => m.random_id ?? m.id;
const messageFor = (row: DispatchRow): Message => ({ type: "user_message", text: row.input.text, id: row.input.turnId, ...(row.input.randomId ? { random_id: row.input.randomId } : {}), ...(row.input.retryOf ? { retry_of: row.input.retryOf } : {}), dispatchKeys: [row.key] });

/** One runtime owns bounded offers; SQLite owns accepted work across runtimes. */
export function createDispatchRecovery(options: {
  store: DispatchStore;
  handler: (peer: string, message: Message, settle: (outcome: "ok" | "error") => boolean, ownership?: { owner: string; batch: string; abortSignal: AbortSignal }) => Promise<void>;
  acquirePeer: (peer: string) => (() => void) | undefined;
  notify: (change: DispatchChange) => void;
  isActive: () => boolean;
  warn: (error: unknown) => void;
  dispatcherOptions?: SerializedInboundDispatcherOptions<Message>;
}) {
  const { store } = options;
  const warn = (error: unknown) => { try { options.warn(error); } catch { /* diagnostics cannot strand recovery */ } };
  let owner: string | undefined;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let peerCursor = "";
  const legacyPending = new Map<string, Set<{ active: boolean }>>();
  const releaseLegacy = (peer: string, token: { active: boolean }) => {
    const set = legacyPending.get(peer); set?.delete(token);
    if (!set?.size) legacyPending.delete(peer);
  };
  const cancelLegacy = (peer: string) => { for (const token of legacyPending.get(peer) ?? []) token.active = false; legacyPending.delete(peer); };
  const running = new Map<string, AbortController>();
  const scheduled = new Map<string, Set<string>>();
  const active = () => !disposed && owner !== undefined && options.isActive() && store.owns(owner);
  const ids = (peer: string) => {
    let set = scheduled.get(peer);
    if (!set) { set = new Set(); scheduled.set(peer, set); }
    return set;
  };
  const forget = (peer: string, keys: readonly string[]) => {
    const set = scheduled.get(peer);
    for (const key of keys) set?.delete(key);
    if (!set?.size) scheduled.delete(peer);
  };
  const notify = (changes: DispatchChange[]) => {
    for (const change of changes) { try { options.notify(change); } catch { /* Difference/history remains authoritative. */ } }
  };
  const dispatcher: SerializedInboundDispatcher<Message> = createSerializedInboundDispatcher(async (peer, offered) => {
    const members = offered.dispatchMembers ?? [];
    const keys = offered.dispatchKeys ?? [];
    let releasePeer: (() => void) | undefined;
    let rows: DispatchRow[] = [];
    let settled = false;
    try {
      if (!active()) return;
      releasePeer = options.acquirePeer(peer);
      if (!releasePeer) return; // No default key, no register/authentication bypass.
      rows = keys.length ? store.claim(owner!, peer, keys) : [];
      const byKey = new Map(rows.map(row => [row.key, row]));
      const inputs = members.flatMap(member => "key" in member
        ? (byKey.has(member.key) ? [messageFor(byKey.get(member.key)!)] : [])
        : member.token.active ? [member.legacy] : []);
      if (!inputs.length) return;
      const message = coalesceUserMessages(inputs);
      if (!rows.length) { await options.handler(peer, message, () => active()); return; }
      const batch = rows[0]!.batch!;
      const settle = (outcome: "ok" | "error") => {
        if (!active()) return false;
        const changes = store.settle(owner!, peer, batch, outcome === "ok" ? "completed" : "failed");
        settled = true;
        notify(changes);
        return changes.length > 0;
      };
      const abort = new AbortController();
      running.set(peer, abort);
      notify(rows.map(row => ({ peerId: peer, id: row.messageId, turnId: row.input.turnId, state: "started", seq: row.stateSeq! })));
      // Publishing is a callout: stop/dispose may invalidate the just-claimed batch.
      // There is no await or callout between this recheck and handler invocation.
      if (!active() || abort.signal.aborted || rows.some(row => store.lookup(peer, row.key)?.state !== "started")) return;
      await options.handler(peer, message, settle, { owner: owner!, batch, abortSignal: abort.signal });
    } catch (error) { warn(error); }
    finally {
      try {
        if (rows.length && !settled && active()) notify(store.settle(owner!, peer, rows[0]!.batch!, "interrupted"));
      } catch (error) { warn(error); }
      for (const member of members) if ("legacy" in member) releaseLegacy(peer, member.token);
      running.delete(peer);
      releasePeer?.();
      forget(peer, keys);
      schedule();
    }
  }, {
    ...options.dispatcherOptions,
    coalesce: (messages) => ({ ...coalesceUserMessages(messages), dispatchKeys: messages.flatMap(m => m.dispatchKeys ?? []), dispatchMembers: messages.flatMap(m => m.dispatchMembers ?? []) }),
  });

  const offerInto = (lease: DispatcherBatchLease<Message>, peer: string, message: Message, reservation?: Parameters<DispatcherBatchLease<Message>["offer"]>[1]): BatchOffer => {
    const key = keyFor(message);
    if (!key) {
      const token = { active: true };
      const offer = lease.offer({ ...message, dispatchMembers: [{ legacy: message, token }] }, reservation);
      if (offer.status !== "accepted") return offer;
      const set = legacyPending.get(peer) ?? new Set<{ active: boolean }>();
      set.add(token); legacyPending.set(peer, set);
      return { status: "accepted", commit: offer.commit, rollback: () => { token.active = false; releaseLegacy(peer, token); offer.rollback(); } };
    }
    if (scheduled.get(peer)?.has(key)) return { status: "accepted", commit: () => { reservation?.requestRelease(); }, rollback: () => { reservation?.requestRelease(); } };
    const offer = lease.offer({ ...message, dispatchKeys: [key], dispatchMembers: [{ key }] }, reservation);
    if (offer.status !== "accepted") return offer;
    ids(peer).add(key);
    return { status: "accepted", commit: offer.commit, rollback: () => { forget(peer, [key]); offer.rollback(); } };
  };
  const pumpPeer = (peer: string): boolean => {
    if (!active()) return false;
    const lease = dispatcher.beginBatch(peer);
    try {
      // Scheduled entries count against the existing dispatcher budget. Page past
      // them so newer work can fill only the remaining bounded capacity.
      let after = 0;
      for (;;) {
        const rows = store.queued(peer, after, 32);
        if (!rows.length) return true;
        for (const row of rows) {
          after = row.seq;
          if (scheduled.get(peer)?.has(row.key)) continue;
          const offer = offerInto(lease, peer, messageFor(row));
          if (offer.status !== "accepted") return false;
          offer.commit();
        }
        if (rows.length < 32) return true;
      }
    } finally { lease.finish(); }
  };
  const tick = () => {
    timer = undefined;
    try {
      if (!active()) return;
      // Recovery of uncertain state is bounded too; repeat without a client retry.
      const changes = store.recoverInterrupted(owner!);
      notify(changes);
      const peers = store.peers(peerCursor, 32);
      for (const peer of peers) pumpPeer(peer);
      peerCursor = peers.length === 32 ? peers.at(-1)! : "";
    } catch (error) { warn(error); }
    schedule();
  };
  function schedule() {
    if (disposed || timer || !owner) return;
    timer = setTimeout(tick, 100);
    timer.unref?.();
  }
  return {
    start() {
      if (owner || disposed) return;
      owner = store.activate();
      tick();
    },
    accept(peer: string, inputs: DispatchInput[]) {
      if (!active()) throw new Error("webchannel: dispatch recovery is not active");
      return store.accept(owner!, peer, inputs);
    },
    beginBatch(peer: string): DispatcherBatchLease<Message> {
      // Older accepted rows enter the FIFO before a newly arriving same-peer send.
      const caughtUp = pumpPeer(peer);
      const lease = dispatcher.beginBatch(peer);
      return { offer: (m, r) => !active() ? { status: "disposed" }
        : !caughtUp ? { status: "rejected", reason: "session-message-count" }
        : offerInto(lease, peer, m, r), finish: () => { lease.finish(); schedule(); } };
    },
    cancel(peer: string) {
      if (!active()) return;
      for (;;) {
        const changes = store.cancel(owner!, peer);
        notify(changes);
        if (changes.length < 32) break;
      }
      cancelLegacy(peer);
      running.get(peer)?.abort();
    },
    retirePeer(peer: string) { cancelLegacy(peer); dispatcher.clearPending(peer); scheduled.delete(peer); schedule(); },
    owns: active,
    dispatcher,
    dispose() { disposed = true; for (const abort of running.values()) abort.abort(); running.clear(); legacyPending.clear(); if (timer) clearTimeout(timer); timer = undefined; scheduled.clear(); dispatcher.dispose(); },
  };
}
export type DispatchRecovery = ReturnType<typeof createDispatchRecovery>;
