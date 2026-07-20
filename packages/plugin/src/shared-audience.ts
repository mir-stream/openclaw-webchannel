/**
 * Shared-audience collision detection (P0-3 D6-1) — PURE.
 *
 * Register admission is chosen purely by the `.register` subject (the accountId
 * segment), NOT by the token's `aud`. So if two register-hop accounts on one
 * gateway share the same (issuer, audience), a bootstrap JWT minted for one
 * VERIFIES against the other's `.register` subject → that peer would receive the
 * WRONG account's conversation key + history.
 *
 * P0-3 hardens the earlier "warn on the second claimant" heuristic into a
 * fail-closed skip of the ENTIRE collision set: because the shared-aud token
 * verifies against every member's subject, leaving even the first member serving
 * is unsafe. This detection runs as a PRE-PASS — before any transport is opened —
 * so a colliding account is skipped without ever leaking an authenticated live
 * connection.
 *
 * This module is the testable core (the `index-nats.ts` entry is tsc-blind and
 * cannot be unit-imported): it takes each account's DERIVED auth and returns the
 * accounts to skip, each annotated with its colliding peers for the operator log.
 */

import type { AuthConfig } from "./auth.js";
import { deriveIssuer } from "./preflight.js";

/** Per-skipped-account collision detail (for the actionable operator log). */
export type SharedAudienceCollision = {
  /** The (raw) issuer the colliding accounts share. */
  issuer: string;
  /** The audience the colliding accounts share. */
  audience: string;
  /** The OTHER accountIds in this collision set (never includes self). */
  peers: string[];
};

/**
 * Detect shared-audience collisions across a gateway's accounts.
 *
 * Only `jwt`-strategy accounts that carry BOTH an issuer and an audience can be
 * cross-verified, so only they participate. The issuer is normalized the SAME way
 * `verifyJwt` compares it (trailing slash collapsed via `deriveIssuer`) — a
 * config-pinned `https://x/` and a derived `https://x` must key as the SAME
 * collision, else the guard would miss exactly the cross-verification it exists to
 * catch.
 *
 * @returns a Map from accountId → collision detail for EVERY account in a
 * collision set of size ≥ 2. Accounts with a unique (issuer, audience) — or
 * without a jwt issuer/audience — are absent from the map (they serve normally).
 */
export function detectSharedAudienceCollisions(
  entries: Array<{ accountId: string; auth: AuthConfig | undefined }>,
): Map<string, SharedAudienceCollision> {
  const byKey = new Map<
    string,
    { issuer: string; audience: string; accountIds: string[] }
  >();
  for (const { accountId, auth } of entries) {
    if ((auth as { strategy?: string } | undefined)?.strategy !== "jwt") continue;
    const jwt = (auth as { jwt?: { issuer?: string; audience?: string } }).jwt;
    const issuer = jwt?.issuer;
    const audience = jwt?.audience;
    if (!issuer || !audience) continue;
    const key = `${deriveIssuer(issuer)} ${audience}`;
    const existing = byKey.get(key);
    if (existing) existing.accountIds.push(accountId);
    else byKey.set(key, { issuer, audience, accountIds: [accountId] });
  }

  const collisions = new Map<string, SharedAudienceCollision>();
  for (const { issuer, audience, accountIds } of byKey.values()) {
    if (accountIds.length < 2) continue;
    for (const accountId of accountIds) {
      collisions.set(accountId, {
        issuer,
        audience,
        peers: accountIds.filter((id) => id !== accountId),
      });
    }
  }
  return collisions;
}
