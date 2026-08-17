import { describe, expect, it } from "vitest";
import { orderConversationPresentation, composerInFlight } from "./presentation.js";

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

describe("orderConversationPresentation", () => {
  it("keeps two turns' reasoning between each user and answer", () => {
    const ordered = orderConversationPresentation(
      [
        { id: "u1", role: "user", text: "one", turnId: "t1" },
        { id: "a1", role: "agent", text: "answer one", turnId: "t1" },
        { id: "u2", role: "user", text: "two", turnId: "t2" },
        { id: "a2", role: "agent", text: "answer two", turnId: "t2" },
      ],
      [
        { id: "r1", turnId: "t1", text: "reason one" },
        { id: "r2", turnId: "t2", text: "reason two" },
      ],
    );
    expect(ordered.map((item) => item.value.id)).toEqual(["u1", "r1", "a1", "u2", "r2", "a2"]);
  });

  it("places a multi-device orphan before its correlated answer, or at the live tail", () => {
    expect(orderConversationPresentation(
      [{ id: "a", role: "agent", text: "answer", turnId: "remote" }],
      [{ id: "r", turnId: "remote", text: "reason" }],
    ).map((item) => item.value.id)).toEqual(["r", "a"]);

    expect(orderConversationPresentation(
      [{ id: "old", role: "agent", text: "old" }],
      [{ id: "r", turnId: "live", text: "reason" }],
    ).map((item) => item.value.id)).toEqual(["old", "r"]);
  });
});
