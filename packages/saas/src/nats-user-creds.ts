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
 * Subject scope depends on `role`:
 *   - "agent": tenant-wide (`webchannel.{tenant}.>`) pub+sub. The enrolled agent
 *     legitimately serves EVERY peer of its accounts (it must publish each
 *     browser's `.out`/`.reginbox` and subscribe each browser's `.in`/`.register`),
 *     so it keeps the tenant-wide grant.
 *   - "browser": scoped to the peer's OWN subtree across all of the tenant's
 *     accounts (`webchannel.{tenant}.*.{peerId}.>`, the `*` matching the accountId
 *     segment). A browser therefore cannot publish to (or subscribe) another
 *     peerId's `.register`/`.reginbox`/`.in`/`.out`/`.handshake` — this structurally
 *     closes the register-reply forgery / K-poisoning vector (a same-tenant peer
 *     could otherwise publish a forged `registered:true` reply to a victim's
 *     reginbox) and the unregister-DoS. The peerId MUST be the authenticated
 *     session/JWT subject, never client input.
 *   - "observer": SUB-only, tenant-wide (`webchannel.{tenant}.>`) with NO pub — the
 *     demo wiretap. Strictly weaker than a browser: it can read the whole tenant
 *     subtree (to render ciphertext) but can never publish anything.
 *
 * All roles preserve cross-tenant isolation — a different tenant's JWT cannot
 * pub/sub here. Matches the enrolled-JWT round-trip (e2e/enrolled-jwt-roundtrip.test.ts).
 *
 * `@nats-io/*` lives in packages/saas (+ e2e) only; never in packages/plugin.
 */

import { createUser, fromSeed, fromPublic } from "@nats-io/nkeys";
import { encodeUser } from "@nats-io/jwt";

import { assertValidSubjectToken } from "./subject-token.js";

/**
 * Logical role of the minted peer. Unlike the original design (perms identical
 * across roles), the role now DETERMINES the subject scope — see the module
 * docstring. "observer" is sub-only (wiretap); "browser" is per-peer-scoped;
 * "agent" is tenant-wide.
 */
export type NatsUserRole = "browser" | "agent" | "observer";

