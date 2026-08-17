/**
 * Storage Identity v2 contract shared by the future credential-binding (#63)
 * and tenant-aware persistence (#71) work.
 *
 * This module is deliberately pure: it validates and compares identity facts,
 * and derives an opaque path-safe namespace id. It does not choose paths, read
 * or write stores, migrate legacy material, or decide remediation policy.
 */

import { createHash } from "node:crypto";

import { assertValidAccountId } from "./account-id.js";
import { isAbsoluteHttpUrl } from "./saas-authority.js";
import { assertValidSubjectToken } from "./subject-token.js";

export const STORAGE_IDENTITY_VERSION = 2 as const;

const STORAGE_NAMESPACE_DOMAIN =
  "openclaw-webchannel/storage-identity/v2";
const STORAGE_NAMESPACE_PREFIX = "v2_";
const STORAGE_NAMESPACE_DIGEST_BYTES = 32;

export type StorageScopeIdentity = Readonly<{
  tenant: string;
  accountId: string;
}>;

/**
 * Facts that bind enrolled credentials to one configured runtime identity.
 *
 * `null` means the enrollment generation genuinely did not deliver that fact.
 * Omitting the field is not equivalent: a missing field is an incomplete legacy
 * shape and must be classified before any future migration can use it.
 */
export type CredentialBindingFacts = Readonly<{
  saasBaseUrl: string;
  deliveredIssuer: string | null;
  relayUrl: string | null;
  agentPublicKey: string;
}>;

/** Minimal identity metadata future secret-bearing store documents embed. */
export type StorageIdentityV2 = Readonly<{
  identityVersion: typeof STORAGE_IDENTITY_VERSION;
  storage: StorageScopeIdentity;
}>;

/** Complete credential binding future credentials documents embed. */
export type CredentialBindingIdentityV2 = Readonly<{
  identityVersion: typeof STORAGE_IDENTITY_VERSION;
  storage: StorageScopeIdentity;
  binding: CredentialBindingFacts;
}>;

export type StorageIdentityField =
  | "identityVersion"
  | "storage.tenant"
  | "storage.accountId";

export type CredentialBindingField =
  | StorageIdentityField
  | "binding.saasBaseUrl"
  | "binding.deliveredIssuer"
  | "binding.relayUrl"
  | "binding.agentPublicKey";

export type StorageIdentityErrorCode =
  | "invalid-shape"
  | "version-too-new"
  | "unsupported-version"
  | "invalid-field";

/**
 * Sanitized parse error. Only stable reason codes and field names are retained;
 * caller-supplied URLs, keys, tokens, and candidate objects are never attached.
 */
export class StorageIdentityContractError extends Error {
  readonly code: StorageIdentityErrorCode | "unbound" | "incomplete";
  readonly fields: readonly CredentialBindingField[];

  constructor(
    code: StorageIdentityErrorCode | "unbound" | "incomplete",
    fields: readonly CredentialBindingField[] = [],
  ) {
    const uniqueFields = Object.freeze([...new Set(fields)]);
    super(
      `webchannel storage identity ${code}` +
        (uniqueFields.length > 0 ? ` (${uniqueFields.join(", ")})` : ""),
    );
    this.name = "StorageIdentityContractError";
    this.code = code;
    this.fields = uniqueFields;
  }
}

export type IdentityInspection =
  | Readonly<{ status: "match" }>
  | Readonly<{ status: "mismatch"; fields: readonly CredentialBindingField[] }>
  | Readonly<{ status: "unbound" }>
  | Readonly<{ status: "incomplete"; fields: readonly CredentialBindingField[] }>
  | Readonly<{
      status: "invalid";
      code: StorageIdentityErrorCode;
      fields: readonly CredentialBindingField[];
    }>;

/** Construct validated, immutable storage identity metadata. */
export function createStorageIdentityV2(
  storage: StorageScopeIdentity,
): StorageIdentityV2 {
  const validated = validateStorageScope(storage);
  return Object.freeze({
    identityVersion: STORAGE_IDENTITY_VERSION,
    storage: validated,
  });
}

