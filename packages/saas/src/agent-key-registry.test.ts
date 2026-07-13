/**
 * F2 — agent identity-key registry tests + the DeviceFlowEnrollment approval
 * integration that populates it.
 *
 * Covers the SaaS completion criteria:
 *  - the registry persists (tenant, accountId) → agentPublicKey across the
 *    pending-enrollment store's eviction (the whole reason it exists);
 *  - enrollment APPROVAL upserts the attested key (re-enroll mints a fresh key →
 *    the registry reflects the latest);
 *  - keying is per-account: distinct accounts get distinct keys, and an
 *    accountId-less enrollment falls back to the default segment WITHOUT
 *    colliding with a named account.
 */

import { describe, it, expect } from "vitest";
import { createAccount } from "@nats-io/nkeys";
import {
  DeviceFlowEnrollment,
  MemoryEnrollmentStore,
} from "./device-flow-enrollment.js";
import {
  MemoryAgentKeyRegistry,
  agentKeyRegistryKey,
  DEFAULT_REGISTRY_ACCOUNT_ID,
} from "./agent-key-registry.js";
import type { SaasTrustChainPrivate, NatsAccountConfig } from "./types.js";
import type { EnrollmentRequest } from "./device-flow-types.js";

const mockAccountKp = createAccount();
const mockTrustChain: SaasTrustChainPrivate = {
  rsaPrivateKeyPem: "-----BEGIN PRIVATE KEY-----\nMOCK\n-----END PRIVATE KEY-----",
  natsAccountSeed: new TextDecoder().decode(mockAccountKp.getSeed()),
};
const mockNatsConfig: NatsAccountConfig = {
  operatorJwt: "MOCK_OPERATOR_JWT",
  accountJwt: "MOCK_ACCOUNT_JWT",
  resolverConfig: {},
  accountPublicKey: "MOCK_ACCOUNT_PUBLIC_KEY",
};

// Two distinct 43-char base64url X25519 public keys (the wire format enroll()
// enforces). Used to prove re-enroll upserts to the NEW key.
const AGENT_KEY_A = "EpK8GJc3BntN3yEwx5GtfQFyIilwIXaKsrWiqYNkzSo";
const AGENT_KEY_B = "AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHIIIIJJJJKKK";

function makeEnrollment(
  store: MemoryEnrollmentStore,
  registry: MemoryAgentKeyRegistry,
): DeviceFlowEnrollment {
  return new DeviceFlowEnrollment({
    saasTrustChain: mockTrustChain,
    natsAccountConfig: mockNatsConfig,
    saasBaseUrl: "https://saas.com",
    jwksUrl: "https://saas.com/.well-known/jwks.json",
    bootstrapUrl: "https://saas.com/bootstrap",
    natsUrl: "wss://nats.saas.com",
    expirationSeconds: 600,
    pollIntervalSeconds: 5,
    store,
    agentKeyRegistry: registry,
  });
}

/** Drive one enroll → approve cycle; returns the user_code. */
async function enrollAndApprove(
  enrollment: DeviceFlowEnrollment,
  req: EnrollmentRequest,
): Promise<void> {
  const resp = await enrollment.enroll(req);
  const result = await enrollment.approve(resp.user_code);
  expect(result).not.toBeNull();
}

describe("MemoryAgentKeyRegistry", () => {
  it("put/get round-trips per (tenant, accountId)", async () => {
    const reg = new MemoryAgentKeyRegistry();
    await reg.put("t1", "a1", AGENT_KEY_A);
    expect(await reg.get("t1", "a1")).toBe(AGENT_KEY_A);
    expect(await reg.get("t1", "a2")).toBeNull();
    expect(await reg.get("t2", "a1")).toBeNull();
  });

  it("an accountId-less enrollment keys to the default segment (no collision with a named account)", async () => {
    const reg = new MemoryAgentKeyRegistry();
    await reg.put("t1", undefined, AGENT_KEY_A);
    await reg.put("t1", "named", AGENT_KEY_B);
    expect(await reg.get("t1", undefined)).toBe(AGENT_KEY_A);
    expect(await reg.get("t1", DEFAULT_REGISTRY_ACCOUNT_ID)).toBe(AGENT_KEY_A);
    expect(await reg.get("t1", "named")).toBe(AGENT_KEY_B);
  });

  it("put upserts (last write wins)", async () => {
    const reg = new MemoryAgentKeyRegistry();
    await reg.put("t1", "a1", AGENT_KEY_A);
    await reg.put("t1", "a1", AGENT_KEY_B);
    expect(await reg.get("t1", "a1")).toBe(AGENT_KEY_B);
  });

  it("agentKeyRegistryKey cannot collide across tenant/account via the join character", () => {
    // A naive `${tenant}/${accountId}` join would let ("a/b", "c") collide with
    // ("a", "b/c"). The length-prefixed key keeps them distinct.
    expect(agentKeyRegistryKey("a/b", "c")).not.toBe(agentKeyRegistryKey("a", "b/c"));
    expect(agentKeyRegistryKey("t", undefined)).toBe(agentKeyRegistryKey("t", DEFAULT_REGISTRY_ACCOUNT_ID));
  });
});

