import { describe, expect, it, vi } from "vitest";

import {
  hasExplicitSessionReasoningOptOut,
  type ReasoningOptOutStoreAccess,
} from "./reasoning-opt-out.js";

function fakeStore(
  reasoningLevel: string | undefined,
  options?: { throwOnLoad?: boolean },
): ReasoningOptOutStoreAccess {
  return {
    resolveStorePath: vi.fn(() => "/tmp/webchannel-reasoning-store.json"),
    loadSessionStore: vi.fn(() => {
      if (options?.throwOnLoad) throw new Error("disk fault");
      return {};
    }),
    resolveSessionStoreEntry: vi.fn(() => ({
      normalizedKey: "agent:main:webchannel:default:direct:peer",
      existing: reasoningLevel === undefined ? undefined : { reasoningLevel },
      legacyKeys: [],
    })),
  } as unknown as ReasoningOptOutStoreAccess;
}

const input = (store: ReasoningOptOutStoreAccess) => ({
  cfg: {} as never,
  agentId: "main",
  sessionKey: "agent:main:webchannel:default:direct:peer",
  store,
});

describe("hasExplicitSessionReasoningOptOut", () => {
  it("does not veto when the session entry or reasoning level is absent", () => {
    expect(hasExplicitSessionReasoningOptOut(input(fakeStore(undefined)))).toBe(false);
  });

  it("vetoes a persisted explicit off", () => {
    expect(hasExplicitSessionReasoningOptOut(input(fakeStore("off")))).toBe(true);
  });

  it.each(["on", "stream"])("does not veto the explicit level %s", (level) => {
    expect(hasExplicitSessionReasoningOptOut(input(fakeStore(level)))).toBe(false);
  });

  it("fails closed when the store cannot be read", () => {
    expect(
      hasExplicitSessionReasoningOptOut(input(fakeStore(undefined, { throwOnLoad: true }))),
    ).toBe(true);
  });

  it("does not read the store when there is no session key", () => {
    const store = fakeStore("off");
    expect(
      hasExplicitSessionReasoningOptOut({
        cfg: {} as never,
        agentId: "main",
        sessionKey: "",
        store,
      }),
    ).toBe(false);
    expect(store.loadSessionStore).not.toHaveBeenCalled();
  });
});