/** Construct a validated, immutable complete credential binding. */
export function createCredentialBindingIdentityV2(input: {
  storage: StorageScopeIdentity;
  binding: CredentialBindingFacts;
}): CredentialBindingIdentityV2 {
  const storage = validateStorageScope(input.storage);
  const binding = validateBindingFacts(input.binding);
  return Object.freeze({
    identityVersion: STORAGE_IDENTITY_VERSION,
    storage,
    binding,
  });
}

/**
 * Parse future v2 storage metadata. Throws only sanitized contract errors.
 *
 * A document without `identityVersion` is `unbound`, not corrupt: that is how
 * callers distinguish a legacy document from a malformed/unsupported v2 one.
 */
export function parseStorageIdentityV2(value: unknown): StorageIdentityV2 {
  const record = requireRecord(value);
  requireVersion(record);
  const storage = parseStorageScope(
    record.storage,
    Object.prototype.hasOwnProperty.call(record, "storage"),
  );
  return Object.freeze({
    identityVersion: STORAGE_IDENTITY_VERSION,
    storage,
  });
}

/** Parse future v2 credential binding metadata with sanitized failures. */
export function parseCredentialBindingIdentityV2(
  value: unknown,
): CredentialBindingIdentityV2 {
  const record = requireRecord(value);
  requireVersion(record);
  const storage = parseStorageScope(
    record.storage,
    Object.prototype.hasOwnProperty.call(record, "storage"),
  );
  const binding = parseBindingFacts(
    record.binding,
    Object.prototype.hasOwnProperty.call(record, "binding"),
  );
  return Object.freeze({
    identityVersion: STORAGE_IDENTITY_VERSION,
    storage,
    binding,
  });
}

/**
 * Compare raw persisted storage metadata against one known-good expected value.
 *
 * Returned diagnostics are content-free and therefore safe to serialize.
 */
export function inspectStorageIdentityV2(
  expected: StorageIdentityV2,
  persisted: unknown,
): IdentityInspection {
  const expectedIdentity = parseStorageIdentityV2(expected);
  const parsed = parseForInspection(parseStorageIdentityV2, persisted);
  if (!parsed.ok) return parsed.inspection;

  const fields: CredentialBindingField[] = [];
  if (expectedIdentity.storage.tenant !== parsed.value.storage.tenant) {
    fields.push("storage.tenant");
  }
  if (expectedIdentity.storage.accountId !== parsed.value.storage.accountId) {
    fields.push("storage.accountId");
  }
  return mismatchOrMatch(fields);
}

/**
 * Compare raw persisted credential binding against one known-good expected
 * value using only the field-specific equivalences documented below.
 */
export function inspectCredentialBindingIdentityV2(
  expected: CredentialBindingIdentityV2,
  persisted: unknown,
): IdentityInspection {
  const expectedIdentity = parseCredentialBindingIdentityV2(expected);
  const parsed = parseForInspection(
    parseCredentialBindingIdentityV2,
    persisted,
  );
  if (!parsed.ok) return parsed.inspection;

  const fields: CredentialBindingField[] = [];
  if (expectedIdentity.storage.tenant !== parsed.value.storage.tenant) {
    fields.push("storage.tenant");
  }
  if (expectedIdentity.storage.accountId !== parsed.value.storage.accountId) {
    fields.push("storage.accountId");
  }
  if (
    stripTrailingSlashes(expectedIdentity.binding.saasBaseUrl) !==
    stripTrailingSlashes(parsed.value.binding.saasBaseUrl)
  ) {
    fields.push("binding.saasBaseUrl");
  }
  if (
    !nullableTrailingSlashEqual(
      expectedIdentity.binding.deliveredIssuer,
      parsed.value.binding.deliveredIssuer,
    )
  ) {
    fields.push("binding.deliveredIssuer");
  }
  if (expectedIdentity.binding.relayUrl !== parsed.value.binding.relayUrl) {
    fields.push("binding.relayUrl");
  }
  if (
    expectedIdentity.binding.agentPublicKey !==
    parsed.value.binding.agentPublicKey
  ) {
    fields.push("binding.agentPublicKey");
  }
  return mismatchOrMatch(fields);
}

