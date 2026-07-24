import { randomBytes } from "node:crypto";
import {
  chmodSync,
  type Dirent,
  existsSync,
  readFileSync,
  readdirSync,
  renameSync,
} from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

import {
  CREDENTIAL_IDENTITY_FIELD,
  assertCredentialDocumentStorage,
  legacyCredentialProvesScope,
  parseCredentialJson,
  upgradeLegacyCredentialDocument,
} from "./credential-document.js";
import {
  conversationKeyMapsEqual,
  parseConversationKeyDocument,
  parseLegacyConversationKeyDocument,
  serializeConversationKeyDocument,
} from "./conversation-key-document.js";
import {
  archiveFileNoReplace,
  atomicWritePrivateFile,
  ensurePrivateDirectory,
} from "./private-file.js";
import {
  legacyTuplePaths,
  resolveCredentialPath,
  tupleStoragePaths,
  type CredentialPathOptions,
} from "./storage-paths.js";
import {
  createStorageIdentityV2,
  type StorageIdentityV2,
} from "./storage-identity.js";
import {
  assertDocumentStorageIdentity,
  StorageDocumentError,
} from "./storage-document.js";

const BACKUP_DIRECTORY_NAME = ".legacy-v1-backups";
const CLAIM_FILE_NAME = "migration-claim.json";
const SOURCE_DIRECTORY_NAME = "source";
const COMPLETE_FILE_NAME = "migration-complete.json";
const STORAGE_NAMESPACE_ID_LENGTH = "v2_".length + 43;
const STORAGE_NAMESPACE_ID_PATTERN = /^v2_[A-Za-z0-9_-]{43}$/;

type ClaimFile = {
  version: 2;
  storageIdentity: StorageIdentityV2;
  ownerPid: number;
};

type CompletionFile = {
  version: 2;
  storageIdentity: StorageIdentityV2;
  credential: "migrated";
  conversationKeys: "fresh" | "migrated";
};

export type LegacyMigrationResult = Readonly<{
  status:
    | "not-needed"
    | "migrated"
    | "resumed"
    | "owned-by-other"
    | "ambiguous-quarantined";
  credential: "absent" | "preserved" | "migrated";
  conversationKeys: "absent" | "fresh" | "migrated";
}>;

export type LegacyMigrationOptions = CredentialPathOptions & {
  /** @internal Test-only seam after an exclusive claim and before source move. */
  _afterClaim?: () => void;
};

/**
 * Inspect and, when provenance is proven, migrate the complete legacy tuple.
 *
 * This is synchronous so every secret consumer can run it before returning any
 * credential or conversation key. The live legacy directory is atomically
 * renamed into a deterministic recoverable backup before any v2 destination is
 * published. A completion marker is written only after both destinations have
 * been parsed and verified.
 */
