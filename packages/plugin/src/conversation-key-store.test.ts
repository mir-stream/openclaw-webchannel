/**
 * ConversationKeyStore tests — Phase 6 (multi-device E2E).
 *
 * The store's contract is what makes multi-device work: one STABLE random key
 * per peerId, generated once, persisted with the credentials-file posture
 * (0700 dir / 0600 file, atomic write), surviving process restarts, and never
 * silently regenerated for a known peer.
 */

import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ConversationKeyStore } from "./conversation-key-store.js";

const ACCOUNT = "acct-a";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "webchannel-keystore-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function storePath(account = ACCOUNT): string {
  return join(home, ".openclaw-webchannel", account, "conversation-keys.json");
}

describe("ConversationKeyStore", () => {
  it("generates a 32-byte key once and returns the SAME key on later calls", () => {
    const store = new ConversationKeyStore({ accountId: ACCOUNT, home });
    const k1 = store.getOrCreate("user-42");
    expect(k1).toHaveLength(32);
    const k2 = store.getOrCreate("user-42");
    expect(Buffer.from(k2).equals(Buffer.from(k1))).toBe(true);
  });

  it("keeps distinct peers' keys independent", () => {
    const store = new ConversationKeyStore({ accountId: ACCOUNT, home });
    const a = store.getOrCreate("user-a");
    const b = store.getOrCreate("user-b");
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });

  it("persists across instances (the gateway-restart property)", () => {
    const first = new ConversationKeyStore({ accountId: ACCOUNT, home });
    const k = first.getOrCreate("user-42");

    const reborn = new ConversationKeyStore({ accountId: ACCOUNT, home });
    const kAgain = reborn.getOrCreate("user-42");
    expect(Buffer.from(kAgain).equals(Buffer.from(k))).toBe(true);
    // And a plain read sees it too.
    expect(reborn.get("user-42")).not.toBeNull();
    expect(reborn.get("never-seen")).toBeNull();
  });

  it("writes with owner-only permissions (0600 file, 0700 dir)", () => {
    const store = new ConversationKeyStore({ accountId: ACCOUNT, home });
    store.getOrCreate("user-42");
    expect(statSync(storePath()).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, ".openclaw-webchannel", ACCOUNT)).mode & 0o777).toBe(0o700);
  });

  it("scopes keys per account (separate files, separate keys)", () => {
    const a = new ConversationKeyStore({ accountId: "acct-a", home });
    const b = new ConversationKeyStore({ accountId: "acct-b", home });
    const ka = a.getOrCreate("user-42");
    const kb = b.getOrCreate("user-42");
    expect(Buffer.from(ka).equals(Buffer.from(kb))).toBe(false);
    expect(statSync(storePath("acct-a")).isFile()).toBe(true);
    expect(statSync(storePath("acct-b")).isFile()).toBe(true);
  });

  it("rejects a traversal accountId before touching the filesystem", () => {
    expect(() => new ConversationKeyStore({ accountId: "../evil", home })).toThrow();
  });

  it("moves a corrupt store aside and starts fresh instead of crashing", () => {
    mkdirSync(join(home, ".openclaw-webchannel", ACCOUNT), { recursive: true });
    writeFileSync(storePath(), "{ not json !!", "utf8");
    const store = new ConversationKeyStore({ accountId: ACCOUNT, home });
    // Fresh key served; the corrupt file no longer shadows the new store.
    const k = store.getOrCreate("user-42");
    expect(k).toHaveLength(32);
    const onDisk = JSON.parse(readFileSync(storePath(), "utf8")) as {
      version: number;
      keys: Record<string, string>;
    };
    expect(onDisk.version).toBe(1);
    expect(Object.keys(onDisk.keys)).toEqual(["user-42"]);
  });

  it("rejects a stored key of the wrong length (treated as corrupt)", () => {
    mkdirSync(join(home, ".openclaw-webchannel", ACCOUNT), { recursive: true });
    writeFileSync(
      storePath(),
      JSON.stringify({ version: 1, keys: { "user-42": Buffer.from("short").toString("base64url") } }),
      "utf8",
    );
    const store = new ConversationKeyStore({ accountId: ACCOUNT, home });
    // Whole file is quarantined; the peer gets a fresh valid key.
    expect(store.getOrCreate("user-42")).toHaveLength(32);
  });

  it("S2: evicts the oldest key once the ceiling is exceeded", () => {
    const store = new ConversationKeyStore({ accountId: ACCOUNT, home, maxKeys: 2 });
    const k1 = store.getOrCreate("p1");
    store.getOrCreate("p2");
    store.getOrCreate("p3"); // evicts p1
    expect(store.get("p1")).toBeNull();
    expect(store.get("p2")).not.toBeNull();
    expect(store.get("p3")).not.toBeNull();
    // A returning evicted peer gets a NEW key (old history unrecoverable —
    // the documented last-resort behavior under abuse-level churn).
    const k1b = store.getOrCreate("p1");
    expect(Buffer.from(k1b).equals(Buffer.from(k1))).toBe(false);
  });
});
