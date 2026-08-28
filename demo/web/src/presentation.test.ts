import { describe, expect, it } from "vitest";
import {
  activityHint,
  composerButtonMode,
  composerInFlight,
  formatToolActivityLine,
  orderConversationPresentation,
} from "./presentation.js";

describe("composerInFlight (#96 — Stop affordance survives between bubbles)", () => {
  it("is true while the agent is typing", () => {
    expect(composerInFlight({ isTyping: true, messages: [] })).toBe(true);
  });

  it("is true while a working draft is live", () => {
    expect(
      composerInFlight({ messages: [{ id: "a1", role: "agent", text: "…", working: true }] }),
    ).toBe(true);
  });

  it("stays true in the gap between bubbles — isTyping cleared, no working draft, turn still open", () => {
    // The exact #96 hole: first bubble has settled (working:false) and the
    // server-pushed typing was cleared, but the turn has not settled yet.
    expect(
      composerInFlight({
        isTyping: false,
        turnActive: true,
        messages: [{ id: "a1", role: "agent", text: "first answer", working: false }],
      }),
    ).toBe(true);
  });

  it("is false once the turn settles (turnActive false, nothing typing/working)", () => {
    expect(
      composerInFlight({
        isTyping: false,
        turnActive: false,
        messages: [{ id: "a1", role: "agent", text: "answer", working: false }],
      }),
    ).toBe(false);
  });

  it("is false for a fresh idle client (turnActive absent)", () => {
    expect(composerInFlight({ messages: [] })).toBe(false);
  });
});

describe("composerButtonMode (#96 — the label states what a click does)", () => {
  const settled = { id: "a1", role: "agent" as const, text: "answer", working: false };
  const gap = { isTyping: false, turnActive: true, messages: [settled] };
  const idle = { isTyping: false, turnActive: false, messages: [settled] };

  it("offers Stop in the between-bubble gap when the composer is empty", () => {
    expect(composerButtonMode(gap, "")).toBe("stop");
  });

  it("offers Send while a draft is in the composer, even mid-turn", () => {
    // The draft is unambiguous Send intent (Enter already sends it). If the
    // label said Stop here, a click would abort the turn AND strand the text —
    // and a user who did mean to abort would publish a message instead.
    expect(composerButtonMode(gap, "a follow-up")).toBe("send");
  });

  it("treats a whitespace-only draft as empty, matching submit()'s own check", () => {
    // Otherwise the button would offer a Send that no-ops.
    expect(composerButtonMode(gap, "   \n ")).toBe("stop");
  });

  it("offers Send once the turn has settled", () => {
    expect(composerButtonMode(idle, "")).toBe("send");
    expect(composerButtonMode(idle, "next question")).toBe("send");
  });

  it("takes in-flight from typing and working drafts too, not just turnActive", () => {
    const typing = { isTyping: true, messages: [settled] };
    const working = { messages: [{ id: "a2", role: "agent" as const, text: "…", working: true }] };
    expect(composerButtonMode(typing, "")).toBe("stop");
    expect(composerButtonMode(typing, "draft")).toBe("send");
    expect(composerButtonMode(working, "")).toBe("stop");
    expect(composerButtonMode(working, "draft")).toBe("send");
  });
});

