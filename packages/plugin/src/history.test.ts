import { describe, expect, it, vi } from "vitest";

import { recent, pageBefore, resolveHistoryConfig, DEFAULT_HISTORY_CONFIG } from "./history.js";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-core";

/**
 * Build a minimal OpenClawPluginApi stub whose `runtime.subagent.getSessionMessages`
 * is the only call history.ts makes. The mock honors the `limit` parameter
 * (returns the LAST `limit` items from the store) the way the real SDK does,
 * so pageBefore's fetch-then-slice contract is exercised faithfully.
 */
function makeApi(
  messages: unknown[] | Error,
): {
  api: OpenClawPluginApi;
  getSessionMessages: ReturnType<typeof vi.fn>;
} {
  const getSessionMessages = vi.fn(async (params: { limit?: number }) => {
    if (messages instanceof Error) throw messages;
    const limit = typeof params.limit === "number" && params.limit > 0 ? params.limit : undefined;
    const slice = typeof limit === "number" ? messages.slice(-limit) : messages;
    return { messages: slice };
  });
  const api = {
    runtime: {
      subagent: { getSessionMessages },
    },
  } as unknown as OpenClawPluginApi;
  return { api, getSessionMessages };
}

describe("history — resolveHistoryConfig (AC6)", () => {
  it("returns documented defaults when config is missing", () => {
    expect(resolveHistoryConfig(undefined)).toEqual(DEFAULT_HISTORY_CONFIG);
    expect(resolveHistoryConfig({})).toEqual(DEFAULT_HISTORY_CONFIG);
    expect(resolveHistoryConfig({ history: {} })).toEqual(DEFAULT_HISTORY_CONFIG);
  });

  it("fills missing sub-fields with defaults", () => {
    expect(resolveHistoryConfig({ history: { limit: 25 } })).toEqual({
      limit: 25,
      pageSize: DEFAULT_HISTORY_CONFIG.pageSize,
    });
    expect(resolveHistoryConfig({ history: { pageSize: 100 } })).toEqual({
      limit: DEFAULT_HISTORY_CONFIG.limit,
      pageSize: 100,
    });
  });

  it("rejects non-positive / non-finite / non-number values and falls back", () => {
    expect(resolveHistoryConfig({ history: { limit: 0, pageSize: -1 } })).toEqual(
      DEFAULT_HISTORY_CONFIG,
    );
    expect(resolveHistoryConfig({ history: { limit: NaN, pageSize: Infinity } })).toEqual(
      DEFAULT_HISTORY_CONFIG,
    );
    expect(resolveHistoryConfig({ history: { limit: "50", pageSize: "50" } })).toEqual(
      DEFAULT_HISTORY_CONFIG,
    );
  });

  it("floors fractional values so the wire contract is integer-only", () => {
    expect(resolveHistoryConfig({ history: { limit: 50.7, pageSize: 12.3 } })).toEqual({
      limit: 50,
      pageSize: 12,
    });
  });
});

