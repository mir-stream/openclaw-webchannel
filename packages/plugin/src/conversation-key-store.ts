/**
 * Conversation-key store — Phase 6 (multi-device E2E).
 *
 * The agent OWNS the per-peer conversation key K on the register-admission
 * path: K is generated ONCE per peerId (random 32 bytes), persisted, and
 * wrap-delivered to each of the user's devices (see `late-join-decryptor.ts`
 * `wrapConversationKey`) instead of being re-derived by a per-device X25519
 * handshake. That is what lets two devices of the SAME user (same peerId)
 * decrypt the SAME conversation concurrently — the second device no longer
 * overwrites the first one's key.
 *
 * Persistence
 * ───────────
 * `~/.openclaw-webchannel-v2/<tuple-namespace>/conversation-keys.json` — the
 * same exact `(tenant, accountId)` secret directory (and the same plaintext-JSON + owner-only-perms
 * posture) as `credentials.json`, which already holds the strictly more
 * powerful NATS user seed. K must survive a gateway restart because live
 * devices hold an unwrapped copy that must stay valid across agent restarts.
 * K-at-rest encryption is deferred (a co-located master key adds no real
 * protection).
 *
 * K seals NO history at rest. ⚠️ THE HISTORY AUTHORITY MOVED IN #240 and the
 * containment consequences moved with it: it is no longer core's session
 * transcript but the plugin's OWN delivery journal — message plaintext in a
 * SQLite file this plugin writes, beside the secrets in the tuple storage
 * directory (`storage-paths.ts` records why it belongs there, and
 * the file inventory is in `docs/CREDENTIAL_CONTAINMENT_RUNBOOK.md` §0.2,
 * which §1.4 of the containment plan delegates to).
 * `journal-history.ts` projects that journal into a history frame, and
 * `NatsChannel.sendHistory` seals the frame with the CURRENT K at delivery
 * time, so replacing K still costs no re-encryption: the next read-and-deliver
 * cycle reseals (§1.4, RETAIN + RESEAL). What has NOT changed is that there is
 * no agent-side CIPHERTEXT store — the journal holds plaintext, and the
 * in-memory ciphertext store an earlier revision of this comment pointed at was
 * never reachable from production and was deleted in #153.
 *
 * File shape: `{ "version": 2, "storageIdentity": { ... }, "keys": { ... } }`.
 * Writes are atomic (tmp + rename), file mode 0600, directory mode 0700.
 *
 * Ordinary corrupt content is archived and starts fresh only after quarantine
 * succeeds. Identity mismatch/unbound/invalid metadata always fails closed and
 * is never treated as ordinary corruption.
 *
 * A document `version` ABOVE the one this build writes fails closed too (#159).
 * It means a newer release wrote the file and the deployer then rolled back, so
 * quarantining it would archive every live device's K and issue fresh keys on
 * the next register — an unrecoverable outage dressed up as recovery. That rule
 * covers the audit-only generation sidecar as well: the sidecar is written with
 * `replace: true` and is never archived, so overwriting a future sidecar would
 * destroy the bytes outright. A MISSING or CORRUPT sidecar keeps its audit-only
 * degradation and still admits registrations; only version-too-new stops.
 */

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

import { formatCapacityWarning, type CapacityStatus } from "./capacity-status.js";
import {
  CONVERSATION_KEY_BYTES,
  parseConversationKeyDocument,
  serializeConversationKeyDocument,
} from "./conversation-key-document.js";
import {
  parseConversationKeyGenerationsDocument,
  serializeConversationKeyGenerationsDocument,
  type ConversationKeyGeneration,
} from "./conversation-key-generations-document.js";
import { migrateLegacyTupleState } from "./legacy-storage-migration.js";
import {
  archiveFileNoReplace,
  atomicWritePrivateFile,
} from "./private-file.js";
import {
  tupleStoragePaths,
  type CredentialPathOptions,
} from "./storage-paths.js";
import type { StorageScopeIdentity } from "./storage-identity.js";
import {
  isVersionTooNew,
  StorageDocumentError,
} from "./storage-document.js";

export type { CapacityStatus } from "./capacity-status.js";
export { formatCapacityWarning } from "./capacity-status.js";

