/**
 * Core types for the SaaS trust chain.
 *
 * This module defines the immutable artifacts produced by setupTrustChain:
 *  - saasTrustChain: The SaaS's RS256 keypair + NATS account signing seed
 *  - natsAccountConfig: operator/account JWT + resolver config for real nats-server
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
   * NATS account signing seed (NKEY seed). Used to sign NATS operator and
   * account JWTs. The corresponding public NKEY is embedded in the resolver
   * config and NATS operator/account JWTs.
   *
   * Format: "SA..." where 'S' = operator, 'A' = account (NATS category byte).
   */
  natsAccountSeed: string;
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
 * Format: https://docs.nats.io/running-a-nats-service/configuration/resolver#memory-resolver
 */
export type NatsResolverConfig = {
  /**
   * Map of account public NKEY to account JWT.
   *
   * nats-server loads this at startup and uses it to verify user JWTs issued
   * for this account. The resolver URL can be omitted (memory resolver) for
   * static configurations.
   */
  [accountPublicKey: string]: string; // account JWT (signed JWT string)
};

/**
 * The complete NATS account configuration for nats-server.
 *
 * This includes:
 *  - operator JWT (signed by operator NKEY)
 *  - resolver config (maps account NKEYs to account JWTs)
 *
 * nats-server loads this configuration to enforce JWT-based authentication
 * and account/subject-level authorization.
 */
export type NatsAccountConfig = {
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
   * This can be embedded directly in nats.conf (memory resolver) or hosted
   * as a static file/service URL.
   */
  resolverConfig: NatsResolverConfig;

  /**
   * Account public NKEY (extracted from the account signing seed).
   *
   * This is used as the resolver config key and must be embedded in the
   * nats-server configuration.
   */
  accountPublicKey: string;
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
