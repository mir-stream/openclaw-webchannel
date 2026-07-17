import { CommitPayloadMismatchError, type EnrollmentRepository } from "./enrollment-repository.js";

type Method = keyof EnrollmentRepository;
export type InterposeHooks = Partial<Record<Method, { before?: () => void | Promise<void>; after?: (result: unknown) => void | Promise<void> }>>;

/** Deterministic pause point used by adapter and integration race cases. */
export function barrier(): { wait(): Promise<void>; resume(): void } {
  let resume!: () => void;
  const paused = new Promise<void>((resolve) => { resume = resolve; });
  return { wait: () => paused, resume };
}

/** Harness-owned decorator: adapters need no test-only failpoint capability. */
export function interpose(repository: EnrollmentRepository, hooks: InterposeHooks = {}): EnrollmentRepository & {
  throwAfterCommit(options?: { times?: number }): { remaining(): number; clear(): void };
} {
  let throws = 0;
  const control = {
    throwAfterCommit({ times = 1 }: { times?: number } = {}) { throws = times; return { remaining: () => throws, clear: () => { throws = 0; } }; },
  };
  return new Proxy(repository, {
    get(target, property, receiver) {
      if (property === "throwAfterCommit") return control.throwAfterCommit;
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      return async (...args: unknown[]) => {
        const hook = hooks[property as Method]; await hook?.before?.();
        const result = await value.apply(target, args); await hook?.after?.(result);
        if (property === "commitApproval" && throws > 0 && (result as { kind?: string }).kind === "committed") {
          throws--; throw new Error("webchannel conformance: committed response lost");
        }
        return result;
      };
    },
  }) as EnrollmentRepository & typeof control;
}

export type EnrollmentRepositoryConformanceOptions = {
  create(config: { retentionMs: number; autoSweep: false }): Promise<{
    repo: EnrollmentRepository; close(): Promise<void>; clock?: { now(): number; advance(ms: number): Promise<void> };
  }>;
};
type Instance = Awaited<ReturnType<EnrollmentRepositoryConformanceOptions["create"]>>;
export type EnrollmentRepositoryConformanceCase = {
  name: string;
  suite: "core" | "clock" | "fault";
  run(instance: Instance): Promise<void>;
};
function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`EnrollmentRepository conformance: ${message}`);
}
const baseAt = (now: number, suffix: string) => ({ device_code: `device-${suffix}`, user_code: `CODE-${suffix}`, agentPublicKey: "A".repeat(43), accountId: `account-${suffix}`, tenant: "tenant", createdAt: now, expiresAt: now + 10_000, status: "pending" as const });
const commit = { agentPublicKey: "A".repeat(43), peerId: "peer", expect: null, creds: { userJwt: "jwt", userSeed: "seed", userPubkey: "pub" } };

/**
 * Individually named cases are public so an adapter can expose them through its
 * native test runner as parameterized tests. The convenience runner below still
 * gives every case a fresh instance, which is the harness's reset contract.
 */
export const enrollmentRepositoryConformanceCases: readonly EnrollmentRepositoryConformanceCase[] = [
  { name: "core: concurrent claims are exclusive", suite: "core", async run(instance) {
    const now = instance.clock?.now() ?? Date.now();
    const base = { device_code: "device-a", user_code: "ABCD-WXYZ", agentPublicKey: "A".repeat(43), accountId: "account", tenant: "tenant", createdAt: now, expiresAt: now + 10_000, status: "pending" as const };
    await instance.repo.createEnrollment(base);
    const [a, b] = await Promise.all([instance.repo.claimApproval(base.user_code, "op-a", 1_000), instance.repo.claimApproval(base.user_code, "op-b", 1_000)]);
    invariant([a, b].filter((x) => x.kind === "claimed").length === 1 && [a, b].filter((x) => x.kind === "in_progress").length === 1, "claim exclusivity violated");
    const opId = a.kind === "claimed" ? "op-a" : "op-b";
    const committed = await instance.repo.commitApproval(opId, commit);
    invariant(committed.kind === "committed" && !committed.idempotent, "initial commit failed");
    const history = await instance.repo.listHistory(base.tenant, base.accountId);
    invariant(history.some((entry) => entry.activationId === committed.record.activationId), "approved commit absent from append-only history");
  } },
  { name: "core: idempotent result is payload-bound and immutable", suite: "core", async run(instance) {
    const now = instance.clock?.now() ?? Date.now(); const base = baseAt(now, "idempotent");
    await instance.repo.createEnrollment(base); await instance.repo.claimApproval(base.user_code, "op", 1_000);
    const committed = await instance.repo.commitApproval("op", commit); invariant(committed.kind === "committed", "initial commit failed");
    const retry = await instance.repo.commitApproval("op", commit);
    invariant(retry.kind === "committed" && retry.idempotent && JSON.stringify(retry.record) === JSON.stringify(committed.record), "exact idempotent recovery violated");
    for (const changed of [{ ...commit, agentPublicKey: "B".repeat(43) }, { ...commit, peerId: "changed" }, { ...commit, creds: { ...commit.creds, userJwt: "changed" } }, { ...commit, expect: "changed" }]) try {
      await instance.repo.commitApproval("op", changed); throw new Error("payload mutation accepted");
    }
    catch (error) { if (!(error instanceof CommitPayloadMismatchError)) throw error; }
    const observed = await instance.repo.tryExpire(base.device_code);
    invariant(observed.enrollment?.status === "approved", "approved enrollment was expired");
  } },
  { name: "clock: equality owns lease and elapsed owner is fenced", suite: "clock", async run(instance) {
    if (!instance.clock) return;
    const now = instance.clock.now(); const equal = baseAt(now, "equal");
    await instance.repo.createEnrollment(equal); await instance.repo.claimApproval(equal.user_code, "equal", 10); await instance.clock.advance(10);
    invariant((await instance.repo.commitApproval("equal", commit)).kind === "committed", "lease equality was not accepted");
    const stale = baseAt(instance.clock.now(), "stale"); await instance.repo.createEnrollment(stale); await instance.repo.claimApproval(stale.user_code, "stale", 10); await instance.clock.advance(11);
    invariant((await instance.repo.commitApproval("stale", commit)).kind === "claim_lost", "elapsed lease committed without reclaim");
  } },
  { name: "fault: committed response loss is recovered exactly", suite: "fault", async run(instance) {
    const now = instance.clock?.now() ?? Date.now(); const base = baseAt(now, "fault"); const repo = interpose(instance.repo);
    await repo.createEnrollment(base); await repo.claimApproval(base.user_code, "op", 1_000); repo.throwAfterCommit({ times: 1 });
    try { await repo.commitApproval("op", commit); throw new Error("failpoint did not fire"); } catch (error) { invariant(error instanceof Error && error.message.includes("committed response lost"), "wrong failpoint error"); }
    const recovered = await repo.commitApproval("op", commit); invariant(recovered.kind === "committed" && recovered.idempotent, "ambiguous commit was not recovered");
  } },
];

export async function runEnrollmentRepositoryConformance(options: EnrollmentRepositoryConformanceOptions): Promise<void> {
  for (const testCase of enrollmentRepositoryConformanceCases) {
    const instance = await options.create({ retentionMs: 50, autoSweep: false });
    try { await testCase.run(instance); }
    catch (error) { throw new Error(`${testCase.name}: ${error instanceof Error ? error.message : String(error)}`, { cause: error }); }
    finally { await instance.close(); }
  }
}
