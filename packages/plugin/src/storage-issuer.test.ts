import { existsSync, linkSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { evaluateWebchannelDoctor } from "./doctor.js";
import { prepareAccountAuth } from "./account-auth.js";
import { ConversationKeyStore } from "./conversation-key-store.js";
import { openDeliveryJournal } from "./delivery-journal.js";
import { derivePublicKey } from "./e2e-crypto.js";
import { migrateLegacyTupleState } from "./legacy-storage-migration.js";
import { ensureStorageIssuer, inspectStorageIssuer, StorageIssuerError } from "./storage-issuer.js";
import { legacyTuplePaths, tupleStoragePaths } from "./storage-paths.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const storageRoot = mkdtempSync(join(tmpdir(), "webchannel-storage-issuer-"));
  roots.push(storageRoot);
  const scope = { tenant: "issuer-test", accountId: "a", storageRoot, home: storageRoot };
  const paths = tupleStoragePaths(scope);
  const prepare = (issuer: string, accountId = "a") => prepareAccountAuth({
    plan: { ...scope, accountId, account: { auth: { strategy: "jwt", jwt: { issuer, jwks: { keys: [] } } } } },
    getPersisted: () => undefined,
  });
  return { scope, paths, prepare };
}

const LEGACY_PRIVATE_KEY = Buffer.alloc(32, 17);
const LEGACY_PUBLIC_KEY = Buffer.from(derivePublicKey(LEGACY_PRIVATE_KEY));
const LEGACY_CONVERSATION_KEY = Buffer.alloc(32, 23);

function writeLegacyFixture(scope: ReturnType<typeof fixture>["scope"]): ReturnType<typeof legacyTuplePaths> {
  const legacy = legacyTuplePaths(scope.accountId, scope.home);
  mkdirSync(legacy.directory, { recursive: true, mode: 0o700 });
  writeFileSync(legacy.credentialPath, JSON.stringify({
    identityKey: {
      publicKey: LEGACY_PUBLIC_KEY.toString("base64url"),
      privateKey: LEGACY_PRIVATE_KEY.toString("base64url"),
    },
    enrollment: {
      creds: { userJwt: "old-jwt", userSeed: "old-seed" },
      peerId: "old-agent",
      jwksUrl: "https://old.example/jwks",
      bootstrapUrl: "https://old.example/bootstrap",
      natsUrl: "wss://old.example/nats",
      issuer: "https://old.example",
    },
    accountId: scope.accountId,
    tenant: scope.tenant,
    saasEnrollUrl: "https://old.example/api/enroll",
    saasPollUrl: "https://old.example/api/poll",
  }), { mode: 0o600 });
  writeFileSync(legacy.conversationKeyPath, JSON.stringify({
    version: 1,
    keys: { "old-peer": LEGACY_CONVERSATION_KEY.toString("base64url") },
  }), { mode: 0o600 });
  return legacy;
}

