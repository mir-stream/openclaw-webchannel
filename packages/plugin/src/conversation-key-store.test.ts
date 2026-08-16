/**
 * ConversationKeyStore tests — the persisted K is a cryptographic history
 * root, so capacity must reject new peers without mutating existing entries.
 */

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ConversationKeyCapacityError,
  ConversationKeyStore,
  type ConversationKeyStoreOptions,
} from "./conversation-key-store.js";
import { openEnvelope, sealEnvelope } from "./e2e-session.js";
import { tupleStoragePaths } from "./storage-paths.js";

const ACCOUNT = "acct-a";
const TENANT = "tenant-A";
const quietWarning = (): void => {};

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "webchannel-keystore-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(home, { recursive: true, force: true });
});

function createStore(
  options: Omit<ConversationKeyStoreOptions, "tenant">,
): ConversationKeyStore {
  return new ConversationKeyStore({ tenant: TENANT, ...options });
}

function storePath(account = ACCOUNT, tenant = TENANT): string {
  return tupleStoragePaths({ tenant, accountId: account, home })
    .conversationKeyPath;
}

function generationPath(account = ACCOUNT, tenant = TENANT): string {
  return tupleStoragePaths({ tenant, accountId: account, home })
    .conversationKeyGenerationsPath;
}

function storedKeys(account = ACCOUNT): Record<string, string> {
  return (JSON.parse(readFileSync(storePath(account), "utf8")) as {
    version: number;
    keys: Record<string, string>;
  }).keys;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return Buffer.from(a).equals(Buffer.from(b));
}

