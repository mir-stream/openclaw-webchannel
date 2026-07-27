/**
 * Per-credential NATS revocation for a self-contained trust chain.
 *
 * A NATS account JWT carries a `revocations` map — `Record<userPubkey, unixSeconds>`
 * — meaning "refuse any credential for this user public key (`U…`) that was
 * issued at or before this unix-seconds timestamp". The special key `"*"` matches
 * ALL users (a tenant-wide kill-switch). nats-server enforces this on connect.
 *
 * This is the single-credential kill-switch that a SaaS built on this package
 * needs: today the only way to cut off a compromised/rotated credential without
 * this helper is to regenerate the entire trust chain (an all-tenant outage).
 * {@link addRevocation} re-encodes the account JWT with an added revocation
 * entry, re-signed by the current account JWT issuer's OPERATOR seed,
 * preserving every existing account field (top-level validity constraints,
 * limits, prior revocations, signing keys, …). Existing revocation floors are
 * monotonic: asking for an older floor never lowers the accepted floor. The
 * returned JWT MUST replace the old account JWT in the nats-server
 * resolver (`resolverConfig[accountPublicKey]`) for the revocation to take effect.
 *
 * Self-contained mode ONLY: an externally-managed account (Synadia Cloud / NGS)
 * has no operator seed here — it is revoked via that provider's own console.
 * For a legacy root-issued claim, obtain the root `operatorSeed` from
 * `setupTrustChain({ returnOperatorSeed: true })`. A ClaimPublisher-managed
 * claim instead requires the offline-authorized delegated operator seed whose
 * public key exactly equals the current claim's `iss`. Obtain `userPubkey` from
 * the minting path (`MintedNatsUserCreds.userPubkey`,
 * `NatsUserCredentials.userPubkey`, or `BrowserCredentials.userPubkey`).
 *
 * PERSISTENCE CAVEAT: `returnOperatorSeed` only takes effect on the FIRST
 * creation of a persisted chain (`loadOrCreateTrustChain`) — an already-persisted
 * chain is returned verbatim and never gains the operator seed, so revocation is
 * unusable there until the chain is regenerated.
 */

import { decode, encodeAccount, type Account } from "@nats-io/jwt";
import { fromSeed, fromPublic } from "@nats-io/nkeys";

/**
 * Re-encode an account JWT with an added revocation entry, signed by its
 * current issuer.
 *
 * @param accountJwt  The current account JWT (from `natsConfig.accountJwt` /
 *   `resolverConfig`). All existing fields are preserved.
 * @param operatorSeed  The operator NKEY seed (`SO…`) whose public key exactly
 *   equals the current account JWT `iss`. For a legacy root-issued claim this is
 *   the root from `setupTrustChain({ returnOperatorSeed: true })`; for a
 *   ClaimPublisher claim it is the offline-authorized delegated issuer seed.
 *   NOT the account seed (`SA…`): re-signing with the account seed yields a
 *   self-signed account JWT a real nats-server rejects.
 * @param userPubkey  The minted user public NKEY (`U…`) to revoke, or `"*"` to
 *   revoke ALL users of the account.
 * @param at  Unix seconds — credentials for `userPubkey` issued at or before this
 *   are refused. Must be a finite positive integer (a fractional value bricks the
 *   account: nats-server unmarshals the revocation timestamp as an int64).
 * @returns The new, current-issuer-signed account JWT. Drop it into the resolver
 *   (replace the old account JWT) for the revocation to take effect.
 */
export async function addRevocation(
  accountJwt: string,
  operatorSeed: string,
  userPubkey: string,
  at: number,
): Promise<string> {
  // The classic footgun is passing the ACCOUNT seed (`SA…`) instead of the
  // current issuer's OPERATOR seed (`SO…`). Reject any non-operator seed before
  // checking the exact issuer invariant below.
  if (typeof operatorSeed !== "string" || !operatorSeed.startsWith("SO")) {
    throw new Error(
      "addRevocation: operatorSeed must be the current account JWT issuer's NATS operator seed ('SO…') — " +
        "either the legacy root issuer or an offline-authorized delegated issuer, not the account seed ('SA…').",
    );
  }
  if (typeof userPubkey !== "string" || (userPubkey !== "*" && !userPubkey.startsWith("U"))) {
    throw new Error(
      "addRevocation: userPubkey must be a minted user public NKEY ('U…') or '*' to revoke all users",
    );
  }
  if (typeof at !== "number" || !Number.isInteger(at) || at <= 0) {
    // Fractional/NaN/Infinity all land in the revocations map and fail
    // nats-server's int64 unmarshal → same account-brick class as a bad seed.
    throw new Error("addRevocation: at must be a finite positive integer (unix seconds)");
  }

  const claim = decode<Account>(accountJwt);
  const nats = claim.nats;
  // Spread the decoded account body so limits, existing revocations, signing
  // keys, imports/exports, etc. survive — dropping the unlimited `limits` set at
  // setup would brick the account (default JWT caps connections at 0).
  const existingFloor = nats.revocations?.[userPubkey];
  const revocations = {
    ...(nats.revocations ?? {}),
    [userPubkey]: Math.max(existingFloor ?? at, at),
  };
  const account: Partial<Account> = { ...nats, revocations };

  // Re-encode against the SAME account public key (`claim.sub`). A public-only
  // key is fine here: `opts.signer` (the operator) does the actual signing and
  // sets `iss`. Mirrors setup-trust-chain.ts Step 4's encodeAccount(..., { signer }).
  const operatorKp = fromSeed(new TextEncoder().encode(operatorSeed));
  // The REAL defense against a wrong or stale issuer seed: an SO-prefixed root
  // or delegated seed is accepted only when its public key exactly equals the
  // supplied current account claim's issuer. An old signer can still construct
  // a candidate from an old claim, but cannot re-sign the newly seeded Dn+1
  // current claim; the downstream offline barrier must block stale-old-claim
  // publication.
  if (operatorKp.getPublicKey() !== claim.iss) {
    throw new Error(
      "addRevocation: operatorSeed is not this account JWT's current issuer (its public key != claim.iss) — wrong chain or stale delegated signer?",
    );
  }
  const accountId = fromPublic(claim.sub);
  return encodeAccount(claim.name, accountId, account, {
    signer: operatorKp,
    // encodeAccount intentionally regenerates jti/iat/iss, but these standard
    // validity constraints belong to the account claim and must survive a
    // revocation-only re-encode.
    exp: claim.exp,
    nbf: claim.nbf,
    aud: claim.aud,
  });
}
