/**
 * Core types for the SaaS trust chain.
 *
 * This module defines the immutable artifacts produced by setupTrustChain:
 *  - saasTrustChain: RS256 keypair + NATS tenant seed + system credential
 *  - natsAccountConfig: operator/account JWTs + resolver config for real nats-server
 *  - jwksDocument: JWKS public key set for JWT verification
 *
 * These artifacts are the single source of truth for the control plane.
 */

/**
 * The SaaS trust chain root — PRIVATE material kept by SaaS.
 *
 * This is generated once by setupTrustChain and must be stored securely by the
 * SaaS operator. The private key signs all bootstrap JWTs and the account
 * signing seed signs NATS account/user JWTs.
 */
export type SaasTrustChainPrivate = {
  /**
   * RS256 private key (PKCS#8 PEM). Used to sign bootstrap JWTs issued to
   * browsers. The corresponding public key is published in the JWKS endpoint.
   */
  rsaPrivateKeyPem: string;

  /**
   * NATS account signing seed (NKEY seed, `SA…`). Signs the user JWTs minted
   * for enrolled agents and browsers.
   *
   * - Self-contained mode: a freshly generated account seed; its public key is
   *   also the account identity (user JWTs are self-signed, no issuer_account).
   * - External mode: the provided managed-account signing-key seed; user JWTs
   *   carry `iss` = this key's public and `nats.issuer_account` = the account
   *   identity (see ExternalNatsAccount). SECRET — never log, never persist it.
   */
  natsAccountSeed: string;

  /**
   * NATS operator NKEY seed (`SO…`) — the TRUST ROOT that signs the account JWT.
   * Present ONLY when setupTrustChain({ returnOperatorSeed: true }) in
   * self-contained mode; undefined otherwise (default, and always in external
   * mode — a managed account has no operator). SECRET, higher value than
   * natsAccountSeed: whoever holds it can re-sign/replace the account. Needed to
   * build per-credential revocation (see addRevocation). Never log; persist only
   * in the same 0600 store as natsAccountSeed.
   */
  operatorSeed?: string;

  /**
   * NATS `.creds` contents for the narrowly-scoped system-account user that
   * may publish account JWTs to `$SYS.REQ.CLAIMS.UPDATE` and receive the
   * request reply on `_INBOX.>`. Present only in self-contained mode.
   *
   * This contains a user NKEY seed. Treat it as a high-value secret: persist
   * it only in an owner-readable store, never log it, and never publish it as
   * part of the public NATS configuration.
   */
  systemAccountCredentials?: string;
};

/**
 * JWKS public key entry for the SaaS RSA public key.
 *
 * This is published at the SaaS's JWKS endpoint so plugins and browsers can
 * verify bootstrap JWTs.
 */
export type JwkRsaPublicKey = {
  kty: "RSA"; // Key type
  kid: string; // Key ID (unique identifier for rotation)
  alg?: "RS256"; // Algorithm (optional in JWKS but we always use RS256)
  use?: "sig"; // Public key use (signature)
  n: string; // Modulus (base64url-encoded)
  e: string; // Exponent (base64url-encoded, typically "AQAB")
};

/**
 * JWKS document containing the SaaS's RSA public keys.
 *
 * Published at the SaaS's JWKS endpoint (e.g., https://saas.com/.well-known/jwks.json).
 */
export type JwksDocument = {
  keys: JwkRsaPublicKey[];
};

/**
 * NATS operator JWT claims.
 *
 * The operator JWT is the root of the NATS trust chain. It's signed by the
 * operator NKEY (derived from the account signing seed) and contains the
 * operator's public key.
 */
export type NatsOperatorClaims = {
  iss: string; // Issuer (operator public NKEY)
  name: string; // Operator name
  sub: string; // Subject (operator public NKEY)
  nats?: {
    server?: {
      id?: string; // Server ID
    };
  };
};

/**
 * NATS account JWT claims.
 *
 * The account JWT defines tenant-level permissions and is signed by the
 * operator NKEY. Each tenant gets their own account JWT for isolation.
 */
export type NatsAccountClaims = {
  iss: string; // Issuer (operator public NKEY)
  name: string; // Account name (e.g., tenant ID)
  sub: string; // Subject (account public NKEY)
  nats: {
    limits?: {
      conn?: number; // Max connections
      subs?: number; // Max subscriptions
      data?: number; // Max bytes (optional)
      payload?: number; // Max payload bytes (optional)
    };
    importer?: {
      url?: string; // Account importer URL (optional)
    };
    publisher?: {
      requires?: boolean; // Whether publishers require auth (optional)
    };
  };
};

/**
 * NATS resolver configuration.
 *
 * The resolver maps account public keys to their JWTs. This config is loaded
 * by nats-server to enforce account-level authentication and authorization.
 *
 * Format: https://docs.nats.io/running-a-nats-service/configuration/securing_nats/auth_intro/jwt/resolver
 */
