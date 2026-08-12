import { describe, expect, it, vi } from "vitest";

import { recent } from "./history.js";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-core";

/**
 * WP A characterization (#95): does the stored transcript yield exactly ONE
 * history row per assistant UTTERANCE?
 *
 * "Utterance" is the settled unit the client renders as one bubble. The #95 plan
 * treats the transcript as canonical for ORDER and BOUNDARY IDENTITY — explicitly
 * NOT for row-set equality. These tests are the evidence for that caveat: they
 * encode, in executable form, that a transcript row set is NOT the same size as
 * the utterance set for a multi-model-step turn.
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
 * B. OUR CODE — the live path a mid-turn status text actually takes:
 *    `inbound.ts:541-547` streams it into the progress draft via `onPartialReply`,
 *    and `inbound.ts:629-633` then OVERWRITES that same draft with the final
 *    answer (`draft.finalize(text)`). One bubble results. Text extraction is
 *    `history.ts:76-93`; role filtering `history.ts:95-100`; id recovery
 *    `history.ts:116-120`.
 *
 * C. OBSERVED CORE BEHAVIOUR — not contract, not a design premise, pinned HERE
 *    rather than cited to an internal bundle path (those are hash-named and change
 *    every build):
 *      1. The agent loop appends one assistant message PER MODEL STEP, not one per
 *         user-visible turn. A turn with N tool rounds writes N+1 assistant
 *         messages, each with its own transcript entry.
 *      2. Mid-turn assistant steps commonly carry a short status text in the same
 *         `content` list as their `toolCall` block.
 *      3. A turn that fails before producing content is persisted as a real
 *         assistant message with `stopReason:"error"`, carrying a fixed sentinel
 *         string as its text.
 *      4. The session-messages read path applies no display projection, so that
 *         sentinel reaches the plugin verbatim.
 *      5. The read path attaches an untyped `__openclaw` envelope carrying at
 *         least `id`; nothing in `openclaw/plugin-sdk/*` declares its shape.
 *      6. No field anywhere on a transcript message correlates two assistant
 *         messages to one agent turn.
 *
 * Together, C1 + C2 + the B path are why a single-tool-round turn renders as ONE
 * live bubble but produces TWO history rows.
 *
 * These tests assert the ACTUAL behaviour, whatever it is. They are
 * characterization, not aspiration: nothing here asserts the behaviour is correct.
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
 * stored message plus the untyped `__openclaw` envelope (source C5). We synthesize
 * the envelope because no contract type declares it — that undeclared shape is
 * itself one of the findings, and `history.ts:116-120` is the only consumer.
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

/**
 * The sentinel core persists for a turn that failed before producing content
 * (source C3). Declared here ONLY as test input — no production code matches it,
 * deliberately: it is an internal constant, and #95 does not take a dependency on
 * it. See the plan's "known presentation defect" section.
 */
const FAILURE_SENTINEL = "[assistant turn failed before producing content]";

