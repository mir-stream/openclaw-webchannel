/**
 * Complete persisted enrollment-credential document parser and binding gate.
 *
 * This is the one interpretation of credentials.json shared by setup, runtime,
 * status, and enrollment. Inspection is deliberately content-free: only stable
 * status/code values and field names leave this module. Secret material is
 * returned only by the load API after the complete v2 binding is proven.
 */

import { derivePublicKey, type KeyPair } from "./e2e-crypto.js";
import { deriveEnrollmentEndpoints } from "./saas-authority.js";
import {
  createCredentialBindingIdentityV2,
  inspectCredentialBindingIdentityV2,
  STORAGE_IDENTITY_VERSION,
  type CredentialBindingField,
  type CredentialBindingIdentityV2,
  type IdentityInspection,
  type StorageScopeIdentity,
  type StorageIdentityErrorCode,
} from "./storage-identity.js";
import {
  assertDocumentStorageIdentity,
  StorageDocumentError,
} from "./storage-document.js";

/** The sole top-level field carrying credential identity metadata. */
export const CREDENTIAL_BINDING_IDENTITY_FIELD = "credentialIdentity" as const;
/** Shared #63/#71 field name; no second storage-only identity block exists. */
export const CREDENTIAL_IDENTITY_FIELD = CREDENTIAL_BINDING_IDENTITY_FIELD;

export type PersistedNatsUserCredentials = {
  userJwt: string;
  userSeed: string;
  permissions?: {
    pub?: string[];
    sub?: string[];
  };
};

/**
 * In-memory/on-disk credential shape used by EnrollmentClient.
 *
 * `credentialIdentity` and `enrollment` are optional only while a fresh device
 * flow is in progress. A file is never reusable until both are complete.
 */
export type PluginCredentialDocument = {
  identityKey: {
    publicKey: string;
    privateKey: string;
  };
  enrollment?: {
    creds: PersistedNatsUserCredentials;
    peerId: string;
    jwksUrl: string;
    bootstrapUrl: string;
    natsUrl: string;
    issuer?: string;
  };
  accountId: string;
  tenant: string;
  saasEnrollUrl: string;
  saasPollUrl: string;
  [CREDENTIAL_BINDING_IDENTITY_FIELD]?: CredentialBindingIdentityV2;
};

export type BoundCredentialDocument = PluginCredentialDocument & {
  enrollment: NonNullable<PluginCredentialDocument["enrollment"]>;
  [CREDENTIAL_BINDING_IDENTITY_FIELD]: CredentialBindingIdentityV2;
};

/** The narrow secret-bearing projection runtime consumers receive on match. */
export type PersistedEnrolledCreds = {
  userJwt: string;
  userSeed: string;
  /**
   * SaaS-delivered relay. Required by every successful bound-document load;
   * optional here only for narrow injected diagnostic/test seams.
   */
  natsUrl?: string;
  issuer?: string;
  /** Present on every successful v2 load; optional only for injected test seams. */
  identityKey?: KeyPair;
};

/** Effective non-secret identity against which one document is checked. */
export type CredentialBindingExpectation = Readonly<{
  tenant: string;
  accountId: string;
  saasBaseUrl: string;
}>;

const EXPECTATION_VALIDATION_PUBLIC_KEY =
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

/**
 * Validate the effective non-secret identity independently of file existence.
 *
 * The storage contract currently validates complete binding objects, so a
 * fixed non-secret 32-byte public-key encoding supplies the payload-only field
 * while tenant/account/SaaS are checked.
 */
export function assertValidCredentialBindingExpectation(
  expected: CredentialBindingExpectation,
): void {
  createCredentialBindingIdentityV2({
    storage: {
      tenant: expected.tenant,
      accountId: expected.accountId,
    },
    binding: {
      saasBaseUrl: expected.saasBaseUrl,
      deliveredIssuer: null,
      relayUrl: null,
      agentPublicKey: EXPECTATION_VALIDATION_PUBLIC_KEY,
    },
  });
}

