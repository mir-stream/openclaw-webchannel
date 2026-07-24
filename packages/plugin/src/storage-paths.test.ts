import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  defaultStorageRoot,
  legacyStorageRoot,
  resolveCredentialPath,
  tupleStoragePaths,
} from "./storage-paths.js";

describe("tuple storage paths", () => {
  it("uses the shared golden namespace vector for both secret stores", () => {
    const paths = tupleStoragePaths({
      tenant: "tenant-A",
      accountId: "Account_A",
      storageRoot: "/state",
    });
    expect(paths.namespaceId).toBe(
      "v2__FSO202TbQHl_AENTOBMvAjxxPu4RUKEd11N4yVtFUE",
    );
    expect(paths.directory).toBe(join("/state", paths.namespaceId));
    expect(paths.credentialPath).toBe(
      join(paths.directory, "credentials.json"),
    );
    expect(paths.conversationKeyPath).toBe(
      join(paths.directory, "conversation-keys.json"),
    );
  });

  it("separates exact case-sensitive tuples without exposing raw tenant in paths", () => {
    const variants = [
      { tenant: "tenant-A", accountId: "same" },
      { tenant: "tenant-B", accountId: "same" },
      { tenant: "Tenant-A", accountId: "same" },
    ].map((scope) =>
      tupleStoragePaths({ ...scope, storageRoot: "/state" }),
    );
    expect(new Set(variants.map((paths) => paths.directory)).size).toBe(3);
    for (const paths of variants) {
      expect(paths.directory).not.toContain(paths.scope.tenant);
      expect(paths.directory).not.toContain(paths.scope.accountId);
    }
  });

  it("keeps exact credentialPath precedence from relocating conversation keys", () => {
    const base = {
      tenant: "tenant-A",
      accountId: "same",
      storageRoot: "/common/root",
    };
    const paths = tupleStoragePaths(base);
    expect(
      resolveCredentialPath({
        ...base,
        credentialPath: "/credential-only/credentials.json",
      }),
    ).toBe("/credential-only/credentials.json");
    expect(paths.conversationKeyPath).toBe(
      join(
        "/common/root",
        paths.namespaceId,
        "conversation-keys.json",
      ),
    );
  });

  it("keeps the default v2 root isolated from legacy binaries", () => {
    expect(defaultStorageRoot("/home/test")).toBe(
      "/home/test/.openclaw-webchannel-v2",
    );
    expect(defaultStorageRoot("/home/test")).not.toBe(
      legacyStorageRoot("/home/test"),
    );
  });

  it("validates scope and overrides before path construction", () => {
    expect(() =>
      tupleStoragePaths({
        tenant: "../tenant",
        accountId: "same",
        storageRoot: "/state",
      }),
    ).toThrow(/storage identity invalid-field/);
    expect(() =>
      tupleStoragePaths({
        tenant: "tenant-A",
        accountId: "../same",
        storageRoot: "/state",
      }),
    ).toThrow(/storage identity invalid-field/);
    expect(() =>
      tupleStoragePaths({
        tenant: "tenant-A",
        accountId: "same",
        storageRoot: "",
      }),
    ).toThrow(/storageRoot/);
    expect(() =>
      tupleStoragePaths({
        tenant: "tenant-A",
        accountId: "same",
        storageRoot: "relative/state",
      }),
    ).toThrow(/storageRoot must be an absolute filesystem path/);
  });

  it("rejects a relative credentialPath independently of process cwd", () => {
    const originalCwd = process.cwd();
    const first = mkdtempSync(join(tmpdir(), "webchannel-cwd-a-"));
    const second = mkdtempSync(join(tmpdir(), "webchannel-cwd-b-"));
    try {
      for (const cwd of [first, second]) {
        process.chdir(cwd);
        expect(() =>
          resolveCredentialPath({
            tenant: "tenant-A",
            accountId: "same",
            storageRoot: "/state",
            credentialPath: "relative/credentials.json",
          }),
        ).toThrow(/credentialPath must be an absolute filesystem path/);
      }
    } finally {
      process.chdir(originalCwd);
      rmSync(first, { recursive: true, force: true });
      rmSync(second, { recursive: true, force: true });
    }
  });
});
