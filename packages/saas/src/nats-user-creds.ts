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
  /** NATS user NKEY seed ("SU…"). */
  userSeed: string;
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
  const accountSigner = fromSeed(new TextEncoder().encode(opts.accountSeed));
  const userKp = createUser();
  const userSeed = new TextDecoder().decode(userKp.getSeed());

  const pub = [`webchannel.${opts.tenant}.>`];
  const sub = [`webchannel.${opts.tenant}.>`];

  const userJwt = await encodeUser(`${role}-${opts.tenant}`, userKp, accountSigner, {
    pub: { allow: pub },
    sub: { allow: sub },
  });

  return { userJwt, userSeed, permissions: { pub, sub } };
}
