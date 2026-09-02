/**
 * P0-7a — browser→agent ingress idempotency (first half).
 *
 * A `user_message` frame now carries a stable, client-minted `id`. This helper
 * decides, for a flush batch, which items are FRESH (first time we have seen
 * their `${peerId}:${id}`) versus duplicates that must be dropped before they run
 * a turn. It is the pure, tsc- and vitest-covered core of the dedupe seam;
 * `index-nats.ts` owns only the `createPersistentDedupe` instance and calls this.
 *
 * Why record-at-ingress (`createPersistentDedupe.checkAndRecord`) and NOT
 * claim/commit (`createClaimableDedupe`, the model the gap doc sketches):
 *   (a) a processing failure already surfaces to the user via the error-finalize
 *       path, and a human retry is a NEW id — so there is nothing to roll back;
 *   (b) the P1-8b coalesce merge collapses the batch to ONE message (first
 *       frame's fields, LAST frame's `id` as the turn anchor), so a per-id
 *       rollback after a merged-turn failure would be lossy anyway; and
 *   (c) claim/commit's in-flight waiting guards a concurrent same-key race that
 *       cannot happen here — this runs inside the debouncer's `onFlush`, which is
 *       same-peer serialized by core's keyChains, so checks are already ordered.
 *
 * THE CRASH WINDOW (deliberate at-most-once tradeoff — stated honestly).
 * `checkAndRecord` records the id BEFORE the turn runs. So there is a narrow
 * window — from the record to the turn actually starting — where a PROCESS CRASH
 * used to lose the message permanently: on restart the P0-7b replay queue
 * re-sends the SAME id, we saw it as already-recorded, and dropped it — deduping
 * away the very message the replay queue exists to recover. We accepted this
 * because the alternative (claim/commit: record only AFTER the turn's effect
 * persists) trades this rare case for a far worse-in-practice one — it RE-ADMITS
 * duplicates on every crash-AFTER-effect and every partial-delivery, which are
 * much more common than crash-in-window, and rationale (b) means a per-id
 * commit/rollback is wrong for merged turns anyway. Crucially the loss window
 * here is record→turn-start — sub-millisecond on the serialized flush path —
 * versus the wide duplicate-turn window claim/commit would open
 * (record→effect-persisted, spanning the whole agent run). Narrow at-most-once
 * beats wide at-least-once for this surface. That deviation from the sketch is
 * deliberate and settled, and the ORDER is unchanged.
 *
 * ⚠️ WHAT CHANGED IS THAT THE WINDOW NOW HEALS (#344), FOR MOST OF IT. The
 * production outcome/lease branch no longer treats an `accepted` marker as proof
 * of an accept: the journal is the SSOT (doc §15.7), so when a marker has no
 * journal row for the item's `random_id`, the replay is RE-ADMITTED — journaled,
 * dispatched, acked with a fresh `committed` echo — instead of being re-acked as
 * a duplicate. A crash anywhere between the marker and the row is therefore
 * recovered by the client's very next replay. See the found/accepted branch in
 * the item loop and the footer's ordering block (which also states the cost:
 * a marker with no row re-runs its turn ONCE).
 *
 * ⚠️ AND IT IS ONLY SAFE BECAUSE `cancelled` IS ITS OWN OUTCOME — the first
 * version of this fix was wrong here, so the reason is worth keeping. "Marker,
 * no row" is NOT only the crash window: the three `/stop` suppression writers
 * (`nats-account-runtime.ts`'s `onCancel`, this file's cancelled-inbound
 * fallback, `inbound-overflow-resolver.ts`'s `recoverCancelled`) write a marker
 * and DELIBERATELY no row. While they spelled that `accepted`, the two states
 * were byte-identical, and a cancelled message whose ack was lost — `sendAck`
 * returned false, or the peer was offline and the at-most-once `.out` frame
 * evaporated — came back on reconnect and was RE-ADMITTED: `/stop` undone, the
 * killed turn run. They now record `cancelled` (`ingress-outcome.ts`), which the
 * found branch drops with an ack and never re-admits. The journal answers "was
 * this accepted?"; only the outcome can answer "was it ever meant to be?".
 *
 * ⚠️ MIGRATION, NARROW BUT REAL. A cancellation recorded by a build BEFORE this
 * change sits in the `accepted` namespace and stays ambiguous for that marker's
 * 7-day TTL: if that same message's ack was ALSO lost, its next replay finds
 * `accepted` with no row and re-runs the turn once. It needs a pre-upgrade
 * cancellation AND a lost ack AND a replay inside the TTL. Not repaired on
 * purpose — the two namespaces cannot be told apart after the fact, and
 * re-running one aborted turn is the lesser error than re-introducing the drop
 * this slice exists to remove.
 *
 * ⚠️ THREE THINGS THE HEALING DOES NOT COVER, so this heading is not retired.
 *  1. AN ITEM WITH NO `random_id`. Its journal row is keyed by the wire id, and
 *     this seam does NOT query the journal by that — a scope choice, not a
 *     limit: `appendInboundUser` stores `idempotency_key = randomId ?? turnId`
 *     and `lookupUserMessageIdByRandomId` reads that same column, so the wire id
 *     WOULD resolve an older client's row. It is not passed because the echo
 *     this branch feeds is keyed by `random_id` and an older client has none, so
 *     widening it buys an existence check and nothing else. The marker still
 *     wins for those items; extending the check to the wire id is a follow-up,
 *     not an impossibility.
 *  2. THE ID-LESS ADMIT PATH. No usable wire id ⇒ no dedupe key ⇒ neither a
 *     marker nor a row is ever written for it, so there is nothing here to heal;
 *     the item is admitted un-deduped and reported as a gap exactly as before
 *     (see `journalGap("no-usable-id")` and its call site for the owning issue).
 *  3. THE LEGACY BOOLEAN-DEDUPE BRANCH at the bottom of this file
 *     (`filterFreshInboundItems`), which has no journal and no outcome store —
 *     it still drops a crash-window replay exactly as the paragraph above
 *     describes.
 */

/**
 * Upper bound on a dedupe-able client `id`. Honest client ids are short random
 * tokens (see `randomInboxToken` in packages/client/src/nats-client.ts), so 128
 * is generous. The wire does NOT validate `id` — `InboundWsMessage` types it
 * `id?: string`, but a hostile peer can send a non-string or a ~1MB string, and
 * a recorded id is persisted as a dedupe key in per-account SQLite (7-day TTL,
 * up to stateMaxEntries). So we treat a non-string or over-length id as ID-LESS
 * (pass through un-deduped, never recorded) rather than persisting it — bounding
 * the storage-amplification surface to conforming clients.
 *
 * ⚠️ DERIVED FROM `MAX_INBOUND_USER_ID_LENGTH`, NOT REPEATED AS `128`, AND THAT
 * IS LOAD-BEARING SINCE #239 HALF 3. The exported constant's own docblock already
 * asks for this ("two doors, and they must not drift to two numbers").
 *
 * ⚠️ THIS `usableId` GATE IS NOW THE SOLE LENGTH BACKSTOP — #243 half 2a REMOVED
 * THE SECOND ONE. Before this slice a surviving over-length id would still throw
 * at the accept seam, inside `journalEventForInboundUser`. That mapper is no
 * longer on the accept path: the seam mints the durable id SERVER-side
 * (`delivery-journal.ts`'s `appendInboundUser`, `webchannel-user-<seq>`), which
 * does not bound anything because the id is its own short mint. So the length of
 * a CLIENT-supplied token is bounded ONLY here — `usableId` runs at key
 * production (`ingressDedupeKey`) and again in the item loop on
 * `item.message.random_id` before it reaches `appendInboundUser`, and both share
 * this one bound. There is
 * no accept-seam throw to catch a leak past it anymore. If this number were ever
 * raised ALONE, an id of length 129 would be admitted here and indexed in the
 * journal's `idempotency_key` column unbounded (the storage-amplification surface
 * the paragraph above exists to hold shut), with no second door to stop it.
 * Deriving it from the exported constant is what keeps THAT hole unrepresentable.
 *
 * ⚠️ IT DOES NOT MAKE THE CLASS UNREPRESENTABLE. Several more `128`s bound this
 * same `user_message.id` at later doors, each hardcoded INDEPENDENTLY and
 * deliberately NOT derived here, because they are different concerns (wire-frame
 * sizing, debouncer validation, coalesce membership, overflow resolution) and
 * coupling them is a bigger change than this slice should make. ANYONE RAISING
 * `MAX_INBOUND_USER_ID_LENGTH` MUST SWEEP THE PACKAGE FOR THEM — an enumeration
 * kept here would only rot into a list that reads complete and is not.
 *
 * `ingress-result-chunks.ts`'s `MAX_INGRESS_RESULT_ID_LENGTH` is the sharp one,
 * and is worth reproducing because it shows what the sweep is FOR: raise
 * `MAX_INBOUND_USER_ID_LENGTH` to 256 and both derived doors move together, so it
 * LOOKS safe — but a 200-char id is then admitted, journaled, recorded `accepted`
 * and dispatched, and `createIngressResultChunkWriter.add` refuses it, so no ack
 * is ever emitted. The client replays forever and every replay takes the
 * `existing.status === "found"` path straight back into the same refusal: the
 * same permanent wedge, one door further along.
 */
const MAX_INGRESS_DEDUPE_ID_LENGTH = MAX_INBOUND_USER_ID_LENGTH;
export const MAX_CANCELLED_INBOUND_FALLBACK_TOMBSTONES = 256;
export const MAX_CANCELLED_INBOUND_FALLBACK_BYTES = 256 * 1024;

