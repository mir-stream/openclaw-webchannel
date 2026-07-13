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
 *   (b) the P1-8b coalesce merge keeps only the FIRST message's fields, so a
 *       per-id rollback after a merged-turn failure would be lossy anyway; and
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
): Promise<T[]> {
  const survivors: T[] = [];
  for (const item of items) {
    // Normalize the wire `id`: only a non-empty, in-bounds STRING is dedupe-able.
    // A non-string or over-length id is treated as ID-LESS — passed through
    // un-deduped and never recorded, so a hostile client cannot amplify SQLite
    // storage with junk keys. (Such a frame is still ACKed by the P0-7b ack
    // layer, which accepts any non-empty string; it simply is not deduped —
    // acceptable, since only a non-conforming client ever hits this path.)
    const rawId = item.message.id;
    const id =
      typeof rawId === "string" && rawId.length > 0 && rawId.length <= MAX_INGRESS_DEDUPE_ID_LENGTH
        ? rawId
        : undefined;
    if (!id) {
      // Back-compat / hardening: id-less (or non-conforming) frames pass through
      // un-deduped.
      survivors.push(item);
      continue;
    }
    const key = `${item.peerId}:${id}`;
    let fresh: boolean;
    try {
      fresh = await checkAndRecord(key, { namespace: accountId });
    } catch (err) {
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
  checkAndRecord: IngressDedupeCheck;
  /** Route the surviving, coalesced message onto the per-session FIFO. */
  dispatch: (peerId: string, message: T["message"]) => void;
  /** Merge the surviving frames into ONE turn's message (P1-8b coalesce). */
  coalesce: (messages: T["message"][]) => T["message"];
  /** Routine duplicate-drop sink (info). */
  logInfo?: (message: string) => void;
  /** Fail-open fault sink (warn). */
  logWarn?: (message: string) => void;
};

/**
 * Build the debouncer's `onFlush` handler — the REAL one index-nats.ts wires,
 * extracted to `src/` so it is tsc-checked and tested directly (index-nats.ts is
 * outside tsconfig, and an inlined closure there could silently drift, e.g.
 * dispatch `items` instead of `fresh`, or drop the accountId namespace).
 *
 * WHY IT LIVES IN onFlush (not setMessageHandler). The dedupe check is async
 * (`checkAndRecord` may await SQLite). `onFlush` is SAME-PEER SERIALIZED by core's
 * keyChains (the debouncer's `serializeImmediate` + `buildKey: peerId`), so
 * awaiting the check here cannot reorder a peer's messages. Awaiting the same
 * check in the fire-and-forget `setMessageHandler` COULD: a slower SQLite miss
 * could let a later frame overtake an earlier one. So the dedupe belongs on the
 * serialized flush path, not the raw handler.
 *
 * WHAT IT DOES, per flush batch:
 *  - filter to FRESH items (drop `${peerId}:${id}` already admitted in the window;
 *    id-less frames pass through; a dedupe fault fails OPEN — keep the message);
 *  - an all-duplicates batch dispatches NOTHING (every item was dropped);
 *  - otherwise coalesce the survivors into one turn and dispatch it to
 *    `fresh[0].peerId`. The batch is one peer's window (same `buildKey`), so the
 *    first survivor's peer is the whole batch's peer.
 *
 * CONTROL-LANE NOTE: `/stop` (and the NL abort vocabulary) BYPASS the debouncer
 * entirely in setMessageHandler, so aborts never reach this path and are never
 * deduped — a duplicate abort is a harmless cosmetic double-bubble, and the abort
 * must not wait on SQLite.
 *
 * Per-id RECORDING happens inside `filterFreshInboundItems` BEFORE the coalesce/
 * dispatch — every id in the batch is recorded as it is checked, so a duplicate
 * already merged into this same turn is still individually recorded and a later
 * replay of it is dropped.
 */
export function createIngressOnFlush<T extends IngressDedupeItem>(
  deps: IngressOnFlushDeps<T>,
): (items: readonly T[]) => Promise<void> {
  const { accountId, checkAndRecord, dispatch, coalesce, logInfo, logWarn } = deps;
  const sinks: IngressDedupeLogSinks = { info: logInfo, warn: logWarn };
  return async (items) => {
    const fresh = await filterFreshInboundItems(items, accountId, checkAndRecord, sinks);
    const first = fresh[0];
    if (!first) return;
    dispatch(first.peerId, coalesce(fresh.map((i) => i.message)));
  };
}
