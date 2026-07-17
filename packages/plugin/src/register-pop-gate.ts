/**
 * Proof-of-Possession admission gate for the NATS register route.
 *
 * PoP is UNCONDITIONALLY required (P0-3 D6-5). A verified bootstrap JWT that
 * carries no `pop_jwk` is rejected (401) before any peer is registered, so a
 * leaked bootstrap JWT minted WITHOUT `pop_jwk` cannot be replayed to register a
 * peer. The former `auth.requirePoP: false` opt-out was removed: after P0-2 the
 * register hop is the ONLY admission door, and a config toggle that unlocked it
 * was a security relaxation, not a real setting. A present `auth.requirePoP` now
 * reaches a fatal migration error (`assertNoRemovedConfig`).
 */

/**
 * Decide whether the register request must be rejected because PoP is required
 * (always) but the verified bootstrap JWT carries no `pop_jwk`.
 *
 * @returns `true` when the route must respond 401 BEFORE registering the peer.
 */
export function popRequirementUnmet(hasPopJwk: boolean): boolean {
  return !hasPopJwk;
}
