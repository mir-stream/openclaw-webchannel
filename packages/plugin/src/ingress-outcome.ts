import { Buffer } from "node:buffer";
import {
  createPersistentDedupe,
  type PersistentDedupe,
} from "openclaw/plugin-sdk/persistent-dedupe";

/**
 * The terminal verdicts an inbound id can carry. Each has its OWN durable
 * marker store — they are set-membership stores, so a distinct outcome is a
 * distinct namespace, not a value in a shared row.
 *
 * - `accepted`   — admitted for a turn. The delivery journal is the authority on
 *                  whether that actually completed; see `OutcomeLookup` below.
 * - `overloaded` — refused for backpressure. The peer gets `inbound_rejected`.
 * - `cancelled`  — ⭐ #344: text `/stop` KILLED, suppressed on purpose and
 *                  DELIBERATELY NEVER JOURNALED. Split out of `accepted` in this
 *                  slice, and the split is the whole point: the three
 *                  cancellation writers (`nats-account-runtime.ts`'s `onCancel`,
 *                  `ingress-dedupe.ts`'s cancelled-inbound fallback,
 *                  `inbound-overflow-resolver.ts`'s `recoverCancelled`) used to
 *                  record `accepted` with no row, which is byte-identical to the
 *                  crash-window state the accept seam must RE-ADMIT. One marker
 *                  value cannot mean both "not journaled yet, run it" and "never
 *                  journal this, drop it", so it is now two.
 *                  A replay under this marker is ACKED (so the client's ledger
 *                  drains) and dropped — never re-admitted, never
 *                  `inbound_rejected`.
 */
export type IngressOutcome = "accepted" | "overloaded" | "cancelled";
export type IngressOutcomeFailureCategory =
  | "lookup-overloaded"
  | "lookup-accepted"
  | "lookup-cancelled"
  | "record-accepted"
  | "record-overloaded"
  | "record-cancelled"
  | "replace-with-accepted"
  | "replace-with-overloaded"
  | "replace-with-cancelled"
  | "rollback-accepted"
  | "rollback-overloaded"
  | "rollback-cancelled"
  | "rollback-recovery-accepted"
  | "rollback-recovery-overloaded"
  | "rollback-recovery-cancelled"
  | "rollback-recovery-poisoned"
  | "adapter-lookup"
  // ⚠️ NO `adapter-record-cancelled` SIBLING, DELIBERATELY. These three name a
  // record whose ADAPTER THREW, and they exist because `ingress-dedupe.ts`
  // reports that through `warnOutcomeFailure`. Its `cancelled` record — the
  // cancelled-inbound fallback branch, the only one in this package that catches
  // a throw — has its own dedicated line ("cancelled-inbound fallback outcome
  // retry failed"), so a fourth category here would have no emitter. Add it the
  // day a call site needs it, not for the shape of the list.
  | "adapter-record-accepted"
  | "adapter-record-overloaded";
export type IngressOutcomeFailureWarning = (
  accountId: string,
  category: IngressOutcomeFailureCategory,
) => void;
/**
 * ⚠️ `{status:"found", outcome:"accepted"}` IS NOT PROOF THAT THE MESSAGE WAS
 * ACCEPTED (#292, #344). This store is an OPTIMIZATION LAYER over the delivery
 * journal, which is the SSOT for user messages (doc §15.7): `record()` persists
 * its marker through the SDK store the moment it is called, and the accept
 * seam's journal row is written later, so a crash — or any build that recorded
 * markers before the journal existed — can leave a marker with no row. The
 * journal is the authority on that disagreement, and BOTH readers of this result
 * apply it: `ingress-dedupe.ts`'s found/accepted branch RE-ADMITS when the row is
 * missing, and `inbound-overflow-resolver.ts`'s accepted arm PUBLISHES NOTHING
 * (it can only report a verdict, so withholding one leaves the client's ledger
 * entry intact for the seam to take).
 *
 * ⚠️ THE CENSUS IS THE CLAIM, AND IT WAS WRONG FOR A ROUND. This used to end "a
 * caller that treats this result as a terminal accept without the same check is
 * reintroducing #344" — while the PR that wrote the sentence still shipped
 * exactly such a caller in the resolver. So: any NEW reader owes the same check,
 * and the two above are the complete set today. Grep before adding a third —
 * `outcomeStore.lookup(` and `peek(` are the entry points.
 *
 * ⚠️ AND THAT IS EXACTLY WHY `cancelled` IS ITS OWN OUTCOME. "Marker present,
 * no journal row" has two producers with OPPOSITE required handling: the crash
 * window (re-admit) and a `/stop` suppression (drop). While both recorded
 * `accepted`, the accept seam could not tell them apart and re-ran killed text —
 * the round-1 defect on this slice. Read the outcome, not the row, to decide
 * WHICH question to ask; ask the journal for a VERDICT only on `accepted`. (Both
 * readers still LOOK UP the row on `cancelled`, but only to carry the
 * `committed` echo for a message that was journaled before the `/stop` landed —
 * the row never changes the cancelled verdict.)
 */
