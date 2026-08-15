import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  _resetHistoryShapeDriftWarningForTest,
  recent,
  pageBefore,
  planHistoryFetch,
  resolveHistoryConfig,
  DEFAULT_HISTORY_CONFIG,
} from "./history.js";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-core";

// history.ts accepts an opaque store key; route-shape assertions belong at the routing seam.
const SESSION_KEY = "opaque-session-key-1";
const OTHER_SESSION_KEY = "opaque-session-key-2";

beforeEach(() => {
  _resetHistoryShapeDriftWarningForTest();
});

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

    const out = await recent(api, SESSION_KEY, 50);

    expect(out).toEqual([
      { id: "m-1", role: "user", text: "hi", ts: 1700000000000 },
      { id: "m-2", role: "agent", text: "hello there", ts: 1700000001000 },
    ]);
    expect(getSessionMessages).toHaveBeenCalledWith({
      sessionKey: SESSION_KEY,
      limit: 50,
    });
  });

  it("scopes EVERY call by sessionKey (no cross-peer leak) (AC2)", async () => {
    const { api, getSessionMessages } = makeApi([]);
    await recent(api, SESSION_KEY, 25);
    await recent(api, OTHER_SESSION_KEY, 10);
    const calls = getSessionMessages.mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0][0]).toEqual({ sessionKey: SESSION_KEY, limit: 25 });
    expect(calls[1][0]).toEqual({ sessionKey: OTHER_SESSION_KEY, limit: 10 });
  });

  it("returns [] for an empty sessionKey or non-positive limit (defensive)", async () => {
    const { api } = makeApi([{ role: "user", content: [{ type: "text", text: "x" }] }]);
    expect(await recent(api, "", 10)).toEqual([]);
    expect(await recent(api, SESSION_KEY, 0)).toEqual([]);
    expect(await recent(api, SESSION_KEY, -5)).toEqual([]);
  });

  it("treats a throwing store as 'no history' (best-effort, never crashes)", async () => {
    const { api } = makeApi(new Error("kernel exploded"));
    const logger = { warn: vi.fn() };
    const out = await recent(api, SESSION_KEY, 10, logger);
    expect(out).toEqual([]);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toMatch(/history\.recent failed/);
  });

  it("treats a non-array payload as 'no history'", async () => {
    const { api } = makeApi("not-an-array" as unknown as unknown[]);
    expect(await recent(api, SESSION_KEY, 10)).toEqual([]);
  });

  it("drops messages that are not user/agent (system, tool, etc.)", async () => {
    const { api } = makeApi([
      { role: "system", content: [{ type: "text", text: "you are a helpful assistant" }] },
      { role: "tool", content: [{ type: "text", text: "tool result" }] },
      { role: "user", content: [{ type: "text", text: "real user text" }] },
    ]);
    const out = await recent(api, SESSION_KEY, 10);
    expect(out).toEqual([
      { id: expect.any(String), role: "user", text: "real user text", ts: expect.any(Number) },
    ]);
  });

  it("marks a window-relative synthetic id when __openclaw is absent", async () => {
    const { api } = makeApi([
      { role: "user", content: [{ type: "text", text: "x" }], timestamp: 1700000000000 },
    ]);
    const out = await recent(api, SESSION_KEY, 10);
    expect(out[0].id).toBe("h-1700000000000-0");
  });

  it("does not warn for the benign absent-envelope case or a valid observed id", async () => {
    const { api } = makeApi([
      { role: "user", content: "no envelope", timestamp: 1000 },
      {
        role: "assistant",
        content: "valid observed id",
        timestamp: 2000,
        __openclaw: { id: "m-valid" },
      },
    ]);
    const logger = { warn: vi.fn() };

    const out = await recent(api, SESSION_KEY, 10, logger);

    expect(out.map((message) => message.id)).toEqual([
      "h-1000-0",
      "m-valid",
    ]);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it.each([
    ["missing id", {}],
    ["empty id", { id: "" }],
    ["non-string id", { id: 42 }],
    ["null envelope", null],
    ["array envelope", [{ id: "array-id" }]],
  ])("warns when __openclaw has shape drift: %s", async (_case, envelope) => {
    const privateText = "private transcript body";
    const privateSessionKey = "private-session-key";
    const { api } = makeApi([
      {
        role: "user",
        content: privateText,
        timestamp: 1700000000000,
        __openclaw: envelope,
      },
    ]);
    const logger = { warn: vi.fn() };

    const out = await recent(api, privateSessionKey, 10, logger);

    expect(out[0].id).toBe("h-1700000000000-0");
    expect(logger.warn).toHaveBeenCalledOnce();
    const warning = logger.warn.mock.calls[0][0];
    expect(warning).toContain("webchannel: history transcript __openclaw shape drift");
    expect(warning).not.toContain(privateText);
    expect(warning).not.toContain(privateSessionKey);
  });

  it("emits the shape-drift warning at most once per process", async () => {
    const { api } = makeApi([
      { role: "user", content: "one", timestamp: 1000, __openclaw: {} },
      { role: "assistant", content: "two", timestamp: 2000, __openclaw: { id: 7 } },
    ]);
    const logger = { warn: vi.fn() };

    await recent(api, SESSION_KEY, 10, logger);
    await recent(api, SESSION_KEY, 10, logger);

    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it("accepts string timestamps (ISO)", async () => {
    const { api } = makeApi([
      { role: "user", content: [{ type: "text", text: "x" }], timestamp: "2026-06-19T00:00:00Z" },
    ]);
    const out = await recent(api, SESSION_KEY, 10);
    expect(out[0].ts).toBe(Date.parse("2026-06-19T00:00:00Z"));
  });

  it("returns [] when the runtime binding is absent (defensive)", async () => {
    const api = { runtime: {} } as unknown as OpenClawPluginApi;
    expect(await recent(api, SESSION_KEY, 10)).toEqual([]);
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

  // A conversation long enough that a cursor can sit OUTSIDE the phase-1
  // (`limit * 2`) window but INSIDE the phase-2 (`MAX_FETCH_WINDOW = 1000`)
  // window — the case that the two-phase widening exists to serve.
  function makeConversation(n: number): unknown[] {
    return Array.from({ length: n }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: [{ type: "text", text: String(i + 1) }],
      timestamp: (i + 1) * 1000,
      __openclaw: { id: `m-${i + 1}` },
    }));
  }

  function makeIdlessConversation(n: number): unknown[] {
    return Array.from({ length: n }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: [{ type: "text", text: String(i + 1) }],
      timestamp: (i + 1) * 1000,
    }));
  }

  it("returns messages strictly older than beforeId, never the cursor", async () => {
    const { api, getSessionMessages } = makeApi(FIXTURE);
    // limit=10 → fetchLimit=20 → window = last 20 = ALL 5 items.
    const out = await pageBefore(api, SESSION_KEY, "m-4", 10);
    // Cursor is m-4 → strictly older = [m-1, m-2, m-3]
    expect(out.map((m) => m.id)).toEqual(["m-1", "m-2", "m-3"]);
    expect(getSessionMessages).toHaveBeenCalledWith({
      sessionKey: SESSION_KEY,
      // limit * 2 so the slice still has room after filtering
      limit: 20,
    });
  });

  it("respects the requested page size (limit) cap", async () => {
    // 30 messages, limit=3, cursor m-20. Many older messages exist, but the
    // page is capped at 3: [m-17, m-18, m-19]. (The cursor is outside the
    // phase-1 window, so this also exercises the widen path.)
    const { api } = makeApi(makeConversation(30));
    const out = await pageBefore(api, SESSION_KEY, "m-20", 3);
    expect(out.map((m) => m.id)).toEqual(["m-17", "m-18", "m-19"]);
  });

  it("returns [] (and re-fetches at the max window) for a cursor nowhere in the store", async () => {
    // A ghost cursor is in neither the phase-1 (limit*2=4) window nor the
    // phase-2 (1000) window. The buggy old behavior handed back the newest
    // `limit` items (which the client dedups → silent stop); the honest
    // signal is an empty page. Both phases must have run.
    const { api, getSessionMessages } = makeApi(FIXTURE);
    const out = await pageBefore(api, SESSION_KEY, "ghost", 2);
    expect(out).toEqual([]);
    expect(getSessionMessages).toHaveBeenCalledTimes(2);
    expect(getSessionMessages.mock.calls[0][0].limit).toBe(4);
    expect(getSessionMessages.mock.calls[1][0].limit).toBe(1000);
  });

  it("diagnoses a window-relative synthetic cursor miss without logging cursor, session, or text", async () => {
    const { api } = makeApi(makeIdlessConversation(30));
    const narrow = await recent(api, SESSION_KEY, 10);
    const cursor = narrow[0].id;
    const wide = await recent(api, SESSION_KEY, 30);
    const sameMessageWideId = wide.find((message) => message.text === "21")?.id;
    const logger = { warn: vi.fn() };

    // The marker is honest: the same message has a different id in another
    // tail window, so this cursor cannot be resolved by either paging phase.
    expect(cursor).toMatch(/^h-\d+-\d+$/);
    expect(sameMessageWideId).not.toBe(cursor);
    expect(await pageBefore(api, SESSION_KEY, cursor, 2, logger)).toEqual([]);

    expect(logger.warn).toHaveBeenCalledOnce();
    const warning = logger.warn.mock.calls[0][0];
    expect(warning).toContain("history.pageBefore cursor miss");
    expect(warning).toContain("cursorKind=window-relative-synthetic");
    expect(warning).toContain("cause=window-relative-synthetic-id");
    expect(warning).not.toContain(cursor);
    expect(warning).not.toContain(SESSION_KEY);
    expect(warning).not.toContain("21");
  });

  it.each([
    ["negative", -1, "h--1-0"],
    ["fractional", 1.5, "h-1.5-0"],
    ["exponent", 1e21, "h-1e+21-0"],
  ])(
    "classifies an emitted %s-timestamp synthetic cursor miss",
    async (_case, timestamp, expectedCursor) => {
      const transcript = makeIdlessConversation(30).map((message, index) =>
        index === 20
          ? { ...(message as Record<string, unknown>), timestamp }
          : message,
      );
      const { api } = makeApi(transcript);
      const cursor = (await recent(api, SESSION_KEY, 10))[0].id;
      const logger = { warn: vi.fn() };

      expect(cursor).toBe(expectedCursor);
      expect(await pageBefore(api, SESSION_KEY, cursor, 2, logger)).toEqual([]);

      expect(logger.warn).toHaveBeenCalledOnce();
      const warning = logger.warn.mock.calls[0][0];
      expect(warning).toContain("cursorKind=window-relative-synthetic");
      expect(warning).toContain("cause=window-relative-synthetic-id");
      expect(warning).not.toContain(cursor);
      expect(warning).not.toContain(SESSION_KEY);
      expect(warning).not.toContain("21");
    },
  );

  it("classifies a final opaque cursor miss", async () => {
    const cursor = "ghost";
    const { api } = makeApi(FIXTURE);
    const logger = { warn: vi.fn() };

    expect(await pageBefore(api, SESSION_KEY, cursor, 600, logger)).toEqual([]);

    expect(logger.warn).toHaveBeenCalledOnce();
    const warning = logger.warn.mock.calls[0][0];
    expect(warning).toContain("cursorKind=opaque");
    expect(warning).toContain("cause=unknown");
    expect(warning).not.toContain(cursor);
    expect(warning).not.toContain(SESSION_KEY);
  });

  it("finds a cursor beyond the phase-1 window via the phase-2 1000-fetch", async () => {
    // 30-message conversation, limit=2 → phase-1 fetches the last 4
    // (m-27..m-30). Cursor m-10 is older than that window, so phase 2
    // re-fetches at limit 1000, finds m-10, and returns the 2 items strictly
    // older: [m-8, m-9].
    const { api, getSessionMessages } = makeApi(makeConversation(30));
    const out = await pageBefore(api, SESSION_KEY, "m-10", 2);
    expect(out.map((m) => m.id)).toEqual(["m-8", "m-9"]);
    expect(getSessionMessages).toHaveBeenCalledTimes(2);
    expect(getSessionMessages.mock.calls[0][0].limit).toBe(4);
    expect(getSessionMessages.mock.calls[1][0].limit).toBe(1000);
  });

  it("hits the store exactly once when a FULL page sits inside the phase-1 window", async () => {
    // 30 messages, limit=2 → phase-1 fetches the last 4 (m-27..m-30). Cursor
    // m-29 is at idx 2 (>= limit), so a full page of older messages is already
    // in the window — return [m-27, m-28] with no wasteful 1000-fetch.
    const { api, getSessionMessages } = makeApi(makeConversation(30));
    const out = await pageBefore(api, SESSION_KEY, "m-29", 2);
    expect(out.map((m) => m.id)).toEqual(["m-27", "m-28"]);
    expect(getSessionMessages).toHaveBeenCalledTimes(1);
    expect(getSessionMessages.mock.calls[0][0].limit).toBe(4);
  });

  it("widens to phase 2 when the cursor is found at the phase-1 window's LEFT edge", async () => {
    // Regression guard for the "~2 pages then stops" bug: the cursor is FOUND
    // in the small window but at its left edge (idx 0), so the older slice
    // would be truncated by the window boundary, not the store. 30 messages,
    // limit=2, cursor m-27 → phase-1 window = m-27..m-30 (idx 0). Must widen
    // and return the real older page [m-25, m-26], not [].
    const { api, getSessionMessages } = makeApi(makeConversation(30));
    const out = await pageBefore(api, SESSION_KEY, "m-27", 2);
    expect(out.map((m) => m.id)).toEqual(["m-25", "m-26"]);
    expect(getSessionMessages).toHaveBeenCalledTimes(2);
    expect(getSessionMessages.mock.calls[0][0].limit).toBe(4);
    expect(getSessionMessages.mock.calls[1][0].limit).toBe(1000);
  });

  it("clamps a large limit to the 1000 cap and never issues a phase-2 fetch", async () => {
    // limit=600 → limit*2=1200, clamped to MAX_FETCH_WINDOW=1000. Phase 1
    // already fetched the maximal window, so a cursor miss returns [] with no
    // second call.
    const { api, getSessionMessages } = makeApi(FIXTURE);
    const out = await pageBefore(api, SESSION_KEY, "ghost", 600);
    expect(out).toEqual([]);
    expect(getSessionMessages).toHaveBeenCalledTimes(1);
    expect(getSessionMessages.mock.calls[0][0].limit).toBe(1000);
  });

  it("serves a left-edge hit from the maximal phase-1 window without widening", async () => {
    // limit=600 → phase-1 fetch is already clamped to 1000 (the max window).
    // Cursor m-4 sits at idx 3 < limit, but there is no wider window to try, so
    // the (truncated) older slice IS the genuine answer: [m-1, m-2, m-3], one
    // call only.
    const { api, getSessionMessages } = makeApi(FIXTURE);
    const out = await pageBefore(api, SESSION_KEY, "m-4", 600);
    expect(out.map((m) => m.id)).toEqual(["m-1", "m-2", "m-3"]);
    expect(getSessionMessages).toHaveBeenCalledTimes(1);
    expect(getSessionMessages.mock.calls[0][0].limit).toBe(1000);
  });

  it("returns [] when the cursor is the very oldest message (start of conversation)", async () => {
    // limit=10 → phase-1 window = all of FIXTURE; cursor m-1 is found at idx 0.
    // idx < limit, so we cannot trust the small window and MUST widen first;
    // phase 2 also finds m-1 at idx 0 → nothing older → [] (confirmed wall).
    const { api, getSessionMessages } = makeApi(FIXTURE);
    const out = await pageBefore(api, SESSION_KEY, "m-1", 10);
    expect(out).toEqual([]);
    expect(getSessionMessages).toHaveBeenCalledTimes(2);
    expect(getSessionMessages.mock.calls[1][0].limit).toBe(1000);
  });

  it("returns [] when the cursor is the oldest message but sits OUTSIDE the phase-1 window", async () => {
    // limit=2 → phase-1 window = last 4 (m-2..m-5); cursor m-1 misses. Phase 2
    // finds m-1 at idx 0 → older slice empty → [] (genuine wall, not a silent
    // stop). Two calls confirm the widening ran.
    const { api, getSessionMessages } = makeApi(FIXTURE);
    const out = await pageBefore(api, SESSION_KEY, "m-1", 2);
    expect(out).toEqual([]);
    expect(getSessionMessages).toHaveBeenCalledTimes(2);
    expect(getSessionMessages.mock.calls[1][0].limit).toBe(1000);
  });

  it("scopes every call by sessionKey (no cross-peer leak) (AC4)", async () => {
    const { api, getSessionMessages } = makeApi(FIXTURE);
    await pageBefore(api, SESSION_KEY, "m-4", 10);
    const lastCall = getSessionMessages.mock.calls.at(-1)![0];
    expect(lastCall.sessionKey).toBe(SESSION_KEY);
  });

  it("returns [] for a missing cursor / non-positive limit (defensive)", async () => {
    const { api } = makeApi(FIXTURE);
    expect(await pageBefore(api, SESSION_KEY, "", 10)).toEqual([]);
    expect(await pageBefore(api, "", "m-4", 10)).toEqual([]);
    expect(await pageBefore(api, SESSION_KEY, "m-4", 0)).toEqual([]);
  });

  it("treats a throwing store as 'no history' (best-effort)", async () => {
    const { api } = makeApi(new Error("store unreachable"));
    const logger = { warn: vi.fn() };
    const out = await pageBefore(api, SESSION_KEY, "m-4", 10, logger);
    expect(out).toEqual([]);
    expect(logger.warn.mock.calls[0][0]).toMatch(/history\.pageBefore failed/);
  });

  it("catches a throw on the phase-2 fetch too (best-effort holds in both phases)", async () => {
    // Phase 1 succeeds but the ghost cursor is not in the small window; the
    // phase-2 1000-fetch then throws. Same warn + [] contract must apply.
    const getSessionMessages = vi.fn(async (params: { limit?: number }) => {
      if (params.limit === 1000) throw new Error("store unreachable mid-page");
      const limit = typeof params.limit === "number" ? params.limit : undefined;
      return { messages: typeof limit === "number" ? FIXTURE.slice(-limit) : FIXTURE };
    });
    const api = { runtime: { subagent: { getSessionMessages } } } as unknown as OpenClawPluginApi;
    const logger = { warn: vi.fn() };
    const out = await pageBefore(api, SESSION_KEY, "ghost", 2, logger);
    expect(out).toEqual([]);
    expect(getSessionMessages).toHaveBeenCalledTimes(2);
    expect(logger.warn.mock.calls[0][0]).toMatch(/history\.pageBefore failed/);
  });
});

