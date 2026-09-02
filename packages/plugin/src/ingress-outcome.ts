import { Buffer } from "node:buffer";
import {
  createPersistentDedupe,
  type PersistentDedupe,
} from "openclaw/plugin-sdk/persistent-dedupe";

export type IngressOutcome = "accepted" | "overloaded";
export type IngressOutcomeFailureCategory =
  | "lookup-overloaded"
  | "lookup-accepted"
  | "record-accepted"
  | "record-overloaded"
  | "replace-with-accepted"
  | "replace-with-overloaded"
  | "rollback-accepted"
  | "rollback-overloaded"
  | "rollback-recovery-accepted"
  | "rollback-recovery-overloaded"
  | "rollback-recovery-poisoned"
  | "adapter-lookup"
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
 * journal is the authority on that disagreement; `ingress-dedupe.ts`'s
 * found/accepted branch consults it and re-admits when the row is missing. A
 * caller that treats this result as a terminal accept without the same check is
 * reintroducing #344.
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
    options?: { replaceOpposite?: boolean },
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
  maxHotEntries?: number;
  maxHotBytes?: number;
  maxRollbackRecoveryEntries?: number;
  maxRollbackRecoveryBytes?: number;
  warnInvariant?: (message: string) => void;
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
    let rejected: { found: boolean; diskError?: unknown };
    try {
      rejected = await hasRecent(options.overloaded, accountId, key);
    } catch (error) {
      options.warnFailure?.(accountId, "lookup-overloaded");
      return { status: "unknown", error };
    }
    if (rejected.found) {
      let accepted: { found: boolean; diskError?: unknown } | undefined;
      try { accepted = await hasRecent(options.accepted, accountId, key); } catch { /* overload remains authoritative */ }
      if (accepted?.found) {
        options.warnInvariant?.("webchannel: ingress outcome invariant violation (dual marker); overloaded wins");
        await options.accepted.forget(key, { namespace: accountId }).catch(() => false);
      }
      putHot(accountId, key, "overloaded", "durable");
      return { status: "found", outcome: "overloaded" };
    }
    if (rejected.diskError !== undefined) {
      options.warnFailure?.(accountId, "lookup-overloaded");
      return { status: "unknown", error: rejected.diskError };
    }

    let accepted: { found: boolean; diskError?: unknown };
    try {
      accepted = await hasRecent(options.accepted, accountId, key);
    } catch (error) {
      options.warnFailure?.(accountId, "lookup-accepted");
      return { status: "unknown", error };
    }
    if (accepted.found) {
      const existing = hot.get(hotKey(accountId, key));
      putHot(
        accountId,
        key,
        "accepted",
        existing?.outcome === "accepted" ? existing.durability : "durable",
      );
      return { status: "found", outcome: "accepted" };
    }
    if (accepted.diskError !== undefined) {
      options.warnFailure?.(accountId, "lookup-accepted");
      return { status: "unknown", error: accepted.diskError };
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
    const store = recovery.outcome === "accepted" ? options.accepted : options.overloaded;
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
      const store = outcome === "accepted" ? options.accepted : options.overloaded;
      const oppositeStore = outcome === "accepted" ? options.overloaded : options.accepted;
      let diskError: unknown;
      let fresh: boolean;
      try {
        const recovery = await recoverFailedRollbackUnlocked(accountId, key);
        if (recovery.status === "unknown") {
          releaseOperation();
          return recovery;
        }
        if (recordOptions?.replaceOpposite) {
          let forgetDiskError: unknown;
          try {
            await oppositeStore.forget(key, {
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
          // opposite marker may remain would create a dual terminal outcome.
          if (forgetDiskError !== undefined) {
            options.warnFailure?.(accountId, `replace-with-${outcome}`);
            releaseOperation();
            return { status: "unknown", error: forgetDiskError };
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
        if (outcome === "overloaded") {
          // SDK has already inserted a memory marker. It must not authorize a
          // terminal rejection, so remove memory first and best-effort disk state.
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
      const store = outcome === "accepted" ? options.accepted : options.overloaded;
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

export function createRateLimitedOutcomeInvariantWarning(
  warn: (message: string) => void,
  now: () => number = Date.now,
  intervalMs = 60_000,
): (message: string) => void {
  let lastAt = Number.NEGATIVE_INFINITY;
  let suppressed = 0;
  return () => {
    const at = now();
    if (at - lastAt < intervalMs) {
      suppressed++;
      return;
    }
    const suppressedSinceLast = suppressed;
    lastAt = at;
    suppressed = 0;
    warn(
      "webchannel: ingress outcome invariant violation (dual marker); overloaded wins " +
        `(suppressed=${suppressedSinceLast})`,
    );
  };
}

const OUTCOME_FAILURE_CATEGORIES: readonly IngressOutcomeFailureCategory[] = [
  "lookup-overloaded",
  "lookup-accepted",
  "record-accepted",
  "record-overloaded",
  "replace-with-accepted",
  "replace-with-overloaded",
  "rollback-accepted",
  "rollback-overloaded",
  "rollback-recovery-accepted",
  "rollback-recovery-overloaded",
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

/** One accepted/overloaded store pair and one hot cache for the whole process. */
export function getProcessIngressOutcomeStore(): IngressOutcomeStore {
  if (!processStore) {
    processStore = createIngressOutcomeStore({
      accepted: createPersistentDedupe({ ...DEDUPE_OPTIONS, namespacePrefix: "persistent-dedupe" }),
      overloaded: createPersistentDedupe({ ...DEDUPE_OPTIONS, namespacePrefix: "webchannel-inbound-overloaded" }),
      warnInvariant: processInvariantWarning,
      warnFailure: processFailureWarning,
    });
  }
  return processStore;
}
