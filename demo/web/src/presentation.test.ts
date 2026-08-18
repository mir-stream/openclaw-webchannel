import { describe, expect, it } from "vitest";
import {
  orderConversationPresentation,
  formatToolActivityLine,
} from "./presentation.js";

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

  it("#97 places tool activity after reasoning, before its turn's answer", () => {
    const ordered = orderConversationPresentation(
      [
        { id: "u1", role: "user", text: "one", turnId: "t1" },
        { id: "a1", role: "agent", text: "answer one", turnId: "t1" },
      ],
      [{ id: "r1", turnId: "t1", text: "reason one" }],
      [{ id: "tc1", turnId: "t1", name: "bash" }],
    );
    expect(ordered.map((item) => item.kind)).toEqual([
      "message",
      "reasoning",
      "tool_activity",
      "message",
    ]);
    expect(ordered.map((item) => item.value.id)).toEqual(["u1", "r1", "tc1", "a1"]);
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