/**
 * Return a stable, fixed-length, path-safe id for an exact `(tenant,accountId)`.
 *
 * Length-prefixed UTF-8 fields prevent concatenation/delimiter ambiguity. The
 * digest is an index only: future documents must still embed and verify the
 * exact identity metadata before returning secrets.
 */
export function deriveStorageNamespaceId(
  storage: StorageScopeIdentity,
): string {
  const validated = validateStorageScope(storage);
  const hash = createHash("sha256");
  hash.update(frameUtf8(STORAGE_NAMESPACE_DOMAIN));
  hash.update(frameUtf8(validated.tenant));
  hash.update(frameUtf8(validated.accountId));
  const digest = hash.digest("base64url");
  if (
    Buffer.from(digest, "base64url").length !==
    STORAGE_NAMESPACE_DIGEST_BYTES
  ) {
    throw new Error("webchannel storage identity digest length invariant failed");
  }
  return `${STORAGE_NAMESPACE_PREFIX}${digest}`;
}

type ParseForInspection<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; inspection: IdentityInspection }>;

function parseForInspection<T>(
  parse: (value: unknown) => T,
  value: unknown,
): ParseForInspection<T> {
  try {
    return Object.freeze({ ok: true, value: parse(value) });
  } catch (error) {
    if (!(error instanceof StorageIdentityContractError)) {
      return Object.freeze({
        ok: false,
        inspection: invalidInspection("invalid-shape", []),
      });
    }
    if (error.code === "unbound") {
      return Object.freeze({
        ok: false,
        inspection: Object.freeze({ status: "unbound" }),
      });
    }
    if (error.code === "incomplete") {
      return Object.freeze({
        ok: false,
        inspection: Object.freeze({
          status: "incomplete",
          fields: error.fields,
        }),
      });
    }
    return Object.freeze({
      ok: false,
      inspection: invalidInspection(error.code, error.fields),
    });
  }
}

function mismatchOrMatch(
  fields: readonly CredentialBindingField[],
): IdentityInspection {
  if (fields.length === 0) return Object.freeze({ status: "match" });
  return Object.freeze({
    status: "mismatch",
    fields: Object.freeze([...fields]),
  });
}

function invalidInspection(
  code: StorageIdentityErrorCode,
  fields: readonly CredentialBindingField[],
): IdentityInspection {
  return Object.freeze({
    status: "invalid",
    code,
    fields: Object.freeze([...fields]),
  });
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new StorageIdentityContractError("invalid-shape");
  }
  if (!Object.prototype.hasOwnProperty.call(value, "identityVersion")) {
    throw new StorageIdentityContractError("unbound");
  }
  return value;
}

function requireVersion(record: Record<string, unknown>): void {
  const version = record.identityVersion;
  if (version === STORAGE_IDENTITY_VERSION) return;
  if (
    typeof version === "number" &&
    Number.isSafeInteger(version) &&
    version > STORAGE_IDENTITY_VERSION
  ) {
    throw new StorageIdentityContractError("version-too-new", [
      "identityVersion",
    ]);
  }
  throw new StorageIdentityContractError("unsupported-version", [
    "identityVersion",
  ]);
}

function parseStorageScope(
  value: unknown,
  propertyPresent: boolean,
): StorageScopeIdentity {
  const fields: readonly CredentialBindingField[] = [
    "storage.tenant",
    "storage.accountId",
  ];
  if (!propertyPresent) {
    throw new StorageIdentityContractError("incomplete", fields);
  }
  if (!isRecord(value)) {
    throw new StorageIdentityContractError("invalid-shape", fields);
  }
  const missing: CredentialBindingField[] = [];
  if (!Object.prototype.hasOwnProperty.call(value, "tenant")) {
    missing.push("storage.tenant");
  }
  if (!Object.prototype.hasOwnProperty.call(value, "accountId")) {
    missing.push("storage.accountId");
  }
  if (missing.length > 0) {
    throw new StorageIdentityContractError("incomplete", missing);
  }
  return validateStorageScope({
    tenant: value.tenant as string,
    accountId: value.accountId as string,
  });
}

