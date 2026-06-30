import { describe, it, expect } from "vitest";
import { assertValidSubjectToken } from "./subject-token.js";

describe("assertValidSubjectToken (saas — subject-injection guard)", () => {
  it("accepts safe alphanumeric tokens (with - and _)", () => {
    for (const t of ["acme", "tenant-1", "tenant_2", "default-agent", "AGENT123", "a"]) {
      expect(() => assertValidSubjectToken(t, "tenant")).not.toThrow();
    }
  });

  it("rejects the empty string", () => {
    expect(() => assertValidSubjectToken("", "tenant")).toThrow(/non-empty/);
  });

  it("rejects a subject separator (`.`) — would widen the subject hierarchy", () => {
    expect(() => assertValidSubjectToken("a.b", "tenant")).toThrow(/not allowed/);
  });

  it("rejects NATS wildcards `*` and `>`", () => {
    expect(() => assertValidSubjectToken("a*", "tenant")).toThrow(/not allowed/);
    expect(() => assertValidSubjectToken("a>", "tenant")).toThrow(/not allowed/);
    expect(() => assertValidSubjectToken("*", "tenant")).toThrow(/not allowed/);
    expect(() => assertValidSubjectToken(">", "tenant")).toThrow(/not allowed/);
  });

  it("rejects whitespace and control characters", () => {
    expect(() => assertValidSubjectToken("a b", "tenant")).toThrow(/not allowed/);
    expect(() => assertValidSubjectToken("a\tb", "tenant")).toThrow(/not allowed/);
    expect(() => assertValidSubjectToken("a\nb", "tenant")).toThrow(/not allowed/);
  });

  it("accepts a token at the 128-char length cap", () => {
    expect(() => assertValidSubjectToken("a".repeat(128), "tenant")).not.toThrow();
  });

  it("rejects an all-alphanumeric token longer than 128 chars", () => {
    expect(() => assertValidSubjectToken("a".repeat(129), "tenant")).toThrow(/not allowed/);
  });

  it("names the offending field in the error", () => {
    expect(() => assertValidSubjectToken("a.b", "accountId")).toThrow(/accountId/);
  });
});
