import {
  createStorageIdentityV2,
  inspectStorageIdentityV2,
  type CredentialBindingField,
  type IdentityInspection,
  type StorageScopeIdentity,
} from "./storage-identity.js";

export type SecretDocumentKind =
  | "credentials"
  | "conversation-keys"
  | "conversation-key-generations";

export type StorageDocumentErrorCode =
  | "identity-unbound"
  | "identity-incomplete"
  | "identity-invalid"
  | "identity-mismatch"
  | "invalid-document"
  | "version-too-new"
  | "storage-io-failed"
  | "legacy-claim-conflict"
  | "legacy-migration-failed";

/**
 * Operator remediation for codes whose stable name does not, on its own, say
 * what to do next. The text is a fixed constant: it names the situation and the
 * action, and never interpolates anything read from the document.
 */
const CODE_REMEDIATION: Partial<Record<StorageDocumentErrorCode, string>> = {
  "version-too-new":
    "this file was written by a NEWER webchannel release than this build " +
    "supports, so this is a version downgrade, not corruption. The file was " +
    "left unchanged. Run the plugin version that wrote it (or newer), or " +
    "restore this account's state from your own backup before downgrading",
};

/**
 * Sanitized persistence failure. It deliberately carries no path, candidate
 * value, tenant, account id, credential, key, URL, or raw parser exception.
 */
export class StorageDocumentError extends Error {
  readonly code: StorageDocumentErrorCode;
  readonly document: SecretDocumentKind;
  readonly fields: readonly CredentialBindingField[];

  constructor(
    document: SecretDocumentKind,
    code: StorageDocumentErrorCode,
    fields: readonly CredentialBindingField[] = [],
  ) {
    const uniqueFields = Object.freeze([...new Set(fields)]);
    const remediation = CODE_REMEDIATION[code];
    super(
      `webchannel ${document} ${code}` +
        (uniqueFields.length > 0 ? ` (${uniqueFields.join(", ")})` : "") +
        (remediation ? `: ${remediation}` : ""),
    );
    this.name = "StorageDocumentError";
    this.code = code;
    this.document = document;
    this.fields = uniqueFields;
  }
}

/**
 * Classify a persisted document `version` against the version this build writes.
 *
 * A version ABOVE the supported one is NOT corruption — it is the fingerprint of
 * a release newer than this one, i.e. an operator downgrade (#159). Callers own
 * quarantine policy, and every quarantine path in this package is keyed on
 * `invalid-document`; returning a distinct code is what keeps a future document
 * out of archive-and-continue and out of any replacing write.
 *
 * Everything else keeps its existing classification: an absent, non-numeric,
 * non-integral, or OLDER version stays `invalid-document`. Upgrading forward is
 * a separate contract this function deliberately does not touch.
 */
export function assertSupportedDocumentVersion(
  document: SecretDocumentKind,
  supported: number,
  value: unknown,
): void {
  if (value === supported) return;
  assertDocumentVersionNotFromFuture(document, supported, value);
  throw new StorageDocumentError(document, "invalid-document");
}

/**
 * Reject only a well-formed top-level version from a newer release.
 *
 * Secret documents call this before identity validation so a future release
 * that advances both version domains is still recognized as a downgrade. The
 * full version assertion remains after identity validation, preserving the
 * identity-first classification of explicit markers for current, older, and
 * malformed versions.
 */
export function assertDocumentVersionNotFromFuture(
  document: SecretDocumentKind,
  supported: number,
  value: unknown,
): void {
  if (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > supported
  ) {
    throw new StorageDocumentError(document, "version-too-new");
  }
}

/** True for the one code that means "a newer release wrote this file". */
export function isVersionTooNew(error: unknown): error is StorageDocumentError {
  return (
    error instanceof StorageDocumentError && error.code === "version-too-new"
  );
}

export function credentialStorageFailureDiagnostic(
  error: StorageDocumentError,
): { code: string; detail: string } {
  return {
    code: `credential-storage-${error.code}`,
    detail:
      `credential storage/migration failed (code=${error.code}); stop all old ` +
      `WebChannel plugin processes for this account, inspect the recoverable ` +
      `legacy backup if present, then retry`,
  };
}

export function assertDocumentStorageIdentity(
  document: SecretDocumentKind,
  expectedScope: StorageScopeIdentity,
  persistedIdentity: unknown,
): void {
  const inspection = inspectStorageIdentityV2(
    createStorageIdentityV2(expectedScope),
    persistedIdentity === undefined ? {} : persistedIdentity,
  );
  if (inspection.status === "match") return;
  throw inspectionError(document, inspection);
}

function inspectionError(
  document: SecretDocumentKind,
  inspection: Exclude<IdentityInspection, { status: "match" }>,
): StorageDocumentError {
  switch (inspection.status) {
    case "unbound":
      return new StorageDocumentError(document, "identity-unbound");
    case "incomplete":
      return new StorageDocumentError(
        document,
        "identity-incomplete",
        inspection.fields,
      );
    case "invalid":
      return new StorageDocumentError(
        document,
        "identity-invalid",
        inspection.fields,
      );
    case "mismatch":
      return new StorageDocumentError(
        document,
        "identity-mismatch",
        inspection.fields,
      );
  }
}
