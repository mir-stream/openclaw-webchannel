/**
 * Guard for {@link settleUntil} — the condition-waiter that replaces the fixed
 * `settle()` tick budget at the assertions whose precondition is "the handshake
 * / publish has actually completed" (#307).
 *
 * The property that matters is the UNHAPPY one: a waiter that gives up quietly
 * and lets the assertion run anyway would turn a genuine red into a green, and
 * this repo's protected e2e gate is its only test evidence. So the timeout path
 * is pinned here, not just the success path.
 */

import { describe, expect, it } from "vitest";

import { settleUntil } from "./nats-client-wrapped.test-harness.js";

describe("settleUntil", () => {
  it("returns without ever yielding when the condition already holds", async () => {
    let polls = 0;
    await settleUntil(() => { polls++; return true; }, { label: "an already-true condition" });
    // polls === 1 IS the no-sleep proof: a sleep would force a second poll.
    expect(polls).toBe(1);
  });

  it("returns as soon as the condition flips, not after the full timeout", async () => {
    let ready = false;
    setTimeout(() => { ready = true; }, 30);
    const startedAt = Date.now();
    await settleUntil(() => ready, { label: "a condition that flips at 30ms", timeoutMs: 2000 });
    expect(ready).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(1000);
  });

  it("THROWS on timeout — it never lets the caller's assertion run on an unmet condition", async () => {
    const startedAt = Date.now();
    await expect(
      settleUntil(() => false, { label: "a condition that can never become true", timeoutMs: 120 }),
    ).rejects.toThrow(/^settleUntil: timed out after \d+ms \(limit 120ms\) waiting for: a condition that can never become true$/);
    // It waited rather than failing instantly, so the throw is the timeout path
    // and not an argument-validation error that would fire on a healthy runner.
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(120);
  });

  it("names what was awaited, so a timeout is diagnosable without opening the test", async () => {
    const error = await settleUntil(() => false, { label: "the widget to become frobnicated", timeoutMs: 20 })
      .then(() => null, (e: unknown) => e as Error);
    expect(error?.message).toContain("the widget to become frobnicated");
  });
});