/**
 * The per-account dedupe key for an inbound item (persistent AND fallback).
 *
 * #243 half 1: the dedupe key SOURCE moved from the wire `id` to the client
 * idempotency `random_id`. #243 half 2a then moved the DURABLE id off the wire
 * `id` too — the accept seam mints it server-side. So the wire `id`'s remaining
 * jobs are (a) gating admission here and (b) the ack the client drains its ledger
 * by; it is no longer what is journaled. Two rules, in order:
 *
 *  1. A valid, in-bounds wire `id` is STILL REQUIRED to produce a key. The ack
 *     layer replies with it (the client's replay ledger is keyed by it), and it
 *     is the FALLBACK idempotency key the accept seam journals under when the
 *     client sent no `random_id` (`appendInboundUser`'s `randomId ?? turnId`).
 *     Gating on it here is what keeps the append loop's "cannot refuse what
 *     reaches it" invariant true: an item without a usable wire id gets NO key
 *     and takes the id-less admit-but-don't-journal path (the deliberate N8 gap),
 *     exactly as before this slice. This is UNCHANGED behaviour, not a new gate —
 *     before half 1 the wire id WAS the key, so "no usable wire id" already meant
 *     "no key". What CHANGED is only the reason the durable side is safe: the id
 *     the seam writes is now a server mint, not this validated wire id, so the
 *     length bound protecting the journal lives at `usableId` here (see the
 *     constant's docblock), not at a mapper throw in the footer.
 *  2. Given a usable wire id, the key BODY is the client `random_id` when it is
 *     itself a usable id, else the wire `id` (older clients that send no
 *     `random_id`, or any non-user frame). So a conforming client dedupes on
 *     `random_id`; everything else dedupes exactly as it did before.
 *
 * Both fields share the one `MAX_INGRESS_DEDUPE_ID_LENGTH` bound and the
 * `${peerId}:<key>` namespacing.
 */
function usableId(value: string | undefined): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_INGRESS_DEDUPE_ID_LENGTH;
}
export function ingressDedupeKey(item: IngressDedupeItem): string | undefined {
  const id = item.message.id;
  if (!usableId(id)) return undefined;
  const keyBody = usableId(item.message.random_id) ? item.message.random_id : id;
  return `${item.peerId}:${keyBody}`;
}

/** Per-account, insertion-ordered safety net for cancelled-item record failures. */
export class CancelledInboundFallbackTombstones {
  private readonly keys = new Map<string, number>();
  private bytes = 0;

  constructor(
    private readonly warn?: (message: string) => void,
    private readonly cap = MAX_CANCELLED_INBOUND_FALLBACK_TOMBSTONES,
    private readonly byteCap = MAX_CANCELLED_INBOUND_FALLBACK_BYTES,
  ) {}

  get size(): number { return this.keys.size; }
  get byteSize(): number { return this.bytes; }
  private scoped(key: string, accountId = "global"): string { return `${accountId.length}:${accountId}${key}`; }
  has(key: string, accountId?: string): boolean {
    return this.keys.has(this.scoped(key, accountId))
      || (accountId !== undefined && this.keys.has(this.scoped(key)));
  }
  delete(key: string, accountId?: string): boolean {
    const scoped = this.scoped(key, accountId);
    let bytes = this.keys.get(scoped);
    if (bytes === undefined && accountId !== undefined) {
      return this.delete(key);
    }
    if (bytes === undefined) return false;
    this.keys.delete(scoped);
    this.bytes -= bytes;
    return true;
  }

  add(key: string, accountId?: string): void {
    const scoped = this.scoped(key, accountId);
    if (this.keys.has(scoped)) return;
    const bytes = Buffer.byteLength(scoped, "utf8") + 48;
    if (bytes > this.byteCap) return;
    let evicted = false;
    while (this.keys.size >= this.cap || this.bytes + bytes > this.byteCap) {
      const oldest = this.keys.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.bytes -= this.keys.get(oldest)!;
      this.keys.delete(oldest);
      evicted = true;
    }
    if (evicted) this.warn?.("webchannel: cancelled-inbound fallback tombstone cap reached; evicted oldest metadata entry");
    this.keys.set(scoped, bytes);
    this.bytes += bytes;
  }
}

/** The `checkAndRecord` shape this helper depends on (a subset of `PersistentDedupe`). */
export type IngressDedupeCheck = (
  key: string,
  options?: { namespace?: string },
) => Promise<boolean>;

/**
 * Minimum item shape: a routable peer and a message that may carry a dedupe id.
 *
 * `text` is here for the v6 delivery journal (#239 half 3): §15.7 makes the
 * plugin the ONLY SSOT for user messages, so the accept seam has to persist the
 * message's CONTENT, not just its id. Both fields are OPTIONAL because this
 * constraint is deliberately the minimum an item must satisfy — production
 * instantiates it with `WebchannelUserMessage`, whose `text` is a required
 * `string`.
 *
 * ⚠️ THE SECOND REASON THIS USED TO GIVE IS GONE: "the wire is decoded with a
 * cast, so a peer that omits `text` really does reach this type with it absent."
 * #246 half A replaced that cast with `decodeInboundWsMessage`, which refuses a
 * `user_message` whose `text` is not a string, so no such item arrives from the
 * NATS door any more. The optionality stays for the FIRST reason — it is the
 * minimum this seam requires of any caller, and its tests inject items directly.
 */
export type IngressDedupeItem = {
  peerId: string;
  message: { id?: string; text?: string; random_id?: string };
};

/**
 * Split log sinks so severity is honest. A routine duplicate DROP is expected
 * traffic (`info`); the fail-open catch is a real fault — the dedupe check threw
 * unexpectedly and we are proceeding un-deduped — so it goes to `warn`, where it
 * won't be buried among the info-level drop lines an operator scrolls past.
 */
export type IngressDedupeLogSinks = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
};

/**
 * Return the items that should proceed to dispatch, in their original order.
 *
 * For each item, in order:
 *  - No `id` (older client): KEEP, and never call `checkAndRecord` — an absent
 *    id is not dedupe-able, and recording an empty key would poison the namespace.
 *  - `checkAndRecord` returns `true` (not recently seen → recorded): KEEP.
 *  - returns `false` (already recorded within the window): DROP as a duplicate,
 *    logging peerId + id at INFO (`sinks.info`) — routine, expected traffic.
 *  - `checkAndRecord` REJECTS (an unexpected throw): KEEP (fail-open) and log at
 *    WARN (`sinks.warn`) — losing dedupe for one frame is strictly better than
 *    losing the message, but the throw is a real fault worth a warn.
 *    Note: a DISK fault does NOT surface here — core's checkAndRecord swallows
 *    it (`onDiskError` hook, then records in memory and returns normally), so a
 *    sustained fault degrades to memory-only dedupe with the instance's own
 *    warn-per-fault; this catch is a safety net for anything beyond that.
 *
 * `namespace` is the account id, so ids are isolated per account and one peer
 * cannot dedupe against (poison) another peer's ids. The key is `${peerId}:<key>`,
 * where `<key>` is the client `random_id` when present and the wire `id`
 * otherwise (#243 half 1; see `ingressDedupeKey`).
 */
export async function filterFreshInboundItems<T extends IngressDedupeItem>(
  items: readonly T[],
  accountId: string,
  checkAndRecord: IngressDedupeCheck,
  sinks?: IngressDedupeLogSinks,
  isActive: () => boolean = () => true,
): Promise<T[]> {
  const survivors: T[] = [];
  for (const item of items) {
    if (!isActive()) return [];
    // Normalize the wire `id`: only a non-empty, in-bounds STRING is dedupe-able.
    // A non-string or over-length id is treated as ID-LESS — passed through
    // un-deduped and never recorded, so a hostile client cannot amplify SQLite
    // storage with junk keys. (Such a frame is still ACKed by the P0-7b ack
    // layer, which accepts any non-empty string; it simply is not deduped —
    // acceptable, since only a non-conforming client ever hits this path.)
    const key = ingressDedupeKey(item);
    if (!key) {
      // Back-compat / hardening: id-less (or non-conforming) frames pass through
      // un-deduped.
      survivors.push(item);
      continue;
    }
    const id = item.message.id as string;
    let fresh: boolean;
    try {
      fresh = await checkAndRecord(key, { namespace: accountId });
      if (!isActive()) return [];
    } catch (err) {
      if (!isActive()) return [];
      sinks?.warn?.(
        `webchannel: ingress dedupe check failed for peer=${logSafe(item.peerId)} id=${logSafe(id)} — ` +
          `keeping message (fail-open): ${logSafe(err)}`,
      );
      survivors.push(item);
      continue;
    }
    if (fresh) {
      survivors.push(item);
    } else {
      sinks?.info?.(
        `webchannel: dropped duplicate inbound message peer=${logSafe(item.peerId)} id=${logSafe(id)}`,
      );
    }
  }
  return survivors;
}

/** Dependencies for `createIngressOnFlush`, generic over the debouncer item `T`. */
export type IngressOnFlushDeps<T extends IngressDedupeItem> = {
  /** Dedupe namespace — the serving account id (isolates ids per account). */
  accountId: string;
  /** The per-account `PersistentDedupe.checkAndRecord` (record-at-ingress). */
  checkAndRecord?: IngressDedupeCheck;
  /** Route the surviving, coalesced message onto the per-session FIFO. */
  dispatch?: (peerId: string, message: T["message"]) => void;
  /** Merge the surviving frames into ONE turn's message (P1-8b coalesce). */
  coalesce?: (messages: T["message"][]) => T["message"];
  /**
   * P0-7b ingress ACK: drain the client's replay ledger on ingress ADMISSION.
   * OPTIONAL — P0-7a (first half) wires NO ack; P0-7b wires `channel.sendAck`.
   * When present, called once per flush with the unique ids across ALL items
   * (see the ack rationale in the factory doc).
   */
  /**
   * #243 half 2a: `committed` carries the server-assigned `random_id → messageId`
   * echo. Optional and back-compatible — every non-echo caller (cancelled
   * fallback, legacy branch) passes two args exactly as before.
   */
  sendAck?: (
    peerId: string,
    ids: string[],
    committed?: Array<{ random_id: string; messageId: string; seq: number }>,
  ) => boolean;
  /**
   * #245 Part B: broadcast a just-committed inbound user message to the account's
   * devices (the Telegram multi-device model — a user's own send appears on their
   * other devices immediately). Called ONCE per genuinely NEW admission
   * (`appendInboundUser`'s `inserted === true`), never on a dedup retry. OPTIONAL
   * and back-compatible — the gap-sync catch-up (#244 hB / #337) remains the
   * correctness fallback if the at-most-once broadcast is missed, so an
   * account/test wired without this simply converges non-origin devices lazily.
   */
  sendUserCommitted?: (
    peerId: string,
    message: { id: string; text: string; turnId?: string; seq: number; random_id?: string },
  ) => boolean;
  sendInboundRejected?: (peerId: string, ids: string[]) => boolean;
  outcomeStore?: IngressOutcomeStore;
  beginBatch?: (peerId: string) => DispatcherBatchLease<T["message"]>;
  measureResultWireBytes?: (peerId: string, frame: IngressResultFrame) => number;
  effectiveOutboundLimit?: () => number;
  /** Cancel-record failures that must be suppressed before ordinary admission. */
  cancelledFallback?: CancelledInboundFallbackTombstones;
  /**
   * v6 delivery journal (#239 half 3) — the plugin's own durable store.
   *
   * ⚠️ OPTIONAL IN THE TYPE ONLY. THIS IS NOT A DEGRADE MODE. Doc §15.7 makes a
   * durable journal write a HARD REQUIREMENT of accepting a user message, so an
   * account serving without one is serving without the SSOT its history comes
   * from. It is optional purely so the existing test constructions in
   * `ingress-dedupe.test.ts` keep compiling.
   * `nats-account-runtime.ts` is the production owner and ALWAYS supplies one —
   * pinned by a source guard in `index-nats-wiring.test.ts`, exactly because
   * "optional" must not quietly become "absent in production" (the same guard
   * `NatsChannelDurability` gets on the egress side).
   */
  deliveryJournal?: DeliveryJournal;
  /** Routine duplicate-drop sink (info). */
  logInfo?: (message: string) => void;
  /** Fail-open fault sink (warn). */
  logWarn?: (message: string) => void;
  /** Account-runtime lifecycle fence, combined with each retained entry fence. */
  isActive?: () => boolean;
};