export type MintNatsUserCredsOptions = {
  /** SaaS NATS account signing seed (`setupTrustChain().private.natsAccountSeed`). */
  accountSeed: string;
  /** Tenant the user is scoped to. */
  tenant: string;
  /** Logical role (default "browser"). Determines the subject scope + JWT name. */
  role?: NatsUserRole;
  /**
   * The peer's stable identity (JWT `sub` = user uuid). REQUIRED for role
   * "browser": the grant is scoped to `webchannel.{tenant}.*.{peerId}.>` so the
   * browser can only touch its own peer subtree. MUST come from the authenticated
   * session/JWT, never from client input. Ignored for "agent"/"observer".
   */
  peerId?: string;
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
 * Mint role-scoped NATS user credentials for a peer. The subject grant depends
 * on `role` (see the module docstring): "agent" is tenant-wide, "browser" is
 * pinned to `webchannel.{tenant}.*.{peerId}.>`, "observer" is sub-only.
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

  // Subject scope by role (see module docstring). The permission grant is the
  // security boundary that closes register-reply forgery + unregister DoS: a
  // browser is pinned to its OWN peer subtree, so it cannot pub/sub another
  // peer's `.register`/`.reginbox`/`.in`/`.out`. An observer can only read.
  let pub: string[];
  let sub: string[];
  // Observer publishes NOTHING. An empty `pub.allow` is NOT deny-all in
  // nats-server (an absent/empty allow-list means unrestricted), so the observer
  // needs an explicit `pub.deny: [">"]` to actually refuse every publish.
  let observerNoPub = false;
  if (role === "agent") {
    pub = [`webchannel.${opts.tenant}.>`];
    sub = [`webchannel.${opts.tenant}.>`];
  } else if (role === "observer") {
    // Wiretap: read the whole tenant subtree, NEVER publish (explicit deny-all).
    pub = [];
    sub = [`webchannel.${opts.tenant}.>`];
    observerNoPub = true;
  } else {
    // browser: pin to this peer's own subtree across all of the tenant's accounts
    // (`*` matches the accountId segment; the same peerId spans every account the
    // user is granted). peerId is the authenticated `sub`, validated as a subject
    // token so it cannot smuggle a `.`/`*`/`>` that would widen the grant.
    if (!opts.peerId) {
      throw new Error(
        "mintNatsUserCreds: role 'browser' requires peerId (the authenticated JWT sub) to scope creds",
      );
    }
    assertValidSubjectToken(opts.peerId, "peerId");
    pub = [`webchannel.${opts.tenant}.*.${opts.peerId}.>`];
    sub = [`webchannel.${opts.tenant}.*.${opts.peerId}.>`];
  }
  const perms = observerNoPub
    ? { pub: { deny: [">"] }, sub: { allow: sub } }
    : { pub: { allow: pub }, sub: { allow: sub } };

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

// ---------------------------------------------------------------------------
// Public API (barrel-exported): browser-login NATS credentials.
// ---------------------------------------------------------------------------

/**
 * Browser NATS credentials returned by {@link issueBrowserCredentials}.
 *
 * Only the fields a browser `WebChannelNATSClient` needs. The base32 `userSeed`
 * (`SU…`) is deliberately DROPPED — the browser signs the server nonce from the
 * raw seed via `crypto.subtle` alone, so it never touches an NKEY decoder. A Node
 * consumer that needs the base32 form must mint through the internal helper.
 */
export type BrowserCredentials = {
  /** NATS user JWT (compact), signed by the account NKEY. */
  userJwt: string;
  /** base64url of the raw 32-byte Ed25519 user-NKEY seed — `WebChannelNATSClient` requires it. */
  userSeedRaw: string;
  /** The pub/sub allow-lists embedded in the JWT. */
  permissions: { pub: string[]; sub: string[] };
};

/**
 * Options for {@link issueBrowserCredentials}.
 */
export type IssueBrowserCredentialsOptions = {
  /** SaaS NATS account signing seed (`loadOrCreateTrustChain().private.natsAccountSeed`). */
  accountSeed: string;
  /** Tenant the browser is scoped to. */
  tenant: string;
  /**
   * The browser peer's STABLE identity (the authenticated session/JWT `sub` =
   * user uuid). REQUIRED: the grant is pinned to `webchannel.{tenant}.*.{peerId}.>`
   * so the browser can only touch its own peer subtree. MUST come from the
   * authenticated session — NEVER from client input — or a peer can impersonate
   * another and forge its register replies.
   */
  peerId: string;
  /**
   * Optional account IDENTITY public NKEY (`A…`) for an externally-managed account
   * (Synadia Cloud / NGS). Present ONLY in external mode — a self-contained demo
   * leaves it unset (setting it couples the creds to a managed resolver).
   */
  issuerAccountId?: string;
  /**
   * Optional lifetime (seconds). When set it MUST be a finite positive number —
   * a `0`/negative/NaN/Infinity value would mint a NON-expiring or malformed-exp
   * credential (a footgun), so this wrapper rejects it. Omit for a non-expiring
   * credential.
   */
  ttlSeconds?: number;
};

/**
 * Mint browser-login NATS credentials — the first public path for issuing a
 * per-peer-scoped browser credential (`role:"browser"`, pinned to
 * `webchannel.{tenant}.*.{peerId}.>`). A thin, safe wrapper over the internal
 * `mintNatsUserCreds`: `peerId` is type-required, `ttlSeconds` (if present) must
 * be `> 0`, and only the browser-relevant fields are returned ({@link BrowserCredentials}).
 *
 * The raw NKEY mint / role selection stays internal — an operator can only ever
 * mint a correctly-scoped browser credential through this door.
 */
export async function issueBrowserCredentials(
  o: IssueBrowserCredentialsOptions,
): Promise<BrowserCredentials> {
  if (o.ttlSeconds !== undefined && !(Number.isFinite(o.ttlSeconds) && o.ttlSeconds > 0)) {
    // NaN/Infinity/fractional-or-negative all slip past a naive `<= 0` check and
    // would mint a silently non-expiring or malformed-exp credential.
    throw new Error(
      "issueBrowserCredentials: ttlSeconds must be a finite positive number when provided (0/NaN/Infinity/negative would mint a non-expiring or malformed credential)",
    );
  }
  if (!o.peerId) {
    throw new Error("issueBrowserCredentials: peerId is required (the authenticated session subject)");
  }
  const minted = await mintNatsUserCreds({
    role: "browser",
    accountSeed: o.accountSeed,
    tenant: o.tenant,
    peerId: o.peerId,
    ...(o.issuerAccountId ? { issuerAccountId: o.issuerAccountId } : {}),
    ...(o.ttlSeconds ? { ttlSeconds: o.ttlSeconds } : {}),
  });
  return {
    userJwt: minted.userJwt,
    userSeedRaw: minted.userSeedRaw,
    permissions: minted.permissions,
  };
}
