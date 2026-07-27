import { Buffer } from "node:buffer";

/** Hard process/session bounds for not-yet-running inbound user work. */
export const DEFAULT_BUSY_TURN_LIMITS = {
  maxMessagesPerSession: 32,
  maxBytesPerSession: 1 * 1024 * 1024,
  maxMessagesPerProcess: 1_024,
  maxBytesPerProcess: 32 * 1024 * 1024,
} as const;

export const RETAINED_MESSAGE_OVERHEAD_BYTES = 256;

export type BusyTurnLimits = {
  maxMessagesPerSession: number;
  maxBytesPerSession: number;
  maxMessagesPerProcess: number;
  maxBytesPerProcess: number;
};

export type RetentionOwner = "debounce-waiting" | "debounce-inflight" | "pending";
export type RetentionLimitReason =
  | "session-message-count"
  | "session-byte-count"
  | "process-message-count"
  | "process-byte-count";

export type RetentionUsage = { messages: number; bytes: number };
export type RetentionBreakdown = Record<RetentionOwner, RetentionUsage>;
export type RetentionSnapshot = {
  process: RetentionUsage;
  session: RetentionUsage;
  breakdown: RetentionBreakdown;
  limits: BusyTurnLimits;
};

export type RetentionSessionToken = symbol;

export interface RetentionReservation {
  readonly sessionToken: RetentionSessionToken;
  readonly chargedBytes: number;
  readonly owner: RetentionOwner;
  readonly released: boolean;
  /** Defer a release request without changing this reservation's charge/owner. */
  hold(): () => void;
  transfer(next: RetentionOwner): void;
  /** Idempotent cleanup for overlapping dispatcher/debouncer retirement owners. */
  requestRelease(): void;
  /** Single-owner release; repeated calls remain an invariant violation. */
  release(): void;
}

export type RetentionReserveResult =
  | { status: "accepted"; reservation: RetentionReservation }
  | { status: "rejected"; reason: RetentionLimitReason };

const zeroUsage = (): RetentionUsage => ({ messages: 0, bytes: 0 });
const zeroBreakdown = (): RetentionBreakdown => ({
  "debounce-waiting": zeroUsage(),
  "debounce-inflight": zeroUsage(),
  pending: zeroUsage(),
});

