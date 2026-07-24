import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  type Dirent,
  existsSync,
  fchmodSync,
  fstatSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
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
  fsyncDirectoryBestEffort,
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
const EXACT_SOURCE_FILE_NAME = "exact-credentials.json";
const EXACT_SOURCE_METADATA_FILE_NAME = "exact-source.json";
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

type ExactSourceFile = {
  version: 2;
  storageIdentity: StorageIdentityV2;
  credentialPathHash: string;
  sourceDev: number;
  sourceIno: number;
  sourceSha256: string;
};

type ExactCredentialSource = Readonly<{
  bytes: Buffer;
  dev: number;
  ino: number;
}>;

type FilesystemIdentity = Readonly<{ dev: number; ino: number }>;
type LegacySourceIdentity = Readonly<{
  directory: FilesystemIdentity;
  credential?: FilesystemIdentity;
  conversationKeys?: FilesystemIdentity;
}>;

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
  /** @internal Test-only seam after durable source move and before publication. */
  _afterSourceMove?: () => void;
  /** @internal Test-only seam for simulating a cross-device hard-link. */
  _linkExactSource?: (sourcePath: string, archivePath: string) => void;
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
  const backupRoot = join(legacy.root, BACKUP_DIRECTORY_NAME);
  const claimDirectory = join(
    backupRoot,
    `${options.accountId}--${destination.namespaceId}`,
  );
  const archivedSource = join(claimDirectory, SOURCE_DIRECTORY_NAME);
  const archivedExactCredential = join(
    claimDirectory,
    EXACT_SOURCE_FILE_NAME,
  );
  const exactSourceMetadata = join(
    claimDirectory,
    EXACT_SOURCE_METADATA_FILE_NAME,
  );
  const completed = join(claimDirectory, COMPLETE_FILE_NAME);

  if (existsSync(completed)) {
    verifyExistingDestinations(
      destination.scope,
      credentialDestination,
      destination.conversationKeyPath,
    );
    const marker = readCompletionFile(completed, destination.scope);
    return Object.freeze({
      status: "not-needed",
      credential: existsSync(credentialDestination) ? "preserved" : "absent",
      conversationKeys: existsSync(destination.conversationKeyPath)
        ? marker.conversationKeys
        : "absent",
    });
  }

  const canUseExactLegacySource =
    options.credentialPath !== undefined &&
    resolvePath(credentialDestination) !==
      resolvePath(destination.credentialPath);
  const hasExactJournal =
    existsSync(exactSourceMetadata) || existsSync(archivedExactCredential);
  if (hasExactJournal) {
    return migrateExactCredentialSource({
      scope: destination.scope,
      backupRoot,
      claimDirectory,
      archivedExactCredential,
      exactSourceMetadata,
      liveCredentialPath: credentialDestination,
      legacy,
      conversationKeyDestination: destination.conversationKeyPath,
      resumed: true,
      ...(options._afterClaim ? { afterClaim: options._afterClaim } : {}),
      ...(options._afterSourceMove
        ? { afterSourceMove: options._afterSourceMove }
        : {}),
      ...(options._linkExactSource
        ? { linkExactSource: options._linkExactSource }
        : {}),
    });
  }

  if (canUseExactLegacySource) {
    const exactCredential = inspectExactLegacyCredential(
      credentialDestination,
      destination.scope,
      true,
    );
    if (exactCredential.status === "owned") {
      return migrateExactCredentialSource({
        scope: destination.scope,
        backupRoot,
        claimDirectory,
        archivedExactCredential,
        exactSourceMetadata,
        liveCredentialPath: credentialDestination,
        legacy,
        conversationKeyDestination: destination.conversationKeyPath,
        resumed: false,
        exactCredential,
        ...(options._afterClaim ? { afterClaim: options._afterClaim } : {}),
        ...(options._afterSourceMove
          ? { afterSourceMove: options._afterSourceMove }
          : {}),
        ...(options._linkExactSource
          ? { linkExactSource: options._linkExactSource }
          : {}),
      });
    }
  }

  verifyExistingDestinations(
    destination.scope,
    credentialDestination,
    destination.conversationKeyPath,
  );

  if (existsSync(archivedSource)) {
    assertNoLiveForeignClaim(backupRoot, options.accountId, claimDirectory);
    claimMigration(claimDirectory, destination.scope);
    return migrateProvenArchive({
      scope: destination.scope,
      claimDirectory,
      sourceDirectory: archivedSource,
      credentialDestination,
      enforceCredentialDirectoryMode:
        credentialDestination === destination.credentialPath,
      conversationKeyDestination: destination.conversationKeyPath,
      resumed: true,
    });
  }

  const liveSource = inspectLegacySourceDirectory(legacy.directory);
  const liveCredential = liveSource?.credential
    ? inspectLegacyCredential(
        legacy.credentialPath,
        destination.scope,
        liveSource.credential,
      )
    : { status: "absent" as const };
  if (liveCredential.status === "other-owner") {
    return Object.freeze({
      status: "owned-by-other",
      credential: "absent",
      conversationKeys: "fresh",
    });
  }

  const legacyConversationExists = liveSource?.conversationKeys !== undefined;
  const legacyKeys = legacyConversationExists
    ? readLegacyConversationKeys(
        legacy.conversationKeyPath,
        destination.scope,
        liveSource.conversationKeys,
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
      if (!liveSource) {
        throw new StorageDocumentError(
          "conversation-keys",
          "legacy-migration-failed",
        );
      }
      assertLegacySourceAtPath(legacy.directory, liveSource);
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
      if (!liveSource) {
        throw new StorageDocumentError(
          "credentials",
          "legacy-migration-failed",
        );
      }
      assertLegacySourceAtPath(legacy.directory, liveSource);
      renameSync(legacy.directory, archivedSource);
      // Make both halves of the cross-directory rename durable before any v2
      // destination is published. Directory fsync remains best-effort on
      // platforms that do not support it.
      fsyncDirectoryBestEffort(legacy.root);
      fsyncDirectoryBestEffort(claimDirectory);
      assertLegacySourceAtPath(archivedSource, liveSource);
    }
  } catch {
    throw new StorageDocumentError("credentials", "legacy-migration-failed");
  }
  options._afterSourceMove?.();

  return migrateProvenArchive({
    scope: destination.scope,
    claimDirectory,
    sourceDirectory: archivedSource,
    credentialDestination,
    enforceCredentialDirectoryMode:
      credentialDestination === destination.credentialPath,
    conversationKeyDestination: destination.conversationKeyPath,
    resumed: false,
    sourceIdentity: liveSource,
  });
}

