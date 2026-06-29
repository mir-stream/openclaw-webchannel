/**
 * Persistent trust chain — load-or-create wrapper around setupTrustChain.
 *
 * setupTrustChain() generates a FRESH operator/account/RSA chain on every call,
 * which is correct for a one-shot harness but fatal for a long-lived issuer: a
 * restart would mint new keys, invalidating every already-enrolled agent's cached
 * NATS user creds (NKEY auth fails) and every bootstrap JWT (the JWKS kid changes).
 *
 * A SetupTrustChainResult is ENTIRELY serializable (RSA private PEM, NATS account
 * seed, operator/account JWTs, resolver map, JWKS, kid) — the issuer only ever
 * needs those values, never the live nkey KeyPair objects. So persistence is
 * simply: generate once, JSON-serialize to a 0600 file, reload thereafter.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { setupTrustChain, type SetupTrustChainOptions } from "./setup-trust-chain.js";
import type { SetupTrustChainResult } from "./types.js";

/**
 * Load a persisted trust chain from `path`, or create + persist a new one.
 *
 * The file holds the SaaS trust root (RSA private key + NATS account signing
 * seed), so it is written with mode 0600 and its parent dir created mode 0700. On
 * every subsequent boot the SAME chain is returned verbatim, so already-enrolled
 * agents keep NKEY-authenticating and issued bootstrap JWTs keep verifying across
 * restarts — the invariant a launchd-managed issuer (and the live gateway that
 * depends on it) requires.
 */
export async function loadOrCreateTrustChain(
  path: string,
  options: SetupTrustChainOptions = {},
): Promise<SetupTrustChainResult> {
  if (existsSync(path)) {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as SetupTrustChainResult;
    // Minimal shape guard: a truncated/legacy file must fail loudly, not silently
    // yield an issuer that mints creds no nats-server will accept.
    if (
      !parsed?.private?.rsaPrivateKeyPem ||
      !parsed?.private?.natsAccountSeed ||
      !parsed?.natsConfig?.operatorJwt ||
      !parsed?.natsConfig?.accountJwt ||
      !parsed?.natsConfig?.resolverConfig ||
      !parsed?.kid
    ) {
      throw new Error(`persisted trust chain at ${path} is missing required fields`);
    }
    return parsed;
  }

  const chain = await setupTrustChain(options);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(chain, null, 2), { mode: 0o600 });
  return chain;
}