export type ConversationKeyRotationResult = ConversationKeyGeneration & {
  key: Uint8Array;
};

/**
 * S2 posture: ceiling on stored keys per account. peerIds on the register path
 * come from verified JWT `sub` claims, so real growth is bounded by real users;
 * the cap only engages under issuer abuse or routing mistakes. Hitting it is a
 * fail-closed admission error: persisted keys are cryptographic history roots
 * and must never be silently evicted.
 */
const DEFAULT_MAX_KEYS = 10_000;

export type ConversationKeyStoreOptions = {
  /** Exact tenant scope. No implicit/default tenant is permitted. */
  tenant: string;
  /** Account whose tuple-scoped secret directory the store lives in. */
  accountId: string;
  /** Common v2 root. The raw tenant is never interpolated into this path. */
  storageRoot?: string;
  /**
   * Credential exact-file override used only by coordinated legacy migration.
   * It never relocates this conversation-key file.
   */
  credentialPath?: string;
  /** Home dir override (tests). Defaults to `os.homedir()`. */
  home?: string;
  /** Key-count ceiling override (tests). Defaults to 10_000. */
  maxKeys?: number;
  /** Best-effort operational signal; does not alter the fixed ceiling. */
  onCapacityWarning?: (status: CapacityStatus) => void;
  /** @internal Test-only failure seam before a key-document atomic write. */
  _beforePersist?: () => void;
  /** @internal Test-only failure seam before a generation atomic write. */
  _beforeGenerationPersist?: () => void;
  /** @internal Test-only crash seam after key rename, before cache publish. */
  _beforeCachePublish?: () => void;
  /** @internal Test-only CSPRNG seam. */
  _randomBytes?: (size: number) => Uint8Array;
  /** @internal Test-only unix-seconds audit clock. */
  _nowSec?: () => number;
};

export class ConversationKeyCapacityError extends Error {
  readonly accountId: string;
  readonly currentKeys: number;
  readonly maxKeys: number;

  constructor(status: CapacityStatus) {
    super(
      `webchannel: account "${status.accountId}" conversation-key capacity ` +
        `${status.currentKeys}/${status.maxKeys}; existing keys preserved, new admission rejected`,
    );
    this.name = "ConversationKeyCapacityError";
    this.accountId = status.accountId;
    this.currentKeys = status.currentKeys;
    this.maxKeys = status.maxKeys;
  }
}

export class ConversationKeyGenerationCapacityError extends Error {
  readonly currentGenerations: number;
  readonly maxGenerations: number;

  constructor(currentGenerations: number, maxGenerations: number) {
    super(
      `webchannel: conversation-key generation capacity ` +
        `${currentGenerations}/${maxGenerations}; key material unchanged`,
    );
    this.name = "ConversationKeyGenerationCapacityError";
    this.currentGenerations = currentGenerations;
    this.maxGenerations = maxGenerations;
  }
}

/**
 * Per-account persistent store of agent-owned conversation keys, keyed by
 * peerId. One instance per register-admission `NatsChannel`.
 *
 * All I/O is synchronous (matches the register hop's synchronous
 * `registerPeer` call-site and the enrollment-client credential writes).
 */
export class ConversationKeyStore {
  private readonly scope: StorageScopeIdentity;
  private readonly accountId: string;
  private readonly filePath: string;
  private readonly generationsFilePath: string;
  private readonly migrationOptions: CredentialPathOptions;
  private readonly maxKeys: number;
  private readonly onCapacityWarning?: (status: CapacityStatus) => void;
  private readonly beforePersist?: () => void;
  private readonly beforeGenerationPersist?: () => void;
  private readonly beforeCachePublish?: () => void;
  private readonly randomKeyBytes: (size: number) => Uint8Array;
  private readonly nowSec: () => number;
  /** Lazily loaded on first access. Entries are never removed by this store. */
  private keys: Map<string, Uint8Array> | null = null;
  private capacityWarningEmitted = false;
  private migrationPrepared = false;

