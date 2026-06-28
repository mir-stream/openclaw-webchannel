/**
 * Shared NATS user-credential minting helper.
 *
 * Mints a real NATS user JWT (signed by the SaaS account NKEY from
 * `setupTrustChain`) plus its NKEY seed, scoped to a tenant. This is the single
 * place the reference enrollment-server's TEST-ONLY `/test/nats-user` route uses
 * to issue creds for a non-agent peer (e.g. a browser/driver) so it can complete
 * an encrypted round-trip with an enrolled agent over a real JWT-auth nats-server.
 *
 * Subject scope: tenant-wide (`webchannel.{tenant}.>`). This is the same scope
 * the working enrolled-JWT round-trip uses (e2e/enrolled-jwt-roundtrip.test.ts)
 * and it covers the channel's per-peer subjects
 * (`webchannel.{tenant}.{agentId}.{peerId}.{in,out,handshake}`) while preserving
 * cross-tenant isolation — a different tenant's account/JWT cannot pub/sub here.
 *
 * `@nats-io/*` lives in packages/saas (+ e2e) only; never in packages/plugin.
 */

import { createUser, fromSeed } from "@nats-io/nkeys";
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
  const accountSigner = fromSeed(new TextEncoder().encode(opts.accountSeed));
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

  const userJwt = await encodeUser(`${role}-${opts.tenant}`, userKp, accountSigner, {
    pub: { allow: pub },
    sub: { allow: sub },
  });

  return { userJwt, userSeed, userSeedRaw, permissions: { pub, sub } };
}
