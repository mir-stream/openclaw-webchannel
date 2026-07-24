/**
 * Node-free capacity diagnostics shared by the key store, register handler,
 * and runtime wiring. Keeping the strings here gives privacy-sensitive logs a
 * single owner without pulling node:fs into the register handler.
 */

export type CapacityStatus = {
  accountId: string;
  currentKeys: number;
  maxKeys: number;
};

export function formatCapacityWarning(status: CapacityStatus): string {
  const state =
    status.currentKeys >= status.maxKeys
      ? "full; existing keys are preserved and new peers are rejected"
      : "approaching the fixed limit";
  return (
    `[webchannel] account "${status.accountId}" conversation-key store is ${state} ` +
    `(${status.currentKeys}/${status.maxKeys}). Investigate issuer/audience/account routing ` +
    `and unexpected JWT sub churn; do not delete conversation-keys.json entries. ` +
    `Use a disjoint account shard for post-cutover new users if growth is legitimate.`
  );
}

export function formatCapacityReject(status: CapacityStatus): string {
  return (
    `[webchannel] account "${status.accountId}" conversation-key capacity reached ` +
    `(${status.currentKeys}/${status.maxKeys}); existing keys were preserved and new admission ` +
    `was rejected. Investigate issuer/audience/account routing and unexpected JWT sub churn; ` +
    `do not delete conversation-keys.json entries. Use a disjoint account shard for ` +
    `post-cutover new users if growth is legitimate.`
  );
}

export function formatCapacityRejectSummary(
  status: CapacityStatus,
  suppressedCount: number,
): string {
  return (
    `[webchannel] account "${status.accountId}" capacity rejects: ` +
    `${suppressedCount} suppressed, ${status.currentKeys}/${status.maxKeys}`
  );
}