describe("#95 WP A — transcript rows vs. assistant utterances", () => {
  /**
   * THE LOAD-BEARING CASE. One user turn, two model steps (one tool round).
   * Live this settles as ONE assistant bubble: the mid-turn status text streams
   * into the progress draft, which the final answer then overwrites (source B).
   * The transcript holds TWO assistant messages (source C1) and both become rows.
   */
  it("a single-tool-round turn yields TWO agent rows for ONE live utterance", async () => {
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
    // The finding, stated as an assertion: rows OUTNUMBER utterances. The live
    // path produced one settled bubble for this turn; the transcript produces
    // two rows, so a reload materializes the mid-turn status text as a permanent
    // second bubble.
    expect(agentRows).toHaveLength(2);
  });

  /**
   * The mid-turn status TEXT is what creates the extra row — NOT the toolCall
   * block. An assistant step whose content is toolCall-only extracts to "" and is
   * dropped, so correspondence is preserved in that shape. This is half of what
   * bounds the divergence to a single cause.
   */
  it("a toolCall-only assistant step is dropped (no row), so it cannot split a bubble", async () => {
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
   * `ThinkingContent` carries `.thinking`, not `.text`, so `history.ts:76-93`
   * never lifts it. Reasoning cannot leak into a hydrated bubble.
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
   * Ordering is preserved across a multi-step turn even as rows are dropped —
   * this is the half of "the transcript is canonical" that DOES hold, and it is
   * what WP B's hydration tests are entitled to rely on.
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

describe("#95 WP A — failed-turn persistence", () => {
  /**
   * A turn that failed before producing content persists as a real assistant
   * message whose text is core's sentinel, and the read path does not project it
   * to display wording (sources C3, C4). So the sentinel reaches the widget
   * verbatim.
   *
   * #95 deliberately does NOT fix this: both the sentinel and core's own
   * replacement wording are internal constants, and matching either would be a new
   * internal dependency for a cosmetic gain. Characterized here and named in the
   * plan as a known presentation defect.
   */
  it("surfaces core's raw failure sentinel verbatim (known defect, not fixed here)", async () => {
    const out = await recent(
      makeApi([
        userMsg(1, "do the thing"),
        assistantMsg(2, [{ type: "text", text: FAILURE_SENTINEL }], "error", {
          errorMessage: "upstream 503",
          errorCode: "UNAVAILABLE",
        }),
      ]),
      "session-key",
      50,
    );

    expect(out.filter((m) => m.role === "agent").map((m) => m.text)).toEqual([FAILURE_SENTINEL]);
  });

  /**
   * `stopReason` is a declared field of the contract's `AssistantMessage`, so it
   * is a safe basis for the additive `failed` field. It is discarded today — this
   * pins the CURRENT loss, and flips when `failed` lands.
   */
  it("currently discards stopReason and the error detail", async () => {
    const out = await recent(
      makeApi([
        assistantMsg(1, [{ type: "text", text: "boom" }], "error", {
          errorMessage: "upstream 503",
          errorCode: "UNAVAILABLE",
        }),
      ]),
      "session-key",
      50,
    );

    expect(out).toHaveLength(1);
    expect(Object.keys(out[0]).sort()).toEqual(["id", "role", "text", "ts"]);
  });
});

describe("#95 WP A — transcript metadata the plugin does not read", () => {
  /**
   * The `__openclaw` envelope is undeclared by any contract type (source C5). The
   * plugin reads only `.id` from it (`history.ts:116-120`). #95 does NOT start
   * reading more of it: `seq` was considered and DEFERRED, because retiring the
   * `h-{ts}-{idx}` synthesis would change row `id` VALUES and break tier-1 dedupe
   * and the `pageBefore` cursor — leaving a new dependency on an untyped envelope
   * for a field with no consumer. See the plan's deferred-work section.
   */
  it("reads only __openclaw.id, ignoring the rest of the envelope", async () => {
    const out = await recent(makeApi([userMsg(7, "hi")]), "session-key", 50);

    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("entry-7");
    expect("seq" in out[0]).toBe(false);
    expect("recordTimestampMs" in out[0]).toBe(false);
  });

  /**
   * No field on a transcript message correlates two assistant messages to one
   * agent turn (source C6). A test can only pin the CONSEQUENCE, and this is it:
   * two structurally DIFFERENT transcripts — one multi-step turn vs. two separate
   * turns — reduce to byte-identical agent rows.
   *
   * This is the evidence for answering (b) on `turnId`. The live `turnId` is the
   * client's own `user_message.id` (`inbound.ts:220-222`), which core never
   * stores, so there is no value to put in a hydrated `turnId` even if the field
   * existed.
   */
  it("gives a client no way to tell which rows shared one agent turn", async () => {
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
        assistantMsg(4, [{ type: "text", text: "Answer." }]),
      ]),
      "session-key",
      50,
    );

    expect(sameTurn.filter((m) => m.role === "agent")).toEqual(
      differentTurns.filter((m) => m.role === "agent"),
    );
  });
});