describe("history — planHistoryFetch (load_history wire → fetch mapping)", () => {
  // Pins the decision the live NATS load-history handler makes
  // (index-nats.ts) — that path is a closure inside the channel setup and not
  // otherwise reachable by a unit test. Regression guard for the bug where the
  // whole request object was passed as `beforeId`.
  it("maps a `before` cursor to a page fetch carrying the STRING id", () => {
    expect(planHistoryFetch({ before: "m-9", limit: 25 }, 50)).toEqual({
      kind: "page",
      beforeId: "m-9",
      limit: 25,
    });
  });

  it("maps a request with no cursor to a recent (tail) fetch", () => {
    expect(planHistoryFetch({ limit: 25 }, 50)).toEqual({ kind: "recent", limit: 25 });
    expect(planHistoryFetch({}, 50)).toEqual({ kind: "recent", limit: 50 });
  });

  it("falls back to the page-size limit for NaN / non-finite / negative wire limits", () => {
    // `NaN <= 0` is false, so these must be rejected here or they slip past
    // pageBefore's own guard.
    expect(planHistoryFetch({ before: "m-1", limit: NaN }, 50)).toEqual({
      kind: "page",
      beforeId: "m-1",
      limit: 50,
    });
    expect(planHistoryFetch({ before: "m-1", limit: Infinity }, 50).limit).toBe(50);
    expect(planHistoryFetch({ before: "m-1", limit: -5 }, 50).limit).toBe(50);
    expect(planHistoryFetch({ before: "m-1", limit: 0 }, 50).limit).toBe(50);
    expect(planHistoryFetch({ limit: "25" as unknown as number }, 50).limit).toBe(50);
  });

  it("floors a fractional wire limit (integer-only contract)", () => {
    expect(planHistoryFetch({ before: "m-1", limit: 25.9 }, 50).limit).toBe(25);
  });
});

