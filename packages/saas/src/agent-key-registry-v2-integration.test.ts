import { describe, expect, it, vi } from "vitest";
import { createAccount } from "@nats-io/nkeys";
import { DeviceFlowEnrollment, type ApproveOutcome } from "./device-flow-enrollment.js";
import { interpose } from "./enrollment-repository-conformance.js";
import { MemoryEnrollmentRepository, type EnrollmentRepository } from "./enrollment-repository.js";
import type { EnrollmentRequest } from "./device-flow-types.js";

const KEY_A = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const KEY_B = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const account = createAccount();
const base = {
  saasTrustChain: { rsaPrivateKeyPem: "-----BEGIN PRIVATE KEY-----\nTEST\n-----END PRIVATE KEY-----", natsAccountSeed: new TextDecoder().decode(account.getSeed()) },
  natsAccountConfig: { operatorJwt: "op", accountJwt: "acct", resolverConfig: {}, accountPublicKey: "pub" },
  saasBaseUrl: "https://saas.test", jwksUrl: "https://saas.test/jwks", bootstrapUrl: "https://saas.test/bootstrap",
  natsUrl: "wss://nats.test", expirationSeconds: 600, pollIntervalSeconds: 5,
};
const request = (key: string, accountId = "account"): EnrollmentRequest => ({ agentPublicKey: key, tenant: "tenant", accountId });
const service = (repository: EnrollmentRepository) => new DeviceFlowEnrollment({ ...base, repository });
const pending = (svc: DeviceFlowEnrollment, key = KEY_A, accountId = "account") => svc.enroll(request(key, accountId));
const approved = (outcome: ApproveOutcome) => {
  expect(outcome.kind).toBe("approved");
  if (outcome.kind !== "approved") throw new Error(`expected approved, got ${outcome.kind}`);
  return outcome.result;
};
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r; }); return { promise, resolve }; };

