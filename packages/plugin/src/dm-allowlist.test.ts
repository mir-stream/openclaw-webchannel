import { describe, it, expect } from "vitest";
import { resolveDmAdmission } from "./dm-allowlist.js";

describe("resolveDmAdmission (DM allowlist, split-authz plugin half)", () => {
  it("admits everyone when no dmSecurity policy is set (Phase A preserved)", () => {
    expect(resolveDmAdmission("anyone", undefined)).toEqual({
      allowed: true,
      reason: "policy-unset",
    });
    expect(resolveDmAdmission("anyone", { allowFrom: ["alice"] })).toEqual({
      allowed: true,
      reason: "policy-unset",
    });
  });

  it("admits everyone under an open policy", () => {
    for (const dmSecurity of ["open", "all", "anyone", "everyone", "public", "ANY"]) {
      expect(resolveDmAdmission("mallory", { dmSecurity }).allowed).toBe(true);
    }
  });

  it("default-denies when policy is allowlist and allowFrom is empty", () => {
    expect(resolveDmAdmission("alice", { dmSecurity: "allowlist" })).toEqual({
      allowed: false,
      reason: "default-deny-empty-allowlist",
    });
    expect(resolveDmAdmission("alice", { dmSecurity: "allowlist", allowFrom: [] })).toEqual({
      allowed: false,
      reason: "default-deny-empty-allowlist",
    });
  });

  it("admits only allowlisted peers under an allowlist policy", () => {
    const cfg = { dmSecurity: "allowlist", allowFrom: ["alice", "bob"] };
    expect(resolveDmAdmission("alice", cfg)).toEqual({ allowed: true, reason: "allowlisted" });
    expect(resolveDmAdmission("bob", cfg)).toEqual({ allowed: true, reason: "allowlisted" });
    expect(resolveDmAdmission("mallory", cfg)).toEqual({ allowed: false, reason: "not-allowlisted" });
  });

  it("is case-insensitive on the policy token only (not on peer identity)", () => {
    expect(resolveDmAdmission("alice", { dmSecurity: "Allowlist", allowFrom: ["alice"] }).allowed).toBe(true);
    // Peer identity is matched exactly — different case is a different identity.
    expect(resolveDmAdmission("Alice", { dmSecurity: "allowlist", allowFrom: ["alice"] }).allowed).toBe(false);
  });
});
