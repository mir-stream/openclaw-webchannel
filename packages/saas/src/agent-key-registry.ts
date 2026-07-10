/**
 * F2 — durable agent identity-key registry.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * On the register/keyStore (production multi-device) path the browser must accept
 * the conversation key K ONLY if it was wrapped by the genuine agent — i.e. by the
 * holder of the agent identity private key that the SaaS attests to the browser.
 * For the browser to authenticate K it needs the agent's X25519 identity PUBLIC
 * key, delivered alongside the (first-party HTTPS) bootstrap response and derived
 * from SOLELY there — never from any NATS frame (see `parseBootstrapResponse` in
 * packages/client/src/saas-bootstrap.ts).
 *
 * That key is sent to the SaaS at enrollment (`agentPublicKey`) but historically
 * lived ONLY in the in-memory pending-enrollment store, which is retention-evicted
 * minutes after the agent polls its creds. So a browser bootstrapping HOURS later
 * had no attested agent key to pin. This registry is the durable home for it:
 * populated at enrollment APPROVAL and read at bootstrap.
 *
 * ── Keying ──────────────────────────────────────────────────────────────────
 * Keyed by (tenant, accountId), matching how the rest of the codebase resolves an
 * account. `accountId` is OPTIONAL in the enrollment request (it "is not part of
 * the trust chain"), so an accountId-less enrollment falls back to
 * {@link DEFAULT_REGISTRY_ACCOUNT_ID}. This is a pure MAP key — it does NOT
 * conjure a plugin-side "default" account (issue #17 is about the plugin's
 * account-config resolution, a different layer). At bootstrap the browser always
 * carries a concrete accountId, so the lookup selects the same key the matching
 * per-account enrollment persisted.
 *
 * ── Durability ──────────────────────────────────────────────────────────────
 * The interface is the durable seam: a production SaaS backs it with a DB / KV so
 * the mapping outlives process restarts and the pending-store sweep. The bundled
 * {@link MemoryAgentKeyRegistry} keeps it in a Map — sufficient for the demo /
 * reference servers (it survives the pending-store eviction because nothing sweeps
 * it) but NOT across a process restart, which a real deployment must not rely on.
 */

/**
 * Fallback registry account segment for an enrollment that carried no explicit
 * `accountId`. See the module docstring — this is a map-key fallback only.
 */
export const DEFAULT_REGISTRY_ACCOUNT_ID = "default";

/**
 * Durable store mapping (tenant, accountId) → the agent's attested X25519
 * identity public key (base64url, 43 chars). Implementations may be in-memory
 * (demo/reference) or persistent (DB/KV) for production.
 */
export interface AgentKeyRegistry {
  /**
   * Upsert the attested agent public key for (tenant, accountId). Called at
   * enrollment APPROVAL. A re-enrollment mints a FRESH agent identity key, so a
   * later approval MUST overwrite the previous value (upsert, last-writer-wins).
   */
  put(tenant: string, accountId: string | undefined, agentPublicKey: string): Promise<void>;

  /**
   * Look up the attested agent public key for (tenant, accountId), or `null` when
   * none is registered (no enrollment yet, or a pre-F2 approval). A `null` at
   * bootstrap means the browser cannot authenticate K — the caller decides
   * whether to fail the bootstrap or omit the field (a lockstep-old client
   * ignores it).
   */
  get(tenant: string, accountId: string | undefined): Promise<string | null>;
}

/**
 * Canonical registry key. `accountId` undefined/empty collapses to
 * {@link DEFAULT_REGISTRY_ACCOUNT_ID}. The two segments are length-prefixed so no
 * `tenant`/`accountId` pair can collide with another via the join character.
 */
export function agentKeyRegistryKey(tenant: string, accountId: string | undefined): string {
  const acct = accountId && accountId.length > 0 ? accountId : DEFAULT_REGISTRY_ACCOUNT_ID;
  return `${tenant.length}:${tenant}/${acct.length}:${acct}`;
}

/**
 * In-memory {@link AgentKeyRegistry}. Survives the pending-enrollment store's
 * eviction (nothing sweeps this map) but NOT a process restart — production
 * deployments provide a persistent implementation of the same interface.
 */
export class MemoryAgentKeyRegistry implements AgentKeyRegistry {
  private readonly keys = new Map<string, string>();

  async put(tenant: string, accountId: string | undefined, agentPublicKey: string): Promise<void> {
    this.keys.set(agentKeyRegistryKey(tenant, accountId), agentPublicKey);
  }

  async get(tenant: string, accountId: string | undefined): Promise<string | null> {
    return this.keys.get(agentKeyRegistryKey(tenant, accountId)) ?? null;
  }
}
