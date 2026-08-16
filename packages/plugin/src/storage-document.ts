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
  | "storage-io-failed"
  | "legacy-claim-conflict"
  | "legacy-migration-failed";

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
    super(
      `webchannel ${document} ${code}` +
        (uniqueFields.length > 0 ? ` (${uniqueFields.join(", ")})` : ""),
    );
    this.name = "StorageDocumentError";
    this.code = code;
    this.document = document;
    this.fields = uniqueFields;
  }
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
