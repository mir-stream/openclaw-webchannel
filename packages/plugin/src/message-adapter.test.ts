import { describe, it, expect, vi } from "vitest";

import { createClawMessageAdapter, createProgressDraftController, createReasoningDraftController } from "./message-adapter.js";
import { NullPeerChannel } from "./channel-contract.js";
import type { WebChannelPeerChannel } from "./channel-contract.js";

describe("durable-delivery capability contract", () => {
  // P0-4 (review R5): the outbound seams THROW on failure, and that is only safe
  // because core refuses to blind-replay an entry stamped `send_attempt_started`
  // unless the adapter declares `reconcileUnknownSend`. Declaring it would silently
  // re-open core's replay path for a send that may already have been delivered —
  // duplicate delivery to the user, with nothing else in the tree to catch it (the
  // peer range `openclaw >= 2026.6.10` is open-ended). This is the gate.
  it("does not declare reconcileUnknownSend (would re-open core's blind-replay path)", () => {
    const adapter = createClawMessageAdapter(new NullPeerChannel()) as unknown as {
      durableFinal?: { capabilities?: Record<string, unknown> };
    };
    expect(adapter.durableFinal?.capabilities?.reconcileUnknownSend).not.toBe(true);
  });
});

describe("targeted outbound delivery", () => {
  class RecordingChannel extends NullPeerChannel {
    readonly sent: string[] = [];
    constructor(private readonly live: Set<string>) { super(); }
    override sendText(peerId: string): boolean {
      if (!this.live.has(peerId)) return false;
      this.sent.push(peerId);
      return true;
    }
  }

  const send = async (channel: RecordingChannel, to?: string) => {
    const adapter = createClawMessageAdapter(channel) as any;
    return adapter.send.text({ to, text: "hello" });
  };

  it("delivers to a valid explicit target", async () => {
    const channel = new RecordingChannel(new Set(["peer-a"]));
    await send(channel, "peer-a");
    expect(channel.sent).toEqual(["peer-a"]);
  });

  it("throws a cause-specific error when the target is absent", async () => {
    const channel = new RecordingChannel(new Set(["peer-a"]));
    await expect(send(channel)).rejects.toThrow("ctx.to is absent");
    expect(channel.sent).toEqual([]);
  });

  it("throws a distinct error when a targeted send returns false", async () => {
    const channel = new RecordingChannel(new Set());
    await expect(send(channel, "peer-gone")).rejects.toThrow(
      "targeted send returned false for peer peer-gone",
    );
    expect(channel.sent).toEqual([]);
  });

  it("does not leak an unresolved target to another account channel", async () => {
    const accountA = new RecordingChannel(new Set(["peer-a"]));
    const accountB = new RecordingChannel(new Set(["peer-b"]));
    await expect(send(accountA, "peer-b")).rejects.toThrow("targeted send returned false");
    expect(accountA.sent).toEqual([]);
    expect(accountB.sent).toEqual([]);
  });
});

describe("ProgressDraftController.finalize result contract", () => {
  it("caches the first true result across simultaneous and later calls", async () => {
    const finalizeDraft = vi.fn((_peer: string, _id: string, _text: string) => true);
    const transport = { finalizeDraft } as unknown as WebChannelPeerChannel;
    const draft = createProgressDraftController({ transport, sessionKey: "p", channelConfig: {} });
    await expect(Promise.all([draft.finalize("one"), draft.finalize("two")])).resolves.toEqual([true, true]);
    await expect(draft.finalize("three")).resolves.toBe(true);
    expect(finalizeDraft).toHaveBeenCalledTimes(1);
    expect(finalizeDraft.mock.calls[0]?.[2]).toBe("one");
  });

  it("caches false without retrying", async () => {
    const finalizeDraft = vi.fn((_peer: string, _id: string, _text: string) => false);
    const transport = { finalizeDraft } as unknown as WebChannelPeerChannel;
    const draft = createProgressDraftController({ transport, sessionKey: "p", channelConfig: {} });
    await expect(draft.finalize("one")).resolves.toBe(false);
    await expect(draft.finalize("two")).resolves.toBe(false);
    expect(finalizeDraft).toHaveBeenCalledTimes(1);
  });

  // P0-4 (review R2): with no pending draft content the finalize body runs to
  // `finalizeDraft` with no preceding await, so the idempotency latch must be
  // armed BEFORE it — a re-entrant call from inside finalizeDraft must not
  // trigger a second terminal frame.
  it("latches synchronously: a re-entrant finalize from inside finalizeDraft does not double-send", async () => {
    let draft!: ReturnType<typeof createProgressDraftController>;
    let reentrant: Promise<boolean> | undefined;
    const finalizeDraft = vi.fn((_peer: string, _id: string, _text: string) => {
      reentrant ??= draft.finalize("re-entrant");
      return true;
    });
    const transport = { finalizeDraft } as unknown as WebChannelPeerChannel;
    draft = createProgressDraftController({ transport, sessionKey: "p", channelConfig: {} });
    await expect(draft.finalize("one")).resolves.toBe(true);
    await expect(reentrant).resolves.toBe(true); // same cached outcome
    expect(finalizeDraft).toHaveBeenCalledTimes(1);
    expect(finalizeDraft.mock.calls[0]?.[2]).toBe("one");
  });

  it("continues to finalize when a pending preview flush throws", async () => {
    const finalizeDraft = vi.fn((_peer: string, _id: string, _text: string) => true);
    const transport = {
      sendProgress: () => { throw new Error("closing socket"); },
      finalizeDraft,
    } as unknown as WebChannelPeerChannel;
    const draft = createProgressDraftController({ transport, sessionKey: "p", channelConfig: {}, throttleMs: 60_000 });
    draft.pushAnswerText("partial");
    await expect(draft.finalize("final")).resolves.toBe(true);
    expect(finalizeDraft).toHaveBeenCalledTimes(1);
  });
});

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
  transport: WebChannelPeerChannel;
  progress: Array<{ id: string; text: string }>;
} {
  const progress: Array<{ id: string; text: string }> = [];
  const transport = {
    sendProgress: (_sessionKey: string, id: string, text: string) => {
      progress.push({ id, text });
      return true;
    },
    finalizeDraft: async () => {},
  } as unknown as WebChannelPeerChannel;
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
    } as unknown as WebChannelPeerChannel;
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

