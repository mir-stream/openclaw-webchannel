import type {
  InboundRetentionBudget,
  RetentionLimitReason,
  RetentionReservation,
  RetentionSessionToken,
} from "./inbound-retention.js";
import { estimateRetainedMessageBytes } from "./inbound-retention.js";
// #344: `IngressRefusal` is the subset a reader without the journal may act on —
// see THE READER RULE on `OutcomeLookup` in that file. Bound as types rather than
// restated as literals, so a fourth outcome does not need an edit here and an
// `accepted` fast-path decision does not typecheck.
import type { IngressOutcome, IngressRefusal } from "./ingress-outcome.js";

export type RetainedDebounceEntry<Item> = {
  item: Item;
  reservation: RetentionReservation;
  id?: string;
  /** False after this key/account generation has been retired. */
  isActive(): boolean;
  /** True when `/stop` owns this pre-run entry's terminal `cancelled` outcome. */
  isCancellationRequested(): boolean;
  /** True after peer/account teardown revokes cancellation delivery ownership. */
  isRetired(): boolean;
  /** Resolves after cancellation persistence/result delivery releases its lease. */
  waitForCancellation(): Promise<void>;
};

export type BoundedDebouncePushResult =
  | { status: "accepted" }
  | { status: "duplicate-inflight" }
  | { status: "overflow-inflight" }
  | { status: "known-outcome"; outcome: IngressRefusal }
  | { status: "overflow"; reason: RetentionLimitReason; chargedBytes?: number }
  | { status: "disposed" };

export type BoundedInboundDebouncer<Item> = {
  push(item: Item): BoundedDebouncePushResult;
  /** Compatibility alias for the pinned SDK primitive's call sites. */
  enqueue(item: Item): Promise<BoundedDebouncePushResult>;
  cancelKey(key: string, options?: { notify?: boolean }): boolean;
  /** Retires all work; `inflight` includes callbacks that still physically retain entries. */
  dispose(): { waiting: number; inflight: number };
  /** Live physical entry/key ownership, including invalidated callbacks awaiting settlement. */
  usage(): { waiting: number; inflight: number; keys: number };
  /** Test/diagnostic view of actual batch arrays and worker continuations. */
  diagnostics(): { capturedEntries: number; queuedBatches: number; workers: number };
};

export type BoundedInboundDebouncerOptions<Item> = {
  debounceMs: number;
  buildKey(item: Item): string;
  sessionToken(key: string, item: Item): RetentionSessionToken;
  budget: InboundRetentionBudget;
  onFlush(entries: readonly RetainedDebounceEntry<Item>[]): Promise<void> | void;
  onCancel?: (entries: readonly RetainedDebounceEntry<Item>[]) => Promise<void> | void;
  getId?: (item: Item) => string | undefined;
  peekOutcome?: (key: string, id: string) => IngressOutcome | undefined;
  isOverflowClaimed?: (key: string, id: string) => boolean;
  /** Synchronous `/stop` tombstone lookup; authoritative over cached outcomes. */
  isCancelledFallback?: (key: string, id: string) => boolean;
  onKnownOutcome?: (key: string, id: string, outcome: IngressRefusal) => void;
  onOverflow?: (params: {
    key: string;
    item: Item;
    id?: string;
    reason: RetentionLimitReason;
    chargedBytes?: number;
    recoverCancelled: boolean;
  }) => void;
  measure?: (item: Item) => number;
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
};

type Waiting<Item> = {
  entries: RetainedDebounceEntry<Item>[];
  timer?: ReturnType<typeof setTimeout>;
};

type FlushBatch<Item> = {
  entries: RetainedDebounceEntry<Item>[];
  generation: number;
};

type KeyWorker<Item> = {
  queued: FlushBatch<Item>[];
  running?: FlushBatch<Item>;
  worker?: Promise<void>;
};

type CancellationBatch<Item> = {
  entries: RetainedDebounceEntry<Item>[];
  started: boolean;
};

function validId(value: string | undefined): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128;
}

function checkedCharge(measure: (item: any) => number, item: any): number {
  let charge: number;
  try {
    charge = measure(item);
  } catch {
    throw new TypeError("unable to measure retained inbound message");
  }
  if (!Number.isSafeInteger(charge) || charge < 0) {
    throw new TypeError("retained message charge must be a finite non-negative safe integer");
  }
  return charge;
}

/**
 * Bounded replacement for OpenClaw's inbound debouncer. Reservations are made
 * before a timer, array item, or same-key continuation is created and stay live
 * through async onFlush settlement.
 */