export type CredentialPayloadField =
  | "document"
  | "tenant"
  | "accountId"
  | "saasEnrollUrl"
  | "saasPollUrl"
  | "identityKey.publicKey"
  | "identityKey.privateKey"
  | "enrollment"
  | "enrollment.peerId"
  | "enrollment.jwksUrl"
  | "enrollment.bootstrapUrl"
  | "enrollment.creds.userJwt"
  | "enrollment.creds.userSeed"
  | "enrollment.creds.permissions"
  | "enrollment.creds.permissions.pub"
  | "enrollment.creds.permissions.sub"
  | "enrollment.issuer"
  | "enrollment.natsUrl";

export type CredentialDocumentField =
  | CredentialBindingField
  | CredentialPayloadField;

export type CredentialDocumentInvalidCode =
  | StorageIdentityErrorCode
  | "invalid-json"
  | "invalid-document"
  | "read-failed";

/** Sanitized inspection taxonomy; it never carries a candidate or secret. */
export type CredentialDocumentInspection =
  | Readonly<{ status: "match" }>
  | Readonly<{ status: "absent" }>
  | Readonly<{
      status: "mismatch";
      fields: readonly CredentialDocumentField[];
    }>
  | Readonly<{ status: "unbound" }>
  | Readonly<{
      status: "incomplete";
      fields: readonly CredentialDocumentField[];
    }>
  | Readonly<{
      status: "invalid";
      code: CredentialDocumentInvalidCode;
      fields: readonly CredentialDocumentField[];
    }>;

export type BoundCredentialLoadResult =
  | Readonly<{
      status: "match";
      document: BoundCredentialDocument;
      credentials: PersistedEnrolledCreds;
    }>
  | Exclude<CredentialDocumentInspection, Readonly<{ status: "match" }>>;

export type CredentialDocumentFailure = Exclude<
  CredentialDocumentInspection,
  { status: "match" }
>;

/** Typed sanitized failure for consumers that use exceptions. */
export class CredentialDocumentBindingError extends Error {
  readonly inspection: CredentialDocumentFailure;
  readonly code: string;
  readonly fields: readonly CredentialDocumentField[];

  constructor(inspection: CredentialDocumentFailure) {
    super(`webchannel ${formatCredentialInspection(inspection)}`);
    this.name = "CredentialDocumentBindingError";
    this.inspection = inspection;
    this.code = credentialInspectionCode(inspection);
    this.fields = "fields" in inspection ? inspection.fields : Object.freeze([]);
  }
}

type ParsedPayload = {
  document: PluginCredentialDocument;
  deliveredIssuer: string | null;
  relayUrl: string | null;
  agentPublicKey: string;
  credentials: PersistedEnrolledCreds;
};

type Evaluation =
  | {
      inspection: Readonly<{ status: "match" }>;
      payload: ParsedPayload;
      identity: CredentialBindingIdentityV2;
    }
  | {
      inspection: Exclude<
        CredentialDocumentInspection,
        Readonly<{ status: "match" }>
      >;
    };

class InvalidCredentialPayload extends Error {
  readonly fields: readonly CredentialPayloadField[];

  constructor(fields: readonly CredentialPayloadField[]) {
    super("webchannel credential document invalid");
    this.name = "InvalidCredentialPayload";
    this.fields = Object.freeze([...new Set(fields)]);
  }
}

/** Construct the identity persisted after a successful enrollment. */
export function createCredentialIdentityForEnrollment(input: {
  tenant: string;
  accountId: string;
  saasBaseUrl: string;
  deliveredIssuer?: string;
  relayUrl?: string;
  agentPublicKey: string;
}): CredentialBindingIdentityV2 {
  return createCredentialBindingIdentityV2({
    storage: {
      tenant: input.tenant,
      accountId: input.accountId,
    },
    binding: {
      saasBaseUrl: input.saasBaseUrl,
      deliveredIssuer: input.deliveredIssuer ?? null,
      relayUrl: input.relayUrl ?? null,
      agentPublicKey: input.agentPublicKey,
    },
  });
}

/** Verify only physical tuple ownership; complete binding is checked on load. */
export function assertCredentialDocumentStorage(
  scope: StorageScopeIdentity,
  candidate: unknown,
): void {
  if (!isRecord(candidate)) {
    throw new StorageDocumentError("credentials", "invalid-document");
  }
  assertCredentialIdentityVersionNotFromFuture(candidate);
  assertDocumentStorageIdentity(
    "credentials",
    scope,
    candidate[CREDENTIAL_BINDING_IDENTITY_FIELD],
  );
}