describe("ConversationKeyStore", () => {
  it("generates a 32-byte key once and returns the same bytes on later calls", () => {
    const store = createStore({ accountId: ACCOUNT, home });
    const k1 = store.getOrCreate("user-42");
    expect(k1).toHaveLength(32);
    expect(sameBytes(store.getOrCreate("user-42"), k1)).toBe(true);
  });

  it("keeps distinct peers' keys independent", () => {
    const store = createStore({ accountId: ACCOUNT, home });
    const a = store.getOrCreate("user-a");
    const b = store.getOrCreate("user-b");
    expect(sameBytes(a, b)).toBe(false);
  });

  it("persists across instances", () => {
    const first = createStore({ accountId: ACCOUNT, home });
    const key = first.getOrCreate("user-42");

    const reborn = createStore({ accountId: ACCOUNT, home });
    expect(sameBytes(reborn.getOrCreate("user-42"), key)).toBe(true);
    expect(reborn.get("never-seen")).toBeNull();
  });

  it("get and getOrCreate never advance an existing key's durable generation", () => {
    let nowSec = 1_700_000_000;
    const first = createStore({
      accountId: ACCOUNT,
      home,
      _nowSec: () => nowSec++,
    });
    const key = first.getOrCreate("user-42");
    const generationBefore = readFileSync(generationPath());

    expect(sameBytes(first.get("user-42")!, key)).toBe(true);
    expect(sameBytes(first.getOrCreate("user-42"), key)).toBe(true);

    const restarted = createStore({
      accountId: ACCOUNT,
      home,
      _nowSec: () => nowSec++,
    });
    expect(sameBytes(restarted.get("user-42")!, key)).toBe(true);
    expect(sameBytes(restarted.getOrCreate("user-42"), key)).toBe(true);
    expect(readFileSync(generationPath())).toEqual(generationBefore);
    expect(restarted.generationOf("user-42")).toEqual({
      epoch: 1,
      rotatedAtSec: 1_700_000_000,
    });
  });

  it("persists a __proto__ peerId as an own key across instances", () => {
    const first = createStore({ accountId: ACCOUNT, home });
    const key = first.getOrCreate("__proto__");

    const persisted = storedKeys();
    expect(Object.prototype.hasOwnProperty.call(persisted, "__proto__")).toBe(true);
    expect(persisted["__proto__"]).toBe(Buffer.from(key).toString("base64url"));

    const reborn = createStore({ accountId: ACCOUNT, home });
    expect(sameBytes(reborn.getOrCreate("__proto__"), key)).toBe(true);
  });

  it("writes with owner-only permissions", () => {
    const store = createStore({ accountId: ACCOUNT, home });
    store.getOrCreate("user-42");
    expect(statSync(storePath()).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(storePath())).mode & 0o777).toBe(0o700);
  });

  it("scopes keys per account", () => {
    const a = createStore({ accountId: "acct-a", home });
    const b = createStore({ accountId: "acct-b", home });
    expect(sameBytes(a.getOrCreate("user-42"), b.getOrCreate("user-42"))).toBe(false);
    expect(statSync(storePath("acct-a")).isFile()).toBe(true);
    expect(statSync(storePath("acct-b")).isFile()).toBe(true);
  });

  it("isolates the same account and peer across tenants, including ciphertext", () => {
    const tenantA = new ConversationKeyStore({
      tenant: "tenant-A",
      accountId: ACCOUNT,
      home,
    });
    const tenantB = new ConversationKeyStore({
      tenant: "tenant-B",
      accountId: ACCOUNT,
      home,
    });
    const keyA = tenantA.getOrCreate("same-peer");
    const keyB = tenantB.getOrCreate("same-peer");
    expect(sameBytes(keyA, keyB)).toBe(false);
    expect(storePath(ACCOUNT, "tenant-A")).not.toBe(
      storePath(ACCOUNT, "tenant-B"),
    );

    const ciphertext = sealEnvelope(
      { tenant: "tenant-A", accountId: ACCOUNT, sub: "same-peer" },
      keyA,
      { text: "tenant-A only" },
    );
    expect(openEnvelope(ciphertext, keyA).message).toEqual({
      text: "tenant-A only",
    });
    expect(() => openEnvelope(ciphertext, keyB)).toThrow();
  });

  it("allows two processes to write distinct tenant tuples without cross-removal", async () => {
    const fixture = fileURLToPath(
      new URL("./test-fixtures/write-conversation-key.ts", import.meta.url),
    );
    const run = (tenant: string) =>
      new Promise<{ code: number | null; stdout: string; stderr: string }>(
        (resolve) => {
          const child = spawn(
            process.execPath,
            [
              "--import",
              "tsx",
              fixture,
              home,
              tenant,
              ACCOUNT,
              "same-peer",
            ],
            { stdio: ["ignore", "pipe", "pipe"] },
          );
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
        },
      );

    const [a, b] = await Promise.all([run("tenant-A"), run("tenant-B")]);
    expect(a, a.stderr).toMatchObject({ code: 0 });
    expect(b, b.stderr).toMatchObject({ code: 0 });
    expect(a.stdout).not.toBe(b.stdout);
    expect(statSync(storePath(ACCOUNT, "tenant-A")).isFile()).toBe(true);
    expect(statSync(storePath(ACCOUNT, "tenant-B")).isFile()).toBe(true);
  }, 15_000);

  it("rejects a traversal accountId before touching the filesystem", () => {
    expect(() => createStore({ accountId: "../evil", home })).toThrow();
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid maxKeys %s",
    (maxKeys) => {
      expect(() => createStore({ accountId: ACCOUNT, home, maxKeys })).toThrow(
        /positive safe integer/,
      );
    },
  );

  it("moves an initially corrupt store aside under the existing lazy-load policy", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mkdirSync(dirname(storePath()), { recursive: true });
    writeFileSync(storePath(), "{ not json !!", "utf8");
    const store = createStore({ accountId: ACCOUNT, home });
    expect(store.getOrCreate("user-42")).toHaveLength(32);
    expect(Object.keys(storedKeys())).toEqual(["user-42"]);
    expect(readdirSync(dirname(storePath())).some((name) => name.includes(".corrupt-"))).toBe(
      true,
    );
  });

  it("rejects an embedded identity mismatch without quarantining or rewriting", () => {
    const source = createStore({ accountId: ACCOUNT, home });
    source.getOrCreate("same-peer");
    const sourceBytes = readFileSync(storePath());
    const targetPath = storePath(ACCOUNT, "tenant-B");
    mkdirSync(dirname(targetPath), { recursive: true, mode: 0o700 });
    writeFileSync(targetPath, sourceBytes, { mode: 0o600 });

    const target = new ConversationKeyStore({
      tenant: "tenant-B",
      accountId: ACCOUNT,
      home,
    });
    expect(() => target.get("same-peer")).toThrow(
      expect.objectContaining({
        code: "identity-mismatch",
        fields: expect.arrayContaining(["storage.tenant"]),
      }),
    );
    expect(readFileSync(targetPath)).toEqual(sourceBytes);
    expect(
      readdirSync(dirname(targetPath)).some((name) =>
        name.includes(".corrupt-"),
      ),
    ).toBe(false);
  });

  it("does not let a malformed document version hide a foreign embedded identity", () => {
    const source = createStore({ accountId: ACCOUNT, home });
    source.getOrCreate("same-peer");
    const candidate = JSON.parse(
      readFileSync(storePath(), "utf8"),
    ) as Record<string, unknown>;
    candidate.version = 999;
    const targetBytes = Buffer.from(JSON.stringify(candidate));
    const targetPath = storePath(ACCOUNT, "tenant-B");
    mkdirSync(dirname(targetPath), { recursive: true, mode: 0o700 });
    writeFileSync(targetPath, targetBytes, { mode: 0o600 });

    const target = new ConversationKeyStore({
      tenant: "tenant-B",
      accountId: ACCOUNT,
      home,
    });
    expect(() => target.get("same-peer")).toThrow(
      expect.objectContaining({
        code: "identity-mismatch",
        fields: expect.arrayContaining(["storage.tenant"]),
      }),
    );
    expect(readFileSync(targetPath)).toEqual(targetBytes);
    expect(
      readdirSync(dirname(targetPath)).some((name) =>
        name.includes(".corrupt-"),
      ),
    ).toBe(false);
  });

  it("treats an initially stored key of the wrong length as corrupt", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mkdirSync(dirname(storePath()), { recursive: true });
    writeFileSync(
      storePath(),
      JSON.stringify({ version: 1, keys: { "user-42": Buffer.from("short").toString("base64url") } }),
      "utf8",
    );
    const store = createStore({ accountId: ACCOUNT, home });
    expect(store.getOrCreate("user-42")).toHaveLength(32);
  });

  it("keeps existing keys and rejects a new peer at capacity with zero durable mutation", () => {
    const store = createStore({
      accountId: ACCOUNT,
      home,
      maxKeys: 2,
      onCapacityWarning: quietWarning,
    });
    const p1 = store.getOrCreate("p1");
    const p2 = store.getOrCreate("p2");
    const before = readFileSync(storePath());

    let thrown: unknown;
    try {
      store.getOrCreate("p3");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ConversationKeyCapacityError);
    expect(thrown).toMatchObject({
      name: "ConversationKeyCapacityError",
      accountId: ACCOUNT,
      currentKeys: 2,
      maxKeys: 2,
    });
    expect(readFileSync(storePath()).equals(before)).toBe(true);
    expect(sameBytes(store.getOrCreate("p1"), p1)).toBe(true);
    expect(sameBytes(store.getOrCreate("p2"), p2)).toBe(true);
    expect(store.get("p3")).toBeNull();

    const reborn = createStore({
      accountId: ACCOUNT,
      home,
      maxKeys: 2,
      onCapacityWarning: quietWarning,
    });
    expect(sameBytes(reborn.getOrCreate("p1"), p1)).toBe(true);
    expect(sameBytes(reborn.getOrCreate("p2"), p2)).toBe(true);
    expect(reborn.get("p3")).toBeNull();
  });

  it("does not rewrite a full store during repeated existing-key lookup", () => {
    const store = createStore({
      accountId: ACCOUNT,
      home,
      maxKeys: 2,
      onCapacityWarning: quietWarning,
    });
    store.getOrCreate("p1");
    store.getOrCreate("p2");
    const before = readFileSync(storePath());
    expect(store.getOrCreate("p1")).not.toBeNull();
    expect(store.getOrCreate("p1")).not.toBeNull();
    expect(readFileSync(storePath()).equals(before)).toBe(true);
    expect(Object.keys(storedKeys())).toEqual(["p1", "p2"]);
  });

  it("publishes a new key in memory only after persistence succeeds", () => {
    let failPersist = false;
    const store = createStore({
      accountId: ACCOUNT,
      home,
      maxKeys: 10,
      _beforePersist: () => {
        if (failPersist) throw new Error("injected write failure");
      },
    });
    store.getOrCreate("p1");
    const before = readFileSync(storePath());
    failPersist = true;

    expect(() => store.getOrCreate("p2")).toThrow();
    expect(store.get("p2")).toBeNull();
    expect(readFileSync(storePath()).equals(before)).toBe(true);

    failPersist = false;
    expect(store.getOrCreate("p2")).toHaveLength(32);
    expect(storedKeys()).toHaveProperty("p2");
  });

  it("fresh-reads before commit so a sequential stale instance cannot erase a key", () => {
    const a = createStore({ accountId: ACCOUNT, home, maxKeys: 10 });
    const b = createStore({ accountId: ACCOUNT, home, maxKeys: 10 });
    expect(b.get("nobody")).toBeNull(); // Prime B's empty cache before A commits.
    const p1 = a.getOrCreate("p1");
    b.getOrCreate("p2");

    const fresh = createStore({ accountId: ACCOUNT, home, maxKeys: 10 });
    expect(Object.keys(storedKeys())).toEqual(["p1", "p2"]);
    expect(sameBytes(fresh.getOrCreate("p1"), p1)).toBe(true);
  });

  it("treats ENOENT on a brand-new account's fresh read as empty", () => {
    const store = createStore({ accountId: ACCOUNT, home, maxKeys: 10 });
    expect(store.getOrCreate("first")).toHaveLength(32);
    expect(Object.keys(storedKeys())).toEqual(["first"]);
  });

  it("does not quarantine or mutate cache when a commit-path fresh read cannot parse", () => {
    const store = createStore({ accountId: ACCOUNT, home, maxKeys: 10 });
    const p1 = store.getOrCreate("p1");
    const valid = readFileSync(storePath());
    const invalid = Buffer.from("{ transiently unreadable shape");
    writeFileSync(storePath(), invalid);

    expect(() => store.getOrCreate("p2")).toThrow();
    expect(readFileSync(storePath()).equals(invalid)).toBe(true);
    expect(readdirSync(dirname(storePath())).some((name) => name.includes(".corrupt-"))).toBe(
      false,
    );
    expect(sameBytes(store.get("p1")!, p1)).toBe(true);
    expect(store.get("p2")).toBeNull();

    writeFileSync(storePath(), valid);
    expect(store.getOrCreate("p2")).toHaveLength(32);
  });

  it("rejects from a full cache without fresh-reading the disk", () => {
    const store = createStore({
      accountId: ACCOUNT,
      home,
      maxKeys: 2,
      onCapacityWarning: quietWarning,
    });
    store.getOrCreate("p1");
    store.getOrCreate("p2");
    writeFileSync(storePath(), "invalid-if-read", "utf8");
    expect(() => store.getOrCreate("p3")).toThrow(ConversationKeyCapacityError);
  });

  it("warns once after the durable 90 percent threshold is reached", () => {
    const warning = vi.fn();
    const store = createStore({
      accountId: ACCOUNT,
      home,
      maxKeys: 10,
      onCapacityWarning: warning,
    });
    for (let i = 1; i <= 8; i += 1) store.getOrCreate(`p${i}`);
    expect(warning).not.toHaveBeenCalled();
    store.getOrCreate("p9");
    expect(warning).toHaveBeenCalledOnce();
    expect(warning).toHaveBeenLastCalledWith({ accountId: ACCOUNT, currentKeys: 9, maxKeys: 10 });
    store.getOrCreate("p10");
    store.getOrCreate("p1");
    expect(warning).toHaveBeenCalledOnce();
  });

  it("warns once on the first access to an already-full store", () => {
    const first = createStore({
      accountId: ACCOUNT,
      home,
      maxKeys: 2,
      onCapacityWarning: quietWarning,
    });
    first.getOrCreate("p1");
    first.getOrCreate("p2");

    const warning = vi.fn();
    const reborn = createStore({
      accountId: ACCOUNT,
      home,
      maxKeys: 2,
      onCapacityWarning: warning,
    });
    reborn.getOrCreate("p1");
    reborn.getOrCreate("p2");
    expect(warning).toHaveBeenCalledOnce();
    expect(warning).toHaveBeenCalledWith({ accountId: ACCOUNT, currentKeys: 2, maxKeys: 2 });
  });

  it("does not warn for a threshold-crossing key until persistence succeeds", () => {
    const warning = vi.fn();
    let failPersist = false;
    const store = createStore({
      accountId: ACCOUNT,
      home,
      maxKeys: 10,
      onCapacityWarning: warning,
      _beforePersist: () => {
        if (failPersist) throw new Error("injected write failure");
      },
    });
    for (let i = 1; i <= 8; i += 1) store.getOrCreate(`p${i}`);
    failPersist = true;
    expect(() => store.getOrCreate("p9")).toThrow();
    expect(warning).not.toHaveBeenCalled();
    failPersist = false;
    store.getOrCreate("p9");
    expect(warning).toHaveBeenCalledOnce();
  });

  it("keeps a durable result when the warning callback throws and never retries it", () => {
    const fallback = vi.spyOn(console, "warn").mockImplementation(() => {});
    const warning = vi.fn(() => {
      throw new Error("logger unavailable");
    });
    const store = createStore({
      accountId: ACCOUNT,
      home,
      maxKeys: 1,
      onCapacityWarning: warning,
    });
    const key = store.getOrCreate("p1");
    expect(sameBytes(store.getOrCreate("p1"), key)).toBe(true);
    expect(storedKeys()).toHaveProperty("p1");
    expect(warning).toHaveBeenCalledOnce();
    expect(fallback).toHaveBeenCalledOnce();
  });
});