export function migrateLegacyTupleState(
  options: LegacyMigrationOptions,
): LegacyMigrationResult {
  const destination = tupleStoragePaths(options);
  const credentialDestination = resolveCredentialPath(options);
  const legacy = legacyTuplePaths(options.accountId, options.home);

  verifyExistingDestinations(
    destination.scope,
    credentialDestination,
    destination.conversationKeyPath,
  );

  const backupRoot = join(legacy.root, BACKUP_DIRECTORY_NAME);
  const claimDirectory = join(
    backupRoot,
    `${options.accountId}--${destination.namespaceId}`,
  );
  const archivedSource = join(claimDirectory, SOURCE_DIRECTORY_NAME);
  const completed = join(claimDirectory, COMPLETE_FILE_NAME);

  if (existsSync(completed)) {
    const marker = readCompletionFile(completed, destination.scope);
    return Object.freeze({
      status: "not-needed",
      credential: existsSync(credentialDestination) ? "preserved" : "absent",
      conversationKeys: existsSync(destination.conversationKeyPath)
        ? marker.conversationKeys
        : "absent",
    });
  }

  if (existsSync(archivedSource)) {
    assertNoLiveForeignClaim(backupRoot, options.accountId, claimDirectory);
    claimMigration(claimDirectory, destination.scope);
    return migrateProvenArchive({
      scope: destination.scope,
      claimDirectory,
      sourceDirectory: archivedSource,
      credentialDestination,
      conversationKeyDestination: destination.conversationKeyPath,
      resumed: true,
    });
  }

  const liveCredential = inspectLegacyCredential(
    legacy.credentialPath,
    destination.scope,
  );
  if (liveCredential.status === "other-owner") {
    return Object.freeze({
      status: "owned-by-other",
      credential: "absent",
      conversationKeys: "fresh",
    });
  }

  const legacyConversationExists = existsSync(legacy.conversationKeyPath);
  const legacyKeys = legacyConversationExists
    ? readLegacyConversationKeys(
        legacy.conversationKeyPath,
        destination.scope,
      )
    : null;

  if (liveCredential.status !== "owned") {
    if (!legacyConversationExists) {
      return Object.freeze({
        status: "not-needed",
        credential: "absent",
        conversationKeys: "absent",
      });
    }
    if (existsSync(destination.conversationKeyPath)) {
      const existing = parseConversationKeyDocument(
        destination.scope,
        readStorageFile(
          destination.conversationKeyPath,
          "conversation-keys",
        ),
      );
      if (existing.size > 0) {
        throw new StorageDocumentError(
          "conversation-keys",
          "legacy-migration-failed",
        );
      }
    }
    assertNoLiveForeignClaim(backupRoot, options.accountId, claimDirectory);
    const archive =
      `${legacy.conversationKeyPath}.ambiguous-v2-` +
      `${destination.namespaceId}-${randomBytes(8).toString("hex")}`;
    try {
      archiveFileNoReplace(legacy.conversationKeyPath, archive);
      publishEmptyConversationStore(
        destination.scope,
        destination.conversationKeyPath,
      );
    } catch {
      throw new StorageDocumentError(
        "conversation-keys",
        "legacy-migration-failed",
      );
    }
    return Object.freeze({
      status: "ambiguous-quarantined",
      credential: "absent",
      conversationKeys: "fresh",
    });
  }

  // Validate and transform every candidate before the first mutation.
  const upgradedCredential = liveCredential.upgraded;
  assertDestinationsCompatible(
    destination.scope,
    credentialDestination,
    destination.conversationKeyPath,
    upgradedCredential,
    legacyKeys ?? new Map(),
  );
  assertNoLiveForeignClaim(backupRoot, options.accountId, claimDirectory);
  claimMigration(claimDirectory, destination.scope);
  options._afterClaim?.();

  try {
    if (!existsSync(archivedSource)) {
      renameSync(legacy.directory, archivedSource);
    }
  } catch {
    throw new StorageDocumentError("credentials", "legacy-migration-failed");
  }

  return migrateProvenArchive({
    scope: destination.scope,
    claimDirectory,
    sourceDirectory: archivedSource,
    credentialDestination,
    conversationKeyDestination: destination.conversationKeyPath,
    resumed: false,
  });
}

function migrateProvenArchive(input: {
  scope: StorageIdentityV2["storage"];
  claimDirectory: string;
  sourceDirectory: string;
  credentialDestination: string;
  conversationKeyDestination: string;
  resumed: boolean;
}): LegacyMigrationResult {
  const sourceCredentialPath = join(input.sourceDirectory, "credentials.json");
  const sourceConversationPath = join(
    input.sourceDirectory,
    "conversation-keys.json",
  );

  let upgradedCredential: ReturnType<typeof upgradeLegacyCredentialDocument>;
  try {
    upgradedCredential = upgradeLegacyCredentialDocument(
      input.scope,
      parseCredentialJson(readFileSync(sourceCredentialPath, "utf8")),
    );
  } catch (error) {
    if (isStorageIdentityError(error)) throw error;
    throw new StorageDocumentError("credentials", "legacy-migration-failed");
  }

  const legacyKeys = existsSync(sourceConversationPath)
    ? readLegacyConversationKeys(sourceConversationPath, input.scope)
    : null;

  // The 0700 claim directory already protects the archived material. Validate
  // every authoritative identity before changing source metadata, then harden
  // the archive before either destination can be published.
  hardenArchivedSource(
    input.sourceDirectory,
    sourceCredentialPath,
    sourceConversationPath,
  );

  try {
    publishCredential(
      input.scope,
      input.credentialDestination,
      upgradedCredential,
    );
    publishConversationKeys(
      input.scope,
      input.conversationKeyDestination,
      legacyKeys ?? new Map(),
    );
    verifyMigratedDestinations(
      input.scope,
      input.credentialDestination,
      input.conversationKeyDestination,
      upgradedCredential,
      legacyKeys ?? new Map(),
    );
    atomicWritePrivateFile(
      join(input.claimDirectory, COMPLETE_FILE_NAME),
      JSON.stringify(
        {
          version: 2,
          storageIdentity: createStorageIdentityV2(input.scope),
          credential: "migrated",
          conversationKeys: legacyKeys ? "migrated" : "fresh",
        } satisfies CompletionFile,
        null,
        2,
      ),
      { replace: true, enforceDirectoryMode: true },
    );
  } catch (error) {
    if (error instanceof StorageDocumentError) throw error;
    throw new StorageDocumentError("credentials", "legacy-migration-failed");
  }

  return Object.freeze({
    status: input.resumed ? "resumed" : "migrated",
    credential: "migrated",
    conversationKeys: legacyKeys ? "migrated" : "fresh",
  });
}

