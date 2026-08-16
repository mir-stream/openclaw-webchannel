/**
 * Offline-only conversation-key rotation implementation (#158).
 *
 * This module is imported by the standalone rotation entry and deliberately
 * excluded from both gateway entry closures. In particular, the account-wide
 * mutation algorithm does not exist in the live gateway bundle: it is only safe
 * after every replica serving the tuple has been stopped.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";

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
import {
  ConversationKeyGenerationCapacityError,
  ConversationKeyStore,
  type ConversationKeyStoreOptions,
} from "./conversation-key-store.js";
import { migrateLegacyTupleState } from "./legacy-storage-migration.js";
import { atomicWritePrivateFile } from "./private-file.js";
import { tupleStoragePaths } from "./storage-paths.js";
import type { StorageScopeIdentity } from "./storage-identity.js";
import { StorageDocumentError } from "./storage-document.js";

const DEFAULT_MAX_KEYS = 10_000;

/** Non-secret blast-radius preview for one named peer. */
export type PeerRotationPreview = Readonly<{
  peerId: string;
  present: boolean;
  generation: ConversationKeyGeneration | null;
}>;

/** Non-secret count and commitment to one exact tuple and target set. */
export type AccountRotationPreview = Readonly<{
  peerCount: number;
  targetDigest: string;
}>;

/** Post-commit, post-readback result for one peer. Carries no key material. */
export type PeerRotationSummary = ConversationKeyGeneration & {
  peerId: string;
};

/** Post-commit, post-readback result for an account. Carries no key material. */
export type AccountRotationSummary = Readonly<{
  peerCount: number;
  targetDigest: string;
  rotatedAtSec: number;
}>;

/**
 * A commit returned, but the complete durable documents did not match the
 * candidates. The outcome is unknown and must never be reported as success.
 */
export class ConversationKeyReadbackError extends Error {
  constructor(detail: string) {
    super(
      `webchannel: conversation-key rotation readback failed (${detail}); ` +
        `durable state is unverified`,
    );
    this.name = "ConversationKeyReadbackError";
  }
}

/** The reviewed tuple+target-set digest no longer matches; no write occurred. */
export class ConversationKeyTargetDigestMismatchError extends Error {
  readonly peerCount: number;
  readonly targetDigest: string;

  constructor(peerCount: number, targetDigest: string) {
    super(
      `webchannel: reviewed tuple+target-set digest does not match the current ` +
        `rotation target (${peerCount} peers, digest ${targetDigest})`,
    );
    this.name = "ConversationKeyTargetDigestMismatchError";
    this.peerCount = peerCount;
    this.targetDigest = targetDigest;
  }
}

/**
 * The complete offline rotation surface. It owns no transport and exposes no
 * keys: every public result is count/label/digest metadata only.
 */
export class OfflineConversationKeyRotator {
  private readonly options: ConversationKeyStoreOptions;
  private readonly scope: StorageScopeIdentity;
  private readonly keyPath: string;
  private readonly generationsPath: string;
  private readonly maxKeys: number;
  private migrationPrepared = false;

  constructor(options: ConversationKeyStoreOptions) {
    const paths = tupleStoragePaths(options);
    const maxKeys = options.maxKeys ?? DEFAULT_MAX_KEYS;
    if (!Number.isSafeInteger(maxKeys) || maxKeys <= 0) {
      throw new Error(
        "webchannel: conversation-key maxKeys must be a positive safe integer",
      );
    }
    this.options = options;
    this.scope = paths.scope;
    this.keyPath = paths.conversationKeyPath;
    this.generationsPath = paths.conversationKeyGenerationsPath;
    this.maxKeys = maxKeys;
  }

  /** Run migration before previewing, so dry run and apply inspect one state. */
  previewPeerRotation(peerId: string): PeerRotationPreview {
    assertPeerId(peerId);
    this.prepareMigration();
    const keys = this.readKeysOrEmpty();
    if (!keys.has(peerId)) {
      return Object.freeze({ peerId, present: false, generation: null });
    }
    const generation = this.readGenerationsAuditOnly().get(peerId) ?? null;
    return Object.freeze({
      peerId,
      present: true,
      generation: generation
        ? { epoch: generation.epoch, rotatedAtSec: generation.rotatedAtSec }
        : null,
    });
  }

  /** Preview every stored peer without printing membership or key material. */
  previewAccountRotation(): AccountRotationPreview {
    this.prepareMigration();
    const keys = this.readKeysOrEmpty();
    return Object.freeze({
      peerCount: keys.size,
      targetDigest: rotationTargetDigest(this.scope, keys.keys()),
    });
  }

