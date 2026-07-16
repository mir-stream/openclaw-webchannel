import { describe, expect, it, vi } from "vitest";
import { createAccount } from "@nats-io/nkeys";
import { DeviceFlowEnrollment, MemoryEnrollmentStore, type EnrollmentStore } from "./device-flow-enrollment.js";
import { MemoryAgentKeyRegistry, type AgentKeyRegistry } from "./agent-key-registry.js";
import type { EnrollmentRequest, PendingEnrollment } from "./device-flow-types.js";

const KEY_A = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const KEY_B = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const KEY_C = "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";
const accountKp = createAccount();
const base = {
  saasTrustChain: {
    rsaPrivateKeyPem: "-----BEGIN PRIVATE KEY-----\nTEST\n-----END PRIVATE KEY-----",
    natsAccountSeed: new TextDecoder().decode(accountKp.getSeed()),
  },
  natsAccountConfig: { operatorJwt: "op", accountJwt: "acct", resolverConfig: {}, accountPublicKey: "pub" },
  saasBaseUrl: "https://saas.test",
  jwksUrl: "https://saas.test/jwks",
  bootstrapUrl: "https://saas.test/bootstrap",
  natsUrl: "wss://nats.test",
  expirationSeconds: 600,
  pollIntervalSeconds: 5,
};

const request = (key: string, accountId = "account"): EnrollmentRequest => ({ agentPublicKey: key, tenant: "tenant", accountId });
const service = (registry: AgentKeyRegistry, store: EnrollmentStore = new MemoryEnrollmentStore({ autoSweep: false })) =>
  new DeviceFlowEnrollment({ ...base, store, agentKeyRegistry: registry });