export function createBoundedInboundDebouncer<Item>(
  options: BoundedInboundDebouncerOptions<Item>,
): BoundedInboundDebouncer<Item> {
  if (!Number.isSafeInteger(options.debounceMs) || options.debounceMs < 0) {
    throw new TypeError("debounceMs must be a non-negative safe integer");
  }
  const measure = options.measure ?? estimateRetainedMessageBytes;
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer));
  const waiting = new Map<string, Waiting<Item>>();
  const chains = new Map<string, KeyWorker<Item>>();
  const inflightIds = new Set<string>();
  const inflightEntries = new Set<RetainedDebounceEntry<Item>>();
  const inflightByKey = new Map<string, Set<RetainedDebounceEntry<Item>>>();
  const entryStates = new WeakMap<
    RetainedDebounceEntry<Item>,
    {
      cancellationRequested: boolean;
      cancellationPending: boolean;
      cancellationCallbackRunning: boolean;
      retired: boolean;
      cancellationSettled?: Promise<void>;
      resolveCancellation?: () => void;
      releaseCancellationHold?: () => void;
    }
  >();
  const runningCallbacks = new Map<
    RetainedDebounceEntry<Item>,
    { key: string; references: number }
  >();
  const cancellationBatches = new Map<string, Set<CancellationBatch<Item>>>();
  const keyGeneration = new Map<string, number>();
  let disposed = false;

  const idIndexKey = (key: string, id: string) => `${key.length}:${key}${id}`;
  const generation = (key: string) => keyGeneration.get(key) ?? 0;
  const bumpGeneration = (key: string) => keyGeneration.set(key, generation(key) + 1);

  const releaseEntry = (
    key: string,
    entry: RetainedDebounceEntry<Item>,
    requestRelease: boolean,
  ) => {
    if (requestRelease) entry.reservation.requestRelease();
    inflightEntries.delete(entry);
    const keyed = inflightByKey.get(key);
    keyed?.delete(entry);
    if (keyed?.size === 0) inflightByKey.delete(key);
  };

  const trackInflight = (key: string, entries: readonly RetainedDebounceEntry<Item>[]) => {
    let keyed = inflightByKey.get(key);
    if (!keyed) {
      keyed = new Set();
      inflightByKey.set(key, keyed);
    }
    for (const entry of entries) {
      inflightEntries.add(entry);
      keyed.add(entry);
      if (!entry.reservation.released) entry.reservation.transfer("debounce-inflight");
    }
  };

  const settleEntries = (
    key: string,
    entries: readonly RetainedDebounceEntry<Item>[],
    owner: "flush" | "cancel" | "retire" = "flush",
  ) => {
    for (const entry of entries) {
      const state = entryStates.get(entry);
      // Once notify-cancellation starts, it owns the reservation until durable
      // suppression + result delivery settle. A concurrently unwinding flush
      // must not release the same retained work early.
      if (owner === "flush" && state?.cancellationPending) continue;
      if (owner === "cancel" && state) state.cancellationPending = false;
      if (owner === "retire" && state) {
        state.retired = true;
        state.cancellationPending = false;
      }
      // A successful flush can transfer the reservation to dispatcher pending.
      // In that case the dispatcher is now the release owner; the debouncer only
      // drops its indexes. Cancellation/retirement always requests release.
      const requestRelease = owner !== "flush" || entry.reservation.owner !== "pending";
      releaseEntry(key, entry, requestRelease);
      if (owner === "cancel" || owner === "retire") {
        // A cancellation callback that already began may have copied the entry.
        // Its pre-acquired hold remains the physical-retention charge until that
        // callback settles. A queued callback that never began is severable.
        if (owner === "cancel" || !state?.cancellationCallbackRunning) {
          state?.releaseCancellationHold?.();
          if (state) state.releaseCancellationHold = undefined;
        }
      }
      if (validId(entry.id)) inflightIds.delete(idIndexKey(key, entry.id));
      if (owner === "cancel" || owner === "retire") state?.resolveCancellation?.();
    }
    if (!chains.has(key) && !waiting.has(key) && !inflightByKey.has(key)) {
      keyGeneration.delete(key);
    }
  };

  const trackRunningCallback = (
    key: string,
    entries: readonly RetainedDebounceEntry<Item>[],
  ) => {
    // Snapshot because peer retirement deliberately truncates caller-owned batch
    // arrays. Callback accounting must still remove the exact entries it added.
    const trackedEntries = [...entries];
    for (const entry of trackedEntries) {
      const tracked = runningCallbacks.get(entry);
      if (tracked) tracked.references++;
      else runningCallbacks.set(entry, { key, references: 1 });
    }
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      for (const entry of trackedEntries) {
        const tracked = runningCallbacks.get(entry);
        if (!tracked) throw new Error("debounce invariant: running callback is not tracked");
        tracked.references--;
        if (tracked.references < 0) {
          throw new Error("debounce invariant: running callback reference underflow");
        }
        if (tracked.references === 0) runningCallbacks.delete(entry);
      }
    };
  };

  const retainRunningFlush = (
    key: string,
    entries: readonly RetainedDebounceEntry<Item>[],
  ) => {
    const releaseHolds: Array<() => void> = [];
    let stopTracking: (() => void) | undefined;
    try {
      // Acquire synchronously before invoking onFlush. The callback can copy the
      // entries before its first await, so each reservation must remain charged
      // even if peer/account retirement clears the caller-owned batch array.
      for (const entry of entries) releaseHolds.push(entry.reservation.hold());
      stopTracking = trackRunningCallback(key, entries);
    } catch (error) {
      for (const release of releaseHolds.reverse()) release();
      throw error;
    }
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      try {
        for (const release of releaseHolds) release();
      } finally {
        stopTracking?.();
      }
    };
  };

  const runFlush = async (
    key: string,
    entries: RetainedDebounceEntry<Item>[],
    flushGeneration: number,
  ): Promise<void> => {
    let releaseRunning: (() => void) | undefined;
    try {
      if (!disposed && generation(key) === flushGeneration) {
        releaseRunning = retainRunningFlush(key, entries);
        await options.onFlush(entries);
      }
    } finally {
      try {
        settleEntries(key, entries, "flush");
      } finally {
        releaseRunning?.();
      }
    }
  };

  const pump = (key: string, chain: KeyWorker<Item>) => {
    if (chain.worker) return;
    const worker = Promise.resolve().then(async () => {
      while (chain.queued.length > 0) {
        const batch = chain.queued.shift()!;
        chain.running = batch;
        try {
          await runFlush(key, batch.entries, batch.generation);
        } catch {
          // One failed flush must not poison later same-key batches.
        } finally {
          if (chain.running === batch) chain.running = undefined;
        }
      }
    });
    chain.worker = worker;
    void worker.finally(() => {
      if (chain.worker !== worker) return;
      chain.worker = undefined;
      if (chain.queued.length > 0) {
        pump(key, chain);
        return;
      }
      if (chains.get(key) === chain) chains.delete(key);
      if (!waiting.has(key) && !inflightByKey.has(key)) keyGeneration.delete(key);
    });
  };

  const clearCapturedBatches = (key: string) => {
    const chain = chains.get(key);
    if (!chain) return;
    // The one currently executing callback cannot be aborted, but its explicit
    // reservation holds keep every possibly copied entry charged. Clearing its
    // caller-owned array removes one reference; queued batches that never began
    // are removed wholesale without per-generation Promise continuations.
    if (chain.running) chain.running.entries.length = 0;
    for (const batch of chain.queued) batch.entries.length = 0;
    chain.queued.length = 0;
  };

  const clearQueuedCancellationBatches = (key: string) => {
    const batches = cancellationBatches.get(key);
    if (!batches) return;
    for (const batch of batches) {
      if (!batch.started) batch.entries.length = 0;
    }
    cancellationBatches.delete(key);
  };

  const scheduleFlush = (key: string, bucket: Waiting<Item>) => {
    const detachAndQueue = () => {
      if (waiting.get(key) !== bucket) return;
      waiting.delete(key);
      const entries = bucket.entries;
      bucket.entries = [];
      const flushGeneration = generation(key);
      // A detached batch is retained by its worker until it starts, so classify
      // and index it as in-flight before allocating that continuation. Retirement
      // can sever queued batches; a batch that started is protected by callback
      // holds until its await settles.
      trackInflight(key, entries);
      let chain = chains.get(key);
      if (!chain) {
        chain = { queued: [] };
        chains.set(key, chain);
      }
      chain.queued.push({
        entries,
        generation: flushGeneration,
      });
      pump(key, chain);
    };
    if (options.debounceMs === 0) {
      // A microtask matches the SDK immediate batching behavior without creating
      // an attacker-sized Promise chain: one continuation belongs to the bucket.
      void Promise.resolve().then(detachAndQueue);
    } else {
      bucket.timer = setTimer(detachAndQueue, options.debounceMs);
    }
  };

  const push = (item: Item): BoundedDebouncePushResult => {
    if (disposed) return { status: "disposed" };
    const key = options.buildKey(item);
    const id = options.getId?.(item);
    let recoverCancelled = false;
    if (validId(id)) {
      if (options.isOverflowClaimed?.(key, id)) return { status: "overflow-inflight" };
      recoverCancelled = options.isCancelledFallback?.(key, id) ?? false;
      // A cancellation fallback represents text `/stop` already killed. It must
      // recover its suppression/ACK even if a stale/conflicting hot overload
      // exists.
      if (!recoverCancelled) {
        const known = options.peekOutcome?.(key, id);
        // ⭐ #344 — A REFUSAL SHORT-CIRCUITS; AN `accepted` DOES NOT. This is THE
        // READER RULE (`OutcomeLookup` in `ingress-outcome.ts`): only the flush
        // path holds the journal, so only it can tell an admitted-and-journaled
        // message from a crash-window orphan. Answering `accepted` here would ack
        // an orphan away and drain the client's ledger entry — the message would
        // never be journaled and never answered, and no later replay would exist
        // to fix it.
        //
        // ⚠️ THIS FAST PATH IS EXACTLY WHERE THAT BIT. `peek` reads a HOT CACHE
        // that `lookupUnlocked`'s found path and `write.commit()` both warm, so
        // an orphan the overflow resolver had just declined to answer was
        // instantly decidable here — the resolver's silence bought nothing while
        // this arm still spoke. Deferring costs one flush for a genuine accepted
        // replay, on a path #355 shows is already dead for conforming clients
        // (the request is keyed by the wire id, the marker by `random_id`).
        if (known !== undefined && known !== "accepted") {
          options.onKnownOutcome?.(key, id, known);
          return { status: "known-outcome", outcome: known };
        }
      }
      if (inflightIds.has(idIndexKey(key, id))) return { status: "duplicate-inflight" };
    }

    let charge: number | undefined;
    try {
      charge = checkedCharge(measure, item);
    } catch {
      const reason: RetentionLimitReason = "session-byte-count";
      options.onOverflow?.({ key, item, id, reason, recoverCancelled });
      return { status: "overflow", reason };
    }
    const result = options.budget.tryReserve(
      options.sessionToken(key, item),
      charge,
      "debounce-waiting",
    );
    if (result.status === "rejected") {
      options.onOverflow?.({
        key,
        item,
        id,
        reason: result.reason,
        chargedBytes: charge,
        recoverCancelled,
      });
      return { status: "overflow", reason: result.reason, chargedBytes: charge };
    }

    // Only after reservation succeeds may we retain the item or create a timer.
    const entryGeneration = generation(key);
    const state: {
      cancellationRequested: boolean;
      cancellationPending: boolean;
      cancellationCallbackRunning: boolean;
      retired: boolean;
      cancellationSettled?: Promise<void>;
      resolveCancellation?: () => void;
      releaseCancellationHold?: () => void;
    } = {
      cancellationRequested: false,
      cancellationPending: false,
      cancellationCallbackRunning: false,
      retired: false,
    };
    const entry: RetainedDebounceEntry<Item> = {
      item,
      reservation: result.reservation,
      isActive: () =>
        !disposed && !state.cancellationRequested && generation(key) === entryGeneration,
      isCancellationRequested: () => state.cancellationRequested,
      isRetired: () => state.retired,
      waitForCancellation: () => state.cancellationSettled ?? Promise.resolve(),
      ...(validId(id) ? { id } : {}),
    };
    entryStates.set(entry, state);
    if (validId(id)) inflightIds.add(idIndexKey(key, id));
    const existing = waiting.get(key);
    if (existing) {
      existing.entries.push(entry);
    } else {
      const bucket: Waiting<Item> = { entries: [entry] };
      waiting.set(key, bucket);
      scheduleFlush(key, bucket);
    }
    return { status: "accepted" };
  };

  const cancelKey = (key: string, cancelOptions?: { notify?: boolean }): boolean => {
    const bucket = waiting.get(key);
    const retireInflight = cancelOptions?.notify === false;
    const waitingEntries = bucket?.entries ?? [];
    const activeEntries = [...(inflightByKey.get(key) ?? [])];
    const exactUnion = [...new Set([...activeEntries, ...waitingEntries])];
    const newlyCancelled = cancelOptions?.notify
      ? exactUnion.filter((entry) => !entryStates.get(entry)?.cancellationRequested)
      : exactUnion;
    if (newlyCancelled.length === 0) return false;

    if (bucket) {
      waiting.delete(key);
      if (bucket.timer) clearTimer(bucket.timer);
      bucket.entries = [];
    }
    // Invalidate the whole old key generation before either cancellation
    // persistence or a stalled normal continuation can resume.
    bumpGeneration(key);

    if (cancelOptions?.notify && options.onCancel) {
      for (const entry of newlyCancelled) {
        const state = entryStates.get(entry);
        if (state) {
          state.cancellationRequested = true;
          state.cancellationPending = true;
          // Pin before returning from cancelKey; `/stop` immediately calls the
          // dispatcher clear path, whose release request must remain charged
          // until this entry's async suppression + ACK settles.
          state.releaseCancellationHold ??= entry.reservation.hold();
          state.cancellationSettled ??= new Promise<void>((resolve) => {
            state.resolveCancellation = resolve;
          });
        }
      }
      // Waiting entries become cancellation-inflight; already detached/active
      // entries remain in the same index. This exact union is notified once.
      trackInflight(key, waitingEntries);
      const cancellationBatch: CancellationBatch<Item> = {
        entries: newlyCancelled,
        started: false,
      };
      let batches = cancellationBatches.get(key);
      if (!batches) {
        batches = new Set();
        cancellationBatches.set(key, batches);
      }
      batches.add(cancellationBatch);
      void Promise.resolve()
        .then(async () => {
          cancellationBatch.started = true;
          cancellationBatches.get(key)?.delete(cancellationBatch);
          if (cancellationBatches.get(key)?.size === 0) cancellationBatches.delete(key);
          const callbackEntries = cancellationBatch.entries;
          cancellationBatch.entries = [];
          // Peer/account teardown can retire this scheduled callback before it
          // begins. In that case it retains nothing and must not invoke user code.
          if (callbackEntries.length === 0) return;
          for (const entry of callbackEntries) {
            const state = entryStates.get(entry);
            if (state) state.cancellationCallbackRunning = true;
          }
          let stopTracking: (() => void) | undefined;
          try {
            stopTracking = trackRunningCallback(key, callbackEntries);
            await options.onCancel!(callbackEntries);
          } finally {
            for (const entry of callbackEntries) {
              const state = entryStates.get(entry);
              if (state) state.cancellationCallbackRunning = false;
            }
            try {
              stopTracking?.();
            } finally {
              settleEntries(key, callbackEntries, "cancel");
            }
          }
        })
        .catch(() => {});
    } else {
      settleEntries(key, newlyCancelled, retireInflight ? "retire" : "cancel");
      if (retireInflight) {
        clearCapturedBatches(key);
        clearQueuedCancellationBatches(key);
      }
    }
    if (!chains.has(key) && !waiting.has(key) && !inflightByKey.has(key)) {
      keyGeneration.delete(key);
    }
    return newlyCancelled.length > 0;
  };

  return {
    push,
    enqueue: async (item) => push(item),
    cancelKey,
    dispose: () => {
      if (disposed) return { waiting: 0, inflight: runningCallbacks.size };
      disposed = true;
      let waitingCount = 0;
      for (const [key, bucket] of waiting) {
        bumpGeneration(key);
        if (bucket.timer) clearTimer(bucket.timer);
        waitingCount += bucket.entries.length;
        settleEntries(key, bucket.entries, "retire");
      }
      waiting.clear();
      const active = [...inflightByKey.entries()].flatMap(([key, entries]) =>
        [...entries].map((entry) => ({ key, entry })),
      );
      for (const { key, entry } of active) settleEntries(key, [entry], "retire");
      for (const key of chains.keys()) clearCapturedBatches(key);
      for (const key of cancellationBatches.keys()) clearQueuedCancellationBatches(key);
      inflightIds.clear();
      return {
        waiting: waitingCount,
        inflight: new Set([...active.map(({ entry }) => entry), ...runningCallbacks.keys()]).size,
      };
    },
    usage: () => ({
      waiting: [...waiting.values()].reduce((n, bucket) => n + bucket.entries.length, 0),
      inflight: new Set([...inflightEntries, ...runningCallbacks.keys()]).size,
      keys: new Set([
        ...waiting.keys(),
        ...chains.keys(),
        ...cancellationBatches.keys(),
        ...[...runningCallbacks.values()].map(({ key }) => key),
      ]).size,
    }),
    diagnostics: () => ({
      capturedEntries: new Set([
        ...runningCallbacks.keys(),
        ...[...chains.values()].flatMap((chain) =>
          chain.queued.flatMap((batch) => batch.entries)),
        ...[...cancellationBatches.values()].flatMap((batches) =>
          [...batches].flatMap((batch) => batch.entries)),
      ]).size,
      queuedBatches: [...chains.values()].reduce((n, chain) => n + chain.queued.length, 0)
        + [...cancellationBatches.values()].reduce((n, batches) => n + batches.size, 0),
      workers: [...chains.values()].filter((chain) => chain.worker !== undefined).length,
    }),
  };
}
