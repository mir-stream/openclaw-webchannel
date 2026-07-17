import { createHash, randomBytes } from "node:crypto";
import type { EnrollmentRecord, NatsUserCredentials } from "./device-flow-types.js";
import {
  agentKeyRegistryKey,
  type ActivationId,
  type AgentKeyRecord,
  type AgentKeyRegistry,
  type RegisterAgentKeyResult,
} from "./agent-key-registry.js";

export class UserCodeCollisionError extends Error {
  constructor(userCode: string) { super(`webchannel: user_code collision: ${userCode}`); this.name = "UserCodeCollisionError"; }
}
export class DeviceCodeCollisionError extends Error {
  constructor(deviceCode: string) { super(`webchannel: device_code collision: ${deviceCode}`); this.name = "DeviceCodeCollisionError"; }
}
export class CommitPayloadMismatchError extends Error {
  constructor(message = "webchannel: commit payload does not match the claimed enrollment or committed operation") {
    super(message); this.name = "CommitPayloadMismatchError";
  }
}

export type ClaimApprovalOutcome =
  | { kind: "claimed"; enrollment: EnrollmentRecord }
  | { kind: "already_approved"; enrollment: EnrollmentRecord }
  | { kind: "in_progress"; leaseUntil: number }
  | { kind: "denied" } | { kind: "expired" } | { kind: "not_found" };
export type CommitApprovalPayload = { creds: NatsUserCredentials; peerId: string; agentPublicKey: string; expect: ActivationId | null };
export type CommitApprovalOutcome =
  | { kind: "committed"; record: AgentKeyRecord; idempotent: boolean }
  | { kind: "claim_lost" } | { kind: "expired" }
  | { kind: "conflict"; current: AgentKeyRecord | null } | { kind: "revoked" };
export type TryExpireOutcome = { transitioned: boolean; enrollment: EnrollmentRecord | null };
export type ReconcileOutcome =
  | { kind: "registered"; record: AgentKeyRecord }
  | { kind: "noop"; reason: "not_found" | "not_approved" | "active_present" | "history_present" };

/**
 * One durability and serialization boundary for enrollment and key activation.
 * Implementations own the authoritative monotonic clock used for all decisions.
 */
export interface EnrollmentRepository extends AgentKeyRegistry {
  createEnrollment(enrollment: EnrollmentRecord): Promise<void>;
  getEnrollment(deviceCode: string): Promise<EnrollmentRecord | null>;
  getEnrollmentByUserCode(userCode: string): Promise<EnrollmentRecord | null>;
  claimApproval(userCode: string, opId: string, leaseMs: number): Promise<ClaimApprovalOutcome>;
  commitApproval(opId: string, commit: CommitApprovalPayload): Promise<CommitApprovalOutcome>;
  releaseClaim(opId: string): Promise<boolean>;
  tryDeny(userCode: string): Promise<boolean>;
  tryExpire(deviceCode: string): Promise<TryExpireOutcome>;
  reconcileApprovedRegistration(deviceCode: string): Promise<ReconcileOutcome>;
  sweep(): Promise<number>;
}

export type MemoryEnrollmentRepositoryOptions = {
  clock?: () => number;
  autoSweep?: boolean;
  retentionMs?: number;
  sweepIntervalMs?: number;
};
const DEFAULT_RETENTION_MS = 300_000;
const DEFAULT_SWEEP_INTERVAL_MS = 60_000;
const cloneRecord = (record: AgentKeyRecord): AgentKeyRecord => ({ ...record });
const cloneCreds = (creds: NonNullable<EnrollmentRecord["natsCreds"]>): NonNullable<EnrollmentRecord["natsCreds"]> => ({
  ...creds,
  ...(creds.permissions ? { permissions: { ...creds.permissions, pub: creds.permissions.pub?.slice(), sub: creds.permissions.sub?.slice() } } : {}),
});
const cloneEnrollment = (record: EnrollmentRecord): EnrollmentRecord => ({
  ...record,
  ...(record.claim ? { claim: { ...record.claim } } : {}),
  ...(record.natsCreds ? { natsCreds: cloneCreds(record.natsCreds) } : {}),
  ...(record.committedRecord ? { committedRecord: cloneRecord(record.committedRecord) } : {}),
});
const keyId = (publicKey: string): string => createHash("sha256").update(Buffer.from(publicKey, "base64url")).digest("base64url");
// The digest binds an idempotency key to the *whole* logical commit.  In
// particular, `expect` is not merely a transient CAS input: accepting a retry
// with a different expectation would turn one opId into a second operation.
// Spell out the canonical field order instead of hashing the caller's object so
// property insertion order and extra implementation-private fields cannot alter
// the durable identity of an otherwise identical request.
const digest = (payload: CommitApprovalPayload): string => createHash("sha256").update(JSON.stringify({
  agentPublicKey: payload.agentPublicKey,
  peerId: payload.peerId,
  creds: { userJwt: payload.creds.userJwt, userSeed: payload.creds.userSeed, userPubkey: payload.creds.userPubkey,
    permissions: payload.creds.permissions ? { pub: payload.creds.permissions.pub ?? null, sub: payload.creds.permissions.sub ?? null } : null },
  expect: payload.expect,
})).digest("hex");