describe("history — recent (AC2)", () => {
  it("returns normalized {id,role,text,ts}[] sorted as the store returns them", async () => {
    const { api, getSessionMessages } = makeApi([
      {
        role: "user",
        content: [{ type: "text", text: "hi" }],
        timestamp: 1700000000000,
        __openclaw: { id: "m-1" },
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "hello there" }],
        timestamp: 1700000001000,
        __openclaw: { id: "m-2" },
      },
    ]);

    const out = await recent(api, "agent:main:webchannel:web-anon", 50);

    expect(out).toEqual([
      { id: "m-1", role: "user", text: "hi", ts: 1700000000000 },
      { id: "m-2", role: "agent", text: "hello there", ts: 1700000001000 },
    ]);
    expect(getSessionMessages).toHaveBeenCalledWith({
      sessionKey: "agent:main:webchannel:web-anon",
      limit: 50,
    });
  });

  it("scopes EVERY call by sessionKey (no cross-peer leak) (AC2)", async () => {
    const { api, getSessionMessages } = makeApi([]);
    await recent(api, "agent:main:webchannel:alice", 25);
    await recent(api, "agent:main:webchannel:bob", 10);
    const calls = getSessionMessages.mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0][0]).toEqual({ sessionKey: "agent:main:webchannel:alice", limit: 25 });
    expect(calls[1][0]).toEqual({ sessionKey: "agent:main:webchannel:bob", limit: 10 });
  });

  it("returns [] for an empty sessionKey or non-positive limit (defensive)", async () => {
    const { api } = makeApi([{ role: "user", content: [{ type: "text", text: "x" }] }]);
    expect(await recent(api, "", 10)).toEqual([]);
    expect(await recent(api, "agent:main:webchannel:web-anon", 0)).toEqual([]);
    expect(await recent(api, "agent:main:webchannel:web-anon", -5)).toEqual([]);
  });

  it("treats a throwing store as 'no history' (best-effort, never crashes)", async () => {
    const { api } = makeApi(new Error("kernel exploded"));
    const logger = { warn: vi.fn() };
    const out = await recent(api, "agent:main:webchannel:web-anon", 10, logger);
    expect(out).toEqual([]);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toMatch(/history\.recent failed/);
  });

  it("treats a non-array payload as 'no history'", async () => {
    const { api } = makeApi("not-an-array" as unknown as unknown[]);
    expect(await recent(api, "agent:main:webchannel:web-anon", 10)).toEqual([]);
  });

  it("drops messages that are not user/agent (system, tool, etc.)", async () => {
    const { api } = makeApi([
      { role: "system", content: [{ type: "text", text: "you are a helpful assistant" }] },
      { role: "tool", content: [{ type: "text", text: "tool result" }] },
      { role: "user", content: [{ type: "text", text: "real user text" }] },
    ]);
    const out = await recent(api, "agent:main:webchannel:web-anon", 10);
    expect(out).toEqual([
      { id: expect.any(String), role: "user", text: "real user text", ts: expect.any(Number) },
    ]);
  });

  it("synthesizes a stable id when __openclaw.id is absent", async () => {
    const { api } = makeApi([
      { role: "user", content: [{ type: "text", text: "x" }], timestamp: 1700000000000 },
    ]);
    const out = await recent(api, "agent:main:webchannel:web-anon", 10);
    expect(out[0].id).toMatch(/^h-1700000000000-0$/);
  });

  it("accepts string timestamps (ISO)", async () => {
    const { api } = makeApi([
      { role: "user", content: [{ type: "text", text: "x" }], timestamp: "2026-06-19T00:00:00Z" },
    ]);
    const out = await recent(api, "agent:main:webchannel:web-anon", 10);
    expect(out[0].ts).toBe(Date.parse("2026-06-19T00:00:00Z"));
  });

  it("returns [] when the runtime binding is absent (defensive)", async () => {
    const api = { runtime: {} } as unknown as OpenClawPluginApi;
    expect(await recent(api, "agent:main:webchannel:web-anon", 10)).toEqual([]);
  });
});

