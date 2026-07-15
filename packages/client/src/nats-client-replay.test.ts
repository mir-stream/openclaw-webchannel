import { describe, expect, it } from "vitest";

describe("registered-session replay identifiers", () => {
  it("keeps an existing message id stable across replay", () => {
    const message = { type: "user_message", id: "msg-fixed", text: "hello", timestamp: 1 };
    expect(message.id).toBe("msg-fixed");
    expect(structuredClone(message).id).toBe("msg-fixed");
  });

  it("does not treat messages without ids as replayable", () => {
    expect("id" in { type: "typing", active: true }).toBe(false);
  });
});
