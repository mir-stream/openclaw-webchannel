import { describe, expect, it } from "vitest";

import {
  formatCapacityReject,
  formatCapacityRejectSummary,
  formatCapacityWarning,
  type CapacityStatus,
} from "./capacity-status.js";

const approaching: CapacityStatus = { accountId: "acct-a", currentKeys: 9, maxKeys: 10 };
const full: CapacityStatus = { accountId: "acct-a", currentKeys: 10, maxKeys: 10 };

describe("capacity status formatting", () => {
  it("formats approaching and full warnings without peer data", () => {
    expect(formatCapacityWarning(approaching)).toBe(
      '[webchannel] account "acct-a" conversation-key store is approaching the fixed limit ' +
        "(9/10). Investigate issuer/audience/account routing and unexpected JWT sub churn; " +
        "do not delete conversation-keys.json entries. Use a disjoint account shard for " +
        "post-cutover new users if growth is legitimate.",
    );
    expect(formatCapacityWarning(full)).toContain(
      "full; existing keys are preserved and new peers are rejected (10/10)",
    );
    expect(formatCapacityWarning(full)).not.toContain("peer-secret");
  });

  it("owns the full reject and summary strings", () => {
    expect(formatCapacityReject(full)).toBe(
      '[webchannel] account "acct-a" conversation-key capacity reached (10/10); existing keys ' +
        "were preserved and new admission was rejected. Investigate issuer/audience/account " +
        "routing and unexpected JWT sub churn; do not delete conversation-keys.json entries. " +
        "Use a disjoint account shard for post-cutover new users if growth is legitimate.",
    );
    expect(formatCapacityRejectSummary(full, 42)).toBe(
      '[webchannel] account "acct-a" capacity rejects: 42 suppressed, 10/10',
    );
  });
});
