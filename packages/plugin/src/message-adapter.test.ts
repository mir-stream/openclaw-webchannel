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

type DraftAttempt = {
  type: "progress" | "final";
  id: string;
  text: string;
};

type DraftOutcome = boolean | "throw";

function makeDraftHarness(options?: {
  throttleMs?: number;
  decide?: (attempt: DraftAttempt, attemptIndex: number) => DraftOutcome;
  onAttempt?: (attempt: DraftAttempt, attemptIndex: number) => void;
  logger?: { warn?: (message: string) => void; info?: (message: string) => void };
}) {
  const attempts: DraftAttempt[] = [];
  const frames: DraftAttempt[] = [];
  const deliver = (attempt: DraftAttempt): boolean => {
    const attemptIndex = attempts.length;
    attempts.push(attempt);
    options?.onAttempt?.(attempt, attemptIndex);
    const outcome = options?.decide?.(attempt, attemptIndex) ?? true;
    if (outcome === "throw") throw new Error(`transport threw for ${attempt.text}`);
    if (outcome) frames.push(attempt);
    return outcome;
  };
  const transport = {
    sendProgress: (_peer: string, id: string, text: string) =>
      deliver({ type: "progress", id, text }),
    finalizeDraft: (_peer: string, id: string, text: string) =>
      deliver({ type: "final", id, text }),
  } as unknown as WebChannelPeerChannel;
  const draft = createProgressDraftController({
    transport,
    sessionKey: "peer-1",
    turnId: "turn-1",
    channelConfig: {},
    throttleMs: options?.throttleMs ?? 0,
    logger: options?.logger ?? { warn: () => {} },
  });
  return { draft, attempts, frames };
}

const toolStart = (itemId = "tool-1") => ({
  event: "tool" as const,
  itemId,
  name: "bash",
  phase: "start" as const,
});

function successfulIds(frames: DraftAttempt[]): string[] {
  return [...new Set(frames.map((frame) => frame.id))];
}