export type OutcomeLookup =
  | { status: "found"; outcome: IngressOutcome }
  | { status: "not-found" }
  | { status: "unknown"; error: unknown };
export type OutcomeRecordResult =
  | {
      status: "recorded";
      durability: "durable" | "memory-only";
      write: OutcomeWriteReceipt;
    }
  | { status: "unknown"; error: unknown };

export interface OutcomeWriteReceipt {
  readonly outcome: IngressOutcome;
  readonly created: boolean;
  readonly durability: "durable" | "memory-only";
  /** Make this exact operation visible to synchronous hot-cache peeks. */
  commit(): void;
  /** Remove only this operation's newly-created marker, then release its key gate. */
  rollback(): Promise<boolean>;
}

export interface IngressOutcomeStore {
  peek(accountId: string, key: string): IngressOutcome | undefined;
  lookup(accountId: string, key: string): Promise<OutcomeLookup>;
  record(
    accountId: string,
    key: string,
    outcome: IngressOutcome,
    options?: { replaceOthers?: boolean },
  ): Promise<OutcomeRecordResult>;
  forget(accountId: string, key: string, outcome: IngressOutcome): Promise<boolean>;
  hotSize(): { entries: number; bytes: number };
  rollbackRecoverySize(): { entries: number; bytes: number; poisoned: boolean };
}

export const MAX_INGRESS_OUTCOME_HOT_ENTRIES = 2_048;
export const MAX_INGRESS_OUTCOME_HOT_BYTES = 2 * 1024 * 1024;
export const MAX_INGRESS_OUTCOME_ROLLBACK_RECOVERY_ENTRIES = 2_048;
export const MAX_INGRESS_OUTCOME_ROLLBACK_RECOVERY_BYTES = 2 * 1024 * 1024;
const HOT_ENTRY_OVERHEAD = 64;

type OutcomeStoreOptions = {
  accepted: PersistentDedupe;
  overloaded: PersistentDedupe;
  /**
   * #344. Its own namespace, because a `PersistentDedupe` stores set membership
   * and nothing else — there is no field to hang a verdict on, so a third
   * verdict is a third store.
   */
  cancelled: PersistentDedupe;
  maxHotEntries?: number;
  maxHotBytes?: number;
  maxRollbackRecoveryEntries?: number;
  maxRollbackRecoveryBytes?: number;
  /**
   * #344: takes the WINNING outcome, not a message — the emitted line is built
   * by `createRateLimitedOutcomeInvariantWarning` so it cannot disagree with the
   * decision that triggered it.
   */
  warnInvariant?: (winner: IngressOutcome) => void;
  warnFailure?: IngressOutcomeFailureWarning;
};

type HotEntry = {
  accountId: string;
  key: string;
  outcome: IngressOutcome;
  durability: "durable" | "memory-only";
  bytes: number;
};

function hotKey(accountId: string, key: string): string {
  return `${accountId.length}:${accountId}${key}`;
}

