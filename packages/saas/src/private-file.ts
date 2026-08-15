import { randomBytes } from "node:crypto";
import {
  closeSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

type DirectoryIdentity = Pick<Stats, "dev" | "ino" | "uid">;

/**
 * Atomically publish private bytes as a regular, owner-only file.
 *
 * The caller-owned destination directory must already exist, must not itself
 * be a symlink, and must not be writable by group or others. Existing symlink
 * destinations are rejected before the bytes are written. A unique sibling
 * temporary file is fsynced and atomically renamed into place.
 */
export function atomicWritePrivateFile(
  filePath: string,
  data: string | Uint8Array,
): void {
  const destination = resolve(filePath);
  const directory = dirname(destination);
  const initialDirectory = assertSafeOwnedDirectory(directory);
  assertReplaceableDestination(destination);

  const temporaryPath = join(
    directory,
    `.${basename(destination)}.tmp-${process.pid}-${randomBytes(12).toString("hex")}`,
  );
  let descriptor: number | undefined;
  let temporaryExists = false;
  try {
    descriptor = openSync(temporaryPath, "wx", 0o600);
    temporaryExists = true;
    fchmodSync(descriptor, 0o600);
    const temporaryIdentity = fstatSync(descriptor);

    // No private bytes have been written yet. Recheck the directory and final
    // destination after creating the temporary entry so path substitution or a
    // newly inserted destination symlink fails closed.
    assertSameSafeOwnedDirectory(directory, initialDirectory);
    assertReplaceableDestination(destination);

    writeFileSync(descriptor, data);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;

    assertSameSafeOwnedDirectory(directory, initialDirectory);
    assertReplaceableDestination(destination);
    const temporaryEntry = lstatSync(temporaryPath);
    if (
      temporaryEntry.isSymbolicLink() ||
      !temporaryEntry.isFile() ||
      temporaryEntry.dev !== temporaryIdentity.dev ||
      temporaryEntry.ino !== temporaryIdentity.ino ||
      (temporaryEntry.mode & 0o777) !== 0o600
    ) {
      throw new Error("private-file temporary entry changed before publication");
    }

    renameSync(temporaryPath, destination);
    temporaryExists = false;

    assertSameSafeOwnedDirectory(directory, initialDirectory);
    const published = lstatSync(destination);
    if (
      published.isSymbolicLink() ||
      !published.isFile() ||
      published.dev !== temporaryIdentity.dev ||
      published.ino !== temporaryIdentity.ino ||
      (published.mode & 0o777) !== 0o600
    ) {
      throw new Error("private-file publication did not produce a mode-0600 regular file");
    }
    assertCurrentOwner(published, "published private file");
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

function assertSafeOwnedDirectory(directory: string): DirectoryIdentity {
  let entry: Stats;
  try {
    entry = lstatSync(directory);
  } catch (error) {
    throw new Error(`private-file destination directory is unavailable: ${directory}`, {
      cause: error,
    });
  }
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    throw new Error(`private-file destination root must be a real directory: ${directory}`);
  }
  assertCurrentOwner(entry, "private-file destination root");
  if ((entry.mode & 0o022) !== 0) {
    throw new Error(
      `private-file destination root must not be writable by group or others: ${directory}`,
    );
  }
  return { dev: entry.dev, ino: entry.ino, uid: entry.uid };
}

function assertSameSafeOwnedDirectory(
  directory: string,
  expected: DirectoryIdentity,
): void {
  const current = assertSafeOwnedDirectory(directory);
  if (
    current.dev !== expected.dev ||
    current.ino !== expected.ino ||
    current.uid !== expected.uid
  ) {
    throw new Error(`private-file destination root changed during write: ${directory}`);
  }
}

function assertReplaceableDestination(destination: string): void {
  try {
    const entry = lstatSync(destination);
    if (entry.isSymbolicLink()) {
      throw new Error(`private-file destination must not be a symlink: ${destination}`);
    }
    if (!entry.isFile()) {
      throw new Error(`private-file destination must be a regular file: ${destination}`);
    }
  } catch (error) {
    if (isFilesystemErrorCode(error, "ENOENT")) return;
    throw error;
  }
}

function assertCurrentOwner(entry: Stats, label: string): void {
  const currentUid = process.getuid?.();
  if (currentUid !== undefined && entry.uid !== currentUid) {
    throw new Error(`${label} must be owned by the current user`);
  }
}

function fsyncDirectoryBestEffort(directory: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(directory, "r");
    fsyncSync(descriptor);
  } catch {
    // Some supported filesystems reject directory fsync. File contents and the
    // atomic rename have already completed, so this barrier remains best effort.
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

function isFilesystemErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}
