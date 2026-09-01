import {
  DEFAULT_BUSY_TURN_LIMITS,
  InboundRetentionBudget,
  estimateRetainedMessageBytes,
  type RetentionLimitReason,
  type RetentionReservation,
  type RetentionSessionToken,
} from "./inbound-retention.js";

export type UserMessageLike = { type: "user_message"; text: string; id?: string; random_id?: string };

/**
 * #99: the wireIds of every message folded into one coalesced turn, in arrival
 * order (the anchor — `message.id`, the LAST id — is included).
 *
 * PLUGIN-INTERNAL. It is not part of `InboundWsMessage` and never reaches the
 * wire in either direction: it exists only so `inbound.ts` can settle each
 * member's P0-4 receipt when the merged turn ends. Without it the non-anchor
 * ids are lost at the merge and their receipts sit at `accepted` forever.
 */
export type CoalescedMemberIds = { coalescedIds?: readonly string[] };

/**
 * Longest member wireId we will echo back inside a `turn_settled`. Client wire
 * ids are short generated strings; anything longer is not one of ours.
 */
export const MAX_COALESCED_MEMBER_ID_LENGTH = 128;

/**
 * Rebuild an inbound `user_message` from its KNOWN wire fields, dropping
 * everything else — in particular `coalescedIds`, which is plugin-internal
 * state that no peer may supply.
 *
 * The decode path casts rather than validates (`JSON.parse(...) as
 * InboundWsMessage`, `nats-channel.ts`) and its `user_message` case forwards the
 * object untouched, so without this every extra property a peer attaches
 * reaches the turn handler. Applying it at the runtime's message handler makes
 * `coalesceUserMessages` the only producer of a member list.
 *
 * It lives here, beside the field's type/producer/reader, so the whole "never
 * from the wire" contract is one file's worth of code; the runtime handler
 * itself is untestable routing (see the note there), and the wiring is pinned
 * by the source guard in `index-nats-wiring.test.ts`.
 *
 * A non-string `id` is dropped rather than carried: retention already ignores
 * one (`offer`, below), so this only makes the frame consistent with how the
 * rest of the pipeline reads it. `random_id` (#243 half 1) is a KNOWN wire field
 * and is preserved on the same non-string-drop rule, so it survives this strip
 * and reaches `ingressDedupeKey`; dropping it here would silently defeat the
 * random_id dedupe by always falling back to the wire `id`.
 *
 * WHAT THIS DOES NOT DO: it strips fields, it does not validate them. `text` is
 * copied through UNVALIDATED — a missing or non-string `text` reaches
 * `isAbortRequestText` and core exactly as it did before, which is the
 * pre-existing decode contract (the cast in `nats-channel.ts` never checked it
 * either). Do not read the name as a validation boundary; adding one is a
 * separate change with its own blast radius.
 */
export function normalizeInboundUserMessage(raw: UserMessageLike): UserMessageLike {
  return {
    type: "user_message",
    text: raw.text,
    ...(typeof raw.id === "string" ? { id: raw.id } : {}),
    ...(typeof raw.random_id === "string" ? { random_id: raw.random_id } : {}),
  };
}

/**
 * Read `coalescedIds` off a message that may NOT be trustworthy, and never
 * throw doing it.
 *
 * The frame this field rides on is decoded with a cast (`JSON.parse(...) as
 * InboundWsMessage` in `nats-channel.ts`) and the `user_message` case forwards
 * it unvalidated, so historically any peer-supplied property survived into the
 * handler. `nats-account-runtime.ts` now strips the frame down to its known
 * wire fields at ingress, which makes `coalesceUserMessages` the field's only
 * producer — this helper is the second layer, so that a future path that
 * forgets to strip degrades to "no members settled beyond the anchor" instead
 * of a thrown turn. Both read sites go through it.
 *
 * Hostile shapes and what they become:
 *  - not an array (`5`, `"abc"`, an object) → `[]`. A bare `for…of` over `5`
 *    throws, and over `"abc"` iterates characters; both are silently absorbed
 *    upstream (`.catch(() => {})` in the dispatcher), which would strand every
 *    receipt in the turn — i.e. #99 again through a different door.
 *  - non-string / empty / over-long members → dropped. Same id-shape rule as
 *    `ingress-result-chunks.ts`'s `add()`, which guards the ack/reject ids.
 *  - an over-long list → capped at `maxMessagesPerSession`, which is exactly the
 *    bound the honest producer obeys (a merged group is drained from that
 *    session's retained pending entries), so the guard cannot drop a member a
 *    real coalesce could have produced.
 *
 * That last equivalence is a PREMISE, not a coincidence: it holds only while the
 * process budget is built from the defaults. Raising it (`new
 * InboundRetentionBudget({ maxMessagesPerSession: 64 })`) would let a real group
 * exceed this cap, and members past it — all ACKed, all at `accepted` — would be
 * silently truncated: #99 verbatim. The premise is pinned by the "#99 cap
 * premise" assertion in `index-nats-wiring.test.ts`, which fails at the line
 * someone would raise it on. If it is ever raised deliberately, this cap must
 * move with it.
 */