function hotBytes(accountId: string, key: string): number {
  return Buffer.byteLength(accountId, "utf8") + Buffer.byteLength(key, "utf8") + HOT_ENTRY_OVERHEAD;
}

/**
 * Lookup precedence, STRONGEST SUPPRESSION FIRST — and the order is a decision,
 * not an accident (#344).
 *
 * A key must carry exactly one terminal outcome; `replaceOthers` is what keeps
 * that true at write time. This order decides who wins if a partial failure ever
 * leaves two, and it is the fail-safe direction: `accepted` is the only verdict
 * that RUNS the text, so it loses to both refusals.
 *
 * `cancelled` outranks `overloaded` on purpose. Both refuse, but they tell the
 * peer different things — `cancelled` acks silently, `overloaded` publishes
 * `inbound_rejected`. `inbound-overflow-resolver.ts`'s `recoverCancelled` branch
 * already states the rule this encodes: text the user killed "must never be
 * reclassified as overloaded merely because its replay arrived while the raw
 * retention budget was full." That resolver enforces it at write time; this
 * enforces the same thing at read time.
 */
const OUTCOME_PRECEDENCE = ["cancelled", "overloaded", "accepted"] as const;

/** Durability-aware adapter around mutually-exclusive persistent dedupe stores. */
export function createIngressOutcomeStore(options: OutcomeStoreOptions): IngressOutcomeStore {
  const maxEntries = options.maxHotEntries ?? MAX_INGRESS_OUTCOME_HOT_ENTRIES;
  const maxBytes = options.maxHotBytes ?? MAX_INGRESS_OUTCOME_HOT_BYTES;
  const maxRecoveryEntries = options.maxRollbackRecoveryEntries
    ?? MAX_INGRESS_OUTCOME_ROLLBACK_RECOVERY_ENTRIES;
  const maxRecoveryBytes = options.maxRollbackRecoveryBytes
    ?? MAX_INGRESS_OUTCOME_ROLLBACK_RECOVERY_BYTES;
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 0) throw new TypeError("maxHotEntries is invalid");
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new TypeError("maxHotBytes is invalid");
  if (!Number.isSafeInteger(maxRecoveryEntries) || maxRecoveryEntries < 0) {
    throw new TypeError("maxRollbackRecoveryEntries is invalid");
  }
  if (!Number.isSafeInteger(maxRecoveryBytes) || maxRecoveryBytes < 0) {
    throw new TypeError("maxRollbackRecoveryBytes is invalid");
  }
  const hot = new Map<string, HotEntry>();
  let totalHotBytes = 0;
  // A receipt rollback owns the only operation gate for its key, but the SDK's
  // `forget` can fail after the marker was durably created. Retain bounded,
  // content-free metadata for those exact markers so a same-process cold lookup
  // cannot rediscover one and ACK/reject work that was never dispatched.
  const rollbackRecovery = new Map<string, HotEntry>();
  let totalRollbackRecoveryBytes = 0;
  let rollbackRecoveryPoisoned = false;
  const rollbackRecoveryPoisonedError = new Error(
    "ingress outcome rollback recovery capacity exhausted",
  );

  const putHot = (
    accountId: string,
    key: string,
    outcome: IngressOutcome,
    durability: "durable" | "memory-only" = "durable",
  ) => {
    const mapKey = hotKey(accountId, key);
    const bytes = hotBytes(accountId, key);
    const prior = hot.get(mapKey);
    if (prior) {
      totalHotBytes -= prior.bytes;
      hot.delete(mapKey);
    }
    if (maxEntries === 0 || bytes > maxBytes) return;
    while (hot.size >= maxEntries || totalHotBytes + bytes > maxBytes) {
      const oldest = hot.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      totalHotBytes -= hot.get(oldest)!.bytes;
      hot.delete(oldest);
    }
    hot.set(mapKey, { accountId, key, outcome, durability, bytes });
    totalHotBytes += bytes;
  };

  const deleteHot = (accountId: string, key: string, outcome?: IngressOutcome) => {
    const mapKey = hotKey(accountId, key);
    const entry = hot.get(mapKey);
    if (!entry || (outcome && entry.outcome !== outcome)) return;
    totalHotBytes -= entry.bytes;
    hot.delete(mapKey);
  };

  const rememberFailedRollback = (
    accountId: string,
    key: string,
    outcome: IngressOutcome,
    durability: "durable" | "memory-only",
  ): void => {
    const mapKey = hotKey(accountId, key);
    deleteHot(accountId, key, outcome);
    if (rollbackRecoveryPoisoned || rollbackRecovery.has(mapKey)) return;
    const bytes = hotBytes(accountId, key);
    if (
      maxRecoveryEntries === 0
      || bytes > maxRecoveryBytes
      || rollbackRecovery.size >= maxRecoveryEntries
      || totalRollbackRecoveryBytes + bytes > maxRecoveryBytes
    ) {
      // Never evict a known-unsafe marker merely to honor the metadata cap. A
      // single bounded latch instead makes every later operation unknown for
      // this process. A process restart retains the plan's documented crash
      // tradeoff, but this live process can no longer silently ACK lost work.
      rollbackRecoveryPoisoned = true;
      options.warnFailure?.(accountId, "rollback-recovery-poisoned");
      return;
    }
    rollbackRecovery.set(mapKey, { accountId, key, outcome, durability, bytes });
    totalRollbackRecoveryBytes += bytes;
    options.warnFailure?.(accountId, `rollback-${outcome}`);
  };

  /** The one place an outcome maps to its backing store. */
  const storeFor = (outcome: IngressOutcome): PersistentDedupe =>
    outcome === "accepted"
      ? options.accepted
      : outcome === "overloaded"
        ? options.overloaded
        : options.cancelled;

  const hasRecent = async (
    store: PersistentDedupe,
    accountId: string,
    key: string,
  ): Promise<{ found: boolean; diskError?: unknown }> => {
    let diskError: unknown;
    const found = await store.hasRecent(key, {
      namespace: accountId,
      onDiskError: (error) => { diskError = error; },
    });
    return { found, ...(diskError !== undefined ? { diskError } : {}) };
  };

  // Serialize the full lookup/write/conditional-cleanup lifecycle per
  // account+key. A write receipt deliberately retains its turn until commit or
  // rollback, so replacement generations cannot overtake old cleanup.
  const operationTails = new Map<string, Promise<void>>();
  const acquireOperation = async (accountId: string, key: string): Promise<() => void> => {
    const mapKey = hotKey(accountId, key);
    const previous = operationTails.get(mapKey) ?? Promise.resolve();
    let releaseCurrent!: () => void;
    const current = new Promise<void>((resolve) => { releaseCurrent = resolve; });
    const tail = previous.catch(() => {}).then(() => current);
    operationTails.set(mapKey, tail);
    await previous.catch(() => {});
    let released = false;
    return () => {
      if (released) return;
      released = true;
      releaseCurrent();
      void tail.then(() => {
        if (operationTails.get(mapKey) === tail) operationTails.delete(mapKey);
      });
    };
  };

  const lookupUnlocked = async (accountId: string, key: string): Promise<OutcomeLookup> => {
    // Probe in precedence order and stop at the first hit. A store fault at ANY
    // rung is still `unknown` for the whole lookup — a lower rung's silence
    // cannot be read as absence when a higher one could not be read at all.
    for (let rung = 0; rung < OUTCOME_PRECEDENCE.length; rung++) {
      const outcome = OUTCOME_PRECEDENCE[rung]!;
      let probe: { found: boolean; diskError?: unknown };
      try {
        probe = await hasRecent(storeFor(outcome), accountId, key);
      } catch (error) {
        options.warnFailure?.(accountId, `lookup-${outcome}`);
        return { status: "unknown", error };
      }
      if (probe.found) {
        // Exactly one terminal outcome may survive. A WEAKER marker alongside
        // this one is an invariant violation: say so and delete it, best-effort,
        // exactly as the overloaded-vs-accepted case has always done. A probe
        // that throws here is skipped rather than escalated — the winning
        // outcome is already known and returning `unknown` would lose it.
        for (let weaker = rung + 1; weaker < OUTCOME_PRECEDENCE.length; weaker++) {
          const loser = OUTCOME_PRECEDENCE[weaker]!;
          let also: { found: boolean; diskError?: unknown } | undefined;
          try { also = await hasRecent(storeFor(loser), accountId, key); } catch { /* winner stands */ }
          if (!also?.found) continue;
          options.warnInvariant?.(outcome);
          await storeFor(loser).forget(key, { namespace: accountId }).catch(() => false);
        }
        // ⚠️ THE DURABILITY RULE IS PER-OUTCOME AND IS NOT AN OVERSIGHT.
        // `accepted` INHERITS a matching hot entry's durability; the two refusals
        // are pinned `durable`. For `overloaded` that is unchanged behaviour, and
        // unifying it away would change what a memory-only marker can authorize:
        // `ingress-dedupe.ts` and `inbound-overflow-resolver.ts` both gate
        // publishing `inbound_rejected` on `durability === "durable"`, and
        // promoting an overloaded hot entry is what those gates were written
        // against.
        //
        // For `cancelled` it IS a change (#344 round 3), stated rather than
        // hidden: while a cancellation was spelled `accepted` it inherited, and
        // now it pins. That is sound because `record()` above fails a faulted
        // `cancelled` write CLOSED, so no memory-only cancelled marker can be
        // created in the first place — every cancelled hot entry originates
        // "durable" here or in `write.commit()`, and by induction stays durable.
        // Which is also why the three cancellation writers do NOT check
        // `durability`: the check would be provably inert, and a dead guard reads
        // as a live one to the next person.
        const existing = hot.get(hotKey(accountId, key));
        putHot(
          accountId,
          key,
          outcome,
          outcome === "accepted" && existing?.outcome === "accepted"
            ? existing.durability
            : "durable",
        );
        return { status: "found", outcome };
      }
      if (probe.diskError !== undefined) {
        options.warnFailure?.(accountId, `lookup-${outcome}`);
        return { status: "unknown", error: probe.diskError };
      }
    }
    return { status: "not-found" };
  };

  const recoverFailedRollbackUnlocked = async (
    accountId: string,
    key: string,
  ): Promise<{ status: "ok" } | { status: "unknown"; error: unknown }> => {
    if (rollbackRecoveryPoisoned) {
      options.warnFailure?.(accountId, "rollback-recovery-poisoned");
      return { status: "unknown", error: rollbackRecoveryPoisonedError };
    }
    const mapKey = hotKey(accountId, key);
    const recovery = rollbackRecovery.get(mapKey);
    if (!recovery) return { status: "ok" };
    const store = storeFor(recovery.outcome);
    let diskError: unknown;
    try {
      await store.forget(key, {
        namespace: accountId,
        onDiskError: (error) => { diskError = error; },
      });
    } catch (error) {
      options.warnFailure?.(accountId, `rollback-recovery-${recovery.outcome}`);
      return { status: "unknown", error };
    }
    if (diskError !== undefined) {
      options.warnFailure?.(accountId, `rollback-recovery-${recovery.outcome}`);
      return { status: "unknown", error: diskError };
    }
    // `false` is also a successful cleanup: it means the exact marker is already
    // absent. The key gate prevents a replacement generation from being created
    // between this delete and releasing the quarantine.
    rollbackRecovery.delete(mapKey);
    totalRollbackRecoveryBytes -= recovery.bytes;
    deleteHot(accountId, key, recovery.outcome);
    return { status: "ok" };
  };

  return {
    peek(accountId, key) {
      if (rollbackRecoveryPoisoned || rollbackRecovery.has(hotKey(accountId, key))) {
        return undefined;
      }
      return hot.get(hotKey(accountId, key))?.outcome;
    },

    async lookup(accountId, key) {
      const releaseOperation = await acquireOperation(accountId, key);
      try {
        const recovery = await recoverFailedRollbackUnlocked(accountId, key);
        if (recovery.status === "unknown") return recovery;
        return await lookupUnlocked(accountId, key);
      } catch (error) {
        return { status: "unknown", error };
      } finally {
        releaseOperation();
      }
    },

    async record(accountId, key, outcome, recordOptions) {
      const releaseOperation = await acquireOperation(accountId, key);
      const store = storeFor(outcome);
      let diskError: unknown;
      let fresh: boolean;
      try {
        const recovery = await recoverFailedRollbackUnlocked(accountId, key);
        if (recovery.status === "unknown") {
          releaseOperation();
          return recovery;
        }
        if (recordOptions?.replaceOthers) {
          // EVERY other outcome, not "the opposite" — #344 made the set three, and
          // the property this enforces was never about pairs: after this write no
          // conflicting terminal marker may survive. With two outcomes the two
          // readings coincided, which is why the old name held up.
          for (const other of OUTCOME_PRECEDENCE) {
            if (other === outcome) continue;
            let forgetDiskError: unknown;
            try {
              await storeFor(other).forget(key, {
                namespace: accountId,
                onDiskError: (error) => { forgetDiskError = error; },
              });
            } catch (error) {
              options.warnFailure?.(accountId, `replace-with-${outcome}`);
              releaseOperation();
              return { status: "unknown", error };
            }
            // The SDK forget API reports storage failures only through this hook.
            // Fail closed: recording/ACKing the replacement while a durable
            // conflicting marker may remain would create a dual terminal outcome.
            if (forgetDiskError !== undefined) {
              options.warnFailure?.(accountId, `replace-with-${outcome}`);
              releaseOperation();
              return { status: "unknown", error: forgetDiskError };
            }
          }
          deleteHot(accountId, key);
        }
        fresh = await store.checkAndRecord(key, {
          namespace: accountId,
          onDiskError: (error) => { diskError = error; },
        });
      } catch (error) {
        options.warnFailure?.(accountId, `record-${outcome}`);
        releaseOperation();
        return { status: "unknown", error };
      }
      if (diskError !== undefined) {
        options.warnFailure?.(accountId, `record-${outcome}`);
        // ⚠️ BOTH REFUSALS FAIL CLOSED; ONLY `accepted` MAY GO MEMORY-ONLY.
        // #344 round 3 extended this from `overloaded` alone. The SDK has already
        // inserted a memory marker, and a memory-only marker dies with the
        // process:
        //  - `overloaded` — it must not authorize a terminal rejection (the
        //    original reason);
        //  - `cancelled` — a suppression lost on restart lets the client's replay
        //    run the turn `/stop` killed, which is the same class of harm this
        //    whole slice exists to remove. Fail closed so the write is retried:
        //    all three cancellation writers already treat `unknown` correctly —
        //    `recordCancelledInboundItems` arms the fallback tombstone, the seam's
        //    fallback branch holds peer FIFO, and the overflow resolver publishes
        //    nothing and keeps its tombstone.
        // `accepted` is deliberately NOT here: a memory-only accept marker that
        // is lost merely re-admits the message, which the journal's idempotency
        // then collapses — the benign direction, and the one the accept path was
        // written against.
        if (outcome !== "accepted") {
          // Remove memory first, then best-effort disk state.
          try { await store.forget(key, { namespace: accountId }); } catch { /* recovery is retry */ }
          deleteHot(accountId, key, outcome);
          releaseOperation();
          return { status: "unknown", error: diskError };
        }
      }
      const prior = hot.get(hotKey(accountId, key));
      const durability: "durable" | "memory-only" = diskError !== undefined
        ? "memory-only"
        : !fresh && prior?.outcome === outcome
          ? prior.durability
          : "durable";
      let settled = false;
      const write: OutcomeWriteReceipt = {
        outcome,
        created: fresh,
        durability,
        commit() {
          if (settled) return;
          settled = true;
          putHot(accountId, key, outcome, durability);
          releaseOperation();
        },
        async rollback() {
          if (settled) return false;
          settled = true;
          let removed = false;
          try {
            // A false/follower result did not create the marker and therefore
            // has no authority to delete it.
            if (fresh) {
              let forgetDiskError: unknown;
              try {
                removed = await store.forget(key, {
                  namespace: accountId,
                  onDiskError: (error) => { forgetDiskError = error; },
                });
              } catch {
                rememberFailedRollback(accountId, key, outcome, durability);
                return false;
              }
              if (forgetDiskError !== undefined) {
                rememberFailedRollback(accountId, key, outcome, durability);
                return false;
              }
            }
            return removed;
          } finally {
            if (fresh && !rollbackRecovery.has(hotKey(accountId, key))) {
              deleteHot(accountId, key, outcome);
            }
            releaseOperation();
          }
        },
      };
      return { status: "recorded", durability, write };
    },

    async forget(accountId, key, outcome) {
      const releaseOperation = await acquireOperation(accountId, key);
      const store = storeFor(outcome);
      try {
        const recovery = await recoverFailedRollbackUnlocked(accountId, key);
        if (recovery.status === "unknown") return false;
        deleteHot(accountId, key, outcome);
        let diskError: unknown;
        const removed = await store.forget(key, {
          namespace: accountId,
          onDiskError: (error) => { diskError = error; },
        });
        return diskError === undefined && removed;
      } catch {
        return false;
      } finally {
        releaseOperation();
      }
    },

    hotSize: () => ({ entries: hot.size, bytes: totalHotBytes }),
    rollbackRecoverySize: () => ({
      entries: rollbackRecovery.size,
      bytes: totalRollbackRecoveryBytes,
      poisoned: rollbackRecoveryPoisoned,
    }),
  };
}