/** Exact legacy ownership evidence used before adopting collocated v1 state. */
export function legacyCredentialProvesScope(
  scope: StorageScopeIdentity,
  candidate: unknown,
): boolean {
  return (
    isRecord(candidate) &&
    candidate.tenant === scope.tenant &&
    candidate.accountId === scope.accountId
  );
}

export function parseCredentialJson(serialized: string): Record<string, unknown> {
  try {
    const candidate = JSON.parse(serialized) as unknown;
    if (!isRecord(candidate)) throw new Error("not an object");
    return candidate;
  } catch {
    throw new StorageDocumentError("credentials", "invalid-document");
  }
}

/** Base URL encoded by the legacy enrollment endpoint fields. */
export function enrollmentBaseUrl(saasEnrollUrl: string): string {
  const withoutTrailing = saasEnrollUrl.replace(/\/+$/, "");
  const suffix = "/api/enroll";
  return withoutTrailing.endsWith(suffix)
    ? withoutTrailing.slice(0, -suffix.length)
    : withoutTrailing;
}

/**
 * Add the shared complete identity to independently proven legacy credentials.
 * An existing identity is authoritative and may never be rebound.
 */
export function upgradeLegacyCredentialDocument(
  scope: StorageScopeIdentity,
  candidate: unknown,
): BoundCredentialDocument {
  if (!isRecord(candidate)) {
    throw new StorageDocumentError("credentials", "invalid-document");
  }
  assertCredentialIdentityVersionNotFromFuture(candidate);
  if (!legacyCredentialProvesScope(scope, candidate)) {
    throw new StorageDocumentError("credentials", "identity-mismatch", [
      "storage.tenant",
      "storage.accountId",
    ]);
  }
  const saasEnrollUrl = candidate.saasEnrollUrl;
  if (typeof saasEnrollUrl !== "string" || saasEnrollUrl.length === 0) {
    throw new StorageDocumentError("credentials", "invalid-document");
  }
  const expected: CredentialBindingExpectation = {
    ...scope,
    saasBaseUrl: enrollmentBaseUrl(saasEnrollUrl),
  };
  let document = candidate;
  const hadExplicitIdentity =
    Object.prototype.hasOwnProperty.call(
      document,
      CREDENTIAL_BINDING_IDENTITY_FIELD,
    );
  if (hadExplicitIdentity) {
    assertCredentialDocumentStorage(scope, document);
  } else {
    const identityKey = isRecord(document.identityKey)
      ? document.identityKey
      : undefined;
    const enrollment = isRecord(document.enrollment)
      ? document.enrollment
      : undefined;
    if (
      typeof identityKey?.publicKey !== "string" ||
      typeof enrollment?.natsUrl !== "string"
    ) {
      throw new StorageDocumentError("credentials", "invalid-document");
    }
    document = {
      ...document,
      [CREDENTIAL_BINDING_IDENTITY_FIELD]:
        createCredentialIdentityForEnrollment({
          ...scope,
          saasBaseUrl: expected.saasBaseUrl,
          ...(typeof enrollment.issuer === "string"
            ? { deliveredIssuer: enrollment.issuer }
            : {}),
          relayUrl: enrollment.natsUrl,
          agentPublicKey: identityKey.publicKey,
        }),
    };
  }
  const loaded = loadBoundCredentialDocument(expected, document);
  if (loaded.status !== "match") {
    // Storage ownership was already proven above. Any remaining #63 mismatch
    // is semantic binding/readiness failure, not permission to attribute the
    // collocated legacy key store to this tuple.
    throw new StorageDocumentError("credentials", "invalid-document");
  }
  return hadExplicitIdentity
    ? (document as BoundCredentialDocument)
    : loaded.document;
}

/** Inspect an already-parsed candidate without ever returning its contents. */
export function inspectCredentialDocument(
  expected: CredentialBindingExpectation,
  candidate: unknown,
): CredentialDocumentInspection {
  return evaluateCredentialDocument(expected, candidate).inspection;
}

