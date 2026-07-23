import { describe, expect, it } from "vitest";
import { InboundRetentionBudget } from "./inbound-retention.js";

describe("InboundRetentionBudget", () => {
  it("enforces stable per-session and process count/byte boundaries", () => {
    const budget = new InboundRetentionBudget({
      maxMessagesPerSession: 2, maxBytesPerSession: 5,
      maxMessagesPerProcess: 3, maxBytesPerProcess: 8,
    });
    const a = budget.createSessionToken();
    const b = budget.createSessionToken();
    const r1 = budget.tryReserve(a, 2);
    const r2 = budget.tryReserve(a, 3);
    expect(r1.status).toBe("accepted");
    expect(r2.status).toBe("accepted");
    expect(budget.tryReserve(a, 0)).toEqual({ status: "rejected", reason: "session-message-count" });
    const r3 = budget.tryReserve(b, 3);
    expect(r3.status).toBe("accepted");
    expect(budget.tryReserve(b, 0)).toEqual({ status: "rejected", reason: "process-message-count" });
    if (r1.status === "accepted") r1.reservation.release();
    expect(budget.usage()).toEqual({ messages: 2, bytes: 6 });
    if (r2.status === "accepted") r2.reservation.release();
    if (r3.status === "accepted") r3.reservation.release();
    expect(budget.usage()).toEqual({ messages: 0, bytes: 0 });
    expect(budget.sessionCount()).toBe(0);
  });

  it("transfers ownership without a usage dip and throws on double release", () => {
    const budget = new InboundRetentionBudget();
    const token = budget.createSessionToken();
    const result = budget.tryReserve(token, 7);
    if (result.status !== "accepted") throw new Error("unexpected rejection");
    result.reservation.transfer("debounce-inflight");
    result.reservation.transfer("pending");
    expect(budget.snapshot(token).breakdown.pending).toEqual({ messages: 1, bytes: 7 });
    result.reservation.release();
    expect(() => result.reservation.release()).toThrow(/more than once/);
  });

  it("coalesces explicit shared-owner release requests while preserving release invariants", () => {
    const budget = new InboundRetentionBudget();
    const token = budget.createSessionToken();
    const result = budget.tryReserve(token, 7);
    if (result.status !== "accepted") throw new Error("unexpected rejection");
    const dropHold = result.reservation.hold();
    result.reservation.requestRelease();
    result.reservation.requestRelease();
    expect(budget.usage()).toEqual({ messages: 1, bytes: 7 });
    expect(() => result.reservation.release()).toThrow(/more than once/);
    dropHold();
    expect(budget.usage()).toEqual({ messages: 0, bytes: 0 });
    result.reservation.requestRelease();
    expect(() => result.reservation.release()).toThrow(/more than once/);
  });
});