/**
 * Legacy enrollment created its account directory without an explicit mode and
 * could retain broader modes on existing secret files. Harden only after the
 * source has been atomically moved under the owner-only backup boundary. A
 * crash before this point leaves the 0700 claim directory as the outer access
 * control; resume retries these chmods before publishing either destination.
 */
function hardenArchivedSource(
  sourceDirectory: string,
  credentialPath: string,
  conversationPath: string,
): void {
  try {
    chmodSync(sourceDirectory, 0o700);
    chmodSync(credentialPath, 0o600);
    if (existsSync(conversationPath)) chmodSync(conversationPath, 0o600);
  } catch {
    throw new StorageDocumentError("credentials", "legacy-migration-failed");
  }
}

function inspectLegacyCredential(
  credentialPath: string,
  scope: StorageIdentityV2["storage"],
):
  | { status: "absent" | "invalid" | "other-owner" }
  | {
      status: "owned";
      upgraded: ReturnType<typeof upgradeLegacyCredentialDocument>;
    } {
  if (!existsSync(credentialPath)) return { status: "absent" };
  let serialized: string;
  try {
    serialized = readFileSync(credentialPath, "utf8");
  } catch {
    throw new StorageDocumentError("credentials", "legacy-migration-failed");
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = parseCredentialJson(serialized);
  } catch {
    return { status: "invalid" };
  }
  const hasExplicitIdentity = Object.prototype.hasOwnProperty.call(
    parsed,
    CREDENTIAL_IDENTITY_FIELD,
  );
  if (!hasExplicitIdentity && !legacyCredentialProvesScope(scope, parsed)) {
    const hasScopeLabels =
      typeof parsed.tenant === "string" &&
      typeof parsed.accountId === "string";
    return { status: hasScopeLabels ? "other-owner" : "invalid" };
  }
  try {
    return {
      status: "owned",
      upgraded: upgradeLegacyCredentialDocument(scope, parsed),
    };
  } catch (error) {
    if (isStorageIdentityError(error)) throw error;
    return { status: "invalid" };
  }
}

function readLegacyConversationKeys(
  path: string,
  scope: StorageIdentityV2["storage"],
): Map<string, Uint8Array> | null {
  let serialized: string;
  try {
    serialized = readFileSync(path, "utf8");
  } catch {
    throw new StorageDocumentError(
      "conversation-keys",
      "legacy-migration-failed",
    );
  }
  try {
    return parseLegacyConversationKeyDocument(scope, serialized);
  } catch (error) {
    if (isStorageIdentityError(error)) throw error;
    // Ordinary malformed key material is retained in the recoverable archive
    // but never adopted into a v2 tuple.
    return null;
  }
}

function isStorageIdentityError(
  error: unknown,
): error is StorageDocumentError {
  return (
    error instanceof StorageDocumentError &&
    (error.code === "identity-unbound" ||
      error.code === "identity-incomplete" ||
      error.code === "identity-invalid" ||
      error.code === "identity-mismatch")
  );
}

function claimMigration(
  claimDirectory: string,
  scope: StorageIdentityV2["storage"],
): void {
  const claimPath = join(claimDirectory, CLAIM_FILE_NAME);
  try {
    ensurePrivateDirectory(claimDirectory, true);
  } catch {
    throw new StorageDocumentError(
      "credentials",
      "legacy-claim-conflict",
    );
  }
  const serialized = JSON.stringify(
    {
      version: 2,
      storageIdentity: createStorageIdentityV2(scope),
      ownerPid: process.pid,
    } satisfies ClaimFile,
    null,
    2,
  );

  // The claim file itself is the atomic lock. Creating the directory is not a
  // claim: another process can observe it before its creator publishes a file.
  // A no-replace hard-link publish closes that narrow race completely.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      atomicWritePrivateFile(claimPath, serialized, {
        replace: false,
        enforceDirectoryMode: true,
      });
      return;
    } catch (error) {
      if (!isEexist(error)) {
        throw new StorageDocumentError(
          "credentials",
          "legacy-claim-conflict",
        );
      }
    }

    const claim = readClaimFile(claimPath, scope);
    if (claim.ownerPid === process.pid) return;
    if (processIsAlive(claim.ownerPid)) {
      throw new StorageDocumentError(
        "credentials",
        "legacy-claim-conflict",
      );
    }

    // Preserve a dead owner's claim before takeover. If two recovery processes
    // race here, only one can unlink the old claim; both then contend again via
    // the same atomic no-replace publish above.
    const stalePath =
      `${claimPath}.stale-${claim.ownerPid}-` +
      randomBytes(8).toString("hex");
    try {
      archiveFileNoReplace(claimPath, stalePath);
    } catch (error) {
      if (isEnoent(error)) continue;
      throw new StorageDocumentError(
        "credentials",
        "legacy-claim-conflict",
      );
    }
  }

  throw new StorageDocumentError(
    "credentials",
    "legacy-claim-conflict",
  );
}