/**
 * The FIXED set of delivery-journal warning categories at this seam.
 *
 * Fixed for the same reason as `ingress-outcome.ts`'s
 * `OUTCOME_FAILURE_CATEGORIES` and `nats-channel.ts`'s `DeliveryJournalWarning`:
 * the limiter's keyspace is a closed union, so no peer-controlled value can
 * become a map key and grow the warning state.
 */
type JournalWarning =
  /**
   * The journal refused the batch. §15.7's asymmetry with the egress seam lives
   * here: this one IS an accept failure — the batch rolls back and no fresh
   * admission is acked. (Two paths are deliberately NOT unwound; the catch that
   * emits this names both.)
   */
  | "append-failed"
  /**
   * An item was ADMITTED (it runs a turn and the client shows its bubble) but
   * could not be journaled, so history will not have it. A live≠history gap we
   * are choosing to leave visible rather than absorb — see the call sites.
   *
   * ONE MEMBER PER REASON, not one for both: the two carry different `action=`
   * values, and only `no-usable-id` has an owning issue (#243). A shared window
   * would let the id-less line suppress the malformed-`text` one within the same
   * batch — hiding precisely the reason nothing else is tracking.
   */
  | "unjournalable-user-id"
  | "unjournalable-user-text"
  /**
   * #344 — an `accepted` outcome marker with NO journal row for the same
   * `random_id`. The journal is the accept authority, so the marker is not
   * evidence of an accept: the item is RE-ADMITTED (journaled, dispatched,
   * acked with a fresh `committed` echo) instead of being re-acked as a
   * duplicate. Its own member because sharing a window with the
   * `unjournalable-*` lines would let either hide the other.
   *
   * ⚠️ READ IT AS "A TURN IS RE-RUNNING", NOT "ALL IS WELL". In the normal case
   * it is a pure recovery — a message that would have been dropped now runs. But
   * a marker left by a build from BEFORE `cancelled` became its own outcome may
   * be a `/stop` suppression wearing the `accepted` namespace, and this line is
   * then the sound of an aborted turn being re-run once (the migration note in
   * the file header bounds it: pre-upgrade cancellation × lost ack × 7-day TTL).
   * A burst right after an upgrade is that; a steady trickle is the crash window
   * doing its job.
   */
  | "orphaned-accept-marker";

/** Match `ingress-outcome.ts`'s limiter and `nats-channel.ts`'s journal warnings. */
const JOURNAL_WARNING_INTERVAL_MS = 60_000;

/**
 * Rate-limited, per-category journal warning, carrying the suppressed count into
 * the next line — the shape `createRateLimitedOutcomeFailureWarning` already
 * uses in this file's imports.
 *
 * Throttled because every category is PEER-DRIVEN at full ingress rate: each
 * `unjournalable-user-*` line fires once per malformed frame, a failing store
 * fails for every batch, and `orphaned-accept-marker` fires once per replayed
 * item whenever the marker store and the journal disagree in bulk (a cut-over or
 * erased journal file makes that EVERY replay in the client's ledger). One line
 * per inbound message would bury the log the `#123` discipline exists to keep
 * readable.
 *
 * One limiter per `createIngressOnFlush`, i.e. per ACCOUNT — so a broken account
 * cannot silence a healthy one, but WITHIN an account the window is shared across
 * every peer. State that plainly, because per-message attribution is the whole
 * point of the `peer=` field: one peer spamming malformed frames suppresses
 * another peer's gap line for the rest of the interval, and the line that does
 * survive names only ONE peer while `suppressed=N` counts all of them. Sharpening
 * this to per-peer would make the keyspace peer-controlled, which is exactly what
 * the fixed category union above exists to prevent; the account-wide window is
 * the deliberate trade.
 */
function createRateLimitedJournalWarning(
  warn: ((message: string) => void) | undefined,
): (category: JournalWarning, body: string) => void {
  const state: Record<JournalWarning, { lastAt: number; suppressed: number }> = {
    "append-failed": { lastAt: Number.NEGATIVE_INFINITY, suppressed: 0 },
    "unjournalable-user-id": { lastAt: Number.NEGATIVE_INFINITY, suppressed: 0 },
    "unjournalable-user-text": { lastAt: Number.NEGATIVE_INFINITY, suppressed: 0 },
    "orphaned-accept-marker": { lastAt: Number.NEGATIVE_INFINITY, suppressed: 0 },
  };
  return (category, body) => {
    const entry = state[category];
    const at = Date.now();
    if (at - entry.lastAt < JOURNAL_WARNING_INTERVAL_MS) {
      entry.suppressed++;
      return;
    }
    const suppressed = entry.suppressed;
    entry.lastAt = at;
    entry.suppressed = 0;
    warn?.(`${body} suppressed=${suppressed}`);
  };
}

/**
 * Build the debouncer's `onFlush` handler — the REAL one index-nats.ts wires,
 * extracted to `src/` so it is tsc-checked and tested directly (index-nats.ts is
 * outside tsconfig, and an inlined closure there could silently drift, e.g.
 * dispatch `items` instead of `fresh`, or drop the accountId namespace).
 *
 * WHY IT LIVES IN onFlush (not setMessageHandler). The dedupe check is async
 * (`checkAndRecord` may await SQLite). `onFlush` is SAME-PEER SERIALIZED by the
 * bounded debouncer's one-worker-per-key design (`buildKey: peerId`), so
 * awaiting the check here cannot reorder a peer's messages. Awaiting the same
 * check in the fire-and-forget `setMessageHandler` COULD: a slower SQLite miss
 * could let a later frame overtake an earlier one. So the dedupe belongs on the
 * serialized flush path, not the raw handler.
 *
 * PRODUCTION outcome/lease branch, per flush batch:
 *  - look up the durable terminal outcome before admission and act on WHICH one
 *    it is (#344): `overloaded` → `inbound_rejected`; `cancelled` (text `/stop`
 *    killed, never journaled on purpose) → ack and drop; `accepted` → CONFIRM IT
 *    AGAINST THE JOURNAL, which is the authority — a marker with no row for the
 *    item's `random_id` is not an accept, so the item is re-admitted down the
 *    fresh path instead of re-acked;
 *  - offer fresh work against the dispatcher lease and record exactly one chosen
 *    outcome before committing the lease;
 *  - commit each FRESH admission's `user` event to the v6 delivery journal —
 *    doc §15.7 makes that write part of ACCEPTING the message, so a failure here
 *    rolls the batch back and no fresh admission is acked (the footer block
 *    states precisely what unwinds and the two paths that do not);
 *  - emit ACK only for accepted ids and `inbound_rejected` only for overloaded
 *    ids. These result classes are disjoint and are published after persistence.
 *
 * LEGACY boolean-dedupe compatibility branch only:
 *  - P0-7b ACK FIRST (before the legacy dedupe/dispatch): ack every id-carrying item —
 *    FRESH AND DUPLICATES ALIKE. A deduped duplicate means the ORIGINAL was
 *    admitted, so the client's replay ledger entry must STILL drain; skipping it
 *    would make the client replay that message on every reconnect forever.
 *    Receipt = ingress ADMISSION, NOT turn success, so it is independent of the
 *    dedupe outcome and correctly precedes it. ONE `sendAck` per flush — the batch
 *    is same-peer (`buildKey = peerId`), so `items[0].peerId` is the whole batch's
 *    peer. `sendAck` is optional (P0-7a wires none); id-less items carry no
 *    ledger entry and are filtered out of the ack.
 *  - filter to FRESH items (drop `${peerId}:${id}` already admitted in the window;
 *    id-less frames pass through; a dedupe fault fails OPEN — keep the message);
 *  - an all-duplicates batch dispatches NOTHING (every item was dropped) — but it
 *    was still ACKED above, so the client stops replaying;
 *  - otherwise coalesce the survivors into one turn and dispatch it to
 *    `fresh[0].peerId`. The batch is one peer's window (same `buildKey`), so the
 *    first survivor's peer is the whole batch's peer.
 *
 * CONTROL-LANE NOTE: `/stop` (and the NL abort vocabulary) BYPASS the debouncer
 * entirely in setMessageHandler, so aborts never reach this path and are never
 * deduped — a duplicate abort is a harmless cosmetic double-bubble, and the abort
 * must not wait on SQLite. The control-lane branch acks its own frame separately.
 * Which means the v6 journal hook below does NOT cover it, and that is a real
 * live≠history gap rather than a decision that aborts are not messages: the
 * client's `send()` routes abort-shaped text through the very same `publish()` as
 * ordinary text, which applies a durable `user` event to its own view, so a
 * `/stop` — and every word in the wider NL abort vocabulary, which is ordinary
 * text like "wait" — DOES render a user bubble live. Issue **#281** owns it. It
 * is out of scope here because the control lane has different semantics: the
 * abort must not wait on SQLite (above), and that branch has no rollback path to
 * express "not accepted" with. Doc §15.7's last bullet asked the question; #281
 * carries the answer.
 *
 * In that legacy branch, per-id recording happens inside
 * `filterFreshInboundItems` before coalesce/dispatch. Production does not use
 * this ACK-first flow; it uses the outcome/lease arbitration above.
 */
