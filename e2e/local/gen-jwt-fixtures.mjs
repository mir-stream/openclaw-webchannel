#!/usr/bin/env node
/**
 * RS256 signing-key + JWKS fixture generator for the JWT-register E2E.
 *
 * The plugin's NATS register hop (`…{peerId}.register`) verifies the bootstrap
 * JWT against `channels.webchannel.auth.jwt` — here a `jwksFile`. This script mints
 * the RS256 keypair the scenario needs:
 *
 *   - `jwks.json`             → the PUBLIC key as a JWK (kid="webchannel-e2e-rs256",
 *                                alg=RS256, use=sig), wrapped as { keys: [...] }.
 *                                The gateway loads this as its JWKS source.
 *   - `rs256-private.jwk.json`→ the PRIVATE key as a JWK so the Node driver can
 *                                re-import it and RS256-sign the bootstrap JWT.
 *
 * MUST run BEFORE the gateway boots so `jwksFile` exists at plugin-load time.
 *
 * Usage: node e2e/local/gen-jwt-fixtures.mjs [outDir]   (default /tmp/oc-e2e)
 */
import { webcrypto } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const KID = "webchannel-e2e-rs256";
const outDir = process.argv[2] || "/tmp/oc-e2e";
mkdirSync(outDir, { recursive: true });

const { publicKey, privateKey } = await webcrypto.subtle.generateKey(
  {
    name: "RSASSA-PKCS1-v1_5",
    modulusLength: 2048,
    publicExponent: new Uint8Array([0x01, 0x00, 0x01]),
    hash: "SHA-256",
  },
  true, // extractable — we export both halves to disk
  ["sign", "verify"],
);

const pubJwk = await webcrypto.subtle.exportKey("jwk", publicKey);
pubJwk.kid = KID;
pubJwk.alg = "RS256";
pubJwk.use = "sig";

const privJwk = await webcrypto.subtle.exportKey("jwk", privateKey);
privJwk.kid = KID;
privJwk.alg = "RS256";

const jwksPath = join(outDir, "jwks.json");
const privPath = join(outDir, "rs256-private.jwk.json");

writeFileSync(jwksPath, `${JSON.stringify({ keys: [pubJwk] }, null, 2)}\n`);
writeFileSync(privPath, `${JSON.stringify(privJwk, null, 2)}\n`);
// Belt-and-braces: lock the RS256 private signing key to owner read/write only.
chmodSync(privPath, 0o600);

console.log(`[gen-jwt-fixtures] JWKS         → ${jwksPath}`);
console.log(`[gen-jwt-fixtures] RS256 private → ${privPath}`);
