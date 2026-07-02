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

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";

import { setupTrustChain, type SetupTrustChainOptions } from "./setup-trust-chain.js";
import type {
  SetupTrustChainResult,
  NatsSelfContainedAccountConfig,
  ExternalNatsAccount,
} from "./types.js";

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
// Overloads mirror setupTrustChain: a self-contained caller (no external
// account) keeps the concrete operator/account/resolver fields.
export function loadOrCreateTrustChain(
  path: string,
  options?: SetupTrustChainOptions & { externalNatsAccount?: undefined },
): Promise<SetupTrustChainResult & { natsConfig: NatsSelfContainedAccountConfig }>;
export function loadOrCreateTrustChain(
  path: string,
  options: SetupTrustChainOptions & { externalNatsAccount: ExternalNatsAccount },
): Promise<SetupTrustChainResult>;
export function loadOrCreateTrustChain(
  path: string,
  options: SetupTrustChainOptions,
): Promise<SetupTrustChainResult>;
export async function loadOrCreateTrustChain(
  path: string,
  options: SetupTrustChainOptions = {},
): Promise<SetupTrustChainResult> {
  // External mode: the SaaS does not own the account; the signing seed is a
  // secret provided via env/config. We NEVER persist that seed — the file holds
  // only the RSA key + JWKS + account id, and the seed is re-overlaid from the
  // env-provided material on every load/create.
  const external = options.externalNatsAccount;

  if (existsSync(path)) {
    const parsed = parsePersistedFile(path);
    // Legacy files predate the `mode` discriminator — treat them as self-contained.
    if (parsed?.natsConfig && parsed.natsConfig.mode === undefined) {
      (parsed.natsConfig as { mode?: string }).mode = "self-contained";
    }
    assertPersistedShape(parsed, path);
    if (parsed.natsConfig.mode === "external" && !external) {
      // The signing seed is never written to disk, so an external file is
      // unusable without the env-provided secret. Fail fast and clearly here
      // rather than minting later with an empty seed (cryptic nkeys error).
      throw new Error(
        `external trust chain at ${path} requires the signing seed ` +
          `(NATS_ACCOUNT_SIGNING_SEED) — refusing to load without it`,
      );
    }
    if (external) {
      // Re-inject the env secret + account id (stripped before persistence).
      parsed.private.natsAccountSeed = external.signingSeed;
      parsed.natsConfig = { mode: "external", accountPublicKey: external.accountId };
    }
    return parsed;
  }

  const chain = await setupTrustChain(options);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  // In external mode, strip the signing seed before writing it to disk. The
  // in-memory `chain` we return keeps it.
  const toPersist: SetupTrustChainResult = external
    ? { ...chain, private: { ...chain.private, natsAccountSeed: "" } }
    : chain;
  writeFileAtomic(path, JSON.stringify(toPersist, null, 2));
  return chain;
}

/**
 * A3: read + parse the persisted file, turning a raw `JSON.parse` SyntaxError
 * into an actionable error. Failing loudly on a corrupt file is intended (§ the
 * comment on {@link assertPersistedShape}) — a silently-regenerated chain would
 * invalidate every enrolled agent. This just makes the failure legible: which
 * file, that it's corrupt, and how to recover.
 */
function parsePersistedFile(path: string): SetupTrustChainResult {
  const raw = readFileSync(path, "utf-8");
  try {
    return JSON.parse(raw) as SetupTrustChainResult;
  } catch (err) {
    throw new Error(
      `persisted trust chain at ${path} is corrupt (not valid JSON): ${(err as Error).message}. ` +
        `This usually means a previous write was interrupted. Restore it from backup, or — only if ` +
        `you accept re-enrolling every agent — delete the file to mint a fresh chain on next boot.`,
    );
  }
}

/**
 * A3: write `path` atomically so an interrupted write (crash / disk-full) can
 * NEVER leave a partial file that bricks every subsequent boot. We write to a
 * process-unique temp file in the SAME directory (so `rename` is a same-filesystem
 * atomic swap) and rename it into place; readers only ever see a fully-written
 * file or the previous one, never a truncated mix. The temp is cleaned up on a
 * write failure.
 *
 * Note: this eliminates corruption from a partial write. Two processes doing a
 * concurrent FIRST boot (no file yet) still race on the final rename (last writer
 * wins, loser runs an in-memory chain not on disk) — acceptable because the
 * deployment model is a single launchd-managed issuer.
 */
function writeFileAtomic(path: string, data: string): void {
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  try {
    writeFileSync(tmp, data, { mode: 0o600 });
    renameSync(tmp, path);
  } catch (err) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      // best-effort temp cleanup; surface the original write error below
    }
    throw err;
  }
}

/**
 * Fail loudly on a truncated/legacy file rather than silently yielding an issuer
 * that mints creds no nats-server will accept. External-mode files legitimately
 * lack the operator/account/resolver fields and the persisted account seed.
 */
function assertPersistedShape(parsed: SetupTrustChainResult, path: string): void {
  const baseOk = parsed?.private?.rsaPrivateKeyPem && parsed?.kid && parsed?.natsConfig;
  if (!baseOk) {
    throw new Error(`persisted trust chain at ${path} is missing required fields`);
  }
  if (parsed.natsConfig.mode === "external") {
    if (!parsed.natsConfig.accountPublicKey) {
      throw new Error(`persisted external trust chain at ${path} is missing accountPublicKey`);
    }
    return;
  }
  if (
    !parsed.private.natsAccountSeed ||
    !parsed.natsConfig.operatorJwt ||
    !parsed.natsConfig.accountJwt ||
    !parsed.natsConfig.resolverConfig
  ) {
    throw new Error(`persisted trust chain at ${path} is missing required fields`);
  }
}
