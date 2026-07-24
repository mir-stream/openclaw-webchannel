import { describe, expect, it } from "vitest";

import {
  STORAGE_IDENTITY_VERSION,
  StorageIdentityContractError,
  createCredentialBindingIdentityV2,
  createStorageIdentityV2,
  deriveStorageNamespaceId,
  inspectCredentialBindingIdentityV2,
  inspectStorageIdentityV2,
  parseCredentialBindingIdentityV2,
} from "./storage-identity.js";

const PUBLIC_KEY = Buffer.alloc(32, 7).toString("base64url");
const OTHER_PUBLIC_KEY = Buffer.alloc(32, 8).toString("base64url");

function completeIdentity() {
  return createCredentialBindingIdentityV2({
    storage: { tenant: "tenant-A", accountId: "Account_A" },
    binding: {
      saasBaseUrl: "https://saas.example/base",
      deliveredIssuer: "https://issuer.example",
      relayUrl: "wss://relay.example/socket?credential=secret-relay",
      agentPublicKey: PUBLIC_KEY,
    },
  });
}

function cloneIdentity(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(completeIdentity())) as Record<string, unknown>;
}

function setField(
  value: Record<string, unknown>,
  field:
    | "tenant"
    | "accountId"
    | "saasBaseUrl"
    | "deliveredIssuer"
    | "relayUrl"
    | "agentPublicKey",
  replacement: unknown,
): void {
  if (field === "tenant" || field === "accountId") {
    (value.storage as Record<string, unknown>)[field] = replacement;
  } else {
    (value.binding as Record<string, unknown>)[field] = replacement;
  }
}

