/**
 * Single-route, multi-account register DISPATCH (가-1 Cycle 2 — Phase 3).
 *
 * The `/webchannel/nats/register*` routes are a SINGLE route set serving ALL
 * accounts (no per-account path segments — that stays 가-2). These pure helpers
 * decide WHICH account a request targets and what CORS to apply, so the wiring
 * is unit-testable without standing up registerFull / a live NATS.
 */

import { peekUnverifiedJwtAudiences } from "./jwt.js";

/**
 * Resolve the accountId a bootstrap JWT targets by peeking its (unverified)
 * `aud` claim(s) and mapping them through `audToAccount`. Returns the first
 * audience that maps to a served account, or `undefined`.
 *
 * The peek is UNVERIFIED on purpose — it only ROUTES. The selected account's
 * verifier then runs the full signature + issuer + aud check, so a forged `aud`
 * can at most select an account whose verifier will reject the token.
 */
export function resolveAccountIdForJwt(
  jwt: string | null | undefined,
  audToAccount: ReadonlyMap<string, string>,
): string | undefined {
  if (!jwt) return undefined;
  for (const aud of peekUnverifiedJwtAudiences(jwt)) {
    const accountId = audToAccount.get(aud);
    if (accountId !== undefined) return accountId;
  }
  return undefined;
}

/**
 * CORS allowlist for the cross-account preflight (OPTIONS) path, which carries
 * no JWT so the target account is unknown. Returns `undefined` (permissive ⇒
 * reflect Origin) when there are no accounts OR any account is permissive
 * (no/empty allowlist); otherwise the de-duplicated union of all allowlists.
 *
 * For a single account this returns exactly that account's allowlist, so the
 * Cycle 1 single-account CORS behavior is preserved.
 */
export function unionAllowedOrigins(
  allowlists: ReadonlyArray<readonly string[] | undefined>,
): string[] | undefined {
  if (allowlists.length === 0) return undefined;
  if (allowlists.some((list) => !list || list.length === 0)) return undefined;
  return [...new Set(allowlists.flatMap((list) => [...(list ?? [])]))];
}

/**
 * Add an `aud → accountId` dispatch entry with DETERMINISTIC FIRST-WINS on
 * collision (C1). Two served accounts can share an `auth.jwt.audience` (same
 * IdP), or one account's agentId key can equal another's configured audience —
 * a blind overwrite would silently misroute every token carrying that aud to
 * whichever account was registered last. Instead we keep the first binding and
 * log an actionable collision warning (mirrors the duplicate-agentId treatment).
 *
 * Returns `true` if the entry was added, `false` if it was a collision (skipped).
 */
export function addAudMapping(
  audToAccount: Map<string, string>,
  aud: string,
  accountId: string,
  onCollision?: (msg: string) => void,
): boolean {
  const existing = audToAccount.get(aud);
  if (existing !== undefined) {
    if (existing !== accountId) {
      onCollision?.(
        `[webchannel] audience "${aud}" is already mapped to account "${existing}"; ` +
          `account "${accountId}" wants the same audience — keeping the first (first-wins). ` +
          `Give each account a distinct jwt.audience / agentId to avoid register misrouting.`,
      );
    }
    return false;
  }
  audToAccount.set(aud, accountId);
  return true;
}

/** A register-target account: just the slice the dispatch core needs. */
export type RegisterTargetAccount = {
  accountId: string;
  /** This account's auth config — the verifier enforces its own issuer/aud. */
  auth: unknown;
};

/**
 * Resolve a bootstrap JWT to its target account AND verify it against THAT
 * account's auth, in one place, so the verify-and-register invariant (S1) is
 * structurally locked: the caller registers the peer into the SAME `account`
 * this returns, and verification used that same account's `auth`. A token whose
 * aud routes to account B can therefore NEVER be verified against — or
 * registered into — account A.
 *
 * Pure w.r.t. its injected `verify` seam (the real caller passes
 * `verifyJwtAndExtractIdentity`), so it is unit-testable without a NATS server.
 *
 * Statuses:
 *   - `no-jwt`    → missing token (caller: 401)
 *   - `no-account`→ aud maps to no served account (caller: 401)
 *   - `non-jwt`   → resolved account is not a `jwt`-strategy account, so a
 *                   bootstrap-JWT register hop is not applicable (caller: 401,
 *                   clearer than letting verify throw → 500)
 *   - `invalid`   → verification returned null (caller: 401)
 *   - `ok`        → `{ account, identity }`; caller continues PoP + registerPeer
 */
export async function resolveAndVerifyRegister<
  I,
  A extends RegisterTargetAccount,
>(params: {
  jwt: string | null | undefined;
  audToAccount: ReadonlyMap<string, string>;
  getAccount: (accountId: string) => A | undefined;
  verify: (jwt: string, auth: unknown) => Promise<I | null>;
}): Promise<
  | { status: "no-jwt" }
  | { status: "no-account" }
  | { status: "non-jwt" }
  | { status: "invalid" }
  | { status: "ok"; account: A; identity: I }
> {
  const { jwt, audToAccount, getAccount, verify } = params;
  if (!jwt) return { status: "no-jwt" };
  const accountId = resolveAccountIdForJwt(jwt, audToAccount);
  if (accountId === undefined) return { status: "no-account" };
  const account = getAccount(accountId);
  if (!account) return { status: "no-account" };
  // A bootstrap-JWT register hop only applies to a `jwt`-strategy account.
  const strategy = (account.auth as { strategy?: string } | undefined)?.strategy;
  if (strategy !== "jwt") return { status: "non-jwt" };
  const identity = await verify(jwt, account.auth);
  if (!identity) return { status: "invalid" };
  return { status: "ok", account, identity };
}
