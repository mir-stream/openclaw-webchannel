import { describe, it, expect } from "vitest";
import { DemoUserDirectory, seedDemoUsers, sha256hex } from "./demo-users.js";

describe("DemoUserDirectory (reference demo login domain)", () => {
  const ACCOUNT = "demo-account";
  const OTHER = "other-account";
  const dir = new DemoUserDirectory(seedDemoUsers(ACCOUNT));

  it("authenticate returns the user for the correct password", () => {
    const user = dir.authenticate("alice", "demo");
    expect(user).not.toBeNull();
    expect(user?.username).toBe("alice");
  });

  it("authenticate returns null for a wrong password", () => {
    expect(dir.authenticate("alice", "wrong")).toBeNull();
  });

  it("authenticate returns null for an unknown user (no enumeration difference)", () => {
    expect(dir.authenticate("mallory", "demo")).toBeNull();
  });

  it("canAccess is true for a seeded account, false for another", () => {
    const alice = dir.authenticate("alice", "demo")!;
    expect(dir.canAccess(alice, ACCOUNT)).toBe(true);
    expect(dir.canAccess(alice, OTHER)).toBe(false);
  });

  it("list() returns usernames + allowedAccounts without leaking secrets", () => {
    const view = new DemoUserDirectory(seedDemoUsers(ACCOUNT)).list();
    const alice = view.find((u) => u.username === "alice");
    expect(alice).toBeTruthy();
    expect(alice!.allowedAccounts).toEqual([ACCOUNT]);
    // No secret fields (passwordSha256 / uuid) escape through the view.
    for (const row of view) {
      expect(row).not.toHaveProperty("passwordSha256");
      expect(row).not.toHaveProperty("uuid");
    }
  });

  it("setAllowedAccounts updates canAccess live (grant then revoke)", () => {
    const d = new DemoUserDirectory(seedDemoUsers(ACCOUNT));
    const alice = () => d.get("alice")!;
    expect(d.canAccess(alice(), OTHER)).toBe(false);

    // Grant OTHER.
    expect(d.setAllowedAccounts("alice", [ACCOUNT, OTHER])).toBe(true);
    expect(d.canAccess(alice(), OTHER)).toBe(true);

    // Revoke everything.
    expect(d.setAllowedAccounts("alice", [])).toBe(true);
    expect(d.canAccess(alice(), ACCOUNT)).toBe(false);
    expect(d.canAccess(alice(), OTHER)).toBe(false);
  });

  it("setAllowedAccounts dedupes and returns false for an unknown user", () => {
    const d = new DemoUserDirectory(seedDemoUsers(ACCOUNT));
    expect(d.setAllowedAccounts("alice", [OTHER, OTHER, ACCOUNT])).toBe(true);
    expect(d.list().find((u) => u.username === "alice")!.allowedAccounts).toEqual([OTHER, ACCOUNT]);
    expect(d.setAllowedAccounts("mallory", [ACCOUNT])).toBe(false);
  });

  it("seedDemoUsers gives alice & bob distinct, stable uuids", () => {
    const users = seedDemoUsers(ACCOUNT);
    const alice = users.find((u) => u.username === "alice");
    const bob = users.find((u) => u.username === "bob");
    expect(alice?.uuid).toBe("11111111-1111-4111-8111-111111111111");
    expect(bob?.uuid).toBe("22222222-2222-4222-8222-222222222222");
    expect(alice?.uuid).not.toBe(bob?.uuid);
  });
});

describe("sha256hex", () => {
  it("is a lowercase hex digest of the input", () => {
    // Known SHA-256 of the ASCII string "demo".
    expect(sha256hex("demo")).toBe(
      "2a97516c354b68848cdbd8f54a226a0a55b21ed138e207ad6c5cbb9c00aa5aea",
    );
  });
});