/**
 * Rate-limited dual-marker warning, ONE THROTTLE ENTRY PER WINNING OUTCOME.
 *
 * ⚠️ IT TAKES THE WINNER, NOT A MESSAGE, AND THAT IS THE FIX (#344 round 2→3).
 * It used to accept a `message: string`, IGNORE it, and emit a hardcoded
 * "…overloaded wins". While `overloaded` was the only winner that was merely
 * redundant; once `cancelled` could win too, the operator log named the wrong
 * verdict — "overloaded wins" says the peer got `inbound_rejected` when it got a
 * silent ack, which is the opposite diagnosis. Building the line HERE, from a
 * closed union, is what makes the emitted text and the store's decision the same
 * fact instead of two that can drift.
 *
 * Taking the union rather than the string also keeps the old property the
 * discarded parameter was protecting: the keyspace is three static entries, so
 * no caller — present or future — can grow this limiter's state with a value off
 * the wire. The previous signature only made that unenforceable.
 */
export function createRateLimitedOutcomeInvariantWarning(
  warn: (message: string) => void,
  now: () => number = Date.now,
  intervalMs = 60_000,
): (winner: IngressOutcome) => void {
  const state = new Map<IngressOutcome, { lastAt: number; suppressed: number }>(
    OUTCOME_PRECEDENCE.map((outcome) => [
      outcome,
      { lastAt: Number.NEGATIVE_INFINITY, suppressed: 0 },
    ]),
  );
  return (winner) => {
    const entry = state.get(winner);
    if (!entry) return;
    const at = now();
    if (at - entry.lastAt < intervalMs) {
      entry.suppressed++;
      return;
    }
    const suppressedSinceLast = entry.suppressed;
    entry.lastAt = at;
    entry.suppressed = 0;
    warn(
      `webchannel: ingress outcome invariant violation (dual marker); ${winner} wins ` +
        `(suppressed=${suppressedSinceLast})`,
    );
  };
}

