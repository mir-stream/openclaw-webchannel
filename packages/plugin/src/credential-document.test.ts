import { describe, expect, it } from "vitest";

import {
  CREDENTIAL_BINDING_IDENTITY_FIELD,
  CredentialDocumentBindingError,
  createCredentialIdentityForEnrollment,
  formatCredentialInspection,
  inspectCredentialDocument,
  inspectCredentialDocumentJson,
  loadBoundCredentialDocument,
} from "./credential-document.js";
import { generateKeyPair } from "./e2e-crypto.js";

const PAIR = generateKeyPair();
const OTHER_PAIR = generateKeyPair();
const PUBLIC_KEY = Buffer.from(PAIR.publicKey).toString("base64url");
const PRIVATE_KEY = Buffer.from(PAIR.privateKey).toString("base64url");
const OTHER_KEY = Buffer.from(OTHER_PAIR.publicKey).toString("base64url");
const OTHER_PRIVATE_KEY = Buffer.from(OTHER_PAIR.privateKey).toString("base64url");
const EXPECTED = Object.freeze({
  tenant: "tenant-A",
  accountId: "Account_A",
  saasBaseUrl: "https://control.example/api",
});

function completeDocument() {
  return {
    [CREDENTIAL_BINDING_IDENTITY_FIELD]:
      createCredentialIdentityForEnrollment({
        ...EXPECTED,
        deliveredIssuer: "https://issuer.example/logical",
        relayUrl: "wss://relay.example/socket",
        agentPublicKey: PUBLIC_KEY,
      }),
    identityKey: {
      publicKey: PUBLIC_KEY,
      privateKey: PRIVATE_KEY,
    },
    enrollment: {
      creds: {
        userJwt: "SECRET-JWT",
        userSeed: "SECRET-SEED",
      },
      peerId: "peer-a",
      jwksUrl: "https://keys.example/jwks",
      bootstrapUrl: "https://bootstrap.example",
      natsUrl: "wss://relay.example/socket",
      issuer: "https://issuer.example/logical",
    },
    accountId: "Account_A",
    tenant: "tenant-A",
    saasEnrollUrl: "https://control.example/api/enroll",
    saasPollUrl: "https://control.example/api/poll",
  };
}

function cloneDocument(): Record<string, any> {
  return JSON.parse(JSON.stringify(completeDocument())) as Record<string, any>;
}