  constructor(options: ConversationKeyStoreOptions) {
    const paths = tupleStoragePaths({
      tenant: options.tenant,
      accountId: options.accountId,
      ...(options.storageRoot !== undefined
        ? { storageRoot: options.storageRoot }
        : {}),
      ...(options.home !== undefined ? { home: options.home } : {}),
    });
    const maxKeys = options.maxKeys ?? DEFAULT_MAX_KEYS;
    if (!Number.isSafeInteger(maxKeys) || maxKeys <= 0) {
      throw new Error("webchannel: conversation-key maxKeys must be a positive safe integer");
    }
    this.scope = paths.scope;
    this.accountId = options.accountId;
    this.filePath = paths.conversationKeyPath;
    this.generationsFilePath = paths.conversationKeyGenerationsPath;
    this.migrationOptions = {
      tenant: options.tenant,
      accountId: options.accountId,
      ...(options.storageRoot !== undefined
        ? { storageRoot: options.storageRoot }
        : {}),
      ...(options.credentialPath !== undefined
        ? { credentialPath: options.credentialPath }
        : {}),
      ...(options.home !== undefined ? { home: options.home } : {}),
    };
    this.maxKeys = maxKeys;
    this.onCapacityWarning = options.onCapacityWarning;
    this.beforePersist = options._beforePersist;
    this.beforeGenerationPersist = options._beforeGenerationPersist;
    this.beforeCachePublish = options._beforeCachePublish;
    this.randomKeyBytes = options._randomBytes ?? ((size) => randomBytes(size));
    this.nowSec = options._nowSec ?? (() => Math.floor(Date.now() / 1_000));
  }

  /**
   * Non-mutating startup probe for the one compatibility state that makes this
   * build unsafe to serve: a key or generation document from a newer release.
   *
   * Missing, corrupt, unreadable, or foreign documents deliberately keep their
   * existing lazy-load policy. In particular this method does not migrate,
   * quarantine, create keys, or write either document.
   */
  assertNoFutureDocuments(): void {
    this.assertKeysNotFromFuture();
    this.assertGenerationsNotFromFuture();
  }

  /**
   * Return the stable conversation key for `peerId`, generating + persisting a
   * fresh random 32-byte key on first sight. NEVER regenerates an existing key
   * — stability across devices and restarts is the whole point.
   */
  getOrCreate(peerId: string): Uint8Array {
    if (!peerId || typeof peerId !== "string") {
      throw new Error("webchannel: peerId must be a non-empty string");
    }
    const keys = this.load();
    this.maybeWarnCapacity(keys.size);
    const existing = keys.get(peerId);
    if (existing) return existing;

    // Once this monotonic cache is full, disk cannot be below the cap under the
    // documented single-writer/no-external-edit precondition. Reject before an
    // O(n) fresh read so abuse at the boundary stays O(1).
    if (keys.size >= this.maxKeys) {
      throw this.capacityError(keys.size);
    }

    // Refresh immediately before a commit candidate is built. This preserves a
    // key committed by another sequential store instance without pretending
    // atomic rename is a cross-process CAS.
    const fresh = this.readFresh();
    this.maybeWarnCapacity(fresh.size);
    const freshExisting = fresh.get(peerId);
    if (freshExisting) {
      this.keys = fresh;
      return freshExisting;
    }
    if (fresh.size >= this.maxKeys) {
      this.keys = fresh;
      throw this.capacityError(fresh.size);
    }

    const key = new Uint8Array(randomBytes(CONVERSATION_KEY_BYTES));
    const next = new Map(fresh);
    next.set(peerId, key);
    this.persist(next);
    this.keys = next;
    this.maybeWarnCapacity(next.size);
    // Register admission is security-authoritative; the sidecar is audit-only.
    // The intentional order is therefore the reverse of rotate(): publish K
    // first, then best-effort its initial label. A crash in between leaves an
    // entry-less durable K which a later rotate() self-heals before changing K.
    this.recordInitialGenerationBestEffort(peerId);
    return key;
  }

  /** Return the stored key for `peerId`, or `null` if none exists. */
  get(peerId: string): Uint8Array | null {
    const keys = this.load();
    this.maybeWarnCapacity(keys.size);
    return keys.get(peerId) ?? null;
  }

