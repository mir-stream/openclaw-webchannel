import { describe, it, expect } from "vitest";

import { createProgressDraftController, createReasoningDraftController } from "./message-adapter.js";
import type { WebChannelTransport } from "./transport.js";

/**
 * P1-8a — `ProgressDraftController.snapshotText()`.
 *
 * The aborted-turn defensive finalize (inbound.ts) reads this to settle the
 * bubble with the streamed content alone (no marker). It must:
 *  - return "" before anything has been pushed (no scaffold worth preserving),
 *  - return the streamed answer body after answer text is pushed,
 *  - return the "Working…" scaffold + tool lines after tool/item events,
 *  - be side-effect-free (calling it must not change what the draft later sends).
 */

function makeFakeTransport(): {
  transport: WebChannelTransport;
  progress: Array<{ id: string; text: string }>;
} {
  const progress: Array<{ id: string; text: string }> = [];
  const transport = {
    sendProgress: (_sessionKey: string, id: string, text: string) => {
      progress.push({ id, text });
      return true;
    },
    finalizeDraft: async () => {},
  } as unknown as WebChannelTransport;
  return { transport, progress };
}

describe("ProgressDraftController.snapshotText", () => {
  it("returns '' before anything is pushed", () => {
    const { transport } = makeFakeTransport();
    const draft = createProgressDraftController({
      transport,
      sessionKey: "peer-1",
      channelConfig: {},
    });
    expect(draft.snapshotText()).toBe("");
  });

  it("returns the streamed answer body after answer text is pushed", () => {
    const { transport } = makeFakeTransport();
    const draft = createProgressDraftController({
      transport,
      sessionKey: "peer-1",
      channelConfig: {},
    });
    draft.pushAnswerText("partial answer so far");
    expect(draft.snapshotText()).toBe("partial answer so far");
  });

  it("returns the working scaffold + tool lines after tool/item events", () => {
    const { transport } = makeFakeTransport();
    const draft = createProgressDraftController({
      transport,
      sessionKey: "peer-1",
      channelConfig: {},
    });
    draft.pushEvent({ event: "tool", itemId: "i1", name: "bash", phase: "start" });
    const snap = draft.snapshotText();
    expect(snap.length).toBeGreaterThan(0);
    // The scaffold is a "<label>…" header followed by the rendered tool line.
    expect(snap.endsWith("…")).toBe(false); // a tool line follows the header
    expect(snap).toContain("Bash");
  });

  it("is side-effect-free (does not mutate what the draft later sends)", async () => {
    const { transport } = makeFakeTransport();
    const draft = createProgressDraftController({
      transport,
      sessionKey: "peer-1",
      channelConfig: {},
    });
    draft.pushAnswerText("hello world");
    const first = draft.snapshotText();
    const second = draft.snapshotText();
    expect(second).toBe(first);
    await draft.finalize("hello world final");
    // The snapshot reads never altered the finalized text.
    expect(first).toBe("hello world");
  });
});

describe("ReasoningDraftController", () => {
  function setup() {
    const frames: Array<{ id: string; turnId: string; text: string }> = [];
    const transport = {
      sendReasoning: (_peer: string, id: string, turnId: string, text: string) => {
        frames.push({ id, turnId, text });
        return true;
      },
    } as unknown as WebChannelTransport;
    const controller = createReasoningDraftController({
      transport,
      sessionKey: "peer-1",
      turnId: "turn-1",
    });
    return { controller, frames };
  }

  it("replaces cumulative full-text updates by id (verified pinned contract)", () => {
    // Every pinned emitter sends the cumulative FULL text so far (ACP snapshot /
    // btw `reasoningText += delta`), never a bare delta — so each frame is a
    // wholesale replace on one id.
    const { controller, frames } = setup();
    controller.push({ text: "Think" });
    controller.push({ text: "Thinking" });
    controller.push({ text: "Thinking more" });
    expect(frames.map((frame) => frame.text)).toEqual(["Think", "Thinking", "Thinking more"]);
    expect(new Set(frames.map((frame) => frame.id)).size).toBe(1);
    expect(frames.every((frame) => frame.turnId === "turn-1")).toBe(true);
  });

  it("replaces snapshot updates and suppresses exact duplicates", () => {
    const { controller, frames } = setup();
    controller.push({ text: "one" });
    controller.push({ text: "replacement", isReasoningSnapshot: true });
    controller.push({ text: "replacement", isReasoningSnapshot: true });
    expect(frames.map((frame) => frame.text)).toEqual(["one", "replacement"]);
  });

  it("ignores empty / non-string text", () => {
    const { controller, frames } = setup();
    controller.push({ text: "" });
    controller.push({});
    controller.push({ text: undefined });
    controller.push({ text: "real" });
    expect(frames.map((frame) => frame.text)).toEqual(["real"]);
  });

  it("rotates ids at a reasoning-end boundary and ignores late updates after stop", () => {
    const { controller, frames } = setup();
    controller.push({ text: "first" });
    controller.endBurst();
    controller.push({ text: "second" });
    controller.stop();
    controller.push({ text: "late" });
    expect(frames).toHaveLength(2);
    expect(frames[0].id).not.toBe(frames[1].id);
  });
});
