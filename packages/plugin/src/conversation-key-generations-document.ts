import {
  createStorageIdentityV2,
  type StorageIdentityV2,
  type StorageScopeIdentity,
} from "./storage-identity.js";
import {
  assertDocumentStorageIdentity,
  assertDocumentVersionNotFromFuture,
  assertSupportedDocumentVersion,
  StorageDocumentError,
} from "./storage-document.js";

export const CONVERSATION_KEY_GENERATIONS_DOCUMENT_VERSION = 1 as const;
export const CONVERSATION_KEY_GENERATIONS_IDENTITY_FIELD =
  "storageIdentity" as const;

export type ConversationKeyGeneration = Readonly<{
  epoch: number;
  rotatedAtSec: number;
}>;

export type ConversationKeyGenerationsV1 = {
  version: typeof CONVERSATION_KEY_GENERATIONS_DOCUMENT_VERSION;
  [CONVERSATION_KEY_GENERATIONS_IDENTITY_FIELD]: StorageIdentityV2;
  generations: Record<string, ConversationKeyGeneration>;
};

export function parseConversationKeyGenerationsDocument(
  scope: StorageScopeIdentity,
  serialized: string,
): Map<string, ConversationKeyGeneration> {
  const document = parseRecord(serialized);
  const hasIdentity = Object.prototype.hasOwnProperty.call(
    document,
    CONVERSATION_KEY_GENERATIONS_IDENTITY_FIELD,
  );
  assertDocumentVersionNotFromFuture(
    "conversation-key-generations",
    CONVERSATION_KEY_GENERATIONS_DOCUMENT_VERSION,
    document.version,
  );
  // As with the key document, an explicit identity marker remains
  // authoritative for current, older, and malformed top-level versions. A
  // valid future version is the one exception: recognize the downgrade before
  // a future identity schema can be misclassified as ordinary audit damage.
  if (hasIdentity) {
    assertDocumentStorageIdentity(
      "conversation-key-generations",
      scope,
      document[CONVERSATION_KEY_GENERATIONS_IDENTITY_FIELD],
    );
  }
  assertSupportedDocumentVersion(
    "conversation-key-generations",
    CONVERSATION_KEY_GENERATIONS_DOCUMENT_VERSION,
    document.version,
  );
  if (!hasIdentity) {
    assertDocumentStorageIdentity(
      "conversation-key-generations",
      scope,
      undefined,
    );
  }
  return parseGenerations(document.generations);
}

export function serializeConversationKeyGenerationsDocument(
  scope: StorageScopeIdentity,
  generations: ReadonlyMap<string, ConversationKeyGeneration>,
): string {
  const encoded = Object.create(null) as Record<
    string,
    ConversationKeyGeneration
  >;
  for (const [peerId, generation] of generations) {
    assertGeneration(generation);
    encoded[peerId] = {
      epoch: generation.epoch,
      rotatedAtSec: generation.rotatedAtSec,
    };
  }
  const document: ConversationKeyGenerationsV1 = {
    version: CONVERSATION_KEY_GENERATIONS_DOCUMENT_VERSION,
    [CONVERSATION_KEY_GENERATIONS_IDENTITY_FIELD]:
      createStorageIdentityV2(scope),
    generations: encoded,
  };
  return JSON.stringify(document, null, 2);
}

function parseRecord(serialized: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(serialized) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("shape");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof StorageDocumentError) throw error;
    throw invalidDocument();
  }
}

function parseGenerations(
  value: unknown,
): Map<string, ConversationKeyGeneration> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidDocument();
  }
  const generations = new Map<string, ConversationKeyGeneration>();
  for (const [peerId, rawGeneration] of Object.entries(
    value as Record<string, unknown>,
  )) {
    if (
      !rawGeneration ||
      typeof rawGeneration !== "object" ||
      Array.isArray(rawGeneration)
    ) {
      throw invalidDocument();
    }
    const generation = rawGeneration as Record<string, unknown>;
    assertGeneration(generation);
    generations.set(
      peerId,
      Object.freeze({
        epoch: generation.epoch as number,
        rotatedAtSec: generation.rotatedAtSec as number,
      }),
    );
  }
  return generations;
}

function assertGeneration(
  value: Record<string, unknown> | ConversationKeyGeneration,
): void {
  const epoch = value.epoch;
  const rotatedAtSec = value.rotatedAtSec;
  if (
    typeof epoch !== "number" ||
    !Number.isSafeInteger(epoch) ||
    epoch <= 0 ||
    typeof rotatedAtSec !== "number" ||
    !Number.isSafeInteger(rotatedAtSec) ||
    rotatedAtSec <= 0
  ) {
    throw invalidDocument();
  }
}

function invalidDocument(): StorageDocumentError {
  return new StorageDocumentError(
    "conversation-key-generations",
    "invalid-document",
  );
}
