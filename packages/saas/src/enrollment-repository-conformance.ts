import { CommitPayloadMismatchError, type EnrollmentRepository } from "./enrollment-repository.js";

type Method = keyof EnrollmentRepository;
export type InterposeHooks = Partial<Record<Method, { before?: () => void | Promise<void>; after?: (result: unknown) => void | Promise<void> }>>;

/** Deterministic pause point used by adapter and integration race cases. */
export function barrier(): { wait(): Promise<void>; resume(): void } {
  let resume!: () => void;
  const paused = new Promise<void>((resolve) => { resume = resolve; });
  return { wait: () => paused, resume };
}

export type EnrollmentRepositoryFaultControl = {
  remaining(): number;
  clear(): void;
};

/** Harness-owned decorator: adapters need no test-only failpoint capability. */
export function interpose(repository: EnrollmentRepository, hooks: InterposeHooks = {}): EnrollmentRepository & {
  throwAfterCommit(options?: { times?: number }): EnrollmentRepositoryFaultControl;
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
  /** Receives the same visible message emitted by the default console reporter. */
  reportSkip?(message: string): void;
};
type Instance = Awaited<ReturnType<EnrollmentRepositoryConformanceOptions["create"]>>;
type Clock = NonNullable<Instance["clock"]>;
export type EnrollmentRepositoryConformanceCase = {
  name: string;
  suite: "core" | "clock" | "fault";
  run(instance: Instance): Promise<void>;
};
function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`EnrollmentRepository conformance: ${message}`);
}
function requireClock(instance: Instance, caseName: string): Clock {
  invariant(instance.clock, `${caseName} requires the optional controlled clock capability`);
  return instance.clock;
}
const baseAt = (now: number, suffix: string) => ({ device_code: `device-${suffix}`, user_code: `CODE-${suffix}`, agentPublicKey: "A".repeat(43), accountId: `account-${suffix}`, tenant: "tenant", createdAt: now, expiresAt: now + 10_000, status: "pending" as const });
const commit = { agentPublicKey: "A".repeat(43), peerId: "peer", expect: null, creds: { userJwt: "jwt", userSeed: "seed", userPubkey: "pub" } };
const same = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);
const status = async (repo: EnrollmentRepository, deviceCode: string, expected: string): Promise<void> =>
  invariant((await repo.getEnrollment(deviceCode))?.status === expected, `${deviceCode} expected ${expected}`);
async function projection(repo: EnrollmentRepository, item: { device_code: string; tenant: string; accountId: string }) {
  return {
    enrollment: await repo.getEnrollment(item.device_code),
    active: await repo.getActive(item.tenant, item.accountId),
    history: await repo.listHistory(item.tenant, item.accountId),
  };
}
function transitionedEnrollment(before: Awaited<ReturnType<typeof projection>>["enrollment"], status: "pending" | "expired") {
  invariant(before, `cannot project ${status} transition from a missing enrollment`);
  const expected = { ...before, status }; delete expected.claim; return expected;
}
async function expectMismatch(action: () => Promise<unknown>, message: string): Promise<void> {
  try { await action(); throw new Error(message); }
  catch (error) { invariant(error instanceof CommitPayloadMismatchError, message); }
}

/**
 * Individually named cases are public so an adapter can expose them through its
 * native test runner as parameterized tests. The convenience runner below still
 * gives every case a fresh instance, which is the harness's reset contract.
 */
