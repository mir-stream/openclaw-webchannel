import { randomUUID } from "node:crypto";
import type { BoundedInboundDebouncer } from "./bounded-inbound-debouncer.js";
import type { DeliveryJournal } from "./delivery-journal.js";
import type { DispatchRecovery } from "./dispatch-recovery.js";
import type { StopPendingInput } from "./channel-contract.js";
import { ingressIdentity, type IngressDedupeItem } from "./ingress-dedupe.js";

/** Server-owned control receipts. SQLite commit is the cancellation boundary;
 * core abort is a one-time live signal, never restart/retransmission work. */
export function createStopControl<Item extends IngressDedupeItem & { message: { cancel_pending?: StopPendingInput[] } }>(deps: {
  journal: DeliveryJournal;
  recovery: DispatchRecovery;
  debouncer: Pick<BoundedInboundDebouncer<Item>, "retainedItems" | "cancelKey">;
  sendAck: DeliveryAck;
  pendingOverflowKey(peer: string): string | undefined;
  retireOverflow(peer: string): void;
  dispatchControl(peer: string, message: Item["message"]): Promise<void>;
  isActive(): boolean;
  warn(error: unknown): void;
}) {
  const pending = new Map<string, Promise<void>>();
  let disposed = false;
  const active = () => !disposed && deps.isActive() && deps.recovery.owns();
  const warn = (error: unknown) => { try { deps.warn(error); } catch { /* diagnostics */ } };
  const ack = (item: Item, cancelled = false) => {
    const identity = ingressIdentity(item);
    if (!identity || !active()) return;
    const row = deps.journal.lookupUserMessageIdByRandomId(item.peerId, identity.idempotencyKey);
    const committed = row && identity.randomId !== undefined ? [{ random_id: identity.randomId, ...row }] : undefined;
    const ids = [identity.wireId];
    // #398: the server, not the client, declares that a cancelled input was never
    // accepted. A read fault omits only the declaration, never the receipt.
    let neverAccepted = false;
    if (cancelled) {
      try { neverAccepted = deps.journal.dispatch!.isUnaccepted(item.peerId, identity.idempotencyKey); }
      catch (error) { warn(error); }
    }
    const sent = !cancelled ? deps.sendAck(item.peerId, ids, committed)
      : neverAccepted ? deps.sendAck(item.peerId, ids, committed, ids, ids)
        : deps.sendAck(item.peerId, ids, committed, ids);
    if (!sent) warn(new Error("webchannel: control receipt delivery failed"));
  };
  /** One frame for the named earlier inputs this stop cancelled before acceptance.
   * An accepted one keeps its ordinary receipt; its row reports the cancellation. */
  const ackPending = (peer: string, named: IngressDedupeItem[], cancelledKeys: readonly string[]) => {
    if (!active()) return;
    const keys = new Set(cancelledKeys);
    const ids = named.flatMap(entry => {
      const identity = ingressIdentity(entry)!;
      return keys.has(identity.idempotencyKey) ? [identity.wireId] : [];
    });
    if (ids.length && !deps.sendAck(peer, ids, undefined, ids, ids)) {
      warn(new Error("webchannel: control receipt delivery failed"));
    }
  };
  return {
    handle(item: Item, cancelBuffered: boolean) {
      const peer = item.peerId;
      try {
        if (!active()) return;
        const key = ingressIdentity(item)?.idempotencyKey ?? randomUUID();
        const previous = deps.journal.dispatch!.lookupStop(peer, key);
        if (previous) { ack(item); return previous; }
        // #398: a later stop already named this one as earlier input. Running it
        // now could only reach work sent after that later stop.
        if (deps.journal.dispatch!.isCancelled(peer, key)) { ack(item, true); return; }
        // #397: at most one core control invocation per peer. A different stop
        // that arrives while it is busy joins it: its own receipt and targets
        // commit now, so a retransmission after the abort returns finds this
        // receipt instead of cancelling a turn started later.
        const joining = pending.has(peer);
        const buffered = cancelBuffered ? deps.debouncer.retainedItems(peer) : [];
        const targets = buffered.flatMap(entry => {
          const identity = ingressIdentity(entry);
          return identity ? [identity.idempotencyKey] : [];
        });
        // The bounded overflow resolver can own an ID with no reservation or
        // dispatch row. Capture it in the same transaction before retiring it.
        const overflowKey = cancelBuffered ? deps.pendingOverflowKey(peer) : undefined;
        if (overflowKey !== undefined) targets.push(overflowKey);
        // #398: earlier input the client has no receipt for yet, which can still
        // reach this server after the stop. Only the explicit command names it.
        const covered = new Set(targets);
        const named = (cancelBuffered ? item.message.cancel_pending ?? [] : []).flatMap(entry => {
          const pendingItem: IngressDedupeItem = { peerId: peer, message: entry };
          const identity = ingressIdentity(pendingItem);
          return identity && identity.idempotencyKey !== key && !covered.has(identity.idempotencyKey) ? [pendingItem] : [];
        });
        const receipt = deps.recovery.recordStop(peer, key, targets, cancelBuffered,
          named.map(entry => ingressIdentity(entry)!.idempotencyKey));
        if (!receipt.fresh) { ack(item); return receipt; }

        const retire = () => {
          if (!cancelBuffered) return;
          // No callback or await between durable target capture and retirement.
          // Async outcome-store cancellation is no longer an ACK dependency.
          deps.debouncer.cancelKey(peer, { notify: false });
          deps.retireOverflow(peer);
          deps.recovery.retirePeer(peer);
          deps.recovery.signalStop(peer);
        };
        const publish = () => {
          if (!cancelBuffered) return;
          deps.recovery.publishStop(peer, key);
          for (const entry of buffered) ack(entry, true);
          ackPending(peer, named, receipt.pendingCancelled ?? []);
        };
        if (joining) {
          // The in-flight lease still holds new starts until that abort returns.
          retire();
          publish();
          ack(item);
          return receipt;
        }

        // Hold new starts until core's async session-wide abort has returned.
        // The abort must never land on a later turn after the old one settles.
        const lease = deps.recovery.dispatcher.beginBatch(peer);
        let finish!: () => void;
        const settled = new Promise<void>(resolve => { finish = resolve; });
        pending.set(peer, settled);
        const release = () => {
          pending.delete(peer);
          try { lease.finish(); } catch (error) { warn(error); }
          finally { finish(); }
        };
        try {
          retire();
          const core = deps.dispatchControl(peer, item.message);
          void core.catch(warn).finally(release);
        } catch (error) { release(); warn(error); }
        publish();
        ack(item);
        return receipt;
      } catch (error) { warn(error); return; } // No receipt on storage failure.
    },
    async dispose() {
      disposed = true;
      // Account replacement waits too: a late session-wide core abort from an
      // old runtime cannot be allowed to reach the replacement's new turn.
      await Promise.all(pending.values());
    },
  };
}
type DeliveryAck = (peer: string, ids: string[], committed?: Array<{ random_id: string; messageId: string; seq: number }>, cancelled?: string[], unaccepted?: string[]) => boolean;
