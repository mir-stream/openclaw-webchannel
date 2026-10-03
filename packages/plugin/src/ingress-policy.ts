import type { DeliveryJournal } from "./delivery-journal.js";
import { ingressIdentity, type IngressDedupeItem } from "./ingress-dedupe.js";
import type { CommittedUserMessage } from "./ingress-result-chunks.js";

/** The runtime calls this before either normal retention or control admission. */
export function createIngressPolicyGate(deps: {
  journal: DeliveryJournal;
  isAllowed(peerId: string): boolean;
  onFreshDenied?(peerId: string): void;
  sendRejected(peerId: string, ids: string[]): boolean;
  sendAck(peerId: string, ids: string[], committed?: CommittedUserMessage[], cancelled?: string[], unaccepted?: string[]): boolean;
  warn(error: unknown): void;
}): (item: IngressDedupeItem) => boolean {
  const warn = (error: unknown) => { try { deps.warn(error); } catch { /* diagnostics */ } };
  return (item) => {
    try {
      if (deps.isAllowed(item.peerId)) return true;
      const identity = ingressIdentity(item);
      if (!identity) return false; // No usable wire ID: no invented receipt.
      const key = identity.idempotencyKey;
      // Policy applies to new input. A previous acceptance/cancellation must
      // keep its exact receipt even after a config change or a lost ACK. Replay
      // it here: forwarding the incoming text could turn an old normal message
      // into a fresh /stop (or the reverse) under an already accepted ID.
      const row = deps.journal.lookupUserMessageIdByRandomId(item.peerId, key);
      const dispatch = deps.journal.dispatch;
      if (!dispatch) throw new Error("webchannel: ingress policy requires dispatch receipts");
      const stopped = dispatch.lookupStop(item.peerId, key);
      const cancelled = dispatch.isCancelled(item.peerId, key);
      const converged = row ? undefined : dispatch.convergence(item.peerId, key);
      if (row || stopped || cancelled || converged) {
        const committed: CommittedUserMessage[] | undefined = identity.randomId === undefined ? undefined
          : row ? [{ random_id: identity.randomId, ...row }]
            : converged ? [{ random_id: identity.randomId, messageId: converged.messageId, converged: true }] : undefined;
        let unaccepted = false;
        if (cancelled) {
          try { unaccepted = dispatch.isUnaccepted(item.peerId, key); }
          catch (error) { warn(error); } // Optional evidence must not invent nonacceptance.
        }
        const ids = [identity.wireId];
        if (!deps.sendAck(item.peerId, ids, committed, cancelled ? ids : undefined, unaccepted ? ids : undefined)) {
          warn(new Error("webchannel: ingress policy replay receipt delivery failed"));
        }
        return false;
      }
      // A refusal is not an accepted durable message or a permanent tombstone.
      // A later policy change may admit the same logical input; this attempt
      // gets only a correlated generic rejection, with no policy configuration.
      if (!deps.sendRejected(item.peerId, [identity.wireId])) {
        warn(new Error("webchannel: ingress policy rejection delivery failed"));
      }
      deps.onFreshDenied?.(item.peerId);
    } catch (error) {
      // Unknown acceptance cannot be truthfully classified as a fresh refusal.
      // Withhold both admission and receipt so a later retry can resolve it.
      warn(error);
    }
    return false;
  };
}
