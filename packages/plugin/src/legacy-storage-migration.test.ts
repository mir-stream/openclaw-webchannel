import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  assertCredentialDocumentStorage,
  parseCredentialJson,
  upgradeLegacyCredentialDocument,
} from "./credential-document.js";
import { loadPersistedCredentialDocument } from "./account-config.js";
import {
  parseConversationKeyDocument,
  serializeConversationKeyDocument,
} from "./conversation-key-document.js";
import { ConversationKeyStore } from "./conversation-key-store.js";
import { derivePublicKey } from "./e2e-crypto.js";
import { migrateLegacyTupleState } from "./legacy-storage-migration.js";
import {
  legacyTuplePaths,
  tupleStoragePaths,
} from "./storage-paths.js";
import {
  createCredentialBindingIdentityV2,
  createStorageIdentityV2,
} from "./storage-identity.js";
import { StorageDocumentError } from "./storage-document.js";

const SCOPE = { tenant: "tenant-A", accountId: "shared-account" };
const OTHER_SCOPE = { tenant: "tenant-B", accountId: "shared-account" };
const PRIVATE_KEY = Buffer.alloc(32, 8).toString("base64url");
const PUBLIC_KEY = Buffer.from(
  derivePublicKey(Buffer.from(PRIVATE_KEY, "base64url")),
).toString("base64url");
const LEGACY_K = Buffer.alloc(32, 9);

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "webchannel-storage-migration-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function legacyCredential(
  scope = SCOPE,
  secretSuffix = "old",
): Record<string, unknown> {
  return {
    identityKey: {
      publicKey: PUBLIC_KEY,
      privateKey: PRIVATE_KEY,
    },
    enrollment: {
      creds: {
        userJwt: `JWT-${secretSuffix}`,
        userSeed: `SEED-${secretSuffix}`,
      },
      peerId: "agent-peer",
      jwksUrl: "https://saas.example/.well-known/jwks.json",
      bootstrapUrl: "https://saas.example/bootstrap",
      natsUrl: "wss://relay.example/socket",
      issuer: "https://issuer.example/",
    },
    accountId: scope.accountId,
    tenant: scope.tenant,
    saasEnrollUrl: "https://saas.example/api/enroll",
    saasPollUrl: "https://saas.example/api/poll",
  };
}