  /**
   * Return the audit-only generation label for `peerId`, or `null` when absent.
   * This diagnostic is not a lock, writer census, or proof of quiescence.
   */
  generationOf(peerId: string): ConversationKeyGeneration | null {
    assertPeerId(peerId);
    this.prepareMigration();
    const generation = this.readGenerationsAuditOnly().get(peerId);
    return generation
      ? { epoch: generation.epoch, rotatedAtSec: generation.rotatedAtSec }
      : null;
  }

  /**
   * Replace one existing peer's K using the generations-first commit protocol.
   * Rotation is per-peer and is not a create API.
   */
  rotate(peerId: string): ConversationKeyRotationResult {
    assertPeerId(peerId);
    this.prepareMigration();

    // Fresh durable reads are load-bearing: neither the monotonic key cache nor
    // any previous sidecar observation can authorize this commit.
    const freshKeys = this.readFresh();
    if (!freshKeys.has(peerId)) {
      throw new Error(
        "webchannel: conversation-key rotation target does not exist",
      );
    }
    const freshGenerations = compactStaleGenerations(
      this.readGenerationsAuditOnly(),
      freshKeys,
    );
    const currentGeneration = freshGenerations.get(peerId);
    const generationCapacityExceeded = currentGeneration
      ? freshGenerations.size > this.maxKeys
      : freshGenerations.size >= this.maxKeys;
    if (generationCapacityExceeded) {
      throw new ConversationKeyGenerationCapacityError(
        freshGenerations.size,
        this.maxKeys,
      );
    }

    const epoch = currentGeneration
      ? nextEpoch(currentGeneration.epoch)
      : 1;
    const rotatedAtSec = this.readNowSec();
    const key = this.makeRandomKey();

    const nextGenerations = new Map(freshGenerations);
    nextGenerations.set(peerId, { epoch, rotatedAtSec });
    const nextKeys = new Map(freshKeys);
    nextKeys.set(peerId, key);

    // Step 4 builds and validates BOTH complete candidate documents in memory.
    // No durable publication happens until both serializers have succeeded.
    const serializedGenerations = serializeConversationKeyGenerationsDocument(
      this.scope,
      nextGenerations,
    );
    const serializedKeys = serializeConversationKeyDocument(
      this.scope,
      nextKeys,
    );

    // Steps 5 and 6. The order is the crash contract: sidecar-ahead is an
    // allowed audit asymmetry; key-ahead (an unauditable K_new) is forbidden.
    this.persistSerializedGenerations(serializedGenerations);
    this.persistSerializedKeys(serializedKeys);

    // A production crash here kills the stale cache with the process. The
    // test-only seam throws without killing it, so invalidate rather than let a
    // caller catch the simulated crash and continue serving K_old over K_new.
    try {
      this.beforeCachePublish?.();
    } catch (error) {
      this.keys = null;
      throw error;
    }
    this.keys = nextKeys;
    return { key: new Uint8Array(key), epoch, rotatedAtSec };
  }

  // -------------------------------------------------------------------------
  // Internal persistence
  // -------------------------------------------------------------------------

  private load(): Map<string, Uint8Array> {
    if (this.keys) return this.keys;
    this.prepareMigration();
    this.assertGenerationsNotFromFuture();
    try {
      this.keys = this.readStoreFile();
    } catch (err) {
      if (isEnoent(err)) {
        this.keys = new Map();
        return this.keys;
      }
      if (
        !(err instanceof StorageDocumentError) ||
        err.code !== "invalid-document"
      ) {
        // Identity mismatch/unbound/invalid metadata is not ordinary
        // corruption and never authorizes an archive-and-continue action.
        throw err;
      }
      const aside =
        `${this.filePath}.corrupt-v2-${Date.now()}-` +
        randomBytes(8).toString("hex");
      console.error(
        "[conversation-key-store] code=invalid-document action=quarantine",
      );
      try {
        archiveFileNoReplace(this.filePath, aside);
      } catch {
        throw new StorageDocumentError(
          "conversation-keys",
          "legacy-migration-failed",
        );
      }
      this.keys = new Map();
      this.persist(this.keys);
      this.resetGenerationsAfterKeyQuarantine();
    }
    return this.keys;
  }

