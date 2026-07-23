import {
  InboundRetentionBudget,
  estimateRetainedMessageBytes,
  type RetentionLimitReason,
  type RetentionReservation,
  type RetentionSessionToken,
} from "./inbound-retention.js";

export type UserMessageLike = { type: "user_message"; text: string; id?: string };

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

export function coalesceUserMessages<M extends UserMessageLike>(messages: readonly M[]): M {
  const first = messages[0];
  if (!first) return undefined as unknown as M;
  if (messages.length === 1) return first;
  return {
    ...first,
    id: messages[messages.length - 1].id,
    text: messages.map((message) => message.text).join("\n\n"),
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