async function pending(svc: DeviceFlowEnrollment, key: string, accountId = "account") {
  return svc.enroll(request(key, accountId));
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

class ExpiryBarrierStore extends MemoryEnrollmentStore {
  readonly expiryReached = deferred();
  readonly releaseExpiry = deferred();
  pauseExpiry = true;

  override async updateEnrollment(code: string, updates: Partial<PendingEnrollment>) {
    if (updates.status === "expired" && this.pauseExpiry) {
      this.expiryReached.resolve();
      await this.releaseExpiry.promise;
    }
    return super.updateEnrollment(code, updates);
  }
}

describe("P1-1 approval state-machine integration", () => {
  it("9: requires a registry", () => {
    expect(() => new DeviceFlowEnrollment(base as ConstructorParameters<typeof DeviceFlowEnrollment>[0])).toThrow("agentKeyRegistry is required");
  });

  it("10-11: gates replacement before mint, then replaces only with the displayed activation", async () => {
    const registry = new MemoryAgentKeyRegistry();
    const svc = service(registry);
    const a = await pending(svc, KEY_A);
    expect((await svc.approve(a.user_code)).kind).toBe("approved");
    const b = await pending(svc, KEY_B);
    const mint = vi.spyOn(svc as never, "generateNatsUserCredentials" as never);
    const conflict = await svc.approve(b.user_code);
    expect(conflict.kind).toBe("conflict");
    expect(mint).not.toHaveBeenCalled();
    expect(await svc.poll({ device_code: b.device_code })).toMatchObject({ error: "authorization_pending" });
    if (conflict.kind !== "conflict" || !conflict.existing) throw new Error("expected occupied conflict");
    expect((await svc.approve(b.user_code, { replaceActivationId: conflict.existing.activationId })).kind).toBe("approved");
    expect((await registry.getActive("tenant", "account"))?.publicKey).toBe(KEY_B);
    expect((await registry.listHistory("tenant", "account"))[1].status).toBe("superseded");
  });

  it("12-13: rebinds confirmation after intervening replacement and rejects cycle replay", async () => {
    const registry = new MemoryAgentKeyRegistry();
    const svc = service(registry);
    const a = await pending(svc, KEY_A); await svc.approve(a.user_code);
    const b = await pending(svc, KEY_B);
    const first = await svc.approve(b.user_code); if (first.kind !== "conflict" || !first.existing) throw new Error();
    const c = await pending(svc, KEY_C);
    const cConflict = await svc.approve(c.user_code); if (cConflict.kind !== "conflict" || !cConflict.existing) throw new Error();
    await svc.approve(c.user_code, { replaceActivationId: cConflict.existing.activationId });
    const rebound = await svc.approve(b.user_code, { replaceActivationId: first.existing.activationId });
    expect(rebound.kind).toBe("conflict");
    if (rebound.kind === "conflict") expect(rebound.existing?.keyIdFingerprint).toBe((await registry.getActive("tenant", "account"))?.keyId.slice(0, 12));
    const activeC = await registry.getActive("tenant", "account");
    await registry.register("tenant", "account", KEY_A, activeC!.activationId);
    expect((await svc.approve(b.user_code, { replaceActivationId: first.existing.activationId })).kind).toBe("conflict");
  });

  it("12: accepts a stale confirmation when a competitor already activated the same incoming key", async () => {
    const registry = new MemoryAgentKeyRegistry();
    const svc = service(registry);
    const a = await pending(svc, KEY_A); await svc.approve(a.user_code);
    const b = await pending(svc, KEY_B);
    const conflict = await svc.approve(b.user_code); if (conflict.kind !== "conflict" || !conflict.existing) throw new Error();
    await registry.register("tenant", "account", KEY_B, conflict.existing.activationId);
    expect((await svc.approve(b.user_code, { replaceActivationId: conflict.existing.activationId })).kind).toBe("approved");
    expect(await registry.listHistory("tenant", "account")).toHaveLength(2);
  });

  it("14 and 25: concurrent different-key approvals across two issuer objects expose creds only to the CAS winner", async () => {
    const inner = new MemoryAgentKeyRegistry();
    let arrivals = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const registry: AgentKeyRegistry = {
      getActive: (...a) => inner.getActive(...a), listHistory: (...a) => inner.listHistory(...a), revokeActive: (...a) => inner.revokeActive(...a),
      async register(...args) { arrivals += 1; if (arrivals === 2) release(); await barrier; return inner.register(...args); },
    };
    const storeA = new MemoryEnrollmentStore({ autoSweep: false });
    const storeB = new MemoryEnrollmentStore({ autoSweep: false });
    const aSvc = service(registry, storeA);
    const bSvc = service(registry, storeB);
    const a = await pending(aSvc, KEY_A);
    const b = await pending(bSvc, KEY_B);
    const outcomes = await Promise.all([aSvc.approve(a.user_code), bSvc.approve(b.user_code)]);
    expect(arrivals).toBe(2); // both minted and reached CAS; ordering is injected, not scheduler luck
    expect(outcomes.filter((o) => o.kind === "approved")).toHaveLength(1);
    expect(outcomes.filter((o) => o.kind === "conflict")).toHaveLength(1);
    const polls = await Promise.all([aSvc.poll({ device_code: a.device_code }), bSvc.poll({ device_code: b.device_code })]);
    expect(polls.filter((p) => "creds" in p)).toHaveLength(1);
    expect(polls.filter((p) => "error" in p && p.error === "authorization_pending")).toHaveLength(1);
  });

  it("15: mint failure changes neither store nor registry and retry recovers", async () => {
    const registry = new MemoryAgentKeyRegistry();
    const store = new MemoryEnrollmentStore({ autoSweep: false });
    const svc = service(registry, store);
    const started = await pending(svc, KEY_A);
    const original = (svc as any).generateNatsUserCredentials.bind(svc);
    (svc as any).generateNatsUserCredentials = vi.fn().mockRejectedValueOnce(new Error("mint failed")).mockImplementation(original);
    await expect(svc.approve(started.user_code)).rejects.toThrow("mint failed");
    expect(await registry.listHistory("tenant", "account")).toEqual([]);
    expect((await store.getEnrollment(started.device_code))?.status).toBe("pending");
    expect((await svc.approve(started.user_code)).kind).toBe("approved");
  });

  it("16(i): eviction between register and store verification is reported rejected", async () => {
    class EvictOnUpdateStore extends MemoryEnrollmentStore {
      override async updateEnrollment(code: string, updates: Partial<PendingEnrollment>) {
        if (updates.status === "approved") await this.deleteEnrollment(code);
        return super.updateEnrollment(code, updates); // intentional silent no-op
      }
    }
    const registry = new MemoryAgentKeyRegistry();
    const svc = service(registry, new EvictOnUpdateStore({ autoSweep: false }));
    const started = await pending(svc, KEY_A);
    expect((await svc.approve(started.user_code)).kind).toBe("rejected");
    expect((await registry.getActive("tenant", "account"))?.publicKey).toBe(KEY_A);
  });

  it("16(ii): eviction immediately after verification leaves a recoverable same-key activation", async () => {
    class EvictAfterVerifyStore extends MemoryEnrollmentStore {
      approved = false;
      override async updateEnrollment(code: string, updates: Partial<PendingEnrollment>) { await super.updateEnrollment(code, updates); if (updates.status === "approved") this.approved = true; }
      override async getEnrollment(code: string) {
        const record = await super.getEnrollment(code);
        if (this.approved && record?.status === "approved") { this.approved = false; await this.deleteEnrollment(code); }
        return record;
      }
    }
    const registry = new MemoryAgentKeyRegistry();
    const svc = service(registry, new EvictAfterVerifyStore({ autoSweep: false }));
    const started = await pending(svc, KEY_A);
    expect((await svc.approve(started.user_code)).kind).toBe("approved");
    expect(await svc.poll({ device_code: started.device_code })).toMatchObject({ error: "invalid_device_code" });
    const reenroll = await pending(svc, KEY_A);
    expect((await svc.approve(reenroll.user_code)).kind).toBe("approved");
    expect(await registry.listHistory("tenant", "account")).toHaveLength(1);
  });

  it("17-18: reconciles only a provably empty registry and never resurrects revoked history", async () => {
    const store = new MemoryEnrollmentStore({ autoSweep: false });
    const originalRegistry = new MemoryAgentKeyRegistry();
    const first = service(originalRegistry, store);
    const started = await pending(first, KEY_A); await first.approve(started.user_code);
    const emptyRegistry = new MemoryAgentKeyRegistry();
    expect((await service(emptyRegistry, store).approve(started.user_code)).kind).toBe("approved");
    expect((await emptyRegistry.getActive("tenant", "account"))?.publicKey).toBe(KEY_A);
    await emptyRegistry.revokeActive("tenant", "account");
    expect((await service(emptyRegistry, store).approve(started.user_code)).kind).toBe("approved");
    expect(await emptyRegistry.getActive("tenant", "account")).toBeNull();
    const retrySvc = service(emptyRegistry);
    const retry = await pending(retrySvc, KEY_A);
    expect((await retrySvc.approve(retry.user_code)).kind).toBe("revoked_key");
  });

  it("17: reconciles legacy approved-without-registration but leaves a different active key untouched", async () => {
    const legacyStore = new MemoryEnrollmentStore({ autoSweep: false });
    const legacy: PendingEnrollment = {
      device_code: "legacy-device",
      user_code: "LEGACY-CODE",
      agentPublicKey: KEY_A,
      accountId: "account",
      tenant: "tenant",
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      status: "approved",
      natsCreds: { userJwt: "legacy-jwt", userSeed: "legacy-seed", userPubkey: "legacy-pubkey" },
      peerId: "legacy-peer",
    };
    await legacyStore.saveEnrollment(legacy);
    const empty = new MemoryAgentKeyRegistry();
    expect((await service(empty, legacyStore).approve(legacy.user_code)).kind).toBe("approved");
    expect((await empty.getActive("tenant", "account"))?.publicKey).toBe(KEY_A);

    const other = new MemoryAgentKeyRegistry();
    await other.register("tenant", "account", KEY_B, null);
    expect((await service(other, legacyStore).approve(legacy.user_code)).kind).toBe("approved");
    expect((await other.getActive("tenant", "account"))?.publicKey).toBe(KEY_B);
    expect(await other.listHistory("tenant", "account")).toHaveLength(1);
  });

  it("20: revoke between register and store produces approved creds with no served pin", async () => {
    const inner = new MemoryAgentKeyRegistry();
    const registry: AgentKeyRegistry = {
      getActive: (...a) => inner.getActive(...a), listHistory: (...a) => inner.listHistory(...a), revokeActive: (...a) => inner.revokeActive(...a),
      async register(...args) { const result = await inner.register(...args); if (result.ok) await inner.revokeActive(args[0], args[1]); return result; },
    };
    const svc = service(registry);
    const started = await pending(svc, KEY_A);
    expect((await svc.approve(started.user_code)).kind).toBe("approved");
    expect(await registry.getActive("tenant", "account")).toBeNull();
    expect(await svc.poll({ device_code: started.device_code })).toHaveProperty("creds");
  });

  it("19: a real poll expiry write before register leaves the key absent and credentials undisclosed", async () => {
    const registry = new MemoryAgentKeyRegistry();
    const store = new ExpiryBarrierStore({ autoSweep: false });
    const svc = service(registry, store);
    const expiring = await pending(svc, KEY_A);
    await store.updateEnrollment(expiring.device_code, { expiresAt: 0 });
    const poll = svc.poll({ device_code: expiring.device_code });
    await store.expiryReached.promise;
    store.releaseExpiry.resolve();
    expect(await poll).toMatchObject({ error: "expired_token" });
    expect((await svc.approve(expiring.user_code)).kind).toBe("rejected");
    expect(await registry.listHistory("tenant", "account")).toEqual([]);
    expect(await svc.poll({ device_code: expiring.device_code })).not.toHaveProperty("creds");
  });

  it("19: real poll expiry between register and store-approved leaves an active recoverable key but no credentials", async () => {
    const registry = new MemoryAgentKeyRegistry();
    const store = new ExpiryBarrierStore({ autoSweep: false });
    store.pauseExpiry = false;
    const registered = deferred();
    const releaseRegister = deferred();
    const gated: AgentKeyRegistry = {
      getActive: (...a) => registry.getActive(...a), listHistory: (...a) => registry.listHistory(...a), revokeActive: (...a) => registry.revokeActive(...a),
      async register(...args) { const result = await registry.register(...args); registered.resolve(); await releaseRegister.promise; return result; },
    };
    let now = 1;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    const svc = service(gated, store);
    const first = await pending(svc, KEY_A);
    const approving = svc.approve(first.user_code);
    await registered.promise;
    now = 1_000_000;
    expect(await svc.poll({ device_code: first.device_code })).toMatchObject({ error: "expired_token" });
    releaseRegister.resolve();
    expect(["approved", "rejected"]).toContain((await approving).kind);
    expect((await registry.getActive("tenant", "account"))?.publicKey).toBe(KEY_A);
    expect(await svc.poll({ device_code: first.device_code })).not.toHaveProperty("creds");
    clock.mockRestore();
    const recoverySvc = service(registry);
    const retry = await pending(recoverySvc, KEY_A);
    expect((await recoverySvc.approve(retry.user_code)).kind).toBe("approved");
    expect(await registry.listHistory("tenant", "account")).toHaveLength(1);
  });

  it("19: real poll expiry write after store-approved loses conditionally and discloses no credentials to that poll", async () => {
    const registry = new MemoryAgentKeyRegistry();
    const store = new ExpiryBarrierStore({ autoSweep: false });
    let now = 1;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    const svc = service(registry, store);
    const first = await pending(svc, KEY_A);
    now = 1_000_000;
    const poll = svc.poll({ device_code: first.device_code });
    await store.expiryReached.promise;
    now = 1;
    expect((await svc.approve(first.user_code)).kind).toBe("approved");
    store.releaseExpiry.resolve();
    expect(await poll).toMatchObject({ error: "expired_token" });
    expect((await registry.getActive("tenant", "account"))?.publicKey).toBe(KEY_A);
    expect(await svc.poll({ device_code: first.device_code })).not.toHaveProperty("creds");
    clock.mockRestore();
    const recovery = service(registry);
    const retry = await pending(recovery, KEY_A);
    expect((await recovery.approve(retry.user_code)).kind).toBe("approved");
  });

  it("19: real concurrent polls in two- and three-userCode replacement sequences preserve active/superseded/revoked classes", async () => {
    const registry = new MemoryAgentKeyRegistry();
    const store = new ExpiryBarrierStore({ autoSweep: false });
    store.pauseExpiry = false;
    const svc = service(registry, store);
    const a = await pending(svc, KEY_A);
    expect((await svc.approve(a.user_code)).kind).toBe("approved");
    const b = await pending(svc, KEY_B);
    const c = await pending(svc, KEY_C);
    const bc = await svc.approve(b.user_code);
    const cc = await svc.approve(c.user_code);
    expect(bc.kind).toBe("conflict");
    expect(cc.kind).toBe("conflict");
    await store.updateEnrollment(b.device_code, { expiresAt: 0 });
    await store.updateEnrollment(c.device_code, { expiresAt: 0 });
    const [bp, cp] = await Promise.all([
      svc.poll({ device_code: b.device_code }),
      svc.poll({ device_code: c.device_code }),
    ]);
    expect(bp).toMatchObject({ error: "expired_token" });
    expect(cp).toMatchObject({ error: "expired_token" });
    if (bc.kind !== "conflict" || !bc.existing || cc.kind !== "conflict" || !cc.existing) throw new Error("missing conflicts");
    expect((await svc.approve(b.user_code, { replaceActivationId: bc.existing.activationId })).kind).toBe("rejected");
    expect((await svc.approve(c.user_code, { replaceActivationId: cc.existing.activationId })).kind).toBe("rejected");
    expect((await registry.getActive("tenant", "account"))?.publicKey).toBe(KEY_A);
    expect((await registry.listHistory("tenant", "account")).map((r) => r.status)).toEqual(["active"]);
    expect(await registry.revokeActive("tenant", "account")).toBe(true);
    expect((await registry.listHistory("tenant", "account")).map((r) => r.status)).toEqual(["revoked"]);
    expect(bp).not.toHaveProperty("creds");
    expect(cp).not.toHaveProperty("creds");
  });

  it("19: CAS defeat followed by expiry leaves the losing incoming key absent and undisclosed", async () => {
    const inner = new MemoryAgentKeyRegistry();
    const first = await inner.register("tenant", "account", KEY_A, null); if (!first.ok) throw new Error();
    const store = new MemoryEnrollmentStore({ autoSweep: false });
    let losingCode = "";
    const registry: AgentKeyRegistry = {
      getActive: (...a) => inner.getActive(...a), listHistory: (...a) => inner.listHistory(...a), revokeActive: (...a) => inner.revokeActive(...a),
      async register(...args) {
        const active = await inner.getActive(args[0], args[1]);
        await inner.register(args[0], args[1], KEY_C, active!.activationId);
        if (losingCode) await store.updateEnrollment(losingCode, { status: "expired" });
        return inner.register(...args);
      },
    };
    const svc = service(registry, store);
    const losing = await pending(svc, KEY_B); losingCode = losing.device_code;
    const outcome = await svc.approve(losing.user_code, { replaceActivationId: first.record.activationId });
    expect(outcome.kind).toBe("conflict");
    expect((await store.getEnrollment(losing.device_code))?.status).toBe("expired");
    expect((await inner.listHistory("tenant", "account")).some((r) => r.publicKey === KEY_B)).toBe(false);
    expect(await svc.poll({ device_code: losing.device_code })).not.toHaveProperty("creds");
  });

  it("21-22: accountId is mandatory and literal default is an ordinary isolated account", async () => {
    const registry = new MemoryAgentKeyRegistry();
    const svc = service(registry);
    await expect(svc.enroll({ agentPublicKey: KEY_A, tenant: "tenant" } as EnrollmentRequest)).rejects.toThrow("accountId");
    const d = await pending(svc, KEY_A, "default"); await svc.approve(d.user_code);
    expect((await registry.getActive("tenant", "default"))?.publicKey).toBe(KEY_A);
    expect(await registry.getActive("tenant", "other")).toBeNull();
  });

  it("23: replace-revoke-register history remains newest-first and tombstoned", async () => {
    const r = new MemoryAgentKeyRegistry();
    const a = await r.register("t", "a", KEY_A, null); if (!a.ok) throw new Error();
    const b = await r.register("t", "a", KEY_B, a.record.activationId); if (!b.ok) throw new Error();
    await r.revokeActive("t", "a");
    await r.register("t", "a", KEY_C, null);
    expect((await r.listHistory("t", "a")).map((x) => [x.publicKey, x.status])).toEqual([[KEY_C, "active"], [KEY_B, "revoked"], [KEY_A, "superseded"]]);
  });

  it("31: enrollment request/response and poll result wire shapes remain unchanged", async () => {
    const svc = service(new MemoryAgentKeyRegistry());
    const started = await pending(svc, KEY_A);
    expect(Object.keys(started).sort()).toEqual(["device_code", "expires_in", "interval", "user_code", "verification_uri", "verification_uri_complete"]);
    expect((await svc.approve(started.user_code)).kind).toBe("approved");
    const polled = await svc.poll({ device_code: started.device_code });
    expect(Object.keys(polled).sort()).toEqual(["bootstrapUrl", "creds", "issuer", "jwksUrl", "natsUrl", "peerId"]);
    expect(polled).not.toHaveProperty("agentId");
  });
});