export const enrollmentRepositoryConformanceCases: readonly EnrollmentRepositoryConformanceCase[] = [
  { name: "1: concurrent claims are exclusive", suite: "core", async run(instance) {
    const now = 10_000;
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
  { name: "2: lease fencing, boundaries, decision table, and both race orders", suite: "clock", async run(instance) {
    const repo = instance.repo; const clock = requireClock(instance, "case 2"); const now = clock.now();
    const equal = baseAt(now, "equal"); await repo.createEnrollment(equal); await repo.claimApproval(equal.user_code, "equal", 10); await clock.advance(10);
    invariant((await repo.commitApproval("equal", commit)).kind === "committed", "lease equality was not accepted");
    const stale = baseAt(clock.now(), "stale"); await repo.createEnrollment(stale); await repo.claimApproval(stale.user_code, "old", 10); await clock.advance(11);
    const before = await repo.getEnrollment(stale.device_code);
    invariant((await repo.commitApproval("old", commit)).kind === "claim_lost", "elapsed owner committed without reclaim");
    invariant(same(await repo.getEnrollment(stale.device_code), before), "stale commit mutated state");
    invariant((await repo.claimApproval(stale.user_code, "new", 10)).kind === "claimed", "elapsed lease was not reclaimable");
    invariant((await repo.commitApproval("old", commit)).kind === "claim_lost" && !(await repo.releaseClaim("old")), "old owner was not fenced after reclaim");

    const livePast = { ...baseAt(clock.now(), "live-past"), expiresAt: clock.now() + 5, accountId: "live-past" };
    await repo.createEnrollment(livePast); await repo.claimApproval(livePast.user_code, "live", 10); await clock.advance(6);
    invariant((await repo.claimApproval(livePast.user_code, "other", 10)).kind === "in_progress", "live lease lost to expiresAt");
    await clock.advance(5); invariant((await repo.claimApproval(livePast.user_code, "other", 10)).kind === "expired", "elapsed lease past expiresAt did not expire");
    const reclaimable = { ...baseAt(clock.now(), "reclaimable"), accountId: "reclaimable" }; await repo.createEnrollment(reclaimable);
    await repo.claimApproval(reclaimable.user_code, "r1", 5); await clock.advance(6);
    invariant((await repo.claimApproval(reclaimable.user_code, "r2", 5)).kind === "claimed", "valid elapsed lease did not reclaim");

    // The barrier pins which atomic call reaches the repository first. In both
    // serializations exactly one writer wins and a stale call is mutation-free.
    for (const commitFirst of [true, false]) {
      const item = { ...baseAt(clock.now(), `race-${commitFirst}`), accountId: `race-${commitFirst}` }; await repo.createEnrollment(item);
      await repo.claimApproval(item.user_code, `owner-${commitFirst}`, 5); await clock.advance(commitFirst ? 5 : 6);
      const gate = barrier(); const decorated = interpose(repo, commitFirst
        ? { claimApproval: { before: gate.wait } } : { commitApproval: { before: gate.wait } });
      const paused = commitFirst
        ? decorated.claimApproval(item.user_code, `reclaimer-${commitFirst}`, 10)
        : decorated.commitApproval(`owner-${commitFirst}`, commit);
      await Promise.resolve();
      const winner = commitFirst
        ? repo.commitApproval(`owner-${commitFirst}`, commit)
        : repo.claimApproval(item.user_code, `reclaimer-${commitFirst}`, 10);
      gate.resume(); const [delayed, firstResult] = await Promise.all([paused, winner]);
      if (commitFirst) {
        invariant(firstResult.kind === "committed" && delayed.kind === "already_approved", "commit-first serialization did not preserve its exact winner");
        // The RETURNED outcome must itself carry the recovery payload the plan
        // guarantees ("creds/peerId/approvedAt/committedBy 보유 보장") — the A2
        // re-return path consumes exactly this object, so an adapter that only
        // sets the stored record but returns a bare already_approved would pass
        // a state re-read yet break every loser-retry recovery.
        invariant(delayed.kind === "already_approved" && same(delayed.enrollment.natsCreds, commit.creds) && delayed.enrollment.peerId === commit.peerId
          && typeof delayed.enrollment.approvedAt === "number" && typeof delayed.enrollment.committedBy === "string",
          "already_approved outcome lacks the guaranteed recovery payload");
        const saved = await repo.getEnrollment(item.device_code);
        invariant(saved?.status === "approved" && same(saved.natsCreds, commit.creds) && saved.peerId === commit.peerId, "commit-first credentials changed");
      } else {
        invariant(firstResult.kind === "claimed" && delayed.kind === "claim_lost", "reclaim-first serialization did not fence stale commit");
        invariant((await repo.getEnrollment(item.device_code))?.claim?.opId === `reclaimer-${commitFirst}`, "stale commit mutated replacement claim");
      }
      invariant((await repo.listHistory(item.tenant, item.accountId)).length === (commitFirst ? 1 : 0), "commit/reclaim race produced wrong activation count");
    }
  } },
  { name: "3: immutable idempotency, supersede/revoke recovery, payload and opId binding", suite: "core", async run(instance) {
    const now = 10_000; const base = baseAt(now, "idempotent");
    await instance.repo.createEnrollment(base); await instance.repo.claimApproval(base.user_code, "op", 1_000);
    const committed = await instance.repo.commitApproval("op", commit); invariant(committed.kind === "committed", "initial commit failed");
    const retry = await instance.repo.commitApproval("op", commit);
    invariant(retry.kind === "committed" && retry.idempotent && same(retry.record, committed.record), "exact idempotent recovery violated");
    const replacement = { ...baseAt(now, "replacement"), accountId: base.accountId, agentPublicKey: "B".repeat(43) };
    await instance.repo.createEnrollment(replacement); await instance.repo.claimApproval(replacement.user_code, "replacement", 1_000);
    const replaced = await instance.repo.commitApproval("replacement", { ...commit, agentPublicKey: replacement.agentPublicKey, expect: committed.kind === "committed" ? committed.record.activationId : null, creds: { userJwt: "jwt-2", userSeed: "seed-2", userPubkey: "pub-2" }, peerId: "peer-2" });
    invariant(replaced.kind === "committed", "supersede fixture failed");
    const afterSupersede = await instance.repo.commitApproval("op", commit);
    invariant(afterSupersede.kind === "committed" && same(afterSupersede.record, committed.record), "supersede changed committed snapshot");
    await instance.repo.revokeActive(base.tenant, base.accountId);
    const afterRevoke = await instance.repo.commitApproval("op", commit);
    invariant(afterRevoke.kind === "committed" && same(afterRevoke.record, committed.record), "revoke changed committed snapshot");
    for (const changed of [{ ...commit, agentPublicKey: "B".repeat(43) }, { ...commit, peerId: "changed" }, { ...commit, creds: { ...commit.creds, userJwt: "changed" } }, { ...commit, expect: "changed" }]) try {
      await instance.repo.commitApproval("op", changed); throw new Error("payload mutation accepted");
    }
    catch (error) { if (!(error instanceof CommitPayloadMismatchError)) throw error; }
    const observed = await instance.repo.tryExpire(base.device_code);
    invariant(observed.enrollment?.status === "approved", "approved enrollment was expired");
    invariant(observed.enrollment?.peerId === commit.peerId && same(observed.enrollment?.natsCreds, commit.creds), "persisted exact credentials/peerId differ");
    invariant((await instance.repo.commitApproval("other-op", commit)).kind === "claim_lost", "other opId recovered commit");
    const other = { ...baseAt(now, "op-reuse"), accountId: "op-reuse" }; await instance.repo.createEnrollment(other);
    await expectMismatch(() => instance.repo.claimApproval(other.user_code, "op", 10), "opId reuse was silently accepted");
  } },
  { name: "4: commit success and every failure are atomic", suite: "clock", async run(instance) {
    const repo = instance.repo; const clock = requireClock(instance, "case 4");
    const now = clock.now(); const success = baseAt(now, "atomic-success"); await repo.createEnrollment(success); await repo.claimApproval(success.user_code, "success", 20);
    const done = await repo.commitApproval("success", commit); invariant(done.kind === "committed", "success fixture failed");
    invariant((await repo.getEnrollment(success.device_code))?.status === "approved", "commit lacks approved enrollment");
    invariant((await repo.listHistory(success.tenant, success.accountId)).some((x) => done.kind === "committed" && x.activationId === done.record.activationId), "commit lacks history activation");
    const active = await repo.register("tenant", "conflict", "A".repeat(43), null); invariant(active.ok, "conflict seed failed");
    const conflict = { ...baseAt(now, "atomic-conflict"), accountId: "conflict", agentPublicKey: "B".repeat(43) }; await repo.createEnrollment(conflict); await repo.claimApproval(conflict.user_code, "conflict", 20);
    const conflictBefore = await projection(repo, conflict);
    invariant((await repo.commitApproval("conflict", { ...commit, agentPublicKey: conflict.agentPublicKey })).kind === "conflict", "conflict missing");
    const conflictAfter = await projection(repo, conflict); invariant(same(conflictAfter.enrollment, transitionedEnrollment(conflictBefore.enrollment, "pending")), "conflict mutated enrollment beyond releasing its claim");
    invariant(same(conflictAfter.active, conflictBefore.active) && same(conflictAfter.history, conflictBefore.history), "conflict mutated registry/history");
    await repo.revokeActive("tenant", "conflict"); const revoked = { ...baseAt(now, "atomic-revoked"), accountId: "conflict" }; await repo.createEnrollment(revoked); await repo.claimApproval(revoked.user_code, "revoked", 20);
    const revokedBefore = await projection(repo, revoked);
    invariant((await repo.commitApproval("revoked", { ...commit, expect: active.ok ? active.record.activationId : null })).kind === "revoked", "revoked missing");
    const revokedAfter = await projection(repo, revoked); invariant(same(revokedAfter.enrollment, transitionedEnrollment(revokedBefore.enrollment, "pending")), "revoked mutated enrollment beyond releasing its claim");
    invariant(same(revokedAfter.active, revokedBefore.active) && same(revokedAfter.history, revokedBefore.history), "revoked mutated registry/history");
    const expired = { ...baseAt(now, "atomic-expired"), accountId: "expired", expiresAt: now + 1 }; await repo.createEnrollment(expired); await repo.claimApproval(expired.user_code, "expired", 20); await clock.advance(2);
    const expiredBefore = await projection(repo, expired); invariant((await repo.commitApproval("expired", commit)).kind === "expired", "expired outcome missing");
    const expiredAfter = await projection(repo, expired); invariant(same(expiredAfter.enrollment, transitionedEnrollment(expiredBefore.enrollment, "expired")), "expired commit mutated enrollment beyond its terminal transition");
    invariant(same(expiredAfter.active, expiredBefore.active) && same(expiredAfter.history, expiredBefore.history), "expired commit mutated registry/history");
    const fenced = { ...baseAt(clock.now(), "atomic-fenced"), accountId: "fenced" }; await repo.createEnrollment(fenced); await repo.claimApproval(fenced.user_code, "old-fenced", 1); await clock.advance(2);
    invariant((await repo.claimApproval(fenced.user_code, "new-fenced", 20)).kind === "claimed", "claim_lost fixture was not reclaimed");
    const fencedBefore = await projection(repo, fenced); invariant((await repo.commitApproval("old-fenced", commit)).kind === "claim_lost", "fenced owner did not lose claim");
    invariant(same(await projection(repo, fenced), fencedBefore), "claim_lost mutated a real claimed record or registry/history");
  } },
  { name: "5: commit registry precedence is tombstone then same-key then CAS", suite: "core", async run({ repo }) {
    const active = await repo.register("tenant", "same", "A".repeat(43), null); invariant(active.ok, "active seed failed");
    const item = { ...baseAt(10_000, "same"), accountId: "same" }; await repo.createEnrollment(item); await repo.claimApproval(item.user_code, "same", 20);
    const result = await repo.commitApproval("same", { ...commit, expect: "stale" }); invariant(result.kind === "committed" && active.ok && result.record.activationId === active.record.activationId, "same-key idempotency lost to CAS");
    await repo.revokeActive("tenant", "same"); const tomb = { ...baseAt(10_000, "tomb"), accountId: "same" }; await repo.createEnrollment(tomb); await repo.claimApproval(tomb.user_code, "tomb", 20);
    invariant((await repo.commitApproval("tomb", commit)).kind === "revoked", "tombstone did not take priority");
  } },
  { name: "6: deny matrix and deny/commit both orders", suite: "clock", async run(instance) {
    const repo = instance.repo; const clock = requireClock(instance, "case 6");
    const pending = baseAt(clock.now(), "deny-pending"); await repo.createEnrollment(pending); invariant(await repo.tryDeny(pending.user_code), "pending deny failed"); invariant(!(await repo.tryDeny(pending.user_code)), "denied was not terminal");
    const past = { ...baseAt(clock.now(), "deny-past"), expiresAt: clock.now() - 1 }; await repo.createEnrollment(past); invariant(!(await repo.tryDeny(past.user_code)), "past pending denied"); await status(repo, past.device_code, "expired");
    // Pause the nominal loser before it enters the repository. This proves both
    // serializations without relying on scheduler timing or Memory's await-free RMW.
    for (const commitFirst of [false, true]) {
      const suffix = commitFirst ? "commit-first" : "deny-first"; const item = { ...baseAt(clock.now(), suffix), accountId: suffix };
      await repo.createEnrollment(item); await repo.claimApproval(item.user_code, suffix, 20);
      const gate = barrier(); const delayedRepo = interpose(repo, commitFirst ? { tryDeny: { before: gate.wait } } : { commitApproval: { before: gate.wait } });
      const delayed = commitFirst ? delayedRepo.tryDeny(item.user_code) : delayedRepo.commitApproval(suffix, commit); await Promise.resolve();
      const first = commitFirst ? await repo.commitApproval(suffix, commit) : await repo.tryDeny(item.user_code); gate.resume(); const loser = await delayed;
      const final = await projection(repo, item);
      if (commitFirst) {
        const commitWinner = first as Awaited<ReturnType<EnrollmentRepository["commitApproval"]>>;
        invariant(commitWinner.kind === "committed" && loser === false, "commit-first did not make deny the exact loser");
        invariant(final.enrollment?.status === "approved" && same(final.enrollment.natsCreds, commit.creds) && final.enrollment.peerId === commit.peerId, "commit-first lost or changed credentials");
        invariant(final.active?.publicKey === commit.agentPublicKey && final.history.length === 1 && final.history[0]?.activationId === commitWinner.record.activationId, "commit-first terminal registry/history projection wrong");
      } else {
        invariant(first === true && (loser as Awaited<ReturnType<EnrollmentRepository["commitApproval"]>>).kind === "claim_lost", "deny-first did not fence commit");
        invariant(final.enrollment?.status === "denied" && !final.enrollment.natsCreds && final.active === null && final.history.length === 0, "deny-first leaked credentials or activation");
      }
    }
    const expired = { ...baseAt(clock.now(), "deny-expired"), expiresAt: clock.now() - 1 }; await repo.createEnrollment(expired); await repo.tryExpire(expired.device_code); invariant(!(await repo.tryDeny(expired.user_code)), "expired was denied");
  } },
  { name: "7: expire matrix returns the post-operation snapshot", suite: "clock", async run(instance) {
    const repo = instance.repo; const clock = requireClock(instance, "case 7");
    invariant(same(await repo.tryExpire("missing"), { transitioned: false, enrollment: null }), "missing expire shape wrong");
    const pending = { ...baseAt(clock.now(), "expire-pending"), expiresAt: clock.now() - 1 }; await repo.createEnrollment(pending); invariant((await repo.tryExpire(pending.device_code)).transitioned, "pending did not expire");
    const live = { ...baseAt(clock.now(), "expire-live"), expiresAt: clock.now() + 1 }; await repo.createEnrollment(live); await repo.claimApproval(live.user_code, "live", 10); await clock.advance(2);
    invariant((await repo.tryExpire(live.device_code)).enrollment?.status === "approving", "live lease expired"); await clock.advance(9); invariant((await repo.tryExpire(live.device_code)).enrollment?.status === "expired", "elapsed approving did not expire");
    const approved = { ...baseAt(clock.now(), "expire-approved"), accountId: "expire-approved" }; await repo.createEnrollment(approved); await repo.claimApproval(approved.user_code, "approved", 10); await repo.commitApproval("approved", commit); await clock.advance(100_000);
    const observed = await repo.tryExpire(approved.device_code); invariant(!observed.transitioned && observed.enrollment?.status === "approved" && same(observed.enrollment.natsCreds, commit.creds), "approved was expired or credentials lost");
  } },
  { name: "8: create is insert-only with portable named collision errors", suite: "core", async run({ repo }) {
    const first = baseAt(10_000, "collision"); await repo.createEnrollment(first);
    for (const [candidate, errorName] of [[{ ...baseAt(10_000, "other"), user_code: first.user_code }, "UserCodeCollisionError"], [{ ...first, user_code: "OTHER-CODE" }, "DeviceCodeCollisionError"]] as const) {
      try { await repo.createEnrollment(candidate); throw new Error(`${errorName} missing`); } catch (error) { invariant(error instanceof Error && error.name === errorName, `${errorName} not portable by name`); }
    }
    invariant((await repo.getEnrollment(first.device_code))?.user_code === first.user_code, "collision overwrote original");
  } },
  { name: "9: configured retention, equality polls, live leases, and sweep races", suite: "clock", async run(instance) {
    const repo = instance.repo; const clock = requireClock(instance, "case 9");
    const approved = { ...baseAt(clock.now(), "retained-approved"), expiresAt: clock.now() + 1, accountId: "retained-approved" }; await repo.createEnrollment(approved); await repo.claimApproval(approved.user_code, "retained", 10); await repo.commitApproval("retained", commit);
    await clock.advance(50); invariant(await repo.sweep() === 0, "configured retention evicted at equality");
    invariant((await repo.tryExpire(approved.device_code)).enrollment?.status === "approved", "equality poll lost approved credentials");
    invariant((await repo.commitApproval("retained", commit)).kind === "committed", "equality idempotent recovery failed"); await clock.advance(1);
    invariant(await repo.sweep() >= 1 && await repo.getEnrollment(approved.device_code) === null, "configured retention ignored after equality");
    invariant((await repo.commitApproval("retained", commit)).kind === "claim_lost", "evicted operation remained recoverable");
    for (const state of ["pending", "denied", "expired"] as const) {
      const item = { ...baseAt(clock.now(), `retain-${state}`), expiresAt: clock.now() + 5 }; await repo.createEnrollment(item);
      if (state === "denied") await repo.tryDeny(item.user_code); if (state === "expired") { await clock.advance(6); await repo.tryExpire(item.device_code); }
      const target = item.expiresAt + 50; await clock.advance(target - clock.now()); invariant(await repo.sweep() === 0, `${state} evicted at equality`); await clock.advance(1); invariant(await repo.sweep() >= 1, `${state} retained too long`);
    }
    const live = { ...baseAt(clock.now(), "sweep-live"), expiresAt: clock.now() + 1 }; await repo.createEnrollment(live); await repo.claimApproval(live.user_code, "sweep-live", 100); await clock.advance(52); invariant(await repo.sweep() === 0, "sweep removed live lease");
    // The retention boundary is expiresAt+retentionMs. A lease live through
    // that boundary protects the approving row, so either serialization must
    // preserve it long enough for an exact commit; a backend that sweeps first
    // despite the lease instead exposes claim_lost/expired, never silent loss.
    for (const sweepFirst of [true, false]) {
      const suffix = `sweep-race-${sweepFirst}`; const race = { ...baseAt(clock.now(), suffix), accountId: suffix, expiresAt: clock.now() + 1 };
      await repo.createEnrollment(race); await repo.claimApproval(race.user_code, suffix, 52); await clock.advance(51);
      const gate = barrier(); const delayedRepo = interpose(repo, sweepFirst ? { commitApproval: { before: gate.wait } } : { sweep: { before: gate.wait } });
      const delayed = sweepFirst ? delayedRepo.commitApproval(suffix, commit) : delayedRepo.sweep(); await Promise.resolve();
      const first = sweepFirst ? await repo.sweep() : await repo.commitApproval(suffix, commit); gate.resume(); const second = await delayed;
      const commitResult = (sweepFirst ? second : first) as Awaited<ReturnType<EnrollmentRepository["commitApproval"]>>;
      invariant(["committed", "claim_lost", "expired"].includes(commitResult.kind), `${suffix} returned an impossible commit outcome`);
      const final = await projection(repo, race);
      if (commitResult.kind === "committed") {
        invariant(final.enrollment?.status === "approved" && same(final.enrollment.natsCreds, commit.creds), `${suffix} committed without durable credentials`);
        invariant(final.active?.activationId === commitResult.record.activationId && final.history.some((x) => x.activationId === commitResult.record.activationId), `${suffix} committed without matching active/history`);
      } else {
        invariant(final.enrollment === null || final.enrollment.status === "expired", `${suffix} lost commit without an expired/evicted terminal row`);
        invariant(final.active === null && final.history.length === 0, `${suffix} failure silently activated registry/history`);
      }
    }
  } },
  { name: "10: reconciliation precedence and register races never resurrect", suite: "core", async run({ repo }) {
    invariant(same(await repo.reconcileApprovedRegistration("missing"), { kind: "noop", reason: "not_found" }), "not_found precedence wrong");
    const pending = baseAt(10_000, "reconcile-pending"); await repo.createEnrollment(pending); invariant((await repo.reconcileApprovedRegistration(pending.device_code)).kind === "noop", "non-approved reconciled");
    const legacy = { ...baseAt(10_000, "reconcile-legacy"), status: "approved" as const, natsCreds: commit.creds, peerId: commit.peerId, approvedAt: 10_000 }; await repo.createEnrollment(legacy);
    invariant((await repo.reconcileApprovedRegistration(legacy.device_code)).kind === "registered", "empty legacy slot not reconciled");
    invariant(same(await repo.reconcileApprovedRegistration(legacy.device_code), { kind: "noop", reason: "active_present" }), "combined active/history precedence wrong");
    await repo.revokeActive(legacy.tenant, legacy.accountId); invariant(same(await repo.reconcileApprovedRegistration(legacy.device_code), { kind: "noop", reason: "history_present" }), "tombstone resurrected");
    for (const reconcileFirst of [true, false]) {
      const accountId = `reconcile-race-${reconcileFirst}`; const item = { ...baseAt(10_000, accountId), accountId, status: "approved" as const, natsCreds: commit.creds, peerId: commit.peerId, approvedAt: 10_000 }; await repo.createEnrollment(item);
      const gate = barrier(); const delayedRepo = interpose(repo, reconcileFirst ? { register: { before: gate.wait } } : { reconcileApprovedRegistration: { before: gate.wait } });
      const delayed = reconcileFirst ? delayedRepo.register(item.tenant, accountId, "B".repeat(43), null) : delayedRepo.reconcileApprovedRegistration(item.device_code); await Promise.resolve();
      const first = reconcileFirst ? await repo.reconcileApprovedRegistration(item.device_code) : await repo.register(item.tenant, accountId, "B".repeat(43), null); gate.resume(); const loser = await delayed;
      const active = await repo.getActive(item.tenant, accountId); const history = await repo.listHistory(item.tenant, accountId);
      if (reconcileFirst) {
        const reconcileWinner = first as Awaited<ReturnType<EnrollmentRepository["reconcileApprovedRegistration"]>>;
        const registerLoser = loser as Awaited<ReturnType<EnrollmentRepository["register"]>>;
        invariant(reconcileWinner.kind === "registered" && !registerLoser.ok && registerLoser.reason === "conflict" && registerLoser.current?.activationId === reconcileWinner.record.activationId, "reconcile-first did not make register(expect=null) the exact conflict loser");
        invariant(active?.publicKey === item.agentPublicKey && active.activationId === reconcileWinner.record.activationId, "reconcile-first winner key identity changed");
      } else {
        const registerWinner = first as Awaited<ReturnType<EnrollmentRepository["register"]>>;
        invariant(registerWinner.ok && same(loser, { kind: "noop", reason: "active_present" }), "register-first did not force reconcile active_present noop");
        invariant(active?.publicKey === "B".repeat(43) && active.activationId === registerWinner.record.activationId, "register-first winner key identity changed");
      }
      invariant(history.length === 1 && history[0]?.status === "active" && history[0].activationId === active?.activationId, "race history was not append-only or resurrected a loser");
    }
  } },
  { name: "3/fault: committed response loss is recovered exactly", suite: "fault", async run(instance) {
    const now = 10_000; const base = baseAt(now, "fault"); const repo = interpose(instance.repo);
    await repo.createEnrollment(base); await repo.claimApproval(base.user_code, "op", 1_000); repo.throwAfterCommit({ times: 1 });
    try { await repo.commitApproval("op", commit); throw new Error("failpoint did not fire"); } catch (error) { invariant(error instanceof Error && error.message.includes("committed response lost"), "wrong failpoint error"); }
    const recovered = await repo.commitApproval("op", commit); invariant(recovered.kind === "committed" && recovered.idempotent, "ambiguous commit was not recovered");
  } },
];

export type EnrollmentRepositoryConformanceReport = { passed: string[]; skipped: string[] };

export async function runEnrollmentRepositoryConformance(options: EnrollmentRepositoryConformanceOptions): Promise<EnrollmentRepositoryConformanceReport> {
  const report: EnrollmentRepositoryConformanceReport = { passed: [], skipped: [] };
  for (const testCase of enrollmentRepositoryConformanceCases) {
    const instance = await options.create({ retentionMs: 50, autoSweep: false });
    try {
      if (testCase.suite === "clock" && !instance.clock) {
        const message = `EnrollmentRepository conformance: SKIP ${testCase.name} (optional controlled clock capability not provided)`;
        report.skipped.push(testCase.name); (options.reportSkip ?? console.warn)(message); continue;
      }
      await testCase.run(instance); report.passed.push(testCase.name);
    }
    catch (error) { throw new Error(`${testCase.name}: ${error instanceof Error ? error.message : String(error)}`, { cause: error }); }
    finally { await instance.close(); }
  }
  return report;
}
