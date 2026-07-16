import type { AgentKeyRecord, AgentKeyRegistry } from "./agent-key-registry.js";

export type AgentKeyRegistryFactory = (() => AgentKeyRegistry | Promise<AgentKeyRegistry>) & {
  /** Advance adapter time and/or run its configured maintenance/compaction pass. */
  maintenance?: (registry: AgentKeyRegistry) => void | Promise<void>;
};

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`AgentKeyRegistry conformance: ${message}`);
}

function validateHistory(history: AgentKeyRecord[]): void {
  invariant(history.filter((r) => r.status === "active").length <= 1, "more than one active record");
  for (const record of history) {
    if (record.status === "superseded") {
      invariant(typeof record.endedAt === "number", "superseded record lacks endedAt");
      invariant(record.supersededBy, "superseded record lacks supersededBy");
    }
  }
}

/**
 * Adapter-generic invariant and allowed-outcome suite for registry SPI v2.
 *
 * This suite validates outcomes and invariants, not interleavings: against a
 * single-process adapter with no internal await points the `Promise.all`
 * "races" execute sequentially. True-concurrency/multi-process validation is
 * each durable adapter's own responsibility (P1-2 store conformance), as is
 * providing a real `factory.maintenance` hook — for the memory reference
 * implementation that hook is a no-op, so the maintenance-survival check is
 * only meaningful for adapters that supply one.
 */
export async function runAgentKeyRegistryConformance(factory: AgentKeyRegistryFactory): Promise<void> {
  const tenant = `conformance-${crypto.randomUUID()}`;
  const account = "account";
  const a = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  const b = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
  const c = "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";
  const registry = await factory();

  // Length-prefix boundary isolation: these pairs collide under naive joining.
  invariant((await registry.register(`${tenant}/x`, "y", a, null)).ok, "boundary slot A failed");
  invariant((await registry.register(tenant, "x/y", b, null)).ok, "boundary slot B collided");
  invariant((await registry.getActive(`${tenant}/x`, "y"))?.publicKey === a, "boundary slot A changed");
  invariant((await registry.getActive(tenant, "x/y"))?.publicKey === b, "boundary slot B changed");

  const first = await registry.register(tenant, account, a, null);
  invariant(first.ok && !first.idempotent, "initial register failed");
  const firstSnapshot = { ...first.record };
  const activeCopy = await registry.getActive(tenant, account);
  const historyCopy = await registry.listHistory(tenant, account);
  invariant(activeCopy, "active snapshot missing");
  (activeCopy as { publicKey: string }).publicKey = c;
  (historyCopy[0] as { status: string }).status = "revoked";
  (first.record as { accountId: string }).accountId = "mutated";
  invariant((await registry.getActive(tenant, account))?.publicKey === a, "returned records are not defensive copies");

  const same = await Promise.all(Array.from({ length: 8 }, () => registry.register(tenant, account, a, "stale")));
  invariant(same.every((r) => r.ok && r.idempotent), "same-key registration was not idempotent");
  invariant((await registry.listHistory(tenant, account)).length === 1, "idempotency changed history");

  const race = await Promise.all([
    registry.register(tenant, account, b, firstSnapshot.activationId),
    registry.register(tenant, account, c, firstSnapshot.activationId),
  ]);
  invariant(race.filter((r) => r.ok).length === 1, "CAS race did not have exactly one winner");
  const active = await registry.getActive(tenant, account);
  invariant(active && (active.publicKey === b || active.publicKey === c), "CAS winner is not active");
  const afterReplace = await registry.listHistory(tenant, account);
  validateHistory(afterReplace);
  const old = afterReplace.find((r) => r.activationId === firstSnapshot.activationId);
  invariant(old?.status === "superseded", "old activation was not superseded");
  invariant(old.supersededBy === active.activationId, "supersededBy is not the exact new activationId");

  // A -> B -> A cycles the deterministic keyId but never the activation token.
  const backToA = await registry.register(tenant, account, a, active.activationId);
  invariant(backToA.ok && !backToA.idempotent, "A-B-A transition failed");
  invariant(backToA.record.activationId !== firstSnapshot.activationId, "activationId was reused");
  const replay = await registry.register(tenant, account, b, firstSnapshot.activationId);
  invariant(!replay.ok && replay.reason === "conflict", "old A activation token replayed");

  invariant(await registry.revokeActive(tenant, account), "revoke failed");
  const tombstone = await registry.register(tenant, account, a, null);
  invariant(!tombstone.ok && tombstone.reason === "revoked", "tombstone did not precede idempotency");
  const other = await registry.register(tenant, account, b, null);
  invariant(other.ok, "non-tombstoned recovery key was rejected");

  // Scripted revoke/register race: either ordering is allowed, but no torn
  // active state or resurrectable tombstone is.
  const raceAccount = "race";
  const seeded = await registry.register(tenant, raceAccount, a, null);
  invariant(seeded.ok, "race setup failed");
  const [revoked, replacement] = await Promise.all([
    registry.revokeActive(tenant, raceAccount),
    registry.register(tenant, raceAccount, b, seeded.record.activationId),
  ]);
  invariant(revoked, "race did not revoke an activation");
  invariant(replacement.ok || replacement.reason === "conflict", "disallowed race result");
  invariant(await registry.getActive(tenant, raceAccount) === null, "race left an active record");
  const beforeMaintenance = await registry.listHistory(tenant, raceAccount);
  validateHistory(beforeMaintenance);
  const tombstoned = beforeMaintenance.filter((r) => r.status === "revoked");
  invariant(tombstoned.length === 1, "race lost its tombstone");
  for (const record of tombstoned) {
    const resurrect = await registry.register(tenant, raceAccount, record.publicKey, null);
    invariant(!resurrect.ok && resurrect.reason === "revoked", "tombstoned key resurrected");
  }

  const preserved = beforeMaintenance.map((record) => ({ ...record }));
  await factory.maintenance?.(registry);
  const afterMaintenance = await registry.listHistory(tenant, raceAccount);
  for (const expected of preserved) {
    const actual = afterMaintenance.find((record) => record.activationId === expected.activationId);
    invariant(actual, `maintenance removed ${expected.activationId}`);
    invariant(JSON.stringify(actual) === JSON.stringify(expected), `maintenance changed ${expected.activationId}`);
  }
}
