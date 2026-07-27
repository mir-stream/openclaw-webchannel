import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * Create a directory tree with an owner-only leaf directory.
 *
 * When recursive mkdir creates a chain, fsync every parent containing a new
 * entry from the outermost entry inward. That prevents a later durable file or
 * completion marker from outliving one of its newly created path components.
 * Existing parent modes are never changed.
 */
export function ensurePrivateDirectory(
  directory: string,
  enforceExistingMode = false,
): void {
  const firstCreated = mkdirSync(directory, {
    recursive: true,
    mode: 0o700,
  });
  if (firstCreated !== undefined) {
    fsyncCreatedDirectoryChain(firstCreated, directory);
  }
  if (enforceExistingMode) chmodSync(directory, 0o700);
}

function fsyncCreatedDirectoryChain(
  firstCreated: string,
  directory: string,
): void {
  const first = resolve(firstCreated);
  let current = resolve(directory);
  const parents: string[] = [];

  while (true) {
    parents.unshift(dirname(current));
    if (current === first) break;
    const parent = dirname(current);
    // mkdirSync's recursive result is contractually the first created path,
    // hence an ancestor. Keep the durability enhancement best-effort if a
    // platform ever returns an unexpected value.
    if (parent === current) {
      fsyncDirectoryBestEffort(dirname(first));
      return;
    }
    current = parent;
  }

  for (const parent of parents) fsyncDirectoryBestEffort(parent);
}

/**
 * Atomically publish a complete owner-only file.
 *
 * Temporary names are per-write and live beside the destination, so distinct
 * tuples and concurrent writers cannot collide. `replace=false` uses a hard
 * link as an atomic no-overwrite publish operation.
 */
export function atomicWritePrivateFile(
  filePath: string,
  data: string | Uint8Array,
  options: { replace?: boolean; enforceDirectoryMode?: boolean } = {},
): void {
  const directory = dirname(filePath);
  ensurePrivateDirectory(directory, options.enforceDirectoryMode ?? false);
  const temporaryPath =
    `${filePath}.tmp-${process.pid}-${randomBytes(12).toString("hex")}`;
  let descriptor: number | undefined;
  let temporaryExists = false;
  try {
    descriptor = openSync(temporaryPath, "wx", 0o600);
    temporaryExists = true;
    writeFileSync(descriptor, data);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;

    if (options.replace === false) {
      linkSync(temporaryPath, filePath);
      unlinkSync(temporaryPath);
      temporaryExists = false;
    } else {
      renameSync(temporaryPath, filePath);
      temporaryExists = false;
    }
    fsyncDirectoryBestEffort(directory);
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // Preserve the original write failure.
      }
    }
    if (temporaryExists) {
      try {
        unlinkSync(temporaryPath);
      } catch {
        // A failed cleanup leaves only a uniquely named, unpublished temp file.
      }
    }
  }
}

/**
 * Move a file aside without ever replacing an existing archive.
 *
 * link+unlink is used because Node's rename primitive may replace an existing
 * file. The archive parent and shared source/archive inode are hardened before
 * unlinking the source. A crash between the two leaves two recoverable links,
 * never data loss.
 */
export function archiveFileNoReplace(
  sourcePath: string,
  archivePath: string,
): void {
  ensurePrivateDirectory(dirname(archivePath), true);
  linkSync(sourcePath, archivePath);
  chmodSync(archivePath, 0o600);
  fsyncDirectoryBestEffort(dirname(archivePath));
  unlinkSync(sourcePath);
  fsyncDirectoryBestEffort(dirname(sourcePath));
}

/**
 * Best-effort durability barrier for directory-entry changes.
 *
 * Some supported platforms/filesystems reject opening or fsyncing a
 * directory, so callers must not depend on this throwing.
 */
export function fsyncDirectoryBestEffort(directory: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(directory, "r");
    fsyncSync(descriptor);
  } catch {
    // Some supported filesystems do not allow fsync on a directory. File data
    // itself has already been fsynced, so this remains the safest fallback.
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // Best effort only.
      }
    }
  }
}
