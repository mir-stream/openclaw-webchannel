/**
 * Shared NATS user-credential minting helper.
 *
 * Mints a real NATS user JWT (signed by the SaaS account NKEY from
 * `setupTrustChain`) plus its NKEY seed, scoped to a tenant. This is the SINGLE
 * minting code path for BOTH peers:
 *   - the browser/driver (reference enrollment-server's TEST-ONLY
 *     `/test/nats-user` route), and
 *   - the enrolled agent (DeviceFlowEnrollment.approve →
 *     generateNatsUserCredentials), so the agent and browser are minted
 *     identically.
 *
 * Supports two account modes (see `issuerAccountId`):
 *   - self-contained: the account is self-signed (SaaS runs the nats-server).
 *   - external (Synadia Cloud / NGS): signed by an account signing key with
 *     `nats.issuer_account` set to the managed account identity.
 *
 * Subject scope: tenant-wide (`webchannel.{tenant}.>`). This is the same scope
 * the working enrolled-JWT round-trip uses (e2e/enrolled-jwt-roundtrip.test.ts)
 * and it covers the channel's per-peer subjects
 * (`webchannel.{tenant}.{accountId}.{peerId}.{in,out,handshake}`) while preserving
 * cross-tenant isolation — a different tenant's account/JWT cannot pub/sub here.
 *
 * `@nats-io/*` lives in packages/saas (+ e2e) only; never in packages/plugin.
 */

import { createUser, fromSeed, fromPublic } from "@nats-io/nkeys";
import { encodeUser } from "@nats-io/jwt";

import { assertValidSubjectToken } from "./subject-token.js";

/** Logical role of the minted peer — informational only (perms are identical). */
export type NatsUserRole = "browser" | "agent";

export type MintNatsUserCredsOptions = {
  /** SaaS NATS account signing seed (`setupTrustChain().private.natsAccountSeed`). */
  accountSeed: string;
  /** Tenant the user is scoped to. */
  tenant: string;
  /** Logical role (default "browser"). Embedded in the JWT name for debugging. */
  role?: NatsUserRole;
  /**
   * Optional account IDENTITY public NKEY (`A…`) for an externally-managed
   * account (Synadia Cloud / NGS).
   *
   * - When PRESENT: `accountSeed` is treated as an account SIGNING-key seed.
   *   The user JWT is signed by that signing key (so `iss` = signing-key
   *   public) and stamped with `nats.issuer_account = issuerAccountId`, so a
   *   managed resolver that lists the signing key for this account accepts it.
   * - When ABSENT: byte-for-byte the original self-signed behavior — the user
   *   JWT is signed by `accountSeed`'s own keypair (`iss` = account public, no
   *   `issuer_account`).
   */
  issuerAccountId?: string;
  /**
   * Optional lifetime (seconds) → the user JWT's `exp` claim. Omit for a
   * non-expiring credential (the original behavior, byte-for-byte). When set, the
   * relay refuses the credential once it lapses; the client classifies the
   * resulting `-ERR Authentication Expired` as TERMINAL and surfaces a re-auth
   * prompt (short-lived-credential UX).
   */
  ttlSeconds?: number;
};

export type MintedNatsUserCreds = {
  /** NATS user JWT (compact), signed by the account NKEY. */
  userJwt: string;
  /** NATS user NKEY seed ("SU…") — base32, for `@nats-io/nkeys` `fromSeed`. */
  userSeed: string;
  /**
   * base64url of the raw 32-byte Ed25519 user-NKEY seed. Browser-friendly: a
   * web client can wrap this in a PKCS#8 header and sign the server nonce with
   * `crypto.subtle` alone — no base32/CRC NKEY decoder, no `@nats-io/*`.
   */
  userSeedRaw: string;
  /** The pub/sub allow-lists embedded in the JWT. */
  permissions: { pub: string[]; sub: string[] };
};

/**
 * Mint tenant-scoped NATS user credentials for a peer.
 *
 * Both pub and sub are allowed across `webchannel.{tenant}.>` so the peer can
 * publish to its `.in`/`.handshake` subjects and subscribe to `.out`/`.handshake`
 * (and vice-versa for the mirror direction) — i.e. talk to the enrolled agent.
 */
export async function mintNatsUserCreds(
  opts: MintNatsUserCredsOptions,
): Promise<MintedNatsUserCreds> {
  const role = opts.role ?? "browser";
  // Reject any tenant that would break the subject hierarchy before it is
  // spliced into the `webchannel.{tenant}.>` permission grant.
  assertValidSubjectToken(opts.tenant, "tenant");
  // The signing key (always present): an account-type keypair whose public key
  // becomes the JWT `iss`. In self-contained mode it IS the account identity;
  // in external mode it is a signing key listed on the managed account.
  const signingKp = fromSeed(new TextEncoder().encode(opts.accountSeed));
  const userKp = createUser();
  const userSeed = new TextDecoder().decode(userKp.getSeed());
  // Browser-friendly raw seed (base64url of the 32-byte Ed25519 seed). Never log.
  // `getRawSeed()` is the KeyPair's public accessor for the exact 32-byte
  // Ed25519 seed (identical to bytes [2,34) of the decoded base32 NKEY seed).
  // The concrete KP class exposes it but the public `KeyPair` interface omits
  // it, so we narrow the type to reach the public method.
  const userKpRaw = userKp as unknown as { getRawSeed(): Uint8Array };
  const userSeedRaw = Buffer.from(userKpRaw.getRawSeed()).toString("base64url");

  const pub = [`webchannel.${opts.tenant}.>`];
  const sub = [`webchannel.${opts.tenant}.>`];
  const perms = { pub: { allow: pub }, sub: { allow: sub } };

  // External mode: sign with the signing key but issue ON BEHALF OF the account
  // identity. `@nats-io/jwt`'s encodeUser, given `opts.signer`, sets
  // `iss` = signer public and `nats.issuer_account` = the `issuer` arg's public
  // (the account identity). The identity key only needs to be PUBLIC (`A…`).
  // Self-contained mode: no signer → `iss` = account public, no issuer_account.
  // Optional expiry → the JWT `exp` claim (unix seconds). Undefined ttl keeps the
  // original non-expiring behavior.
  const exp = opts.ttlSeconds ? Math.floor(Date.now() / 1000) + opts.ttlSeconds : undefined;
  const userJwt = opts.issuerAccountId
    ? await encodeUser(
        `${role}-${opts.tenant}`,
        userKp,
        fromPublic(opts.issuerAccountId),
        perms,
        exp ? { signer: signingKp, exp } : { signer: signingKp },
      )
    : await encodeUser(
        `${role}-${opts.tenant}`,
        userKp,
        signingKp,
        perms,
        exp ? { exp } : undefined,
      );

  return { userJwt, userSeed, userSeedRaw, permissions: { pub, sub } };
}
