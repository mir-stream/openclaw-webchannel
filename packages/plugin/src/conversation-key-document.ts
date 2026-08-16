import {
  createStorageIdentityV2,
  type StorageIdentityV2,
  type StorageScopeIdentity,
} from "./storage-identity.js";
import {
  assertDocumentStorageIdentity,
  assertSupportedDocumentVersion,
  StorageDocumentError,
} from "./storage-document.js";

export const CONVERSATION_KEY_DOCUMENT_VERSION = 2 as const;
export const LEGACY_CONVERSATION_KEY_DOCUMENT_VERSION = 1 as const;
export const CONVERSATION_KEY_BYTES = 32;
export const CONVERSATION_KEY_IDENTITY_FIELD = "storageIdentity" as const;

export type ConversationKeyDocumentV2 = {
  version: typeof CONVERSATION_KEY_DOCUMENT_VERSION;
  [CONVERSATION_KEY_IDENTITY_FIELD]: StorageIdentityV2;
  keys: Record<string, string>;
};

export function parseConversationKeyDocument(
  scope: StorageScopeIdentity,
  serialized: string,
): Map<string, Uint8Array> {
  const document = parseRecord(serialized);
  const hasIdentity = Object.prototype.hasOwnProperty.call(
    document,
    CONVERSATION_KEY_IDENTITY_FIELD,
  );
  // An explicit identity marker is authoritative even when the surrounding
  // document version is malformed or unsupported. Otherwise a foreign-scope
  // document could be downgraded to "ordinary corruption" and moved aside.
  if (hasIdentity) {
    assertDocumentStorageIdentity(
      "conversation-keys",
      scope,
      document[CONVERSATION_KEY_IDENTITY_FIELD],
    );
  }
  assertSupportedDocumentVersion(
    "conversation-keys",
    CONVERSATION_KEY_DOCUMENT_VERSION,
    document.version,
  );
  if (!hasIdentity) {
    assertDocumentStorageIdentity("conversation-keys", scope, undefined);
  }
  return parseKeys(document.keys);
}

export function parseLegacyConversationKeyDocument(
  scope: StorageScopeIdentity,
  serialized: string,
): Map<string, Uint8Array> {
  const document = parseRecord(serialized);
  if (
    Object.prototype.hasOwnProperty.call(
      document,
      CONVERSATION_KEY_IDENTITY_FIELD,
    )
  ) {
    // A v1 envelope normally has no marker. If one is explicitly present, it is
    // authoritative and must be checked before version or key parsing.
    assertDocumentStorageIdentity(
      "conversation-keys",
      scope,
      document[CONVERSATION_KEY_IDENTITY_FIELD],
    );
  }
  // The v1 reader answers the same question as the v2 one: a version above the
  // one it understands is a downgrade signal, not malformed key material, and
  // must not be adopted-or-discarded as ordinary corruption (#159).
  assertSupportedDocumentVersion(
    "conversation-keys",
    LEGACY_CONVERSATION_KEY_DOCUMENT_VERSION,
    document.version,
  );
  return parseKeys(document.keys);
}

export function serializeConversationKeyDocument(
  scope: StorageScopeIdentity,
  keys: ReadonlyMap<string, Uint8Array>,
): string {
  const encoded = Object.create(null) as Record<string, string>;
  for (const [peerId, key] of keys) {
    if (key.length !== CONVERSATION_KEY_BYTES) {
      throw new StorageDocumentError("conversation-keys", "invalid-document");
    }
    encoded[peerId] = Buffer.from(key).toString("base64url");
  }
  const document: ConversationKeyDocumentV2 = {
    version: CONVERSATION_KEY_DOCUMENT_VERSION,
    [CONVERSATION_KEY_IDENTITY_FIELD]: createStorageIdentityV2(scope),
    keys: encoded,
  };
  return JSON.stringify(document, null, 2);
}

export function conversationKeyMapsEqual(
  left: ReadonlyMap<string, Uint8Array>,
  right: ReadonlyMap<string, Uint8Array>,
): boolean {
  if (left.size !== right.size) return false;
  for (const [peerId, key] of left) {
    const candidate = right.get(peerId);
    if (!candidate || !Buffer.from(candidate).equals(Buffer.from(key))) {
      return false;
    }
  }
  return true;
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
    throw new StorageDocumentError("conversation-keys", "invalid-document");
  }
}

function parseKeys(value: unknown): Map<string, Uint8Array> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new StorageDocumentError("conversation-keys", "invalid-document");
  }
  const keys = new Map<string, Uint8Array>();
  for (const [peerId, encoded] of Object.entries(
    value as Record<string, unknown>,
  )) {
    if (typeof encoded !== "string") {
      throw new StorageDocumentError("conversation-keys", "invalid-document");
    }
    const bytes = Buffer.from(encoded, "base64url");
    if (
      bytes.length !== CONVERSATION_KEY_BYTES ||
      bytes.toString("base64url") !== encoded
    ) {
      throw new StorageDocumentError("conversation-keys", "invalid-document");
    }
    keys.set(peerId, new Uint8Array(bytes));
  }
  return keys;
}