describe("history — pageBefore (AC2 / AC4)", () => {
  // SDK-shaped: `role` is "user"|"assistant", text is in `content[].text`,
  // ids are attached at `__openclaw.id`.
  const FIXTURE = [
    { role: "user", content: [{ type: "text", text: "1" }], timestamp: 1000, __openclaw: { id: "m-1" } },
    { role: "assistant", content: [{ type: "text", text: "2" }], timestamp: 2000, __openclaw: { id: "m-2" } },
    { role: "user", content: [{ type: "text", text: "3" }], timestamp: 3000, __openclaw: { id: "m-3" } },
    { role: "assistant", content: [{ type: "text", text: "4" }], timestamp: 4000, __openclaw: { id: "m-4" } },
    { role: "user", content: [{ type: "text", text: "5" }], timestamp: 5000, __openclaw: { id: "m-5" } },
  ];

  it("returns messages strictly older than beforeId, never the cursor", async () => {
    const { api, getSessionMessages } = makeApi(FIXTURE);
    // limit=10 → fetchLimit=20 → window = last 20 = ALL 5 items.
    const out = await pageBefore(api, "agent:main:webchannel:web-anon", "m-4", 10);
    // Cursor is m-4 → strictly older = [m-1, m-2, m-3]
    expect(out.map((m) => m.id)).toEqual(["m-1", "m-2", "m-3"]);
    expect(getSessionMessages).toHaveBeenCalledWith({
      sessionKey: "agent:main:webchannel:web-anon",
      // limit * 2 so the slice still has room after filtering
      limit: 20,
    });
  });

  it("respects the requested page size (limit) cap", async () => {
    const { api } = makeApi(FIXTURE);
    // limit=2 → fetchLimit=4 → window = last 4 = [m-2..m-5].
    // cursor=m-3 (in window at idx=1) → older slice = [m-2] (1 item).
    // Then cap by limit=2 (we asked for 2 max) → still [m-2].
    const out = await pageBefore(api, "agent:main:webchannel:web-anon", "m-3", 2);
    expect(out.map((m) => m.id)).toEqual(["m-2"]);
  });

  it("falls back to the oldest `limit` items when beforeId is outside the window", async () => {
    // fetchLimit = limit*2 = 4. window = last 4 of FIXTURE = [m-2..m-5].
    // The cursor "ghost" is not in the window, so the fallback runs:
    // returns the OLDEST `limit` items the window has = slice(-2) of
    // [m-2..m-5] = [m-4, m-5].
    const { api } = makeApi(FIXTURE);
    const out = await pageBefore(api, "agent:main:webchannel:web-anon", "ghost", 2);
    expect(out.map((m) => m.id)).toEqual(["m-4", "m-5"]);
  });

  it("returns the oldest available items when cursor is past the fetched window", async () => {
    // limit=2, fetchLimit=4. With the limit-respecting mock, window = last 4.
    // Cursor m-1 is NOT in [m-2..m-5] (m-1 is older than the window).
    // The fallback returns the OLDEST `limit` items available: slice(-2) of
    // [m-2..m-5] = [m-4, m-5] — the user keeps making scroll progress.
    const { api } = makeApi(FIXTURE);
    const out = await pageBefore(api, "agent:main:webchannel:web-anon", "m-1", 2);
    expect(out.map((m) => m.id)).toEqual(["m-4", "m-5"]);
  });

  it("scopes every call by sessionKey (no cross-peer leak) (AC4)", async () => {
    const { api, getSessionMessages } = makeApi(FIXTURE);
    await pageBefore(api, "agent:main:webchannel:alice", "m-4", 10);
    const lastCall = getSessionMessages.mock.calls.at(-1)![0];
    expect(lastCall.sessionKey).toBe("agent:main:webchannel:alice");
  });

  it("returns [] for a missing cursor / non-positive limit (defensive)", async () => {
    const { api } = makeApi(FIXTURE);
    expect(await pageBefore(api, "agent:main:webchannel:web-anon", "", 10)).toEqual([]);
    expect(await pageBefore(api, "", "m-4", 10)).toEqual([]);
    expect(await pageBefore(api, "agent:main:webchannel:web-anon", "m-4", 0)).toEqual([]);
  });

  it("treats a throwing store as 'no history' (best-effort)", async () => {
    const { api } = makeApi(new Error("store unreachable"));
    const logger = { warn: vi.fn() };
    const out = await pageBefore(api, "agent:main:webchannel:web-anon", "m-4", 10, logger);
    expect(out).toEqual([]);
    expect(logger.warn.mock.calls[0][0]).toMatch(/history\.pageBefore failed/);
  });
});
