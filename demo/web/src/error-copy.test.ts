/**
 * P1-7 terminal-error copy tests: every cause resolves to non-empty copy, an
 * absent cause falls back to the `unknown` entry, and the two unrecoverable
 * causes (`protocol-mismatch`, `config`) hide the Re-authenticate affordance.
 */
import { describe, expect, it } from "vitest";

import type { WebChannelErrorCause } from "../../../packages/client/src/index.js";
import { terminalErrorCopy } from "./error-copy.js";

const ALL_CAUSES: WebChannelErrorCause[] = [
  "auth-expired",
  "auth-rejected",
  "protocol-mismatch",
  "secure-channel-failed",
  "config",
  "server",
  "unknown",
];

describe("terminalErrorCopy", () => {
  it("returns non-empty heading + hint for every cause", () => {
    for (const cause of ALL_CAUSES) {
      const copy = terminalErrorCopy(cause);
      expect(copy.heading.length).toBeGreaterThan(0);
      expect(copy.hint.length).toBeGreaterThan(0);
    }
  });

  it("falls back to the `unknown` entry when the cause is undefined", () => {
    expect(terminalErrorCopy(undefined)).toEqual(terminalErrorCopy("unknown"));
  });

  it("falls back to the `unknown` entry for an unrecognized cause (version skew)", () => {
    // A NEWER published client can emit a cause this bundle's Record doesn't
    // know; the widget must degrade to the unknown copy, not crash the render.
    expect(terminalErrorCopy("rate-limited" as WebChannelErrorCause)).toEqual(
      terminalErrorCopy("unknown"),
    );
  });

  it("hides Re-authenticate for the unrecoverable causes", () => {
    expect(terminalErrorCopy("protocol-mismatch").showReauth).toBe(false);
    expect(terminalErrorCopy("config").showReauth).toBe(false);
  });

  it("offers Re-authenticate for the recoverable causes (incl. the unknown fallback)", () => {
    for (const cause of ["auth-expired", "auth-rejected", "secure-channel-failed", "server", "unknown"] as const) {
      expect(terminalErrorCopy(cause).showReauth).toBe(true);
    }
  });

  it("scene ⑤: an expired credential still reads \"Credentials expired\"", () => {
    expect(terminalErrorCopy("auth-expired").heading).toBe("Credentials expired");
  });
});