function readClaimFile(
  claimPath: string,
  scope: StorageIdentityV2["storage"],
): ClaimFile {
  try {
    const candidate = JSON.parse(
      readFileSync(claimPath, "utf8"),
    ) as Partial<ClaimFile>;
    if (
      candidate.version !== 2 ||
      !Number.isSafeInteger(candidate.ownerPid) ||
      (candidate.ownerPid ?? 0) <= 0
    ) {
      throw new Error("invalid claim");
    }
    assertDocumentStorageIdentity(
      "credentials",
      scope,
      candidate.storageIdentity,
    );
    return candidate as ClaimFile;
  } catch {
    throw new StorageDocumentError(
      "credentials",
      "legacy-claim-conflict",
    );
  }
}

function readCompletionFile(
  markerPath: string,
  scope: StorageIdentityV2["storage"],
): CompletionFile {
  try {
    const candidate = JSON.parse(
      readFileSync(markerPath, "utf8"),
    ) as Partial<CompletionFile>;
    if (
      candidate.version !== 2 ||
      candidate.credential !== "migrated" ||
      (candidate.conversationKeys !== "fresh" &&
        candidate.conversationKeys !== "migrated")
    ) {
      throw new Error("invalid completion marker");
    }
    assertDocumentStorageIdentity(
      "credentials",
      scope,
      candidate.storageIdentity,
    );
    return candidate as CompletionFile;
  } catch {
    throw new StorageDocumentError(
      "credentials",
      "legacy-migration-failed",
    );
  }
}

function assertNoLiveForeignClaim(
  backupRoot: string,
  accountId: string,
  ownClaimDirectory: string,
): void {
  if (!existsSync(backupRoot)) return;
  let entries: Dirent[];
  try {
    entries = readdirSync(backupRoot, { withFileTypes: true });
  } catch {
    throw new StorageDocumentError("credentials", "storage-io-failed");
  }
  for (const entry of entries) {
    if (
      !entry.isDirectory() ||
      claimDirectoryAccountId(entry.name) !== accountId
    ) {
      continue;
    }
    const candidate = join(backupRoot, entry.name);
    if (candidate === ownClaimDirectory) continue;
    if (existsSync(join(candidate, COMPLETE_FILE_NAME))) continue;
    throw new StorageDocumentError("credentials", "legacy-claim-conflict");
  }
}

/**
 * Decode the existing `<accountId>--<v2 namespace>` claim naming without using
 * a prefix match. The fixed namespace length makes the final separator
 * unambiguous even when a valid account id itself contains `--`.
 */
function claimDirectoryAccountId(name: string): string | undefined {
  const separatorIndex = name.length - STORAGE_NAMESPACE_ID_LENGTH - 2;
  if (
    separatorIndex <= 0 ||
    name.slice(separatorIndex, separatorIndex + 2) !== "--"
  ) {
    return undefined;
  }
  const namespaceId = name.slice(separatorIndex + 2);
  if (!STORAGE_NAMESPACE_ID_PATTERN.test(namespaceId)) return undefined;
  return name.slice(0, separatorIndex);
}

function verifyExistingDestinations(
  scope: StorageIdentityV2["storage"],
  credentialPath: string,
  conversationPath: string,
): void {
  if (existsSync(credentialPath)) {
    const credential = parseCredentialJson(
      readStorageFile(credentialPath, "credentials"),
    );
    assertCredentialDocumentStorage(scope, credential);
  }
  if (existsSync(conversationPath)) {
    try {
      parseConversationKeyDocument(
        scope,
        readStorageFile(conversationPath, "conversation-keys"),
      );
    } catch (error) {
      // The store's established corruption policy owns ordinary malformed
      // content. Migration only intercepts identity failures, which must never
      // be mistaken for permission to quarantine and start serving.
      if (
        error instanceof StorageDocumentError &&
        error.code === "invalid-document"
      ) {
        return;
      }
      throw error;
    }
  }
}

