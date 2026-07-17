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
