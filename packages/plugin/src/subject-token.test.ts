import { describe, it, expect } from "vitest";
import { assertValidSubjectToken } from "./subject-token.js";

describe("assertValidSubjectToken (plugin — subject-injection guard)", () => {
  it("accepts safe alphanumeric tokens (with - and _)", () => {
    for (const t of ["web-jwt-peer", "peer_1", "default-agent", "PEER123", "a"]) {
      expect(() => assertValidSubjectToken(t, "peerId")).not.toThrow();
    }
  });

  it("rejects the empty string", () => {
    expect(() => assertValidSubjectToken("", "peerId")).toThrow(/non-empty/);
  });

  it("rejects a subject separator (`.`) — would widen the subject hierarchy", () => {
    expect(() => assertValidSubjectToken("a.b", "peerId")).toThrow(/not allowed/);
  });

  it("rejects NATS wildcards `*` and `>`", () => {
    expect(() => assertValidSubjectToken("a*", "peerId")).toThrow(/not allowed/);
    expect(() => assertValidSubjectToken("a>", "peerId")).toThrow(/not allowed/);
    expect(() => assertValidSubjectToken("*", "peerId")).toThrow(/not allowed/);
    expect(() => assertValidSubjectToken(">", "peerId")).toThrow(/not allowed/);
  });

  it("rejects whitespace and control characters", () => {
    expect(() => assertValidSubjectToken("a b", "peerId")).toThrow(/not allowed/);
    expect(() => assertValidSubjectToken("a\tb", "peerId")).toThrow(/not allowed/);
    expect(() => assertValidSubjectToken("a\nb", "peerId")).toThrow(/not allowed/);
  });

  it("accepts a token at the 128-char length cap", () => {
    expect(() => assertValidSubjectToken("a".repeat(128), "peerId")).not.toThrow();
  });

  it("rejects an all-alphanumeric token longer than 128 chars", () => {
    expect(() => assertValidSubjectToken("a".repeat(129), "peerId")).toThrow(/not allowed/);
  });

  it("names the offending field in the error", () => {
    expect(() => assertValidSubjectToken("a*", "peerId")).toThrow(/peerId/);
  });
});
