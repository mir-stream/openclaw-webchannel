import { randomUUID } from "node:crypto";
import type { BoundedInboundDebouncer } from "./bounded-inbound-debouncer.js";
import type { DeliveryJournal } from "./delivery-journal.js";
import type { DispatchRecovery } from "./dispatch-recovery.js";
import { ingressIdentity, type IngressDedupeItem } from "./ingress-dedupe.js";

/** Server-owned control receipts. SQLite commit is the cancellation boundary;
 * core abort is a one-time live signal, never restart/retransmission work. */
export function createStopControl<Item extends IngressDedupeItem>(deps: {
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
    if (!deps.sendAck(item.peerId, [identity.wireId], row && identity.randomId !== undefined
      ? [{ random_id: identity.randomId, ...row }] : undefined,
      cancelled ? [identity.wireId] : undefined)) warn(new Error("webchannel: control receipt delivery failed"));
  };
  return {
    handle(item: Item, cancelBuffered: boolean) {
      const peer = item.peerId;
      try {
        if (!active()) return;
        const key = ingressIdentity(item)?.idempotencyKey ?? randomUUID();
        const previous = deps.journal.dispatch!.lookupStop(peer, key);
        if (previous) { ack(item); return previous; }
        // At most one core control invocation per peer. A different command
        // retries without ACK while it is busy; duplicates already have receipts.
        if (pending.has(peer)) return;
        const buffered = cancelBuffered ? deps.debouncer.retainedItems(peer) : [];
        const targets = buffered.flatMap(entry => {
          const identity = ingressIdentity(entry);
          return identity ? [identity.idempotencyKey] : [];
        });
        // The bounded overflow resolver can own an ID with no reservation or
        // dispatch row. Capture it in the same transaction before retiring it.
        const overflowKey = cancelBuffered ? deps.pendingOverflowKey(peer) : undefined;
        if (overflowKey !== undefined) targets.push(overflowKey);
        const receipt = deps.recovery.recordStop(peer, key, targets, cancelBuffered);
        if (!receipt.fresh) { ack(item); return receipt; }

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
          if (cancelBuffered) {
            // No callback or await between durable target capture and retirement.
            // Async outcome-store cancellation is no longer an ACK dependency.
            deps.debouncer.cancelKey(peer, { notify: false });
            deps.retireOverflow(peer);
            deps.recovery.retirePeer(peer);
            deps.recovery.signalStop(peer);
          }
          const core = deps.dispatchControl(peer, item.message);
          void core.catch(warn).finally(release);
        } catch (error) { release(); warn(error); }
        if (cancelBuffered) {
          deps.recovery.publishStop(peer, key);
          for (const entry of buffered) ack(entry, true);
        }
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
type DeliveryAck = (peer: string, ids: string[], committed?: Array<{ random_id: string; messageId: string; seq: number }>, cancelled?: string[]) => boolean;