const OUTCOME_FAILURE_CATEGORIES: readonly IngressOutcomeFailureCategory[] = [
  "lookup-overloaded",
  "lookup-accepted",
  "lookup-cancelled",
  "record-accepted",
  "record-overloaded",
  "record-cancelled",
  "replace-with-accepted",
  "replace-with-overloaded",
  "replace-with-cancelled",
  "rollback-accepted",
  "rollback-overloaded",
  "rollback-cancelled",
  "rollback-recovery-accepted",
  "rollback-recovery-overloaded",
  "rollback-recovery-cancelled",
  "rollback-recovery-poisoned",
  "adapter-lookup",
  "adapter-record-accepted",
  "adapter-record-overloaded",
];

/** Fixed-category limiter: keys, message data, and arbitrary errors never enter warning state. */
export function createRateLimitedOutcomeFailureWarning(
  warn: (message: string) => void,
  now: () => number = Date.now,
  intervalMs = 60_000,
): IngressOutcomeFailureWarning {
  const state = new Map<IngressOutcomeFailureCategory, { lastAt: number; suppressed: number }>(
    OUTCOME_FAILURE_CATEGORIES.map((category) => [
      category,
      { lastAt: Number.NEGATIVE_INFINITY, suppressed: 0 },
    ]),
  );
  return (accountId, category) => {
    const entry = state.get(category);
    if (!entry) return;
    const at = now();
    if (at - entry.lastAt < intervalMs) {
      entry.suppressed = Math.min(entry.suppressed + 1, Number.MAX_SAFE_INTEGER);
      return;
    }
    const safeAccount = /^[A-Za-z0-9._-]{1,64}$/.test(accountId) ? accountId : "<redacted>";
    const suppressed = entry.suppressed;
    entry.lastAt = at;
    entry.suppressed = 0;
    warn(
      `webchannel: ingress outcome storage unavailable account=${safeAccount} ` +
        `category=${category} action=retry-fail-closed suppressed=${suppressed}`,
    );
  };
}