export type NatsResolverConfig = {
  /**
   * Map of account public NKEY to account JWT.
   *
   * nats-server loads this at startup and uses it to verify user JWTs issued
   * for this account. Self-contained servers preload these JWTs into their
   * writable full/Dir resolver at startup.
   */
  [accountPublicKey: string]: string; // account JWT (signed JWT string)
};

/**
 * Self-contained NATS account configuration for a SaaS-run nats-server.
 *
 * This is produced when the SaaS GENERATES its own operator + account (the
 * default mode). It carries everything a nats-server needs to enforce
 * JWT-based authentication and account/subject-level authorization.
 */
export type NatsSelfContainedAccountConfig = {
  /**
   * Discriminator. `"self-contained"` (the default — may be omitted) = the SaaS
   * generated the operator/account and runs (or ships config for) its own
   * nats-server. Absent ⇒ self-contained (legacy persisted files predate it).
   */
  mode?: "self-contained";

  /**
   * NATS operator JWT (compact JWT string).
   *
   * The operator JWT is the root of the NATS trust chain. It's signed by the
   * operator NKEY and contains the operator's public key.
   */
  operatorJwt: string;

  /**
   * NATS account JWT (compact JWT string).
   *
   * The account JWT defines tenant-level permissions and is signed by the
   * operator NKEY. Each tenant gets their own account JWT for isolation.
   */
  accountJwt: string;

  /**
   * Resolver config mapping account public NKEY to account JWT.
   *
   * These entries seed the writable full/Dir resolver in nats.conf.
   */
  resolverConfig: NatsResolverConfig;

  /**
   * Account public NKEY (extracted from the account signing seed).
   *
   * This is used as the resolver config key and must be embedded in the
   * nats-server configuration.
   */
  accountPublicKey: string;

  /**
   * Public NKEY of the dedicated NATS system account. The operator JWT names
   * the same account as its system account, and the full resolver is seeded
   * with that account's JWT.
   */
  systemAccountPublicKey: string;
};

/**
 * External (managed) NATS account configuration — e.g. Synadia Cloud / NGS.
 *
 * In this mode the SaaS does NOT run the nats-server, so there is no operator
 * JWT, account JWT, resolver config, or nats.conf to emit (Synadia hosts the
 * server and already trusts the account). The SaaS only mints user JWTs on
 * behalf of the provided account identity, signed with the provided account
 * signing key. These absent fields are intentionally NOT present (not faked
 * with empty values).
 */
export type NatsExternalAccountConfig = {
  /**
   * Discriminator. `"external"` = a managed account (Synadia/NGS) whose
   * nats-server the SaaS does not run.
   */
  mode: "external";

  /**
   * Account identity public NKEY (`A…`). This is the `issuer_account` stamped
   * into every minted user JWT so the managed resolver accepts the connection.
   */
  accountPublicKey: string;
};

/**
 * The complete NATS account configuration for the control plane.
 *
 * Discriminated on `mode`:
 *  - `"self-contained"` — SaaS-generated operator/account (default; full config)
 *  - `"external"` — managed account (Synadia/NGS); no operator/account/resolver
 */
export type NatsAccountConfig =
  | NatsSelfContainedAccountConfig
  | NatsExternalAccountConfig;

/**
 * Externally-managed NATS account material (e.g. Synadia Cloud / NGS).
 *
 * When supplied to setupTrustChain, the SaaS mints user JWTs on behalf of this
 * account instead of generating its own operator/account. Both fields are read
 * from env/config and the `signingSeed` is a SECRET — never logged, never
 * written to any output file.
 */
export type ExternalNatsAccount = {
  /**
   * Account signing-key seed (`SA…`). Signs the user JWTs. Its public key
   * (`A…`) becomes the JWT `iss`; it is a signing key listed on the managed
   * account, distinct from the account identity (`accountId`).
   */
  signingSeed: string;

  /**
   * Account identity public NKEY (`A…`). Becomes `nats.issuer_account` in each
   * minted user JWT so the managed resolver maps the user to this account.
   */
  accountId: string;
};

/**
 * The complete output of setupTrustChain.
 *
 * This includes both private material (SaaS only) and public configuration
 * (nats-server + JWKS endpoint).
 */
export type SetupTrustChainResult = {
  /**
   * Private material kept by SaaS. Never share outside SaaS infrastructure.
   */
  private: SaasTrustChainPrivate;

  /**
   * NATS configuration for nats-server.
   *
   * This includes operator/account JWTs and resolver config. The operator
   * JWT and resolver config must be loaded by nats-server at startup.
   */
  natsConfig: NatsAccountConfig;

  /**
   * JWKS document for the SaaS's RSA public key.
   *
   * Publish this at the SaaS's JWKS endpoint so plugins and browsers can
   * verify bootstrap JWTs.
   */
  jwks: JwksDocument;

  /**
   * Key ID for the RSA keypair.
   *
   * This is embedded in JWT headers and used for key lookup in JWKS.
   * Generated as a UUID during setupTrustChain.
   */
  kid: string;
};
