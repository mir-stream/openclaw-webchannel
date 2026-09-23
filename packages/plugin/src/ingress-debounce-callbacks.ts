import type { BoundedInboundDebouncerOptions } from "./bounded-inbound-debouncer.js";
import type { CancelledInboundFallbackTombstones, IngressDedupeItem } from "./ingress-dedupe.js";
import { ingressDedupeKey, ingressIdentity } from "./ingress-dedupe.js";
import type { DeliveryJournal } from "./delivery-journal.js";
import type { IngressOutcomeStore } from "./ingress-outcome.js";
import type { BoundedOverflowResolver } from "./inbound-overflow-resolver.js";
import type { RetentionSessionToken } from "./inbound-retention.js";

type CallbackOptions<Item> = Pick<BoundedInboundDebouncerOptions<Item>,
  "getId" | "getDedupeKey" | "isOverflowClaimed" | "onOverflowClaimed" | "isCancelledFallback" | "peekOutcome" | "onKnownOutcome" | "onOverflow"
>;

/** The account runtime's pre-debounce and overflow wiring, shared with integration tests. */
export function createIngressDebounceCallbacks<Item extends IngressDedupeItem>(deps: {
  accountId: string;
  outcomeStore: IngressOutcomeStore;
  overflowResolver: BoundedOverflowResolver;
  cancelledFallback: CancelledInboundFallbackTombstones;
  deliveryJournal: Pick<DeliveryJournal, "lookupUserMessageIdByRandomId" | "dispatch">;
  sessionToken(peerId: string): RetentionSessionToken;
  sendAck(peerId: string, ids: string[], committed?: Array<{ random_id: string; messageId: string; seq: number }>): boolean;
  sendRejected(peerId: string, ids: string[]): boolean;
  onPressure?: BoundedInboundDebouncerOptions<Item>["onOverflow"];
}): CallbackOptions<Item> {
  const { accountId, outcomeStore, overflowResolver, cancelledFallback } = deps;
  return {
    getId: (item) => ingressIdentity(item)?.wireId,
    getDedupeKey: ingressDedupeKey,
    isOverflowClaimed: (peerId, key) => !deps.deliveryJournal.dispatch?.isCancelled(peerId, key.slice(peerId.length + 1)) && overflowResolver.hasActiveClaim(accountId, key),
    onOverflowClaimed: (item) => {
      const identity = ingressIdentity(item)!;
      overflowResolver.tryStart({
        accountId, peerId: item.peerId, id: identity.wireId, key: identity.key,
        randomId: identity.randomId, sessionToken: deps.sessionToken(item.peerId),
        recoverCancelled: cancelledFallback.has(identity.key, accountId),
      });
    },
    isCancelledFallback: (peerId, key) => !deps.deliveryJournal.dispatch?.isCancelled(peerId, key.slice(peerId.length + 1)) && cancelledFallback.has(key, accountId),
    peekOutcome: (peerId, key) => deps.deliveryJournal.dispatch?.isCancelled(peerId, key.slice(peerId.length + 1))
      ? "cancelled" : outcomeStore.peek(accountId, key),
    onKnownOutcome: (peerId, id, outcome, item) => {
      if (outcome === "overloaded") deps.sendRejected(peerId, [id]);
      else {
        // Cancellation needs no row for its verdict, but may have a committed
        // row from before /stop. Preserve its echo even on the hot-cache path.
        const identity = ingressIdentity(item)!;
        let row;
        try {
          row = deps.deliveryJournal.lookupUserMessageIdByRandomId(peerId, identity.idempotencyKey);
        } catch { /* A journal fault does not undo a known cancellation. */ }
        deps.sendAck(peerId, [id], row && identity.randomId !== undefined
          ? [{ random_id: identity.randomId, ...row }]
          : undefined);
      }
    },
    onOverflow: (params) => {
      deps.onPressure?.(params);
      // A waiting/inflight original (including cancellation) owns the verdict.
      // This alias has no reservation: leave it for retry instead of racing that
      // owner with an independent durable overload decision.
      if (params.deferToRetained) return;
      const { key: peerId, item, recoverCancelled } = params;
      const identity = ingressIdentity(item);
      if (!identity) return;
      overflowResolver.tryStart({
        accountId, peerId, id: identity.wireId, key: identity.key, randomId: identity.randomId,
        sessionToken: deps.sessionToken(peerId), recoverCancelled,
      });
    },
  };
}
