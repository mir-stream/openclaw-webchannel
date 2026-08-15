import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

type DirectoryIdentity = Pick<Stats, "dev" | "ino" | "uid">;

/**
 * Create an absent private directory and validate the caller-owned leaf.
 *
 * Newly created leaves are forced to 0700. Existing directories retain their
 * mode but must be real, owned by the current uid, and not writable by group or
 * others (0755/0750 caller-owned deployment roots remain compatible).
 *
 * @internal Not barrel-exported; persistence code shares the file policy
 * without expanding the package's public API.
 */
export function ensurePrivateDirectory(directory: string): void {
  const resolvedDirectory = resolve(directory);
  const firstCreated = mkdirSync(resolvedDirectory, {
    recursive: true,
    mode: 0o700,
  });
  if (firstCreated !== undefined) {
    chmodSync(resolvedDirectory, 0o700);
    fsyncCreatedDirectoryChain(firstCreated, resolvedDirectory);
  }
  assertSafeOwnedDirectory(resolvedDirectory);
}

function fsyncCreatedDirectoryChain(firstCreated: string, directory: string): void {
  const first = resolve(firstCreated);
  let current = resolve(directory);
  const parents: string[] = [];

  while (true) {
    parents.unshift(dirname(current));
    if (current === first) break;
    const parent = dirname(current);
    if (parent === current) {
      // `mkdirSync({ recursive: true })` should return an ancestor. If a
      // platform violates that contract, retain safe modes and make only the
      // directory-entry durability enhancement best effort.
      fsyncDirectoryBestEffort(dirname(first));
      return;
    }
    current = parent;
  }

  for (const parent of parents) fsyncDirectoryBestEffort(parent);
}

/**
 * Securely read an optional owner-only regular file without following its
 * final path component.
 *
 * Directory and file identity are rebound around the descriptor read. These
 * checks defend against a different OS user controlling a writable path; Node's
 * path APIs do not promise complete protection against a malicious same-uid
 * process, so callers must not claim that stronger boundary.
 *
 * @internal Not barrel-exported.
 */
export function readPrivateFileIfExists(filePath: string): string | undefined {
  const source = resolve(filePath);
  const directory = dirname(source);
  const initialDirectory = assertSafeOwnedDirectory(directory);

  let initialEntry: Stats;
  try {
    initialEntry = lstatSync(source);
  } catch (error) {
    if (isFilesystemErrorCode(error, "ENOENT")) {
      assertSameSafeOwnedDirectory(directory, initialDirectory);
      return undefined;
    }
    throw new Error(`private-file source is unavailable: ${source}`, { cause: error });
  }
  assertSecurePrivateFile(initialEntry, source);

  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      source,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    const opened = fstatSync(descriptor);
    assertSecurePrivateFile(opened, source);
    assertSameFileIdentity(initialEntry, opened, source);
    assertSameSafeOwnedDirectory(directory, initialDirectory);

    const contents = readFileSync(descriptor, "utf8");

    const openedAfterRead = fstatSync(descriptor);
    assertSecurePrivateFile(openedAfterRead, source);
    assertSameFileIdentity(opened, openedAfterRead, source);
    const pathAfterRead = lstatSync(source);
    assertSecurePrivateFile(pathAfterRead, source);
    assertSameFileIdentity(openedAfterRead, pathAfterRead, source);
    assertSameSafeOwnedDirectory(directory, initialDirectory);
    return contents;
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown filesystem failure";
    throw new Error(
      `private-file source could not be read safely: ${source}: ${detail}`,
      { cause: error },
    );
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // Preserve the read result or the original validation failure.
      }
    }
  }
}

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

function assertSecurePrivateFile(entry: Stats, source: string): void {
  if (entry.isSymbolicLink() || !entry.isFile()) {
    throw new Error(`private-file source must be a real regular file: ${source}`);
  }
  assertCurrentOwner(entry, `private-file source at ${source}`);
  if ((entry.mode & 0o777) !== 0o600) {
    throw new Error(`private-file source must have exact mode 0600: ${source}`);
  }
}

function assertSameFileIdentity(expected: Stats, current: Stats, source: string): void {
  if (expected.dev !== current.dev || expected.ino !== current.ino) {
    throw new Error(`private-file source changed during read: ${source}`);
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