  /**
   * Use the store's established single-peer commit protocol, then compare both
   * complete durable documents with the complete candidates. A same-cardinality
   * mutation of any non-target key or sidecar entry therefore fails readback.
   */
  rotatePeerVerified(peerId: string): PeerRotationSummary {
    assertPeerId(peerId);
    this.prepareMigration();
    const expectedKeys = this.readKeysOrEmpty();
    if (!expectedKeys.has(peerId)) {
      throw new Error(
        "webchannel: conversation-key rotation target does not exist",
      );
    }
    const expectedGenerations = compactStaleGenerations(
      this.readGenerationsAuditOnly(),
      expectedKeys,
    );

    const result = new ConversationKeyStore(this.options).rotate(peerId);
    expectedKeys.set(peerId, new Uint8Array(result.key));
    expectedGenerations.set(peerId, {
      epoch: result.epoch,
      rotatedAtSec: result.rotatedAtSec,
    });
    this.verifyCompleteReadback(expectedKeys, expectedGenerations);
    return Object.freeze({
      peerId,
      epoch: result.epoch,
      rotatedAtSec: result.rotatedAtSec,
    });
  }

  /**
   * Rotate every peer as one generations-first commit. Both complete candidates
   * are serialized before publication and each document is replaced once,
   * independent of the peer count.
   */
  rotateAccountVerified(
    reviewedTargetDigest: string,
  ): AccountRotationSummary {
    this.prepareMigration();
    const freshKeys = this.readKeysOrEmpty();
    if (freshKeys.size === 0) {
      throw new Error(
        "webchannel: conversation-key account rotation has no target",
      );
    }
    const freshTargetDigest = rotationTargetDigest(this.scope, freshKeys.keys());
    if (freshTargetDigest !== reviewedTargetDigest) {
      throw new ConversationKeyTargetDigestMismatchError(
        freshKeys.size,
        freshTargetDigest,
      );
    }
    const freshGenerations = compactStaleGenerations(
      this.readGenerationsAuditOnly(),
      freshKeys,
    );
    if (freshKeys.size > this.maxKeys) {
      throw new ConversationKeyGenerationCapacityError(
        freshKeys.size,
        this.maxKeys,
      );
    }

    const rotatedAtSec = this.readNowSec();
    const nextKeys = new Map<string, Uint8Array>();
    const nextGenerations = new Map<string, ConversationKeyGeneration>();
    for (const peerId of freshKeys.keys()) {
      const current = freshGenerations.get(peerId);
      nextKeys.set(peerId, this.makeRandomKey());
      nextGenerations.set(peerId, {
        epoch: current ? nextEpoch(current.epoch) : 1,
        rotatedAtSec,
      });
    }

    // Validate the whole pair before either file changes.
    const serializedGenerations = serializeConversationKeyGenerationsDocument(
      this.scope,
      nextGenerations,
    );
    const serializedKeys = serializeConversationKeyDocument(
      this.scope,
      nextKeys,
    );

    // Sidecar-ahead is the documented crash-safe asymmetry. Key-ahead is not.
    this.persistGenerations(serializedGenerations);
    this.persistKeys(serializedKeys);
    this.options._beforeCachePublish?.();
    this.verifyCompleteReadback(nextKeys, nextGenerations);

    return Object.freeze({
      peerCount: nextKeys.size,
      targetDigest: freshTargetDigest,
      rotatedAtSec,
    });
  }

  private prepareMigration(): void {
    if (this.migrationPrepared) return;
    migrateLegacyTupleState({
      tenant: this.options.tenant,
      accountId: this.options.accountId,
      // Unlike live startup, an incident-response preview must not quarantine
      // a K merely because the operator omitted/mistyped an exact credential
      // override. Preserve it until ownership can be proven explicitly.
      ambiguousConversationKeyPolicy: "preserve",
      ...(this.options.storageRoot !== undefined
        ? { storageRoot: this.options.storageRoot }
        : {}),
      ...(this.options.credentialPath !== undefined
        ? { credentialPath: this.options.credentialPath }
        : {}),
      ...(this.options.home !== undefined ? { home: this.options.home } : {}),
    });
    this.migrationPrepared = true;
  }

  private readKeysOrEmpty(): Map<string, Uint8Array> {
    try {
      return parseConversationKeyDocument(
        this.scope,
        readFileSync(this.keyPath, "utf8"),
      );
    } catch (error) {
      if (isEnoent(error)) return new Map();
      throw error;
    }
  }

