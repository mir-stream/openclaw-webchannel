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
 * This deviation from the sketch is deliberate and settled.
 */

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
 * Return the items that should proceed to dispatch, in their original order.
 *
 * For each item, in order:
 *  - No `id` (older client): KEEP, and never call `checkAndRecord` — an absent
 *    id is not dedupe-able, and recording an empty key would poison the namespace.
 *  - `checkAndRecord` returns `true` (not recently seen → recorded): KEEP.
 *  - returns `false` (already recorded within the window): DROP as a duplicate,
 *    logging peerId + id at info.
 *  - `checkAndRecord` REJECTS (an unexpected throw): KEEP (fail-open) and log —
 *    losing dedupe for one frame is strictly better than losing the message.
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
  log?: (message: string) => void,
): Promise<T[]> {
  const survivors: T[] = [];
  for (const item of items) {
    const id = item.message.id;
    if (!id) {
      // Back-compat: id-less frames pass through un-deduped.
      survivors.push(item);
      continue;
    }
    const key = `${item.peerId}:${id}`;
    let fresh: boolean;
    try {
      fresh = await checkAndRecord(key, { namespace: accountId });
    } catch (err) {
      log?.(
        `webchannel: ingress dedupe check failed for peer=${item.peerId} id=${id} — ` +
          `keeping message (fail-open): ${String(err)}`,
      );
      survivors.push(item);
      continue;
    }
    if (fresh) {
      survivors.push(item);
    } else {
      log?.(
        `webchannel: dropped duplicate inbound message peer=${item.peerId} id=${id}`,
      );
    }
  }
  return survivors;
}