export function readCoalescedMemberIds(source: unknown): readonly string[] {
  const raw = (source as CoalescedMemberIds | null | undefined)?.coalescedIds;
  if (!Array.isArray(raw)) return [];
  const ids: string[] = [];
  for (const candidate of raw) {
    if (
      typeof candidate !== "string" ||
      candidate.length === 0 ||
      candidate.length > MAX_COALESCED_MEMBER_ID_LENGTH
    ) {
      continue;
    }
    ids.push(candidate);
    if (ids.length >= DEFAULT_BUSY_TURN_LIMITS.maxMessagesPerSession) break;
  }
  return ids;
}

export type RetainedEntry<Message> = {
  message: Message;
  id?: string;
  reservation: RetentionReservation;
};

export type BatchOffer =
  | { status: "accepted"; commit(): void; rollback(): void }
  | { status: "rejected"; reason: RetentionLimitReason }
  | { status: "disposed" };

export interface DispatcherBatchLease<Message> {
  offer(message: Message, reservation?: RetentionReservation): BatchOffer;
  finish(): void;
}

export interface SerializedInboundDispatcher<Message> {
  dispatch(sessionKey: string, message: Message, reservation?: RetentionReservation): BatchOffer["status"];
  beginBatch(sessionKey: string): DispatcherBatchLease<Message>;
  pendingSessions(): number;
  /** Drop/release retained work and return the exact messages that were dropped. */
  clearPending(sessionKey: string): Message[];
  pendingBuffered(sessionKey: string): number;
  dispose(): { pending: number; provisional: number };
  /** Compatibility alias for lifecycle callers that predate bounded retention. */
  close(): void;
  isDisposed(): boolean;
}

