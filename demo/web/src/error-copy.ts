/**
 * P1-7 — terminal-error copy: map a machine-readable `WebChannelErrorCause` to
 * truthful heading/hint wording plus whether the Re-authenticate affordance can
 * plausibly help. Pure and DOM-free so the widget renders from it and a unit test
 * exercises every cause without a browser.
 *
 * The lookup is a `Record<WebChannelErrorCause, …>`, so adding a union member is a
 * COMPILE-TIME error until its copy exists (no silent fallthrough); `undefined`
 * (state carries no cause) resolves to the `unknown` entry — the safe default of
 * still offering re-auth (a useless click is cheaper than a dead-end screen).
 */
import type { WebChannelErrorCause } from "../../../packages/client/src/index.js";

export type TerminalErrorCopy = {
  /** Bold heading — names WHAT failed. */
  heading: string;
  /** Muted line — what to DO about it (always shown, exactly once). */
  hint: string;
  /** Whether Re-authenticate can plausibly fix it (false = re-auth is useless). */
  showReauth: boolean;
};

const COPY: Record<WebChannelErrorCause, TerminalErrorCopy> = {
  "auth-expired": {
    heading: "Credentials expired",
    hint: "Your session credential reached its TTL — re-authenticate to continue.",
    showReauth: true,
  },
  "auth-rejected": {
    heading: "Not authorized",
    hint: "The relay or agent rejected this credential — re-authenticate to mint a fresh one.",
    showReauth: true,
  },
  "protocol-mismatch": {
    heading: "Upgrade required",
    hint: "This page and the agent plugin speak incompatible protocol versions — upgrade the older side, then reload.",
    showReauth: false,
  },
  "secure-channel-failed": {
    heading: "Secure channel failed",
    hint: "The encrypted session could not be established — re-authenticate to retry with fresh keys.",
    showReauth: true,
  },
  config: {
    heading: "Configuration error",
    hint: "The embedding page passed incomplete connection config — this needs a code fix, not a retry.",
    showReauth: false,
  },
  capacity: {
    heading: "Agent account is full",
    hint: "This OpenClaw WebChannel account cannot admit new users — contact the operator to use another account.",
    showReauth: false,
  },
  server: {
    heading: "Agent-side failure",
    hint: "Registration failed on the agent — re-authenticate to retry, or try again later.",
    showReauth: true,
  },
  unknown: {
    heading: "Connection failed",
    hint: "The connection ended with an unrecoverable error.",
    showReauth: true,
  },
};

/**
 * Resolve terminal-error copy for a cause; `undefined` → the `unknown` entry.
 * The trailing `?? COPY.unknown` is version-skew defense, not dead code: the
 * client is a published package, so a NEWER client can emit a cause this stale
 * bundle's `Record` doesn't know — indexing would return `undefined` and the
 * widget's `copy.heading` would kill the whole render.
 */
export function terminalErrorCopy(cause: WebChannelErrorCause | undefined): TerminalErrorCopy {
  return COPY[cause ?? "unknown"] ?? COPY.unknown;
}