function assertDestinationsCompatible(
  scope: StorageIdentityV2["storage"],
  credentialPath: string,
  conversationPath: string,
  credential: Record<string, unknown>,
  keys: ReadonlyMap<string, Uint8Array>,
): void {
  if (existsSync(credentialPath)) {
    const existing = parseCredentialJson(
      readStorageFile(credentialPath, "credentials"),
    );
    assertCredentialDocumentStorage(scope, existing);
    if (!isDeepStrictEqual(existing, credential)) {
      throw new StorageDocumentError(
        "credentials",
        "legacy-migration-failed",
      );
    }
  }
  if (existsSync(conversationPath)) {
    const existing = parseConversationKeyDocument(
      scope,
      readStorageFile(conversationPath, "conversation-keys"),
    );
    if (!conversationKeyMapsEqual(existing, keys)) {
      throw new StorageDocumentError(
        "conversation-keys",
        "legacy-migration-failed",
      );
    }
  }
}

function publishCredential(
  scope: StorageIdentityV2["storage"],
  destination: string,
  credential: Record<string, unknown>,
): void {
  if (!existsSync(destination)) {
    try {
      atomicWritePrivateFile(
        destination,
        JSON.stringify(credential, null, 2),
        { replace: false, enforceDirectoryMode: true },
      );
    } catch (error) {
      if (!isEexist(error)) throw error;
    }
  }
  const existing = parseCredentialJson(
    readStorageFile(destination, "credentials"),
  );
  assertCredentialDocumentStorage(scope, existing);
  if (!isDeepStrictEqual(existing, credential)) {
    throw new StorageDocumentError("credentials", "legacy-migration-failed");
  }
}

function publishConversationKeys(
  scope: StorageIdentityV2["storage"],
  destination: string,
  keys: ReadonlyMap<string, Uint8Array>,
): void {
  if (!existsSync(destination)) {
    try {
      atomicWritePrivateFile(
        destination,
        serializeConversationKeyDocument(scope, keys),
        { replace: false, enforceDirectoryMode: true },
      );
    } catch (error) {
      if (!isEexist(error)) throw error;
    }
  }
  const existing = parseConversationKeyDocument(
    scope,
    readStorageFile(destination, "conversation-keys"),
  );
  if (!conversationKeyMapsEqual(existing, keys)) {
    throw new StorageDocumentError(
      "conversation-keys",
      "legacy-migration-failed",
    );
  }
}

function publishEmptyConversationStore(
  scope: StorageIdentityV2["storage"],
  destination: string,
): void {
  if (!existsSync(destination)) {
    try {
      atomicWritePrivateFile(
        destination,
        serializeConversationKeyDocument(scope, new Map()),
        { replace: false, enforceDirectoryMode: true },
      );
    } catch (error) {
      if (!isEexist(error)) throw error;
    }
  }
  const parsed = parseConversationKeyDocument(
    scope,
    readStorageFile(destination, "conversation-keys"),
  );
  if (parsed.size !== 0) {
    throw new StorageDocumentError(
      "conversation-keys",
      "legacy-migration-failed",
    );
  }
}

function verifyMigratedDestinations(
  scope: StorageIdentityV2["storage"],
  credentialPath: string,
  conversationPath: string,
  expectedCredential: Record<string, unknown>,
  expectedKeys: ReadonlyMap<string, Uint8Array>,
): void {
  const credential = parseCredentialJson(
    readStorageFile(credentialPath, "credentials"),
  );
  assertCredentialDocumentStorage(scope, credential);
  if (!isDeepStrictEqual(credential, expectedCredential)) {
    throw new StorageDocumentError("credentials", "legacy-migration-failed");
  }
  const keys = parseConversationKeyDocument(
    scope,
    readStorageFile(conversationPath, "conversation-keys"),
  );
  if (!conversationKeyMapsEqual(keys, expectedKeys)) {
    throw new StorageDocumentError(
      "conversation-keys",
      "legacy-migration-failed",
    );
  }
}

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code === "EPERM"
    );
  }
}

function isEexist(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "EEXIST"
  );
}

function readStorageFile(
  filePath: string,
  document: "credentials" | "conversation-keys",
): string {
  try {
    return readFileSync(filePath, "utf8");
  } catch {
    throw new StorageDocumentError(document, "storage-io-failed");
  }
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
