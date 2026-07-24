/**
 * Complete persisted enrollment-credential document parser and binding gate.
 *
 * This is the one interpretation of credentials.json shared by setup, runtime,
 * status, and enrollment. Inspection is deliberately content-free: only stable
 * status/code values and field names leave this module. Secret material is
 * returned only by the load API after the complete v2 binding is proven.
 */

import type { KeyPair } from "./e2e-crypto.js";
import {
  createCredentialBindingIdentityV2,
  inspectCredentialBindingIdentityV2,
  type CredentialBindingField,
  type CredentialBindingIdentityV2,
  type IdentityInspection,
  type StorageIdentityErrorCode,
} from "./storage-identity.js";

/** The sole top-level field carrying credential identity metadata. */
export const CREDENTIAL_BINDING_IDENTITY_FIELD = "credentialIdentity" as const;

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
    natsUrl?: string;
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
  | "identityKey.publicKey"
  | "identityKey.privateKey"
  | "enrollment"
  | "enrollment.creds.userJwt"
  | "enrollment.creds.userSeed"
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
  if (!("payload" in evaluated)) return evaluated.inspection;
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
  const creds = enrollment && isRecord(enrollment.creds)
    ? enrollment.creds
    : undefined;
  if (!isNonEmptyString(creds?.userJwt)) {
    fields.push("enrollment.creds.userJwt");
  }
  if (!isNonEmptyString(creds?.userSeed)) {
    fields.push("enrollment.creds.userSeed");
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
  if (
    relayPresent &&
    !isNonEmptyString(enrollment?.natsUrl)
  ) {
    fields.push("enrollment.natsUrl");
  }
  if (fields.length > 0) throw new InvalidCredentialPayload(fields);

  const encodedPublicKey = publicKey as string;
  const encodedPrivateKey = privateKey as string;
  const document = candidate as PluginCredentialDocument;
  const persisted = document.enrollment!;
  const identityKeyPair = Object.freeze({
    publicKey: new Uint8Array(Buffer.from(encodedPublicKey, "base64url")),
    privateKey: new Uint8Array(Buffer.from(encodedPrivateKey, "base64url")),
  });
  const credentials = Object.freeze({
    userJwt: persisted.creds.userJwt,
    userSeed: persisted.creds.userSeed,
    ...(relayPresent ? { natsUrl: persisted.natsUrl! } : {}),
    ...(issuerPresent ? { issuer: persisted.issuer! } : {}),
    identityKey: identityKeyPair,
  });
  return {
    document,
    deliveredIssuer: issuerPresent ? persisted.issuer! : null,
    relayUrl: relayPresent ? persisted.natsUrl! : null,
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
