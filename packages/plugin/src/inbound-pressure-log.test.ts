import { describe, expect, it, vi } from "vitest";
import { InboundPressureLogger } from "./inbound-pressure-log.js";
import { InboundRetentionBudget } from "./inbound-retention.js";

describe("InboundPressureLogger", () => {
  it("rate-limits by account/reason and never includes message, peer, or id content", () => {
    let now = 0;
    const warn = vi.fn();
    const budget = new InboundRetentionBudget();
    const token = budget.createSessionToken();
    const logger = new InboundPressureLogger(warn, () => now, 60_000);
    const event = {
      accountId: "acct",
      internalReason: "session-message-count" as const,
      rejectedMessages: 1,
      rejectedChargedBytes: 300,
      snapshot: budget.snapshot(token),
    };

    expect(logger.record(event)).toBe(true);
    expect(logger.record(event)).toBe(false);
    now = 60_000;
    expect(logger.record(event)).toBe(true);
    expect(warn).toHaveBeenCalledTimes(2);
    const output = warn.mock.calls.flat().join("\n");
    expect(output).toContain("suppressed=1");
    expect(output).not.toContain("secret-message-text");
    expect(output).not.toContain("peer-secret");
    expect(output).not.toContain("id-secret");
  });
});