describe("activityHint (#96 — the transcript-tail activity line)", () => {
  const user = { id: "u1", role: "user" as const, text: "go", turnId: "t1" };
  const answer = { id: "a1", role: "agent" as const, text: "first answer", turnId: "t1" };
  const reasoning = [{ id: "r1", turnId: "t1", text: "thinking" }];
  const gap = { isTyping: false, turnActive: true, messages: [user, answer] };

  it("says the agent is typing when nothing richer is on screen", () => {
    expect(
      activityHint({ isTyping: true, messages: [user], reasoning: [], approvals: [] }),
    ).toBe("agent is typing…");
  });

  it("yields the typing line to a reasoning lane for the latest user turn", () => {
    expect(
      activityHint({ isTyping: true, messages: [user], reasoning, approvals: [] }),
    ).toBeNull();
  });

  it("still shows the gap hint when the turn already produced reasoning", () => {
    // The Fix-1 regression: `state.reasoning` carries no liveness notion, so
    // gating the WHOLE hint on it would suppress "still working…" for the rest
    // of any turn that ever emitted one reasoning block — i.e. never render it
    // on a default (reasoning-on) deployment.
    //
    // ⚠️ This said "is a rolling buffer". `presentation.ts` dropped that phrase
    // in #242 half 2 and this test did not: `state.reasoning` is now DERIVED
    // from `state.messages` and UNCAPPED, and it also holds blocks replayed from
    // history. The argument is unaffected — it never depended on the buffer, and
    // an unbounded, history-bearing list makes it STRONGER.
    expect(activityHint({ ...gap, reasoning, approvals: [] })).toBe("still working…");
  });

  it("shows the gap hint when the turn produced no reasoning", () => {
    expect(activityHint({ ...gap, reasoning: [], approvals: [] })).toBe("still working…");
  });

  it("is silent while an unresolved approval card is actionable", () => {
    // The turn is blocked on the USER, not working — the card takes priority.
    expect(
      activityHint({ ...gap, reasoning, approvals: [{ resolvedDecision: undefined }] }),
    ).toBeNull();
  });

  it("resumes the gap hint once every approval is resolved", () => {
    expect(
      activityHint({ ...gap, reasoning, approvals: [{ resolvedDecision: "allow-once" }] }),
    ).toBe("still working…");
  });

  it("is silent when only SOME of the approvals are resolved", () => {
    // Any one unresolved card is actionable, so "every resolved" is the wrong
    // question — a resolved card ahead of it must not unmute the hint.
    expect(
      activityHint({
        ...gap,
        reasoning,
        approvals: [{ resolvedDecision: "deny" }, { resolvedDecision: undefined }],
      }),
    ).toBeNull();
  });

  it("is silent while a working draft renders its own in-progress bubble", () => {
    expect(
      activityHint({
        isTyping: false,
        turnActive: true,
        messages: [user, { id: "a2", role: "agent", text: "…", working: true, turnId: "t1" }],
        reasoning: [],
        approvals: [],
      }),
    ).toBeNull();
  });

  it("is silent once the turn settles", () => {
    expect(
      activityHint({ isTyping: false, turnActive: false, messages: [user, answer], reasoning: [], approvals: [] }),
    ).toBeNull();
  });

  it("P1-9: a pending or retracted user bubble never becomes the latest user turn", () => {
    // Both carry no turnId, so treating one as `latestUser` would drop the
    // reasoning gate and resurrect "agent is typing…" beside a live lane.
    for (const tail of [
      { id: "u2", role: "user" as const, text: "queued", pending: true },
      { id: "u2", role: "user" as const, text: "not sent", retracted: true },
    ]) {
      expect(
        activityHint({ isTyping: true, messages: [user, tail], reasoning, approvals: [] }),
      ).toBeNull();
    }
  });
});