describe("DeviceFlowEnrollment → agent-key registry (F2a)", () => {
  it("approval persists the attested agent key, and it SURVIVES the pending-store eviction", async () => {
    const store = new MemoryEnrollmentStore({ autoSweep: false, retentionMs: 0 });
    const registry = new MemoryAgentKeyRegistry();
    const enrollment = makeEnrollment(store, registry);

    await enrollAndApprove(enrollment, {
      agentPublicKey: AGENT_KEY_A,
      tenant: "acme",
      accountId: "agent-1",
    });
    expect(await registry.get("acme", "agent-1")).toBe(AGENT_KEY_A);

    // Evict EVERYTHING from the pending store (retentionMs:0 → sweep drops all
    // records past expiry; force it well past). The durable registry must retain.
    store.sweep(Date.now() + 10 * 60 * 1000);
    expect(await registry.get("acme", "agent-1")).toBe(AGENT_KEY_A);
  });

  it("re-enrollment mints a fresh key → approval UPSERTS the registry to the new key", async () => {
    const store = new MemoryEnrollmentStore({ autoSweep: false });
    const registry = new MemoryAgentKeyRegistry();
    const enrollment = makeEnrollment(store, registry);

    await enrollAndApprove(enrollment, { agentPublicKey: AGENT_KEY_A, tenant: "acme", accountId: "agent-1" });
    expect(await registry.get("acme", "agent-1")).toBe(AGENT_KEY_A);

    // Same account re-enrolls with a NEW identity key (fresh device flow).
    await enrollAndApprove(enrollment, { agentPublicKey: AGENT_KEY_B, tenant: "acme", accountId: "agent-1" });
    expect(await registry.get("acme", "agent-1")).toBe(AGENT_KEY_B);
  });

  it("keys per account: two accounts on one tenant get distinct agent keys", async () => {
    const store = new MemoryEnrollmentStore({ autoSweep: false });
    const registry = new MemoryAgentKeyRegistry();
    const enrollment = makeEnrollment(store, registry);

    await enrollAndApprove(enrollment, { agentPublicKey: AGENT_KEY_A, tenant: "acme", accountId: "agent-1" });
    await enrollAndApprove(enrollment, { agentPublicKey: AGENT_KEY_B, tenant: "acme", accountId: "agent-2" });

    expect(await registry.get("acme", "agent-1")).toBe(AGENT_KEY_A);
    expect(await registry.get("acme", "agent-2")).toBe(AGENT_KEY_B);
  });

  it("a DENIED enrollment never populates the registry", async () => {
    const store = new MemoryEnrollmentStore({ autoSweep: false });
    const registry = new MemoryAgentKeyRegistry();
    const enrollment = makeEnrollment(store, registry);

    const resp = await enrollment.enroll({ agentPublicKey: AGENT_KEY_A, tenant: "acme", accountId: "agent-1" });
    expect(await enrollment.deny(resp.user_code)).toBe(true);
    expect(await enrollment.approve(resp.user_code)).toBeNull();
    expect(await registry.get("acme", "agent-1")).toBeNull();
  });

  it("no registry configured → approval still succeeds (pin delivery simply disabled)", async () => {
    const store = new MemoryEnrollmentStore({ autoSweep: false });
    const enrollment = new DeviceFlowEnrollment({
      saasTrustChain: mockTrustChain,
      natsAccountConfig: mockNatsConfig,
      saasBaseUrl: "https://saas.com",
      jwksUrl: "https://saas.com/.well-known/jwks.json",
      bootstrapUrl: "https://saas.com/bootstrap",
      natsUrl: "wss://nats.saas.com",
      store,
    });
    const resp = await enrollment.enroll({ agentPublicKey: AGENT_KEY_A, tenant: "acme", accountId: "agent-1" });
    expect(await enrollment.approve(resp.user_code)).not.toBeNull();
  });
});