function parseBindingFacts(
  value: unknown,
  propertyPresent: boolean,
): CredentialBindingFacts {
  const allFields: readonly CredentialBindingField[] = [
    "binding.saasBaseUrl",
    "binding.deliveredIssuer",
    "binding.relayUrl",
    "binding.agentPublicKey",
  ];
  if (!propertyPresent) {
    throw new StorageIdentityContractError("incomplete", allFields);
  }
  if (!isRecord(value)) {
    throw new StorageIdentityContractError("invalid-shape", allFields);
  }
  const missing = allFields.filter((field) => {
    const key = field.slice("binding.".length);
    return !Object.prototype.hasOwnProperty.call(value, key);
  });
  if (missing.length > 0) {
    throw new StorageIdentityContractError("incomplete", missing);
  }
  return validateBindingFacts({
    saasBaseUrl: value.saasBaseUrl as string,
    deliveredIssuer: value.deliveredIssuer as string | null,
    relayUrl: value.relayUrl as string | null,
    agentPublicKey: value.agentPublicKey as string,
  });
}

function validateStorageScope(
  storage: StorageScopeIdentity,
): StorageScopeIdentity {
  const invalid: CredentialBindingField[] = [];
  try {
    assertValidSubjectToken(storage?.tenant, "tenant");
  } catch {
    invalid.push("storage.tenant");
  }
  try {
    assertValidAccountId(storage?.accountId);
  } catch {
    invalid.push("storage.accountId");
  }
  if (invalid.length > 0) {
    throw new StorageIdentityContractError("invalid-field", invalid);
  }
  return Object.freeze({
    tenant: storage.tenant,
    accountId: storage.accountId,
  });
}

function validateBindingFacts(
  binding: CredentialBindingFacts,
): CredentialBindingFacts {
  const invalid: CredentialBindingField[] = [];
  if (!isAbsoluteHttpUrl(binding?.saasBaseUrl)) {
    invalid.push("binding.saasBaseUrl");
  }
  if (
    binding?.deliveredIssuer !== null &&
    !nonEmptyAfterTrailingSlash(binding?.deliveredIssuer)
  ) {
    invalid.push("binding.deliveredIssuer");
  }
  if (
    binding?.relayUrl !== null &&
    (typeof binding?.relayUrl !== "string" || binding.relayUrl.length === 0)
  ) {
    invalid.push("binding.relayUrl");
  }
  if (!isBase64Url32(binding?.agentPublicKey)) {
    invalid.push("binding.agentPublicKey");
  }
  if (invalid.length > 0) {
    throw new StorageIdentityContractError("invalid-field", invalid);
  }
  return Object.freeze({
    saasBaseUrl: binding.saasBaseUrl,
    deliveredIssuer: binding.deliveredIssuer,
    relayUrl: binding.relayUrl,
    agentPublicKey: binding.agentPublicKey,
  });
}

function nonEmptyAfterTrailingSlash(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    stripTrailingSlashes(value).length > 0
  );
}

function isBase64Url32(value: unknown): value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value)) {
    return false;
  }
  const decoded = Buffer.from(value, "base64url");
  return (
    decoded.length === 32 &&
    decoded.toString("base64url") === value
  );
}

function stripTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, "");
}

function nullableTrailingSlashEqual(
  left: string | null,
  right: string | null,
): boolean {
  if (left === null || right === null) return left === right;
  return stripTrailingSlashes(left) === stripTrailingSlashes(right);
}

function frameUtf8(value: string): Buffer {
  const bytes = Buffer.from(value, "utf8");
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(bytes.length);
  return Buffer.concat([length, bytes]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
