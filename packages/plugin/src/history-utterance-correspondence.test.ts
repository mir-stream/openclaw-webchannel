import { describe, expect, it, vi } from "vitest";

import { recent } from "./history.js";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-core";

/**
 * WP A characterization (#95): how the current normalizer projects
 * contract-compatible stored message shapes. These tests do not prove that every
 * core execution produces these shapes or that a projected row always
 * corresponds to one live utterance.
 *
 * SOURCES, classified per the convention in
 * `docs/ISSUE_93_APPROVAL_ORIGIN_ROUTING_PLAN.md` §2:
 *
 * A. CONTRACT — `openclaw/plugin-sdk/llm` exports the transcript message shapes
 *    these fixtures are built from: `UserMessage`, `AssistantMessage`,
 *    `ToolResultMessage`, `TextContent`, `ToolCall`, `ThinkingContent`, `Usage`,
 *    `StopReason`. Notably `AssistantMessage.content` is a LIST of content blocks
 *    and `stopReason` is a declared field — both load-bearing below.
 *
 * B. OUR CODE — `handleInboundMessage` wires `onPartialReply` into a progress
 *    draft and `deliverDraftFinalPayload` completes that draft through
 *    `draft.finalize`. `history.ts` owns text extraction, role filtering, and id
 *    recovery. These symbol names, rather than line numbers, are the stable
 *    references for the behavior exercised below.
 *
 * C. STATIC CORE OBSERVATIONS — not contract, not a design premise, recorded HERE
 *    rather than cited to an internal bundle path (those are hash-named and change
 *    every build):
 *      1. The agent loop appends one assistant message PER MODEL STEP, not one per
 *         user-visible turn. A turn with N tool rounds writes N+1 assistant
 *         messages, each with its own transcript entry.
 *      2. Mid-turn assistant steps commonly carry a short status text in the same
 *         `content` list as their `toolCall` block.
 *      3. `stopReason:"error"` belongs to one assistant attempt/message, not a
 *         durable verdict for the whole user turn. Retry/fallback can append a
 *         later successful assistant message.
 *      4. The read path attaches an untyped `__openclaw` envelope carrying at
 *         least `id`; nothing in `openclaw/plugin-sdk/*` declares its shape.
 *      5. The exact client-generated live `turnId` is not present on the stored
 *         messages returned to this projection. User boundaries and raw tool
 *         structure can nevertheless provide structural grouping evidence.
 *
 * C1-C3 are static observations of the pinned implementation; the tests below
 * cover only the projection of the explicit fixtures they construct.
 *
 * These tests assert the current normalizer's behavior for their explicit input
 * shapes. They are characterization, not an exhaustive core execution test.
 */

/**
 * Build a minimal OpenClawPluginApi stub whose `runtime.subagent.getSessionMessages`
 * is the only call history.ts makes. Mirrors the harness in `history.test.ts`.
 */
function makeApi(messages: unknown[]): OpenClawPluginApi {
  const getSessionMessages = vi.fn(async (params: { limit?: number }) => {
    const limit = typeof params.limit === "number" && params.limit > 0 ? params.limit : undefined;
    return { messages: typeof limit === "number" ? messages.slice(-limit) : messages };
  });
  return { runtime: { subagent: { getSessionMessages } } } as unknown as OpenClawPluginApi;
}

/** Zero usage block, shaped as the contract's `Usage` (`openclaw/plugin-sdk/llm`). */
const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/**
 * One transcript record as the session-messages read hands it to the plugin: the
 * stored message plus the untyped `__openclaw` envelope (source C4). We synthesize
 * the envelope because no contract type declares it — that undeclared shape is
 * itself one of the findings, and `extractId` is the only consumer here.
 */
function record(seq: number, message: Record<string, unknown>): Record<string, unknown> {
  return {
    ...message,
    __openclaw: { id: `entry-${seq}`, seq, recordTimestampMs: 1_760_000_000_000 + seq * 1000 },
  };
}

function userMsg(seq: number, text: string): Record<string, unknown> {
  return record(seq, {
    role: "user",
    content: [{ type: "text", text }],
    timestamp: 1_760_000_000_000 + seq * 1000,
  });
}

/** Assistant message shaped as the contract's `AssistantMessage`. */
function assistantMsg(
  seq: number,
  content: Array<Record<string, unknown>>,
  stopReason: "stop" | "toolUse" | "error" = "stop",
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return record(seq, {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: "openai",
    model: "gpt-test",
    usage: ZERO_USAGE,
    stopReason,
    timestamp: 1_760_000_000_000 + seq * 1000,
    ...extra,
  });
}

