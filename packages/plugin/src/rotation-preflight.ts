/**
 * Offline-rotation preflight — a SAFETY NET, not a quiescence proof (#158).
 *
 * Read this before trusting anything in this file. `rotate-conversation-key-cli`
 * mutates the two durable documents of one `(tenant, accountId)` tuple while it
 * assumes no gateway is serving that tuple. Nothing here can establish that
 * assumption, and the command must never claim otherwise:
 *
 *   A RUNNING BUT IDLE GATEWAY IS INVISIBLE TO EVERY CHECK BELOW. The plugin
 *   holds no lease, no pidfile and no open handle on its state; it reads on
 *   demand and publishes with tmp+rename. There is therefore no local artifact
 *   that says "a gateway is up", and this library cannot get one — it does not
 *   know what the deployer runs it under (`docs/ISSUE_72_CONTAINMENT_PLAN.md`
 *   §2.6). Bringing observed replicas to zero is an OPERATOR obligation, and
 *   step ① of `docs/CREDENTIAL_CONTAINMENT_RUNBOOK.md` is where it is imposed.
 *
 * What the two checks here do catch is narrow and worth stating exactly:
 *
 *   1. CONCURRENT ROTATION. The lock is a real mutual exclusion between
 *      invocations of this command. Two operators rotating the same tuple at
 *      once would otherwise lose one of the two K sets with no error.
 *   2. A WRITER CAUGHT MID-WRITE. `atomicWritePrivateFile` cleans its temp file
 *      up in a `finally`, so a leftover `*.tmp-<pid>-<hex>` whose pid is alive
 *      means some process is inside a write to this tuple right now. This is a
 *      genuine signal and a very small window; its absence proves nothing.
 *
 * Neither check is evidence about replica count. Do not add a third check and
 * let the total start reading as proof.
 */

import { randomBytes } from "node:crypto";
import { readFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import { archiveFileNoReplace, atomicWritePrivateFile } from "./private-file.js";

/** Owner-only lock file, created inside the tuple's own storage directory. */
export const ROTATION_LOCK_FILE_NAME = "conversation-key-rotation.lock";

/** Temp files published by `atomicWritePrivateFile`: `<name>.tmp-<pid>-<hex>`. */
const TEMP_ARTIFACT_PATTERN = /\.tmp-(\d+)-[0-9a-f]+$/;

const LOCK_TOKEN_PATTERN = /^[a-f0-9]{32}$/;

export type RotationLock = Readonly<{ path: string; token: string }>;

type RotationLockFile = {
  version: 1;
  ownerPid: number;
  token: string;
};

/** A preflight check refused the operation. Never thrown after a commit. */
export class RotationPreflightError extends Error {
  readonly findings: readonly string[];

  constructor(message: string, findings: readonly string[] = []) {
    super(message);
    this.name = "RotationPreflightError";
    this.findings = Object.freeze([...findings]);
  }
}

/**
 * Report in-flight writers observed in `directory`.
 *
 * Returns human-readable findings with no file contents in them; an empty array
 * means "nothing was observed", which is NOT "nothing is running".
 */
export function probeLiveTupleWriters(directory: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch (error) {
    // A probe that cannot see must never answer "clear". A missing directory is
    // the caller's own explicit-target error; anything else is a refusal here.
    if (isEnoent(error)) return [];
    throw new RotationPreflightError(
      `webchannel: could not read the tuple directory ${directory} to probe ` +
        `for live writers`,
    );
  }
  const findings: string[] = [];
  for (const entry of entries) {
    if (entry === ROTATION_LOCK_FILE_NAME) continue;
    const match = TEMP_ARTIFACT_PATTERN.exec(entry);
    if (!match) continue;
    const pid = Number(match[1]);
    if (!processIsAlive(pid)) continue;
    findings.push(
      `an atomic-write temp file owned by live pid ${pid} is present in the ` +
        `tuple directory (a process is writing this account's state now)`,
    );
  }
  return findings;
}

/**
 * Take the tuple's rotation lock, or refuse.
 *
 * A lock whose owner is still alive is a hard refusal: it is another rotation,
 * and there is no safe way to interleave two of them. A lock whose owner is
 * gone is archived and retaken, so a crashed rotation does not wedge the tuple.
 */
export function acquireRotationLock(directory: string): RotationLock {
  const path = join(directory, ROTATION_LOCK_FILE_NAME);
  const token = randomBytes(16).toString("hex");
  const serialized = JSON.stringify({
    version: 1,
    ownerPid: process.pid,
    token,
  } satisfies RotationLockFile);

  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      atomicWritePrivateFile(path, serialized, {
        replace: false,
        enforceDirectoryMode: true,
      });
      return Object.freeze({ path, token });
    } catch (error) {
      if (!isEexist(error)) {
        throw new RotationPreflightError(
          `webchannel: could not take the rotation lock at ${path}`,
        );
      }
    }

    const owner = readRotationLock(path);
    if (owner === null) {
      // Unreadable lock content is not authority to steal the lock. Refuse and
      // let the operator look at the file.
      throw new RotationPreflightError(
        `webchannel: the rotation lock at ${path} is unreadable; ` +
          `inspect it manually before rotating`,
      );
    }
    if (processIsAlive(owner.ownerPid)) {
      throw new RotationPreflightError(
        `webchannel: another rotation is in progress (lock owner pid ` +
          `${owner.ownerPid} is alive); wait for it to finish`,
      );
    }
    try {
      archiveFileNoReplace(
        path,
        `${path}.stale-${owner.ownerPid}-${randomBytes(8).toString("hex")}`,
      );
    } catch (error) {
      if (isEnoent(error)) continue;
      throw new RotationPreflightError(
        `webchannel: could not clear a stale rotation lock at ${path}`,
      );
    }
  }
  throw new RotationPreflightError(
    `webchannel: could not take the rotation lock at ${path}`,
  );
}

/**
 * Release a lock this process owns.
 *
 * Releasing runs in a `finally`, i.e. also on the failure path, so it must not
 * mask the original error: it reports a mismatch and otherwise stays quiet.
 */
export function releaseRotationLock(lock: RotationLock): void {
  const owner = readRotationLock(lock.path);
  if (
    owner === null ||
    owner.ownerPid !== process.pid ||
    owner.token !== lock.token
  ) {
    throw new RotationPreflightError(
      `webchannel: the rotation lock at ${lock.path} is no longer ours`,
    );
  }
  try {
    unlinkSync(lock.path);
  } catch {
    throw new RotationPreflightError(
      `webchannel: could not release the rotation lock at ${lock.path}`,
    );
  }
}

function readRotationLock(path: string): RotationLockFile | null {
  try {
    const candidate = JSON.parse(
      readFileSync(path, "utf8"),
    ) as Partial<RotationLockFile>;
    if (
      candidate.version !== 1 ||
      !Number.isSafeInteger(candidate.ownerPid) ||
      (candidate.ownerPid ?? 0) <= 0 ||
      typeof candidate.token !== "string" ||
      !LOCK_TOKEN_PATTERN.test(candidate.token)
    ) {
      return null;
    }
    return candidate as RotationLockFile;
  } catch {
    return null;
  }
}

/** EPERM means the pid exists and belongs to another user: still alive. */
function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCodeOf(error) === "EPERM";
  }
}

function isEexist(error: unknown): boolean {
  return errorCodeOf(error) === "EEXIST";
}

function isEnoent(error: unknown): boolean {
  return errorCodeOf(error) === "ENOENT";
}

function errorCodeOf(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error
    ? (error as { code?: unknown }).code
    : undefined;
}
