/**
 * Proof-of-Possession admission gate for the NATS register route.
 *
 * Secure-by-default: PoP is REQUIRED unless an operator explicitly opts out with
 * `auth.requirePoP: false`. Previously the register route only verified PoP when
 * the bootstrap JWT happened to carry a `pop_jwk`; a leaked bootstrap JWT minted
 * WITHOUT `pop_jwk` was therefore freely replayable to register a peer. With the
 * default-true gate, a verified JWT that lacks `pop_jwk` is rejected (401) before
 * any peer is registered.
 */

/**
 * Decide whether the register request must be rejected because PoP is required
 * but the verified bootstrap JWT carries no `pop_jwk`.
 *
 * @returns `true` when the route must respond 401 BEFORE registering the peer.
 */
export function popRequirementUnmet(requirePoP: boolean, hasPopJwk: boolean): boolean {
  return requirePoP && !hasPopJwk;
}