describe("history — read-time sanitization (live/history text parity)", () => {
  it("normalizes a raw assistant transcript (tool XML + placeholder) to clean text", async () => {
    const { api } = makeApi([
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text:
              '<tool_call>{"name":"get_roster","arguments":{}}</tool_call>\n' +
              "[tool calls omitted]\n답변 본문.",
          },
        ],
        timestamp: 1700000000000,
        __openclaw: { id: "m-1" },
      },
    ]);
    const out = await recent(api, SESSION_KEY, 10);
    expect(out).toEqual([
      { id: "m-1", role: "agent", text: "답변 본문.", ts: 1700000000000 },
    ]);
  });

  it("drops a NO_REPLY-only assistant message (not emitted)", async () => {
    const { api } = makeApi([
      { role: "user", content: [{ type: "text", text: "hi" }], __openclaw: { id: "u-1" } },
      { role: "assistant", content: [{ type: "text", text: "NO_REPLY" }], __openclaw: { id: "a-1" } },
      { role: "assistant", content: [{ type: "text", text: "real reply" }], __openclaw: { id: "a-2" } },
    ]);
    const out = await recent(api, SESSION_KEY, 10);
    expect(out.map((m) => m.id)).toEqual(["u-1", "a-2"]);
    expect(out.map((m) => m.text)).toEqual(["hi", "real reply"]);
  });

  it("strips injected metadata blocks + timestamp from a raw user message, keeping only the body", async () => {
    // The real inbound shape: sentinel LABEL lines + ```json fences prepended,
    // then a `[timestamp] body` line. Only the body should survive re-hydration.
    const rawUser =
      "Conversation info (untrusted metadata):\n```json\n{\n  \"is_group_chat\": true\n}\n```\n" +
      "Sender (untrusted metadata):\n```json\n{\n  \"label\": \"bob\"\n}\n```\n" +
      "\n[Mon 2026-07-06 20:04 GMT+9] 실제 사용자 질문입니다.";
    const { api } = makeApi([
      { role: "user", content: [{ type: "text", text: rawUser }], __openclaw: { id: "u-1" } },
    ]);
    const out = await recent(api, SESSION_KEY, 10);
    expect(out).toEqual([
      { id: "u-1", role: "user", text: "실제 사용자 질문입니다.", ts: expect.any(Number) },
    ]);
  });
});
