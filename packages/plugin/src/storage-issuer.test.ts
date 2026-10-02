import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { evaluateWebchannelDoctor } from "./doctor.js";
import { prepareAccountAuth } from "./account-auth.js";
import { ConversationKeyStore } from "./conversation-key-store.js";
import { openDeliveryJournal } from "./delivery-journal.js";
import { ensureStorageIssuer, inspectStorageIssuer } from "./storage-issuer.js";
import { tupleStoragePaths } from "./storage-paths.js";

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
});
