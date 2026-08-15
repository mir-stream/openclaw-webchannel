/**
 * Persistent trust chain — load-or-create wrapper around setupTrustChain.
 *
 * setupTrustChain() generates a FRESH operator/account/RSA chain on every call,
 * which is correct for a one-shot harness but fatal for a long-lived issuer: a
 * restart would mint new keys, invalidating every already-enrolled agent's cached
 * NATS user creds (NKEY auth fails) and every bootstrap JWT (the JWKS kid changes).
 *
 * A SetupTrustChainResult is ENTIRELY serializable (RSA private PEM, NATS account
 * seed, system credential, operator/account JWTs, resolver map, JWKS, kid) — the
 * issuer only ever needs those values, never the live nkey KeyPair objects. So
 * persistence is simply: generate once, JSON-serialize to a 0600 file, reload.
 */

import { dirname } from "node:path";

import {
  atomicWritePrivateFile,
  ensurePrivateDirectory,
  readPrivateFileIfExists,
} from "./private-file.js";
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
 * seed, system credential, and optionally operator seed), so new parent dirs are
 * 0700 and the file is exactly 0600. Existing roots and files are loaded only
 * after owner/mode/type checks and an O_NOFOLLOW descriptor/inode binding. This
 * closes disclosure through paths writable by a different OS user; Node's
 * path-based APIs do not provide a complete malicious-same-uid boundary.
 *
 * Creation fsyncs a unique same-directory temporary file and atomically renames
 * it, so a crash cannot publish a partial JSON document. Two concurrent FIRST
 * boots can still race at the final rename (the deployment contract remains one
 * issuer process). On every subsequent boot the SAME chain is returned verbatim,
 * preserving enrolled NATS credentials and bootstrap-JWT verification.
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
  const parent = dirname(path);
  let persisted: string | undefined;
  try {
    ensurePrivateDirectory(parent);
    persisted = readPrivateFileIfExists(path);
  } catch (error) {
    throw persistedStorageError(path, "read", error);
  }

  if (persisted !== undefined) {
    const parsed = parsePersistedFile(path, persisted);
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
  // In external mode, strip the signing seed before writing it to disk. The
  // in-memory `chain` we return keeps it.
  const toPersist: SetupTrustChainResult = external
    ? { ...chain, private: { ...chain.private, natsAccountSeed: "" } }
    : chain;
  try {
    atomicWritePrivateFile(path, JSON.stringify(toPersist, null, 2));
  } catch (error) {
    throw persistedStorageError(path, "write", error);
  }
  return chain;
}

function persistedStorageError(
  path: string,
  operation: "read" | "write",
  cause: unknown,
): Error {
  const detail = cause instanceof Error ? cause.message : "unknown filesystem failure";
  return new Error(
    `persisted trust chain at ${path} failed secure ${operation}: ${detail}`,
    { cause },
  );
}

/**
 * A3: read + parse the persisted file, turning a raw `JSON.parse` SyntaxError
 * into an actionable error. Failing loudly on a corrupt file is intended (§ the
 * comment on {@link assertPersistedShape}) — a silently-regenerated chain would
 * invalidate every enrolled agent. This just makes the failure legible: which
 * file, that it's corrupt, and how to recover.
 */
function parsePersistedFile(path: string, raw: string): SetupTrustChainResult {
  try {
    return JSON.parse(raw) as SetupTrustChainResult;
  } catch {
    // Recent Node versions may include a slice of the rejected input in the
    // SyntaxError message. The persisted document contains authority secrets,
    // so do not attach or interpolate the parser error here.
    throw new Error(
      `persisted trust chain at ${path} is corrupt (not valid JSON). ` +
        `This usually means a previous write was interrupted. Restore it from backup, or — only if ` +
        `you accept re-enrolling every agent — delete the file to mint a fresh chain on next boot.`,
    );
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

  const hasSystemAccount =
    parsed.natsConfig.systemAccountPublicKey &&
    parsed.private.systemAccountCredentials &&
    parsed.natsConfig.resolverConfig[parsed.natsConfig.systemAccountPublicKey];
  if (!hasSystemAccount) {
    const cause = parsed.private.operatorSeed
      ? "it predates system-account support, and automatic migration is intentionally disabled"
      : "it was created without an operator seed, so it cannot sign the system account required for runtime account-claim updates";
    throw new Error(
      `persisted trust chain at ${path} has no usable system account: ${cause}. ` +
        `For a disposable demo/e2e chain, delete ${path} and restart to regenerate it; ` +
        `do not delete a production trust root as a migration strategy.`,
    );
  }
}
