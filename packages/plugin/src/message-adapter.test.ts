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
    draft.pushAnswerText({ text: "partial" });
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
    draft.pushAnswerText({ text: "partial answer so far" });
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
    draft.pushAnswerText({ text: "hello world" });
    const first = draft.snapshotText();
    const second = draft.snapshotText();
    expect(second).toBe(first);
    await draft.finalize("hello world final");
    // The snapshot reads never altered the finalized text.
    expect(first).toBe("hello world");
  });
});

/**
 * #94 — one rotatable draft lane per assistant message.
 *
 * The controller used to mint ONE id per turn and merge every assistant message
 * into a single body, so `finalize(lastMessage)` replaced that merged bubble and
 * the earlier text the user had already watched stream disappeared from the live
 * view. Each message now owns a lane: its own id, its own body, its own terminal
 * frame.
 *
 * Rotation triggers, in the order the pinned core actually produces them:
 *  - an `assistantMessageIndex` change across queued blocks;
 *  - a non-`replace` partial whose cumulative text restarts (the per-itemId
 *    cumulative reset, seen from here as divergence);
 *  - `onAssistantMessageStart`, which both pinned runners latch to fire once per
 *    RUN (run-attempt-DRhLt3eF.js:4083-4085, btw-CDO5476N.js:564/:597-599), so it
 *    normally lands on the empty first lane and no-ops.
 *
 * The harness runs with `throttleMs: 0` and flushes after each push, so every
 * `progress` frame is observable in order.
 */
function makeLaneHarness(options?: {
  /** Replaces the default "the terminal frame was accepted" transport result. */
  finalizeImpl?: (id: string, text: string) => boolean;
}) {
  const progress: Array<{ id: string; text: string }> = [];
  /** Every finalizeDraft ATTEMPT, recorded before the impl can throw. */
  const finalizes: Array<{ id: string; text: string }> = [];
  const warns: string[] = [];
  const infos: string[] = [];
  const transport = {
    sendProgress: (_peer: string, id: string, text: string) => {
      progress.push({ id, text });
      return true;
    },
    finalizeDraft: (_peer: string, id: string, text: string) => {
      finalizes.push({ id, text });
      return options?.finalizeImpl ? options.finalizeImpl(id, text) : true;
    },
  } as unknown as WebChannelPeerChannel;
  const draft = createProgressDraftController({
    transport,
    sessionKey: "peer-1",
    turnId: "turn-1",
    channelConfig: {},
    throttleMs: 0,
    logger: { warn: (m) => warns.push(m), info: (m) => infos.push(m) },
  });
  /** Push one partial and let the throttled loop drain it. */
  const push = async (update: { text?: string; delta?: string; replace?: true }) => {
    draft.pushAnswerText(update);
    await draft.flush();
  };
  const ids = () => progress.map((frame) => frame.id);
  return { draft, transport, progress, finalizes, warns, infos, push, ids };
}