export function coalesceUserMessages<M extends UserMessageLike & CoalescedMemberIds>(
  messages: readonly M[],
): M {
  const first = messages[0];
  if (!first) return undefined as unknown as M;
  // Single message: returned untouched. It therefore carries a member list only
  // if its sender put one there — which the ingress normalization in
  // `nats-account-runtime.ts` strips off every wire frame, so on the real path a
  // non-coalesced turn has no member list and settles with exactly one
  // `turn_settled`, as before #99. `readCoalescedMemberIds` is what keeps that
  // true (inert, not a throw) for any caller that skips the strip.
  if (messages.length === 1) return first;
  // #99: keep every member's wireId, in arrival order, so the merged turn can
  // settle each one. The anchor (last id) stays `id` — it is what the drafts and
  // `agent_message` frames reference — and also appears here, last.
  //
  // The accumulation is associative on purpose: an input that already carries
  // member ids has them UNIONED in rather than dropped. Nesting is not reachable
  // today (coalesce runs once, over raw pending entries — the debouncer batches
  // but never merges), so this is cheap insurance, not a claim that it happens.
  const coalescedIds: string[] = [];
  const seen = new Set<string>();
  const addId = (id: string | undefined): void => {
    // A message with no id contributes nothing: there is no receipt to settle.
    // The same shape/length rule as `readCoalescedMemberIds`, and the same cap,
    // so the merged list is bounded no matter which side the ids came from.
    // The cap can only ever bind on a hostile list, never on a real group, for
    // as long as the process budget keeps the default `maxMessagesPerSession` —
    // pinned by the "#99 cap premise" assertion in `index-nats-wiring.test.ts`.
    // Note the reader-side cap alone would strand members if that premise broke,
    // so relaxing this one is not a fix.
    if (
      typeof id !== "string" ||
      id.length === 0 ||
      id.length > MAX_COALESCED_MEMBER_ID_LENGTH ||
      seen.has(id) ||
      coalescedIds.length >= DEFAULT_BUSY_TURN_LIMITS.maxMessagesPerSession
    ) {
      return;
    }
    seen.add(id);
    coalescedIds.push(id);
  };
  for (const message of messages) {
    // Read defensively: an input's `coalescedIds` is only OURS by construction,
    // and a non-array here would throw inside the dispatcher's `startTurn`,
    // which absorbs it by discarding the whole turn (ACKed, never run, never
    // settled).
    for (const memberId of readCoalescedMemberIds(message)) addId(memberId);
    addId(message.id);
  }
  // Drop any list carried in by `...first` before deciding: the field is present
  // ONLY when this merge has a real group. An empty list would contradict that
  // and hand the settle path a field it must re-check for nothing.
  const { coalescedIds: _carriedIds, ...carried } = first as M & CoalescedMemberIds;
  return {
    ...(carried as M),
    id: messages[messages.length - 1].id,
    text: messages.map((message) => message.text).join("\n\n"),
    ...(coalescedIds.length > 0 ? { coalescedIds } : {}),
  };
}

type LeaseEntry<Message> = RetainedEntry<Message> & {
  state: "provisional" | "committed" | "rolled-back" | "attached";
};

type InternalLease<Message> = {
  key: string;
  entries: LeaseEntry<Message>[];
  finished: boolean;
  tailRejected: RetentionLimitReason | undefined;
};

type SessionState<Message> = {
  running?: Promise<void>;
  pending: RetainedEntry<Message>[];
  openLeases: Set<InternalLease<Message>>;
  readyToDrain: boolean;
};

export type SerializedInboundDispatcherOptions<Message> = {
  coalesce?: (messages: Message[]) => Message;
  budget?: InboundRetentionBudget;
  sessionToken?: (sessionKey: string) => RetentionSessionToken;
  measure?: (message: Message) => number;
};

function checkedCharge<Message>(measure: (message: Message) => number, message: Message): number {
  const charge = measure(message);
  if (!Number.isSafeInteger(charge) || charge < 0) {
    throw new TypeError("retained message charge must be a finite non-negative safe integer");
  }
  return charge;
}

/**
 * Per-session serial dispatcher. The coalescing path owns a streaming admission
 * lease so ingress can persist each outcome before committing retained work.
 */
