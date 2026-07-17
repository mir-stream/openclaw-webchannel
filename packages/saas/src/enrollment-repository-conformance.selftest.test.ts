import { describe, expect, it } from "vitest";
import {
  enrollmentRepositoryConformanceCases,
  runEnrollmentRepositoryConformance,
  type EnrollmentRepositoryConformanceCase,
} from "./enrollment-repository-conformance.js";
import { MemoryEnrollmentRepository, type EnrollmentRepository } from "./enrollment-repository.js";

type Broken = "non_atomic_conflict" | "stale_commit" | "retention" | "reconcile_overwrite";

function findCase(prefix: string): EnrollmentRepositoryConformanceCase {
  const found = enrollmentRepositoryConformanceCases.find((candidate) => candidate.name.startsWith(prefix));
  if (!found) throw new Error(`missing exported conformance ${prefix}`);
  return found;
}

function breakRepository(inner: MemoryEnrollmentRepository, defect: Broken): EnrollmentRepository {
  return new Proxy(inner, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      if (defect === "non_atomic_conflict" && property === "commitApproval") return async (opId: string, payload: Parameters<EnrollmentRepository["commitApproval"]>[1]) => {
        if (opId !== "conflict") return target.commitApproval(opId, payload);
        // Model the exact forbidden split transaction: registry CAS is durable,
        // but the adapter reports conflict without rolling that activation back.
        const enrollment = await target.getEnrollment("device-atomic-conflict"); const active = enrollment && await target.getActive(enrollment.tenant, enrollment.accountId);
        if (!enrollment || !active) throw new Error("non-atomic fixture missing");
        await target.register(enrollment.tenant, enrollment.accountId, enrollment.agentPublicKey, active.activationId);
        return { kind: "conflict" as const, current: active };
      };
      if (defect === "stale_commit" && property === "commitApproval") return async (opId: string, payload: Parameters<EnrollmentRepository["commitApproval"]>[1]) => {
        const honest = await target.commitApproval(opId, payload); if (opId !== "old-fenced" || honest.kind !== "claim_lost") return honest;
        const enrollment = await target.getEnrollment("device-atomic-fenced"); if (!enrollment) throw new Error("stale fixture missing");
        const registered = await target.register(enrollment.tenant, enrollment.accountId, enrollment.agentPublicKey, null);
        if (!registered.ok) throw new Error("stale fixture registration failed");
        return { kind: "committed" as const, record: registered.record, idempotent: false };
      };
      if (defect === "reconcile_overwrite" && property === "reconcileApprovedRegistration") return async (deviceCode: string) => {
        const enrollment = await target.getEnrollment(deviceCode); if (!enrollment?.status || enrollment.status !== "approved") return target.reconcileApprovedRegistration(deviceCode);
        const active = await target.getActive(enrollment.tenant, enrollment.accountId);
        if (!active) return target.reconcileApprovedRegistration(deviceCode);
        // A broken repair path treats reconciliation as an unconditional
        // supersede, resurrecting the legacy enrollment over an occupied slot.
        const replaced = await target.register(enrollment.tenant, enrollment.accountId, enrollment.agentPublicKey, active.activationId);
        if (!replaced.ok) throw new Error("overwrite fixture failed");
        return { kind: "registered" as const, record: replaced.record };
      };
      return value.bind(target);
    },
  });
}

function controlled(defect?: Broken) {
  let now = 10_000;
  // The retention defect deliberately discards the harness-supplied 50ms.
  const inner = new MemoryEnrollmentRepository({ autoSweep: false, retentionMs: defect === "retention" ? 5_000 : 50, clock: () => now });
  return { repo: defect ? breakRepository(inner, defect) : inner, close: async () => inner.close(), clock: { now: () => now, advance: async (ms: number) => { now += ms; } } };
}

describe("EnrollmentRepository conformance harness self-tests", () => {
  it("accepts the honest memory implementation across the full suite", async () => {
    const report = await runEnrollmentRepositoryConformance({ create: async () => controlled() });
    expect(report.skipped).toEqual([]); expect(report.passed).toHaveLength(enrollmentRepositoryConformanceCases.length);
  });

  for (const [prefix, defect] of [["4:", "non_atomic_conflict"], ["4:", "stale_commit"], ["9:", "retention"], ["10:", "reconcile_overwrite"]] as const) {
    it(`rejects the deliberately broken ${defect} adapter`, async () => {
      await expect(findCase(prefix).run(controlled(defect))).rejects.toThrow(/EnrollmentRepository conformance/);
    });
  }

  it("fails a directly selected clock case loudly and visibly skips clock cases in the convenience runner", async () => {
    const withoutClock = () => { const repo = new MemoryEnrollmentRepository({ autoSweep: false, clock: () => 10_000 }); return { repo, close: async () => repo.close() }; };
    await expect(findCase("4:").run(withoutClock())).rejects.toThrow("case 4 requires the optional controlled clock capability");
    const skips: string[] = []; const report = await runEnrollmentRepositoryConformance({ create: async () => withoutClock(), reportSkip: (message) => skips.push(message) });
    expect(report.skipped).toHaveLength(enrollmentRepositoryConformanceCases.filter((candidate) => candidate.suite === "clock").length);
    expect(skips).toHaveLength(report.skipped.length); expect(skips.every((message) => message.includes("SKIP") && message.includes("controlled clock"))).toBe(true);
  });
});
