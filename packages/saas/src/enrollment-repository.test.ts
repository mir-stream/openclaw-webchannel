import { describe, expect, it } from "vitest";
import { runAgentKeyRegistryConformance } from "./agent-key-registry-conformance.js";
import { interpose, runEnrollmentRepositoryConformance } from "./enrollment-repository-conformance.js";
import { CommitPayloadMismatchError, DeviceCodeCollisionError, MemoryEnrollmentRepository, UserCodeCollisionError } from "./enrollment-repository.js";
import type { EnrollmentRecord } from "./device-flow-types.js";

const KEY_A = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const KEY_B = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const creds = { userJwt: "jwt", userSeed: "seed", userPubkey: "pub" };
const record = (now: number, suffix = "a", overrides: Partial<EnrollmentRecord> = {}): EnrollmentRecord => ({
  device_code: `device-${suffix}`, user_code: `CODE-${suffix}`, agentPublicKey: KEY_A,
  tenant: "tenant", accountId: "account", createdAt: now, expiresAt: now + 1_000, status: "pending", ...overrides,
});
const payload = (key = KEY_A, expect: string | null = null) => ({ creds, peerId: "peer", agentPublicKey: key, expect });

describe("EnrollmentRepository conformance", () => {
  it("runs the exported core/clock/fault harness with instance-scoped async clock", async () => {
    await runEnrollmentRepositoryConformance({ create: async ({ retentionMs, autoSweep }) => {
      let now = 10_000; const repo = new MemoryEnrollmentRepository({ retentionMs, autoSweep, clock: () => now });
      return { repo, close: async () => repo.close(), clock: { now: () => now, advance: async (ms) => { now += ms; } } };
    } });
  });

  it("1: admits exactly one concurrent claim and reports one lease", async () => {
    const repo = new MemoryEnrollmentRepository({ autoSweep: false, clock: () => 100 }); await repo.createEnrollment(record(100));
    const outcomes = await Promise.all(Array.from({ length: 8 }, (_, i) => repo.claimApproval("CODE-a", `op-${i}`, 50)));
    expect(outcomes.filter((x) => x.kind === "claimed")).toHaveLength(1);
    expect(new Set(outcomes.filter((x) => x.kind === "in_progress").map((x) => x.kind === "in_progress" && x.leaseUntil))).toEqual(new Set([150]));
  });

  it("2: fences at lease boundaries, without requiring a reclaim", async () => {
    let now = 100; const repo = new MemoryEnrollmentRepository({ autoSweep: false, clock: () => now }); await repo.createEnrollment(record(now));
    await repo.claimApproval("CODE-a", "old", 10); now = 110;
    expect((await repo.commitApproval("old", payload())).kind).toBe("committed"); // equality is live
    await repo.createEnrollment(record(now, "b", { accountId: "b" })); await repo.claimApproval("CODE-b", "stale", 10); now = 121;
    expect((await repo.commitApproval("stale", { ...payload(), expect: null })).kind).toBe("claim_lost");
    expect((await repo.claimApproval("CODE-b", "new", 10)).kind).toBe("claimed");
    expect((await repo.commitApproval("stale", payload())).kind).toBe("claim_lost"); expect(await repo.releaseClaim("stale")).toBe(false);
  });

  it("2: follows the live-lease/expiresAt claim decision table", async () => {
    let now = 0; const repo = new MemoryEnrollmentRepository({ autoSweep: false, clock: () => now });
    await repo.createEnrollment(record(now, "a", { expiresAt: 5 })); await repo.claimApproval("CODE-a", "owner", 10); now = 6;
    expect((await repo.claimApproval("CODE-a", "other", 10)).kind).toBe("in_progress"); now = 11;
    expect((await repo.claimApproval("CODE-a", "other", 10)).kind).toBe("expired");
    await repo.createEnrollment(record(now, "b", { expiresAt: 100 })); await repo.claimApproval("CODE-b", "one", 5); now = 17;
    expect((await repo.claimApproval("CODE-b", "two", 5)).kind).toBe("claimed");
  });

  it("3: recovers exact immutable commit results and rejects four payload mutations", async () => {
    const repo = new MemoryEnrollmentRepository({ autoSweep: false, clock: () => 100 }); await repo.createEnrollment(record(100)); await repo.claimApproval("CODE-a", "op", 50);
    const first = await repo.commitApproval("op", payload()); expect(first.kind).toBe("committed");
    const again = await repo.commitApproval("op", payload()); expect(again).toEqual(first.kind === "committed" ? { ...first, idempotent: true } : first);
    if (first.kind !== "committed") throw new Error(); await repo.revokeActive("tenant", "account");
    expect(await repo.commitApproval("op", payload())).toEqual({ kind: "committed", record: first.record, idempotent: true });
    for (const changed of [{ ...payload(), agentPublicKey: KEY_B }, { ...payload(), peerId: "x" }, { ...payload(), creds: { ...creds, userJwt: "x" } }, { ...payload(), expect: "x" }])
      await expect(repo.commitApproval("op", changed)).rejects.toBeInstanceOf(CommitPayloadMismatchError);
    expect((await repo.commitApproval("other", payload())).kind).toBe("claim_lost");
  });

  it("3/4: models ambiguous committed responses only, with no partial state", async () => {
    const raw = new MemoryEnrollmentRepository({ autoSweep: false, clock: () => 100 }); const repo = interpose(raw); await repo.createEnrollment(record(100)); await repo.claimApproval("CODE-a", "op", 50);
    const fail = repo.throwAfterCommit({ times: 1 }); await expect(repo.commitApproval("op", payload())).rejects.toThrow("committed response lost"); expect(fail.remaining()).toBe(0);
    const recovered = await repo.commitApproval("op", payload()); expect(recovered).toMatchObject({ kind: "committed", idempotent: true });
    expect((await raw.getEnrollment("device-a"))?.status).toBe("approved"); expect(await raw.listHistory("tenant", "account")).toHaveLength(1);
    await raw.createEnrollment(record(100, "b", { accountId: "account", agentPublicKey: KEY_B })); await raw.claimApproval("CODE-b", "conflict", 50);
    const control = repo.throwAfterCommit({ times: 1 }); expect((await repo.commitApproval("conflict", payload(KEY_B, "wrong"))).kind).toBe("conflict");
    expect(control.remaining()).toBe(1); control.clear(); expect((await raw.getEnrollment("device-b"))?.status).toBe("pending");
  });

  it("5: preserves registry conformance and tombstone priority through commit", async () => {
    await runAgentKeyRegistryConformance(() => new MemoryEnrollmentRepository({ autoSweep: false }));
    const repo = new MemoryEnrollmentRepository({ autoSweep: false, clock: () => 100 }); const active = await repo.register("tenant", "account", KEY_A, null); if (!active.ok) throw new Error();
    await repo.revokeActive("tenant", "account"); await repo.createEnrollment(record(100)); await repo.claimApproval("CODE-a", "op", 50);
    expect((await repo.commitApproval("op", payload(KEY_A, active.record.activationId))).kind).toBe("revoked");
  });

  it("6/7: deny and expire conditionally fence transitions", async () => {
    let now = 100; const repo = new MemoryEnrollmentRepository({ autoSweep: false, clock: () => now }); await repo.createEnrollment(record(now));
    await repo.claimApproval("CODE-a", "op", 10); expect(await repo.tryDeny("CODE-a")).toBe(true); expect((await repo.commitApproval("op", payload())).kind).toBe("claim_lost");
    await repo.createEnrollment(record(now, "b")); await repo.claimApproval("CODE-b", "live", 10); now = 105;
    expect(await repo.tryExpire("device-b")).toMatchObject({ transitioned: false, enrollment: { status: "approving" } }); now = 1_200;
    expect(await repo.tryExpire("device-b")).toMatchObject({ transitioned: true, enrollment: { status: "expired" } }); expect(await repo.tryDeny("CODE-b")).toBe(false);
  });

  it("8: enforces both insertion uniqueness constraints", async () => {
    const repo = new MemoryEnrollmentRepository({ autoSweep: false }); await repo.createEnrollment(record(0));
    await expect(repo.createEnrollment(record(0, "b", { user_code: "CODE-a" }))).rejects.toBeInstanceOf(UserCodeCollisionError);
    await expect(repo.createEnrollment(record(0, "a", { user_code: "OTHER" }))).rejects.toBeInstanceOf(DeviceCodeCollisionError);
  });

  it("9: retains equality boundaries, protects live leases, then ends idempotency", async () => {
    let now = 100; const repo = new MemoryEnrollmentRepository({ autoSweep: false, retentionMs: 10, clock: () => now }); await repo.createEnrollment(record(now)); await repo.claimApproval("CODE-a", "op", 50);
    expect((await repo.commitApproval("op", payload())).kind).toBe("committed"); now = 110; expect(await repo.sweep()).toBe(0); expect((await repo.commitApproval("op", payload())).kind).toBe("committed");
    now = 111; expect(await repo.sweep()).toBe(1); expect((await repo.commitApproval("op", payload())).kind).toBe("claim_lost");
    await repo.createEnrollment(record(now, "b", { expiresAt: now + 5 })); await repo.claimApproval("CODE-b", "lease", 100); now += 20; expect(await repo.sweep()).toBe(0);
  });

  it("10: reconciliation observes not-found/not-approved/active/history and never resurrects", async () => {
    const repo = new MemoryEnrollmentRepository({ autoSweep: false, clock: () => 100 });
    expect(await repo.reconcileApprovedRegistration("missing")).toEqual({ kind: "noop", reason: "not_found" }); await repo.createEnrollment(record(100));
    expect(await repo.reconcileApprovedRegistration("device-a")).toEqual({ kind: "noop", reason: "not_approved" }); await repo.claimApproval("CODE-a", "op", 50); await repo.commitApproval("op", payload());
    expect(await repo.reconcileApprovedRegistration("device-a")).toEqual({ kind: "noop", reason: "active_present" }); await repo.revokeActive("tenant", "account");
    expect(await repo.reconcileApprovedRegistration("device-a")).toEqual({ kind: "noop", reason: "history_present" }); expect(await repo.getActive("tenant", "account")).toBeNull();
  });

  it("3: rejects reuse of one opId across different enrollments", async () => {
    const repo = new MemoryEnrollmentRepository({ autoSweep: false, clock: () => 100 });
    await repo.createEnrollment(record(100, "a")); await repo.createEnrollment(record(100, "b", { accountId: "b" }));
    await repo.claimApproval("CODE-a", "shared-op", 50);
    await expect(repo.claimApproval("CODE-b", "shared-op", 50)).rejects.toBeInstanceOf(CommitPayloadMismatchError);
    expect((await repo.getEnrollment("device-b"))?.status).toBe("pending");
  });

  it("4: conflict, revoked, expired, and claim-lost commits leave no partial approval/history", async () => {
    let now = 100; const repo = new MemoryEnrollmentRepository({ autoSweep: false, clock: () => now });
    const seeded = await repo.register("tenant", "account", KEY_A, null); if (!seeded.ok) throw new Error();
    await repo.createEnrollment(record(now, "conflict", { agentPublicKey: KEY_B })); await repo.claimApproval("CODE-conflict", "conflict", 10);
    expect((await repo.commitApproval("conflict", payload(KEY_B, null))).kind).toBe("conflict");
    expect((await repo.getEnrollment("device-conflict"))?.status).toBe("pending");
    expect(await repo.listHistory("tenant", "account")).toHaveLength(1);

    await repo.revokeActive("tenant", "account");
    await repo.createEnrollment(record(now, "revoked")); await repo.claimApproval("CODE-revoked", "revoked", 10);
    expect((await repo.commitApproval("revoked", payload(KEY_A, seeded.record.activationId))).kind).toBe("revoked");
    expect((await repo.getEnrollment("device-revoked"))?.status).toBe("pending");

    await repo.createEnrollment(record(now, "expired", { accountId: "expired", expiresAt: 101 })); await repo.claimApproval("CODE-expired", "expired", 10); now = 102;
    expect((await repo.commitApproval("expired", payload())).kind).toBe("expired");
    expect(await repo.getActive("tenant", "expired")).toBeNull();
    expect((await repo.commitApproval("missing", payload())).kind).toBe("claim_lost");
  });

  it("5: commit keeps tombstone > same-key > CAS precedence", async () => {
    const repo = new MemoryEnrollmentRepository({ autoSweep: false, clock: () => 100 });
    const active = await repo.register("tenant", "same", KEY_A, null); if (!active.ok) throw new Error();
    await repo.createEnrollment(record(100, "same", { accountId: "same" })); await repo.claimApproval("CODE-same", "same", 20);
    const same = await repo.commitApproval("same", payload(KEY_A, "stale"));
    expect(same).toMatchObject({ kind: "committed", record: { activationId: active.record.activationId } });
    expect(await repo.listHistory("tenant", "same")).toHaveLength(1);
    await repo.revokeActive("tenant", "same");
    await repo.createEnrollment(record(100, "tomb", { accountId: "same" })); await repo.claimApproval("CODE-tomb", "tomb", 20);
    expect((await repo.commitApproval("tomb", payload(KEY_A, null))).kind).toBe("revoked");
  });

  it("6: covers the complete deny matrix and ambiguous-commit three-step recovery", async () => {
    let now = 100; const raw = new MemoryEnrollmentRepository({ autoSweep: false, clock: () => now });
    await raw.createEnrollment(record(now, "pending")); expect(await raw.tryDeny("CODE-pending")).toBe(true); expect(await raw.tryDeny("CODE-pending")).toBe(false);
    await raw.createEnrollment(record(now, "past", { expiresAt: 99 })); expect(await raw.tryDeny("CODE-past")).toBe(false); expect((await raw.getEnrollment("device-past"))?.status).toBe("expired");
    await raw.createEnrollment(record(now, "approved", { accountId: "approved" })); await raw.claimApproval("CODE-approved", "op", 10);
    const repo = interpose(raw); repo.throwAfterCommit({ times: 1 });
    await expect(repo.commitApproval("op", { ...payload(), expect: null })).rejects.toThrow("committed response lost");
    expect(await repo.tryDeny("CODE-approved")).toBe(false);
    expect(await repo.commitApproval("op", payload())).toMatchObject({ kind: "committed", idempotent: true });
  });

  it("7: expire returns the post-operation record for missing, pending, live/elapsed approving, and approved", async () => {
    let now = 10; const repo = new MemoryEnrollmentRepository({ autoSweep: false, clock: () => now });
    expect(await repo.tryExpire("missing")).toEqual({ transitioned: false, enrollment: null });
    await repo.createEnrollment(record(0, "pending", { expiresAt: 9 })); expect(await repo.tryExpire("device-pending")).toMatchObject({ transitioned: true, enrollment: { status: "expired" } });
    await repo.createEnrollment(record(10, "live", { expiresAt: 11 })); await repo.claimApproval("CODE-live", "live", 5); now = 12;
    expect(await repo.tryExpire("device-live")).toMatchObject({ transitioned: false, enrollment: { status: "approving" } }); now = 16;
    expect(await repo.tryExpire("device-live")).toMatchObject({ transitioned: true, enrollment: { status: "expired" } });
    await repo.createEnrollment(record(now, "approved", { accountId: "approved" })); await repo.claimApproval("CODE-approved", "approved", 5); await repo.commitApproval("approved", payload()); now = 1_000;
    expect(await repo.tryExpire("device-approved")).toMatchObject({ transitioned: false, enrollment: { status: "approved", natsCreds: creds } });
  });

  it("9: pending/denied/expired retain at equality and evict strictly after expiresAt+configured retention", async () => {
    let now = 0; const repo = new MemoryEnrollmentRepository({ autoSweep: false, retentionMs: 10, clock: () => now });
    for (const suffix of ["pending", "denied", "expired"]) await repo.createEnrollment(record(now, suffix, { expiresAt: 5 }));
    await repo.tryDeny("CODE-denied"); now = 6; await repo.tryExpire("device-expired"); now = 15;
    expect(await repo.sweep()).toBe(0); now = 16; expect(await repo.sweep()).toBe(3);
  });

  it("10: reconciles an approved legacy snapshot only when the slot is empty", async () => {
    const repo = new MemoryEnrollmentRepository({ autoSweep: false, clock: () => 100 });
    // A conformance adapter can receive legacy approved data through its normal
    // migration path; the memory reference fixture injects that durable shape.
    const legacy = record(100, "legacy", { status: "approved", natsCreds: creds, peerId: "peer", approvedAt: 100 });
    await repo.createEnrollment(legacy);
    const result = await repo.reconcileApprovedRegistration("device-legacy");
    expect(result.kind).toBe("registered");
    expect((await repo.getActive("tenant", "account"))?.publicKey).toBe(KEY_A);
  });
});