export function createIngressOnFlush<T extends IngressDedupeItem>(
  deps: IngressOnFlushDeps<T>,
): (items: readonly (T | RetainedDebounceEntry<T>)[]) => Promise<void> {
  const { accountId, checkAndRecord, dispatch, coalesce, sendAck, cancelledFallback, logInfo, logWarn } = deps;
  const isActive = deps.isActive ?? (() => true);
  const sinks: IngressDedupeLogSinks = { info: logInfo, warn: logWarn };
  const warnOutcomeFailure = createRateLimitedOutcomeFailureWarning((message) => logWarn?.(message));
  const warnJournal = createRateLimitedJournalWarning(logWarn);
  return async (items) => {
    if (!isActive()) return;
    if (deps.outcomeStore && deps.beginBatch) {
      const retained = items.map((value) => "item" in value
        ? value as RetainedDebounceEntry<T>
        : {
            item: value as T,
            reservation: undefined,
            isActive: () => true,
            isCancellationRequested: () => false,
            isRetired: () => false,
            waitForCancellation: async () => {},
          });
      const anchor = retained[0]?.item;
      if (!anchor) return;
      const peerId = anchor.peerId;
      const lease = deps.beginBatch(peerId);
      const measure = (frame: IngressResultFrame) => deps.measureResultWireBytes?.(peerId, frame)
        ?? Buffer.byteLength(JSON.stringify(frame), "utf8");
      // #243 half 2a: the `ack` writer is created in the FOOTER, not here, because
      // its `committed` echo is only known once the fresh admissions have been
      // journaled (their minted ids) and the deduped retries have been looked up.
      // See `committedBatch` and the footer.
      const rejected = createIngressResultChunkWriter({
        type: "inbound_rejected",
        publish: (frame) => deps.sendInboundRejected?.(peerId, frame.ids) ?? false,
        measureWireBytes: measure,
        effectiveOutboundLimit: deps.effectiveOutboundLimit?.(),
        onTooSmall: () => logWarn?.("webchannel: result frame cannot fit effective NATS max_payload"),
      });
      const rollbackOffers: Array<() => void> = [];
      const commitOffers: Array<() => void> = [];
      const pendingWrites: OutcomeWriteReceipt[] = [];
      const deferredReleases: Array<() => void> = [];
      /**
       * #239 half 3 — the FRESH admissions this batch owes the journal, in
       * ARRIVAL ORDER, collected as they are decided and written in the footer.
       *
       * ⚠️ ONE ENTRY PER ITEM, NOT ONE PER TURN. P1-8b coalesces the batch into a
       * single turn message carrying the LAST frame's id, but the client drew N
       * user bubbles, so N `user` rows is what makes history equal live (N8). The
       * coalesced message is a dispatch concern and never reaches this array.
       */
      const journalPending: Array<{ wireId: string; randomId: string | undefined; text: unknown }> = [];
      /**
       * #243 half 2a — the batch's `random_id → messageId` echo, in the order the
       * ids are collected. A FRESH admission contributes its newly minted id
       * (footer append loop); a DEDUPED RETRY contributes the id its first
       * admission minted, recovered via `lookupUserMessageIdByRandomId`. Rides
       * the first `ack` frame (see the footer). Empty for older clients that sent
       * no usable `random_id` — those are still acked, just not echoed.
       */
      const committedBatch: Array<{ random_id: string; messageId: string; seq: number }> = [];
      /**
       * The chosen results, held until the footer. **NOTHING may be `add`ed to
       * either chunk writer inside the item loop.**
       *
       * ⚠️ `add()` IS NOT A BUFFER. `createIngressResultChunkWriter.add` flushes
       * EAGERLY — at `maxIds` (`ingress-result-chunks.ts`, the `ids.length >=
       * maxIds` branch) and again when the next id would exceed the effective
       * wire limit — and `flush()` calls `publish`, which is `deps.sendAck` →
       * `channel.sendAck` → the wire. So an in-loop `add` could publish an ack
       * for the batch's first 64 ids BEFORE the journal ran, and a journal
       * failure would then roll those messages back while the client had already
       * drained their ledger entries and would never replay them: permanent,
       * silent loss of accepted user text — exactly what doc §15.7 exists to
       * prevent. (Unreachable today only by one accident per trigger, both in
       * OTHER files: the id-count trigger is held off because `maxIds` is 64 and
       * `DEFAULT_BUSY_TURN_LIMITS.maxMessagesPerSession` is 32, and the byte
       * trigger because `MAX_INGRESS_RESULT_WIRE_BYTES` is 64 KB AND
       * `nats-account-runtime.ts` never supplies the `effectiveOutboundLimit`
       * that would shrink it — a wiring gap, which is weaker than arithmetic and
       * one line from closing. This slice's own tests pass an
       * `effectiveOutboundLimit` precisely to fire that second trigger. Neither
       * is a property this file should depend on.)
       *
       * The chunking semantics are unchanged: the same ids are `add`ed in the
       * same order, so the same frames are produced — only later. Memory: two
       * arrays of ≤128-char ids, alongside `retained`, which already holds every
       * item's whole message for the life of the batch.
       */
      const ackIds: string[] = [];
      const rejectedIds: string[] = [];
      let finalized = false;
      let fifoBlocked = false;

      const rollbackWrites = async () => {
        for (const write of pendingWrites) await write.rollback();
      };
      const rollbackBatch = async () => {
        await rollbackWrites();
        for (const rollback of rollbackOffers) rollback();
        for (const release of deferredReleases) release();
      };

      /**
       * An item that was ADMITTED but cannot be journaled. Both reasons are
       * malformed-frame shapes the conforming client never produces; each leaves
       * live text that history will not have (N8), so it is reported rather than
       * absorbed. Silent when this seam has no journal at all — then nothing is
       * journaled and there is no gap specific to this item.
       */
      const journalGap = (reason: "no-usable-id" | "non-string-text") => {
        if (!deps.deliveryJournal) return;
        // The action is PER REASON. #243 (server-assigned user ids) is the fix
        // for `no-usable-id` and does not address `non-string-text` at all, so
        // pointing both at #243 would send an operator to an issue that can never
        // close their line. The throttle CATEGORY is per reason for the same
        // reason: one shared 60 s window lets whichever reason fires first hide
        // the other.
        //
        // ⚠️ `non-string-text` IS NOW UNREACHABLE FROM THE NATS WIRE, and its
        // `action=` token is deliberately unchanged. This used to say the reason
        // "needs wire-level validation of `text`, which
        // `normalizeInboundUserMessage` explicitly declines to do" — #246 half A
        // added exactly that validation, at the receive door rather than in the
        // normalizer (`decodeInboundWsMessage` refuses a `user_message` whose
        // `text` is not a string). What remains reachable is a DIRECT caller of
        // this seam that did not come through that door. The emitted token still
        // reads `no-owning-issue`: it names the OPERATOR's action, it is what
        // every existing grep and the #123 audit baseline match on, and renaming
        // a log token is a change with its own blast radius — not a free
        // side-effect of closing the door.
        //
        // `no-usable-id` is UNAFFECTED and stays reachable: the decoder refuses a
        // PRESENT-but-unusable id, while an ABSENT one is legal on the wire
        // (older clients send none) and is exactly what produces no dedupe key.
        const idLess = reason === "no-usable-id";
        const action = idLess
          ? "action=live-only-history-gap-issue-243"
          : "action=live-only-history-gap-malformed-frame-no-owning-issue";
        warnJournal(
          idLess ? "unjournalable-user-id" : "unjournalable-user-text",
          "webchannel: inbound user message admitted but NOT journaled " +
            `peer=${logSafe(peerId)} reason=${reason} ${action}`,
        );
      };

      try {
        for (const retainedItem of retained) {
          const item = retainedItem.item;
          const reservation = retainedItem.reservation;
          const release = () => {
            reservation?.requestRelease();
          };
          // The first unresolved storage classification is a same-flush FIFO
          // barrier. Suffix entries remain wholly unclassified: no lookup,
          // offer, record, result, or dispatch. Their ledger ids retry later.
          if (fifoBlocked) {
            release();
            continue;
          }
          if (!isActive() || !retainedItem.isActive()) {
            release();
            fifoBlocked = true;
            continue;
          }
          const key = ingressDedupeKey(item);
          if (!key) {
            const offer = lease.offer(item.message, reservation);
            if (offer.status === "accepted") {
              offer.commit();
              // KNOWN GAP, DELIBERATELY LEFT VISIBLE (#239 half 3). An item with
              // no dedupe key is still ADMITTED here: it runs a turn and the
              // client shows its bubble. It is not journaled because it never
              // reaches the journal at all — with no key it takes THIS branch and
              // never enters `journalPending`, so the footer's `appendInboundUser`
              // is never called for it. The reason is now STRUCTURAL (no key ⇒ no
              // append), not a mapper throw: #243 half 2a replaced the old
              // `journalEventForInboundUser` accept-seam call — whose throw used
              // to be what stopped an id-less item — with a server mint that runs
              // only for keyed items. So this is live text history will not have:
              // an N8 gap we are CHOOSING to leave, which is why it is a warn and
              // not silence.
              //
              // ⚠️ DO NOT "FIX" IT BY MINTING A SERVER ID FOR THIS ITEM. #243
              // half 2a DOES mint server ids — but only for items with a dedupe
              // key (`randomId ?? wireId`), which is what makes a mint idempotent
              // across replays and reconcilable to the client. This item has
              // NEITHER a usable wire id NOR a `random_id`, so a mint here could
              // be echoed to nothing, could not dedupe a replay, and would be a
              // phantom row under an id the client has never heard of. The gap is
              // the honest outcome for an item with no stable identity.
              //
              // Only a NON-CONFORMING client reaches this: `nats-client.ts`
              // mints an id for every `user_message` it publishes, and the
              // ledger it replays from is keyed by that id.
              //
              // ⚠️ REPORTED FROM THE ITEM LOOP, UNLIKE THE `non-string-text`
              // GAP, AND THE ASYMMETRY IS THE POINT. That one is a fresh
              // admission sitting in `rollbackOffers`, so a refused batch rolls
              // it back and it never runs — reporting it there would be a gap
              // line for a message that never existed, which is why it is
              // deferred to the footer. THIS one commits its offer inline and
              // never enters `rollbackOffers`, so `finish()` promotes it to
              // `attached` and drains it: a refused batch still runs it (that is
              // exception 2 in the catch below), and the gap is real precisely
              // when the batch fails. Deferring this one would LOSE a true line.
              //
              // ⚠️ "IT RUNS" IS CHECKED, NOT ASSUMED, AND IT IS NOT ABSOLUTE.
              // `commit()`'s own disposed/finished rollback branch cannot fire
              // from here, because `offer()` reads those SAME two flags one
              // statement earlier and would have returned `{status:"disposed"}`
              // into the `else`; the two calls are adjacent and synchronous with
              // no callout between them, so put an `await` there and that stops
              // being true. A cancellation racing this batch DOES falsify it
              // from outside: `clearPending` walks `state.openLeases` and rolls
              // back every entry not already `rolled-back` — this `committed`
              // one included — so the line can be emitted for an item that is
              // then cancelled and never runs. Name the MECHANISM, not one
              // caller: `/stop`, peer retirement (unregister and peer-cap
              // eviction both reach it) and teardown all land the same rollback,
              // which is why the invalidated check below says "`/stop` or peer
              // retirement" rather than naming one. Needs a non-conforming
              // client and is log-only, but it is a spurious gap report, and it
              // is the same mid-flight cancellation #292 measures.
              journalGap("no-usable-id");
            } else release();
            continue;
          }
          const id = item.message.id as string;
          // #243 half 2a: the usable client `random_id` this item was keyed on
          // (the same predicate `ingressDedupeKey` uses for the key BODY). It is
          // what a fresh admission is journaled under and what a retry echoes by.
          // Absent for an older client that sent none — then there is no echo.
          const randomId = usableId(item.message.random_id) ? item.message.random_id : undefined;
          // #344: set when the found/accepted branch below refuses the marker as
          // evidence and falls through to the fresh-accept path. The only thing
          // it changes downstream is that this key already carries a durable
          // `accepted` marker, which matters to the overloaded record.
          let readmitted = false;

          // A cancellation tombstone is authoritative and must run before an
          // ordinary outcome lookup or dispatcher admission. It represents text
          // `/stop` already killed whose first suppression write failed. Retry
          // persistence first and ACK only after it succeeds; retain the
          // tombstone until both halves succeed. The replay reservation is
          // released exactly once.
          if (cancelledFallback?.has(key, accountId)) {
            let result: OutcomeRecordResult | undefined;
            try {
              result = await deps.outcomeStore.record(
                accountId,
                key,
                // ⭐ #344 — `cancelled`, NOT `accepted`. This is the second of the
                // three suppression writers (with `nats-account-runtime.ts`'s
                // `onCancel` and `inbound-overflow-resolver.ts`'s
                // `recoverCancelled`), and all three deliberately write NO journal
                // row. Under `accepted` that state was indistinguishable from the
                // accept seam's crash window, so the found branch below re-admitted
                // killed text on any replay whose ack was lost.
                "cancelled",
                { replaceOthers: true },
              );
              if (result.status !== "recorded") {
                logWarn?.("webchannel: cancelled-inbound fallback outcome retry failed");
              }
            } catch {
              logWarn?.("webchannel: cancelled-inbound fallback outcome retry failed");
            }
            if (!isActive() || !retainedItem.isActive()) {
              if (result?.status === "recorded") await result.write.rollback();
              release();
              fifoBlocked = true;
              continue;
            }
            if (result?.status !== "recorded") {
              // The fallback is authoritative cancellation suppression, but
              // without a successful replacement write it has no publishable
              // chosen outcome. Preserve peer FIFO until that retry succeeds.
              release();
              fifoBlocked = true;
              continue;
            }
            let acked = false;
            result.write.commit();
            acked = deps.sendAck?.(item.peerId, [id]) ?? false;
            if (!acked) logWarn?.("webchannel: cancelled-inbound fallback result delivery failed");
            if (acked) cancelledFallback.delete(key, accountId);
            release();
            continue;
          }

          let existing: OutcomeLookup;
          try {
            existing = await deps.outcomeStore.lookup(accountId, key);
          } catch (error) {
            warnOutcomeFailure(accountId, "adapter-lookup");
            existing = { status: "unknown", error };
          }
          if (!isActive() || !retainedItem.isActive()) {
            release();
            fifoBlocked = true;
            continue;
          }
          if (existing.status === "unknown") {
            release();
            fifoBlocked = true;
            continue;
          }
          if (existing.status === "found") {
            // Deferred to the footer like every other result — see `ackIds`.
            // A REPLAY's result is therefore also withheld when a fresh sibling's
            // journal write fails. Deliberate, and harmless: the batch retries
            // whole and this id's durable outcome is unchanged, so the replay
            // lands here again and is classified again — acked, rejected, or
            // (#344, below) re-admitted, whichever the two stores then say.
            if (existing.outcome === "overloaded") {
              release();
              rejectedIds.push(id);
              continue;
            }
            // ⭐ #344 — A CANCELLED REPLAY IS DROPPED, NOT RE-ADMITTED, AND THIS
            // ARM IS WHY THE OUTCOME HAD TO SPLIT. Text `/stop` killed has a
            // marker and, on purpose, NO journal row — the same shape the crash
            // window leaves. Read only the row and the two are one state; read
            // the outcome and they are two. So this arm answers the row question
            // by NOT ASKING IT.
            //
            // ACK, never `inbound_rejected`: the ack is what drains the client's
            // replay ledger so it stops re-sending dead text, and a rejection
            // would tell the peer its message hit backpressure, which is a lie.
            // No `committed` echo either — there is no row to echo, and inventing
            // one would put a durable id on the wire for a message history does
            // not have. This is exactly what the branch did before the split,
            // when the same suppression was spelled `accepted`.
            if (existing.outcome === "cancelled") {
              release();
              ackIds.push(id);
              continue;
            }
            // #243 half 2a — THE DEDUPED-RETRY ECHO. The retry is caught here,
            // BEFORE any re-append, so it must not mint a fresh id or write a
            // second row (a new id would slip past the journal's
            // `journal_user_idempotency_once` guard, whose key is the OLD
            // `random_id`, and duplicate the durable message). Instead recover
            // the id the FIRST admission minted, from the row, and echo the SAME
            // value.
            //
            // #244 half A: the lookup now returns the first admission's `seq`
            // alongside its `messageId`, and the retry echoes BOTH unchanged —
            // never a fresh seq, exactly as it never mints a fresh id.
            const committed = randomId !== undefined && deps.deliveryJournal
              ? deps.deliveryJournal.lookupUserMessageIdByRandomId(peerId, randomId)
              : undefined;
            // ⭐ #344 — THE JOURNAL IS THE DEDUPE AUTHORITY; THE MARKER IS AN
            // OPTIMIZATION LAYER. The Telegram server dedupes a re-sent message
            // by `random_id` against the messages it has STORED — the stored
            // message IS the dedupe record, so there is no marker that can
            // outlive it. Our marker CAN: `record()` persists it through the SDK
            // store before the footer's `appendInboundUser` runs (that order is
            // deliberate and stays — see the footer's ordering block), so a crash
            // between the two leaves an `accepted` marker with no row. Re-acking
            // on that marker is what made the message absent from the SSOT
            // forever while the origin device kept a "sent" bubble (#344, the
            // crash door onto #292).
            //
            // So: marker says accepted, the item carries a `random_id`, this
            // seam HAS a journal, and the journal has no row for it ⇒ it was NOT
            // accepted. Fall through to the fresh-accept path, which journals it
            // and dispatches the turn. Nothing here is a second journal call
            // site: the one append stays in the footer.
            //
            // The three ways out of the check, and why each still acks:
            //  - no `random_id` (an older client): its row is keyed by the wire
            //    id and this seam does not query by that. A SCOPE choice, not a
            //    limit — `appendInboundUser` writes `idempotency_key =
            //    randomId ?? turnId` and this lookup reads that column, so the
            //    wire id would resolve it. Unchanged behaviour: ack, no echo.
            //  - no `deps.deliveryJournal` (P0-7a wiring, and this file's own
            //    pre-journal tests): there is no authority to consult.
            //  - a row exists: the ordinary deduped retry, re-echoing the FIRST
            //    admission's id and seq.
            const orphanedMarker =
              randomId !== undefined && deps.deliveryJournal !== undefined && committed === undefined;
            if (!orphanedMarker) {
              release();
              ackIds.push(id);
              if (randomId !== undefined && committed !== undefined) {
                committedBatch.push({
                  random_id: randomId,
                  messageId: committed.messageId,
                  seq: committed.seq,
                });
              }
              continue;
            }
            // Per item, throttled by category like every other journal warning.
            // It is a RECOVERY, not a loss: the line exists because the marker
            // and the journal disagreed, which is either the crash window above
            // or a marker minted by a pre-journal build, and an operator seeing
            // a run of these is seeing turns re-run (see the footer's ordering
            // block for the bounded cost).
            warnJournal(
              "orphaned-accept-marker",
              "webchannel: accepted outcome marker has no journal row, re-admitting " +
                `peer=${logSafe(peerId)} random_id=${logSafe(randomId)} ` +
                "action=journal-is-authoritative-turn-re-runs-once",
            );
            readmitted = true;
            // Fall through to the fresh-accept path below, reservation still held.
          }

          const offer = lease.offer(item.message, reservation);
          if (offer.status === "disposed") {
            release();
            continue;
          }
          if (offer.status === "rejected") {
            let result: OutcomeRecordResult | undefined;
            try {
              // #344: a re-admitted item (see the found/accepted branch) still
              // carries its old `accepted` marker. Recording `overloaded`
              // alongside it would create the dual terminal outcome
              // `lookupUnlocked` treats as an invariant violation, so replace it
              // — exactly what the cancelled-inbound fallback does in the other
              // direction. `replaceOthers` fails CLOSED (`status: "unknown"`),
              // which lands on the same FIFO barrier below.
              result = await deps.outcomeStore.record(
                accountId,
                key,
                "overloaded",
                readmitted ? { replaceOthers: true } : undefined,
              );
            } catch {
              warnOutcomeFailure(accountId, "adapter-record-overloaded");
              // The same FIFO barrier below handles thrown adapters and explicit
              // tri-state unknown identically.
            }
            if (!isActive() || !retainedItem.isActive()) {
              if (result?.status === "recorded") await result.write.rollback();
              release();
              fifoBlocked = true;
              continue;
            }
            if (result?.status === "recorded" && result.durability === "durable") {
              pendingWrites.push(result.write);
              deferredReleases.push(release);
              rejectedIds.push(id);
            } else {
              if (result?.status === "recorded") await result.write.rollback();
              release();
              fifoBlocked = true;
            }
            continue;
          }
          let rolledBack = false;
          const rollbackOnce = () => {
            if (rolledBack) return;
            rolledBack = true;
            offer.rollback();
          };
          rollbackOffers.push(rollbackOnce);

          let recorded: OutcomeRecordResult | undefined;
          try {
            recorded = await deps.outcomeStore.record(accountId, key, "accepted");
          } catch {
            warnOutcomeFailure(accountId, "adapter-record-accepted");
            // A thrown storage adapter is the same unresolved classification as
            // `{status:"unknown"}` and blocks this suffix.
          }
          if (!isActive() || !retainedItem.isActive()) {
            if (recorded?.status === "recorded") await recorded.write.rollback();
            // Keep the provisional offer/reservation physically owned until the
            // invalidated footer has released every earlier outcome gate and the
            // cancellation callback settles; footer rolls this offer back.
            fifoBlocked = true;
          } else if (recorded?.status === "recorded") {
            pendingWrites.push(recorded.write);
            commitOffers.push(offer.commit);
            ackIds.push(id);
            // ---- v6 #239 half 3: THE ONE FRESH ADMISSION OF NEW USER TEXT ----
            //
            // Collected HERE and written in the footer, not written here. This
            // point is still inside the item loop, and the `invalidated` check
            // below can still roll the ENTIRE batch back — a `/stop` or a peer
            // retirement that lands while a later item is awaiting its lookup.
            // A `user` row for a message that then never runs is a phantom user
            // bubble in history that live never showed: N8 in the GAINING
            // direction, the same class of error NOT-list N6b records (the
            // egress seam's own two-round mistake).
            //
            // STILL THE ONLY COLLECTION SITE, and #344 is why that survived a
            // second demand for one. The `existing.status === "found"` branch
            // above has a case that DOES need a row — an `accepted` marker with
            // no journal row, which #292 named and #344 measured a crash door
            // onto — but it gets there by FALLING THROUGH to this path rather
            // than by a hook of its own. So a re-admitted item is journaled by
            // this exact line, under the same rules, and "a deduped retry writes
            // no row" stays true: a retry that reaches this line was, by the
            // journal's own verdict, never accepted.
            if (deps.deliveryJournal) {
              journalPending.push({ wireId: id, randomId, text: item.message.text });
            }
          } else {
            rollbackOnce();
            fifoBlocked = true;
          }
        }

        // `/stop` or peer retirement can invalidate an earlier committed offer
        // while this same batch is stalled on a later lookup/write. Nothing in
        // an invalidated generation may reach the dispatcher or publish its
        // normal result. Cancellation keeps the killed ids' markers as tombstones
        // (`cancelled` since #344, `accepted` before it); teardown removes them so
        // a replacement runtime is not poisoned.
        const invalidated = !isActive() || retained.some((entry) => !entry.isActive());
        if (invalidated) {
          // Release key-operation gates through exact-write rollback before
          // waiting for cancellation, whose `cancelled` replacement write may be
          // queued behind one of them.
          await rollbackWrites();
          await Promise.all(
            retained
              .filter((entry) => entry.isCancellationRequested())
              .map((entry) => entry.waitForCancellation()),
          );
          for (const rollback of rollbackOffers) rollback();
          for (const release of deferredReleases) release();
          finalized = true;
          return;
        }
        // ---- v6 #239 half 3 — THE JOURNAL WRITE *IS* THE ACCEPT (doc §15.7) --
        //
        // The plugin is the ONLY SSOT for user messages, so a durable journal
        // write is a HARD REQUIREMENT of accepting one, not best-effort: a user
        // message that is not in the journal WAS NOT ACCEPTED.
        //
        // ⚠️ §15.7's "journal-first → then confirm" IS ABOUT THE WIRE, NOT THE
        // STORE, AND THIS BLOCK USED TO CONFLATE THEM (#344). On the wire the
        // ordering holds exactly: the append runs here, above `pendingWrites`
        // commit and above the only place either chunk writer is touched, so no
        // ack leaves before the row is durable. In the STORE the ordering is the
        // other way round — `outcomeStore.record(…, "accepted")` in the item loop
        // persists its marker through the SDK store at that moment, so the
        // durable sequence is marker-first, row-second, and a crash between them
        // leaves an `accepted` marker with no row.
        //
        // THAT ORDER STAYS. Writing the row first would open the mirror window
        // instead: a row with no marker, which a replay reads as a FRESH
        // admission — `appendInboundUser` collapses onto the existing row
        // (`inserted: false`) but the offer is still dispatched, so the same text
        // gets one user row and two answers. That is not hypothetical; it is the
        // marker-eviction bullet #355 already carries, and reordering here would
        // add a crash door onto it.
        //
        // WHAT CHANGED IS THE RULE FOR READING THE TWO WHEN THEY DISAGREE: the
        // journal is the authority and the marker is an optimization layer, so an
        // `accepted` marker with no row is not evidence of an accept. The
        // found/accepted branch in the item loop enforces it — it consults this
        // journal and re-admits (journals + dispatches) rather than re-acking.
        // That check is what makes the crash window the file header describes
        // HEAL on the client's replay instead of losing the message forever.
        //
        // ⚠️ THE QUESTION IS ASKED ONLY OF `accepted`, AND THAT IS THE FIX'S
        // LOAD-BEARING HALF. "No row" is a deliberate, permanent state for the
        // three `/stop` suppression writers, so the journal cannot arbitrate
        // there — asking it would undo the cancellation. They record `cancelled`
        // (a distinct terminal outcome, `ingress-outcome.ts`), which the item
        // loop drops with an ack and never re-admits. One store answers "was it
        // accepted?"; the other answers "was it ever meant to run?", and only the
        // second can tell the crash window from a `/stop`.
        //
        // ⚠️ THE COST, STATED, IN TWO PARTS.
        //  1. ONGOING: an `accepted` marker whose row is genuinely gone — a
        //     pre-journal build, or an erased or cut-over journal file (doc
        //     §15.6) — re-runs that message's turn ONCE on its next replay
        //     instead of being dropped. Bounded by the marker store's 7-day TTL
        //     and by the client's ledger (only a message the client is still
        //     replaying reaches this at all).
        //  2. ONE-OFF, ON UPGRADE: a cancellation recorded as `accepted` by an
        //     older build is indistinguishable from (1) for that marker's TTL, so
        //     if its ack was also lost, the aborted turn re-runs once. The file
        //     header carries the full statement.
        //
        // ⚠️ THE ASYMMETRY WITH THE EGRESS SEAM IS DELIBERATE AND IS THE WHOLE
        // POINT OF THIS BLOCK. At egress (§15.8, `nats-channel.ts`'s
        // `journalOutbound`) a journal failure must NEVER change the send
        // result — log, never throw, never return `false` — because the journal
        // write PRECEDES the publish there, and blocking the push on a faulted
        // history write would turn one missing history row into a lost LIVE
        // message (N8, losing). HERE nothing this seam is the SSOT for has been confirmed
        // to anyone yet: no chunk-writer result is on the wire, no turn has run,
        // and the journal is the authority that decides whether the message
        // exists at all. So here a journal failure IS an accept failure.
        //
        // Position: AFTER the `invalidated` early return (see the collection
        // site — journaling a batch that is about to roll back is N8 in the
        // gaining direction) and BEFORE ANY CHUNK-WRITER RESULT REACHES THE
        // WIRE. The item loop deliberately publishes nothing through either
        // writer — see `ackIds` for why `chunkWriter.add()` inside the loop was
        // NOT good enough. The one exception is the cancelled-inbound fallback
        // branch's direct `sendAck`, which does reach the wire before this
        // point; exception 1 in the catch block below argues why that is right.
        if (deps.deliveryJournal && journalPending.length > 0) {
          // The text is validated HERE rather than at the collection site, and
          // these `non-string-text` lines are emitted only AFTER the append loop
          // has committed, so neither return path that abandons the batch — the
          // `invalidated` one above nor the append failure below — reports a
          // TEXT gap for a message that never ran. (The `no-usable-id` line
          // still fires from the item loop, and correctly so: that item runs
          // even when the batch is refused. Its call site carries the
          // asymmetry.) A non-string `text` can no longer reach us THROUGH THE
          // NATS DOOR at all: #246 half A decodes every inbound frame there and
          // refuses a `user_message` whose `text` is not a string (the older
          // reading — "reaches us from a non-conforming client, because
          // `normalizeInboundUserMessage` copies `raw.text` unvalidated off a
          // frame decoded with a cast" — described the cast that is gone). The
          // check stays because this seam has callers that are not that door, and
          // because what follows is still exactly what would happen if one
          // arrived: `append` would TAKE it (only `user` IDS are validated
          // there), but the shared
          // reducer types `user.text` as a `string`, so a row holding one is a
          // durable row no reader can render. Same verdict as an unusable id:
          // admit, do not journal, say so. And the gap is sharper than a plain
          // omission — the turn still runs and the egress seam journals its
          // answer, so history gains an agent answer with NO preceding user row.
          const journalable: Array<{ wireId: string; randomId: string | undefined; text: string }> = [];
          const unjournalableText: Array<"non-string-text"> = [];
          for (const pending of journalPending) {
            if (typeof pending.text === "string") {
              journalable.push({ wireId: pending.wireId, randomId: pending.randomId, text: pending.text });
            } else unjournalableText.push("non-string-text");
          }
          try {
            for (const pending of journalable) {
              // `conversationId` is the peerId — doc §16.2-7, identical to the
              // egress seam. The journal FILE is already scoped to
              // (tenant, accountId) by its path, and the peerId is the
              // authenticated JWT `sub`, so the triple is complete without
              // reading core's mutable route or agentId.
              //
              // `turnId` IS THIS MESSAGE'S OWN WIRE ID, and that is the client
              // mirror, not an invention. Live, `nats-client-wrapper.ts`'s
              // `nextPublishedUserMessages` applies
              // `{kind:"user", id: bubbleId, text, turnId: wireId}` — the wire id
              // reserved for THAT publish — and all three of its callers
              // (`publish`, and the two held-message release paths) pass their
              // own freshly reserved id, never a shared batch anchor.
              // `applyUser` writes it straight onto the durable message. So
              // omitting it would put `turnId: undefined` in history where live
              // has a value, on EVERY user message — a live≠history field
              // divergence (N8), in rows §15.6's destructive cutover makes the
              // only store, with no schema gate (#271) to migrate later.
              //
              // The plugin agrees independently: `inbound.ts` derives the turn's
              // own id as `message.id ?? "webchannel-turn-<ms>-<rand>"`, i.e. the
              // user message's wire id IS the turn id. (For a P1-8b-coalesced
              // batch the plugin's turn takes the LAST frame's id while the
              // client stamps each bubble with its own — so per-message is the
              // faithful choice, and it is also what the client does.)
              //
              // ⚠️ THIS IS THE `id` QUESTION, AND #243 half 2a IS WHERE IT MOVES.
              // The durable `id` is no longer the client WIRE id — the SERVER
              // mints it inside `appendInboundUser`'s transaction, tied to the
              // `seq` (doc §16.2-1). `turnId` is a SEPARATE field and STAYS the
              // wire id: the client still holds it (`nextPublishedUserMessages`
              // stamps it on the live bubble) and it is the value both sides
              // already agree on, so it is the faithful mirror. The minted id is
              // captured for the ack echo below; in 2a the client keeps
              // reconciling by text/position and ignores that echo (adoption is
              // half 2b).
              //
              // Synchronous and in arrival order, because `seq` order is the
              // stream's order and the stream's order IS the identity model
              // (doc §16.5.3). No batching, no deferral.
              const { messageId, seq, inserted } = deps.deliveryJournal.appendInboundUser(peerId, {
                text: pending.text,
                turnId: pending.wireId,
                ...(pending.randomId !== undefined ? { randomId: pending.randomId } : {}),
              });
              // The echo is keyed by `random_id`, so it exists only for a
              // conforming client. An older client is still journaled (under a
              // server id) and acked; it simply carries no `committed` entry.
              //
              // #244 half A: the echo carries the user message's `seq` too — this
              // is its ONLY wire carrier (the user opener rides no durable frame),
              // and without it the turn's first agent frame reads as a phantom gap.
              if (pending.randomId !== undefined) {
                committedBatch.push({ random_id: pending.randomId, messageId, seq });
              }
              // #245 Part B: broadcast the committed user event to the account's
              // OTHER devices so a user's own send appears there immediately (the
              // Telegram model), rather than lazily on the next agent frame's
              // gap-sync catch-up. ONE publish to the shared `.out` subject — it IS
              // the fan-out (no per-device registry; doc §16.2-8).
              //
              // ⚠️ ONLY ON A GENUINELY NEW ADMISSION (`inserted === true`). A dedup
              // retry re-appends idempotently (`inserted === false`) and must NOT
              // re-broadcast: it would be redundant (the event already went out on
              // the first admission) — harmless if it did (the client's adopt/
              // `applyUser` are idempotent), but this keeps the wire quiet.
              //
              // ⚠️ NOT the origin's authoritative receipt — that stays the
              // `ack.committed` echo above, unchanged. This is the mirror to the
              // OTHER devices; the origin reconciles it against its optimistic
              // bubble by `random_id` (a no-op once the ack drained the linkage),
              // so it too sees exactly one bubble.
              //
              // The gap-sync path (#244 hB / #337) REMAINS the correctness
              // fallback: NATS is at-most-once, so a missed broadcast is caught
              // when the next agent frame opens a seq gap and `get_difference`
              // re-delivers this user event (#337 appends it for a non-origin
              // device). This broadcast only makes the common case immediate.
              if (inserted) {
                deps.sendUserCommitted?.(peerId, {
                  id: messageId,
                  text: pending.text,
                  turnId: pending.wireId,
                  seq,
                  ...(pending.randomId !== undefined ? { random_id: pending.randomId } : {}),
                });
              }
            }
          } catch (error) {
            // ACCEPT FAILURE, expressed with the mechanism this function already
            // has: leave `finalized` false and return, so the `finally` below
            // runs `rollbackBatch()`. That is the same shape the unresolved
            // outcome-store classification uses above (`existing.status ===
            // "unknown"` → `fifoBlocked`, no result published, retry later);
            // §15.7 makes the journal the higher authority, so it gets at least
            // the same discipline.
            //
            // ⚠️ WHAT ACTUALLY UNWINDS — AND THE TWO THINGS THAT DO NOT. An
            // unqualified "everything rolls back" is how N6b happened: an
            // absolute in this file becomes the next reader's premise. So, both
            // MEASURED with probes now kept as tests in
            // `ingress-dedupe-delivery-journal.test.ts`:
            //
            // Unwound — every fresh admission this seam is the SSOT for: no
            // `ack` and no `inbound_rejected` frame (both writers are untouched
            // until the footer below), every outcome write in `pendingWrites`
            // rolled back, every offer in `rollbackOffers` rolled back, every
            // reservation in `deferredReleases` released.
            //
            // NOT unwound, and correct:
            //  1. THE CANCELLED-INBOUND FALLBACK's result. That branch commits
            //     its outcome write and calls `deps.sendAck` DIRECTLY inside the
            //     item loop, bypassing the chunk writers — so its ack is already
            //     on the wire before the journal is consulted, and nothing here
            //     undoes it. The item is text `/stop` already KILLED: it has no
            //     durable row to lose, and that ack is what stops the client
            //     replaying a dead message forever.
            //  2. AN ID-LESS ITEM's dispatch. That branch calls `offer.commit()`
            //     inline and never pushes onto `rollbackOffers`, so `finish()`
            //     promotes it to `attached` and drains it — the item runs even
            //     though the batch was refused. (True of THIS unwinding; the
            //     call site above names the one thing that falsifies it from
            //     outside.) Only a non-conforming client
            //     produces one, and refusing to run text already accepted for
            //     dispatch would lose it outright. `journalGap` reports exactly
            //     this as the live≠history gap it is.
            //
            // Neither exception loses fresh conforming-client text, which is the
            // property §15.7 actually demands.
            //
            // ⚠️ ONE REAL THROW SOURCE HERE, ON PURPOSE. As of #243 half 2a the
            // append goes through `appendInboundUser`, which no longer runs the
            // client-supplied-id VALIDATION the old `journalEventForInboundUser`
            // mapper did (the id is now SERVER-minted from `seq`, always
            // well-formed — item 4's "trust our own mint"). So the only way this
            // catch fires is a genuine STORE FAULT (`append`/`appendInboundUser`
            // hitting SQLite), and a `code="<none>"` diagnostic on it means a
            // construction bug, not a sick database. The `try` still spans the
            // whole append loop because #242 widens the durable event set and a
            // future kind may add a mapper-style refusal — and THAT is when the
            // categories must split.
            //
            // ⚠️ CAUGHT, NOT PROPAGATED. Measured: a rejected `onFlush` is
            // swallowed with NO log by the debouncer's worker
            // (`bounded-inbound-debouncer.ts`'s `pump`: `catch { /* One failed
            // flush must not poison later same-key batches. */ }`), so letting
            // it escape would roll the batch back silently and cost the operator
            // the only line that explains why messages stopped being accepted.
            //
            // ⚠️ A PARTIAL BATCH PRODUCES NO DUPLICATE ROW — and that is ALL
            // this claim covers. It is a fact about the CALLER, not about this
            // function: `nats-client.ts` replays an unacked `user_message` under
            // the SAME id (`flushQueue()` re-queues `entry.message` from the
            // ledger keyed by that id, and `retryDueUnacked()` re-publishes the
            // same entry in-session), so a row committed before the throw comes
            // back as an ordinary `inserted: false` no-op on `journal_user_once`.
            // (The exact opposite of the egress caller, which re-mints
            // `nextMessageId()` per attempt; N6b is what that costs.)
            //
            // ⚠️ IT DOES NOT COVER ORDER, AND ORDER DOES BREAK. Thirty lines up
            // this block says `seq` order IS the identity model, so the residual
            // has to be named rather than argued away: a refused batch holding
            // `A` starts no turn, the client does not gate a new send on a
            // pending unacked entry, so the user's next message `B` is accepted
            // and journaled first, and `A` lands after it when its backoff
            // fires — live `A, B`, replay `B, A`. That is issue **#282**, whose
            // body carries the measurements. ⚠️ #240 HAS LANDED AND DID NOT FIX
            // IT: half 2 made the journal the only history store, so the reorder
            // is now OBSERVABLE by any client that reconnects rather than
            // hypothetical. #282 still owns it, and it got more urgent, not
            // less — do not read the reader's arrival as its resolution.
            //
            // ⚠️ AND IT DOES NOT COVER THE ORPHAN ROW EITHER — issue **#283**.
            // `append` is one IMMEDIATE transaction PER EVENT
            // (`delivery-journal.ts`), so a throw at append *k* leaves rows
            // `1..k-1` COMMITTED while every one of those messages' turns is
            // rolled back here. The retry normally repairs it: the client
            // replays the same ids, the committed rows come back
            // `inserted: false`, and the messages run. But the ledger is
            // memory-only, so if the client loses it before its backoff fires (a
            // page reload), row `1` stays in the journal with no turn and no live
            // bubble — a phantom user bubble in history that live never showed,
            // N8 in the GAINING direction, arriving through a different door than
            // the one the collection site above guards.
            //
            // Reachability, stated honestly rather than hidden or inflated: it
            // needs a MULTI-ITEM batch (the debounce default is 0 ms, so batches
            // are usually size 1 — multi-item ones come from busy-time
            // coalescing), AND a store that fails BETWEEN appends rather than on
            // the first (a closed, corrupt or read-only handle fails uniformly on
            // append 1 and leaves no partial state; a lock taken mid-batch is the
            // realistic case), AND the client losing the ledger before the retry.
            //
            // NOT fixed here on purpose. The fix is an atomic multi-append, and
            // `delivery-journal.ts`'s append docblock currently states the
            // opposite as a rule ("never batch or defer them, because batching
            // reorders"). That rule's REASON does not apply to a synchronous,
            // in-order multi-append — but amending a merged sibling slice's
            // stated contract from a slice that is not about the store is the
            // wrong place for that argument. ⚠️ AND THE READER HAS SINCE ARRIVED
            // — #240 half 2 — so "the row is not visible yet" is no longer part
            // of why this is deferred: an orphan row IS a phantom bubble in a
            // real history read today. #283 carries both options and is the only
            // thing still holding the fix.
            //
            // The retry is BOUNDED, not infinite, and the honest claim is worth
            // stating: the ledger is capped at `MAX_UNACKED = 100` in memory and
            // evicts the oldest with "they will not be replayed on reconnect",
            // surfacing as a `failed` bubble; a page reload loses it entirely.
            // Doc §16.2-9 already records the memory-cap outbox as a known gap.
            warnJournal(
              "append-failed",
              "webchannel: delivery journal append failed at the inbound accept " +
                `peer=${logSafe(peerId)} journalable=${journalable.length} ` +
                `action=reject-accept-client-retries ${journalFailureDiagnostic(error)}`,
            );
            return;
          }
          for (const reason of unjournalableText) journalGap(reason);
        }
        for (const write of pendingWrites) write.commit();
        for (const commit of commitOffers) commit();
        // THE ONLY PLACE EITHER WRITER IS TOUCHED. `add` can publish (see
        // `ackIds`), so both the adds and the finishes live here, below the
        // journal and below every persistence commit — this is what the
        // docblock's "published after persistence" means.
        //
        // Same ids, same order, so the same chunk boundaries as before; the only
        // observable change is that all `ack` frames now precede all
        // `inbound_rejected` frames instead of interleaving by item. The two
        // classes are disjoint id sets and the client handles them
        // independently, and the footer already finished them in this order.
        //
        // #243 half 2a: the `ack` writer is BUILT HERE, not at the top of the
        // batch, because `committedBatch` is only complete now — after the fresh
        // admissions minted their ids (append loop) and the deduped retries
        // recovered theirs (item loop). The writer attaches the whole echo to its
        // FIRST published frame and measures it on the wire; `publish` forwards
        // `frame.committed` to `deps.sendAck`, whose channel-side writer re-carries
        // it on ITS first frame (`sendIngressResult`).
        const ack = createIngressResultChunkWriter({
          type: "ack",
          // Pass the third arg ONLY when there is an echo to carry, so an ack
          // with no `committed` calls `sendAck` with its original two-arg shape.
          publish: (frame) => {
            const committed = frame.type === "ack" ? frame.committed : undefined;
            return (committed && committed.length > 0
              ? deps.sendAck?.(peerId, frame.ids, committed)
              : deps.sendAck?.(peerId, frame.ids)) ?? false;
          },
          measureWireBytes: measure,
          effectiveOutboundLimit: deps.effectiveOutboundLimit?.(),
          ...(committedBatch.length > 0 ? { committed: committedBatch } : {}),
          onTooSmall: () => logWarn?.("webchannel: result frame cannot fit effective NATS max_payload"),
        });
        for (const id of ackIds) ack.add(id);
        ack.finish();
        for (const id of rejectedIds) rejected.add(id);
        rejected.finish();
        for (const release of deferredReleases) release();
        finalized = true;
      } finally {
        // Nested: a rejected rollback must not strand the lease in `openLeases`.
        try {
          if (!finalized) await rollbackBatch();
        } finally {
          lease.finish();
        }
      }
      return;
    }

    if (!checkAndRecord || !dispatch || !coalesce) {
      throw new Error("createIngressOnFlush requires either outcome/lease or legacy dedupe dependencies");
    }
    const rawItems = items.map((value) => "item" in value ? value.item : value);
    // P0-7b ack first — see the doc. Ack is receipt of ADMISSION and covers all
    // id-carrying items regardless of the dedupe outcome, so it runs before the
    // fresh-filter. Guard `items[0]` (an empty flush never fires, but stay total).
    // Cancel fallback lookup is deliberately first. A hit represents text that
    // /stop already killed, so it must never reach ordinary ack/dedupe/dispatch.
    const ordinary: T[] = [];
    for (const item of rawItems) {
      if (!isActive()) return;
      const key = ingressDedupeKey(item);
      if (!key || !cancelledFallback?.has(key, accountId)) {
        ordinary.push(item);
        continue;
      }
      let recorded = false;
      try {
        await checkAndRecord(key, { namespace: accountId });
        if (!isActive()) return;
        recorded = true;
      } catch {
        if (!isActive()) return;
        logWarn?.("webchannel: cancelled-inbound fallback outcome retry failed");
      }
      const id = item.message.id as string;
      if (!isActive()) return;
      const acked = sendAck?.(item.peerId, [id]) ?? false;
      if (!acked) logWarn?.("webchannel: cancelled-inbound fallback result delivery failed");
      if (recorded && acked) cancelledFallback.delete(key, accountId);
    }

    const anchor = ordinary[0];
    if (!isActive()) return;
    if (anchor && sendAck) {
      const ackIds = [
        ...new Set(
          ordinary
            .map((i) => i.message.id)
            .filter((id): id is string => typeof id === "string" && id.length > 0),
        ),
      ];
      if (ackIds.length > 0 && !sendAck(anchor.peerId, ackIds)) {
        // #123: serialize the whole array as JSON, then pass that JSON text to
        // logSafe so logfmt sees one outer quoted value. A bare `["a","b"]`
        // starts as an unquoted logfmt value and the first `"` makes the record
        // invalid; `logSafe` preserves the JSON boundaries behind that outer
        // logfmt delimiter.
        logWarn?.(
          `webchannel: ingress admission ack failed for peer=${logSafe(anchor.peerId)} ` +
            `ids=${logSafe(JSON.stringify(ackIds))}`,
        );
      }
    }
    const fresh = await filterFreshInboundItems(
      ordinary,
      accountId,
      checkAndRecord,
      sinks,
      isActive,
    );
    if (!isActive()) return;
    const first = fresh[0];
    if (!first) return;
    if (!isActive()) return;
    dispatch(first.peerId, coalesce(fresh.map((i) => i.message)));
  };
}

