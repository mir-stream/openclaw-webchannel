import { afterEach, describe, expect, it, vi } from "vitest";

import { createCapacityDiagnostics } from "./capacity-diagnostics.js";
import {
  formatCapacityReject,
  formatCapacityRejectSummary,
  formatCapacityWarning,
  type CapacityStatus,
} from "./capacity-status.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createCapacityDiagnostics", () => {
  it("forwards warning formatting verbatim", () => {
    const warn = vi.fn();
    const diagnostics = createCapacityDiagnostics({ logger: { warn } });
    const status: CapacityStatus = { accountId: "a", currentKeys: 9, maxKeys: 10 };
    diagnostics.onCapacityWarning(status);
    expect(warn).toHaveBeenCalledWith(formatCapacityWarning(status));
  });

  it("keeps interleaved account reject windows independent", () => {
    let now = 1_000;
    const error = vi.fn();
    const diagnostics = createCapacityDiagnostics({ logger: { error }, now: () => now });
    const a: CapacityStatus = { accountId: "a", currentKeys: 10, maxKeys: 10 };
    const b: CapacityStatus = { accountId: "b", currentKeys: 10, maxKeys: 10 };

    diagnostics.onCapacityReject(a);
    diagnostics.onCapacityReject(b);
    diagnostics.onCapacityReject(a);
    diagnostics.onCapacityReject(b);
    expect(error.mock.calls.map(([message]) => message)).toEqual([
      formatCapacityReject(a),
      formatCapacityReject(b),
    ]);

    now += 60_000;
    diagnostics.onCapacityReject(a);
    expect(error).toHaveBeenLastCalledWith(formatCapacityRejectSummary(a, 2));
    diagnostics.onCapacityReject(b);
    expect(error).toHaveBeenLastCalledWith(formatCapacityRejectSummary(b, 2));
  });

  it("does not throw when logger and console fallbacks throw", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {
      throw new Error("console warn unavailable");
    });
    vi.spyOn(console, "error").mockImplementation(() => {
      throw new Error("console error unavailable");
    });
    const diagnostics = createCapacityDiagnostics({
      logger: {
        warn: () => {
          throw new Error("warn unavailable");
        },
        error: () => {
          throw new Error("error unavailable");
        },
      },
    });
    const status: CapacityStatus = { accountId: "a", currentKeys: 10, maxKeys: 10 };
    expect(() => diagnostics.onCapacityWarning(status)).not.toThrow();
    expect(() => diagnostics.onCapacityReject(status)).not.toThrow();
  });
});