  /** Read current durable state without invoking lazy-load quarantine policy. */
  private readFresh(): Map<string, Uint8Array> {
    try {
      return this.readStoreFile();
    } catch (err) {
      if (isEnoent(err)) return new Map();
      throw err;
    }
  }

  private readStoreFile(): Map<string, Uint8Array> {
    let serialized: string;
    try {
      serialized = readFileSync(this.filePath, "utf8");
    } catch (error) {
      if (isEnoent(error)) throw error;
      throw new StorageDocumentError(
        "conversation-keys",
        "storage-io-failed",
      );
    }
    return parseConversationKeyDocument(this.scope, serialized);
  }

  private persist(keys: ReadonlyMap<string, Uint8Array>): void {
    this.persistSerializedKeys(
      serializeConversationKeyDocument(this.scope, keys),
    );
  }

  private persistSerializedKeys(serialized: string): void {
    this.beforePersist?.();
    try {
      atomicWritePrivateFile(
        this.filePath,
        serialized,
        { replace: true, enforceDirectoryMode: true },
      );
    } catch (error) {
      if (error instanceof StorageDocumentError) throw error;
      throw new StorageDocumentError(
        "conversation-keys",
        "storage-io-failed",
      );
    }
  }

  private readGenerationFile(): Map<string, ConversationKeyGeneration> {
    let serialized: string;
    try {
      serialized = readFileSync(this.generationsFilePath, "utf8");
    } catch (error) {
      if (isEnoent(error)) throw error;
      throw new StorageDocumentError(
        "conversation-key-generations",
        "storage-io-failed",
      );
    }
    return parseConversationKeyGenerationsDocument(this.scope, serialized);
  }

  /** Non-mutating counterpart to the key document's lazy-load policy. */
  private assertKeysNotFromFuture(): void {
    try {
      this.readStoreFile();
    } catch (error) {
      if (isVersionTooNew(error)) throw error;
    }
  }

  /**
   * Fail closed before the key path can mutate anything when the sidecar was
   * written by a newer release (#159).
   *
   * This runs at the head of the lazy load, ahead of key quarantine and ahead
   * of every sidecar write, so a downgraded process neither resets nor replaces
   * a future sidecar. Missing, corrupt, and unreadable sidecars are NOT this
   * guard's business — they stay audit-only and are handled where they are read.
   */
  private assertGenerationsNotFromFuture(): void {
    try {
      this.readGenerationFile();
    } catch (error) {
      if (isVersionTooNew(error)) throw error;
    }
  }

  /**
   * Sidecar failure is audit-only: report a fixed diagnostic and start empty.
   *
   * The one exception is version-too-new. Swallowing it would hand an empty map
   * to a caller that then writes the sidecar back at this build's version,
   * erasing a newer release's file with no archive behind it.
   */
  private readGenerationsAuditOnly(): Map<string, ConversationKeyGeneration> {
    try {
      return this.readGenerationFile();
    } catch (error) {
      if (isVersionTooNew(error)) throw error;
      const code = isEnoent(error)
        ? "missing"
        : error instanceof StorageDocumentError
          ? error.code
          : "storage-io-failed";
      this.logGenerationAuditFailure(code, "empty-state");
      return new Map();
    }
  }

  private persistGenerations(
    generations: ReadonlyMap<string, ConversationKeyGeneration>,
  ): void {
    this.persistSerializedGenerations(
      serializeConversationKeyGenerationsDocument(this.scope, generations),
    );
  }

  private persistSerializedGenerations(serialized: string): void {
    this.beforeGenerationPersist?.();
    try {
      atomicWritePrivateFile(this.generationsFilePath, serialized, {
        replace: true,
        enforceDirectoryMode: true,
      });
    } catch (error) {
      if (error instanceof StorageDocumentError) throw error;
      throw new StorageDocumentError(
        "conversation-key-generations",
        "storage-io-failed",
      );
    }
  }