describe("#94 assistant-message lane rotation", () => {
  it("M1: a leading boundary before any text creates no bubble and no second id", async () => {
    const h = makeLaneHarness();
    h.draft.handleAssistantMessageBoundary();
    await h.push({ text: "A" });
    await h.push({ text: "A msg" });

    // Nothing settled: the boundary found an empty lane.
    expect(h.finalizes).toEqual([]);
    expect(new Set(h.ids()).size).toBe(1);
    expect(h.progress.at(-1)).toEqual({ id: h.draft.id, text: "A msg" });
  });

  it("M2: a boundary settles A on its own id and B streams under a different id", async () => {
    const h = makeLaneHarness();
    await h.push({ text: "A msg" });
    const idA = h.draft.id;

    h.draft.handleAssistantMessageBoundary();
    await h.push({ text: "B msg" });
    const idB = h.draft.id;

    expect(idB).not.toBe(idA);
    // A settled with exactly the text the user watched stream…
    expect(h.finalizes).toEqual([{ id: idA, text: "A msg" }]);
    // …and B's frames never touch A's id.
    expect(h.progress.filter((f) => f.id === idB).at(-1)?.text).toBe("B msg");
    expect(h.progress.filter((f) => f.id === idA).every((f) => f.text === "A msg")).toBe(true);
  });

  it("M3: three messages settle as three lanes in order", async () => {
    const h = makeLaneHarness();
    await h.push({ text: "A" });
    const idA = h.draft.id;
    h.draft.handleAssistantMessageBoundary();
    await h.push({ text: "B" });
    const idB = h.draft.id;
    h.draft.handleAssistantMessageBoundary();
    await h.push({ text: "C" });
    const idC = h.draft.id;
    await h.draft.finalize("C final");

    expect(new Set([idA, idB, idC]).size).toBe(3);
    expect(h.finalizes).toEqual([
      { id: idA, text: "A" },
      { id: idB, text: "B" },
      { id: idC, text: "C final" },
    ]);
  });

  it("M4: replace:true rewrites the active lane and never rotates", async () => {
    const h = makeLaneHarness();
    await h.push({ text: "Hello world" });
    const idA = h.draft.id;
    // A rewrite may diverge AND shrink; both guards are skipped for replace.
    await h.push({ text: "Something else entirely", replace: true });
    await h.push({ text: "Short", replace: true });

    expect(h.draft.id).toBe(idA);
    expect(h.finalizes).toEqual([]); // no bubble was settled, so none was created
    expect(new Set(h.ids()).size).toBe(1);
    expect(h.progress.at(-1)?.text).toBe("Short");
    // A rewrite is a declared same-message update, so it emits no rotation
    // diagnostic (the divergence path is what logs).
    expect(h.infos).toEqual([]);
  });

  it("M5: several queued blocks record on one lane in order and settle it once", async () => {
    const h = makeLaneHarness();
    const idA = h.draft.id;
    h.draft.recordQueuedBlock({ text: "one" });
    h.draft.recordQueuedBlock({ text: "two", assistantMessageIndex: 0 });
    h.draft.recordQueuedBlock({ text: "three", assistantMessageIndex: 0 });
    // Recording never emits a progress frame.
    expect(h.progress).toEqual([]);

    h.draft.handleAssistantMessageBoundary();
    await h.draft.finalize("later message");

    expect(h.finalizes[0]).toEqual({ id: idA, text: "one\n\ntwo\n\nthree" });
    expect(h.finalizes.filter((f) => f.id === idA)).toHaveLength(1);
  });

  it("M6: a lane with blocks and no partials settles from the block texts", async () => {
    const h = makeLaneHarness();
    const idA = h.draft.id;
    h.draft.recordQueuedBlock({ text: "first block" });
    h.draft.recordQueuedBlock({ text: "" });
    h.draft.recordQueuedBlock({});
    h.draft.recordQueuedBlock({ text: "second block" });
    h.draft.handleAssistantMessageBoundary();

    expect(h.finalizes).toEqual([{ id: idA, text: "first block\n\nsecond block" }]);
  });

  it("M6b: a queued block arriving after its lane settled changes nothing on the wire", async () => {
    // What holds this is the per-lane settle latch, not the `lane.settled`
    // check in recordBlockOnLane — deleting that check fails no test, because a
    // settled lane can never emit a second frame either way. The test records
    // the shape: once a bubble is settled, later blocks cannot amend it.
    const h = makeLaneHarness();
    await h.push({ text: "A msg" });
    const idA = h.draft.id;
    await h.draft.finalize("A final");
    expect(h.finalizes).toEqual([{ id: idA, text: "A final" }]);

    h.draft.recordQueuedBlock({ text: "late block", assistantMessageIndex: 3 });
    h.draft.handleAssistantMessageBoundary();

    expect(h.finalizes).toEqual([{ id: idA, text: "A final" }]);
  });

  it("M7: a diverged non-replace partial preserves the streamed lane, logs, and rotates", async () => {
    const h = makeLaneHarness();
    await h.push({ text: "First msg" });
    const idA = h.draft.id;
    await h.push({ text: "Second msg" });
    const idB = h.draft.id;

    expect(idB).not.toBe(idA);
    // The already-streamed text survives in its own bubble instead of being
    // clobbered by the restarted cumulative text.
    expect(h.finalizes).toEqual([{ id: idA, text: "First msg" }]);
    expect(h.progress.filter((f) => f.id === idB).at(-1)?.text).toBe("Second msg");
    // The rotation is never silent (§6.5.1). It is a normal path in the pinned
    // core, so it records at info, not as a contract violation.
    expect(h.infos).toHaveLength(1);
    expect(h.infos[0]).toContain("partial stream restarted");
    expect(h.warns).toEqual([]);
  });

  it("M8: a late boundary for an already-rotated seam does not rotate again", async () => {
    const h = makeLaneHarness();
    await h.push({ text: "First msg" });
    const idA = h.draft.id;
    await h.push({ text: "Second msg" }); // divergence rotates here
    const idB = h.draft.id;

    h.draft.handleAssistantMessageBoundary(); // belated event for the SAME seam
    await h.push({ text: "Second msg more" });

    // Still on lane B: the late boundary neither settled the in-progress
    // message nor split it into a third bubble.
    expect(h.draft.id).toBe(idB);
    expect(h.finalizes).toEqual([{ id: idA, text: "First msg" }]);
    expect(h.progress.at(-1)).toEqual({ id: idB, text: "Second msg more" });
  });

  it("M9: lane A failing to settle (false, then throw) does not stop lane B", async () => {
    const failing = new Set<string>();
    const h = makeLaneHarness({
      finalizeImpl: (id) => {
        if (failing.has(id)) throw new Error("socket closed");
        return false;
      },
    });
    await h.push({ text: "A msg" });
    const idA = h.draft.id;

    // A's boundary settle returns false…
    h.draft.handleAssistantMessageBoundary();
    await h.push({ text: "B msg" });
    const idB = h.draft.id;
    // …and the next lane's settle THROWS out of the transport.
    failing.add(idB);
    h.draft.handleAssistantMessageBoundary();

    // The controller survived both: lane C still streams and still settles.
    await h.push({ text: "C msg" });
    const idC = h.draft.id;
    await expect(h.draft.finalize("C final")).resolves.toBe(false);

    expect(h.finalizes).toEqual([
      { id: idA, text: "A msg" },
      { id: idB, text: "B msg" },
      { id: idC, text: "C final" },
    ]);
    // The throwing lane logged a diagnostic rather than propagating.
    expect(h.warns.some((m) => m.includes("failed to settle"))).toBe(true);
  });

  it("M10: concurrent and re-entrant settles emit exactly one terminal frame per lane", async () => {
    let draft!: ReturnType<typeof createProgressDraftController>;
    let reentrant: Promise<boolean> | undefined;
    const finalizes: Array<{ id: string; text: string }> = [];
    const transport = {
      sendProgress: () => true,
      finalizeDraft: (_peer: string, id: string, text: string) => {
        finalizes.push({ id, text });
        // Re-enter from inside the transport call, while the lane's latch is
        // mid-flight.
        reentrant ??= draft.finalize("re-entrant");
        return true;
      },
    } as unknown as WebChannelPeerChannel;
    draft = createProgressDraftController({
      transport,
      sessionKey: "peer-1",
      turnId: "turn-1",
      channelConfig: {},
      throttleMs: 0,
    });

    draft.pushAnswerText({ text: "A msg" });
    await draft.flush();
    const idA = draft.id;
    // Boundary settle + an immediate second boundary for the same lane.
    draft.handleAssistantMessageBoundary();
    draft.handleAssistantMessageBoundary();

    draft.pushAnswerText({ text: "B msg" });
    await draft.flush();
    const idB = draft.id;
    await expect(
      Promise.all([draft.finalize("B final"), draft.finalize("B final again")]),
    ).resolves.toEqual([true, true]);
    await expect(draft.finalize("B once more")).resolves.toBe(true);
    await expect(reentrant).resolves.toBe(true);

    expect(finalizes).toEqual([
      { id: idA, text: "A msg" },
      { id: idB, text: "B final" },
    ]);
  });

  it("M11: an assistantMessageIndex change on a queued block settles the lane and rotates", async () => {
    const h = makeLaneHarness();
    const idA = h.draft.id;
    h.draft.recordQueuedBlock({ text: "A block", assistantMessageIndex: 0 });
    h.draft.recordQueuedBlock({ text: "B block", assistantMessageIndex: 1 });
    const idB = h.draft.id;

    expect(idB).not.toBe(idA);
    expect(h.finalizes).toEqual([{ id: idA, text: "A block" }]);
    expect(h.infos.some((m) => m.includes("assistantMessageIndex 1"))).toBe(true);

    // The new lane owns index 1: a further block with that index joins it
    // rather than rotating again, and the lane settles on its own id.
    h.draft.recordQueuedBlock({ text: "B block 2", assistantMessageIndex: 1 });
    expect(h.draft.id).toBe(idB);
    await h.draft.finalize("B final");
    expect(h.finalizes.at(-1)).toEqual({ id: idB, text: "B final" });
  });

  it("M11b: blocks without an index never rotate", async () => {
    const h = makeLaneHarness();
    const idA = h.draft.id;
    h.draft.recordQueuedBlock({ text: "one" });
    h.draft.recordQueuedBlock({ text: "two" });
    h.draft.recordQueuedBlock({ text: "three", assistantMessageIndex: 7 });
    h.draft.recordQueuedBlock({ text: "four" });

    expect(h.draft.id).toBe(idA);
    expect(h.finalizes).toEqual([]);
    h.draft.handleAssistantMessageBoundary();
    expect(h.finalizes).toEqual([{ id: idA, text: "one\n\ntwo\n\nthree\n\nfour" }]);
  });

  it("M12: the FAVOURABLE interleaving (A partials, block A, B partials, block B) rotates ONCE", async () => {
    // One of the two orderings the clocks allow: A's block drains before B's
    // deltas. The partial restart rotates, and the block that follows carries
    // the NEW index onto a lane that has not adopted one yet — that block is
    // the active message's own, so it adopts in place and must not rotate
    // again. (The other ordering is M14; nothing guarantees which one occurs,
    // because blocks drain on an async serialized chain behind a coalescer
    // while partials are awaited inline in the delta loop.)
    const h = makeLaneHarness();
    await h.push({ text: "A msg" });
    const idA = h.draft.id;
    h.draft.recordQueuedBlock({ text: "A msg", assistantMessageIndex: 0 });

    await h.push({ text: "B msg" }); // stream restart → the single rotation
    const idB = h.draft.id;
    h.draft.recordQueuedBlock({ text: "B msg", assistantMessageIndex: 1 });
    expect(h.draft.id).toBe(idB);

    await h.push({ text: "B msg more" });
    await h.draft.finalize("B msg final");

    expect(idB).not.toBe(idA);
    expect(h.finalizes).toEqual([
      { id: idA, text: "A msg" },
      { id: idB, text: "B msg final" },
    ]);
  });

  it("M14: the UNFAVOURABLE interleaving — BOTH blocks drain after the partials rotated", async () => {
    // Blocks drain on an async serialized `sendChain` behind a coalescer that
    // only flushes on an index change or an idle timer
    // (block-reply-pipeline-CsIUOKQ6.js:241-246, :299-300), while partials are
    // awaited inline in the delta loop (run-attempt-DRhLt3eF.js:4088-4097). So
    // A's block routinely arrives after B's partials have already rotated the
    // lane — and lane A, created and settled purely from partials, never saw an
    // index of its own.
    //
    // Ownership therefore cannot be inferred from the index VALUE: at the
    // moment A's block lands, the active lane simply has no index, and reading
    // "no index yet, so this block is mine" hands A's index to lane B. B then
    // reads its own block as a higher index — a new message — and settles a
    // SECOND time. What this test holds is that outcome: one terminal frame per
    // message. It does NOT hold WHERE each block was recorded — both blocks'
    // text is invisible here either way, because every lane in this fixture has
    // `answerText`, which outranks queued blocks in `laneBody`. M17 is the test
    // that constrains the routing target.
    const h = makeLaneHarness();
    await h.push({ text: "A msg" });
    const idA = h.draft.id;
    await h.push({ text: "B msg" }); // stream restart → the single rotation
    const idB = h.draft.id;

    h.draft.recordQueuedBlock({ text: "A msg", assistantMessageIndex: 0 });
    expect(h.draft.id).toBe(idB);
    h.draft.recordQueuedBlock({ text: "B msg", assistantMessageIndex: 1 });
    expect(h.draft.id).toBe(idB);

    await h.push({ text: "B msg more" });
    await h.draft.finalize("B final");

    expect(h.finalizes).toEqual([
      { id: idA, text: "A msg" },
      { id: idB, text: "B final" },
    ]);
    expect(new Set(h.finalizes.map((f) => f.id)).size).toBe(2);
  });

  it("M14c: three partial messages whose blocks all drain afterwards settle three times", async () => {
    // The same skew as M14, one message deeper: by the time any block arrives
    // the turn already has three lanes and two of them are settled. As in M14,
    // what is held here is the settled shape — three messages, three terminal
    // frames, three ids — not which lane each block was recorded on (M17).
    const h = makeLaneHarness();
    await h.push({ text: "A" });
    const idA = h.draft.id;
    await h.push({ text: "B" });
    const idB = h.draft.id;
    await h.push({ text: "C" });
    const idC = h.draft.id;

    h.draft.recordQueuedBlock({ text: "A", assistantMessageIndex: 0 });
    h.draft.recordQueuedBlock({ text: "B", assistantMessageIndex: 1 });
    h.draft.recordQueuedBlock({ text: "C", assistantMessageIndex: 2 });
    expect(h.draft.id).toBe(idC);
    await h.draft.finalize("C final");

    expect(h.finalizes).toEqual([
      { id: idA, text: "A" },
      { id: idB, text: "B" },
      { id: idC, text: "C final" },
    ]);
    expect(new Set(h.finalizes.map((f) => f.id)).size).toBe(3);
  });

  it("M14d: a lane reused for a later index releases its previous one (one key per lane)", async () => {
    // Text-less (media-only) blocks give a lane nothing to show, so the lane is
    // reused for the next index rather than rotated — otherwise a scaffold
    // bubble already on screen would be stranded. Reuse must RELEASE the old
    // key: holding two keys inflates the ordinal past the lanes that exist, and
    // the next block then reads as a new message, settling the live lane early
    // so its text is shown twice.
    const h = makeLaneHarness();
    h.draft.recordQueuedBlock({ assistantMessageIndex: 0 });
    h.draft.recordQueuedBlock({ assistantMessageIndex: 1 });
    await h.push({ text: "X" });
    const idX = h.draft.id;
    await h.push({ text: "Y" });
    const idY = h.draft.id;
    h.draft.recordQueuedBlock({ text: "Y", assistantMessageIndex: 2 });
    expect(h.draft.id).toBe(idY);
    await h.draft.finalize("Y final");

    expect(h.finalizes).toEqual([
      { id: idX, text: "X" },
      { id: idY, text: "Y final" },
    ]);
  });

  it("M17: a late block is routed to ITS lane, not to whatever lane is active", async () => {
    // The routing TARGET is only observable where a block's text can reach the
    // wire, which means a lane with no `answerText` — a lane that streamed text
    // settles from that text and hides any block recorded on it. So the live
    // lane here is one rotated by a boundary and still empty: if the late block
    // were recorded on it instead of on the settled lane that owns it, the next
    // boundary would settle that lane FROM the block and replay an
    // already-delivered message as a fourth bubble.
    const h = makeLaneHarness();
    // A block-only first message, settled at its boundary.
    h.draft.recordQueuedBlock({ text: "A block only" });
    h.draft.handleAssistantMessageBoundary();
    const idA = h.finalizes[0]!.id;
    // A second message that streams, settled at its own boundary. The lane that
    // rotation opens has neither text nor blocks.
    await h.push({ text: "B msg" });
    const idB = h.draft.id;
    h.draft.handleAssistantMessageBoundary();
    const idC = h.draft.id;

    // A's own block finally drains, carrying its index. It belongs to a lane
    // that settled two messages ago.
    h.draft.recordQueuedBlock({ text: "A block only", assistantMessageIndex: 0 });
    // Nothing to settle on the live lane: the late block is not its body.
    h.draft.handleAssistantMessageBoundary();
    expect(h.draft.id).toBe(idC);
    await h.draft.finalize("C final");

    expect(h.finalizes).toEqual([
      { id: idA, text: "A block only" },
      { id: idB, text: "B msg" },
      { id: idC, text: "C final" },
    ]);
  });

  it("M14b: a block arriving out of index order is dropped, not given an ordinal", async () => {
    // Ordinal ownership assumes the drain is monotonic. A lower index arriving
    // after a higher one has already been claimed must be discarded: consuming
    // an ordinal for it shifts every later block onto the wrong lane, which
    // shows up as the live lane being settled early and split in two.
    const h = makeLaneHarness();
    await h.push({ text: "A msg" });
    const idA = h.draft.id;
    await h.push({ text: "B msg" });
    const idB = h.draft.id;

    h.draft.recordQueuedBlock({ text: "B msg", assistantMessageIndex: 1 });
    h.draft.recordQueuedBlock({ text: "A msg", assistantMessageIndex: 0 }); // out of order
    h.draft.recordQueuedBlock({ text: "B tail", assistantMessageIndex: 2 });

    expect(h.draft.id).toBe(idB);
    await h.draft.finalize("B final");
    expect(h.finalizes).toEqual([
      { id: idA, text: "A msg" },
      { id: idB, text: "B final" },
    ]);
  });

  it("M15: partials after a BLOCK-ONLY lane rotate instead of erasing its blocks", async () => {
    // The lane in the middle produced no partials at all, so its body is its
    // queued block. When the next message's partials arrive, the restart check
    // has to compare against that body: comparing only against streamed text
    // would absorb them into the block-only lane, where laneBody's
    // answerText-first preference then discards the block — erasing a whole
    // assistant message from the live view.
    const h = makeLaneHarness();
    await h.push({ text: "A msg" });
    const idA = h.draft.id;
    h.draft.recordQueuedBlock({ text: "A msg", assistantMessageIndex: 0 });
    h.draft.recordQueuedBlock({ text: "B block only", assistantMessageIndex: 1 });
    const idB = h.draft.id;
    await h.push({ text: "C msg" });
    const idC = h.draft.id;
    await h.draft.finalize("C final");

    expect(new Set([idA, idB, idC]).size).toBe(3);
    expect(h.finalizes).toEqual([
      { id: idA, text: "A msg" },
      { id: idB, text: "B block only" },
      { id: idC, text: "C final" },
    ]);
  });

  it("M16: an index change on a lane with nothing to settle reuses that lane", async () => {
    // The lane is SHOWN (a scaffold frame went out) but has no body of its own.
    // Rotating away would strand that bubble: no terminal frame could ever
    // reach it, and the protocol has no delete frame, so the widget would spin
    // on it forever. Reusing the lane keeps it settleable.
    const h = makeLaneHarness();
    h.draft.pushEvent({ event: "tool", itemId: "i1", name: "bash", phase: "start" });
    await h.draft.flush();
    const idA = h.draft.id;
    expect(h.progress.map((f) => f.id)).toEqual([idA]);

    h.draft.recordQueuedBlock({ text: "", assistantMessageIndex: 0 });
    h.draft.recordQueuedBlock({ text: "", assistantMessageIndex: 1 });
    expect(h.draft.id).toBe(idA);
    expect(h.finalizes).toEqual([]);

    await h.draft.finalize("the answer");
    expect(h.finalizes).toEqual([{ id: idA, text: "the answer" }]);
  });

  it("M13: a late boundary after an index-change rotation does not rotate again", async () => {
    const h = makeLaneHarness();
    const idA = h.draft.id;
    h.draft.recordQueuedBlock({ text: "A block", assistantMessageIndex: 0 });
    h.draft.recordQueuedBlock({ text: "B block", assistantMessageIndex: 1 });
    const idB = h.draft.id;

    h.draft.handleAssistantMessageBoundary(); // belated event for the same seam
    expect(h.draft.id).toBe(idB);
    expect(h.finalizes).toEqual([{ id: idA, text: "A block" }]);
  });

  it("delta-only partials extend the active lane (fallback path)", async () => {
    const h = makeLaneHarness();
    await h.push({ delta: "Hel" });
    await h.push({ delta: "lo" });
    expect(h.progress.at(-1)?.text).toBe("Hello");
    expect(new Set(h.ids()).size).toBe(1);
  });

  it("a rotated lane emits no progress frame until it has assistant text (§6.2-2b)", async () => {
    const h = makeLaneHarness();
    await h.push({ text: "A msg" });
    const idA = h.draft.id;
    h.draft.handleAssistantMessageBoundary();
    const idB = h.draft.id;

    // Tool activity between messages must not paint (and thereby commit) a
    // bubble for the new lane — the protocol has no bubble-delete frame.
    h.draft.pushEvent({ event: "tool", itemId: "i1", name: "bash", phase: "start" });
    await h.draft.flush();
    expect(h.progress.some((f) => f.id === idB)).toBe(false);
    expect(h.draft.started).toBe(false);
    expect(h.draft.snapshotText()).toBe("");

    await h.push({ text: "B msg" });
    expect(h.progress.at(-1)).toEqual({ id: idB, text: "B msg" });
    expect(h.draft.started).toBe(true);
    expect(h.finalizes).toEqual([{ id: idA, text: "A msg" }]);
  });

  it("finalize flushes the lane's pending frame BEFORE marking it settled", async () => {
    // The pre-finalize flush is what guarantees the widget saw the bubble at
    // least once on a fast turn. It has to run while the lane is still
    // unsettled — a lane marked settled first would have that frame dropped by
    // the same guard that protects a rotated lane.
    const events: string[] = [];
    const transport = {
      sendProgress: (_peer: string, id: string, text: string) => {
        events.push(`progress ${id} ${text}`);
        return true;
      },
      finalizeDraft: (_peer: string, id: string, text: string) => {
        events.push(`final ${id} ${text}`);
        return true;
      },
    } as unknown as WebChannelPeerChannel;
    const draft = createProgressDraftController({
      transport,
      sessionKey: "peer-1",
      turnId: "turn-1",
      channelConfig: {},
      throttleMs: 60_000,
    });
    draft.pushAnswerText({ text: "A one" });
    const id = draft.id;
    draft.pushAnswerText({ text: "A one two" }); // held by the throttle
    await draft.finalize("A final");

    expect(events).toEqual([
      `progress ${id} A one`,
      `progress ${id} A one two`,
      `final ${id} A final`,
    ]);
  });

  it("a throttled frame still pending when its lane settles is dropped, not sent late", async () => {
    // The loop keeps the newest pending text and only drains it on flush. If
    // the lane settles first, that pending frame must be DROPPED: sending it
    // would repaint a bubble the widget has already settled (the protocol has
    // no way to un-settle one).
    //
    // What this constrains is that the pending text is evaluated against the
    // lane it BELONGS to. Dropping that association — flushing against
    // whatever lane is active by then — makes the frame land on the new lane's
    // id, which this test catches. It does NOT independently constrain the id
    // read: swapping `lane.id` for `active.id` while keeping the settled check
    // fails nothing, because the frame is dropped before the id is used.
    const events: string[] = [];
    const transport = {
      sendProgress: (_peer: string, id: string, text: string) => {
        events.push(`progress ${id} ${text}`);
        return true;
      },
      finalizeDraft: (_peer: string, id: string, text: string) => {
        events.push(`final ${id} ${text}`);
        return true;
      },
    } as unknown as WebChannelPeerChannel;
    // A long throttle: the FIRST update sends immediately (the loop's initial
    // window is open), the second is held pending until a flush.
    const draft = createProgressDraftController({
      transport,
      sessionKey: "peer-1",
      turnId: "turn-1",
      channelConfig: {},
      throttleMs: 60_000,
    });
    draft.pushAnswerText({ text: "A one" });
    const idA = draft.id;
    draft.pushAnswerText({ text: "A one two" }); // pending, not yet sent
    expect(events).toEqual([`progress ${idA} A one`]);

    draft.handleAssistantMessageBoundary(); // settles lane A with its full body
    const idB = draft.id;
    await draft.flush(); // drains the still-pending "A one two"

    expect(events).toEqual([`progress ${idA} A one`, `final ${idA} A one two`]);
    expect(events.some((e) => e.includes(idB))).toBe(false);
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