describe("Storage Identity v2 contract", () => {
  it("constructs, parses, and compares a complete known-good identity", () => {
    const expected = completeIdentity();
    expect(expected).toEqual({
      identityVersion: STORAGE_IDENTITY_VERSION,
      storage: { tenant: "tenant-A", accountId: "Account_A" },
      binding: {
        saasBaseUrl: "https://saas.example/base",
        deliveredIssuer: "https://issuer.example",
        relayUrl: "wss://relay.example/socket?credential=secret-relay",
        agentPublicKey: PUBLIC_KEY,
      },
    });
    expect(parseCredentialBindingIdentityV2(cloneIdentity())).toEqual(expected);
    expect(inspectCredentialBindingIdentityV2(expected, cloneIdentity())).toEqual({
      status: "match",
    });
  });

  it.each([
    ["tenant", "tenant-B", "storage.tenant"],
    ["accountId", "Account_B", "storage.accountId"],
    [
      "saasBaseUrl",
      "https://other-saas.example/base",
      "binding.saasBaseUrl",
    ],
    [
      "deliveredIssuer",
      "https://other-issuer.example",
      "binding.deliveredIssuer",
    ],
    [
      "relayUrl",
      "wss://other-relay.example/socket",
      "binding.relayUrl",
    ],
    ["agentPublicKey", OTHER_PUBLIC_KEY, "binding.agentPublicKey"],
  ] as const)(
    "detects a single %s mutation after the valid control",
    (field, replacement, mismatchField) => {
      const expected = completeIdentity();
      const candidate = cloneIdentity();
      setField(candidate, field, replacement);
      expect(inspectCredentialBindingIdentityV2(expected, candidate)).toEqual({
        status: "mismatch",
        fields: [mismatchField],
      });
    },
  );

  it("allows trailing-slash-only SaaS and issuer variants", () => {
    const expected = completeIdentity();
    const candidate = cloneIdentity();
    setField(candidate, "saasBaseUrl", "https://saas.example/base///");
    setField(candidate, "deliveredIssuer", "https://issuer.example///");
    expect(inspectCredentialBindingIdentityV2(expected, candidate)).toEqual({
      status: "match",
    });
  });

  it.each([
    "not a url",
    "/relative",
    "ftp://saas.example",
    "https://saas.example?secret=query",
    "https://saas.example#fragment",
    "https://user:secret@saas.example",
    " https://saas.example",
  ])("rejects invalid SaaS authority without echoing it: %s", (saasBaseUrl) => {
    const candidate = cloneIdentity();
    setField(candidate, "saasBaseUrl", saasBaseUrl);
    const inspection = inspectCredentialBindingIdentityV2(
      completeIdentity(),
      candidate,
    );
    expect(inspection).toEqual({
      status: "invalid",
      code: "invalid-field",
      fields: ["binding.saasBaseUrl"],
    });
    expect(JSON.stringify(inspection)).not.toContain(saasBaseUrl);
  });

  it("preserves an accepted SaaS URL byte-for-byte", () => {
    const exact = "https://SaaS.Example:8443/control/path";
    const identity = createCredentialBindingIdentityV2({
      storage: { tenant: "tenant-A", accountId: "Account_A" },
      binding: {
        ...completeIdentity().binding,
        saasBaseUrl: exact,
      },
    });
    expect(identity.binding.saasBaseUrl).toBe(exact);
  });

  it("does not normalize a distinct SaaS path or any relay suffix", () => {
    const expected = completeIdentity();

    const differentPath = cloneIdentity();
    setField(
      differentPath,
      "saasBaseUrl",
      "https://saas.example/other-base",
    );
    expect(
      inspectCredentialBindingIdentityV2(expected, differentPath),
    ).toEqual({
      status: "mismatch",
      fields: ["binding.saasBaseUrl"],
    });

    const relaySlash = cloneIdentity();
    setField(
      relaySlash,
      "relayUrl",
      "wss://relay.example/socket?credential=secret-relay/",
    );
    expect(inspectCredentialBindingIdentityV2(expected, relaySlash)).toEqual({
      status: "mismatch",
      fields: ["binding.relayUrl"],
    });
  });

  it("reports every independently changed semantic field", () => {
    const expected = completeIdentity();
    const candidate = cloneIdentity();
    setField(candidate, "tenant", "tenant-B");
    setField(candidate, "saasBaseUrl", "https://other-saas.example");
    setField(candidate, "agentPublicKey", OTHER_PUBLIC_KEY);
    expect(inspectCredentialBindingIdentityV2(expected, candidate)).toEqual({
      status: "mismatch",
      fields: [
        "storage.tenant",
        "binding.saasBaseUrl",
        "binding.agentPublicKey",
      ],
    });
  });

  it("derives stable, fixed, path-safe, tuple-separated namespace ids", () => {
    const scope = { tenant: "tenant-A", accountId: "Account_A" };
    const first = deriveStorageNamespaceId(scope);
    const second = deriveStorageNamespaceId(scope);
    expect(first).toBe(second);
    expect(first).toBe("v2__FSO202TbQHl_AENTOBMvAjxxPu4RUKEd11N4yVtFUE");
    expect(first).toMatch(/^v2_[A-Za-z0-9_-]{43}$/);

    const variants = [
      { tenant: "tenant-B", accountId: "Account_A" },
      { tenant: "tenant-A", accountId: "Account_B" },
      { tenant: "Tenant-A", accountId: "Account_A" },
      { tenant: "ab", accountId: "c" },
      { tenant: "a", accountId: "bc" },
    ];
    const ids = new Set([
      first,
      ...variants.map((variant) => deriveStorageNamespaceId(variant)),
    ]);
    expect(ids.size).toBe(variants.length + 1);
  });

  it("rejects invalid tenant/account scope before namespace derivation", () => {
    expect(() =>
      deriveStorageNamespaceId({ tenant: "tenant.with.dot", accountId: "A" }),
    ).toThrow(StorageIdentityContractError);
    expect(() =>
      deriveStorageNamespaceId({ tenant: "tenant-A", accountId: "../A" }),
    ).toThrow(StorageIdentityContractError);
  });

  it("distinguishes unbound, incomplete, unsupported, and invalid shapes", () => {
    const expected = completeIdentity();
    expect(inspectCredentialBindingIdentityV2(expected, {})).toEqual({
      status: "unbound",
    });
    expect(
      inspectCredentialBindingIdentityV2(expected, {
        identityVersion: STORAGE_IDENTITY_VERSION,
        storage: { tenant: "tenant-A" },
      }),
    ).toEqual({
      status: "incomplete",
      fields: ["storage.accountId"],
    });
    expect(
      inspectCredentialBindingIdentityV2(expected, {
        ...cloneIdentity(),
        identityVersion: 99,
      }),
    ).toEqual({
      status: "invalid",
      code: "unsupported-version",
      fields: ["identityVersion"],
    });
    expect(inspectCredentialBindingIdentityV2(expected, [])).toEqual({
      status: "invalid",
      code: "invalid-shape",
      fields: [],
    });
    expect(
      inspectCredentialBindingIdentityV2(expected, {
        identityVersion: STORAGE_IDENTITY_VERSION,
        storage: null,
      }),
    ).toEqual({
      status: "invalid",
      code: "invalid-shape",
      fields: ["storage.tenant", "storage.accountId"],
    });
    expect(
      inspectCredentialBindingIdentityV2(expected, {
        identityVersion: STORAGE_IDENTITY_VERSION,
        storage: { tenant: "tenant-A", accountId: "Account_A" },
        binding: [],
      }),
    ).toEqual({
      status: "invalid",
      code: "invalid-shape",
      fields: [
        "binding.saasBaseUrl",
        "binding.deliveredIssuer",
        "binding.relayUrl",
        "binding.agentPublicKey",
      ],
    });
  });

  it("treats missing binding facts as incomplete, including legacy absence", () => {
    const expected = completeIdentity();
    const candidate = cloneIdentity();
    delete (candidate.binding as Record<string, unknown>).deliveredIssuer;
    delete (candidate.binding as Record<string, unknown>).relayUrl;
    expect(inspectCredentialBindingIdentityV2(expected, candidate)).toEqual({
      status: "incomplete",
      fields: ["binding.deliveredIssuer", "binding.relayUrl"],
    });
  });

  it("supports explicit unavailable delivered facts without inventing values", () => {
    const expected = createCredentialBindingIdentityV2({
      storage: { tenant: "tenant-A", accountId: "Account_A" },
      binding: {
        saasBaseUrl: "https://saas.example",
        deliveredIssuer: null,
        relayUrl: null,
        agentPublicKey: PUBLIC_KEY,
      },
    });
    expect(
      inspectCredentialBindingIdentityV2(
        expected,
        JSON.parse(JSON.stringify(expected)),
      ),
    ).toEqual({ status: "match" });
  });

  it("returns content-free diagnostics and sanitized parse errors", () => {
    const expected = completeIdentity();
    const candidate = cloneIdentity();
    const secretUrl =
      "wss://user:password@relay.example/private-token?access_token=top-secret";
    const secretKey = Buffer.alloc(32, 99).toString("base64url");
    setField(candidate, "relayUrl", secretUrl);
    setField(candidate, "agentPublicKey", secretKey);

    const serialized = JSON.stringify(
      inspectCredentialBindingIdentityV2(expected, candidate),
    );
    expect(serialized).not.toContain(secretUrl);
    expect(serialized).not.toContain(secretKey);
    expect(serialized).not.toContain("password");
    expect(serialized).toContain("binding.relayUrl");
    expect(serialized).toContain("binding.agentPublicKey");

    const malformed = cloneIdentity();
    setField(malformed, "agentPublicKey", "private-key-material");
    let thrown: unknown;
    try {
      parseCredentialBindingIdentityV2(malformed);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(StorageIdentityContractError);
    expect(String(thrown)).not.toContain("private-key-material");
  });

  it("compares the independently reusable storage-only identity", () => {
    const expected = createStorageIdentityV2({
      tenant: "tenant-A",
      accountId: "Account_A",
    });
    expect(inspectStorageIdentityV2(expected, expected)).toEqual({
      status: "match",
    });
    expect(
      inspectStorageIdentityV2(expected, {
        identityVersion: STORAGE_IDENTITY_VERSION,
        storage: { tenant: "tenant-B", accountId: "Account_A" },
      }),
    ).toEqual({
      status: "mismatch",
      fields: ["storage.tenant"],
    });
  });
});
