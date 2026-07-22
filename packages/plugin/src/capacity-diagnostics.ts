import {
  formatCapacityReject,
  formatCapacityRejectSummary,
  formatCapacityWarning,
  type CapacityStatus,
} from "./capacity-status.js";

const REJECT_SUMMARY_INTERVAL_MS = 60_000;

export type CapacityLogger = {
  warn?: (message: string) => void;
  error?: (message: string) => void;
};

export type CapacityDiagnosticsOptions = {
  logger?: CapacityLogger;
  now?: () => number;
};

export type CapacityDiagnostics = {
  onCapacityWarning: (status: CapacityStatus) => void;
  onCapacityReject: (status: CapacityStatus) => void;
};

type RejectState = {
  nextSummaryAt: number;
  suppressedCount: number;
};

/**
 * Compose best-effort capacity diagnostics. Reject state is keyed by account so
 * a future hoist outside the serving loop cannot mix tenants' log windows.
 */
export function createCapacityDiagnostics(
  options: CapacityDiagnosticsOptions = {},
): CapacityDiagnostics {
  const now = options.now ?? Date.now;
  const rejectStates = new Map<string, RejectState>();

  const emit = (level: "warn" | "error", message: string): void => {
    const primary = options.logger?.[level];
    if (primary) {
      try {
        primary(message);
        return;
      } catch {
        // Fall through to the privacy-safe console line. Diagnostics are never
        // allowed to change admission or key persistence outcomes.
      }
    }
    try {
      (level === "warn" ? console.warn : console.error)(message);
    } catch {
      // Best effort only.
    }
  };

  return {
    onCapacityWarning(status) {
      emit("warn", formatCapacityWarning(status));
    },
    onCapacityReject(status) {
      const currentTime = now();
      const state = rejectStates.get(status.accountId);
      if (!state) {
        // Publish limiter state before touching an external logger so a throwing
        // logger cannot turn a full account back into a per-attempt log flood.
        rejectStates.set(status.accountId, {
          nextSummaryAt: currentTime + REJECT_SUMMARY_INTERVAL_MS,
          suppressedCount: 0,
        });
        emit("error", formatCapacityReject(status));
        return;
      }

      state.suppressedCount += 1;
      if (currentTime < state.nextSummaryAt) return;

      const suppressedCount = state.suppressedCount;
      state.suppressedCount = 0;
      state.nextSummaryAt = currentTime + REJECT_SUMMARY_INTERVAL_MS;
      emit("error", formatCapacityRejectSummary(status, suppressedCount));
    },
  };
}
