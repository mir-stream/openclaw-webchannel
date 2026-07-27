/**
 * DM allowlist admission — the plugin-owned half of the split authz model.
 *
 * Per the OpenClaw channel-plugin docs, authorization is split: core evaluates
 * policy, but the plugin normalizes identity and supplies the allowlist via
 * `security.dm.{resolveAllowFrom,resolvePolicy,defaultPolicy}` (see channel.ts).
 * On the NATS inbound path the plugin must also GATE its own inbound handler
 * with the admission decision before dispatching the turn to the agent —
 * otherwise a non-allowlisted sender reaches the agent (open-by-default).
 *
 * Policy semantics (Seed: "default-deny on empty allowFrom"):
 *  - policy === "allowlist"  → admit only peers present in `allowFrom`
 *                              (an empty allowlist denies everyone — default-deny).
 *  - an open policy ("open"/"all"/"any"/"anyone"/"everyone"/"public") → admit all.
 *  - policy UNSET            → admit all. This preserves the already-shipping
 *                              Phase A (Gateway-WS) behavior; operators opt into
 *                              default-deny by setting `dmSecurity: "allowlist"`.
 */

export type DmSecurityConfig = {
  /** Allowed sender identities (peerId === JWT `sub`). */
  allowFrom?: readonly string[];
  /** DM policy. "allowlist" enforces default-deny; unset/open admits all. */
  dmSecurity?: string;
};

export type DmAdmission = {
  allowed: boolean;
  /** Machine-readable reason, useful for logs and negative-path assertions. */
  reason:
    | "open-policy"
    | "policy-unset"
    | "allowlisted"
    | "not-allowlisted"
    | "default-deny-empty-allowlist";
};

const OPEN_POLICIES = new Set([
  "open",
  "all",
  "any",
  "anyone",
  "everyone",
  "public",
]);

/**
 * Decide whether a peer may message the agent over a direct channel.
 *
 * Pure and side-effect free so it can be unit-tested directly and reused by the
 * inbound seam.
 */
export function resolveDmAdmission(
  peerId: string,
  cfg: DmSecurityConfig | undefined,
): DmAdmission {
  const policy = cfg?.dmSecurity?.trim().toLowerCase();

  if (!policy) return { allowed: true, reason: "policy-unset" };
  if (OPEN_POLICIES.has(policy)) return { allowed: true, reason: "open-policy" };

  // Allowlist policy → default-deny. Only explicitly allowed peers are admitted.
  const allowFrom = cfg?.allowFrom ?? [];
  if (allowFrom.length === 0) {
    return { allowed: false, reason: "default-deny-empty-allowlist" };
  }
  return allowFrom.includes(peerId)
    ? { allowed: true, reason: "allowlisted" }
    : { allowed: false, reason: "not-allowlisted" };
}
