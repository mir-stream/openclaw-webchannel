/**
 * P1-7 terminal-error copy tests: every cause resolves to non-empty copy, an
 * absent cause falls back to the `unknown` entry, and unrecoverable causes hide
 * the Re-authenticate affordance.
 */
import { describe, expect, it } from "vitest";

import type { ChatBubble, WebChannelErrorCause } from "../../../packages/client/src/index.js";
import { sendStatusCopy, terminalErrorCopy } from "./error-copy.js";

const ALL_CAUSES: WebChannelErrorCause[] = [
  "auth-expired",
  "auth-rejected",
  "protocol-mismatch",
  "secure-channel-failed",
  "config",
  "capacity",
  "server",
  "empty",
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
    expect(terminalErrorCopy("capacity").showReauth).toBe(false);
  });

  it("offers Re-authenticate for the recoverable causes (incl. the unknown fallback)", () => {
    for (const cause of ["auth-expired", "auth-rejected", "secure-channel-failed", "server", "unknown"] as const) {
      expect(terminalErrorCopy(cause).showReauth).toBe(true);
    }
  });

  it("scene ⑤: an expired credential still reads \"Credentials expired\"", () => {
    expect(terminalErrorCopy("auth-expired").heading).toBe("Credentials expired");
  });

  it("tells a capacity-rejected user to contact the operator", () => {
    const copy = terminalErrorCopy("capacity");
    expect(copy.heading).toMatch(/full/i);
    expect(copy.hint).toMatch(/operator/i);
  });
});

describe("sendStatusCopy cancellation", () => {
  const bubble = (extra: Partial<ChatBubble>) => ({
    id: "m", role: "user", text: "x", sendState: "failed", sendFailure: { reason: "cancelled", retryable: false }, ...extra,
  }) as ChatBubble;

  it("never labels a cancel after acceptance as a failed send", () => {
    // The durable request line owns the effects warning for this case.
    expect(sendStatusCopy(bubble({ requestState: "cancelled" }))).toBeUndefined();
  });

  it("labels a cancel before delivery as not sent", () => {
    expect(sendStatusCopy(bubble({}))).toEqual({ label: "Not sent · cancelled" });
  });
});

describe("sendStatusCopy empty turn (#404)", () => {
  const bubble = (sendFailure: ChatBubble["sendFailure"]) => ({
    id: "m", role: "user", text: "x", sendState: "failed", sendFailure,
  }) as ChatBubble;

  it("says no response was generated and offers the retry draft", () => {
    expect(sendStatusCopy(bubble({ reason: "turn-failed", retryable: true, cause: "empty" }))).toEqual({
      label: "No response generated",
      hint: "The agent finished without replying. Restore the draft and send it again to retry.",
      restoreDraft: true,
    });
  });

  it("keeps the effects warning for an unclassified turn failure", () => {
    expect(sendStatusCopy(bubble({ reason: "turn-failed", retryable: true }))?.label)
      .toBe("Request failed after acceptance");
  });
});