describe("ProgressDraftController — ordered assistant lanes", () => {
  it("M1: the first boundary is a no-op and A partial creates one lane", async () => {
    const h = makeDraftHarness();
    h.draft.handleAssistantMessageBoundary();
    expect(h.frames).toEqual([]);

    h.draft.pushAnswerText({ text: "A1" });
    await h.draft.flush();

    expect(h.frames).toHaveLength(1);
    expect(h.frames[0]).toMatchObject({ type: "progress", text: "A1" });
    expect(h.draft.snapshotText()).toBe("A1");
    expect(h.draft.started).toBe(true);
  });

  it("M1b: tool P plus an empty first lane converges to one B bubble", async () => {
    const h = makeDraftHarness();
    h.draft.handleAssistantMessageBoundary();
    h.draft.pushEvent(toolStart());
    const provisionalId = h.frames[0]!.id;

    h.draft.handleAssistantMessageBoundary();
    h.draft.pushAnswerText({ text: "B partial" });
    expect(h.frames).toHaveLength(1);

    await expect(h.draft.finalize("B final")).resolves.toBe(true);
    expect(h.frames.map((frame) => ({ type: frame.type, id: frame.id, text: frame.text }))).toEqual([
      { type: "progress", id: provisionalId, text: h.frames[0]!.text },
      { type: "final", id: provisionalId, text: "B final" },
    ]);
    expect(successfulIds(h.frames)).toEqual([provisionalId]);
  });

  it("M2: A settles at its boundary and B uses a different id", async () => {
    const h = makeDraftHarness();
    h.draft.handleAssistantMessageBoundary();
    h.draft.pushAnswerText({ text: "A partial" });
    const idA = h.frames[0]!.id;

    h.draft.handleAssistantMessageBoundary();
    h.draft.pushAnswerText({ text: "B partial" });
    const idB = h.frames.find((frame) => frame.text === "B partial")!.id;
    await h.draft.finalize("B final");

    expect(idB).not.toBe(idA);
    expect(h.frames).toEqual([
      { type: "progress", id: idA, text: "A partial" },
      { type: "final", id: idA, text: "A partial" },
      { type: "progress", id: idB, text: "B partial" },
      { type: "final", id: idB, text: "B final" },
    ]);
  });

  it("M3: A, B, and C retain generation order and three ids", async () => {
    const h = makeDraftHarness();
    h.draft.handleAssistantMessageBoundary();
    h.draft.pushAnswerText({ text: "A" });
    h.draft.handleAssistantMessageBoundary();
    h.draft.pushAnswerText({ text: "B" });
    h.draft.handleAssistantMessageBoundary();
    h.draft.pushAnswerText({ text: "C" });
    await h.draft.finalize("C final");

    expect(h.frames.map((frame) => frame.text)).toEqual(["A", "A", "B", "B", "C", "C final"]);
    expect(successfulIds(h.frames)).toHaveLength(3);
  });

  it("M4: replace:true rewrites only the current lane", async () => {
    const warn = vi.fn();
    const h = makeDraftHarness({ logger: { warn } });
    h.draft.handleAssistantMessageBoundary();
    h.draft.pushAnswerText({ text: "A original" });
    const id = h.frames[0]!.id;
    h.draft.pushAnswerText({ text: "rewritten", replace: true });
    await h.draft.finalize("rewritten final");

    expect(h.frames).toEqual([
      { type: "progress", id, text: "A original" },
      { type: "progress", id, text: "rewritten" },
      { type: "final", id, text: "rewritten final" },
    ]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("M5: repeated indexed and indexless callbacks are silent until actual delivery", async () => {
    // The callback input has index/notice metadata but no body; actual wire text
    // enters this controller through `deliverAuthorizedBlock` below.
    for (const assistantMessageIndex of [0, undefined]) {
      const h = makeDraftHarness();
      h.draft.handleAssistantMessageBoundary();
      h.draft.noteBlockReplyQueued({ assistantMessageIndex });
      h.draft.noteBlockReplyQueued({ assistantMessageIndex });
      expect(h.frames).toEqual([]);

      await h.draft.deliverAuthorizedBlock({ text: "actual-1" });
      await h.draft.deliverAuthorizedBlock({ text: "actual-2" });
      expect(h.frames.map((frame) => frame.text)).toEqual(["actual-1", "actual-2"]);
      expect(successfulIds(h.frames)).toHaveLength(2);
    }
  });

  it("M5: multiple unresolved indexless candidates retain the earliest barrier and diagnose ambiguity", async () => {
    const warn = vi.fn();
    const h = makeDraftHarness({ logger: { warn } });
    h.draft.handleAssistantMessageBoundary();
    h.draft.handleAssistantMessageBoundary();
    h.draft.handleAssistantMessageBoundary();
    h.draft.pushAnswerText({ text: "C" });
    h.draft.noteBlockReplyQueued({});

    expect(h.frames).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain("ambiguous indexless block reservation");
    await h.draft.drain();
    expect(h.frames.map((frame) => frame.text)).toEqual(["C"]);
  });

  it("M6: a callback-only lane produces no bubble after skip, cancel, or drain", async () => {
    for (const lifecycle of ["skip", "cancel", "drain"] as const) {
      const h = makeDraftHarness();
      h.draft.handleAssistantMessageBoundary();
      h.draft.noteBlockReplyQueued({ assistantMessageIndex: 0 });
      h.draft.handleAssistantMessageBoundary();
      if (lifecycle === "drain") {
        await h.draft.drain();
      } else {
        h.draft.noteDeliveryLifecycle(lifecycle, { assistantMessageIndex: 0 });
        await h.draft.drain();
      }
      expect(h.frames).toEqual([]);
    }
  });

  it("M6b: an indexed late A reservation orders fresh fallback before B", async () => {
    const h = makeDraftHarness();
    h.draft.handleAssistantMessageBoundary();
    h.draft.handleAssistantMessageBoundary();
    h.draft.pushAnswerText({ text: "B partial" });
    h.draft.noteBlockReplyQueued({ assistantMessageIndex: 0 });
    expect(h.frames).toEqual([]);

    await expect(h.draft.deliverAuthorizedBlock({ text: "postHookA" })).resolves.toBe(true);
    expect(h.frames.map((frame) => frame.text)).toEqual(["postHookA"]);
    h.draft.noteDeliveryLifecycle("settled", { assistantMessageIndex: 0 });
    expect(h.frames.map((frame) => frame.text)).toEqual(["postHookA", "B partial"]);

    await h.draft.finalize("B final");
    expect(successfulIds(h.frames)).toHaveLength(2);
  });

  it("M6c: an indexless late reservation holds B until terminal drain", async () => {
    const h = makeDraftHarness();
    h.draft.handleAssistantMessageBoundary();
    h.draft.handleAssistantMessageBoundary();
    h.draft.pushAnswerText({ text: "B partial" });
    h.draft.noteBlockReplyQueued({});

    await h.draft.deliverAuthorizedBlock({ text: "fallback-A" });
    h.draft.noteDeliveryLifecycle("settled", {});
    expect(h.frames.map((frame) => frame.text)).toEqual(["fallback-A"]);

    await h.draft.drain();
    expect(h.frames.map((frame) => frame.text)).toEqual(["fallback-A", "B partial"]);
    expect(h.frames[0]!.id).not.toBe(h.frames[1]!.id);
  });

  it("M6d: the controller publishes only the rewritten actual payload", async () => {
    // `noteBlockReplyQueued` has no body parameter. This controller fixture
    // therefore supplies post-hook text only through `deliverAuthorizedBlock`;
    // hook/media/TTS rewrite coverage belongs to inbound.
    const h = makeDraftHarness();
    h.draft.handleAssistantMessageBoundary();
    h.draft.noteBlockReplyQueued({ assistantMessageIndex: 0 });
    await h.draft.deliverAuthorizedBlock({ text: "postHookA + prepared media narration" });

    expect(h.attempts.map((attempt) => attempt.text)).toEqual([
      "postHookA + prepared media narration",
    ]);
  });

  it("M6e: zero, one, or many reservations never route an actual block into a lane", async () => {
    for (const reservationCount of [0, 1, 3]) {
      const h = makeDraftHarness();
      h.draft.handleAssistantMessageBoundary();
      h.draft.pushAnswerText({ text: "lane A" });
      const laneId = h.frames[0]!.id;
      for (let index = 0; index < reservationCount; index += 1) {
        h.draft.noteBlockReplyQueued({ assistantMessageIndex: 0 });
      }

      await h.draft.deliverAuthorizedBlock({ text: `actual block ${reservationCount}` });
      const block = h.frames.find((frame) => frame.text === `actual block ${reservationCount}`)!;
      expect(block.id).not.toBe(laneId);
      expect(h.draft.snapshotText()).toBe("lane A");

      h.draft.pushAnswerText({ text: "lane A later" });
      expect(h.frames.at(-1)).toEqual({ type: "progress", id: laneId, text: "lane A later" });
    }
  });

  it.each([
    ["status", { isStatusNotice: true }],
    ["fallback", { isFallbackNotice: true }],
    ["compaction", { isCompactionNotice: true }],
  ] as const)("M6f: a queued %s notice never becomes a predecessor barrier", (_name, flag) => {
    const h = makeDraftHarness();
    h.draft.handleAssistantMessageBoundary();
    h.draft.pushAnswerText({ text: "A" });
    h.draft.noteBlockReplyQueued({ assistantMessageIndex: 0, ...flag });
    h.draft.handleAssistantMessageBoundary();
    h.draft.pushAnswerText({ text: "B" });

    expect(h.frames.map((frame) => frame.text)).toEqual(["A", "A", "B"]);
    expect(successfulIds(h.frames)).toHaveLength(2);
  });

  it("M6g: actual notice flags and callback-to-actual rewrites stay independent", async () => {
    const actualNoticeFlags = [
      { isStatusNotice: true },
      { isFallbackNotice: true },
      { isCompactionNotice: true },
    ];
    for (const flag of actualNoticeFlags) {
      const h = makeDraftHarness();
      h.draft.handleAssistantMessageBoundary();
      h.draft.pushAnswerText({ text: "A" });
      const idA = h.frames[0]!.id;
      h.draft.noteBlockReplyQueued({ assistantMessageIndex: 0 });
      h.draft.handleAssistantMessageBoundary();
      h.draft.pushAnswerText({ text: "B" });
      await h.draft.deliverAuthorizedBlock({ text: "actual notice", ...flag });
      h.draft.noteDeliveryLifecycle("settled", { assistantMessageIndex: 0 });
      const idB = h.frames.find((frame) => frame.text === "B")!.id;
      const noticeId = h.frames.find((frame) => frame.text === "actual notice")!.id;
      expect(new Set([idA, idB, noticeId]).size).toBe(3);
      h.draft.pushAnswerText({ text: "B later" });
      expect(h.frames.at(-1)?.id).toBe(idB);
    }

    const rewritten = makeDraftHarness();
    rewritten.draft.handleAssistantMessageBoundary();
    rewritten.draft.pushAnswerText({ text: "lane" });
    const laneId = rewritten.frames[0]!.id;
    rewritten.draft.noteBlockReplyQueued({ isStatusNotice: true });
    await rewritten.draft.deliverAuthorizedBlock({ text: "rewritten non-notice" });
    expect(rewritten.frames.at(-1)?.id).not.toBe(laneId);
    rewritten.draft.pushAnswerText({ text: "lane later" });
    expect(rewritten.frames.at(-1)).toEqual({ type: "progress", id: laneId, text: "lane later" });
  });

  it("M6h: indexed lifecycle cleanup releases B; ambiguous cleanup waits for drain", async () => {
    for (const lifecycle of ["skip", "cancel"] as const) {
      const h = makeDraftHarness();
      h.draft.handleAssistantMessageBoundary();
      h.draft.handleAssistantMessageBoundary();
      h.draft.pushAnswerText({ text: "B" });
      h.draft.noteBlockReplyQueued({ assistantMessageIndex: 0 });
      h.draft.noteDeliveryLifecycle(lifecycle, { assistantMessageIndex: 0 });
      expect(h.frames.map((frame) => frame.text)).toEqual(["B"]);
    }

    const cleanupBeforeBoundary = makeDraftHarness();
    cleanupBeforeBoundary.draft.handleAssistantMessageBoundary();
    cleanupBeforeBoundary.draft.noteBlockReplyQueued({ assistantMessageIndex: 0 });
    cleanupBeforeBoundary.draft.noteDeliveryLifecycle("skip", {
      assistantMessageIndex: 0,
    });
    cleanupBeforeBoundary.draft.handleAssistantMessageBoundary();
    cleanupBeforeBoundary.draft.pushAnswerText({ text: "B after early cleanup" });
    expect(cleanupBeforeBoundary.frames.map((frame) => frame.text)).toEqual([
      "B after early cleanup",
    ]);

    const indexless = makeDraftHarness();
    indexless.draft.handleAssistantMessageBoundary();
    indexless.draft.handleAssistantMessageBoundary();
    indexless.draft.pushAnswerText({ text: "B" });
    indexless.draft.noteBlockReplyQueued({});
    indexless.draft.noteDeliveryLifecycle("cancel", {});
    expect(indexless.frames).toEqual([]);
    await indexless.draft.drain();
    expect(indexless.frames.map((frame) => frame.text)).toEqual(["B"]);

    const duplicate = makeDraftHarness();
    duplicate.draft.handleAssistantMessageBoundary();
    duplicate.draft.handleAssistantMessageBoundary();
    duplicate.draft.pushAnswerText({ text: "B" });
    duplicate.draft.noteBlockReplyQueued({ assistantMessageIndex: 0 });
    duplicate.draft.noteBlockReplyQueued({ assistantMessageIndex: 0 });
    duplicate.draft.noteDeliveryLifecycle("settled", { assistantMessageIndex: 0 });
    expect(duplicate.frames).toEqual([]);
    await duplicate.draft.drain();
    expect(duplicate.frames.map((frame) => frame.text)).toEqual(["B"]);
  });

  it("M6h/F3: lifecycle notice flags retire only a matching sole record", () => {
    const h = makeDraftHarness();
    h.draft.handleAssistantMessageBoundary();
    h.draft.pushAnswerText({ text: "A" });
    h.draft.noteBlockReplyQueued({ assistantMessageIndex: 0, isStatusNotice: true });
    h.draft.noteDeliveryLifecycle("skip", {
      assistantMessageIndex: 0,
      isStatusNotice: true,
    });
    h.draft.noteBlockReplyQueued({ assistantMessageIndex: 0 });
    h.draft.handleAssistantMessageBoundary();
    h.draft.pushAnswerText({ text: "B" });

    expect(h.frames.map((frame) => frame.text)).toEqual(["A", "A"]);
    h.draft.noteDeliveryLifecycle("cancel", { assistantMessageIndex: 0 });
    expect(h.frames.map((frame) => frame.text)).toEqual(["A", "A", "B"]);
  });

  it("M6h/F3: block and notice records at one index remain ambiguous as a union", async () => {
    const h = makeDraftHarness();
    h.draft.handleAssistantMessageBoundary();
    h.draft.pushAnswerText({ text: "A" });
    h.draft.noteBlockReplyQueued({ assistantMessageIndex: 0 });
    h.draft.noteBlockReplyQueued({ assistantMessageIndex: 0, isStatusNotice: true });
    h.draft.handleAssistantMessageBoundary();
    h.draft.pushAnswerText({ text: "B partial" });

    h.draft.noteDeliveryLifecycle("skip", {
      assistantMessageIndex: 0,
      isStatusNotice: true,
    });
    await h.draft.deliverAuthorizedBlock({ text: "F-A" });
    h.draft.noteDeliveryLifecycle("settled", { assistantMessageIndex: 0 });
    expect(h.frames.map((frame) => frame.text)).toEqual(["A", "A", "F-A"]);

    await h.draft.drain();
    expect(h.frames.map((frame) => frame.text)).toEqual(["A", "A", "F-A", "B partial"]);
  });

  it("M6h/F4: an indexed lifecycle opens an empty predecessor barrier", async () => {
    const h = makeDraftHarness();
    h.draft.handleAssistantMessageBoundary();
    h.draft.noteBlockReplyQueued({ assistantMessageIndex: 0 });
    h.draft.handleAssistantMessageBoundary();
    h.draft.pushAnswerText({ text: "B partial" });
    await h.draft.flush();
    expect(h.attempts).toEqual([]);

    h.draft.noteDeliveryLifecycle("settled", { assistantMessageIndex: 0 });
    await h.draft.flush();
    expect(h.attempts.map((attempt) => attempt.text)).toEqual(["B partial"]);
  });

  it("M6h/F4: an attached indexless epoch survives the first indexed retirement", async () => {
    const h = makeDraftHarness();
    h.draft.handleAssistantMessageBoundary();
    h.draft.noteBlockReplyQueued({ assistantMessageIndex: 0 });
    h.draft.handleAssistantMessageBoundary();
    h.draft.pushAnswerText({ text: "B partial" });
    h.draft.noteBlockReplyQueued({});

    await h.draft.deliverAuthorizedBlock({ text: "F-A1" });
    h.draft.noteDeliveryLifecycle("settled", { assistantMessageIndex: 0 });
    expect(h.frames.map((frame) => frame.text)).toEqual(["F-A1"]);

    await h.draft.deliverAuthorizedBlock({ text: "F-A2" });
    h.draft.noteDeliveryLifecycle("settled", {});
    expect(h.frames.map((frame) => frame.text)).toEqual(["F-A1", "F-A2"]);

    await h.draft.finalize("B final");
    expect(h.frames.map((frame) => frame.text)).toEqual(["F-A1", "F-A2", "B final"]);
  });

  it("M6h/F6: settled lifecycle consumes one recorded actual-block disposition", async () => {
    const h = makeDraftHarness();
    h.draft.handleAssistantMessageBoundary();
    h.draft.pushAnswerText({ text: "A" });
    h.draft.noteBlockReplyQueued({ assistantMessageIndex: 0 });
    h.draft.handleAssistantMessageBoundary();
    h.draft.pushAnswerText({ text: "B" });

    await h.draft.deliverAuthorizedBlock({ text: "actual-1" });
    h.draft.noteDeliveryLifecycle("settled", { assistantMessageIndex: 0 });
    expect(h.frames.map((frame) => frame.text)).toEqual(["A", "A", "actual-1", "B"]);

    h.draft.noteBlockReplyQueued({ assistantMessageIndex: 0 });
    h.draft.handleAssistantMessageBoundary();
    h.draft.pushAnswerText({ text: "C" });
    const beforeDuplicateSettled = [...h.frames];
    h.draft.noteDeliveryLifecycle("settled", { assistantMessageIndex: 0 });
    expect(h.frames).toEqual(beforeDuplicateSettled);

    await h.draft.drain();
    expect(h.frames.map((frame) => frame.text)).toEqual([
      "A",
      "A",
      "actual-1",
      "B",
      "B",
      "C",
    ]);
  });

  it("M6i: independent true commits P while false/throw roll back and keep the queue alive", async () => {
    for (const firstOutcome of [true, false, "throw"] as const) {
      const h = makeDraftHarness({
        decide: (attempt) => (attempt.text === "first actual" ? firstOutcome : true),
      });
      h.draft.pushEvent(toolStart());
      const provisionalId = h.frames[0]!.id;
      await expect(h.draft.deliverAuthorizedBlock({ text: "first actual" })).resolves.toBe(
        firstOutcome === true,
      );
      if (firstOutcome !== true) {
        h.draft.pushEvent(toolStart(`after-${String(firstOutcome)}`));
        expect(h.frames.at(-1)?.id).toBe(provisionalId);
        expect(h.frames.at(-1)?.type).toBe("progress");
      }
      await expect(h.draft.deliverAuthorizedBlock({ text: "next actual" })).resolves.toBe(true);

      const next = h.frames.find((frame) => frame.text === "next actual")!;
      if (firstOutcome === true) {
        expect(h.frames.find((frame) => frame.text === "first actual")!.id).toBe(provisionalId);
        expect(next.id).not.toBe(provisionalId);
      } else {
        expect(next.id).toBe(provisionalId);
      }
      h.draft.noteDeliveryLifecycle("settled", {});
    }
  });

  it("M7: unmarked divergence preserves A, rotates, and logs a contract violation", () => {
    const warn = vi.fn();
    const h = makeDraftHarness({ logger: { warn } });
    h.draft.handleAssistantMessageBoundary();
    h.draft.pushAnswerText({ text: "A body" });
    const idA = h.frames[0]!.id;
    h.draft.pushAnswerText({ text: "B body" });
    const idB = h.frames.at(-1)!.id;

    expect(idB).not.toBe(idA);
    expect(h.frames.map((frame) => frame.text)).toEqual(["A body", "A body", "B body"]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain("contract violation");
  });

  it("M8: a late structured boundary after defensive rotation does not rotate twice", async () => {
    const h = makeDraftHarness();
    h.draft.handleAssistantMessageBoundary();
    h.draft.pushAnswerText({ text: "A" });
    h.draft.pushAnswerText({ text: "B" });
    const idB = h.frames.at(-1)!.id;

    h.draft.handleAssistantMessageBoundary();
    h.draft.pushAnswerText({ text: "B later" });
    await h.draft.finalize("B final");

    expect(h.frames.at(-2)).toEqual({ type: "progress", id: idB, text: "B later" });
    expect(h.frames.at(-1)).toEqual({ type: "final", id: idB, text: "B final" });
    expect(successfulIds(h.frames)).toHaveLength(2);
  });

  it("M9: A settle failure leaves no rejected queue tail and B still settles", async () => {
    const h = makeDraftHarness({
      decide: (attempt) =>
        attempt.type === "final" && attempt.text === "A" ? false : true,
    });
    h.draft.handleAssistantMessageBoundary();
    h.draft.pushAnswerText({ text: "A" });
    const idA = h.frames[0]!.id;
    h.draft.handleAssistantMessageBoundary();
    h.draft.pushAnswerText({ text: "B" });
    const idB = h.frames.at(-1)!.id;
    await expect(h.draft.finalize("B final")).resolves.toBe(true);

    expect(h.attempts.filter((attempt) => attempt.text === "A")).toEqual([
      { type: "progress", id: idA, text: "A" },
      { type: "final", id: idA, text: "A" },
    ]);
    expect(h.frames.at(-1)).toEqual({ type: "final", id: idB, text: "B final" });
  });

  it("M10: a lane settle is re-entrantly latched while an independent final remains available", async () => {
    let draft!: ReturnType<typeof createProgressDraftController>;
    let reentrant: Promise<boolean> | undefined;
    const attempts: DraftAttempt[] = [];
    const transport = {
      finalizeDraft: (_peer: string, id: string, text: string) => {
        attempts.push({ type: "final", id, text });
        if (text === "ordinary") reentrant ??= draft.finalize("re-entrant");
        return text !== "cleanup";
      },
      sendProgress: () => true,
    } as unknown as WebChannelPeerChannel;
    draft = createProgressDraftController({
      transport,
      sessionKey: "peer-1",
      channelConfig: {},
      throttleMs: 0,
      logger: { warn: () => {} },
    });

    await expect(draft.finalize("ordinary")).resolves.toBe(true);
    await expect(reentrant).resolves.toBe(false);
    await expect(draft.finalize("cleanup")).resolves.toBe(false);
    await expect(draft.deliverIndependentFinal({ text: "extra" })).resolves.toBe(true);

    expect(attempts.map((attempt) => attempt.text)).toEqual(["ordinary", "cleanup", "extra"]);
    expect(new Set(attempts.map((attempt) => attempt.id)).size).toBe(3);
  });

  it("M10: a later final after a failed lane settle reports its own successful send", async () => {
    const h = makeDraftHarness({
      decide: (attempt) => attempt.text !== "ordinary failed",
    });

    await expect(h.draft.finalize("ordinary failed")).resolves.toBe(false);
    await expect(h.draft.finalize("timeout warning")).resolves.toBe(true);

    expect(h.attempts.map((attempt) => attempt.text)).toEqual([
      "ordinary failed",
      "timeout warning",
    ]);
    expect(h.attempts[0]!.id).not.toBe(h.attempts[1]!.id);
  });

  it("an ordinary terminal slot disarms the legacy started cleanup signal", async () => {
    const h = makeDraftHarness();
    h.draft.pushAnswerText({ text: "visible partial" });
    expect(h.draft.started).toBe(true);

    await expect(h.draft.finalize("ordinary final")).resolves.toBe(true);
    expect(h.draft.started).toBe(false);
  });
});

describe("ProgressDraftController — final reconciliation", () => {
  it("M11a: callback-free leading error finals are all independent of materialized A/B", async () => {
    const h = makeDraftHarness();
    h.draft.handleAssistantMessageBoundary();
    h.draft.pushEvent(toolStart());
    h.draft.pushAnswerText({ text: "lane A" });
    const idA = h.frames.at(-1)!.id;
    h.draft.handleAssistantMessageBoundary();
    h.draft.pushAnswerText({ text: "lane B" });
    const idB = h.frames.at(-1)!.id;

    h.draft.noteLeadingTerminalError();
    for (const text of ["terminal error", "A1", "A2", "B final replay"]) {
      await h.draft.deliverIndependentFinal({ text });
    }
    await h.draft.drain();

    const independent = h.frames.filter((frame) =>
      ["terminal error", "A1", "A2", "B final replay"].some((text) => text === frame.text),
    );
    expect(independent).toHaveLength(4);
    expect(independent.every((frame) => frame.id !== idA && frame.id !== idB)).toBe(true);
    expect(new Set(independent.map((frame) => frame.id)).size).toBe(4);
    expect(h.frames.find((frame) => frame.type === "final" && frame.id === idA)?.text).toBe("lane A");
    expect(h.frames.find((frame) => frame.type === "final" && frame.id === idB)?.text).toBe("lane B");
  });

  it("M11b: coalesced callback counts never group or suppress actual blocks/finals", async () => {
    const h = makeDraftHarness();
    h.draft.handleAssistantMessageBoundary();
    h.draft.pushEvent(toolStart());
    h.draft.pushAnswerText({ text: "lane A" });
    const idA = h.frames.at(-1)!.id;
    h.draft.handleAssistantMessageBoundary();
    h.draft.pushAnswerText({ text: "lane B" });
    const idB = h.frames.at(-1)!.id;

    h.draft.noteBlockReplyQueued({ assistantMessageIndex: 0 });
    h.draft.noteBlockReplyQueued({ assistantMessageIndex: 1 });
    await h.draft.deliverAuthorizedBlock({ text: "actual A1 + A2" });
    await h.draft.deliverAuthorizedBlock({ text: "actual B" });
    h.draft.noteLeadingTerminalError();
    for (const text of ["terminal error", "A1", "A2", "B final replay"]) {
      await h.draft.deliverIndependentFinal({ text });
    }
    await h.draft.drain();

    const preservedTexts = [
      "actual A1 + A2",
      "actual B",
      "terminal error",
      "A1",
      "A2",
      "B final replay",
    ];
    const preserved = h.frames.filter((frame) =>
      preservedTexts.some((text) => text === frame.text),
    );
    expect(preserved.map((frame) => frame.text)).toEqual(preservedTexts);
    expect(new Set(preserved.map((frame) => frame.id)).size).toBe(6);
    expect(preserved.every((frame) => frame.id !== idA && frame.id !== idB)).toBe(true);
  });

  it("M12: mixed true/false/throw leading-error fallbacks all run with actual results", async () => {
    const outcomes = new Map<string, DraftOutcome>([
      ["F1", true],
      ["F2", false],
      ["F3", "throw"],
      ["F4", true],
    ]);
    const h = makeDraftHarness({ decide: (attempt) => outcomes.get(attempt.text) ?? true });
    h.draft.handleAssistantMessageBoundary();
    h.draft.pushAnswerText({ text: "retained lane" });
    const laneId = h.frames[0]!.id;
    h.draft.noteLeadingTerminalError();

    const results: boolean[] = [];
    for (const text of ["F1", "F2", "F3", "F4"]) {
      results.push(await h.draft.deliverIndependentFinal({ text }));
    }
    expect(results).toEqual([true, false, false, true]);
    expect(h.attempts.filter((attempt) => /^F[1-4]$/.test(attempt.text))).toHaveLength(4);
    expect(h.draft.snapshotText()).toBe("retained lane");
    expect(h.frames.filter((frame) => frame.id === laneId).map((frame) => frame.text)).toEqual([
      "retained lane",
    ]);
  });
});

describe("ProgressDraftController — provisional preview transactions", () => {
  it("M13a: an authorized block claims visible P before B uses a fresh lane id", async () => {
    const h = makeDraftHarness();
    h.draft.pushEvent(toolStart());
    const provisionalId = h.frames[0]!.id;
    await h.draft.deliverAuthorizedBlock({ text: "block F" });
    h.draft.handleAssistantMessageBoundary();
    h.draft.pushAnswerText({ text: "B" });
    const idB = h.frames.at(-1)!.id;
    await h.draft.finalize("B final");

    expect(h.frames.find((frame) => frame.text === "block F")!.id).toBe(provisionalId);
    expect(idB).not.toBe(provisionalId);
    expect(h.frames.map((frame) => frame.text)).toEqual([
      h.frames[0]!.text,
      "block F",
      "B",
      "B final",
    ]);
  });

  it("M13b: block-only success replaces P and drain does not re-settle scaffold", async () => {
    const h = makeDraftHarness();
    h.draft.pushEvent(toolStart());
    const provisionalId = h.frames[0]!.id;
    await h.draft.deliverAuthorizedBlock({ text: "block-only" });
    await h.draft.drain();

    expect(h.frames).toHaveLength(2);
    expect(h.frames.map((frame) => frame.id)).toEqual([provisionalId, provisionalId]);
    expect(h.frames.at(-1)).toEqual({ type: "final", id: provisionalId, text: "block-only" });
  });

  it.each([false, "throw"] as const)(
    "M13c: block %s rolls P back so B claims it without a failed-block ghost",
    async (failure) => {
      const h = makeDraftHarness({
        decide: (attempt) => (attempt.text === "failed block" ? failure : true),
      });
      h.draft.pushEvent(toolStart());
      const provisionalId = h.frames[0]!.id;
      await expect(h.draft.deliverAuthorizedBlock({ text: "failed block" })).resolves.toBe(false);
      await expect(h.draft.finalize("B final")).resolves.toBe(true);

      expect(h.frames.map((frame) => frame.text)).toEqual([h.frames[0]!.text, "B final"]);
      expect(h.frames.map((frame) => frame.id)).toEqual([provisionalId, provisionalId]);
    },
  );

  it("M13d: the first successful notice/error claimant owns P and later payloads are fresh", async () => {
    const cases = [
      async (h: ReturnType<typeof makeDraftHarness>) =>
        h.draft.deliverAuthorizedBlock({ text: "first", isStatusNotice: true }),
      async (h: ReturnType<typeof makeDraftHarness>) =>
        h.draft.deliverIndependentFinal({ text: "first", isFallbackNotice: true }),
      async (h: ReturnType<typeof makeDraftHarness>) => {
        h.draft.noteLeadingTerminalError();
        return h.draft.deliverIndependentFinal({ text: "first" });
      },
    ];
    for (const deliverFirst of cases) {
      const h = makeDraftHarness();
      h.draft.pushEvent(toolStart());
      const provisionalId = h.frames[0]!.id;
      await deliverFirst(h);
      await h.draft.deliverIndependentFinal({ text: "second" });
      h.draft.pushAnswerText({ text: "lane after independent" });
      const first = h.frames.find((frame) => frame.text === "first")!;
      const second = h.frames.find((frame) => frame.text === "second")!;
      const lane = h.frames.find((frame) => frame.text === "lane after independent")!;
      expect(first.id).toBe(provisionalId);
      expect(new Set([first.id, second.id, lane.id]).size).toBe(3);
    }

    const ordered = makeDraftHarness();
    ordered.draft.handleAssistantMessageBoundary();
    ordered.draft.pushEvent(toolStart("ordered-terminal"));
    const orderedP = ordered.frames[0]!.id;
    ordered.draft.handleAssistantMessageBoundary();
    ordered.draft.pushAnswerText({ text: "retained lane" });
    ordered.draft.handleAssistantMessageBoundary();
    await ordered.draft.deliverIndependentFinal({
      text: "terminal notice",
      isCompactionNotice: true,
    });
    await ordered.draft.drain();
    const terminal = ordered.frames.find((frame) => frame.text === "terminal notice")!;
    const retained = ordered.frames.find((frame) => frame.text === "retained lane")!;
    expect(terminal.id).toBe(orderedP);
    expect(retained.id).not.toBe(orderedP);
    expect(ordered.frames.indexOf(terminal)).toBeLessThan(ordered.frames.indexOf(retained));
  });

  it("M13e: a failed leading error rolls P back for the retained answer", async () => {
    const h = makeDraftHarness({
      decide: (attempt) => (attempt.text === "terminal error" ? false : true),
    });
    h.draft.pushEvent(toolStart());
    const provisionalId = h.frames[0]!.id;
    h.draft.noteLeadingTerminalError();
    await expect(h.draft.deliverIndependentFinal({ text: "terminal error" })).resolves.toBe(false);
    await expect(h.draft.finalize("retained A")).resolves.toBe(true);

    expect(h.frames.map((frame) => frame.text)).toEqual([h.frames[0]!.text, "retained A"]);
    expect(h.frames.map((frame) => frame.id)).toEqual([provisionalId, provisionalId]);
  });

  it("M13f: lane and independent P claims both suppress every later scaffold write", async () => {
    const lane = makeDraftHarness();
    lane.draft.pushEvent(toolStart("lane-tool"));
    const laneP = lane.frames[0]!.id;
    lane.draft.handleAssistantMessageBoundary();
    lane.draft.pushAnswerText({ text: "lane answer" });
    lane.draft.pushEvent(toolStart("late-lane-tool"));
    expect(lane.frames.filter((frame) => frame.id === laneP)).toHaveLength(2);
    expect(lane.frames.at(-1)?.text).toBe("lane answer");

    const independent = makeDraftHarness();
    independent.draft.pushEvent(toolStart("block-tool"));
    const independentP = independent.frames[0]!.id;
    await independent.draft.deliverAuthorizedBlock({ text: "block answer" });
    independent.draft.pushEvent(toolStart("late-block-tool"));
    independent.draft.handleAssistantMessageBoundary();
    independent.draft.pushAnswerText({ text: "B" });
    expect(independent.frames.filter((frame) => frame.id === independentP)).toHaveLength(2);
    expect(independent.frames.find((frame) => frame.text === "B")!.id).not.toBe(independentP);
  });

  it("M13f: a successful fresh-id delivery suppresses later scaffold creation", async () => {
    const h = makeDraftHarness();
    await expect(h.draft.deliverAuthorizedBlock({ text: "durable first" })).resolves.toBe(true);
    h.draft.pushEvent(toolStart("late-tool"));
    await h.draft.flush();

    expect(h.attempts).toHaveLength(1);
    expect(h.attempts[0]).toMatchObject({ type: "final", text: "durable first" });
  });

  it("M13g: failed first progress/final lane frames leave P for B and are not retried", async () => {
    for (const frameType of ["progress", "final"] as const) {
      for (const failure of [false, "throw"] as const) {
        const h = makeDraftHarness({
          throttleMs: frameType === "final" ? 60_000 : 0,
          decide: (attempt) => (attempt.text === "A" ? failure : true),
        });
        h.draft.handleAssistantMessageBoundary();
        h.draft.pushEvent(toolStart(`${frameType}-${String(failure)}`));
        const provisionalId = h.frames[0]!.id;
        h.draft.pushAnswerText({ text: "A" });
        h.draft.handleAssistantMessageBoundary();
        h.draft.pushEvent(toolStart(`after-A-${frameType}-${String(failure)}`));
        await h.draft.flush();
        expect(h.frames.at(-1)?.id).toBe(provisionalId);
        expect(h.frames.at(-1)?.type).toBe("progress");
        await expect(h.draft.finalize("B")).resolves.toBe(true);

        const failedA = h.attempts.filter((attempt) => attempt.text === "A");
        expect(failedA).toHaveLength(1);
        expect(failedA[0]!.type).toBe(frameType);
        expect(failedA[0]!.id).toBe(provisionalId);
        expect(h.frames.find((frame) => frame.text === "B")!.id).toBe(provisionalId);
        expect(h.frames.filter((frame) => frame.text === "A")).toEqual([]);
      }
    }

    for (const failure of [false, "throw"] as const) {
      const h = makeDraftHarness({
        decide: (attempt) => (attempt.text === "A direct final" ? failure : true),
      });
      h.draft.pushEvent(toolStart(`direct-final-${String(failure)}`));
      const provisionalId = h.frames[0]!.id;
      await expect(h.draft.finalize("A direct final")).resolves.toBe(false);
      h.draft.pushEvent(toolStart(`after-direct-final-${String(failure)}`));
      await h.draft.flush();
      expect(h.frames.at(-1)?.id).toBe(provisionalId);
      await expect(h.draft.deliverIndependentFinal({ text: "next independent" })).resolves.toBe(
        true,
      );
      expect(h.attempts.filter((attempt) => attempt.text === "A direct final")).toHaveLength(1);
      expect(h.frames.find((frame) => frame.text === "next independent")!.id).toBe(provisionalId);
    }
  });

  it("M13h: F claims P after A progress failure; A's later revision uses fresh id", async () => {
    const h = makeDraftHarness({
      decide: (attempt) => (attempt.text === "A1" ? false : true),
    });
    h.draft.pushEvent(toolStart());
    const provisionalId = h.frames[0]!.id;
    h.draft.handleAssistantMessageBoundary();
    h.draft.pushAnswerText({ text: "A1" });
    await h.draft.deliverAuthorizedBlock({ text: "F" });
    h.draft.pushAnswerText({ text: "A1 later" });
    h.draft.pushEvent(toolStart("late"));

    const fallback = h.frames.find((frame) => frame.text === "F")!;
    const later = h.frames.find((frame) => frame.text === "A1 later")!;
    expect(fallback.id).toBe(provisionalId);
    expect(later.id).not.toBe(provisionalId);
    expect(h.frames.filter((frame) => frame.id === provisionalId).map((frame) => frame.text)).toEqual([
      h.frames[0]!.text,
      "F",
    ]);
  });

  it("drain settles a visible unclaimed tool-only preview at the same id", async () => {
    const h = makeDraftHarness();
    h.draft.pushEvent(toolStart());
    const preview = h.frames[0]!;
    expect(h.draft.started).toBe(true);
    expect(h.draft.snapshotText()).toBe("");
    await h.draft.drain();
    expect(h.frames.at(-1)).toEqual({ type: "final", id: preview.id, text: preview.text });
  });

  it("an empty independent payload logs a skip without reporting transport failure", async () => {
    const warn = vi.fn();
    const h = makeDraftHarness({ logger: { warn } });

    await expect(h.draft.deliverIndependentFinal({ text: "" })).resolves.toBe(false);
    expect(h.attempts).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("skipped empty text without a transport attempt"),
    );
  });

  it("drain after stop does not emit a terminal frame", async () => {
    const h = makeDraftHarness();
    h.draft.pushAnswerText({ text: "visible partial" });
    h.draft.stop();
    await h.draft.drain();

    expect(h.attempts.map((attempt) => attempt.type)).toEqual(["progress"]);
  });

  it("delta updates extend only the current lane", () => {
    const h = makeDraftHarness();
    h.draft.handleAssistantMessageBoundary();
    h.draft.pushAnswerText({ text: "", delta: "Hel" });
    const id = h.frames[0]!.id;
    h.draft.pushAnswerText({ delta: "lo" });
    expect(h.frames.at(-1)).toEqual({ type: "progress", id, text: "Hello" });
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
    // These inputs model btw's raw cumulative payload with inter-burst
    // whitespace, including that whitespace in the third burst's prefix.
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
    // The middle burst strips to empty and emits no frame before `endBurst`;
    // the final input still carries the prior raw prefix.
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