function migrateExactCredentialSource(input: {
  scope: StorageIdentityV2["storage"];
  backupRoot: string;
  claimDirectory: string;
  archivedExactCredential: string;
  exactSourceMetadata: string;
  liveCredentialPath: string;
  legacy: ReturnType<typeof legacyTuplePaths>;
  conversationKeyDestination: string;
  resumed: boolean;
  exactCredential?: {
    status: "owned";
    upgraded: ReturnType<typeof upgradeLegacyCredentialDocument>;
    source: ExactCredentialSource;
  };
  afterClaim?: () => void;
  afterSourceMove?: () => void;
  linkExactSource?: (sourcePath: string, archivePath: string) => void;
}): LegacyMigrationResult {
  const pathHash = credentialPathHash(input.liveCredentialPath);
  if (
    existsSync(input.archivedExactCredential) &&
    !existsSync(input.exactSourceMetadata)
  ) {
    // The metadata is durably published before archival. An archive without
    // that path-bound journal can never be a legitimate resumable state.
    throw new StorageDocumentError("credentials", "legacy-migration-failed");
  }
  const exactJournal = existsSync(input.exactSourceMetadata)
    ? readExactSourceFile(input.exactSourceMetadata, input.scope, pathHash)
    : undefined;

  const exactSourceIsArchived = existsSync(input.archivedExactCredential);
  const exactCredential = input.exactCredential ??
    inspectExactLegacyCredential(
      exactSourceIsArchived
        ? input.archivedExactCredential
        : input.liveCredentialPath,
      input.scope,
      !exactSourceIsArchived,
    );
  if (exactCredential.status !== "owned") {
    throw new StorageDocumentError("credentials", "legacy-migration-failed");
  }
  if (
    exactJournal &&
    exactJournal.sourceSha256 !==
      exactCredentialSourceDigest(exactCredential.source.bytes)
  ) {
    throw new StorageDocumentError("credentials", "legacy-migration-failed");
  }

  const archivedLegacyDirectory = join(
    input.claimDirectory,
    SOURCE_DIRECTORY_NAME,
  );
  const legacySourceWasArchived = existsSync(archivedLegacyDirectory);
  const legacySourceDirectory = legacySourceWasArchived
    ? archivedLegacyDirectory
    : input.legacy.directory;
  const legacySource = inspectLegacySourceDirectory(legacySourceDirectory);
  const legacyCredentialPath = legacySourceWasArchived
    ? join(archivedLegacyDirectory, "credentials.json")
    : input.legacy.credentialPath;
  const legacyConversationPath = legacySourceWasArchived
    ? join(archivedLegacyDirectory, "conversation-keys.json")
    : input.legacy.conversationKeyPath;

  // A bare-account credential is independent ownership evidence. If present,
  // it must agree with the exact override's complete storage/binding identity
  // before that override may authorize adoption of collocated legacy keys.
  const legacyCredential = legacySource?.credential
    ? inspectLegacyCredential(
        legacyCredentialPath,
        input.scope,
        legacySource.credential,
      )
    : { status: "absent" as const };
  if (
    legacyCredential.status !== "absent" &&
    (legacyCredential.status !== "owned" ||
      !isDeepStrictEqual(
        legacyCredential.upgraded[CREDENTIAL_IDENTITY_FIELD],
        exactCredential.upgraded[CREDENTIAL_IDENTITY_FIELD],
      ))
  ) {
    throw new StorageDocumentError("credentials", "legacy-migration-failed");
  }

  const legacyConversationExists =
    legacySource?.conversationKeys !== undefined;
  const legacyKeys = legacyConversationExists
    ? readLegacyConversationKeys(
        legacyConversationPath,
        input.scope,
        legacySource.conversationKeys,
      )
    : null;
  if (existsSync(input.conversationKeyDestination)) {
    const existing = parseConversationKeyDocument(
      input.scope,
      readStorageFile(
        input.conversationKeyDestination,
        "conversation-keys",
      ),
    );
    if (!conversationKeyMapsEqual(existing, legacyKeys ?? new Map())) {
      throw new StorageDocumentError(
        "conversation-keys",
        "legacy-migration-failed",
      );
    }
  }

  assertNoLiveForeignClaim(
    input.backupRoot,
    input.scope.accountId,
    input.claimDirectory,
  );
  claimMigration(input.claimDirectory, input.scope);
  const authorizedSource: ExactCredentialSource = exactJournal
    ? Object.freeze({
        bytes: exactCredential.source.bytes,
        dev: exactJournal.sourceDev,
        ino: exactJournal.sourceIno,
      })
    : exactCredential.source;
  const metadataCreated = publishExactSourceFile(
    input.exactSourceMetadata,
    input.scope,
    pathHash,
    authorizedSource,
  );
  input.afterClaim?.();

  try {
    archiveExactCredential(
      input.liveCredentialPath,
      input.archivedExactCredential,
      exactCredential.upgraded,
      authorizedSource,
      input.scope,
      input.linkExactSource ?? linkSync,
    );
  } catch (error) {
    if (
      metadataCreated &&
      !existsSync(input.archivedExactCredential)
    ) {
      try {
        unlinkSync(input.exactSourceMetadata);
        fsyncDirectoryBestEffort(dirname(input.exactSourceMetadata));
      } catch {
        // Preserve the archival failure. The path-bound metadata contains no
        // secret and a retry will validate it before doing any source work.
      }
    }
    throw error;
  }
  const archivedExact = inspectExactLegacyCredential(
    input.archivedExactCredential,
    input.scope,
  );
  if (
    archivedExact.status !== "owned" ||
    !isDeepStrictEqual(
      archivedExact.upgraded,
      exactCredential.upgraded,
    )
  ) {
    throw new StorageDocumentError("credentials", "legacy-migration-failed");
  }
  const movableLegacySource: LegacySourceIdentity | undefined =
    legacySource &&
    !legacySourceWasArchived &&
    resolvePath(input.liveCredentialPath) ===
      resolvePath(input.legacy.credentialPath)
      ? Object.freeze({
          directory: legacySource.directory,
          ...(legacySource.conversationKeys
            ? { conversationKeys: legacySource.conversationKeys }
            : {}),
        })
      : legacySource;
  try {
    if (
      movableLegacySource &&
      !legacySourceWasArchived
    ) {
      assertLegacySourceAtPath(input.legacy.directory, movableLegacySource);
      renameSync(input.legacy.directory, archivedLegacyDirectory);
      fsyncDirectoryBestEffort(input.legacy.root);
      fsyncDirectoryBestEffort(input.claimDirectory);
      assertLegacySourceAtPath(
        archivedLegacyDirectory,
        movableLegacySource,
      );
    }
  } catch {
    throw new StorageDocumentError("credentials", "legacy-migration-failed");
  }
  input.afterSourceMove?.();

  try {
    chmodSync(input.archivedExactCredential, 0o600);
    if (movableLegacySource) {
      hardenArchivedSource(
        archivedLegacyDirectory,
        movableLegacySource,
        false,
      );
    }
    publishCredential(
      input.scope,
      input.liveCredentialPath,
      exactCredential.upgraded,
      false,
    );
    publishConversationKeys(
      input.scope,
      input.conversationKeyDestination,
      legacyKeys ?? new Map(),
    );
    verifyMigratedDestinations(
      input.scope,
      input.liveCredentialPath,
      input.conversationKeyDestination,
      exactCredential.upgraded,
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

function inspectExactLegacyCredential(
  credentialPath: string,
  scope: StorageIdentityV2["storage"],
  requireSingleLink = false,
):
  | { status: "absent" | "not-legacy" }
  | {
      status: "owned";
      upgraded: ReturnType<typeof upgradeLegacyCredentialDocument>;
      source: ExactCredentialSource;
    } {
  if (!existsSync(credentialPath)) return { status: "absent" };
  let before: ReturnType<typeof lstatSync>;
  let bytes: Buffer;
  let after: ReturnType<typeof lstatSync>;
  try {
    before = lstatSync(credentialPath);
    if (!before.isFile() || before.isSymbolicLink()) {
      throw new StorageDocumentError("credentials", "storage-io-failed");
    }
    bytes = readFileSync(credentialPath);
    after = lstatSync(credentialPath);
    if (!sameInode(before, after)) {
      throw new StorageDocumentError("credentials", "storage-io-failed");
    }
  } catch (error) {
    if (error instanceof StorageDocumentError) throw error;
    throw new StorageDocumentError("credentials", "storage-io-failed");
  }
  let candidate: Record<string, unknown>;
  try {
    candidate = parseCredentialJson(bytes.toString("utf8"));
  } catch {
    return { status: "not-legacy" };
  }
  if (
    Object.prototype.hasOwnProperty.call(
      candidate,
      CREDENTIAL_IDENTITY_FIELD,
    ) ||
    !legacyCredentialProvesScope(scope, candidate)
  ) {
    return { status: "not-legacy" };
  }
  if (requireSingleLink && (before.nlink !== 1 || after.nlink !== 1)) {
    throw new StorageDocumentError(
      "credentials",
      "legacy-migration-failed",
    );
  }
  try {
    return {
      status: "owned",
      upgraded: upgradeLegacyCredentialDocument(scope, candidate),
      source: Object.freeze({
        bytes,
        dev: after.dev,
        ino: after.ino,
      }),
    };
  } catch {
    return { status: "not-legacy" };
  }
}

function archiveExactCredential(
  livePath: string,
  archivePath: string,
  upgraded: Record<string, unknown>,
  source: ExactCredentialSource,
  scope: StorageIdentityV2["storage"],
  link: (sourcePath: string, archivePath: string) => void,
): void {
  let createdArchive = false;
  if (!existsSync(archivePath)) {
    try {
      ensurePrivateDirectory(dirname(archivePath), true);
      assertLiveExactSource(livePath, source);
      try {
        link(livePath, archivePath);
        createdArchive = true;
        fsyncDirectoryBestEffort(dirname(archivePath));
      } catch (error) {
        if (!isExdev(error)) throw error;
        atomicWritePrivateFile(archivePath, source.bytes, {
          replace: false,
          enforceDirectoryMode: true,
        });
        createdArchive = true;
      }
    } catch (error) {
      if (!isEexist(error)) {
        throw new StorageDocumentError(
          "credentials",
          "legacy-migration-failed",
        );
      }
    }
  }

  try {
    const archivedBytes = readFileSync(archivePath);
    if (!archivedBytes.equals(source.bytes)) {
      throw new StorageDocumentError(
        "credentials",
        "legacy-migration-failed",
      );
    }
    const archived = inspectExactLegacyCredential(archivePath, scope);
    if (
      archived.status !== "owned" ||
      !isDeepStrictEqual(archived.upgraded, upgraded)
    ) {
      throw new StorageDocumentError(
        "credentials",
        "legacy-migration-failed",
      );
    }
    if (!existsSync(livePath)) return;

    const live = parseCredentialJson(readStorageFile(livePath, "credentials"));
    try {
      assertCredentialDocumentStorage(scope, live);
      if (!isDeepStrictEqual(live, upgraded)) {
        throw new StorageDocumentError(
          "credentials",
          "legacy-migration-failed",
        );
      }
      return;
    } catch (error) {
      if (
        error instanceof StorageDocumentError &&
        error.code !== "identity-unbound"
      ) {
        throw error;
      }
    }

    // Validate the same originally authorized inode and bytes immediately
    // before removing its live directory entry. A replacement observed at
    // either boundary is someone else's file and must remain untouched.
    assertLiveExactSource(livePath, source);
    unlinkSync(livePath);
    fsyncDirectoryBestEffort(dirname(livePath));
  } catch (error) {
    if (createdArchive && existsSync(archivePath)) {
      try {
        unlinkSync(archivePath);
        fsyncDirectoryBestEffort(dirname(archivePath));
      } catch {
        // Retaining a verified no-replace backup is safer than risking removal
        // of a path another process may now own.
      }
    }
    if (error instanceof StorageDocumentError) throw error;
    throw new StorageDocumentError("credentials", "legacy-migration-failed");
  }
}

function assertLiveExactSource(
  path: string,
  expected: ExactCredentialSource,
): void {
  let before: ReturnType<typeof lstatSync>;
  let bytes: Buffer;
  let after: ReturnType<typeof lstatSync>;
  try {
    before = lstatSync(path);
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.dev !== expected.dev ||
      before.ino !== expected.ino
    ) {
      throw new Error("exact source changed");
    }
    bytes = readFileSync(path);
    after = lstatSync(path);
  } catch {
    throw new StorageDocumentError("credentials", "legacy-migration-failed");
  }
  if (
    !sameInode(before, after) ||
    after.dev !== expected.dev ||
    after.ino !== expected.ino ||
    !bytes.equals(expected.bytes)
  ) {
    throw new StorageDocumentError("credentials", "legacy-migration-failed");
  }
}

function sameInode(
  left: { dev: number; ino: number },
  right: { dev: number; ino: number },
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function credentialPathHash(path: string): string {
  return createHash("sha256").update(path).digest("base64url");
}

function publishExactSourceFile(
  path: string,
  scope: StorageIdentityV2["storage"],
  pathHash: string,
  source: ExactCredentialSource,
): boolean {
  let created = false;
  if (!existsSync(path)) {
    try {
      atomicWritePrivateFile(
        path,
        JSON.stringify(
          {
            version: 2,
            storageIdentity: createStorageIdentityV2(scope),
            credentialPathHash: pathHash,
            sourceDev: source.dev,
            sourceIno: source.ino,
            sourceSha256: exactCredentialSourceDigest(source.bytes),
          } satisfies ExactSourceFile,
          null,
          2,
        ),
        { replace: false, enforceDirectoryMode: true },
      );
      created = true;
    } catch (error) {
      if (!isEexist(error)) throw error;
    }
  }
  const persisted = readExactSourceFile(path, scope, pathHash);
  if (
    persisted.sourceDev !== source.dev ||
    persisted.sourceIno !== source.ino ||
    persisted.sourceSha256 !== exactCredentialSourceDigest(source.bytes)
  ) {
    throw new StorageDocumentError("credentials", "legacy-migration-failed");
  }
  return created;
}

function readExactSourceFile(
  path: string,
  scope: StorageIdentityV2["storage"],
  pathHash: string,
): ExactSourceFile {
  try {
    const candidate = JSON.parse(
      readFileSync(path, "utf8"),
    ) as Partial<ExactSourceFile>;
    if (
      candidate.version !== 2 ||
      candidate.credentialPathHash !== pathHash ||
      !Number.isSafeInteger(candidate.sourceDev) ||
      !Number.isSafeInteger(candidate.sourceIno) ||
      (candidate.sourceDev ?? -1) < 0 ||
      (candidate.sourceIno ?? 0) <= 0 ||
      typeof candidate.sourceSha256 !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(candidate.sourceSha256)
    ) {
      throw new Error("invalid exact source");
    }
    assertDocumentStorageIdentity(
      "credentials",
      scope,
      candidate.storageIdentity,
    );
    return candidate as ExactSourceFile;
  } catch {
    throw new StorageDocumentError("credentials", "legacy-migration-failed");
  }
}

function exactCredentialSourceDigest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("base64url");
}

function migrateProvenArchive(input: {
  scope: StorageIdentityV2["storage"];
  claimDirectory: string;
  sourceDirectory: string;
  credentialDestination: string;
  enforceCredentialDirectoryMode: boolean;
  conversationKeyDestination: string;
  resumed: boolean;
  sourceIdentity?: LegacySourceIdentity;
}): LegacyMigrationResult {
  const sourceCredentialPath = join(input.sourceDirectory, "credentials.json");
  const sourceConversationPath = join(
    input.sourceDirectory,
    "conversation-keys.json",
  );
  const sourceIdentity =
    input.sourceIdentity ??
    inspectLegacySourceDirectory(input.sourceDirectory);
  if (!sourceIdentity?.credential) {
    throw new StorageDocumentError("credentials", "legacy-migration-failed");
  }
  assertLegacySourceAtPath(input.sourceDirectory, sourceIdentity);

  let upgradedCredential: ReturnType<typeof upgradeLegacyCredentialDocument>;
  try {
    upgradedCredential = upgradeLegacyCredentialDocument(
      input.scope,
      parseCredentialJson(
        readBoundSecretFile(
          sourceCredentialPath,
          sourceIdentity.credential,
          "credentials",
        ),
      ),
    );
  } catch (error) {
    if (isStorageIdentityError(error)) throw error;
    throw new StorageDocumentError("credentials", "legacy-migration-failed");
  }

  const legacyKeys = sourceIdentity.conversationKeys
    ? readLegacyConversationKeys(
        sourceConversationPath,
        input.scope,
        sourceIdentity.conversationKeys,
      )
    : null;

  // The 0700 claim directory already protects the archived material. Validate
  // every authoritative identity before changing source metadata, then harden
  // the archive before either destination can be published.
  hardenArchivedSource(
    input.sourceDirectory,
    sourceIdentity,
  );

  try {
    publishCredential(
      input.scope,
      input.credentialDestination,
      upgradedCredential,
      input.enforceCredentialDirectoryMode,
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
  identity: LegacySourceIdentity,
  credentialRequired = true,
): void {
  try {
    assertLegacySourceAtPath(sourceDirectory, identity);
    chmodBoundPath(sourceDirectory, identity.directory, 0o700, true);
    if (!identity.credential && credentialRequired) {
      throw new Error("missing credential identity");
    }
    if (identity.credential) {
      chmodBoundPath(
        join(sourceDirectory, "credentials.json"),
        identity.credential,
        0o600,
        false,
      );
    }
    if (identity.conversationKeys) {
      chmodBoundPath(
        join(sourceDirectory, "conversation-keys.json"),
        identity.conversationKeys,
        0o600,
        false,
      );
    }
  } catch {
    throw new StorageDocumentError("credentials", "legacy-migration-failed");
  }
}

function inspectLegacySourceDirectory(
  directory: string,
): LegacySourceIdentity | undefined {
  const inspect = (
    path: string,
    kind: "directory" | "file",
  ): FilesystemIdentity | undefined => {
    let entry: ReturnType<typeof lstatSync>;
    try {
      entry = lstatSync(path);
    } catch (error) {
      if (isEnoent(error)) return undefined;
      throw error;
    }
    if (
      entry.isSymbolicLink() ||
      (kind === "directory" ? !entry.isDirectory() : !entry.isFile()) ||
      (kind === "file" && entry.nlink !== 1)
    ) {
      throw new Error("unsafe legacy source");
    }
    return Object.freeze({ dev: entry.dev, ino: entry.ino });
  };
  try {
    const directoryIdentity = inspect(directory, "directory");
    if (!directoryIdentity) return undefined;
    const credential = inspect(join(directory, "credentials.json"), "file");
    const conversationKeys = inspect(
      join(directory, "conversation-keys.json"),
      "file",
    );
    return Object.freeze({
      directory: directoryIdentity,
      ...(credential ? { credential } : {}),
      ...(conversationKeys ? { conversationKeys } : {}),
    });
  } catch {
    throw new StorageDocumentError("credentials", "legacy-migration-failed");
  }
}

function assertLegacySourceAtPath(
  directory: string,
  expected: LegacySourceIdentity,
): void {
  const current = inspectLegacySourceDirectory(directory);
  const same = (
    left: FilesystemIdentity | undefined,
    right: FilesystemIdentity | undefined,
  ): boolean =>
    left === undefined
      ? right === undefined
      : right !== undefined &&
        left.dev === right.dev &&
        left.ino === right.ino;
  if (
    !current ||
    !same(current.directory, expected.directory) ||
    !same(current.credential, expected.credential) ||
    !same(
      current.conversationKeys,
      expected.conversationKeys,
    )
  ) {
    throw new StorageDocumentError("credentials", "legacy-migration-failed");
  }
}

function readBoundSecretFile(
  path: string,
  expected: FilesystemIdentity,
  document: "credentials" | "conversation-keys",
): string {
  try {
    return withBoundLegacySource(
      path,
      expected,
      false,
      (descriptor) => readFileSync(descriptor, "utf8"),
    );
  } catch {
    throw new StorageDocumentError(document, "legacy-migration-failed");
  }
}

function chmodBoundPath(
  path: string,
  expected: FilesystemIdentity,
  mode: number,
  directory: boolean,
): void {
  withBoundLegacySource(path, expected, directory, (descriptor) => {
    fchmodSync(descriptor, mode);
  });
}

function withBoundLegacySource<T>(
  path: string,
  expected: FilesystemIdentity,
  directory: boolean,
  action: (descriptor: number) => T,
): T {
  const descriptor = openSync(
    path,
    constants.O_RDONLY |
      constants.O_NOFOLLOW |
      (directory ? constants.O_DIRECTORY : 0),
  );
  const assertBound = (): void => {
    const entry = fstatSync(descriptor);
    if (
      entry.dev !== expected.dev ||
      entry.ino !== expected.ino ||
      (directory ? !entry.isDirectory() : !entry.isFile()) ||
      (!directory && entry.nlink !== 1)
    ) {
      throw new Error("legacy source changed");
    }
  };
  try {
    assertBound();
    const result = action(descriptor);
    assertBound();
    return result;
  } finally {
    closeSync(descriptor);
  }
}

function inspectLegacyCredential(
  credentialPath: string,
  scope: StorageIdentityV2["storage"],
  identity?: FilesystemIdentity,
):
  | { status: "absent" | "invalid" | "other-owner" }
  | {
      status: "owned";
      upgraded: ReturnType<typeof upgradeLegacyCredentialDocument>;
    } {
  if (!existsSync(credentialPath)) return { status: "absent" };
  let serialized: string;
  try {
    serialized = identity
      ? readBoundSecretFile(credentialPath, identity, "credentials")
      : readFileSync(credentialPath, "utf8");
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
    if (hasExplicitIdentity) {
      if (error instanceof StorageDocumentError) throw error;
      throw new StorageDocumentError("credentials", "legacy-migration-failed");
    }
    if (isStorageIdentityError(error)) throw error;
    return { status: "invalid" };
  }
}

function readLegacyConversationKeys(
  path: string,
  scope: StorageIdentityV2["storage"],
  identity?: FilesystemIdentity,
): Map<string, Uint8Array> | null {
  let serialized: string;
  try {
    serialized = identity
      ? readBoundSecretFile(path, identity, "conversation-keys")
      : readFileSync(path, "utf8");
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
    // The shared helper durably links every newly created backup/claim path
    // component before the claim can authorize moving live source material.
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
  enforceDirectoryMode: boolean,
): void {
  if (!existsSync(destination)) {
    try {
      atomicWritePrivateFile(
        destination,
        JSON.stringify(credential, null, 2),
        { replace: false, enforceDirectoryMode },
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

function isExdev(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "EXDEV"
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
