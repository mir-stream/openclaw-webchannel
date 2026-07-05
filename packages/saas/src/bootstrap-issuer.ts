/**
 * Bootstrap JWT issuer — the RS256 SIGNING half of the bootstrap flow.
 *
 * `buildBootstrapClaims` (bootstrap-claims.ts) produces the claim OBJECT; this
 * module signs it into a compact JWT with the SaaS trust-chain RSA key. It is the
 * public, safe counterpart so a consumer never hand-rolls webcrypto RS256 (the
 * footgun this whole reference app is meant to remove).
 *
 * Promoted from the demo's proven `importRsaPrivateKeyFromPem` + `signBootstrapJwt`
 * (demo/saas-server.ts). Unlike the demo's mutable module-level `activeSigner`,
 * a `BootstrapIssuer` captures the key + kid at creation time and is IMMUTABLE:
 * key rotation = create a NEW issuer with the fresh kid/PEM.
 *
 * CONTRACT: the `kid` an issuer captures MUST exist in the JWKS being served
 * (`/.well-known/jwks.json`), or the plugin's JWKS lookup fails closed. On
 * rotation, refresh the served JWKS and re-create the issuer together. When both
 * derive from one `loadOrCreateTrustChain` result, they are automatically in sync.
 */

import { webcrypto } from "node:crypto";

import type { BootstrapClaims } from "./bootstrap-claims.js";

/** An immutable RS256 signer for bootstrap JWTs. */
export type BootstrapIssuer = {
  /**
   * Serialize `{alg:"RS256",typ:"JWT",kid}` + the claims payload and RS256-sign
   * them with the captured RSA key, returning a compact (3-part) JWT.
   */
  sign(claims: BootstrapClaims): Promise<string>;
};

/** Import a PKCS#8 PEM RSA private key for RS256 signing (RSASSA-PKCS1-v1_5 / SHA-256). */
async function importRsaPrivateKeyFromPem(pem: string): Promise<webcrypto.CryptoKey> {
  const body = pem
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/\s/g, "");
  const der = Buffer.from(body, "base64");
  return webcrypto.subtle.importKey(
    "pkcs8",
    new Uint8Array(der),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

/**
 * Create an immutable RS256 bootstrap-JWT issuer.
 *
 * @param opts.rsaPrivateKeyPem PKCS#8 PEM RSA private key = `trustChain.private.rsaPrivateKeyPem`.
 * @param opts.kid Key id stamped into the JWT header = `trustChain.kid`. MUST be
 *   present in the served JWKS (see module contract).
 */
export async function createBootstrapIssuer(opts: {
  rsaPrivateKeyPem: string;
  kid: string;
}): Promise<BootstrapIssuer> {
  const signingKey = await importRsaPrivateKeyFromPem(opts.rsaPrivateKeyPem);
  const kid = opts.kid;
  const b64urlJson = (obj: unknown): string =>
    Buffer.from(JSON.stringify(obj)).toString("base64url");

  return {
    async sign(claims: BootstrapClaims): Promise<string> {
      const header = { alg: "RS256", typ: "JWT", kid };
      const signingInput = `${b64urlJson(header)}.${b64urlJson(claims)}`;
      const sig = await webcrypto.subtle.sign(
        { name: "RSASSA-PKCS1-v1_5" },
        signingKey,
        new TextEncoder().encode(signingInput),
      );
      return `${signingInput}.${Buffer.from(new Uint8Array(sig)).toString("base64url")}`;
    },
  };
}