export function createSerializedInboundDispatcher<Message>(
  handler: (sessionKey: string, message: Message) => Promise<void>,
  options?: SerializedInboundDispatcherOptions<Message>,
): SerializedInboundDispatcher<Message> {
  const coalesce = options?.coalesce;
  const budget = options?.budget ?? new InboundRetentionBudget();
  const measure = options?.measure ?? estimateRetainedMessageBytes;
  // Validate injected measurement at construction without retaining an item.
  if (typeof measure !== "function") throw new TypeError("measure must be a function");

  const tokens = new Map<string, RetentionSessionToken>();
  const tokenFor = options?.sessionToken ?? ((key: string) => {
    let token = tokens.get(key);
    if (!token) {
      token = budget.createSessionToken();
      tokens.set(key, token);
    }
    return token;
  });

  const chains = new Map<string, Promise<void>>();
  const sessions = new Map<string, SessionState<Message>>();
  let disposed = false;

  const release = (entry: RetainedEntry<Message>) => {
    entry.reservation.requestRelease();
  };

  const maybeForget = (key: string, state: SessionState<Message>) => {
    if (!state.running && state.pending.length === 0 && state.openLeases.size === 0) {
      sessions.delete(key);
      if (!options?.sessionToken) tokens.delete(key);
    }
  };

  const sessionFor = (key: string): SessionState<Message> => {
    let state = sessions.get(key);
    if (!state) {
      state = { pending: [], openLeases: new Set(), readyToDrain: false };
      sessions.set(key, state);
    }
    return state;
  };

  const startTurn = (key: string, state: SessionState<Message>, entries: RetainedEntry<Message>[]) => {
    if (disposed || entries.length === 0) {
      for (const entry of entries) release(entry);
      maybeForget(key, state);
      return;
    }
    // Detach/release before allocating the merged string or invoking the handler:
    // running work is outside the retained-work budget.
    const messages = entries.map((entry) => entry.message);
    for (const entry of entries) release(entry);
    let message: Message;
    try {
      message = coalesce ? coalesce(messages) : messages[0];
    } catch {
      maybeForget(key, state);
      return;
    }
    const settled = Promise.resolve()
      .then(() => disposed ? undefined : handler(key, message))
      .catch(() => {});
    state.running = settled;
    void settled.then(() => {
      if (state.running !== settled) return;
      state.running = undefined;
      if (disposed) {
        for (const entry of state.pending.splice(0)) release(entry);
        maybeForget(key, state);
        return;
      }
      if (state.openLeases.size > 0) {
        state.readyToDrain = true;
        return;
      }
      drain(key, state);
    });
  };

  const drain = (key: string, state: SessionState<Message>) => {
    if (state.running || state.openLeases.size > 0) return;
    state.readyToDrain = false;
    const entries = state.pending.splice(0);
    if (entries.length > 0) startTurn(key, state, entries);
    else maybeForget(key, state);
  };

  const disposedLease = (): DispatcherBatchLease<Message> => ({
    offer: () => ({ status: "disposed" }),
    finish: () => {},
  });

  const beginBatch = (sessionKey: string): DispatcherBatchLease<Message> => {
    if (disposed || !coalesce) return disposed ? disposedLease() : createLegacyLease(sessionKey);
    const state = sessionFor(sessionKey);
    const internal: InternalLease<Message> = {
      key: sessionKey,
      entries: [],
      finished: false,
      tailRejected: undefined,
    };
    state.openLeases.add(internal);

    const offer = (message: Message, supplied?: RetentionReservation): BatchOffer => {
      if (disposed || internal.finished) {
        supplied?.requestRelease();
        return { status: "disposed" };
      }
      if (internal.tailRejected) {
        // A supplied reservation still protects the caller's retained raw item
        // while it persists the terminal overload outcome. The caller releases
        // it after that async resolution; an unsupplied offer owns nothing here.
        return { status: "rejected", reason: internal.tailRejected };
      }

      let reservation = supplied;
      if (reservation) {
        if (reservation.released || reservation.sessionToken !== tokenFor(sessionKey)) {
          reservation.requestRelease();
          internal.tailRejected = "session-message-count";
          return { status: "rejected", reason: internal.tailRejected };
        }
        reservation.transfer("pending");
      } else {
        let charge: number;
        try {
          charge = checkedCharge(measure, message);
        } catch {
          internal.tailRejected = "session-byte-count";
          return { status: "rejected", reason: internal.tailRejected };
        }
        const reserved = budget.tryReserve(tokenFor(sessionKey), charge, "pending");
        if (reserved.status === "rejected") {
          internal.tailRejected = reserved.reason;
          return { status: "rejected", reason: reserved.reason };
        }
        reservation = reserved.reservation;
      }

      const id = (message as { id?: unknown }).id;
      const entry: LeaseEntry<Message> = {
        message,
        ...(typeof id === "string" ? { id } : {}),
        reservation,
        state: "provisional",
      };
      internal.entries.push(entry);
      return {
        status: "accepted",
        commit: () => {
          if (entry.state !== "provisional") return;
          if (disposed || internal.finished) {
            entry.state = "rolled-back";
            release(entry);
            return;
          }
          entry.state = "committed";
        },
        rollback: () => {
          if (entry.state !== "provisional" && entry.state !== "committed") return;
          entry.state = "rolled-back";
          release(entry);
        },
      };
    };

    const finish = () => {
      if (internal.finished) return;
      internal.finished = true;
      state.openLeases.delete(internal);
      for (const entry of internal.entries) {
        if (entry.state === "provisional") {
          entry.state = "rolled-back";
          release(entry);
        } else if (entry.state === "committed") {
          entry.state = "attached";
          state.pending.push(entry);
        }
      }
      internal.entries = [];
      if (!state.running && state.openLeases.size === 0) drain(sessionKey, state);
      else if (state.readyToDrain && state.openLeases.size === 0) drain(sessionKey, state);
    };

    return { offer, finish };
  };

  function createLegacyLease(sessionKey: string): DispatcherBatchLease<Message> {
    const offered: Message[] = [];
    let finished = false;
    return {
      offer(message, reservation) {
        if (finished || disposed) {
          reservation?.requestRelease();
          return { status: "disposed" };
        }
        // Legacy chains do not own retained accounting. A reservation supplied
        // by the bounded debouncer becomes uncharged immediately before chaining.
        reservation?.requestRelease();
        offered.push(message);
        let active = true;
        return {
          status: "accepted",
          commit: () => { active = false; },
          rollback: () => {
            if (!active) return;
            active = false;
            const index = offered.indexOf(message);
            if (index >= 0) offered.splice(index, 1);
          },
        };
      },
      finish() {
        if (finished) return;
        finished = true;
        for (const message of offered) dispatchLegacy(sessionKey, message);
      },
    };
  }

  const dispatchLegacy = (sessionKey: string, message: Message) => {
    if (disposed) return;
    const previous = chains.get(sessionKey) ?? Promise.resolve();
    const settled = previous.then(() =>
      disposed ? undefined : Promise.resolve()
        .then(() => disposed ? undefined : handler(sessionKey, message))
        .catch(() => {}),
    );
    chains.set(sessionKey, settled);
    void settled.then(() => {
      if (chains.get(sessionKey) === settled) chains.delete(sessionKey);
    });
  };

  const dispatch = (
    sessionKey: string,
    message: Message,
    reservation?: RetentionReservation,
  ): BatchOffer["status"] => {
    if (!coalesce) {
      if (disposed) {
        reservation?.requestRelease();
        return "disposed";
      }
      reservation?.requestRelease();
      dispatchLegacy(sessionKey, message);
      return "accepted";
    }
    const lease = beginBatch(sessionKey);
    const offer = lease.offer(message, reservation);
    if (offer.status === "accepted") offer.commit();
    else reservation?.requestRelease();
    lease.finish();
    return offer.status;
  };

  const clearPending = (sessionKey: string): Message[] => {
    const state = sessions.get(sessionKey);
    if (!state) return [];
    const dropped: Message[] = [];
    for (const entry of state.pending.splice(0)) {
      dropped.push(entry.message);
      release(entry);
    }
    for (const lease of state.openLeases) {
      for (const entry of lease.entries) {
        if (entry.state === "rolled-back") continue;
        dropped.push(entry.message);
        entry.state = "rolled-back";
        release(entry);
      }
    }
    maybeForget(sessionKey, state);
    return dropped;
  };

  const dispose = () => {
    if (disposed) return { pending: 0, provisional: 0 };
    disposed = true;
    chains.clear();
    let pending = 0;
    let provisional = 0;
    for (const [key, state] of sessions) {
      for (const entry of state.pending.splice(0)) {
        pending++;
        release(entry);
      }
      for (const lease of state.openLeases) {
        lease.finished = true;
        for (const entry of lease.entries) {
          if (entry.state === "rolled-back") continue;
          provisional++;
          entry.state = "rolled-back";
          release(entry);
        }
        lease.entries = [];
      }
      state.openLeases.clear();
      state.readyToDrain = false;
      maybeForget(key, state);
    }
    sessions.clear();
    tokens.clear();
    // Running handlers are allowed to settle, but queued same-tick handlers and
    // recursive follow-ups observe `disposed` before they can start.
    return { pending, provisional };
  };

  return {
    dispatch,
    beginBatch,
    pendingSessions: () => chains.size + sessions.size,
    clearPending,
    pendingBuffered: (key) => sessions.get(key)?.pending.length ?? 0,
    dispose,
    close: () => {
      void dispose();
    },
    isDisposed: () => disposed,
  };
}