/** Inspect serialized JSON with a stable, content-free malformed classification. */
export function inspectCredentialDocumentJson(
  expected: CredentialBindingExpectation,
  json: string,
): CredentialDocumentInspection {
  const parsed = parseJson(json);
  if (!parsed.ok) return parsed.inspection;
  return inspectCredentialDocument(expected, parsed.value);
}

/**
 * Load a serialized document only after its payload and v2 identity match.
 *
 * Unlike the inspection API, this explicitly secret-bearing API returns the
 * narrow runtime projection on success. Every failure remains sanitized.
 */
export function loadBoundCredentialDocumentJson(
  expected: CredentialBindingExpectation,
  json: string,
): BoundCredentialLoadResult {
  const parsed = parseJson(json);
  if (!parsed.ok) return parsed.inspection;
  return loadBoundCredentialDocument(expected, parsed.value);
}

/** Load an already-parsed candidate only after its complete binding is proven. */
export function loadBoundCredentialDocument(
  expected: CredentialBindingExpectation,
  candidate: unknown,
): BoundCredentialLoadResult {
  const evaluated = evaluateCredentialDocument(expected, candidate);
  if (!("payload" in evaluated)) {
    if (
      evaluated.inspection.status === "invalid" &&
      evaluated.inspection.code === "version-too-new"
    ) {
      throw new StorageDocumentError("credentials", "version-too-new");
    }
    return evaluated.inspection;
  }
  const document = {
    ...evaluated.payload.document,
    enrollment: evaluated.payload.document.enrollment!,
    [CREDENTIAL_BINDING_IDENTITY_FIELD]: evaluated.identity,
  } as BoundCredentialDocument;
  return Object.freeze({
    status: "match",
    document,
    credentials: evaluated.payload.credentials,
  });
}

/** Stable code used by setup/runtime/doctor diagnostics. */
export function credentialInspectionCode(
  inspection: Exclude<CredentialDocumentInspection, { status: "match" }>,
): string {
  if (inspection.status === "absent") return "credentials-absent";
  if (inspection.status === "mismatch") return "credentials-binding-mismatch";
  if (inspection.status === "unbound") return "credentials-unbound";
  if (inspection.status === "incomplete") return "credentials-binding-incomplete";
  return `credentials-invalid-${inspection.code}`;
}

/** Content-free detail suitable for logs and status. */
export function formatCredentialInspection(
  inspection: Exclude<CredentialDocumentInspection, { status: "match" }>,
): string {
  const code = credentialInspectionCode(inspection);
  const fields = "fields" in inspection ? inspection.fields : [];
  return fields.length > 0 ? `${code} fields=${fields.join(",")}` : code;
}

function evaluateCredentialDocument(
  expected: CredentialBindingExpectation,
  candidate: unknown,
): Evaluation {
  // A newer identity schema may legitimately change fields this build's payload
  // parser requires. Recognize only a well-formed future integer before payload
  // validation; every lower or malformed version keeps its existing precedence.
  if (hasFutureCredentialIdentityVersion(candidate)) {
    return {
      inspection: invalidInspection("version-too-new", ["identityVersion"]),
    };
  }
  let payload: ParsedPayload;
  try {
    payload = parsePayload(candidate);
  } catch (error) {
    const fields =
      error instanceof InvalidCredentialPayload ? error.fields : [];
    return {
      inspection: invalidInspection("invalid-document", fields),
    };
  }

  const expectedIdentity = createCredentialBindingIdentityV2({
    storage: {
      tenant: expected.tenant,
      accountId: expected.accountId,
    },
    binding: {
      saasBaseUrl: expected.saasBaseUrl,
      deliveredIssuer: payload.deliveredIssuer,
      relayUrl: payload.relayUrl,
      agentPublicKey: payload.agentPublicKey,
    },
  });
  const record = candidate as Record<string, unknown>;
  const rawIdentity = Object.prototype.hasOwnProperty.call(
    record,
    CREDENTIAL_BINDING_IDENTITY_FIELD,
  )
    ? record[CREDENTIAL_BINDING_IDENTITY_FIELD]
    : {};
  const identityInspection = inspectCredentialBindingIdentityV2(
    expectedIdentity,
    rawIdentity,
  );
  if (identityInspection.status !== "match") {
    return { inspection: fromIdentityInspection(identityInspection) };
  }
  const payloadMismatches: CredentialPayloadField[] = [];
  if (payload.document.tenant !== expected.tenant) {
    payloadMismatches.push("tenant");
  }
  if (payload.document.accountId !== expected.accountId) {
    payloadMismatches.push("accountId");
  }
  const endpoints = deriveEnrollmentEndpoints(expected.saasBaseUrl);
  if (payload.document.saasEnrollUrl !== endpoints.saasEnrollUrl) {
    payloadMismatches.push("saasEnrollUrl");
  }
  if (payload.document.saasPollUrl !== endpoints.saasPollUrl) {
    payloadMismatches.push("saasPollUrl");
  }
  if (payloadMismatches.length > 0) {
    return {
      inspection: Object.freeze({
        status: "mismatch",
        fields: Object.freeze(payloadMismatches),
      }),
    };
  }
  return {
    inspection: Object.freeze({ status: "match" }),
    payload,
    identity: expectedIdentity,
  };
}