/**
 * PER-STORE, AND THERE ARE NOW THREE OF THEM (#344).
 *
 * These are each `createPersistentDedupe`'s own caps, so the process ceiling is
 * 3 × (2 048 memory entries + 5 000 SQLite rows), not the numbers written here —
 * up from 2 × when `cancelled` shared the `accepted` namespace. The growth is
 * bounded and small (one short key per entry, a few hundred KiB of memory at the
 * cap) and it is the honest shape of the data: three disjoint verdicts, and a
 * key can hold only one of them, so the SUM across the three namespaces is still
 * one entry per deduped message. What actually grew is the worst case where all
 * three namespaces are simultaneously at their independent caps — a state no
 * single traffic pattern produces, since each message contributes to exactly one.
 */
const DEDUPE_OPTIONS = {
  ttlMs: 7 * 24 * 60 * 60 * 1_000,
  memoryMaxSize: 2_048,
  pluginId: "webchannel",
  stateMaxEntries: 5_000,
} as const;

let processStore: IngressOutcomeStore | undefined;
const processInvariantWarning = createRateLimitedOutcomeInvariantWarning((message) =>
  console.warn(message),
);
const processFailureWarning = createRateLimitedOutcomeFailureWarning((message) =>
  console.warn(message),
);

/** One store per outcome, and one hot cache, for the whole process. */
export function getProcessIngressOutcomeStore(): IngressOutcomeStore {
  if (!processStore) {
    processStore = createIngressOutcomeStore({
      accepted: createPersistentDedupe({ ...DEDUPE_OPTIONS, namespacePrefix: "persistent-dedupe" }),
      overloaded: createPersistentDedupe({ ...DEDUPE_OPTIONS, namespacePrefix: "webchannel-inbound-overloaded" }),
      // #344. A NEW namespace, so it starts empty: a `/stop` suppression written
      // by an older build lives in the `accepted` namespace and STAYS there. See
      // the migration note in `ingress-dedupe.ts`'s header.
      cancelled: createPersistentDedupe({ ...DEDUPE_OPTIONS, namespacePrefix: "webchannel-inbound-cancelled" }),
      warnInvariant: processInvariantWarning,
      warnFailure: processFailureWarning,
    });
  }
  return processStore;
}
