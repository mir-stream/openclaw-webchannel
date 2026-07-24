import type { RetentionLimitReason, RetentionSnapshot } from "./inbound-retention.js";

export type InboundPressureEvent = {
  accountId: string;
  internalReason: RetentionLimitReason;
  rejectedMessages: number;
  rejectedChargedBytes: number;
  snapshot: RetentionSnapshot;
};

/** Content-free, bounded-key, next-event-flushed pressure log limiter. */
export class InboundPressureLogger {
  private readonly states = new Map<string, { lastAt: number; suppressed: number }>();
  constructor(
    private readonly warn: (message: string) => void,
    private readonly now: () => number = Date.now,
    private readonly intervalMs = 60_000,
  ) {}

  record(event: InboundPressureEvent): boolean {
    const key = `${event.accountId.length}:${event.accountId}:${event.internalReason}`;
    const now = this.now();
    const state = this.states.get(key);
    if (state && now - state.lastAt < this.intervalMs) {
      state.suppressed += event.rejectedMessages;
      return false;
    }
    const suppressed = state?.suppressed ?? 0;
    this.states.set(key, { lastAt: now, suppressed: 0 });
    const { process, session, breakdown, limits } = event.snapshot;
    this.warn(
      "webchannel: inbound retained-work pressure " +
      `accountId=${event.accountId} internalReason=${event.internalReason} ` +
      `rejectedMessages=${event.rejectedMessages} rejectedChargedBytes=${event.rejectedChargedBytes} ` +
      `sessionRetainedMessages=${session.messages} sessionRetainedBytes=${session.bytes} ` +
      `processRetainedMessages=${process.messages} processRetainedBytes=${process.bytes} ` +
      `debounceWaiting=${breakdown["debounce-waiting"].messages} ` +
      `debounceInflight=${breakdown["debounce-inflight"].messages} ` +
      `dispatcherPending=${breakdown.pending.messages} ` +
      `maxMessagesPerSession=${limits.maxMessagesPerSession} maxBytesPerSession=${limits.maxBytesPerSession} ` +
      `maxMessagesPerProcess=${limits.maxMessagesPerProcess} maxBytesPerProcess=${limits.maxBytesPerProcess} ` +
      `suppressed=${suppressed}`,
    );
    return true;
  }
}