  private recordInitialGenerationBestEffort(peerId: string): void {
    try {
      let generations = this.readGenerationsAuditOnly();
      if (generations.has(peerId)) return;

      // The key was durably committed first, so this fresh read includes the
      // target and gives stale-entry compaction an exact authority snapshot.
      const freshKeys = this.readFresh();
      generations = compactStaleGenerations(generations, freshKeys);
      if (generations.size >= this.maxKeys) {
        this.logGenerationAuditFailure("capacity-full", "entry-omitted");
        return;
      }
      const next = new Map(generations);
      next.set(peerId, { epoch: 1, rotatedAtSec: this.readNowSec() });
      this.persistGenerations(next);
    } catch {
      // Registration already committed K. An audit write must never roll that
      // result back or turn a successful admission into a failure. A sidecar
      // that turned version-too-new since the load-time probe lands here too:
      // the read throws BEFORE any write, so the future file keeps its bytes.
      this.logGenerationAuditFailure("write-failed", "entry-omitted");
    }
  }

  /**
   * The only sidecar write with no read in front of it. It is reachable solely
   * from the lazy-load quarantine branch, which `assertGenerationsNotFromFuture`
   * already gated, so it cannot replace a newer release's sidecar.
   */
  private resetGenerationsAfterKeyQuarantine(): void {
    try {
      this.persistGenerations(new Map());
    } catch {
      // The key authority was safely quarantined and reset. Its audit-only
      // sidecar must not be allowed to turn that recovery into an outage.
      this.logGenerationAuditFailure("write-failed", "quarantine-reset-skipped");
    }
  }

  private makeRandomKey(): Uint8Array {
    const bytes = new Uint8Array(this.randomKeyBytes(CONVERSATION_KEY_BYTES));
    if (bytes.length !== CONVERSATION_KEY_BYTES) {
      throw new Error(
        "webchannel: conversation-key CSPRNG returned an invalid length",
      );
    }
    return bytes;
  }

  private readNowSec(): number {
    const value = this.nowSec();
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(
        "webchannel: conversation-key audit clock must return positive unix seconds",
      );
    }
    return value;
  }

  private logGenerationAuditFailure(code: string, action: string): void {
    try {
      console.error(
        `[conversation-key-store] document=conversation-key-generations ` +
          `code=${code} action=${action}`,
      );
    } catch {
      // The audit sidecar and its diagnostics cannot own key availability.
    }
  }

  private prepareMigration(): void {
    if (this.migrationPrepared) return;
    migrateLegacyTupleState(this.migrationOptions);
    this.migrationPrepared = true;
  }

  private capacityError(currentKeys: number): ConversationKeyCapacityError {
    return new ConversationKeyCapacityError({
      accountId: this.accountId,
      currentKeys,
      maxKeys: this.maxKeys,
    });
  }

  private maybeWarnCapacity(currentKeys: number): void {
    if (this.capacityWarningEmitted || currentKeys * 10 < this.maxKeys * 9) return;
    this.capacityWarningEmitted = true;
    const status: CapacityStatus = {
      accountId: this.accountId,
      currentKeys,
      maxKeys: this.maxKeys,
    };
    try {
      if (this.onCapacityWarning) {
        this.onCapacityWarning(status);
      } else {
        console.warn(formatCapacityWarning(status));
      }
    } catch {
      try {
        console.warn(formatCapacityWarning(status));
      } catch {
        // Best effort only; diagnostics cannot change a durable key result.
      }
    }
  }
}

function assertPeerId(peerId: string): void {
  if (!peerId || typeof peerId !== "string") {
    throw new Error("webchannel: peerId must be a non-empty string");
  }
}

function compactStaleGenerations(
  generations: ReadonlyMap<string, ConversationKeyGeneration>,
  keys: ReadonlyMap<string, Uint8Array>,
): Map<string, ConversationKeyGeneration> {
  const compacted = new Map<string, ConversationKeyGeneration>();
  for (const [peerId, generation] of generations) {
    if (keys.has(peerId)) compacted.set(peerId, generation);
  }
  return compacted;
}

function nextEpoch(epoch: number): number {
  if (!Number.isSafeInteger(epoch) || epoch <= 0 || epoch >= Number.MAX_SAFE_INTEGER) {
    throw new Error(
      "webchannel: conversation-key generation cannot advance safely",
    );
  }
  return epoch + 1;
}

function isEnoent(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "ENOENT"
  );
}