describe("ReasoningDraftController — btw stale-burst defense", () => {
  function setup() {
    const frames: Array<{ id: string; turnId: string; text: string }> = [];
    const transport = {
      sendReasoning: (_peer: string, id: string, turnId: string, text: string) => {
        frames.push({ id, turnId, text });
        return true;
      },
    } as unknown as WebChannelPeerChannel;
    const controller = createReasoningDraftController({
      transport,
      sessionKey: "peer-1",
      turnId: "turn-1",
    });
    return { controller, frames };
  }

  it("strips a prior burst's stale prefix from a later btw burst (under the rotated id)", () => {
    // btw never resets its `reasoningText` accumulator at thinking_end, so burst 2's
    // cumulative payload still carries burst 1's full text as a raw prefix.
    const { controller, frames } = setup();
    controller.push({ text: "AAA" });
    controller.endBurst();
    controller.push({ text: "AAABBB" });
    controller.push({ text: "AAABBBCCC" });
    expect(frames.map((f) => f.text)).toEqual(["AAA", "BBB", "BBBCCC"]);
    // burst 1 has its own id; burst 2's two frames share the rotated id.
    expect(frames[1].id).not.toBe(frames[0].id);
    expect(frames[2].id).toBe(frames[1].id);
  });

  it("ignores a stale re-send of the exact prior-burst text after endBurst", () => {
    const { controller, frames } = setup();
    controller.push({ text: "AAA" });
    controller.endBurst();
    controller.push({ text: "AAA" });
    expect(frames.map((f) => f.text)).toEqual(["AAA"]);
  });

  it("trims inter-burst whitespace left in the stripped remainder", () => {
    const { controller, frames } = setup();
    controller.push({ text: "AAA" });
    controller.endBurst();
    controller.push({ text: "AAA\n\nBBB" });
    expect(frames.map((f) => f.text)).toEqual(["AAA", "BBB"]);
  });

  it("falls through to a plain replace when a later burst does not carry the stale prefix", () => {
    const { controller, frames } = setup();
    controller.push({ text: "AAA" });
    controller.endBurst();
    controller.push({ text: "XYZ" });
    expect(frames.map((f) => f.text)).toEqual(["AAA", "XYZ"]);
    expect(frames[1].id).not.toBe(frames[0].id);
  });

  it("accumulates the stale prefix across three bursts (burst 3 prefix = burst1+burst2)", () => {
    const { controller, frames } = setup();
    controller.push({ text: "AAA" });
    controller.endBurst();
    controller.push({ text: "AAABBB" });
    controller.endBurst();
    controller.push({ text: "AAABBBCCC" });
    expect(frames.map((f) => f.text)).toEqual(["AAA", "BBB", "CCC"]);
    // Each burst renders under its own rotated id.
    expect(new Set(frames.map((f) => f.id)).size).toBe(3);
  });

  it("handles three bursts with whitespace BETWEEN them in btw's raw accumulator", () => {
    // Thinking models emit "\n" / "\n\n" between blocks, so btw's raw cumulative
    // payload carries inter-burst whitespace. The stale prefix must be the raw
    // payload (not our trimmed display text), or burst 3's prefix match fails and
    // its lane shows the fully duplicated text.
    const { controller, frames } = setup();
    controller.push({ text: "AAA" });
    controller.endBurst();
    controller.push({ text: "AAA\nBBB" });
    controller.endBurst();
    controller.push({ text: "AAA\nBBB\nCCC" });
    expect(frames.map((f) => f.text)).toEqual(["AAA", "BBB", "CCC"]);
    expect(new Set(frames.map((f) => f.id)).size).toBe(3);
  });

  it("preserves the stale prefix through an all-stale burst (endBurst early-return)", () => {
    // A burst whose every payload strips to nothing sends no frame, so its
    // endBurst early-returns on empty currentText — the PRIOR burst's stale
    // prefix must survive so the NEXT real burst still strips correctly.
    const { controller, frames } = setup();
    controller.push({ text: "AAA" });
    controller.endBurst();
    controller.push({ text: "AAA" }); // stale re-send only — strips to empty
    controller.endBurst();
    controller.push({ text: "AAA\nCCC" });
    expect(frames.map((f) => f.text)).toEqual(["AAA", "CCC"]);
    expect(new Set(frames.map((f) => f.id)).size).toBe(2);
  });
});