function writeLegacyState(
  scope = SCOPE,
  options: { credential?: boolean; keys?: boolean } = {},
): ReturnType<typeof legacyTuplePaths> {
  const paths = legacyTuplePaths(scope.accountId, home);
  mkdirSync(paths.directory, { recursive: true, mode: 0o700 });
  if (options.credential !== false) {
    writeFileSync(
      paths.credentialPath,
      JSON.stringify(legacyCredential(scope), null, 2),
      { mode: 0o600 },
    );
  }
  if (options.keys !== false) {
    writeFileSync(
      paths.conversationKeyPath,
      JSON.stringify(
        {
          version: 1,
          keys: { "same-peer": LEGACY_K.toString("base64url") },
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
  }
  return paths;
}

describe("legacy tuple storage migration", () => {
  it("rejects a symlinked legacy conversation-key file without touching its target", () => {
    const legacy = writeLegacyState(SCOPE, { keys: false });
    const external = join(home, "external-keys.json");
    const externalBytes = Buffer.from("TOP-SECRET external keys");
    writeFileSync(external, externalBytes, { mode: 0o640 });
    chmodSync(external, 0o640);
    symlinkSync(external, legacy.conversationKeyPath);
    const destination = tupleStoragePaths({ ...SCOPE, home });

    expect(() => migrateLegacyTupleState({ ...SCOPE, home })).toThrow(
      expect.objectContaining({ code: "legacy-migration-failed" }),
    );
    expect(readFileSync(external)).toEqual(externalBytes);
    expect(statSync(external).mode & 0o777).toBe(0o640);
    expect(lstatSync(legacy.conversationKeyPath).isSymbolicLink()).toBe(true);
    expect(existsSync(destination.credentialPath)).toBe(false);
    expect(existsSync(destination.conversationKeyPath)).toBe(false);
  });

  it("rejects a symlinked legacy credential without touching its target", () => {
    const legacy = writeLegacyState(SCOPE, { credential: false });
    const external = join(home, "external-credential.json");
    const externalBytes = Buffer.from(
      JSON.stringify(legacyCredential(SCOPE, "TOP-SECRET"), null, 2),
    );
    writeFileSync(external, externalBytes, { mode: 0o640 });
    chmodSync(external, 0o640);
    symlinkSync(external, legacy.credentialPath);
    const destination = tupleStoragePaths({ ...SCOPE, home });

    expect(() => migrateLegacyTupleState({ ...SCOPE, home })).toThrow(
      expect.objectContaining({ code: "legacy-migration-failed" }),
    );
    expect(readFileSync(external)).toEqual(externalBytes);
    expect(statSync(external).mode & 0o777).toBe(0o640);
    expect(lstatSync(legacy.credentialPath).isSymbolicLink()).toBe(true);
    expect(existsSync(destination.credentialPath)).toBe(false);
    expect(existsSync(destination.conversationKeyPath)).toBe(false);
  });

  it("rejects a symlinked legacy source directory without touching its target", () => {
    const legacy = legacyTuplePaths(SCOPE.accountId, home);
    const externalDirectory = join(home, "external-account");
    mkdirSync(legacy.root, { recursive: true, mode: 0o700 });
    mkdirSync(externalDirectory, { recursive: true, mode: 0o750 });
    chmodSync(externalDirectory, 0o750);
    const externalCredential = join(externalDirectory, "credentials.json");
    const externalBytes = Buffer.from(
      JSON.stringify(legacyCredential(SCOPE, "TOP-SECRET"), null, 2),
    );
    writeFileSync(externalCredential, externalBytes, { mode: 0o640 });
    chmodSync(externalCredential, 0o640);
    symlinkSync(externalDirectory, legacy.directory);
    const destination = tupleStoragePaths({ ...SCOPE, home });

    expect(() => migrateLegacyTupleState({ ...SCOPE, home })).toThrow(
      expect.objectContaining({ code: "legacy-migration-failed" }),
    );
    expect(readFileSync(externalCredential)).toEqual(externalBytes);
    expect(statSync(externalCredential).mode & 0o777).toBe(0o640);
    expect(statSync(externalDirectory).mode & 0o777).toBe(0o750);
    expect(lstatSync(legacy.directory).isSymbolicLink()).toBe(true);
    expect(existsSync(destination.credentialPath)).toBe(false);
    expect(existsSync(destination.conversationKeyPath)).toBe(false);
  });

  it.each(["credentials", "conversation-keys"] as const)(
    "rejects a multiply-linked legacy %s secret",
    (kind) => {
      const legacy = writeLegacyState();
      const source = kind === "credentials"
        ? legacy.credentialPath
        : legacy.conversationKeyPath;
      const externalLink = join(home, `${kind}.external-link`);
      linkSync(source, externalLink);
      const before = readFileSync(source);
      const destination = tupleStoragePaths({ ...SCOPE, home });

      expect(() => migrateLegacyTupleState({ ...SCOPE, home })).toThrow(
        expect.objectContaining({ code: "legacy-migration-failed" }),
      );
      expect(readFileSync(source)).toEqual(before);
      expect(readFileSync(externalLink)).toEqual(before);
      expect(statSync(source).nlink).toBe(2);
      expect(existsSync(destination.credentialPath)).toBe(false);
      expect(existsSync(destination.conversationKeyPath)).toBe(false);
    },
  );

  it("migrates a proven owner, verifies both destinations, and retains a recoverable backup", () => {
    const legacy = writeLegacyState();
    chmodSync(legacy.directory, 0o755);
    chmodSync(legacy.credentialPath, 0o644);
    chmodSync(legacy.conversationKeyPath, 0o644);
    const result = migrateLegacyTupleState({ ...SCOPE, home });
    const destination = tupleStoragePaths({ ...SCOPE, home });

    expect(result).toEqual({
      status: "migrated",
      credential: "migrated",
      conversationKeys: "migrated",
    });
    expect(existsSync(legacy.directory)).toBe(false);

    const backups = readdirSync(
      join(legacy.root, ".legacy-v1-backups"),
      { withFileTypes: true },
    ).filter((entry) => entry.isDirectory());
    expect(backups).toHaveLength(1);
    const backup = join(
      legacy.root,
      ".legacy-v1-backups",
      backups[0]!.name,
    );
    expect(
      existsSync(join(backup, "source", "credentials.json")),
    ).toBe(true);
    expect(
      existsSync(join(backup, "source", "conversation-keys.json")),
    ).toBe(true);
    expect(statSync(join(backup, "source")).mode & 0o777).toBe(0o700);
    expect(
      statSync(join(backup, "source", "credentials.json")).mode & 0o777,
    ).toBe(0o600);
    expect(
      statSync(join(backup, "source", "conversation-keys.json")).mode & 0o777,
    ).toBe(0o600);
    expect(existsSync(join(backup, "migration-complete.json"))).toBe(true);

    const credential = parseCredentialJson(
      readFileSync(destination.credentialPath, "utf8"),
    );
    expect(() =>
      assertCredentialDocumentStorage(SCOPE, credential),
    ).not.toThrow();
    expect(
      (
        credential.enrollment as {
          creds: { userJwt: string; userSeed: string };
        }
      ).creds,
    ).toEqual({ userJwt: "JWT-old", userSeed: "SEED-old" });

    const keys = parseConversationKeyDocument(
      SCOPE,
      readFileSync(destination.conversationKeyPath, "utf8"),
    );
    expect(Buffer.from(keys.get("same-peer")!)).toEqual(LEGACY_K);
    expect(statSync(destination.directory).mode & 0o777).toBe(0o700);
    expect(statSync(destination.credentialPath).mode & 0o777).toBe(0o600);
    expect(statSync(destination.conversationKeyPath).mode & 0o777).toBe(
      0o600,
    );

    expect(migrateLegacyTupleState({ ...SCOPE, home }).status).toBe(
      "not-needed",
    );
  });

  it("auto-migrates before credential/key delivery and survives restart", () => {
    writeLegacyState();
    const loaded = loadPersistedCredentialDocument(
      { ...SCOPE, saasBaseUrl: "https://saas.example" },
      { home },
    );
    expect(loaded.status).toBe("match");
    if (loaded.status !== "match") throw new Error("expected credentials");
    expect(loaded.credentials).toMatchObject({
      userJwt: "JWT-old",
      userSeed: "SEED-old",
      natsUrl: "wss://relay.example/socket",
      issuer: "https://issuer.example/",
    });

    const first = new ConversationKeyStore({ ...SCOPE, home });
    expect(Buffer.from(first.get("same-peer")!)).toEqual(LEGACY_K);
    const restarted = new ConversationKeyStore({ ...SCOPE, home });
    expect(Buffer.from(restarted.getOrCreate("same-peer"))).toEqual(LEGACY_K);
  });

  it("preserves an existing exact credential-path parent mode during migration", () => {
    writeLegacyState();
    const customDirectory = join(home, "operator-managed");
    const credentialPath = join(customDirectory, "tenant-a.json");
    mkdirSync(customDirectory, { recursive: true, mode: 0o755 });
    chmodSync(customDirectory, 0o755);

    expect(
      migrateLegacyTupleState({ ...SCOPE, home, credentialPath }),
    ).toMatchObject({
      status: "migrated",
      credential: "migrated",
    });
    expect(statSync(customDirectory).mode & 0o777).toBe(0o755);
    expect(statSync(credentialPath).mode & 0o777).toBe(0o600);
    expect(() =>
      assertCredentialDocumentStorage(
        SCOPE,
        parseCredentialJson(readFileSync(credentialPath, "utf8")),
      ),
    ).not.toThrow();
  });

  it("archives and upgrades a proven v1 exact override with collocated keys", () => {
    const legacy = writeLegacyState(SCOPE, { credential: false });
    const customDirectory = join(home, "operator-managed");
    const credentialPath = join(customDirectory, "account.json");
    mkdirSync(customDirectory, { recursive: true, mode: 0o755 });
    chmodSync(customDirectory, 0o755);
    const original = Buffer.from(
      JSON.stringify(legacyCredential(SCOPE, "EXACT-SECRET"), null, 2),
    );
    writeFileSync(credentialPath, original, { mode: 0o640 });
    const destination = tupleStoragePaths({ ...SCOPE, home });
    const claim = join(
      legacy.root,
      ".legacy-v1-backups",
      `${SCOPE.accountId}--${destination.namespaceId}`,
    );

    expect(
      migrateLegacyTupleState({ ...SCOPE, home, credentialPath }),
    ).toMatchObject({
      status: "migrated",
      credential: "migrated",
      conversationKeys: "migrated",
    });
    expect(readFileSync(join(claim, "exact-credentials.json"))).toEqual(
      original,
    );
    expect(statSync(join(claim, "exact-credentials.json")).mode & 0o777).toBe(
      0o600,
    );
    expect(statSync(customDirectory).mode & 0o777).toBe(0o755);
    expect(statSync(credentialPath).mode & 0o777).toBe(0o600);
    expect(Buffer.from(
      parseConversationKeyDocument(
        SCOPE,
        readFileSync(destination.conversationKeyPath, "utf8"),
      ).get("same-peer")!,
    )).toEqual(LEGACY_K);

    const after = readFileSync(credentialPath);
    expect(
      migrateLegacyTupleState({ ...SCOPE, home, credentialPath }),
    ).toMatchObject({ status: "not-needed", credential: "preserved" });
    expect(readFileSync(credentialPath)).toEqual(after);
    expect(readFileSync(join(claim, "exact-credentials.json"))).toEqual(
      original,
    );
  });

  it("rejects symlinked collocated keys for an exact credential override", () => {
    const legacy = writeLegacyState(SCOPE, {
      credential: false,
      keys: false,
    });
    const credentialPath = join(home, "operator-managed", "account.json");
    mkdirSync(dirname(credentialPath), { recursive: true });
    const exactBytes = Buffer.from(
      JSON.stringify(legacyCredential(SCOPE, "EXACT-SECRET"), null, 2),
    );
    writeFileSync(credentialPath, exactBytes, { mode: 0o640 });
    const external = join(home, "external-keys.json");
    const externalBytes = Buffer.from(JSON.stringify({
      version: 1,
      keys: { "same-peer": LEGACY_K.toString("base64url") },
    }));
    writeFileSync(external, externalBytes, { mode: 0o640 });
    chmodSync(external, 0o640);
    symlinkSync(external, legacy.conversationKeyPath);
    const destination = tupleStoragePaths({ ...SCOPE, home });

    expect(() =>
      migrateLegacyTupleState({ ...SCOPE, home, credentialPath }),
    ).toThrow(expect.objectContaining({ code: "legacy-migration-failed" }));
    expect(readFileSync(credentialPath)).toEqual(exactBytes);
    expect(readFileSync(external)).toEqual(externalBytes);
    expect(statSync(external).mode & 0o777).toBe(0o640);
    expect(existsSync(destination.conversationKeyPath)).toBe(false);
  });

  it("rejects a multiply-linked exact legacy credential before claiming", () => {
    const legacy = writeLegacyState(SCOPE, { credential: false });
    const credentialPath = join(home, "operator-managed", "account.json");
    mkdirSync(dirname(credentialPath), { recursive: true });
    const exactBytes = Buffer.from(
      JSON.stringify(legacyCredential(SCOPE, "EXACT-SECRET"), null, 2),
    );
    writeFileSync(credentialPath, exactBytes, { mode: 0o640 });
    chmodSync(credentialPath, 0o640);
    const externalLink = join(home, "external-credential.json");
    linkSync(credentialPath, externalLink);
    const destination = tupleStoragePaths({ ...SCOPE, home });
    const claim = join(
      legacy.root,
      ".legacy-v1-backups",
      `${SCOPE.accountId}--${destination.namespaceId}`,
    );

    expect(() =>
      migrateLegacyTupleState({ ...SCOPE, home, credentialPath }),
    ).toThrow(expect.objectContaining({ code: "legacy-migration-failed" }));
    expect(readFileSync(credentialPath)).toEqual(exactBytes);
    expect(readFileSync(externalLink)).toEqual(exactBytes);
    expect(statSync(externalLink).mode & 0o777).toBe(0o640);
    expect(statSync(externalLink).nlink).toBe(2);
    expect(existsSync(claim)).toBe(false);
    expect(existsSync(destination.conversationKeyPath)).toBe(false);
  });

  it("resumes an exact override after the durable archival boundary", () => {
    const legacy = writeLegacyState(SCOPE, { credential: false });
    const credentialPath = join(home, "outside", "account.json");
    mkdirSync(dirname(credentialPath), { recursive: true });
    const original = Buffer.from(JSON.stringify(legacyCredential(), null, 2));
    writeFileSync(credentialPath, original, { mode: 0o600 });
    const simulatedCrash = new Error("exact archive crash");

    expect(() =>
      migrateLegacyTupleState({
        ...SCOPE,
        home,
        credentialPath,
        _afterSourceMove: () => {
          expect(existsSync(credentialPath)).toBe(false);
          throw simulatedCrash;
        },
      }),
    ).toThrow(simulatedCrash);

    expect(
      migrateLegacyTupleState({ ...SCOPE, home, credentialPath }),
    ).toMatchObject({ status: "resumed", credential: "migrated" });
    expect(existsSync(credentialPath)).toBe(true);
    expect(existsSync(legacy.directory)).toBe(false);
  });

  it("resumes an unchanged exact override from metadata-only state", () => {
    const credentialPath = join(home, "outside", "account.json");
    mkdirSync(dirname(credentialPath), { recursive: true });
    writeFileSync(
      credentialPath,
      JSON.stringify(legacyCredential(), null, 2),
      { mode: 0o600 },
    );
    const simulatedCrash = new Error("metadata-only crash");

    expect(() =>
      migrateLegacyTupleState({
        ...SCOPE,
        home,
        credentialPath,
        _afterClaim: () => {
          throw simulatedCrash;
        },
      }),
    ).toThrow(simulatedCrash);

    expect(
      migrateLegacyTupleState({ ...SCOPE, home, credentialPath }),
    ).toMatchObject({ status: "resumed", credential: "migrated" });
  });

  it("rejects a new exact-source hardlink on metadata-only replay", () => {
    const legacy = legacyTuplePaths(SCOPE.accountId, home);
    const credentialPath = join(home, "outside", "account.json");
    mkdirSync(dirname(credentialPath), { recursive: true });
    const original = Buffer.from(JSON.stringify(legacyCredential(), null, 2));
    writeFileSync(credentialPath, original, { mode: 0o640 });
    chmodSync(credentialPath, 0o640);
    const simulatedCrash = new Error("metadata-only crash");
    expect(() =>
      migrateLegacyTupleState({
        ...SCOPE,
        home,
        credentialPath,
        _afterClaim: () => {
          throw simulatedCrash;
        },
      }),
    ).toThrow(simulatedCrash);

    const externalLink = join(home, "external-credential.json");
    linkSync(credentialPath, externalLink);
    expect(() =>
      migrateLegacyTupleState({ ...SCOPE, home, credentialPath }),
    ).toThrow(expect.objectContaining({ code: "legacy-migration-failed" }));
    expect(readFileSync(credentialPath)).toEqual(original);
    expect(readFileSync(externalLink)).toEqual(original);
    expect(statSync(credentialPath).mode & 0o777).toBe(0o640);
    expect(statSync(externalLink).mode & 0o777).toBe(0o640);
    expect(statSync(credentialPath).nlink).toBe(2);
    expect(statSync(externalLink).nlink).toBe(2);
    const destination = tupleStoragePaths({ ...SCOPE, home });
    const claim = join(
      legacy.root,
      ".legacy-v1-backups",
      `${SCOPE.accountId}--${destination.namespaceId}`,
    );
    expect(existsSync(join(claim, "exact-credentials.json"))).toBe(false);
    expect(existsSync(destination.conversationKeyPath)).toBe(false);
  });

  it("rejects an in-place exact rewrite after a metadata-only crash", () => {
    const legacy = writeLegacyState(SCOPE, { credential: false });
    const credentialPath = join(home, "outside", "account.json");
    mkdirSync(dirname(credentialPath), { recursive: true });
    writeFileSync(
      credentialPath,
      JSON.stringify(legacyCredential(SCOPE, "ORIGINAL"), null, 2),
      { mode: 0o600 },
    );
    const inodeBefore = statSync(credentialPath).ino;
    const simulatedCrash = new Error("metadata-only crash");

    expect(() =>
      migrateLegacyTupleState({
        ...SCOPE,
        home,
        credentialPath,
        _afterClaim: () => {
          throw simulatedCrash;
        },
      }),
    ).toThrow(simulatedCrash);

    const replacement = legacyCredential(SCOPE, "REPLACEMENT-SECRET");
    (replacement.enrollment as { natsUrl: string }).natsUrl =
      "wss://replacement-relay.example/socket";
    const replacementBytes = Buffer.from(JSON.stringify(replacement, null, 2));
    writeFileSync(credentialPath, replacementBytes, { mode: 0o600 });
    expect(statSync(credentialPath).ino).toBe(inodeBefore);

    let thrown: unknown;
    try {
      migrateLegacyTupleState({ ...SCOPE, home, credentialPath });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({ code: "legacy-migration-failed" });
    expect(String(thrown)).not.toContain("REPLACEMENT-SECRET");
    expect(String(thrown)).not.toContain(home);
    expect(readFileSync(credentialPath)).toEqual(replacementBytes);
    expect(existsSync(legacy.directory)).toBe(true);
    const destination = tupleStoragePaths({ ...SCOPE, home });
    const claim = join(
      legacy.root,
      ".legacy-v1-backups",
      `${SCOPE.accountId}--${destination.namespaceId}`,
    );
    expect(existsSync(join(claim, "exact-credentials.json"))).toBe(false);
    expect(existsSync(join(claim, "source"))).toBe(false);
    expect(existsSync(destination.credentialPath)).toBe(false);
    expect(existsSync(destination.conversationKeyPath)).toBe(false);
  });

  it("supports an exact override at the bare-account legacy credential path", () => {
    const legacy = writeLegacyState();
    const before = readFileSync(legacy.credentialPath);
    const destination = tupleStoragePaths({ ...SCOPE, home });
    const claim = join(
      legacy.root,
      ".legacy-v1-backups",
      `${SCOPE.accountId}--${destination.namespaceId}`,
    );

    expect(
      migrateLegacyTupleState({
        ...SCOPE,
        home,
        credentialPath: legacy.credentialPath,
      }),
    ).toMatchObject({
      status: "migrated",
      credential: "migrated",
      conversationKeys: "migrated",
    });
    expect(existsSync(legacy.credentialPath)).toBe(true);
    expect(readFileSync(join(claim, "exact-credentials.json"))).toEqual(before);
    expect(existsSync(destination.conversationKeyPath)).toBe(true);
  });

  it("resumes a bare-account exact archive link left by a crash", () => {
    const legacy = writeLegacyState();
    const original = readFileSync(legacy.credentialPath);
    const destination = tupleStoragePaths({ ...SCOPE, home });
    const claim = join(
      legacy.root,
      ".legacy-v1-backups",
      `${SCOPE.accountId}--${destination.namespaceId}`,
    );
    const archived = join(claim, "exact-credentials.json");
    const simulatedCrash = new Error("link archive crash");

    expect(() =>
      migrateLegacyTupleState({
        ...SCOPE,
        home,
        credentialPath: legacy.credentialPath,
        _linkExactSource: (source, archive) => {
          linkSync(source, archive);
          throw simulatedCrash;
        },
      }),
    ).toThrow(expect.objectContaining({ code: "legacy-migration-failed" }));
    expect(readFileSync(legacy.credentialPath)).toEqual(original);
    expect(readFileSync(archived)).toEqual(original);
    expect(statSync(legacy.credentialPath).nlink).toBe(2);
    expect(statSync(archived).nlink).toBe(2);

    expect(
      migrateLegacyTupleState({
        ...SCOPE,
        home,
        credentialPath: legacy.credentialPath,
      }),
    ).toMatchObject({
      status: "resumed",
      credential: "migrated",
      conversationKeys: "migrated",
    });
    expect(readFileSync(archived)).toEqual(original);
    expect(Buffer.from(
      parseConversationKeyDocument(
        SCOPE,
        readFileSync(destination.conversationKeyPath, "utf8"),
      ).get("same-peer")!,
    )).toEqual(LEGACY_K);
  });

  it("never overwrites an exact-path credential published after archival", () => {
    const credentialPath = join(home, "outside", "account.json");
    mkdirSync(dirname(credentialPath), { recursive: true });
    const original = Buffer.from(JSON.stringify(legacyCredential(), null, 2));
    writeFileSync(credentialPath, original, { mode: 0o600 });
    const winner = upgradeLegacyCredentialDocument(
      SCOPE,
      legacyCredential(SCOPE, "concurrent-winner"),
    );
    const winnerBytes = Buffer.from(JSON.stringify(winner, null, 2));

    expect(() =>
      migrateLegacyTupleState({
        ...SCOPE,
        home,
        credentialPath,
        _afterSourceMove: () => {
          writeFileSync(credentialPath, winnerBytes, { mode: 0o600 });
        },
      }),
    ).toThrow(expect.objectContaining({ code: "legacy-migration-failed" }));

    expect(readFileSync(credentialPath)).toEqual(winnerBytes);
    const destination = tupleStoragePaths({ ...SCOPE, home });
    const archived = join(
      legacyTuplePaths(SCOPE.accountId, home).root,
      ".legacy-v1-backups",
      `${SCOPE.accountId}--${destination.namespaceId}`,
      "exact-credentials.json",
    );
    expect(readFileSync(archived)).toEqual(original);
  });

  it("does not remove a v2 winner published before exact archival", () => {
    const credentialPath = join(home, "outside", "account.json");
    mkdirSync(dirname(credentialPath), { recursive: true });
    writeFileSync(
      credentialPath,
      JSON.stringify(legacyCredential(), null, 2),
      { mode: 0o600 },
    );
    const winner = upgradeLegacyCredentialDocument(
      SCOPE,
      legacyCredential(SCOPE, "pre-archive-winner"),
    );
    const winnerBytes = Buffer.from(JSON.stringify(winner, null, 2));

    expect(() =>
      migrateLegacyTupleState({
        ...SCOPE,
        home,
        credentialPath,
        _afterClaim: () => {
          const replacement = `${credentialPath}.winner`;
          writeFileSync(replacement, winnerBytes, { mode: 0o600 });
          renameSync(replacement, credentialPath);
        },
      }),
    ).toThrow(expect.objectContaining({ code: "legacy-migration-failed" }));

    expect(existsSync(credentialPath)).toBe(true);
    expect(readFileSync(credentialPath)).toEqual(winnerBytes);
    const destination = tupleStoragePaths({ ...SCOPE, home });
    const claim = join(
      legacyTuplePaths(SCOPE.accountId, home).root,
      ".legacy-v1-backups",
      `${SCOPE.accountId}--${destination.namespaceId}`,
    );
    expect(existsSync(join(claim, "exact-credentials.json"))).toBe(false);
  });

  it("falls back to a durable exclusive copy when exact archival is cross-device", () => {
    const credentialPath = join(home, "outside", "account.json");
    mkdirSync(dirname(credentialPath), { recursive: true });
    const original = Buffer.from(JSON.stringify(legacyCredential(), null, 2));
    writeFileSync(credentialPath, original, { mode: 0o600 });

    expect(
      migrateLegacyTupleState({
        ...SCOPE,
        home,
        credentialPath,
        _linkExactSource: () => {
          throw Object.assign(new Error("cross-device link"), {
            code: "EXDEV",
          });
        },
      }),
    ).toMatchObject({ status: "migrated", credential: "migrated" });

    const destination = tupleStoragePaths({ ...SCOPE, home });
    const archived = join(
      legacyTuplePaths(SCOPE.accountId, home).root,
      ".legacy-v1-backups",
      `${SCOPE.accountId}--${destination.namespaceId}`,
      "exact-credentials.json",
    );
    expect(readFileSync(archived)).toEqual(original);
    expect(
      parseCredentialJson(readFileSync(credentialPath, "utf8")),
    ).toHaveProperty("credentialIdentity");
  });

  it("does not let an exact override authorize keys with contradictory legacy ownership", () => {
    const legacy = writeLegacyState(OTHER_SCOPE);
    const credentialPath = join(home, "outside", "account.json");
    mkdirSync(dirname(credentialPath), { recursive: true });
    const exactBefore = Buffer.from(JSON.stringify(legacyCredential(), null, 2));
    writeFileSync(credentialPath, exactBefore, { mode: 0o600 });
    const legacyCredentialBefore = readFileSync(legacy.credentialPath);
    const keysBefore = readFileSync(legacy.conversationKeyPath);
    const destination = tupleStoragePaths({ ...SCOPE, home });

    expect(() =>
      migrateLegacyTupleState({ ...SCOPE, home, credentialPath }),
    ).toThrow(expect.objectContaining({ code: "legacy-migration-failed" }));
    expect(readFileSync(credentialPath)).toEqual(exactBefore);
    expect(readFileSync(legacy.credentialPath)).toEqual(
      legacyCredentialBefore,
    );
    expect(readFileSync(legacy.conversationKeyPath)).toEqual(keysBefore);
    expect(existsSync(destination.credentialPath)).toBe(false);
    expect(existsSync(destination.conversationKeyPath)).toBe(false);
  });

  it("keeps an explicit-identity exact override authoritative and untouched", () => {
    const credentialPath = join(home, "outside", "account.json");
    mkdirSync(dirname(credentialPath), { recursive: true });
    const candidate = legacyCredential(SCOPE, "TOP-SECRET");
    candidate.credentialIdentity = createCredentialBindingIdentityV2({
      storage: OTHER_SCOPE,
      binding: {
        saasBaseUrl: "https://saas.example",
        deliveredIssuer: "https://issuer.example/",
        relayUrl: "wss://relay.example/socket",
        agentPublicKey: PUBLIC_KEY,
      },
    });
    const before = Buffer.from(JSON.stringify(candidate, null, 2));
    writeFileSync(credentialPath, before, { mode: 0o600 });

    expect(() =>
      migrateLegacyTupleState({ ...SCOPE, home, credentialPath }),
    ).toThrow(expect.objectContaining({ code: "identity-mismatch" }));
    expect(readFileSync(credentialPath)).toEqual(before);
  });

  it("rejects an exact v1 credential symlink without archiving or rebinding it", () => {
    const target = join(home, "operator", "target.json");
    const credentialPath = join(home, "operator", "account.json");
    mkdirSync(dirname(target), { recursive: true });
    const before = Buffer.from(JSON.stringify(legacyCredential(), null, 2));
    writeFileSync(target, before, { mode: 0o600 });
    symlinkSync(target, credentialPath);

    expect(() =>
      migrateLegacyTupleState({ ...SCOPE, home, credentialPath }),
    ).toThrow(expect.objectContaining({ code: "storage-io-failed" }));
    expect(readFileSync(target)).toEqual(before);
    expect(lstatSync(credentialPath).isSymbolicLink()).toBe(true);
    expect(
      existsSync(join(legacyTuplePaths(SCOPE.accountId, home).root, ".legacy-v1-backups")),
    ).toBe(false);
  });

  it("keeps a malformed exact override untouched", () => {
    const credentialPath = join(home, "operator", "account.json");
    mkdirSync(dirname(credentialPath), { recursive: true });
    const before = Buffer.from("{TOP-SECRET malformed");
    writeFileSync(credentialPath, before, { mode: 0o600 });

    expect(() =>
      migrateLegacyTupleState({ ...SCOPE, home, credentialPath }),
    ).toThrow(expect.objectContaining({ code: "invalid-document" }));
    expect(readFileSync(credentialPath)).toEqual(before);
    expect(
      existsSync(join(legacyTuplePaths(SCOPE.accountId, home).root, ".legacy-v1-backups")),
    ).toBe(false);
  });

  it("never rebinds an unbound document at an aliased canonical v2 path", () => {
    const destination = tupleStoragePaths({ ...SCOPE, home });
    mkdirSync(destination.directory, { recursive: true, mode: 0o700 });
    const before = Buffer.from(JSON.stringify(legacyCredential(), null, 2));
    writeFileSync(destination.credentialPath, before, { mode: 0o600 });
    const aliasedPath = join(
      destination.directory,
      "..",
      destination.namespaceId,
      "credentials.json",
    );

    expect(() =>
      migrateLegacyTupleState({
        ...SCOPE,
        home,
        credentialPath: aliasedPath,
      }),
    ).toThrow(expect.objectContaining({ code: "identity-unbound" }));
    expect(readFileSync(destination.credentialPath)).toEqual(before);
    expect(
      existsSync(join(legacyTuplePaths(SCOPE.accountId, home).root, ".legacy-v1-backups")),
    ).toBe(false);
  });

  it("preserves a matching explicit credential identity instead of rebinding it", () => {
    const candidate = legacyCredential();
    const explicitIdentity = createCredentialBindingIdentityV2({
      storage: SCOPE,
      binding: {
        saasBaseUrl: "https://saas.example",
        deliveredIssuer: "https://issuer.example/",
        relayUrl: "wss://relay.example/socket",
        agentPublicKey: PUBLIC_KEY,
      },
    });
    candidate.credentialIdentity = explicitIdentity;

    const upgraded = upgradeLegacyCredentialDocument(SCOPE, candidate);

    expect(upgraded.credentialIdentity).toBe(explicitIdentity);
    expect(upgraded.credentialIdentity.binding.saasBaseUrl).toBe(
      "https://saas.example",
    );
  });

  it("rejects a foreign explicit credential identity before any migration mutation", () => {
    const legacy = writeLegacyState();
    const candidate = legacyCredential(SCOPE, "TOP-SECRET");
    candidate.credentialIdentity = createCredentialBindingIdentityV2({
      storage: OTHER_SCOPE,
      binding: {
        saasBaseUrl: "https://foreign.example",
        deliveredIssuer: null,
        relayUrl: null,
        agentPublicKey: PUBLIC_KEY,
      },
    });
    const credentialBefore = Buffer.from(JSON.stringify(candidate, null, 2));
    writeFileSync(legacy.credentialPath, credentialBefore, { mode: 0o600 });
    const keysBefore = readFileSync(legacy.conversationKeyPath);
    const destination = tupleStoragePaths({ ...SCOPE, home });

    let thrown: unknown;
    try {
      migrateLegacyTupleState({ ...SCOPE, home });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({
      code: "identity-mismatch",
      fields: expect.arrayContaining(["storage.tenant"]),
    });
    expect(String(thrown)).not.toContain("TOP-SECRET");
    expect(readFileSync(legacy.credentialPath)).toEqual(credentialBefore);
    expect(readFileSync(legacy.conversationKeyPath)).toEqual(keysBefore);
    expect(existsSync(legacy.directory)).toBe(true);
    expect(existsSync(destination.credentialPath)).toBe(false);
    expect(existsSync(destination.conversationKeyPath)).toBe(false);
  });

  it("fails closed on an explicit semantic binding mismatch before inspecting keys", () => {
    const legacy = writeLegacyState();
    const candidate = legacyCredential(SCOPE, "TOP-SECRET");
    candidate.credentialIdentity = createCredentialBindingIdentityV2({
      storage: SCOPE,
      binding: {
        saasBaseUrl: "https://different-saas.example",
        deliveredIssuer: "https://issuer.example/",
        relayUrl: "wss://relay.example/socket",
        agentPublicKey: PUBLIC_KEY,
      },
    });
    const credentialBefore = Buffer.from(JSON.stringify(candidate, null, 2));
    writeFileSync(legacy.credentialPath, credentialBefore, { mode: 0o600 });
    // If key inspection happens, this malformed file would otherwise be
    // classified and retained through an ambiguous quarantine path.
    const keyBefore = Buffer.from("{TOP-SECRET malformed keys");
    writeFileSync(legacy.conversationKeyPath, keyBefore, { mode: 0o600 });
    const destination = tupleStoragePaths({ ...SCOPE, home });

    let thrown: unknown;
    try {
      migrateLegacyTupleState({ ...SCOPE, home });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(StorageDocumentError);
    expect(thrown).toMatchObject({
      document: "credentials",
      code: "invalid-document",
    });
    expect(String(thrown)).not.toContain("TOP-SECRET");
    expect(String(thrown)).not.toContain(home);
    expect(existsSync(legacy.directory)).toBe(true);
    expect(readFileSync(legacy.credentialPath)).toEqual(credentialBefore);
    expect(readFileSync(legacy.conversationKeyPath)).toEqual(keyBefore);
    expect(existsSync(destination.credentialPath)).toBe(false);
    expect(existsSync(destination.conversationKeyPath)).toBe(false);
  });

  it("rejects a foreign identity marker in v1 keys before any migration mutation", () => {
    const legacy = writeLegacyState();
    const credentialBefore = readFileSync(legacy.credentialPath);
    const keysBefore = Buffer.from(
      JSON.stringify(
        {
          version: 1,
          storageIdentity: createStorageIdentityV2(OTHER_SCOPE),
          keys: { "same-peer": LEGACY_K.toString("base64url") },
        },
        null,
        2,
      ),
    );
    writeFileSync(legacy.conversationKeyPath, keysBefore, { mode: 0o600 });
    const destination = tupleStoragePaths({ ...SCOPE, home });

    let thrown: unknown;
    try {
      migrateLegacyTupleState({ ...SCOPE, home });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({
      code: "identity-mismatch",
      fields: expect.arrayContaining(["storage.tenant"]),
    });
    expect(String(thrown)).not.toContain(LEGACY_K.toString("base64url"));
    expect(readFileSync(legacy.credentialPath)).toEqual(credentialBefore);
    expect(readFileSync(legacy.conversationKeyPath)).toEqual(keysBefore);
    expect(existsSync(legacy.directory)).toBe(true);
    expect(existsSync(destination.credentialPath)).toBe(false);
    expect(existsSync(destination.conversationKeyPath)).toBe(false);
  });

  it("quarantines an ownership-ambiguous v1 key without adopting it", () => {
    const legacy = writeLegacyState(SCOPE, { credential: false });
    chmodSync(legacy.directory, 0o755);
    chmodSync(legacy.conversationKeyPath, 0o644);
    const result = migrateLegacyTupleState({ ...SCOPE, home });
    const destination = tupleStoragePaths({ ...SCOPE, home });

    expect(result).toEqual({
      status: "ambiguous-quarantined",
      credential: "absent",
      conversationKeys: "fresh",
    });
    expect(existsSync(legacy.conversationKeyPath)).toBe(false);
    const archive = readdirSync(legacy.directory).find((name) =>
      name.startsWith("conversation-keys.json.ambiguous-v2-"),
    );
    expect(archive).toBeDefined();
    expect(statSync(legacy.directory).mode & 0o777).toBe(0o700);
    expect(statSync(join(legacy.directory, archive!)).mode & 0o777).toBe(0o600);
    expect(
      parseConversationKeyDocument(
        SCOPE,
        readFileSync(destination.conversationKeyPath, "utf8"),
      ).size,
    ).toBe(0);

    const store = new ConversationKeyStore({ ...SCOPE, home });
    const fresh = store.getOrCreate("same-peer");
    expect(Buffer.from(fresh).equals(LEGACY_K)).toBe(false);
  });

  it("does not let matching labels make a malformed credential prove key ownership", () => {
    const legacy = writeLegacyState();
    const malformed = legacyCredential();
    (
      (malformed.enrollment as { creds: { userSeed: string } }).creds
    ).userSeed = "";
    writeFileSync(
      legacy.credentialPath,
      JSON.stringify(malformed, null, 2),
      { mode: 0o600 },
    );

    expect(migrateLegacyTupleState({ ...SCOPE, home })).toEqual({
      status: "ambiguous-quarantined",
      credential: "absent",
      conversationKeys: "fresh",
    });
    expect(existsSync(legacy.credentialPath)).toBe(true);
    expect(
      readdirSync(legacy.directory).some((name) =>
        name.startsWith("conversation-keys.json.ambiguous-v2-"),
      ),
    ).toBe(true);

    const destination = tupleStoragePaths({ ...SCOPE, home });
    expect(existsSync(destination.credentialPath)).toBe(false);
    expect(
      parseConversationKeyDocument(
        SCOPE,
        readFileSync(destination.conversationKeyPath, "utf8"),
      ).size,
    ).toBe(0);
  });

  it.each(["missing relay", "invalid key pair"] as const)(
    "does not let matching labels plus %s satisfy complete binding readiness",
    (failure) => {
      const legacy = writeLegacyState();
      const candidate = legacyCredential();
      if (failure === "missing relay") {
        delete (candidate.enrollment as Record<string, unknown>).natsUrl;
      } else {
        (candidate.identityKey as { publicKey: string }).publicKey =
          Buffer.alloc(32, 3).toString("base64url");
      }
      writeFileSync(
        legacy.credentialPath,
        JSON.stringify(candidate, null, 2),
        { mode: 0o600 },
      );

      expect(migrateLegacyTupleState({ ...SCOPE, home })).toEqual({
        status: "ambiguous-quarantined",
        credential: "absent",
        conversationKeys: "fresh",
      });
      expect(existsSync(legacy.credentialPath)).toBe(true);
      expect(existsSync(tupleStoragePaths({ ...SCOPE, home }).credentialPath))
        .toBe(false);
    },
  );

  it("does not mutate material proven to belong to another tenant", () => {
    const legacy = writeLegacyState(SCOPE);
    const credentialBefore = readFileSync(legacy.credentialPath);
    const keysBefore = readFileSync(legacy.conversationKeyPath);

    expect(migrateLegacyTupleState({ ...OTHER_SCOPE, home })).toEqual({
      status: "owned-by-other",
      credential: "absent",
      conversationKeys: "fresh",
    });
    expect(readFileSync(legacy.credentialPath)).toEqual(credentialBefore);
    expect(readFileSync(legacy.conversationKeyPath)).toEqual(keysBefore);
    expect(
      existsSync(tupleStoragePaths({ ...OTHER_SCOPE, home }).credentialPath),
    ).toBe(false);

    expect(migrateLegacyTupleState({ ...SCOPE, home }).status).toBe("migrated");
  });

  it("fails closed on an exact-account competing incomplete claim without mutating the source", () => {
    const legacy = writeLegacyState();
    const before = readFileSync(legacy.credentialPath);
    const foreign = tupleStoragePaths({ ...OTHER_SCOPE, home });
    const foreignClaim = join(
      legacy.root,
      ".legacy-v1-backups",
      `${SCOPE.accountId}--${foreign.namespaceId}`,
    );
    mkdirSync(foreignClaim, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(foreignClaim, "migration-claim.json"),
      JSON.stringify({
        version: 2,
        storageIdentity: createStorageIdentityV2(OTHER_SCOPE),
        ownerPid: process.pid,
      }),
      { mode: 0o600 },
    );

    expect(() => migrateLegacyTupleState({ ...SCOPE, home })).toThrow(
      expect.objectContaining({
        code: "legacy-claim-conflict",
      }),
    );
    expect(readFileSync(legacy.credentialPath)).toEqual(before);
    expect(existsSync(legacy.directory)).toBe(true);
  });

  it("does not alias a longer account id or malformed name during claim discovery", () => {
    const scope = { tenant: "tenant-A", accountId: "acct" };
    const longerScope = { tenant: "tenant-B", accountId: "acct--blue" };
    const legacy = writeLegacyState(scope);
    const longer = tupleStoragePaths({ ...longerScope, home });
    const backupRoot = join(legacy.root, ".legacy-v1-backups");
    const longerClaim = join(
      backupRoot,
      `${longerScope.accountId}--${longer.namespaceId}`,
    );
    mkdirSync(longerClaim, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(longerClaim, "migration-claim.json"),
      JSON.stringify({
        version: 2,
        storageIdentity: createStorageIdentityV2(longerScope),
        ownerPid: process.pid,
      }),
      { mode: 0o600 },
    );
    mkdirSync(join(backupRoot, `${scope.accountId}--v2_short`), {
      recursive: true,
      mode: 0o700,
    });

    expect(migrateLegacyTupleState({ ...scope, home }).status).toBe("migrated");
    expect(existsSync(longerClaim)).toBe(true);
  });

  it("permits only one of two concurrent process claims to migrate", async () => {
    const legacy = writeLegacyState();
    const destination = tupleStoragePaths({ ...SCOPE, home });
    const claim = join(
      legacy.root,
      ".legacy-v1-backups",
      `${SCOPE.accountId}--${destination.namespaceId}`,
      "migration-claim.json",
    );
    const fixture = fileURLToPath(
      new URL("./test-fixtures/migrate-legacy-storage.ts", import.meta.url),
    );
    const start = (delayMs: number) => {
      const child = spawn(
        process.execPath,
        [
          "--import",
          "tsx",
          fixture,
          home,
          SCOPE.tenant,
          SCOPE.accountId,
          String(delayMs),
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      const completion = new Promise<{
        code: number | null;
        stdout: string;
        stderr: string;
      }>((resolve) => {
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
          stdout += chunk;
        });
        child.stderr.on("data", (chunk: string) => {
          stderr += chunk;
        });
        child.on("close", (code) => resolve({ code, stdout, stderr }));
      });
      return { child, completion };
    };

    const first = start(1_000);
    for (let attempts = 0; attempts < 500 && !existsSync(claim); attempts += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(existsSync(claim)).toBe(true);
    const second = start(0);
    const [firstResult, secondResult] = await Promise.all([
      first.completion,
      second.completion,
    ]);
    expect(firstResult, firstResult.stderr).toMatchObject({ code: 0 });
    expect(secondResult, secondResult.stderr).toMatchObject({ code: 0 });
    expect(JSON.parse(firstResult.stdout)).toEqual({
      ok: true,
      status: "migrated",
    });
    expect(JSON.parse(secondResult.stdout)).toEqual({
      ok: false,
      code: "legacy-claim-conflict",
    });
    expect(existsSync(destination.credentialPath)).toBe(true);
    expect(existsSync(destination.conversationKeyPath)).toBe(true);
  }, 15_000);

  it("resumes a crash-safe claimed archive for the same tuple", () => {
    const legacy = writeLegacyState();
    const destination = tupleStoragePaths({ ...SCOPE, home });
    const claim = join(
      legacy.root,
      ".legacy-v1-backups",
      `${SCOPE.accountId}--${destination.namespaceId}`,
    );
    mkdirSync(claim, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(claim, "migration-claim.json"),
      JSON.stringify({
        version: 2,
        storageIdentity: createStorageIdentityV2(SCOPE),
        ownerPid: process.pid,
      }),
      { mode: 0o600 },
    );
    const source = join(claim, "source");
    renameSync(legacy.directory, source);
    const sourceCredential = join(source, "credentials.json");
    const sourceConversation = join(source, "conversation-keys.json");
    chmodSync(source, 0o755);
    chmodSync(sourceCredential, 0o644);
    chmodSync(sourceConversation, 0o646);

    expect(migrateLegacyTupleState({ ...SCOPE, home }).status).toBe("resumed");
    expect(existsSync(destination.credentialPath)).toBe(true);
    expect(existsSync(destination.conversationKeyPath)).toBe(true);
    expect(existsSync(join(claim, "migration-complete.json"))).toBe(true);
    expect(statSync(source).mode & 0o777).toBe(0o700);
    expect(statSync(sourceCredential).mode & 0o777).toBe(0o600);
    expect(statSync(sourceConversation).mode & 0o777).toBe(0o600);
  });

  it("resumes after a crash boundary immediately following the durable source move", () => {
    const legacy = writeLegacyState();
    const destination = tupleStoragePaths({ ...SCOPE, home });
    const claim = join(
      legacy.root,
      ".legacy-v1-backups",
      `${SCOPE.accountId}--${destination.namespaceId}`,
    );
    const archivedSource = join(claim, "source");
    const simulatedCrash = new Error("simulated post-rename crash");

    expect(() =>
      migrateLegacyTupleState({
        ...SCOPE,
        home,
        _afterSourceMove: () => {
          expect(existsSync(legacy.directory)).toBe(false);
          expect(existsSync(archivedSource)).toBe(true);
          expect(existsSync(destination.credentialPath)).toBe(false);
          expect(existsSync(destination.conversationKeyPath)).toBe(false);
          throw simulatedCrash;
        },
      }),
    ).toThrow(simulatedCrash);

    expect(migrateLegacyTupleState({ ...SCOPE, home }).status).toBe("resumed");
    expect(existsSync(destination.credentialPath)).toBe(true);
    expect(existsSync(destination.conversationKeyPath)).toBe(true);
    expect(existsSync(join(claim, "migration-complete.json"))).toBe(true);
  });

  it.each(["credentials", "conversation-keys"] as const)(
    "rejects a foreign %s marker in a claimed archive before changing source modes",
    (foreignDocument) => {
      const legacy = writeLegacyState();
      const destination = tupleStoragePaths({ ...SCOPE, home });
      const claim = join(
        legacy.root,
        ".legacy-v1-backups",
        `${SCOPE.accountId}--${destination.namespaceId}`,
      );
      mkdirSync(claim, { recursive: true, mode: 0o700 });
      writeFileSync(
        join(claim, "migration-claim.json"),
        JSON.stringify({
          version: 2,
          storageIdentity: createStorageIdentityV2(SCOPE),
          ownerPid: process.pid,
        }),
        { mode: 0o600 },
      );

      if (foreignDocument === "credentials") {
        const candidate = legacyCredential(SCOPE, "RESUME-SECRET");
        candidate.credentialIdentity = createCredentialBindingIdentityV2({
          storage: OTHER_SCOPE,
          binding: {
            saasBaseUrl: "https://foreign.example",
            deliveredIssuer: null,
            relayUrl: null,
            agentPublicKey: PUBLIC_KEY,
          },
        });
        writeFileSync(
          legacy.credentialPath,
          JSON.stringify(candidate, null, 2),
        );
      } else {
        writeFileSync(
          legacy.conversationKeyPath,
          JSON.stringify(
            {
              version: 1,
              storageIdentity: createStorageIdentityV2(OTHER_SCOPE),
              keys: {
                "same-peer": LEGACY_K.toString("base64url"),
              },
            },
            null,
            2,
          ),
        );
      }

      const source = join(claim, "source");
      renameSync(legacy.directory, source);
      const sourceCredential = join(source, "credentials.json");
      const sourceConversation = join(source, "conversation-keys.json");
      chmodSync(source, 0o755);
      chmodSync(sourceCredential, 0o644);
      chmodSync(sourceConversation, 0o646);
      const credentialBefore = readFileSync(sourceCredential);
      const conversationBefore = readFileSync(sourceConversation);
      const modesBefore = {
        source: statSync(source).mode & 0o777,
        credential: statSync(sourceCredential).mode & 0o777,
        conversation: statSync(sourceConversation).mode & 0o777,
      };

      let thrown: unknown;
      try {
        migrateLegacyTupleState({ ...SCOPE, home });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toMatchObject({
        code: "identity-mismatch",
        document: foreignDocument,
        fields: expect.arrayContaining(["storage.tenant"]),
      });
      expect(String(thrown)).not.toContain("RESUME-SECRET");
      expect(existsSync(source)).toBe(true);
      expect(readFileSync(sourceCredential)).toEqual(credentialBefore);
      expect(readFileSync(sourceConversation)).toEqual(conversationBefore);
      expect({
        source: statSync(source).mode & 0o777,
        credential: statSync(sourceCredential).mode & 0o777,
        conversation: statSync(sourceConversation).mode & 0o777,
      }).toEqual(modesBefore);
      expect(existsSync(destination.credentialPath)).toBe(false);
      expect(existsSync(destination.conversationKeyPath)).toBe(false);
      expect(existsSync(join(claim, "migration-complete.json"))).toBe(false);
    },
  );

  it("atomically takes over a dead same-tuple claim while preserving it", () => {
    writeLegacyState();
    const destination = tupleStoragePaths({ ...SCOPE, home });
    const claim = join(
      legacyTuplePaths(SCOPE.accountId, home).root,
      ".legacy-v1-backups",
      `${SCOPE.accountId}--${destination.namespaceId}`,
    );
    mkdirSync(claim, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(claim, "migration-claim.json"),
      JSON.stringify({
        version: 2,
        storageIdentity: createStorageIdentityV2(SCOPE),
        ownerPid: Number.MAX_SAFE_INTEGER,
      }),
      { mode: 0o600 },
    );

    expect(migrateLegacyTupleState({ ...SCOPE, home }).status).toBe(
      "migrated",
    );
    expect(
      readdirSync(claim).some((name) =>
        name.startsWith("migration-claim.json.stale-"),
      ),
    ).toBe(true);
  });

  it("never overwrites an existing same-scope destination with different secrets", () => {
    const legacy = writeLegacyState();
    const destination = tupleStoragePaths({ ...SCOPE, home });
    mkdirSync(destination.directory, { recursive: true, mode: 0o700 });
    const existing = upgradeLegacyCredentialDocument(
      SCOPE,
      legacyCredential(SCOPE, "new"),
    );
    writeFileSync(
      destination.credentialPath,
      JSON.stringify(existing, null, 2),
      { mode: 0o600 },
    );
    writeFileSync(
      destination.conversationKeyPath,
      serializeConversationKeyDocument(SCOPE, new Map()),
      { mode: 0o600 },
    );
    const before = readFileSync(destination.credentialPath);

    expect(() => migrateLegacyTupleState({ ...SCOPE, home })).toThrow(
      StorageDocumentError,
    );
    expect(readFileSync(destination.credentialPath)).toEqual(before);
    expect(existsSync(legacy.directory)).toBe(true);
  });

  it("fails before source mutation when malformed legacy keys conflict with an existing v2 store", () => {
    const legacy = writeLegacyState();
    writeFileSync(legacy.conversationKeyPath, "{ malformed legacy keys", {
      mode: 0o600,
    });
    const destination = tupleStoragePaths({ ...SCOPE, home });
    mkdirSync(destination.directory, { recursive: true, mode: 0o700 });
    writeFileSync(
      destination.conversationKeyPath,
      serializeConversationKeyDocument(
        SCOPE,
        new Map([["already-v2", new Uint8Array(LEGACY_K)]]),
      ),
      { mode: 0o600 },
    );
    const sourceBefore = readFileSync(legacy.credentialPath);
    const destinationBefore = readFileSync(destination.conversationKeyPath);

    expect(() => migrateLegacyTupleState({ ...SCOPE, home })).toThrow(
      expect.objectContaining({ code: "legacy-migration-failed" }),
    );
    expect(existsSync(legacy.directory)).toBe(true);
    expect(readFileSync(legacy.credentialPath)).toEqual(sourceBefore);
    expect(readFileSync(destination.conversationKeyPath)).toEqual(
      destinationBefore,
    );
  });

  it("rejects a mismatched v2 destination before touching legacy material", () => {
    const legacy = writeLegacyState();
    const destination = tupleStoragePaths({ ...SCOPE, home });
    mkdirSync(dirname(destination.credentialPath), {
      recursive: true,
      mode: 0o700,
    });
    writeFileSync(
      destination.credentialPath,
      JSON.stringify(
        upgradeLegacyCredentialDocument(
          OTHER_SCOPE,
          legacyCredential(OTHER_SCOPE),
        ),
        null,
        2,
      ),
      { mode: 0o600 },
    );
    const before = readFileSync(legacy.credentialPath);

    expect(() => migrateLegacyTupleState({ ...SCOPE, home })).toThrow(
      expect.objectContaining({
        code: "identity-mismatch",
        fields: expect.arrayContaining(["storage.tenant"]),
      }),
    );
    expect(readFileSync(legacy.credentialPath)).toEqual(before);
    expect(existsSync(legacy.directory)).toBe(true);
  });
});