/**
 * P0-7b — handle the inbound items a `/stop` CANCELLED out of the debounce window.
 *
 * A message that is still buffered in the pre-run debounce window when the user
 * sends `/stop` is dropped by `cancelKey` (P1-8b's control-lane contract) BEFORE
 * it ever reaches `onFlush` — so it was never dedupe-recorded and never acked, yet
 * the client's replay ledger still holds it. Without this, the next reconnect would
 * replay that killed text, the server would see it as FRESH, ack it, and run a turn
 * the user explicitly aborted (possibly much later). For each id-carrying dropped
 * item we:
 *   1. RECORD `${peerId}:${id}` first — so if an in-flight replay lands before the
 *      ack, ingress dedupe drops it as a duplicate and the killed text never runs;
 *   2. THEN `sendAck` the ids — draining the client's ledger when it is still
 *      connected, so it stops replaying at all.
 * Record-before-ack is load-bearing: acking first leaves a window where a replay
 * arrives before the record and runs. (This is the OPPOSITE ordering from the
 * admit path in `createIngressOnFlush`, where the message IS being admitted so
 * ack-first is safe — here the message was KILLED, so a pre-record replay would
 * wrongly run it.)
 *
 * The bounded debouncer awaits this handler on behalf of every cancelled entry,
 * retaining its reservation until persistence and result delivery settle. A
 * record that throws is swallowed with a WARN
 * (`logWarn`, matching the fail-open severity split in `filterFreshInboundItems`)
 * and does NOT block the ack — a lost record only re-opens the pre-existing
 * pre-P0-7b replay window (a replay could run), which is strictly no worse than
 * before this fix. Id-less items are skipped entirely (an older client never
 * ledgers them, so there is nothing to record or ack). `cancelKey` is per-peer,
 * but ids are grouped by peer defensively so a single ack frame per peer carries
 * exactly its own ids.
 */