/** Single-process reference: every transition is an await-free synchronous RMW. */
export class MemoryEnrollmentRepository implements EnrollmentRepository {
  private readonly enrollments = new Map<string, EnrollmentRecord>();
  private readonly userCodes = new Map<string, string>();
  private readonly histories = new Map<string, AgentKeyRecord[]>();
  private readonly clock: () => number;
  private readonly retentionMs: number;
  private readonly sweepIntervalMs: number;
  private sweepTimer?: ReturnType<typeof setInterval>;

  constructor(options: MemoryEnrollmentRepositoryOptions = {}) {
    this.clock = options.clock ?? Date.now;
    this.retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS;
    this.sweepIntervalMs = options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    if (options.autoSweep !== false) this.startSweeper();
  }
  startSweeper(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => { void this.sweep(); }, this.sweepIntervalMs);
    this.sweepTimer.unref?.();
  }
  close(): void { if (this.sweepTimer) clearInterval(this.sweepTimer); this.sweepTimer = undefined; }

  async createEnrollment(enrollment: EnrollmentRecord): Promise<void> {
    if (this.enrollments.has(enrollment.device_code)) throw new DeviceCodeCollisionError(enrollment.device_code);
    const owner = this.userCodes.get(enrollment.user_code);
    if (owner && this.enrollments.has(owner)) throw new UserCodeCollisionError(enrollment.user_code);
    const stored = cloneEnrollment(enrollment);
    this.enrollments.set(stored.device_code, stored); this.userCodes.set(stored.user_code, stored.device_code);
  }
  async getEnrollment(deviceCode: string): Promise<EnrollmentRecord | null> {
    const value = this.enrollments.get(deviceCode); return value ? cloneEnrollment(value) : null;
  }
  async getEnrollmentByUserCode(userCode: string): Promise<EnrollmentRecord | null> {
    const code = this.userCodes.get(userCode); return code ? this.getEnrollment(code) : null;
  }
  async claimApproval(userCode: string, opId: string, leaseMs: number): Promise<ClaimApprovalOutcome> {
    const code = this.userCodes.get(userCode); const record = code ? this.enrollments.get(code) : undefined;
    if (!record) return { kind: "not_found" };
    // opId is the transaction's idempotency identity, so it may never name two
    // enrollments. Quietly attaching it to a second record would make a later
    // commit depend on map iteration order and could recover the wrong payload.
    const reused = [...this.enrollments.values()].find((candidate) =>
      candidate.device_code !== record.device_code &&
      (candidate.claim?.opId === opId || candidate.committedBy === opId));
    if (reused) throw new CommitPayloadMismatchError("webchannel: approval opId reused for another enrollment");
    // This order is the contract's decision table, not a cosmetic collection of
    // guards.  Terminal approval wins over the request deadline because its
    // committed credentials remain recoverable for the retention horizon.  A
    // live owner likewise wins over expiresAt: another replica may observe the
    // operation, but must not terminate it while its lease is still fenced in.
    if (record.status === "approved") return { kind: "already_approved", enrollment: cloneEnrollment(record) };
    if (record.status === "denied") return { kind: "denied" };
    if (record.status === "expired") return { kind: "expired" };
    const now = this.clock();
    if (record.status === "pending" && now > record.expiresAt) { record.status = "expired"; return { kind: "expired" }; }
    if (record.status === "approving" && record.claim && now <= record.claim.leaseUntil) return { kind: "in_progress", leaseUntil: record.claim.leaseUntil };
    if (record.status === "approving" && now > record.expiresAt) { record.status = "expired"; delete record.claim; return { kind: "expired" }; }
    record.status = "approving"; record.claim = { opId, leaseUntil: now + leaseMs };
    return { kind: "claimed", enrollment: cloneEnrollment(record) };
  }
  private registerSync(tenant: string, accountId: string, publicKey: string, expect: ActivationId | null): RegisterAgentKeyResult {
    const slot = agentKeyRegistryKey(tenant, accountId); const history = this.histories.get(slot) ?? [];
    const incoming = keyId(publicKey);
    if (history.some((r) => r.status === "revoked" && r.keyId === incoming)) return { ok: false, reason: "revoked" };
    const index = history.findIndex((r) => r.status === "active"); const active = index < 0 ? undefined : history[index];
    if (active?.publicKey === publicKey) return { ok: true, record: cloneRecord(active), idempotent: true };
    if ((expect === null && active) || (expect !== null && active?.activationId !== expect)) return { ok: false, reason: "conflict", current: active ? cloneRecord(active) : null };
    const now = this.clock(); const activationId = randomBytes(16).toString("base64url");
    const record: AgentKeyRecord = { tenant, accountId, publicKey, keyId: incoming, activationId, status: "active", enrolledAt: now };
    const next = history.map((r, i) => i === index ? { ...r, status: "superseded" as const, endedAt: now, supersededBy: activationId } : r);
    next.unshift(record); this.histories.set(slot, next); return { ok: true, record: cloneRecord(record), idempotent: false };
  }
  async commitApproval(opId: string, commit: CommitApprovalPayload): Promise<CommitApprovalOutcome> {
    const record = [...this.enrollments.values()].find((r) => r.claim?.opId === opId || (r.status === "approved" && r.committedBy === opId));
    const commitDigest = digest(commit);
    // Recovery deliberately precedes the lease fence.  Once the transaction is
    // durable, a lost response may be retried after the lease; committedBy plus
    // commitDigest proves it is recovery, not a stale writer. committedRecord is
    // the immutable result snapshot—consulting today's active slot would return
    // the wrong activation after a later supersede or revoke.
    if (record?.status === "approved" && record.committedBy === opId) {
      if (record.commitDigest !== commitDigest || !record.committedRecord) throw new CommitPayloadMismatchError();
      return { kind: "committed", record: cloneRecord(record.committedRecord), idempotent: true };
    }
    const now = this.clock();
    // The lease itself is the fencing token. Equality remains owned (`<=` in
    // positive form); the first instant strictly after leaseUntil is rejected
    // even if nobody has reclaimed yet. This closes the classic expired-owner
    // write window rather than relying on a newer claimant to create a fence.
    if (!record || record.status !== "approving" || record.claim?.opId !== opId || now > record.claim.leaseUntil) return { kind: "claim_lost" };
    if (now > record.expiresAt) { record.status = "expired"; delete record.claim; return { kind: "expired" }; }
    if (commit.agentPublicKey !== record.agentPublicKey) throw new CommitPayloadMismatchError("webchannel: commit agentPublicKey differs from enrollment");
    // registerSync and the enrollment mutation contain no await and share this
    // repository's serialization boundary. Durable adapters must implement the
    // same region as one transaction: neither an activation without approved
    // credentials nor approved credentials without history may become visible.
    const registered = this.registerSync(record.tenant, record.accountId, commit.agentPublicKey, commit.expect);
    if (!registered.ok) {
      record.status = "pending"; delete record.claim;
      return registered.reason === "revoked" ? { kind: "revoked" } : { kind: "conflict", current: registered.current };
    }
    // Deep-clone on the way IN, not just on the way out: a shallow spread left
    // the nested permissions arrays aliased to the caller-retained payload, so
    // a caller mutating minted creds after commit would silently corrupt the
    // durable record while commitDigest still matched the original bytes —
    // making the record fail its own idempotent-recovery digest later.
    record.status = "approved"; record.natsCreds = cloneCreds(commit.creds); record.peerId = commit.peerId;
    record.approvedAt = now; record.committedBy = opId; record.commitDigest = commitDigest;
    record.committedRecord = cloneRecord(registered.record); delete record.claim;
    return { kind: "committed", record: cloneRecord(registered.record), idempotent: false };
  }
  async releaseClaim(opId: string): Promise<boolean> {
    const record = [...this.enrollments.values()].find((r) => r.status === "approving" && r.claim?.opId === opId);
    if (!record) return false; record.status = "pending"; delete record.claim; return true;
  }
  async tryDeny(userCode: string): Promise<boolean> {
    const code = this.userCodes.get(userCode); const record = code ? this.enrollments.get(code) : undefined;
    if (!record || (record.status !== "pending" && record.status !== "approving")) return false;
    if (this.clock() > record.expiresAt) { record.status = "expired"; delete record.claim; return false; }
    record.status = "denied"; delete record.claim; return true;
  }
  async tryExpire(deviceCode: string): Promise<TryExpireOutcome> {
    const record = this.enrollments.get(deviceCode); if (!record) return { transitioned: false, enrollment: null };
    const now = this.clock(); let transitioned = false;
    if (record.status === "pending" && now > record.expiresAt) { record.status = "expired"; transitioned = true; }
    else if (record.status === "approving" && record.claim && now > record.claim.leaseUntil && now > record.expiresAt) { record.status = "expired"; delete record.claim; transitioned = true; }
    return { transitioned, enrollment: cloneEnrollment(record) };
  }
  async reconcileApprovedRegistration(deviceCode: string): Promise<ReconcileOutcome> {
    const enrollment = this.enrollments.get(deviceCode);
    if (!enrollment) return { kind: "noop", reason: "not_found" };
    if (enrollment.status !== "approved") return { kind: "noop", reason: "not_approved" };
    const history = this.histories.get(agentKeyRegistryKey(enrollment.tenant, enrollment.accountId)) ?? [];
    if (history.some((r) => r.status === "active")) return { kind: "noop", reason: "active_present" };
    if (history.length) return { kind: "noop", reason: "history_present" };
    const result = this.registerSync(enrollment.tenant, enrollment.accountId, enrollment.agentPublicKey, null);
    if (!result.ok) throw new Error("webchannel: impossible reconciliation registry result");
    return { kind: "registered", record: result.record };
  }
  async sweep(): Promise<number> {
    const now = this.clock(); let removed = 0;
    for (const [code, record] of this.enrollments) {
      if (record.status === "approving" && record.claim && now <= record.claim.leaseUntil) continue;
      // Approval retention starts at approvedAt, not expiresAt: a commit at the
      // edge still receives the full ambiguity-recovery horizon. All other
      // states age from expiresAt. The strict `>` is intentional—at equality the
      // record, credentials, and idempotent result are still contractually live.
      const base = record.status === "approved" ? record.approvedAt : record.expiresAt;
      if (base !== undefined && now > base + this.retentionMs) { this.enrollments.delete(code); this.userCodes.delete(record.user_code); removed++; }
    }
    return removed;
  }
  async getActive(tenant: string, accountId: string): Promise<AgentKeyRecord | null> {
    const active = (this.histories.get(agentKeyRegistryKey(tenant, accountId)) ?? []).find((r) => r.status === "active"); return active ? cloneRecord(active) : null;
  }
  async register(tenant: string, accountId: string, publicKey: string, expect: ActivationId | null): Promise<RegisterAgentKeyResult> { return this.registerSync(tenant, accountId, publicKey, expect); }
  async revokeActive(tenant: string, accountId: string): Promise<boolean> {
    const slot = agentKeyRegistryKey(tenant, accountId); const history = this.histories.get(slot); const index = history?.findIndex((r) => r.status === "active") ?? -1;
    if (!history || index < 0) return false; const now = this.clock(); this.histories.set(slot, history.map((r, i) => i === index ? { ...r, status: "revoked" as const, endedAt: now } : r)); return true;
  }
  async listHistory(tenant: string, accountId: string): Promise<AgentKeyRecord[]> { return (this.histories.get(agentKeyRegistryKey(tenant, accountId)) ?? []).map(cloneRecord); }
}