/** Tool result shaped as the contract's `ToolResultMessage`. */
function toolResultMsg(seq: number, toolCallId: string, text: string): Record<string, unknown> {
  return record(seq, {
    role: "toolResult",
    toolCallId,
    toolName: "agents_list",
    content: [{ type: "text", text }],
    isError: false,
    timestamp: 1_760_000_000_000 + seq * 1000,
  });
}

/** Shaped as the contract's `ToolCall` content block. */
const TOOL_CALL = {
  type: "toolCall",
  id: "call-1",
  name: "agents_list",
  arguments: {},
};

describe("#95 WP A — history projection of assistant steps", () => {
  /**
   * One contract-compatible multi-step fixture. The live path can overwrite a
   * progress draft with the final answer, while this projection emits both
   * assistant messages when both contain visible text.
   */
  it("projects both visible assistant messages from a multi-step fixture", async () => {
    const out = await recent(
      makeApi([
        userMsg(1, "which agents are configured?"),
        // Model step 1: status text alongside the tool call (source C2).
        assistantMsg(2, [{ type: "text", text: "Let me check that." }, TOOL_CALL], "toolUse"),
        toolResultMsg(3, "call-1", "alpha, beta, gamma"),
        // Model step 2: the actual answer.
        assistantMsg(4, [{ type: "text", text: "You have three agents: alpha, beta, gamma." }]),
      ]),
      "session-key",
      50,
    );

    const agentRows = out.filter((m) => m.role === "agent");
    expect(agentRows.map((m) => m.text)).toEqual([
      "Let me check that.",
      "You have three agents: alpha, beta, gamma.",
    ]);
    // This is a normalizer characterization, not an exhaustive statement about
    // the shapes produced by every core execution.
    expect(agentRows).toHaveLength(2);
  });

  /** A toolCall-only assistant step extracts to "" and produces no projected row. */
  it("drops a toolCall-only assistant step from the projection", async () => {
    const out = await recent(
      makeApi([
        userMsg(1, "which agents are configured?"),
        assistantMsg(2, [TOOL_CALL], "toolUse"),
        toolResultMsg(3, "call-1", "alpha, beta, gamma"),
        assistantMsg(4, [{ type: "text", text: "Three: alpha, beta, gamma." }]),
      ]),
      "session-key",
      50,
    );

    expect(out.filter((m) => m.role === "agent").map((m) => m.text)).toEqual([
      "Three: alpha, beta, gamma.",
    ]);
  });

  /**
   * `ThinkingContent` carries `.thinking`, not `.text`, so `extractText` never
   * lifts it. Reasoning in this explicit shape does not enter a hydrated bubble.
   */
  it("a thinking-only assistant step is dropped (no row)", async () => {
    const out = await recent(
      makeApi([
        userMsg(1, "hello"),
        assistantMsg(2, [{ type: "thinking", thinking: "the user said hello" }], "toolUse"),
        assistantMsg(3, [{ type: "text", text: "Hi!" }]),
      ]),
      "session-key",
      50,
    );

    expect(out.filter((m) => m.role === "agent").map((m) => m.text)).toEqual(["Hi!"]);
  });

  /** `toolResult` is not a user/agent role, so it never reaches the timeline. */
  it("toolResult rows never appear in history", async () => {
    const out = await recent(
      makeApi([
        userMsg(1, "go"),
        assistantMsg(2, [TOOL_CALL], "toolUse"),
        toolResultMsg(3, "call-1", "SECRET TOOL OUTPUT"),
        assistantMsg(4, [{ type: "text", text: "done" }]),
      ]),
      "session-key",
      50,
    );

    expect(out.every((m) => m.role === "user" || m.role === "agent")).toBe(true);
    expect(out.some((m) => m.text.includes("SECRET TOOL OUTPUT"))).toBe(false);
  });

  /**
   * The current projection preserves the relative order of rows it emits. WP B's
   * hydration tests consume that projected row sequence as their input contract.
   */
  it("preserves relative order of the rows it does emit", async () => {
    const out = await recent(
      makeApi([
        userMsg(1, "first question"),
        assistantMsg(2, [{ type: "text", text: "Checking." }, TOOL_CALL], "toolUse"),
        toolResultMsg(3, "call-1", "data"),
        assistantMsg(4, [{ type: "text", text: "First answer." }]),
        userMsg(5, "second question"),
        assistantMsg(6, [{ type: "text", text: "Second answer." }]),
      ]),
      "session-key",
      50,
    );

    expect(out.map((m) => `${m.role}:${m.text}`)).toEqual([
      "user:first question",
      "agent:Checking.",
      "agent:First answer.",
      "user:second question",
      "agent:Second answer.",
    ]);
  });
});

