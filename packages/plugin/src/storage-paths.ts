import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

import {
  createStorageIdentityV2,
  deriveStorageNamespaceId,
  type StorageScopeIdentity,
} from "./storage-identity.js";

/**
 * V2 intentionally uses a different default root from legacy binaries. This
 * prevents an old process from treating a v2 namespace directory as one of its
 * bare-account stores during the stop-all, one-way cutover.
 */
export const DEFAULT_STORAGE_ROOT_NAME = ".openclaw-webchannel-v2";
export const LEGACY_STORAGE_ROOT_NAME = ".openclaw-webchannel";

export const CREDENTIAL_FILE_NAME = "credentials.json";
export const CONVERSATION_KEY_FILE_NAME = "conversation-keys.json";
export const CONVERSATION_KEY_GENERATIONS_FILE_NAME =
  "conversation-key-generations.json";
/**
 * v6 delivery journal (issue #239) — the plugin-owned durable event log.
 *
 * It lives in the SAME tuple directory as the two secret stores rather than in
 * core's shared state dir (which doc §15.2 named). The journal holds message
 * PLAINTEXT, so it belongs behind the same tenant/account isolation as the
 * conversation keys that protect that plaintext in transit: this directory has a
 * validated namespace derivation (`storage-identity.ts`) and owner-only handling
 * (`private-file.ts:ensurePrivateDirectory`), and core's state dir would give the
 * journal LESS separation than the keys. Full reasoning in
 * `delivery-journal.ts`'s docblock.
 */
export const DELIVERY_JOURNAL_FILE_NAME = "delivery-journal.sqlite";

export type TupleStoragePathOptions = StorageScopeIdentity & {
  /** Common v2 root for both tuple-scoped secret-bearing stores. */
  storageRoot?: string;
  /** Home-directory seam used only when storageRoot is omitted. */
  home?: string;
};

export type TupleStoragePaths = Readonly<{
  scope: StorageScopeIdentity;
  namespaceId: string;
  storageRoot: string;
  directory: string;
  credentialPath: string;
  conversationKeyPath: string;
  conversationKeyGenerationsPath: string;
  deliveryJournalPath: string;
}>;

export type CredentialPathOptions = TupleStoragePathOptions & {
  /**
   * Absolute exact credential-file override. It never changes the tuple
   * directory or the conversation-key path.
   */
  credentialPath?: string;
};

/** Default v2 storage root. */
export function defaultStorageRoot(home: string = homedir()): string {
  return join(home, DEFAULT_STORAGE_ROOT_NAME);
}

/** Legacy v1 storage root, used only by the migration boundary. */
export function legacyStorageRoot(home: string = homedir()): string {
  return join(home, LEGACY_STORAGE_ROOT_NAME);
}

/**
 * Build the one canonical tuple directory used by both v2 stores.
 *
 * Scope validation happens before any path construction, and neither raw tenant
 * nor raw account id is interpolated into a v2 path.
 */
export function tupleStoragePaths(
  options: TupleStoragePathOptions,
): TupleStoragePaths {
  const scope = createStorageIdentityV2({
    tenant: options?.tenant as string,
    accountId: options?.accountId as string,
  }).storage;
  const storageRoot = options.storageRoot === undefined
    ? defaultStorageRoot(options.home)
    : validateStorageRoot(options.storageRoot);
  const namespaceId = deriveStorageNamespaceId(scope);
  const directory = join(storageRoot, namespaceId);
  return Object.freeze({
    scope,
    namespaceId,
    storageRoot,
    directory,
    credentialPath: join(directory, CREDENTIAL_FILE_NAME),
    conversationKeyPath: join(directory, CONVERSATION_KEY_FILE_NAME),
    conversationKeyGenerationsPath: join(
      directory,
      CONVERSATION_KEY_GENERATIONS_FILE_NAME,
    ),
    deliveryJournalPath: join(directory, DELIVERY_JOURNAL_FILE_NAME),
  });
}

/**
 * Resolve the credential file without changing the meaning of an exact
 * credentialPath override. Calling this still validates the tuple first.
 */
export function resolveCredentialPath(options: CredentialPathOptions): string {
  const paths = tupleStoragePaths(options);
  return options.credentialPath === undefined
    ? paths.credentialPath
    : validateAbsolutePath(options.credentialPath, "credentialPath");
}

export type LegacyTuplePaths = Readonly<{
  root: string;
  directory: string;
  credentialPath: string;
  conversationKeyPath: string;
}>;

/** Bare-account v1 locations. Tenant is deliberately not accepted here. */
export function legacyTuplePaths(
  accountId: string,
  home: string = homedir(),
): LegacyTuplePaths {
  // Reuse the shared scope validator without inventing a second account-id
  // contract. The tenant is a fixed valid sentinel and never reaches a path.
  const validatedAccountId = createStorageIdentityV2({
    tenant: "legacy",
    accountId,
  }).storage.accountId;
  const root = legacyStorageRoot(home);
  const directory = join(root, validatedAccountId);
  return Object.freeze({
    root,
    directory,
    credentialPath: join(directory, CREDENTIAL_FILE_NAME),
    conversationKeyPath: join(directory, CONVERSATION_KEY_FILE_NAME),
  });
}

/** Older pre-account single-file location retained only for runbook cleanup. */
export function legacySingleFileCredentialPath(
  home: string = homedir(),
): string {
  return join(legacyStorageRoot(home), CREDENTIAL_FILE_NAME);
}

function validatePathOverride(value: string, field: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\0")
  ) {
    throw new Error(`webchannel: ${field} must be a non-empty filesystem path`);
  }
  return value;
}

function validateStorageRoot(value: string): string {
  return validateAbsolutePath(value, "storageRoot");
}

function validateAbsolutePath(value: string, field: string): string {
  const validated = validatePathOverride(value, field);
  if (!isAbsolute(validated)) {
    throw new Error(
      `webchannel: ${field} must be an absolute filesystem path`,
    );
  }
  return validated;
}