export async function recordCancelledInboundItems<T extends IngressDedupeItem>(
  items: readonly T[],
  accountId: string,
  checkAndRecord: IngressDedupeCheck,
  sendAck: (peerId: string, ids: string[]) => boolean,
  logWarn?: (message: string) => void,
  cancelledFallback?: CancelledInboundFallbackTombstones,
  canPublish: () => boolean = () => true,
): Promise<void> {
  const idsByPeer = new Map<string, string[]>();
  for (const item of items) {
    if (!canPublish()) return;
    const key = ingressDedupeKey(item);
    if (!key) continue; // id-less/non-conforming: never persist or retain it.
    const id = item.message.id as string;
    let suppressionReady = false;
    try {
      await checkAndRecord(key, { namespace: accountId });
      if (!canPublish()) return;
      suppressionReady = true;
    } catch {
      if (!canPublish()) return;
      logWarn?.("webchannel: cancelled-inbound suppression record failed; result delivery remains best-effort");
      cancelledFallback?.add(key, accountId);
    }
    if (!suppressionReady) cancelledFallback?.add(key, accountId);
    // Ack regardless of the record outcome: the ack drains the client ledger, and
    // the record is the fallback for when the ack cannot reach a disconnected client.
    const ids = idsByPeer.get(item.peerId) ?? [];
    ids.push(id);
    idsByPeer.set(item.peerId, ids);
  }
  for (const [peerId, ids] of idsByPeer) {
    if (!canPublish()) return;
    if (!sendAck(peerId, ids)) {
      logWarn?.("webchannel: cancelled-inbound result delivery failed");
    }
  }
}
import type { RetainedDebounceEntry } from "./bounded-inbound-debouncer.js";
import type { DispatcherBatchLease } from "./inbound-queue.js";
import type {
  IngressOutcomeStore,
  OutcomeLookup,
  OutcomeRecordResult,
  OutcomeWriteReceipt,
} from "./ingress-outcome.js";
import { createRateLimitedOutcomeFailureWarning } from "./ingress-outcome.js";
import { createIngressResultChunkWriter } from "./ingress-result-chunks.js";
import type { IngressResultFrame } from "./ingress-result-chunks.js";
// #123: peer ids and message ids reach these log lines straight off the wire.
import { logSafe } from "./log-safe.js";
/**
 * v6 delivery journal (#239 half 3). TYPE-ONLY for the store — this module never
 * opens one — and a value import for the id-length bound and failure diagnostic
 * beside it. (#243 half 2a: the accept seam no longer calls
 * `journalEventForInboundUser` — the server mints the id inside
 * `appendInboundUser` — so that mapper is no longer imported here.)
 */
import type { DeliveryJournal } from "./delivery-journal.js";
import {
  MAX_INBOUND_USER_ID_LENGTH,
  journalFailureDiagnostic,
} from "./delivery-journal-event.js";
