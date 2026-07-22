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
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ConversationKeyCapacityError,
  ConversationKeyStore,
} from "./conversation-key-store.js";

const ACCOUNT = "acct-a";
const quietWarning = (): void => {};

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "webchannel-keystore-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(home, { recursive: true, force: true });
});

function storePath(account = ACCOUNT): string {
  return join(home, ".openclaw-webchannel", account, "conversation-keys.json");
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
    const store = new ConversationKeyStore({ accountId: ACCOUNT, home });
    const k1 = store.getOrCreate("user-42");
    expect(k1).toHaveLength(32);
    expect(sameBytes(store.getOrCreate("user-42"), k1)).toBe(true);
  });

  it("keeps distinct peers' keys independent", () => {
    const store = new ConversationKeyStore({ accountId: ACCOUNT, home });
    const a = store.getOrCreate("user-a");
    const b = store.getOrCreate("user-b");
    expect(sameBytes(a, b)).toBe(false);
  });

  it("persists across instances", () => {
    const first = new ConversationKeyStore({ accountId: ACCOUNT, home });
    const key = first.getOrCreate("user-42");

    const reborn = new ConversationKeyStore({ accountId: ACCOUNT, home });
    expect(sameBytes(reborn.getOrCreate("user-42"), key)).toBe(true);
    expect(reborn.get("never-seen")).toBeNull();
  });

  it("writes with owner-only permissions", () => {
    const store = new ConversationKeyStore({ accountId: ACCOUNT, home });
    store.getOrCreate("user-42");
    expect(statSync(storePath()).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(storePath())).mode & 0o777).toBe(0o700);
  });

  it("scopes keys per account", () => {
    const a = new ConversationKeyStore({ accountId: "acct-a", home });
    const b = new ConversationKeyStore({ accountId: "acct-b", home });
    expect(sameBytes(a.getOrCreate("user-42"), b.getOrCreate("user-42"))).toBe(false);
    expect(statSync(storePath("acct-a")).isFile()).toBe(true);
    expect(statSync(storePath("acct-b")).isFile()).toBe(true);
  });

  it("rejects a traversal accountId before touching the filesystem", () => {
    expect(() => new ConversationKeyStore({ accountId: "../evil", home })).toThrow();
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid maxKeys %s",
    (maxKeys) => {
      expect(() => new ConversationKeyStore({ accountId: ACCOUNT, home, maxKeys })).toThrow(
        /positive safe integer/,
      );
    },
  );

  it("moves an initially corrupt store aside under the existing lazy-load policy", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mkdirSync(dirname(storePath()), { recursive: true });
    writeFileSync(storePath(), "{ not json !!", "utf8");
    const store = new ConversationKeyStore({ accountId: ACCOUNT, home });
    expect(store.getOrCreate("user-42")).toHaveLength(32);
    expect(Object.keys(storedKeys())).toEqual(["user-42"]);
    expect(readdirSync(dirname(storePath())).some((name) => name.includes(".corrupt-"))).toBe(
      true,
    );
  });

  it("treats an initially stored key of the wrong length as corrupt", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mkdirSync(dirname(storePath()), { recursive: true });
    writeFileSync(
      storePath(),
      JSON.stringify({ version: 1, keys: { "user-42": Buffer.from("short").toString("base64url") } }),
      "utf8",
    );
    const store = new ConversationKeyStore({ accountId: ACCOUNT, home });
    expect(store.getOrCreate("user-42")).toHaveLength(32);
  });

  it("keeps existing keys and rejects a new peer at capacity with zero durable mutation", () => {
    const store = new ConversationKeyStore({
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

    const reborn = new ConversationKeyStore({
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
    const store = new ConversationKeyStore({
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
    const store = new ConversationKeyStore({ accountId: ACCOUNT, home, maxKeys: 10 });
    store.getOrCreate("p1");
    const before = readFileSync(storePath());
    mkdirSync(`${storePath()}.tmp`);

    expect(() => store.getOrCreate("p2")).toThrow();
    expect(store.get("p2")).toBeNull();
    expect(readFileSync(storePath()).equals(before)).toBe(true);

    rmSync(`${storePath()}.tmp`, { recursive: true });
    expect(store.getOrCreate("p2")).toHaveLength(32);
    expect(storedKeys()).toHaveProperty("p2");
  });

  it("fresh-reads before commit so a sequential stale instance cannot erase a key", () => {
    const a = new ConversationKeyStore({ accountId: ACCOUNT, home, maxKeys: 10 });
    const b = new ConversationKeyStore({ accountId: ACCOUNT, home, maxKeys: 10 });
    expect(b.get("nobody")).toBeNull(); // Prime B's empty cache before A commits.
    const p1 = a.getOrCreate("p1");
    b.getOrCreate("p2");

    const fresh = new ConversationKeyStore({ accountId: ACCOUNT, home, maxKeys: 10 });
    expect(Object.keys(storedKeys())).toEqual(["p1", "p2"]);
    expect(sameBytes(fresh.getOrCreate("p1"), p1)).toBe(true);
  });

  it("treats ENOENT on a brand-new account's fresh read as empty", () => {
    const store = new ConversationKeyStore({ accountId: ACCOUNT, home, maxKeys: 10 });
    expect(store.getOrCreate("first")).toHaveLength(32);
    expect(Object.keys(storedKeys())).toEqual(["first"]);
  });

  it("does not quarantine or mutate cache when a commit-path fresh read cannot parse", () => {
    const store = new ConversationKeyStore({ accountId: ACCOUNT, home, maxKeys: 10 });
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
    const store = new ConversationKeyStore({
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
    const store = new ConversationKeyStore({
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
    const first = new ConversationKeyStore({
      accountId: ACCOUNT,
      home,
      maxKeys: 2,
      onCapacityWarning: quietWarning,
    });
    first.getOrCreate("p1");
    first.getOrCreate("p2");

    const warning = vi.fn();
    const reborn = new ConversationKeyStore({
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
    const store = new ConversationKeyStore({
      accountId: ACCOUNT,
      home,
      maxKeys: 10,
      onCapacityWarning: warning,
    });
    for (let i = 1; i <= 8; i += 1) store.getOrCreate(`p${i}`);
    mkdirSync(`${storePath()}.tmp`);
    expect(() => store.getOrCreate("p9")).toThrow();
    expect(warning).not.toHaveBeenCalled();
    rmSync(`${storePath()}.tmp`, { recursive: true });
    store.getOrCreate("p9");
    expect(warning).toHaveBeenCalledOnce();
  });

  it("keeps a durable result when the warning callback throws and never retries it", () => {
    const fallback = vi.spyOn(console, "warn").mockImplementation(() => {});
    const warning = vi.fn(() => {
      throw new Error("logger unavailable");
    });
    const store = new ConversationKeyStore({
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