describe("orderConversationPresentation", () => {
  /**
   * ⚠️ #242 half 2 CHANGED WHAT THIS FUNCTION IS FOR, and these cases were
   * rewritten rather than adapted. The old suite fed a SEPARATE reasoning array
   * and asserted that each burst was placed after its user anchor by `turnId` —
   * including a "multi-device orphan" case that placed a burst whose turn had no
   * local anchor at the live tail. All of that was the renderer holding a second
   * opinion about ordering. Reasoning is a durable message now: its position is
   * the array's, so the property to pin is that this function PRESERVES it.
   */
  it("emits reasoning exactly where the transcript holds it", () => {
    const ordered = orderConversationPresentation([
      { id: "u1", role: "user", text: "one", turnId: "t1" },
      { kind: "reasoning", id: "r1", turnId: "t1", text: "reason one" },
      { id: "a1", role: "agent", text: "answer one", turnId: "t1" },
      { id: "u2", role: "user", text: "two", turnId: "t2" },
      { kind: "reasoning", id: "r2", turnId: "t2", text: "reason two" },
      { id: "a2", role: "agent", text: "answer two", turnId: "t2" },
    ]);
    expect(ordered.map((item) => item.value.id)).toEqual(["u1", "r1", "a1", "u2", "r2", "a2"]);
    expect(ordered.map((item) => item.kind)).toEqual([
      "message",
      "reasoning",
      "message",
      "message",
      "reasoning",
      "message",
    ]);
  });

  it("does NOT re-anchor a block by turnId — the stream order wins", () => {
    // The case the deleted `turnId` grouping would have got WRONG: a block that
    // arrives AFTER its turn's answer belongs where the stream put it, and the
    // old implementation would have hoisted it back above `a1` by `turnId`.
    //
    // ⚠️ TWO THINGS THIS COMMENT USED TO CLAIM ARE CUT, BOTH FALSE. It attributed
    // the late arrival to "a burst closed by the turn teardown", which is the
    // dichotomy `journal-history.ts`'s conversion loop retracts — the closing
    // mechanism is not the variable, the interleaving is. And it called the
    // hoisted order "an order neither the live client nor a replay produces",
    // which is backwards for the GAP 2b case it was naming: there the hoisted
    // order IS the live one (`INTERLEAVED_TURN_LIVE_IDS` is `["r1", "A"]`).
    //
    // What this test actually pins is narrower and does not need either claim:
    // this function reads POSITION off the array and never re-derives it from
    // `turnId`. Which of live and replay is "right" when they disagree is GAP
    // 2b's question, not the renderer's.
    const ordered = orderConversationPresentation([
      { id: "u1", role: "user", text: "one", turnId: "t1" },
      { id: "a1", role: "agent", text: "answer one", turnId: "t1" },
      { kind: "reasoning", id: "r1", turnId: "t1", text: "reason one" },
    ]);
    expect(ordered.map((item) => item.value.id)).toEqual(["u1", "a1", "r1"]);
  });

  it("keeps two bursts of one turn distinct and in order", () => {
    const ordered = orderConversationPresentation([
      { kind: "reasoning", id: "r1", turnId: "t1", text: "first" },
      { kind: "reasoning", id: "r2", turnId: "t1", text: "second" },
      { id: "a1", role: "agent", text: "answer", turnId: "t1" },
    ]);
    expect(ordered.map((item) => item.value.id)).toEqual(["r1", "r2", "a1"]);
  });

  it("#97 still interleaves tool activity by turnId — it is still ephemeral", () => {
    const ordered = orderConversationPresentation(
      [
        { id: "u1", role: "user", text: "one", turnId: "t1" },
        { kind: "reasoning", id: "r1", turnId: "t1", text: "reason one" },
        { id: "a1", role: "agent", text: "answer one", turnId: "t1" },
      ],
      [{ id: "tc1", turnId: "t1", name: "bash" }],
    );
    // The tool chip anchors to the USER row (its turn's anchor), which now puts
    // it before the reasoning block rather than after it. That is the honest
    // consequence of the two lanes no longer being ordered by the same rule —
    // one has a position, the other has only a turn.
    expect(ordered.map((item) => item.kind)).toEqual([
      "message",
      "tool_activity",
      "reasoning",
      "message",
    ]);
    expect(ordered.map((item) => item.value.id)).toEqual(["u1", "tc1", "r1", "a1"]);
  });

  it("#97 places an orphan tool chip at the tail when its turn has no anchor", () => {
    expect(
      orderConversationPresentation(
        [{ id: "old", role: "agent", text: "old" }],
        [{ id: "tc1", turnId: "live", name: "bash" }],
      ).map((item) => item.value.id),
    ).toEqual(["old", "tc1"]);
  });
});

describe("formatToolActivityLine", () => {
  it("composes name, status, arg KEY names, and summary — never arg values", () => {
    const line = formatToolActivityLine({
      id: "tc1",
      turnId: "t1",
      name: "get_weather",
      status: "completed",
      argKeys: ["city", "days"],
      summary: "sunny",
    });
    expect(line).toBe("🔧 get_weather — completed (city, days) · sunny");
  });

  it("falls back to phase when status is absent and omits missing pieces", () => {
    expect(
      formatToolActivityLine({ id: "tc1", turnId: "t1", name: "bash", phase: "start" }),
    ).toBe("🔧 bash — start");
    expect(formatToolActivityLine({ id: "tc1", turnId: "t1" })).toBe("🔧 tool");
  });
});