  private readGenerations(): Map<string, ConversationKeyGeneration> {
    return parseConversationKeyGenerationsDocument(
      this.scope,
      readFileSync(this.generationsPath, "utf8"),
    );
  }

  private readGenerationsAuditOnly(): Map<string, ConversationKeyGeneration> {
    try {
      return this.readGenerations();
    } catch (error) {
      const code = isEnoent(error)
        ? "missing"
        : error instanceof StorageDocumentError
          ? error.code
          : "storage-io-failed";
      try {
        console.error(
          `[conversation-key-store] document=conversation-key-generations ` +
            `code=${code} action=empty-state`,
        );
      } catch {
        // Diagnostics cannot alter the key result.
      }
      return new Map();
    }
  }

  private persistKeys(serialized: string): void {
    this.options._beforePersist?.();
    try {
      atomicWritePrivateFile(this.keyPath, serialized, {
        replace: true,
        enforceDirectoryMode: true,
      });
    } catch (error) {
      if (error instanceof StorageDocumentError) throw error;
      throw new StorageDocumentError(
        "conversation-keys",
        "storage-io-failed",
      );
    }
  }

  private persistGenerations(serialized: string): void {
    this.options._beforeGenerationPersist?.();
    try {
      atomicWritePrivateFile(this.generationsPath, serialized, {
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

  private makeRandomKey(): Uint8Array {
    const bytes = new Uint8Array(
      (this.options._randomBytes ?? ((size) => randomBytes(size)))(
        CONVERSATION_KEY_BYTES,
      ),
    );
    if (bytes.length !== CONVERSATION_KEY_BYTES) {
      throw new Error(
        "webchannel: conversation-key CSPRNG returned an invalid length",
      );
    }
    return bytes;
  }

  private readNowSec(): number {
    const value = (this.options._nowSec ?? (() => Math.floor(Date.now() / 1_000)))();
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(
        "webchannel: conversation-key audit clock must return positive unix seconds",
      );
    }
    return value;
  }

  private verifyCompleteReadback(
    expectedKeys: ReadonlyMap<string, Uint8Array>,
    expectedGenerations: ReadonlyMap<string, ConversationKeyGeneration>,
  ): void {
    let keys: Map<string, Uint8Array>;
    let generations: Map<string, ConversationKeyGeneration>;
    try {
      keys = this.readKeysOrEmpty();
      generations = this.readGenerations();
    } catch {
      throw new ConversationKeyReadbackError("documents could not be re-read");
    }
    if (keys.size !== expectedKeys.size) {
      throw new ConversationKeyReadbackError("key count changed after commit");
    }
    if (generations.size !== expectedGenerations.size) {
      throw new ConversationKeyReadbackError(
        "generation sidecar cardinality changed after commit",
      );
    }
    for (const [peerId, expectedKey] of expectedKeys) {
      const storedKey = keys.get(peerId);
      if (
        !storedKey ||
        storedKey.length !== expectedKey.length ||
        !timingSafeEqual(storedKey, expectedKey)
      ) {
        throw new ConversationKeyReadbackError("key material did not match");
      }
    }
    for (const [peerId, expectedGeneration] of expectedGenerations) {
      const storedGeneration = generations.get(peerId);
      if (
        !storedGeneration ||
        storedGeneration.epoch !== expectedGeneration.epoch ||
        storedGeneration.rotatedAtSec !== expectedGeneration.rotatedAtSec
      ) {
        throw new ConversationKeyReadbackError("generation label did not match");
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

function rotationTargetDigest(
  scope: StorageScopeIdentity,
  peerIds: Iterable<string>,
): string {
  const hash = createHash("sha256");
  hash.update(frameUtf8("openclaw-webchannel/rotation-target/v2"));
  hash.update(frameUtf8(scope.tenant));
  hash.update(frameUtf8(scope.accountId));
  for (const peerId of [...peerIds].sort()) hash.update(frameUtf8(peerId));
  return hash.digest("hex");
}

/** Unambiguous length framing for every UTF-8 digest component. */
function frameUtf8(value: string): Buffer {
  const bytes = Buffer.from(value, "utf8");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  return Buffer.concat([length, bytes]);
}

function nextEpoch(epoch: number): number {
  if (!Number.isSafeInteger(epoch) || epoch <= 0 || epoch >= Number.MAX_SAFE_INTEGER) {
    throw new Error(
      "webchannel: conversation-key generation cannot advance safely",
    );
  }
  return epoch + 1;
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