describe("storage issuer admission (#412)", () => {
  it("binds a fresh tuple before data is written and never overwrites its issuer", () => {
    const { scope, paths } = fixture();
    expect(inspectStorageIssuer({ ...scope, issuer: "https://old.example/" })).toBe("fresh");
    expect(readdirSync(scope.storageRoot)).toEqual([]);
    ensureStorageIssuer({ ...scope, issuer: "https://old.example/" });
    const marker = join(paths.directory, "storage-issuer.json");
    expect(statSync(marker).mode & 0o777).toBe(0o600);
    const original = readFileSync(marker);
    ensureStorageIssuer({ ...scope, issuer: "https://old.example" });
    expect(() => ensureStorageIssuer({ ...scope, issuer: "https://new.example" })).toThrow(/mismatch/);
    expect(readFileSync(marker)).toEqual(original);
  });

  it("refuses a changed issuer before the verifier can expose an existing peer's key and history", () => {
    const { scope, paths, prepare } = fixture();
    mkdirSync(paths.directory, { recursive: true });
    writeFileSync(join(paths.directory, "storage-issuer.json"), JSON.stringify({ version: 1, tenant: scope.tenant, accountId: "a", issuer: "https://old.example" }));
    const keyStore = new ConversationKeyStore(scope);
    const key = keyStore.getOrCreate("same-sub");
    const journal = openDeliveryJournal({ databasePath: paths.deliveryJournalPath });
    journal.append("same-sub", { kind: "bubble", answerId: "old-answer", text: "old private history" });
    journal.close();
    const before = [paths.conversationKeyPath, paths.deliveryJournalPath].map(path => readFileSync(path));
    expect(() => prepare("https://new.example")).toThrow(/storage issuer.*mismatch/);
    expect([paths.conversationKeyPath, paths.deliveryJournalPath].map(path => readFileSync(path))).toEqual(before);
    expect(() => prepare("https://old.example/")).not.toThrow();
    expect(new ConversationKeyStore(scope).getOrCreate("same-sub")).toEqual(key);
    // A failed account cannot prevent another account's preparation.
    expect(() => prepare("https://new.example", "b")).not.toThrow();
  });

  it.each(["conversation-keys.json", "conversation-key-generations.json", "delivery-journal.sqlite", "delivery-journal.sqlite-wal"])("refuses unbound %s without stamping, deleting or migrating it", (file) => {
    const { paths, prepare } = fixture();
    mkdirSync(paths.directory, { recursive: true });
    writeFileSync(join(paths.directory, file), "pre-issuer private bytes");
    expect(() => prepare("https://current.example")).toThrow(/storage issuer.*unbound/);
    expect(readdirSync(paths.directory)).toEqual([file]);
    expect(readFileSync(join(paths.directory, file), "utf8")).toBe("pre-issuer private bytes");
  });

  it.each(["{", '{"version":2}', '{"version":1,"issuer":"https://current.example"}'])("refuses invalid/future metadata %s without overwriting it", (bytes) => {
    const { paths, prepare } = fixture();
    mkdirSync(paths.directory, { recursive: true });
    const path = join(paths.directory, "storage-issuer.json");
    writeFileSync(path, bytes);
    expect(() => prepare("https://current.example")).toThrow(/storage issuer/);
    expect(readFileSync(path, "utf8")).toBe(bytes);
  });

  it("doctor identifies the affected tuple and explains manual archive/reset without writing", () => {
    const { scope, paths } = fixture();
    mkdirSync(paths.directory, { recursive: true });
    writeFileSync(join(paths.directory, "storage-issuer.json"), JSON.stringify({ version: 1, tenant: scope.tenant, accountId: "a", issuer: "old" }));
    const cfg = { channels: { webchannel: { tenant: scope.tenant, storageRoot: scope.storageRoot,
      auth: { strategy: "jwt", jwt: { issuer: "new", jwks: { keys: [] } } },
      accounts: { a: {}, b: {} },
    } } };
    const findings = evaluateWebchannelDoctor(cfg, { env: {}, loadPersistedEnrolledCreds: () => ({
      userJwt: "J", userSeed: "S", identityKey: { publicKey: new Uint8Array(32), privateKey: new Uint8Array(32) },
    }) });
    expect(findings.filter(f => f.checkId === "storage-issuer-failed")).toEqual([
      expect.objectContaining({ accountId: "a", severity: "error", fix: expect.stringContaining(paths.directory) }),
    ]);
    expect(findings.find(f => f.checkId === "storage-issuer-failed")?.fix).toMatch(/archive.*explicit/i);
    expect(readdirSync(paths.directory)).toEqual(["storage-issuer.json"]);
  });

  it.each(["tuple", "exact-credential"] as const)(
    "refuses a resumable %s migration archive before binding a new issuer",
    (kind) => {
      const { scope, paths } = fixture();
      const legacy = writeLegacyFixture(scope);
      const originalKeyBytes = readFileSync(legacy.conversationKeyPath);
      const credentialPath = kind === "exact-credential"
        ? join(scope.storageRoot, "exact", "credentials.json")
        : undefined;
      if (credentialPath) {
        mkdirSync(join(scope.storageRoot, "exact"), { recursive: true });
        writeFileSync(credentialPath, readFileSync(legacy.credentialPath), { mode: 0o600 });
      }
      const crash = new Error("simulated migration crash");
      expect(() => migrateLegacyTupleState({
        ...scope,
        ...(credentialPath ? { credentialPath } : {}),
        ...(kind === "tuple"
          ? { _afterSourceMove: () => { throw crash; } }
          : {
              _linkExactSource: (source: string, archive: string) => {
                linkSync(source, archive);
                throw crash;
              },
            }),
      })).toThrow();

      const backupRoot = join(legacy.root, ".legacy-v1-backups");
      const claim = join(backupRoot, readdirSync(backupRoot).find(name => name.includes("--v2_"))!);
      const retainedKeyPath = kind === "tuple"
        ? join(claim, "source", "conversation-keys.json")
        : legacy.conversationKeyPath;
      expect(readFileSync(retainedKeyPath)).toEqual(originalKeyBytes);
      const marker = join(paths.directory, "storage-issuer.json");
      const markerBefore = kind === "exact-credential"
        ? Buffer.from(JSON.stringify({
            version: 1,
            tenant: scope.tenant,
            accountId: scope.accountId,
            issuer: "https://new.example",
          }))
        : undefined;
      if (markerBefore) {
        mkdirSync(paths.directory, { recursive: true });
        writeFileSync(marker, markerBefore, { mode: 0o600 });
      }
      let thrown: unknown;
      try {
        ensureStorageIssuer({ ...scope, issuer: "https://new.example" });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(StorageIssuerError);
      expect(String(thrown)).toMatch(new RegExp(`pending legacy migration archive.*${paths.namespaceId}`));
      expect((thrown as StorageIssuerError).fix).toContain(claim);
      expect(existsSync(marker)).toBe(markerBefore !== undefined);
      if (markerBefore) expect(readFileSync(marker)).toEqual(markerBefore);
      expect(readFileSync(retainedKeyPath)).toEqual(originalKeyBytes);
    },
  );

  it("permits a completed inactive migration backup", () => {
    const { scope, paths } = fixture();
    const legacy = writeLegacyFixture(scope);
    migrateLegacyTupleState(scope);
    const backupRoot = join(legacy.root, ".legacy-v1-backups");
    const claim = join(backupRoot, readdirSync(backupRoot).find(name => name.includes("--v2_"))!);
    const archivedKeys = join(claim, "source", "conversation-keys.json");
    const originalKeyBytes = readFileSync(archivedKeys);
    unlinkSync(paths.conversationKeyPath);

    expect(inspectStorageIssuer({ ...scope, issuer: "https://old.example" })).toBe("fresh");
    ensureStorageIssuer({ ...scope, issuer: "https://old.example" });
    expect(existsSync(join(paths.directory, "storage-issuer.json"))).toBe(true);
    expect(readFileSync(archivedKeys)).toEqual(originalKeyBytes);
  });
});
