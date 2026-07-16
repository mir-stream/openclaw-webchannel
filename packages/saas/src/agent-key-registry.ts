import { createHash, randomBytes } from "node:crypto";

/** Stable full base64url SHA-256 identifier of an X25519 public key. */
export type AgentKeyId = string;
/** Opaque, per-activation CAS token. It is deliberately not derived from the key. */
export type ActivationId = string;

export interface AgentKeyRecord {
  readonly tenant: string;
  readonly accountId: string;
  readonly publicKey: string;
  readonly keyId: AgentKeyId;
  readonly activationId: ActivationId;
  readonly status: "active" | "superseded" | "revoked";
  readonly enrolledAt: number;
  readonly endedAt?: number;
  readonly supersededBy?: ActivationId;
}

export type RegisterAgentKeyResult =
  | { ok: true; record: AgentKeyRecord; idempotent: boolean }
  | { ok: false; reason: "conflict"; current: AgentKeyRecord | null }
  | { ok: false; reason: "revoked" };

/**
 * Durable agent-key registry SPI v2.
 *
 * Implementations MUST serialize register/revokeActive per slot and return a
 * coherent before-or-after snapshot from readers. History and tombstones are
 * non-lossy for the lifetime of a slot: TTL or lossy compaction is not conformant.
 * The enrollment store and this registry must share one durability domain.
 */
export interface AgentKeyRegistry {
  getActive(tenant: string, accountId: string): Promise<AgentKeyRecord | null>;
  register(
    tenant: string,
    accountId: string,
    publicKey: string,
    expect: ActivationId | null,
  ): Promise<RegisterAgentKeyResult>;
  revokeActive(tenant: string, accountId: string): Promise<boolean>;
  listHistory(tenant: string, accountId: string): Promise<AgentKeyRecord[]>;
}

/** Length-prefixing prevents tenant/account boundary collisions. */
export function agentKeyRegistryKey(tenant: string, accountId: string): string {
  return `${tenant.length}:${tenant}/${accountId.length}:${accountId}`;
}

function keyId(publicKey: string): AgentKeyId {
  return createHash("sha256").update(Buffer.from(publicKey, "base64url")).digest("base64url");
}

function clone(record: AgentKeyRecord): AgentKeyRecord {
  return { ...record };
}

/**
 * Single-process reference implementation. Map transitions contain no await,
 * hence each slot's read/modify/write is one JS run-to-completion operation.
 */
export class MemoryAgentKeyRegistry implements AgentKeyRegistry {
  private readonly histories = new Map<string, AgentKeyRecord[]>();

  async getActive(tenant: string, accountId: string): Promise<AgentKeyRecord | null> {
    const active = this.histories
      .get(agentKeyRegistryKey(tenant, accountId))
      ?.find((record) => record.status === "active");
    return active ? clone(active) : null;
  }

  async register(
    tenant: string,
    accountId: string,
    publicKey: string,
    expect: ActivationId | null,
  ): Promise<RegisterAgentKeyResult> {
    const slot = agentKeyRegistryKey(tenant, accountId);
    const history = this.histories.get(slot) ?? [];
    const incomingKeyId = keyId(publicKey);

    // Contractual precedence: permanent tombstone, idempotency, then CAS.
    if (history.some((record) => record.status === "revoked" && record.keyId === incomingKeyId)) {
      return { ok: false, reason: "revoked" };
    }
    const activeIndex = history.findIndex((record) => record.status === "active");
    const active = activeIndex >= 0 ? history[activeIndex] : undefined;
    if (active?.publicKey === publicKey) {
      return { ok: true, record: clone(active), idempotent: true };
    }
    if ((expect === null && active) || (expect !== null && active?.activationId !== expect)) {
      return { ok: false, reason: "conflict", current: active ? clone(active) : null };
    }

    const now = Date.now();
    const activationId = randomBytes(16).toString("base64url");
    const record: AgentKeyRecord = {
      tenant,
      accountId,
      publicKey,
      keyId: incomingKeyId,
      activationId,
      status: "active",
      enrolledAt: now,
    };
    const next = history.map((old, index) =>
      index === activeIndex
        ? { ...old, status: "superseded" as const, endedAt: now, supersededBy: activationId }
        : old,
    );
    next.unshift(record);
    this.histories.set(slot, next);
    return { ok: true, record: clone(record), idempotent: false };
  }

  async revokeActive(tenant: string, accountId: string): Promise<boolean> {
    const slot = agentKeyRegistryKey(tenant, accountId);
    const history = this.histories.get(slot);
    const activeIndex = history?.findIndex((record) => record.status === "active") ?? -1;
    if (!history || activeIndex < 0) return false;
    const now = Date.now();
    this.histories.set(
      slot,
      history.map((record, index) =>
        index === activeIndex ? { ...record, status: "revoked" as const, endedAt: now } : record,
      ),
    );
    return true;
  }

  async listHistory(tenant: string, accountId: string): Promise<AgentKeyRecord[]> {
    return (this.histories.get(agentKeyRegistryKey(tenant, accountId)) ?? []).map(clone);
  }
}
