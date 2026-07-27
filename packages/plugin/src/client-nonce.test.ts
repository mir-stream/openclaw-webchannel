/**
 * `clientNonce` format validator (protocol v3).
 *
 * Two properties matter here, and only one of them is about hygiene:
 *   1. ENTROPY — at least 16 random bytes (22 unpadded base64url chars), so the
 *      anchor cannot be guessed ahead of the attempt it protects.
 *   2. ALPHABET — base64url ONLY. This is what makes the `0x1F`-delimited wrap
 *      AAD unambiguous without escaping: a nonce that could contain `0x1F` would
 *      reopen the field-boundary ambiguity the delimiter exists to remove.
 */

import { describe, it, expect } from "vitest";

import {
  isValidClientNonce,
  CLIENT_NONCE_MIN_LENGTH,
  CLIENT_NONCE_MAX_LENGTH,
} from "./client-nonce.js";

describe("isValidClientNonce", () => {
  it("accepts unpadded base64url at and above the entropy floor", () => {
    expect(CLIENT_NONCE_MIN_LENGTH).toBe(22); // = 16 random bytes, unpadded
    expect(isValidClientNonce("A".repeat(CLIENT_NONCE_MIN_LENGTH))).toBe(true);
    expect(isValidClientNonce("Y2xpZW50LW5vbmNlLWZpeHR1cmUtMDE")).toBe(true);
    // The full base64url alphabet, including both URL-safe substitutions.
    expect(isValidClientNonce("abcXYZ012789-_-_-_-_-_")).toBe(true);
    expect(isValidClientNonce("Q".repeat(CLIENT_NONCE_MAX_LENGTH))).toBe(true);
  });

  it.each([
    ["one char below the entropy floor", "A".repeat(CLIENT_NONCE_MIN_LENGTH - 1)],
    ["one char above the cap", "A".repeat(CLIENT_NONCE_MAX_LENGTH + 1)],
    ["empty", ""],
    ["base64 padding", `${"A".repeat(22)}=`],
    ["standard-base64 '+'", `${"A".repeat(21)}+`],
    ["standard-base64 '/'", `${"A".repeat(21)}/`],
    ["NATS subject separator", `${"A".repeat(21)}.`],
    ["NATS wildcard", `${"A".repeat(21)}*`],
    ["whitespace", `${"A".repeat(21)} `],
    ["a 0x1F UNIT SEPARATOR (the AAD delimiter)", `${"A".repeat(21)}${String.fromCharCode(0x1f)}`],
    ["a NUL byte", `${"A".repeat(21)}${String.fromCharCode(0)}`],
    ["a newline", `${"A".repeat(21)}\n`],
    ["non-ASCII", `${"A".repeat(21)}é`],
  ])("rejects %s", (_label, value) => {
    expect(isValidClientNonce(value)).toBe(false);
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["a number", 1234567890123456789012],
    ["an object", { toString: () => "A".repeat(22) }],
    ["an array of chars", Array(22).fill("A")],
  ])("rejects the non-string %s", (_label, value) => {
    expect(isValidClientNonce(value)).toBe(false);
  });

  it("is anchored — a valid nonce embedded in junk is rejected", () => {
    expect(isValidClientNonce(`\n${"A".repeat(22)}`)).toBe(false);
    expect(isValidClientNonce(`${"A".repeat(22)}\n`)).toBe(false);
  });
});