function parsePayload(candidate: unknown): ParsedPayload {
  if (!isRecord(candidate)) {
    throw new InvalidCredentialPayload(["document"]);
  }
  const fields: CredentialPayloadField[] = [];
  if (!isNonEmptyString(candidate.tenant)) fields.push("tenant");
  if (!isNonEmptyString(candidate.accountId)) fields.push("accountId");
  if (!isNonEmptyString(candidate.saasEnrollUrl)) {
    fields.push("saasEnrollUrl");
  }
  if (!isNonEmptyString(candidate.saasPollUrl)) {
    fields.push("saasPollUrl");
  }
  const identityKey = isRecord(candidate.identityKey)
    ? candidate.identityKey
    : undefined;
  const publicKey = identityKey?.publicKey;
  const privateKey = identityKey?.privateKey;
  if (!isBase64Url32(publicKey)) fields.push("identityKey.publicKey");
  if (!isBase64Url32(privateKey)) fields.push("identityKey.privateKey");

  const enrollment = isRecord(candidate.enrollment)
    ? candidate.enrollment
    : undefined;
  if (!enrollment) fields.push("enrollment");
  if (!isNonEmptyString(enrollment?.peerId)) {
    fields.push("enrollment.peerId");
  }
  if (!isNonEmptyString(enrollment?.jwksUrl)) {
    fields.push("enrollment.jwksUrl");
  }
  if (!isNonEmptyString(enrollment?.bootstrapUrl)) {
    fields.push("enrollment.bootstrapUrl");
  }
  const creds = enrollment && isRecord(enrollment.creds)
    ? enrollment.creds
    : undefined;
  if (!isNonEmptyString(creds?.userJwt)) {
    fields.push("enrollment.creds.userJwt");
  }
  if (!isNonEmptyString(creds?.userSeed)) {
    fields.push("enrollment.creds.userSeed");
  }
  const permissionsPresent =
    Boolean(creds) &&
    Object.prototype.hasOwnProperty.call(creds, "permissions");
  const permissions =
    permissionsPresent && isRecord(creds?.permissions)
      ? creds.permissions
      : undefined;
  if (permissionsPresent && !permissions) {
    fields.push("enrollment.creds.permissions");
  }
  if (
    permissions &&
    Object.prototype.hasOwnProperty.call(permissions, "pub") &&
    !isStringArray(permissions.pub)
  ) {
    fields.push("enrollment.creds.permissions.pub");
  }
  if (
    permissions &&
    Object.prototype.hasOwnProperty.call(permissions, "sub") &&
    !isStringArray(permissions.sub)
  ) {
    fields.push("enrollment.creds.permissions.sub");
  }

  const issuerPresent =
    Boolean(enrollment) &&
    Object.prototype.hasOwnProperty.call(enrollment, "issuer");
  if (
    issuerPresent &&
    !isNonEmptyString(enrollment?.issuer)
  ) {
    fields.push("enrollment.issuer");
  }
  const relayPresent =
    Boolean(enrollment) &&
    Object.prototype.hasOwnProperty.call(enrollment, "natsUrl");
  // A reusable enrolled v2 document must carry the relay delivered alongside
  // its credentials. Treat absent/null/empty alike as invalid provenance:
  // binding relay=null must never authorize dialing a current config fallback.
  if (!relayPresent || !isNonEmptyString(enrollment?.natsUrl)) {
    fields.push("enrollment.natsUrl");
  }
  if (fields.length > 0) throw new InvalidCredentialPayload(fields);

  const encodedPublicKey = publicKey as string;
  const encodedPrivateKey = privateKey as string;
  const decodedPublicKey = new Uint8Array(
    Buffer.from(encodedPublicKey, "base64url"),
  );
  const decodedPrivateKey = new Uint8Array(
    Buffer.from(encodedPrivateKey, "base64url"),
  );
  let derivedPublicKey: Uint8Array;
  try {
    derivedPublicKey = derivePublicKey(decodedPrivateKey);
  } catch {
    throw new InvalidCredentialPayload(["identityKey.privateKey"]);
  }
  if (!Buffer.from(derivedPublicKey).equals(Buffer.from(decodedPublicKey))) {
    throw new InvalidCredentialPayload([
      "identityKey.publicKey",
      "identityKey.privateKey",
    ]);
  }
  const document = candidate as PluginCredentialDocument;
  const persisted = document.enrollment!;
  const identityKeyPair = Object.freeze({
    publicKey: decodedPublicKey,
    privateKey: decodedPrivateKey,
  });
  const credentials = Object.freeze({
    userJwt: persisted.creds.userJwt,
    userSeed: persisted.creds.userSeed,
    natsUrl: persisted.natsUrl!,
    ...(issuerPresent ? { issuer: persisted.issuer! } : {}),
    identityKey: identityKeyPair,
  });
  return {
    document,
    deliveredIssuer: issuerPresent ? persisted.issuer! : null,
    relayUrl: persisted.natsUrl!,
    agentPublicKey: encodedPublicKey,
    credentials,
  };
}

