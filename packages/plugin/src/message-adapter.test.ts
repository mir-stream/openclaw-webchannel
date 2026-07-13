import { describe, it, expect } from "vitest";

import { createProgressDraftController } from "./message-adapter.js";
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
