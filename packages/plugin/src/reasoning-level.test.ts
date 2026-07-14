import { describe, it, expect, vi } from "vitest";

import {
  resolveWebchannelReasoningLevel,
  type ReasoningStoreAccess,
} from "./reasoning-level.js";

/**
 * Reasoning display-policy resolution (Telegram parity, reasoning-level.ts).
 * The session-store read is injected so these are deterministic and never touch
 * the filesystem. Assertions mirror `resolveTelegramReasoningLevel`:
 * session-store level wins; a store-read throw is fail-closed to "off"; otherwise
 * the `agents.*.reasoningDefault` config default (else "off") applies.
 */

/** A fake store-access seam returning `entry` (or throwing on load). */
function fakeStore(
  entry: { reasoningLevel?: string } | undefined,
  opts?: { throwOnLoad?: boolean },
): ReasoningStoreAccess {
  return {
    resolveStorePath: vi.fn(() => "/tmp/webchannel-store.json"),
    loadSessionStore: vi.fn(() => {
      if (opts?.throwOnLoad) throw new Error("disk fault");
      return {};
    }),
    resolveSessionStoreEntry: vi.fn(() => ({
      normalizedKey: "k",
      existing: entry,
      legacyKeys: [],
    })),
  } as unknown as ReasoningStoreAccess;
}

const cfgWithDefault = (level: string) =>
  ({ agents: { defaults: { reasoningDefault: level } } }) as never;

describe("resolveWebchannelReasoningLevel", () => {
  it.each(["stream", "on", "off"] as const)(
    "session-store level '%s' wins over the config default",
    (level) => {
      // Config default is deliberately the opposite of the store level, proving
      // the store entry wins in both directions.
      const cfg = cfgWithDefault(level === "off" ? "stream" : "off");
      expect(
        resolveWebchannelReasoningLevel({
          cfg,
          agentId: "main",
          sessionKey: "k",
          store: fakeStore({ reasoningLevel: level }),
        }),
      ).toBe(level);
    },
  );

  it("a store-read throw is fail-closed to 'off' even when the config default is 'stream'", () => {
    expect(
      resolveWebchannelReasoningLevel({
        cfg: cfgWithDefault("stream"),
        agentId: "main",
        sessionKey: "k",
        store: fakeStore(undefined, { throwOnLoad: true }),
      }),
    ).toBe("off");
  });

  it("an unrecognized session-store level falls through to the config default", () => {
    expect(
      resolveWebchannelReasoningLevel({
        cfg: cfgWithDefault("stream"),
        agentId: "main",
        sessionKey: "k",
        store: fakeStore({ reasoningLevel: "weird" }),
      }),
    ).toBe("stream");
  });

  it("no session entry → matching agents.list reasoningDefault (case-insensitive agent id)", () => {
    const cfg = {
      agents: {
        list: [{ id: "main", reasoningDefault: "stream" }],
        defaults: { reasoningDefault: "off" },
      },
    } as never;
    expect(
      resolveWebchannelReasoningLevel({
        cfg,
        agentId: "MAIN",
        sessionKey: "k",
        store: fakeStore(undefined),
      }),
    ).toBe("stream");
  });

  it("no session entry, no matching list entry → agents.defaults reasoningDefault", () => {
    expect(
      resolveWebchannelReasoningLevel({
        cfg: cfgWithDefault("stream"),
        agentId: "main",
        sessionKey: "k",
        store: fakeStore(undefined),
      }),
    ).toBe("stream");
  });

  it("no session entry and no config default → 'off'", () => {
    expect(
      resolveWebchannelReasoningLevel({
        cfg: {} as never,
        agentId: "main",
        sessionKey: "k",
        store: fakeStore(undefined),
      }),
    ).toBe("off");
  });

  it("no sessionKey → config default without reading the store", () => {
    const store = fakeStore(undefined);
    expect(
      resolveWebchannelReasoningLevel({
        cfg: cfgWithDefault("stream"),
        agentId: "main",
        sessionKey: "",
        store,
      }),
    ).toBe("stream");
    expect(store.loadSessionStore).not.toHaveBeenCalled();
  });
});