describe("P1-2 atomic enrollment integration", () => {
  it("requires the unified repository", () => {
    expect(() => new DeviceFlowEnrollment(base as ConstructorParameters<typeof DeviceFlowEnrollment>[0])).toThrow("repository is required");
  });

  it("gates replacement before mint and preserves CAS confirmation", async () => {
    const repo = new MemoryEnrollmentRepository({ autoSweep: false }); const svc = service(repo);
    approved(await svc.approve((await pending(svc)).user_code));
    const next = await pending(svc, KEY_B); const mint = vi.spyOn(svc as never, "generateNatsUserCredentials" as never);
    const conflict = await svc.approve(next.user_code); expect(conflict.kind).toBe("conflict"); expect(mint).not.toHaveBeenCalled();
    expect((await repo.getEnrollment(next.device_code))?.status).toBe("pending");
    if (conflict.kind !== "conflict" || !conflict.existing) throw new Error("missing conflict token");
    approved(await svc.approve(next.user_code, { replaceActivationId: conflict.existing.activationId }));
    expect((await repo.getActive("tenant", "account"))?.publicKey).toBe(KEY_B);
  });

  it("two issuers sharing one repository produce one commit and stable credentials", async () => {
    const entered = deferred(); const release = deferred();
    const raw = new MemoryEnrollmentRepository({ autoSweep: false });
    let paused = true;
    const repo = interpose(raw, { commitApproval: { before: async () => { if (paused) { paused = false; entered.resolve(); await release.promise; } } } });
    const a = service(repo); const b = service(repo); const started = await pending(a);
    const first = a.approve(started.user_code); await entered.promise;
    expect((await b.approve(started.user_code)).kind).toBe("in_progress"); release.resolve();
    const winner = approved(await first); const retry = approved(await b.approve(started.user_code));
    expect(retry).toEqual(winner); expect(await a.poll({ device_code: started.device_code })).toEqual(winner);
    expect(await repo.listHistory("tenant", "account")).toHaveLength(1);
  });

  it("deny of an approving record fences the late commit", async () => {
    const repo = new MemoryEnrollmentRepository({ autoSweep: false }); const svc = service(repo); const otherIssuer = service(repo); const started = await pending(svc);
    const entered = deferred(); const release = deferred(); const original = (svc as any).generateNatsUserCredentials.bind(svc);
    (svc as any).generateNatsUserCredentials = async (...args: unknown[]) => { entered.resolve(); await release.promise; return original(...args); };
    const approval = svc.approve(started.user_code); await entered.promise; expect(await otherIssuer.deny(started.user_code)).toBe(true); release.resolve();
    expect((await approval).kind).toBe("rejected"); expect((await repo.getEnrollment(started.device_code))?.status).toBe("denied");
    expect(await repo.listHistory("tenant", "account")).toEqual([]);
  });

  it("mint failure releases the claim and a retry recovers", async () => {
    const repo = new MemoryEnrollmentRepository({ autoSweep: false }); const svc = service(repo); const started = await pending(svc);
    const original = (svc as any).generateNatsUserCredentials.bind(svc);
    (svc as any).generateNatsUserCredentials = vi.fn().mockRejectedValueOnce(new Error("mint failed")).mockImplementation(original);
    await expect(svc.approve(started.user_code)).rejects.toThrow("mint failed");
    expect((await repo.getEnrollment(started.device_code))?.status).toBe("pending"); approved(await svc.approve(started.user_code));
  });

  it("recovers one lost commit response and propagates two", async () => {
    const raw = new MemoryEnrollmentRepository({ autoSweep: false }); const decorated = interpose(raw); const svc = service(decorated);
    decorated.throwAfterCommit({ times: 1 }); const one = await pending(svc); const result = approved(await svc.approve(one.user_code));
    expect(await svc.poll({ device_code: one.device_code })).toEqual(result);
    const raw2 = new MemoryEnrollmentRepository({ autoSweep: false }); const twice = interpose(raw2); const svc2 = service(twice);
    twice.throwAfterCommit({ times: 2 }); const two = await pending(svc2); await expect(svc2.approve(two.user_code)).rejects.toThrow("committed response lost");
    approved(await svc2.approve(two.user_code));
  });

  it("approved polling ignores expiresAt while pending polling expires", async () => {
    let now = 1_000; const repo = new MemoryEnrollmentRepository({ autoSweep: false, clock: () => now }); const svc = service(repo);
    vi.spyOn(Date, "now").mockReturnValue(now); const ok = await pending(svc); const result = approved(await svc.approve(ok.user_code));
    now = 1_000_000; expect(await svc.poll({ device_code: ok.device_code })).toEqual(result); vi.restoreAllMocks();
    let later = 1_000; const repo2 = new MemoryEnrollmentRepository({ autoSweep: false, clock: () => later }); const svc2 = service(repo2);
    vi.spyOn(Date, "now").mockReturnValue(later); const stale = await pending(svc2); later = 1_000_000;
    expect(await svc2.poll({ device_code: stale.device_code })).toMatchObject({ error: "expired_token" }); vi.restoreAllMocks();
  });

  it("the process-local lock is only an optimization", async () => {
    const repo = new MemoryEnrollmentRepository({ autoSweep: false }); const svc = service(repo); const started = await pending(svc);
    const inner = (svc as any).approveInner.bind(svc) as (code: string) => Promise<ApproveOutcome>;
    const outcomes = await Promise.all([inner(started.user_code), inner(started.user_code)]);
    expect(outcomes.filter((x) => x.kind === "approved")).toHaveLength(1);
    expect(outcomes.filter((x) => x.kind === "in_progress")).toHaveLength(1);
    expect(await repo.listHistory("tenant", "account")).toHaveLength(1);
  });

  it("keeps enrollment and poll wire shapes unchanged", async () => {
    const svc = service(new MemoryEnrollmentRepository({ autoSweep: false })); const started = await pending(svc);
    expect(Object.keys(started).sort()).toEqual(["device_code", "expires_in", "interval", "user_code", "verification_uri", "verification_uri_complete"]);
    approved(await svc.approve(started.user_code));
    expect(Object.keys(await svc.poll({ device_code: started.device_code })).sort()).toEqual(["bootstrapUrl", "creds", "issuer", "jwksUrl", "natsUrl", "peerId"]);
  });

  it("15: conflict and revoked-key gates release claims without minting or changing pending", async () => {
    const raw = new MemoryEnrollmentRepository({ autoSweep: false }); const svc = service(raw);
    approved(await svc.approve((await pending(svc, KEY_A)).user_code));
    const blocked = await pending(svc, KEY_B); const mint = vi.spyOn(svc as never, "generateNatsUserCredentials" as never);
    expect((await svc.approve(blocked.user_code)).kind).toBe("conflict");
    expect(mint).not.toHaveBeenCalled(); expect((await raw.getEnrollment(blocked.device_code))?.status).toBe("pending");
    await raw.revokeActive("tenant", "account");
    const revoked = await pending(svc, KEY_A); mint.mockClear();
    expect((await svc.approve(revoked.user_code)).kind).toBe("revoked_key");
    expect(mint).not.toHaveBeenCalled(); expect((await raw.getEnrollment(revoked.device_code))?.status).toBe("pending");
  });

  it("16: already-approved recovery exercises all reconciliation outcomes without creating a claim", async () => {
    for (const expected of ["registered", "active_present", "history_present", "not_found"] as const) {
      const raw = new MemoryEnrollmentRepository({ autoSweep: false }); const fixture = service(raw);
      const started = await pending(fixture, KEY_A, `reconcile-${expected}`); const first = approved(await fixture.approve(started.user_code));
      if (expected !== "active_present") await raw.revokeActive("tenant", `reconcile-${expected}`);
      if (expected === "registered") {
        // A legacy approved snapshot may have lost both registry writes. The
        // memory fixture clears only registry state while retaining enrollment.
        (raw as any).histories.clear();
      } else if (expected === "not_found") {
        // The claim returned an approved snapshot, but eviction won before the
        // reconciliation RMW. This is an allowed recovery outcome.
        (raw as any).enrollments.delete(started.device_code);
        (raw as any).userCodes.delete(started.user_code);
      }
      let reconcileReason = ""; let claimedAfterApproval = false;
      const repo = new Proxy(raw, { get(target, property, receiver) {
        if (property === "claimApproval") return async (...args: Parameters<EnrollmentRepository["claimApproval"]>) => {
          if (expected === "not_found") return { kind: "already_approved", enrollment: { status: "approved", device_code: started.device_code, user_code: started.user_code, agentPublicKey: KEY_A, tenant: "tenant", accountId: `reconcile-${expected}`, createdAt: 0, expiresAt: 1, approvedAt: 0, natsCreds: first.creds, peerId: first.peerId } } as const;
          const result = await target.claimApproval(...args); if (result.kind === "claimed" && (await target.getEnrollmentByUserCode(args[0]))?.status === "approved") claimedAfterApproval = true; return result;
        };
        if (property === "reconcileApprovedRegistration") return async (code: string) => { const result = await target.reconcileApprovedRegistration(code); reconcileReason = result.kind === "registered" ? result.kind : result.reason; return result; };
        const value = Reflect.get(target, property, receiver); return typeof value === "function" ? value.bind(target) : value;
      } }) as EnrollmentRepository;
      expect(approved(await service(repo).approve(started.user_code))).toEqual(first);
      expect(reconcileReason).toBe(expected); expect(claimedAfterApproval).toBe(false);
    }
  });

  it("17/19: poll follows repository time and both expire/commit serializations preserve the winner", async () => {
    let repositoryNow = 1_000; const raw = new MemoryEnrollmentRepository({ autoSweep: false, retentionMs: 10, clock: () => repositoryNow });
    vi.spyOn(Date, "now").mockReturnValue(9_000_000); const svc = service(raw); const started = await pending(svc);
    const result = approved(await svc.approve(started.user_code));
    const repo = interpose(raw, { tryExpire: { after: async (outcome) => expect(outcome).toMatchObject({ enrollment: { status: "approved" } }) } });
    repositoryNow = 1_011;
    expect(await service(repo).poll({ device_code: started.device_code })).toEqual(result);
    expect((await raw.getEnrollment(started.device_code))?.status).toBe("approved");
    expect(await raw.sweep()).toBe(1); expect(await svc.poll({ device_code: started.device_code })).toMatchObject({ error: "invalid_device_code" });

    // Expire first: a pending record becomes terminal and a later approval is
    // rejected. Commit first: tryExpire observes approved and cannot overwrite.
    repositoryNow = 100; vi.mocked(Date.now).mockReturnValue(100);
    const expireFirst = await pending(svc, KEY_A, "expire-first"); repositoryNow = 1_000_000;
    expect(await svc.poll({ device_code: expireFirst.device_code })).toMatchObject({ error: "expired_token" });
    expect((await svc.approve(expireFirst.user_code)).kind).toBe("rejected");
    vi.restoreAllMocks();
  });

  it("20: claim loss cannot report a fake approval and creates no activation", async () => {
    const raw = new MemoryEnrollmentRepository({ autoSweep: false }); let claimedOp = ""; let released = false;
    const repo = new Proxy(raw, { get(target, property, receiver) {
      if (property === "claimApproval") return async (...args: Parameters<EnrollmentRepository["claimApproval"]>) => { claimedOp = args[1]; return target.claimApproval(...args); };
      if (property === "commitApproval") return async (...args: Parameters<EnrollmentRepository["commitApproval"]>) => { if (!released) { released = true; await target.releaseClaim(claimedOp); } return target.commitApproval(...args); };
      const value = Reflect.get(target, property, receiver); return typeof value === "function" ? value.bind(target) : value;
    } }) as EnrollmentRepository;
    const svc = service(repo); const started = await pending(svc, KEY_A, "lost");
    expect((await svc.approve(started.user_code)).kind).toBe("rejected");
    expect(await raw.getActive("tenant", "lost")).toBeNull();
    expect((await raw.getEnrollment(started.device_code))?.status).toBe("pending");
  });

  it("20: sweep loss during approval returns only allowed failure outcomes and never a fake activation", async () => {
    let now = 100; const raw = new MemoryEnrollmentRepository({ autoSweep: false, retentionMs: 0, clock: () => now });
    let swept = false;
    const repo = new Proxy(raw, { get(target, property, receiver) {
      if (property === "commitApproval") return async (...args: Parameters<EnrollmentRepository["commitApproval"]>) => {
        if (!swept) { swept = true; now = 1_000_000; await target.sweep(); }
        return target.commitApproval(...args);
      };
      const value = Reflect.get(target, property, receiver); return typeof value === "function" ? value.bind(target) : value;
    } }) as EnrollmentRepository;
    vi.spyOn(Date, "now").mockReturnValue(100); const svc = service(repo); const started = await pending(svc, KEY_A, "swept");
    expect((await svc.approve(started.user_code)).kind).toBe("rejected");
    expect(await raw.getEnrollment(started.device_code)).toBeNull(); expect(await raw.getActive("tenant", "swept")).toBeNull();
    vi.restoreAllMocks();
  });
});