describe("#95 WP A — no terminal-turn failure signal", () => {
  /** An error attempt may be followed by a successful retry/fallback. */
  it("does not expose an error attempt followed by success as a terminal failure verdict", async () => {
    const out = await recent(
      makeApi([
        userMsg(1, "do the thing"),
        assistantMsg(2, [{ type: "text", text: "temporary upstream failure" }], "error", {
          errorMessage: "upstream 503",
          errorCode: "UNAVAILABLE",
        }),
        assistantMsg(3, [{ type: "text", text: "done" }], "stop"),
      ]),
      "session-key",
      50,
    );

    expect(out.map((m) => `${m.role}:${m.text}`)).toEqual([
      "user:do the thing",
      "agent:temporary upstream failure",
      "agent:done",
    ]);
    expect(out.map((m) => Object.keys(m).sort())).toEqual([
      ["id", "role", "text", "ts"],
      ["id", "role", "text", "ts"],
      ["id", "role", "text", "ts"],
    ]);
  });

  /**
   * Attempts without surviving display text produce no history row. Their
   * `stopReason` therefore cannot be promoted into a durable turn verdict.
   */
  it("drops textless and sanitized-away error attempts without inventing a failure signal", async () => {
    const out = await recent(
      makeApi([
        userMsg(1, "do the thing"),
        assistantMsg(2, [], "error"),
        assistantMsg(3, [TOOL_CALL], "error"),
        assistantMsg(4, [{ type: "thinking", thinking: "partial reasoning" }], "error"),
        assistantMsg(5, [{ type: "text", text: "NO_REPLY" }], "error"),
        assistantMsg(6, [{ type: "text", text: "done" }], "stop"),
      ]),
      "session-key",
      50,
    );

    expect(out.map((m) => `${m.role}:${m.text}`)).toEqual([
      "user:do the thing",
      "agent:done",
    ]);
    expect(out.map((m) => Object.keys(m).sort())).toEqual([
      ["id", "role", "text", "ts"],
      ["id", "role", "text", "ts"],
    ]);
  });
});

describe("#95 WP A — transcript metadata the plugin does not read", () => {
  /**
   * The `__openclaw` envelope is undeclared by any contract type (source C4). The
   * plugin reads only `.id` from it (`extractId`). `seq` is deliberately ignored:
   * adopting another field from the same private envelope would only rename the
   * contract defect. #128 keeps `.id` as the observed best-effort value while
   * making envelope drift and synthetic-cursor misses explicit diagnostics.
   */
  it("reads only __openclaw.id, ignoring the rest of the envelope", async () => {
    const out = await recent(makeApi([userMsg(7, "hi")]), "session-key", 50);

    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("entry-7");
    expect("seq" in out[0]).toBe(false);
    expect("recordTimestampMs" in out[0]).toBe(false);
  });

  /**
   * The projection does not synthesize the exact client-generated live turnId.
   * It does preserve normalized user rows, so a real second user boundary remains
   * observable and the two transcript shapes below are not equivalent.
   */
  it("omits exact live turnId while preserving user-boundary grouping evidence", async () => {
    const sameTurn = await recent(
      makeApi([
        userMsg(1, "one question"),
        assistantMsg(2, [{ type: "text", text: "Checking." }, TOOL_CALL], "toolUse"),
        toolResultMsg(3, "call-1", "data"),
        assistantMsg(4, [{ type: "text", text: "Answer." }]),
      ]),
      "session-key",
      50,
    );
    const differentTurns = await recent(
      makeApi([
        userMsg(1, "one question"),
        assistantMsg(2, [{ type: "text", text: "Checking." }]),
        userMsg(3, "another question"),
        assistantMsg(4, [{ type: "text", text: "Answer." }]),
      ]),
      "session-key",
      50,
    );

    expect(sameTurn.map((m) => `${m.role}:${m.text}`)).toEqual([
      "user:one question",
      "agent:Checking.",
      "agent:Answer.",
    ]);
    expect(differentTurns.map((m) => `${m.role}:${m.text}`)).toEqual([
      "user:one question",
      "agent:Checking.",
      "user:another question",
      "agent:Answer.",
    ]);
    expect(sameTurn).not.toEqual(differentTurns);
    expect([...sameTurn, ...differentTurns].every((m) => !("turnId" in m))).toBe(true);
  });
});