describe("credential document semantic binding", () => {
  it("loads a complete unchanged control and exposes secrets only on match", () => {
    expect(inspectCredentialDocument(EXPECTED, completeDocument())).toEqual({
      status: "match",
    });
    const loaded = loadBoundCredentialDocument(EXPECTED, completeDocument());
    expect(loaded.status).toBe("match");
    if (loaded.status === "match") {
      expect(loaded.credentials).toMatchObject({
        userJwt: "SECRET-JWT",
        userSeed: "SECRET-SEED",
        issuer: "https://issuer.example/logical",
        natsUrl: "wss://relay.example/socket",
      });
      expect(loaded.credentials.identityKey?.publicKey).toEqual(
        new Uint8Array(Buffer.from(PUBLIC_KEY, "base64url")),
      );
    }
  });

  it.each([
    ["storage.tenant", "tenant-B"],
    ["storage.accountId", "Account_B"],
    ["binding.saasBaseUrl", "https://other-control.example/api"],
    ["binding.deliveredIssuer", "https://other-issuer.example"],
    ["binding.relayUrl", "wss://other-relay.example/socket"],
    ["binding.agentPublicKey", OTHER_KEY],
  ] as const)("rejects a single embedded %s mutation", (field, replacement) => {
    const candidate = cloneDocument();
    const identity = candidate[CREDENTIAL_BINDING_IDENTITY_FIELD];
    const [group, key] = field.split(".");
    identity[group][key] = replacement;
    expect(inspectCredentialDocument(EXPECTED, candidate)).toEqual({
      status: "mismatch",
      fields: [field],
    });
  });

  it.each([
    ["tenant", "tenant-B", "storage.tenant"],
    ["accountId", "Account_B", "storage.accountId"],
    [
      "saasBaseUrl",
      "https://other-control.example/api",
      "binding.saasBaseUrl",
    ],
  ] as const)(
    "rejects a document reused under a different effective %s",
    (field, replacement, mismatchField) => {
      expect(
        inspectCredentialDocument(
          { ...EXPECTED, [field]: replacement },
          completeDocument(),
        ),
      ).toEqual({
        status: "mismatch",
        fields: [mismatchField],
      });
    },
  );

  it.each([
    ["enrollment.issuer", "binding.deliveredIssuer", "https://payload-issuer.example"],
    ["enrollment.natsUrl", "binding.relayUrl", "wss://payload-relay.example"],
    ["identityKey.publicKey", "binding.agentPublicKey", OTHER_KEY],
  ] as const)(
    "rejects payload drift in %s against independently embedded identity",
    (payloadField, bindingField, replacement) => {
      const candidate = cloneDocument();
      if (payloadField === "identityKey.publicKey") {
        candidate.identityKey.publicKey = replacement;
        candidate.identityKey.privateKey = OTHER_PRIVATE_KEY;
      } else {
        candidate.enrollment[payloadField.slice("enrollment.".length)] =
          replacement;
      }
      expect(inspectCredentialDocument(EXPECTED, candidate)).toEqual({
        status: "mismatch",
        fields: [bindingField],
      });
    },
  );

  it("reports multi-field drift and a cross-account file swap", () => {
    const candidate = cloneDocument();
    candidate.credentialIdentity.storage.tenant = "tenant-B";
    candidate.credentialIdentity.storage.accountId = "Account_B";
    candidate.credentialIdentity.binding.saasBaseUrl =
      "https://other.example";
    expect(inspectCredentialDocument(EXPECTED, candidate)).toEqual({
      status: "mismatch",
      fields: [
        "storage.tenant",
        "storage.accountId",
        "binding.saasBaseUrl",
      ],
    });

    expect(
      inspectCredentialDocument(
        {
          ...EXPECTED,
          tenant: "tenant-B",
          accountId: "Account_B",
        },
        completeDocument(),
      ),
    ).toEqual({
      status: "mismatch",
      fields: ["storage.tenant", "storage.accountId"],
    });
  });

  it("allows only SaaS/issuer trailing-slash equivalence", () => {
    const candidate = cloneDocument();
    candidate.credentialIdentity.binding.saasBaseUrl =
      `${EXPECTED.saasBaseUrl}///`;
    candidate.credentialIdentity.binding.deliveredIssuer =
      `${candidate.enrollment.issuer}///`;
    expect(inspectCredentialDocument(EXPECTED, candidate)).toEqual({
      status: "match",
    });

    candidate.credentialIdentity.binding.relayUrl =
      `${candidate.enrollment.natsUrl}/`;
    expect(inspectCredentialDocument(EXPECTED, candidate)).toEqual({
      status: "mismatch",
      fields: ["binding.relayUrl"],
    });
  });

  it("accepts independent custom-domain SaaS, issuer, JWKS, and relay hosts", () => {
    const candidate = cloneDocument();
    candidate.enrollment.jwksUrl = "https://keys.cdn.example/jwks";
    candidate.enrollment.bootstrapUrl = "https://login.proxy.example/bootstrap";
    expect(inspectCredentialDocument(EXPECTED, candidate)).toEqual({
      status: "match",
    });
  });

  it("supports an explicit null issuer only when the payload omits it", () => {
    const candidate = cloneDocument();
    delete candidate.enrollment.issuer;
    candidate.credentialIdentity.binding.deliveredIssuer = null;
    expect(inspectCredentialDocument(EXPECTED, candidate)).toEqual({
      status: "match",
    });
  });

  it.each([
    ["absent", undefined],
    ["null", null],
    ["empty", ""],
  ])("rejects a reusable v2 document with %s delivered relay provenance", (_label, value) => {
    const candidate = cloneDocument();
    if (value === undefined) {
      delete candidate.enrollment.natsUrl;
    } else {
      candidate.enrollment.natsUrl = value;
    }
    candidate.credentialIdentity.binding.relayUrl = null;
    expect(inspectCredentialDocument(EXPECTED, candidate)).toEqual({
      status: "invalid",
      code: "invalid-document",
      fields: ["enrollment.natsUrl"],
    });
  });

  it("rejects well-shaped X25519 halves that do not form one key pair", () => {
    const candidate = cloneDocument();
    candidate.identityKey.privateKey = OTHER_PRIVATE_KEY;
    expect(inspectCredentialDocument(EXPECTED, candidate)).toEqual({
      status: "invalid",
      code: "invalid-document",
      fields: ["identityKey.publicKey", "identityKey.privateKey"],
    });
  });

  it("distinguishes legacy, incomplete, corrupt, and unsupported metadata", () => {
    const legacy = cloneDocument();
    delete legacy[CREDENTIAL_BINDING_IDENTITY_FIELD];
    expect(inspectCredentialDocument(EXPECTED, legacy)).toEqual({
      status: "unbound",
    });

    const incomplete = cloneDocument();
    delete incomplete.credentialIdentity.binding.relayUrl;
    expect(inspectCredentialDocument(EXPECTED, incomplete)).toEqual({
      status: "incomplete",
      fields: ["binding.relayUrl"],
    });

    const corrupt = cloneDocument();
    corrupt.credentialIdentity.binding.agentPublicKey = "not-a-key";
    expect(inspectCredentialDocument(EXPECTED, corrupt)).toEqual({
      status: "invalid",
      code: "invalid-field",
      fields: ["binding.agentPublicKey"],
    });

    const unsupported = cloneDocument();
    unsupported.credentialIdentity.identityVersion = 99;
    expect(inspectCredentialDocument(EXPECTED, unsupported)).toEqual({
      status: "invalid",
      code: "unsupported-version",
      fields: ["identityVersion"],
    });
  });

  it("rejects malformed payload fields before returning any secret", () => {
    const candidate = cloneDocument();
    candidate.enrollment.creds.userSeed = "";
    candidate.identityKey.privateKey = "bad-private-key";
    expect(inspectCredentialDocument(EXPECTED, candidate)).toEqual({
      status: "invalid",
      code: "invalid-document",
      fields: [
        "identityKey.privateKey",
        "enrollment.creds.userSeed",
      ],
    });
    expect(loadBoundCredentialDocument(EXPECTED, candidate)).not.toHaveProperty(
      "credentials",
    );
  });

  it("returns exact content-free diagnostics for errors and logs", () => {
    const secretRelay =
      "wss://user:password@relay.example/private?access_token=top-secret";
    const secretIssuer =
      "https://issuer-user:issuer-pass@example/private?key=issuer-secret";
    const candidate = cloneDocument();
    candidate.credentialIdentity.binding.relayUrl = secretRelay;
    candidate.credentialIdentity.binding.deliveredIssuer = secretIssuer;
    candidate.credentialIdentity.binding.agentPublicKey = OTHER_KEY;
    candidate.identityKey.privateKey = PRIVATE_KEY;

    const inspection = inspectCredentialDocument(EXPECTED, candidate);
    expect(inspection).toEqual({
      status: "mismatch",
      fields: [
        "binding.deliveredIssuer",
        "binding.relayUrl",
        "binding.agentPublicKey",
      ],
    });
    const error = new CredentialDocumentBindingError(
      inspection.status === "match" ? { status: "absent" } : inspection,
    );
    const serialized = JSON.stringify({
      inspection,
      message: error.message,
      detail:
        inspection.status === "match"
          ? ""
          : formatCredentialInspection(inspection),
    });
    for (const secret of [
      "SECRET-JWT",
      "SECRET-SEED",
      secretRelay,
      secretIssuer,
      OTHER_KEY,
      PRIVATE_KEY,
      "password",
      "top-secret",
      "issuer-secret",
    ]) {
      expect(serialized).not.toContain(secret);
    }
    expect(serialized).toContain("binding.relayUrl");
    expect(serialized).toContain("binding.agentPublicKey");
  });

  it("classifies malformed JSON without echoing source bytes", () => {
    const source = "{SECRET-JWT SECRET-SEED private-key";
    const inspection = inspectCredentialDocumentJson(EXPECTED, source);
    expect(inspection).toEqual({
      status: "invalid",
      code: "invalid-json",
      fields: [],
    });
    expect(JSON.stringify(inspection)).not.toContain(source);
  });
});
