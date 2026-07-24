import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
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
import { loadPersistedEnrolledCreds } from "./account-config.js";
import {
  parseConversationKeyDocument,
  serializeConversationKeyDocument,
} from "./conversation-key-document.js";
import { ConversationKeyStore } from "./conversation-key-store.js";
import { migrateLegacyTupleState } from "./legacy-storage-migration.js";
import {
  legacyTuplePaths,
  tupleStoragePaths,
} from "./storage-paths.js";
import { createStorageIdentityV2 } from "./storage-identity.js";
import { StorageDocumentError } from "./storage-document.js";

const SCOPE = { tenant: "tenant-A", accountId: "shared-account" };
const OTHER_SCOPE = { tenant: "tenant-B", accountId: "shared-account" };
const PUBLIC_KEY = Buffer.alloc(32, 7).toString("base64url");
const PRIVATE_KEY = Buffer.alloc(32, 8).toString("base64url");
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
    const credentials = loadPersistedEnrolledCreds(SCOPE, { home });
    expect(credentials).toMatchObject({
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

  it("fails closed on a competing incomplete claim without mutating the source", () => {
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
    renameSync(legacy.directory, join(claim, "source"));

    expect(migrateLegacyTupleState({ ...SCOPE, home }).status).toBe("resumed");
    expect(existsSync(destination.credentialPath)).toBe(true);
    expect(existsSync(destination.conversationKeyPath)).toBe(true);
    expect(existsSync(join(claim, "migration-complete.json"))).toBe(true);
  });

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