function assertSafeNonNegative(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a finite non-negative safe integer`);
  }
}

function validateLimits(limits: BusyTurnLimits): void {
  assertSafeNonNegative(limits.maxMessagesPerSession, "maxMessagesPerSession");
  assertSafeNonNegative(limits.maxBytesPerSession, "maxBytesPerSession");
  assertSafeNonNegative(limits.maxMessagesPerProcess, "maxMessagesPerProcess");
  assertSafeNonNegative(limits.maxBytesPerProcess, "maxBytesPerProcess");
}

/**
 * Conservative charged-retained-byte estimator. Unknown enumerable properties
 * are intentionally included by JSON.stringify. The separator is charged even
 * for the last item so a future busy-time merge cannot escape accounting.
 */
export function estimateRetainedMessageBytes(message: unknown): number {
  const json = JSON.stringify(message);
  if (json === undefined) throw new TypeError("inbound message is not JSON serializable");
  return Buffer.byteLength(json, "utf8") + RETAINED_MESSAGE_OVERHEAD_BYTES + 2;
}

type SessionState = { usage: RetentionUsage; breakdown: RetentionBreakdown };

/** Process-wide owner of every not-yet-running inbound reservation. */
export class InboundRetentionBudget {
  readonly limits: BusyTurnLimits;
  private readonly sessions = new Map<RetentionSessionToken, SessionState>();
  private readonly processUsage = zeroUsage();
  private readonly processBreakdown = zeroBreakdown();

  constructor(limits: BusyTurnLimits = DEFAULT_BUSY_TURN_LIMITS) {
    validateLimits(limits);
    this.limits = { ...limits };
  }

  createSessionToken(): RetentionSessionToken {
    return Symbol("webchannel-inbound-session");
  }

  /** Stable first-failure classification; mutates nothing on failure. */
  tryReserve(
    sessionToken: RetentionSessionToken,
    chargedBytes: number,
    owner: RetentionOwner = "debounce-waiting",
  ): RetentionReserveResult {
    if (typeof sessionToken !== "symbol") throw new TypeError("sessionToken must be an opaque symbol");
    assertSafeNonNegative(chargedBytes, "chargedBytes");
    const current = this.sessions.get(sessionToken)?.usage ?? zeroUsage();
    const { limits } = this;
    if (current.messages + 1 > limits.maxMessagesPerSession) {
      return { status: "rejected", reason: "session-message-count" };
    }
    if (current.bytes + chargedBytes > limits.maxBytesPerSession) {
      return { status: "rejected", reason: "session-byte-count" };
    }
    if (this.processUsage.messages + 1 > limits.maxMessagesPerProcess) {
      return { status: "rejected", reason: "process-message-count" };
    }
    if (this.processUsage.bytes + chargedBytes > limits.maxBytesPerProcess) {
      return { status: "rejected", reason: "process-byte-count" };
    }

    const session = this.sessions.get(sessionToken) ?? {
      usage: zeroUsage(),
      breakdown: zeroBreakdown(),
    };
    if (!this.sessions.has(sessionToken)) this.sessions.set(sessionToken, session);
    this.adjust(session, owner, 1, chargedBytes);

    let currentOwner = owner;
    let released = false;
    let releaseRequested = false;
    let holds = 0;
    const budget = this;
    const finalizeRelease = () => {
      const state = budget.sessions.get(sessionToken);
      if (!state) throw new Error("retention invariant: release has no session usage");
      budget.adjust(state, currentOwner, -1, -chargedBytes);
      released = true;
      if (state.usage.messages === 0 && state.usage.bytes === 0) {
        budget.sessions.delete(sessionToken);
      }
    };
    const reservation: RetentionReservation = {
      sessionToken,
      chargedBytes,
      get owner() { return currentOwner; },
      get released() { return released; },
      hold() {
        if (released || releaseRequested) {
          throw new Error("cannot hold a released retention reservation");
        }
        holds++;
        let active = true;
        return () => {
          if (!active) return;
          active = false;
          holds--;
          if (holds < 0) throw new Error("retention reservation hold underflow");
          if (holds === 0 && releaseRequested && !released) finalizeRelease();
        };
      },
      transfer(next) {
        if (released || releaseRequested) throw new Error("retention reservation already released");
        if (next === currentOwner) return;
        const state = budget.sessions.get(sessionToken);
        if (!state) throw new Error("retention invariant: live reservation has no session usage");
        budget.adjustBreakdown(state, currentOwner, -1, -chargedBytes);
        budget.adjustBreakdown(state, next, 1, chargedBytes);
        currentOwner = next;
      },
      requestRelease() {
        if (releaseRequested) return;
        if (released) return;
        releaseRequested = true;
        if (holds === 0) finalizeRelease();
      },
      release() {
        if (released || releaseRequested) {
          throw new Error("retention reservation released more than once");
        }
        releaseRequested = true;
        if (holds === 0) finalizeRelease();
      },
    };
    return { status: "accepted", reservation };
  }

  reserve(
    sessionToken: RetentionSessionToken,
    chargedBytes: number,
    owner: RetentionOwner = "debounce-waiting",
  ): RetentionReservation | undefined {
    const result = this.tryReserve(sessionToken, chargedBytes, owner);
    return result.status === "accepted" ? result.reservation : undefined;
  }

  usage(sessionToken?: RetentionSessionToken): RetentionUsage {
    const source = sessionToken ? this.sessions.get(sessionToken)?.usage : this.processUsage;
    return { messages: source?.messages ?? 0, bytes: source?.bytes ?? 0 };
  }

  snapshot(sessionToken?: RetentionSessionToken): RetentionSnapshot {
    const session = sessionToken ? this.sessions.get(sessionToken) : undefined;
    const breakdown = session?.breakdown ?? this.processBreakdown;
    return {
      process: this.usage(),
      session: sessionToken ? this.usage(sessionToken) : zeroUsage(),
      breakdown: {
        "debounce-waiting": { ...breakdown["debounce-waiting"] },
        "debounce-inflight": { ...breakdown["debounce-inflight"] },
        pending: { ...breakdown.pending },
      },
      limits: { ...this.limits },
    };
  }

  sessionCount(): number { return this.sessions.size; }

  private adjust(state: SessionState, owner: RetentionOwner, messageDelta: number, byteDelta: number): void {
    state.usage.messages += messageDelta;
    state.usage.bytes += byteDelta;
    this.processUsage.messages += messageDelta;
    this.processUsage.bytes += byteDelta;
    this.adjustBreakdown(state, owner, messageDelta, byteDelta);
    this.assertUsage(state.usage, "session");
    this.assertUsage(this.processUsage, "process");
  }

  private adjustBreakdown(
    state: SessionState,
    owner: RetentionOwner,
    messageDelta: number,
    byteDelta: number,
  ): void {
    state.breakdown[owner].messages += messageDelta;
    state.breakdown[owner].bytes += byteDelta;
    this.processBreakdown[owner].messages += messageDelta;
    this.processBreakdown[owner].bytes += byteDelta;
    this.assertUsage(state.breakdown[owner], `session ${owner}`);
    this.assertUsage(this.processBreakdown[owner], `process ${owner}`);
  }

  private assertUsage(usage: RetentionUsage, scope: string): void {
    if (usage.messages < 0 || usage.bytes < 0) {
      throw new Error(`retention invariant: ${scope} usage underflow`);
    }
  }
}
