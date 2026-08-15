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
 * K seals NO history at rest. The production history authority is OpenClaw
 * core's session transcript — plaintext JSONL at owner-only perms, written by
 * core, never by this plugin. `history.ts` reads and normalizes it through
 * `getSessionMessages`; `NatsChannel.sendHistory` seals the resulting frame
 * with the CURRENT K at delivery time, so replacing K costs no
 * re-encryption: the next read-and-deliver cycle reseals
 * (`docs/ISSUE_72_CONTAINMENT_PLAN.md` §1.4, RETAIN + RESEAL). The agent-side
 * ciphertext store an earlier revision of this comment described is
 * `history-store.ts`, which has no production caller.
 *
 * File shape: `{ "version": 2, "storageIdentity": { ... }, "keys": { ... } }`.
 * Writes are atomic (tmp + rename), file mode 0600, directory mode 0700.
 *
 * Ordinary corrupt content is archived and starts fresh only after quarantine
 * succeeds. Identity mismatch/unbound/invalid metadata always fails closed and
 * is never treated as ordinary corruption.
 */

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

import { formatCapacityWarning, type CapacityStatus } from "./capacity-status.js";
import {
  CONVERSATION_KEY_BYTES,
  parseConversationKeyDocument,
  serializeConversationKeyDocument,
} from "./conversation-key-document.js";
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
import { StorageDocumentError } from "./storage-document.js";

export type { CapacityStatus } from "./capacity-status.js";
export { formatCapacityWarning } from "./capacity-status.js";

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
  /** @internal Test-only failure seam immediately before an atomic write. */
  _beforePersist?: () => void;
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
  private readonly migrationOptions: CredentialPathOptions;
  private readonly maxKeys: number;
  private readonly onCapacityWarning?: (status: CapacityStatus) => void;
  private readonly beforePersist?: () => void;
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
    return key;
  }

  /** Return the stored key for `peerId`, or `null` if none exists. */
  get(peerId: string): Uint8Array | null {
    const keys = this.load();
    this.maybeWarnCapacity(keys.size);
    return keys.get(peerId) ?? null;
  }

  // -------------------------------------------------------------------------
  // Internal persistence
  // -------------------------------------------------------------------------

  private load(): Map<string, Uint8Array> {
    if (this.keys) return this.keys;
    this.prepareMigration();
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
    this.beforePersist?.();
    try {
      atomicWritePrivateFile(
        this.filePath,
        serializeConversationKeyDocument(this.scope, keys),
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

function isEnoent(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "ENOENT"
  );
}
