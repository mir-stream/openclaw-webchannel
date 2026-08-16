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
 * loses the message permanently: on restart the P0-7b replay queue re-sends the
 * SAME id, we see it as already-recorded, and drop it — deduping away the very
 * message the replay queue exists to recover. We accept this because the
 * alternative (claim/commit: record only AFTER the turn's effect persists)
 * trades this rare case for a far worse-in-practice one — it RE-ADMITS duplicates
 * on every crash-AFTER-effect and every partial-delivery, which are much more
 * common than crash-in-window, and rationale (b) means a per-id commit/rollback
 * is wrong for merged turns anyway. Crucially the loss window here is
 * record→turn-start — sub-millisecond on the serialized flush path — versus the
 * wide duplicate-turn window claim/commit would open (record→effect-persisted,
 * spanning the whole agent run). Narrow at-most-once beats wide at-least-once for
 * this surface. This deviation from the sketch is deliberate and settled.
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
 */
const MAX_INGRESS_DEDUPE_ID_LENGTH = 128;
export const MAX_CANCELLED_INBOUND_FALLBACK_TOMBSTONES = 256;
export const MAX_CANCELLED_INBOUND_FALLBACK_BYTES = 256 * 1024;

/** Apply the same bounded/non-empty id rule to persistent and fallback keys. */
export function ingressDedupeKey(item: IngressDedupeItem): string | undefined {
  const id = item.message.id;
  return typeof id === "string" && id.length > 0 && id.length <= MAX_INGRESS_DEDUPE_ID_LENGTH
    ? `${item.peerId}:${id}`
    : undefined;
}

export type ControlLaneRetryAdmission =
  | { status: "fresh"; persisted: Promise<void> }
  | { status: "duplicate" }
  | { status: "untracked" };

export type ControlLaneRetryGuard = {
  admit(peerId: string, id: string | undefined): ControlLaneRetryAdmission;
};

const DEFAULT_MAX_PENDING_CONTROL_MARKERS = 256;

/**
 * Classify control-lane retries by the same stable inner id as ordinary ingress.
 *
 * The outcome store's synchronous hot marker handles completed writes. A small
 * bounded in-flight set closes only the interval before a first marker commits,
 * allowing destructive control effects to remain synchronous and ahead of later
 * same-peer input. This is transient admission state, not a second long-lived
 * replay cache; cold-cache/restart behavior remains an explicit residual.
 */
export function createControlLaneRetryGuard(options: {
  accountId: string;
  outcomeStore: Pick<IngressOutcomeStore, "peek" | "record">;
  onPersistenceFailure?: () => void;
  maxPending?: number;
}): ControlLaneRetryGuard {
  const pending = new Set<string>();
  const maxPending = Math.max(1, options.maxPending ?? DEFAULT_MAX_PENDING_CONTROL_MARKERS);
  let warned = false;
  const reportPersistenceFailure = () => {
    if (warned) return;
    warned = true;
    try { options.onPersistenceFailure?.(); } catch { /* diagnostics never affect routing */ }
  };

  return {
    admit(peerId, id) {
      const key = ingressDedupeKey({ peerId, message: { id } });
      if (!key) return { status: "untracked" };
      if (pending.has(key) || options.outcomeStore.peek(options.accountId, key) === "accepted") {
        return { status: "duplicate" };
      }
      if (pending.size >= maxPending) {
        reportPersistenceFailure();
        return { status: "untracked" };
      }

      pending.add(key);
      const persisted = options.outcomeStore
        .record(options.accountId, key, "accepted")
        .then((result) => {
          if (result.status !== "recorded") {
            reportPersistenceFailure();
            return;
          }
          result.write.commit();
        })
        .catch(() => {
          reportPersistenceFailure();
        })
        .finally(() => {
          pending.delete(key);
        });

      return { status: "fresh", persisted };
    },
  };
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

/** Minimum item shape: a routable peer and a message that may carry a dedupe id. */
export type IngressDedupeItem = {
  peerId: string;
  message: { id?: string };
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
 * cannot dedupe against (poison) another peer's ids. The key is `${peerId}:${id}`.
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
        `webchannel: ingress dedupe check failed for peer=${item.peerId} id=${id} — ` +
          `keeping message (fail-open): ${String(err)}`,
      );
      survivors.push(item);
      continue;
    }
    if (fresh) {
      survivors.push(item);
    } else {
      sinks?.info?.(
        `webchannel: dropped duplicate inbound message peer=${item.peerId} id=${id}`,
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
  sendAck?: (peerId: string, ids: string[]) => boolean;
  sendInboundRejected?: (peerId: string, ids: string[]) => boolean;
  outcomeStore?: IngressOutcomeStore;
  beginBatch?: (peerId: string) => DispatcherBatchLease<T["message"]>;
  measureResultWireBytes?: (peerId: string, frame: IngressResultFrame) => number;
  effectiveOutboundLimit?: () => number;
  /** Cancel-record failures that must be suppressed before ordinary admission. */
  cancelledFallback?: CancelledInboundFallbackTombstones;
  /** Routine duplicate-drop sink (info). */
  logInfo?: (message: string) => void;
  /** Fail-open fault sink (warn). */
  logWarn?: (message: string) => void;
  /** Account-runtime lifecycle fence, combined with each retained entry fence. */
  isActive?: () => boolean;
};

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
 *  - lookup the durable accepted/overloaded outcome before admission;
 *  - offer fresh work against the dispatcher lease and record exactly one chosen
 *    outcome before committing the lease;
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
 * entirely in setMessageHandler, so aborts never reach this path and must not
 * wait behind its FIFO. The runtime instead applies
 * `createControlLaneRetryGuard`: it uses this same outcome store to classify the
 * stable inner id before destructive control effects, then ACKs duplicates
 * without dispatch. The control-lane branch acks its own frame separately.
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
      const ack = createIngressResultChunkWriter({
        type: "ack",
        publish: (frame) => deps.sendAck?.(peerId, frame.ids) ?? false,
        measureWireBytes: measure,
        effectiveOutboundLimit: deps.effectiveOutboundLimit?.(),
        onTooSmall: () => logWarn?.("webchannel: result frame cannot fit effective NATS max_payload"),
      });
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
            if (offer.status === "accepted") offer.commit();
            else release();
            continue;
          }
          const id = item.message.id as string;

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
                "accepted",
                { replaceOpposite: true },
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
              // The fallback is authoritative accepted suppression, but without
              // a successful replacement write it has no publishable chosen
              // outcome. Preserve peer FIFO until that retry succeeds.
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
            release();
            if (existing.outcome === "accepted") ack.add(id);
            else rejected.add(id);
            continue;
          }

          const offer = lease.offer(item.message, reservation);
          if (offer.status === "disposed") {
            release();
            continue;
          }
          if (offer.status === "rejected") {
            let result: OutcomeRecordResult | undefined;
            try {
              result = await deps.outcomeStore.record(accountId, key, "overloaded");
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
              rejected.add(id);
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
            ack.add(id);
          } else {
            rollbackOnce();
            fifoBlocked = true;
          }
        }

        // `/stop` or peer retirement can invalidate an earlier committed offer
        // while this same batch is stalled on a later lookup/write. Nothing in
        // an invalidated generation may reach the dispatcher or publish its
        // normal result. Cancellation keeps accepted markers as tombstones;
        // teardown removes them so a replacement runtime is not poisoned.
        const invalidated = !isActive() || retained.some((entry) => !entry.isActive());
        if (invalidated) {
          // Release key-operation gates through exact-write rollback before
          // waiting for cancellation, whose accepted replacement write may be
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
        for (const write of pendingWrites) write.commit();
        for (const commit of commitOffers) commit();
        ack.finish();
        rejected.finish();
        for (const release of deferredReleases) release();
        finalized = true;
      } finally {
        if (!finalized) await rollbackBatch();
        lease.finish();
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
        logWarn?.(`webchannel: ingress admission ack failed for peer=${anchor.peerId} ids=${ackIds.join(",")}`);
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