function fromIdentityInspection(
  inspection: Exclude<IdentityInspection, { status: "match" }>,
): Exclude<CredentialDocumentInspection, { status: "match" | "absent" }> {
  if (inspection.status === "unbound") {
    return Object.freeze({ status: "unbound" });
  }
  if (inspection.status === "incomplete") {
    return Object.freeze({
      status: "incomplete",
      fields: Object.freeze([...inspection.fields]),
    });
  }
  if (inspection.status === "mismatch") {
    return Object.freeze({
      status: "mismatch",
      fields: Object.freeze([...inspection.fields]),
    });
  }
  return invalidInspection(inspection.code, inspection.fields);
}

function invalidInspection(
  code: CredentialDocumentInvalidCode,
  fields: readonly CredentialDocumentField[],
): Readonly<{
  status: "invalid";
  code: CredentialDocumentInvalidCode;
  fields: readonly CredentialDocumentField[];
}> {
  return Object.freeze({
    status: "invalid",
    code,
    fields: Object.freeze([...new Set(fields)]),
  });
}

function parseJson(
  json: string,
):
  | Readonly<{ ok: true; value: unknown }>
  | Readonly<{
      ok: false;
      inspection: ReturnType<typeof invalidInspection>;
    }> {
  try {
    return Object.freeze({ ok: true, value: JSON.parse(json) as unknown });
  } catch {
    return Object.freeze({
      ok: false,
      inspection: invalidInspection("invalid-json", []),
    });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasFutureCredentialIdentityVersion(candidate: unknown): boolean {
  if (
    !isRecord(candidate) ||
    !Object.prototype.hasOwnProperty.call(
      candidate,
      CREDENTIAL_BINDING_IDENTITY_FIELD,
    )
  ) {
    return false;
  }
  const identity = candidate[CREDENTIAL_BINDING_IDENTITY_FIELD];
  if (!isRecord(identity)) return false;
  const version = identity.identityVersion;
  return (
    typeof version === "number" &&
    Number.isSafeInteger(version) &&
    version > STORAGE_IDENTITY_VERSION
  );
}

function assertCredentialIdentityVersionNotFromFuture(
  candidate: unknown,
): void {
  if (hasFutureCredentialIdentityVersion(candidate)) {
    throw new StorageDocumentError("credentials", "version-too-new");
  }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isBase64Url32(value: unknown): value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value)) {
    return false;
  }
  const decoded = Buffer.from(value, "base64url");
  return decoded.length === 32 && decoded.toString("base64url") === value;
}
