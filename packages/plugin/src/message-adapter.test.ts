import { describe, it, expect, vi } from "vitest";
import { sanitizeAssistantVisibleStreamText } from "openclaw/plugin-sdk/agent-runtime";

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
  // #212: the turn_snapshot frames the controller emits at drain, in order.
  const snapshots: Array<{
    turnId: string;
    answers: Array<{ id: string; text: string }>;
    remove: string[];
  }> = [];
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
    sendTurnSnapshot: (
      _peer: string,
      turnId: string,
      answers: Array<{ id: string; text: string }>,
      remove: string[],
    ) => {
      snapshots.push({ turnId, answers, remove });
      return true;
    },
  } as unknown as WebChannelPeerChannel;
  const draft = createProgressDraftController({
    transport,
    sessionKey: "peer-1",
    turnId: "turn-1",
    channelConfig: {},
    throttleMs: options?.throttleMs ?? 0,
    logger: options?.logger ?? { warn: () => {} },
  });
  return { draft, attempts, frames, snapshots };
}

const toolStart = (itemId = "tool-1") => ({
  event: "tool" as const,
  itemId,
  name: "bash",
  phase: "start" as const,
});

function bubbleOrder(frames: DraftAttempt[]): string[] {
  const order: string[] = [];
  const last = new Map<string, string>();
  for (const frame of frames) {
    if (!last.has(frame.id)) order.push(frame.id);
    last.set(frame.id, frame.text);
  }
  return order.map((id) => last.get(id)!);
}

function successfulIds(frames: DraftAttempt[]): string[] {
  return [...new Set(frames.map((frame) => frame.id))];
}

async function replayPinnedStreamPrefixes(
  draft: ReturnType<typeof makeDraftHarness>["draft"],
  source: string,
): Promise<string> {
  let previous: string | undefined;
  for (let end = 1; end <= source.length; end += 1) {
    const visible = sanitizeAssistantVisibleStreamText(source.slice(0, end));
    if (visible === previous) continue;
    previous = visible;
    // Core suppresses empty partial callbacks; preserving that omission is what
    // makes the tool-only and coalesced regressions realistic.
    if (!visible) continue;
    draft.pushAnswerText({ text: visible });
    await draft.flush();
  }
  return sanitizeAssistantVisibleStreamText(source);
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

  // #173 — collapse-aware final routing. Which lane an ordinary final belongs to
  // depends on the LAST assistant message, per the verified core contract
  // (payloads-1r4oLFNi.js:335/:424/:426): a text-bearing last message COLLAPSES
  // to exactly one final (the last message's text); a tool-only last message
  // emits one final per text-bearing message, in order. Tool-only messages still
  // fire `onAssistantMessageStart`, so in the tool-only shape `currentLane()` at
  // finalize time is the TEXTLESS tool lane — the reason the old
  // `finalize`→`currentLane()` produced [A,A,B].
  //
  // When the current lane is textless AND text-bearing lanes exist, the shape is
  // undecidable until the turn ends: the collapse-with-nonstreaming-last shape
  // (K==1 → the final is the current lane's own text, e.g. M15a/M15b) is
  // byte-identical at finalize time to the tool-only-last #173 shape (K>=2 → one
  // final per text-bearing lane). Only the drain-time COUNT separates them, so
  // those finals are BUFFERED and resolved at drain.
  it("M173a: tool-only last message — two finals settle each text lane's own bubble in order [A][B] at drain", async () => {
    const h = makeDraftHarness();
    h.draft.handleAssistantMessageBoundary(); // first boundary: no-op
    h.draft.pushAnswerText({ text: "first ans" }); // lane A (gen 0)
    await h.draft.flush();
    h.draft.handleAssistantMessageBoundary(); // rotate → lane B; lane A auto-settles
    h.draft.pushAnswerText({ text: "second ans" }); // lane B (gen 1)
    await h.draft.flush();
    h.draft.handleAssistantMessageBoundary(); // rotate → tool-only lane (gen 2); lane B auto-settles
    // The tool-only last message streams NO visible answer text — its lane stays
    // textless and is the current lane when the finals arrive.
    const idA = h.frames.find((frame) => frame.text === "first ans")!.id;
    const idB = h.frames.find((frame) => frame.text === "second ans")!.id;

    // Textless current lane → both finals BUFFER (nothing sent yet), provisionally true.
    await expect(h.draft.finalize("first answer")).resolves.toBe(true);
    await expect(h.draft.finalize("second answer")).resolves.toBe(true);
    const finalsBeforeDrain = h.frames.filter(
      (frame) => frame.text === "first answer" || frame.text === "second answer",
    );
    expect(finalsBeforeDrain).toEqual([]);

    // Drain knows K==2 → the #173 fallback: final#i → i-th text-bearing lane.
    await h.draft.drain();

    expect(idA).not.toBe(idB);
    // Every final landed on a text lane's OWN id — no third (independent) bubble.
    expect(successfulIds(h.frames)).toEqual([idA, idB]);
    // The authoritative final tops up each lane's own bubble in order → [A][B].
    const finalsById = (id: string) =>
      h.frames.filter((frame) => frame.type === "final" && frame.id === id).map((f) => f.text);
    expect(finalsById(idA)).toEqual(["first ans", "first answer"]);
    expect(finalsById(idB)).toEqual(["second ans", "second answer"]);
    expect(bubbleOrder(h.frames)).toEqual(["first answer", "second answer"]);
  });

  it("M173b: text-bearing last message (collapse) — the single final settles the current lane IMMEDIATELY; earlier lanes keep their streamed text", async () => {
    const h = makeDraftHarness();
    h.draft.handleAssistantMessageBoundary(); // first boundary: no-op
    h.draft.pushAnswerText({ text: "first ans" }); // lane A (gen 0)
    await h.draft.flush();
    h.draft.handleAssistantMessageBoundary(); // rotate → lane B; lane A auto-settles
    h.draft.pushAnswerText({ text: "second ans" }); // lane B (gen 1) — the LAST message, and it has text
    await h.draft.flush();
    const idA = h.frames.find((frame) => frame.text === "first ans")!.id;
    const idB = h.frames.find((frame) => frame.text === "second ans")!.id;

    // Collapse: the current lane bears text, so the target is unambiguous and the
    // final settles it IMMEDIATELY — no drain needed. It belongs to the current
    // (text-bearing) lane, NOT the first lane.
    await h.draft.finalize("second answer");

    expect(successfulIds(h.frames)).toEqual([idA, idB]);
    expect(bubbleOrder(h.frames)).toEqual(["first ans", "second answer"]);
    // A stray second ordinary final in the collapse shape has no lane left to
    // own it and falls back to an independent bubble (today's behaviour).
    await h.draft.finalize("stray extra");
    expect(bubbleOrder(h.frames)).toEqual(["first ans", "second answer", "stray extra"]);
    expect(successfulIds(h.frames)).toHaveLength(3);
  });

  it("M173c: collapse whose last message streamed no partial — single buffered final settles the current lane at drain [A][B][C]", async () => {
    // Real core shape (same as M15a/M15b): A and B stream; the LAST message C has
    // text but streams no partial, so its lane is textless at finalize time. Core
    // collapses to ONE final = C's text. K==1 at drain → the final is the current
    // (textless) lane's own text → C gets its own bubble.
    const h = makeDraftHarness();
    h.draft.handleAssistantMessageBoundary();
    h.draft.pushAnswerText({ text: "message A" });
    await h.draft.flush();
    h.draft.handleAssistantMessageBoundary(); // → lane B; A auto-settles
    h.draft.pushAnswerText({ text: "message B" });
    await h.draft.flush();
    h.draft.handleAssistantMessageBoundary(); // → lane C (textless current); B auto-settles

    await expect(h.draft.finalize("message C")).resolves.toBe(true); // buffered
    expect(h.frames.some((frame) => frame.text === "message C")).toBe(false);

    await h.draft.drain();

    expect(bubbleOrder(h.frames)).toEqual(["message A", "message B", "message C"]);
    expect(successfulIds(h.frames)).toHaveLength(3);
  });

  it("M173d: KNOWN LIMITATION (Case X) — a single streamed answer then a tool-only last message tops up the tool lane", async () => {
    // [one text answer A, then a tool-only LAST message] collapses to K==1 with a
    // textless current lane (the tool lane), so the lone final tops up that tool
    // lane rather than lane A. This matches prior behaviour and is NOT a
    // regression (the old keyframe never touched a one-text-lane turn either). The
    // sound fix needs a per-message final identity core does not expose for
    // finals; deferred to the Phase 3 snapshot. This test pins the CURRENT
    // behaviour so a future change to it is deliberate.
    const h = makeDraftHarness();
    h.draft.handleAssistantMessageBoundary();
    h.draft.pushAnswerText({ text: "the ans" }); // lane A (gen 0), the only text lane
    await h.draft.flush();
    h.draft.handleAssistantMessageBoundary(); // → tool-only lane (gen 1, textless current); A auto-settles
    const idA = h.frames.find((frame) => frame.text === "the ans")!.id;

    await expect(h.draft.finalize("the answer")).resolves.toBe(true); // buffered
    await h.draft.drain();

    // K==1 → the final tops up the current (tool) lane, a SEPARATE bubble from A.
    const idTool = h.frames.find((frame) => frame.text === "the answer")!.id;
    expect(idTool).not.toBe(idA);
    expect(bubbleOrder(h.frames)).toEqual(["the ans", "the answer"]);
  });

  it("M173e: KNOWN LIMITATION (K>=2 mid-lane materialization failure) — positional pairing shifts", async () => {
    // Same #111 final-identity ceiling as Case X, at the K>=2 branch. Topology
    // A,B,C (all text) + a tool-only LAST message; B's frames drop on a transient
    // wire failure so B never materializes. Core emits finals [tA,tB,tC].
    // `materializedAnswerLanes()` correctly excludes B (per M13g's rule), leaving
    // [A,C], so positional pairing shifts: tA→A (right), tB→C (WRONG lane), tC→
    // overflow→independent. Finals are identity-less, so no sound recovery exists
    // at this layer; the Phase 3 authoritative snapshot is the real fix. This test
    // PINS the current behaviour so a change to it is deliberate — do NOT add
    // mitigation code to make it "pass differently."
    const h = makeDraftHarness({
      // Fail every frame carrying B's text (progress AND final) so lane B never
      // materializes, modelling a mid-sequence transient publish failure.
      decide: (attempt) => attempt.text !== "B",
    });
    h.draft.handleAssistantMessageBoundary(); // first boundary: no-op
    h.draft.pushAnswerText({ text: "A" }); // lane A (gen 0)
    await h.draft.flush();
    h.draft.handleAssistantMessageBoundary(); // → lane B; A auto-settles (materializes)
    h.draft.pushAnswerText({ text: "B" }); // lane B (gen 1) — its frames all fail
    await h.draft.flush();
    h.draft.handleAssistantMessageBoundary(); // → lane C; B auto-settle FAILS (not materialized)
    h.draft.pushAnswerText({ text: "C" }); // lane C (gen 2)
    await h.draft.flush();
    h.draft.handleAssistantMessageBoundary(); // → tool-only lane (gen 3, textless current); C auto-settles

    const idA = h.frames.find((frame) => frame.text === "A")!.id;
    const idC = h.frames.find((frame) => frame.text === "C")!.id;
    // Lane B never shipped a single frame.
    expect(h.frames.some((frame) => frame.text === "B")).toBe(false);

    await expect(h.draft.finalize("tA")).resolves.toBe(true); // buffered
    await expect(h.draft.finalize("tB")).resolves.toBe(true); // buffered
    await expect(h.draft.finalize("tC")).resolves.toBe(true); // buffered
    await h.draft.drain();

    // tA → A (correct); tB → C (WRONG lane — the pinned limitation); tC → independent.
    const lastFinalOn = (id: string) =>
      h.frames.filter((frame) => frame.type === "final" && frame.id === id).at(-1)!.text;
    expect(lastFinalOn(idA)).toBe("tA");
    expect(lastFinalOn(idC)).toBe("tB");
    const tcFrame = h.frames.find((frame) => frame.text === "tC")!;
    expect(tcFrame.id).not.toBe(idA);
    expect(tcFrame.id).not.toBe(idC);
  });

  // #212 (Phase 3, targeted) — the authoritative `turn_snapshot` emitted at drain.
  // These ADD snapshot assertions on the #215 shapes; the existing frame-level
  // assertions above (M173a-e) are deliberately left unchanged.
  it("M212a: mid-lane K>=2 — snapshot carries streamed [A][B][C] and removes the overflow bubble", async () => {
    // Same topology as M173e: A,B,C all stream; B's frames all fail (never
    // materializes); tool-only last. Finals [tA,tB,tC] mis-route (tB→C, tC→
    // independent). The snapshot must yield the CORRECT ordered STREAMED content
    // regardless: [A][B][C], with the overflow bubble named in `remove`.
    const h = makeDraftHarness({ decide: (attempt) => attempt.text !== "B" });
    h.draft.handleAssistantMessageBoundary();
    h.draft.pushAnswerText({ text: "A" });
    await h.draft.flush();
    h.draft.handleAssistantMessageBoundary();
    h.draft.pushAnswerText({ text: "B" }); // frames fail → not materialized, no lane id
    await h.draft.flush();
    h.draft.handleAssistantMessageBoundary();
    h.draft.pushAnswerText({ text: "C" });
    await h.draft.flush();
    h.draft.handleAssistantMessageBoundary(); // tool-only last

    const idA = h.frames.find((frame) => frame.text === "A")!.id;
    const idC = h.frames.find((frame) => frame.text === "C")!.id;

    await h.draft.finalize("tA");
    await h.draft.finalize("tB");
    await h.draft.finalize("tC");
    await h.draft.drain();

    const tcId = h.frames.find((frame) => frame.text === "tC")!.id;
    expect(h.snapshots).toHaveLength(1);
    const snap = h.snapshots[0];
    expect(snap.turnId).toBe("turn-1");
    // Streamed content, in generation order — immune to the mis-routed finals.
    expect(snap.answers.map((a) => a.text)).toEqual(["A", "B", "C"]);
    // A and C keep their materialized ids; B (never materialized) gets a minted id.
    expect(snap.answers[0].id).toBe(idA);
    expect(snap.answers[2].id).toBe(idC);
    expect(snap.answers[1].id).not.toBe(idA);
    expect(snap.answers[1].id).not.toBe(idC);
    // The overflow independent bubble is named for removal; the answer ids are not.
    expect(snap.remove).toEqual([tcId]);
    expect(snap.remove).not.toContain(idA);
    expect(snap.remove).not.toContain(idC);
  });

  it("M212a2 (P3-F1): clean K>=2 tool-only-last — the snapshot carries each lane's FULL authoritative final, not the truncated partial", async () => {
    // The provably-sound K>=2 shape (M173a at the frame level): A and B both
    // stream AND materialize, then a tool-only LAST message leaves the current
    // lane textless. Core buffers finals [tA,tB] and drain pairs them one-to-one
    // onto [A,B] — no overflow, every text lane streamed, so the routing is
    // certain. Each final's tail therefore belongs to its lane and the snapshot
    // MUST show the FULL final text ("first answer"/"second answer"), NOT the last
    // streamed partial ("first ans"/"second ans"). Before P3-F1 the buffered path
    // left `answerText` non-authoritative on THIS sound path too, so the snapshot
    // collapsed each lane back to its partial (a truncated tail on reload).
    const h = makeDraftHarness();
    h.draft.handleAssistantMessageBoundary(); // first boundary: no-op
    h.draft.pushAnswerText({ text: "first ans" }); // lane A (gen 0), streams + materializes
    await h.draft.flush();
    h.draft.handleAssistantMessageBoundary(); // → lane B; A auto-settles
    h.draft.pushAnswerText({ text: "second ans" }); // lane B (gen 1), streams + materializes
    await h.draft.flush();
    h.draft.handleAssistantMessageBoundary(); // → tool-only lane (gen 2), textless current
    const idA = h.frames.find((frame) => frame.text === "first ans")!.id;
    const idB = h.frames.find((frame) => frame.text === "second ans")!.id;

    await h.draft.finalize("first answer"); // buffered (textless current lane)
    await h.draft.finalize("second answer"); // buffered
    await h.draft.drain();

    expect(idA).not.toBe(idB);
    expect(h.snapshots).toHaveLength(1);
    const snap = h.snapshots[0];
    // The full, correctly-routed final for each streamed lane — no truncation.
    expect(snap.answers).toEqual([
      { id: idA, text: "first answer" },
      { id: idB, text: "second answer" },
    ]);
    // One-to-one pairing, no overflow bubble to supersede.
    expect(snap.remove).toEqual([]);
  });

  it("M212b: Case X (K==1) — snapshot is [A] streamed with an EMPTY remove; the tool bubble is untouched (M173d preserved)", async () => {
    // Byte-identical to M173c at the plugin layer, so the snapshot deliberately
    // does NOT touch the tool bubble: it is neither an answer lane (never
    // streamed) nor superseded. M173d's frame-level behaviour is unchanged.
    const h = makeDraftHarness();
    h.draft.handleAssistantMessageBoundary();
    h.draft.pushAnswerText({ text: "the ans" });
    await h.draft.flush();
    h.draft.handleAssistantMessageBoundary(); // tool-only last
    const idA = h.frames.find((frame) => frame.text === "the ans")!.id;

    await h.draft.finalize("the answer");
    await h.draft.drain();

    // Frame-level M173d still holds: two bubbles, the final on the tool lane.
    expect(bubbleOrder(h.frames)).toEqual(["the ans", "the answer"]);

    expect(h.snapshots).toHaveLength(1);
    const snap = h.snapshots[0];
    expect(snap.answers).toEqual([{ id: idA, text: "the ans" }]);
    expect(snap.remove).toEqual([]);
    // The mis-routed tool bubble is NOT named — the client preserves it.
    const toolId = h.frames.find((frame) => frame.text === "the answer")!.id;
    expect(snap.remove).not.toContain(toolId);
    expect(snap.answers.map((a) => a.id)).not.toContain(toolId);
  });

  it("M212c: collapse with a non-streaming last message — snapshot is [A][B] with empty remove; message C is left intact", async () => {
    // M173c shape: A,B stream; C has text but streams no partial → its final is
    // routed to C's textless lane (a legitimate NEW bubble). The snapshot must NOT
    // claim to remove or reorder C — C is neither in `answers` (it never streamed)
    // nor in `remove`, so the client preserves it exactly.
    const h = makeDraftHarness();
    h.draft.handleAssistantMessageBoundary();
    h.draft.pushAnswerText({ text: "message A" });
    await h.draft.flush();
    h.draft.handleAssistantMessageBoundary();
    h.draft.pushAnswerText({ text: "message B" });
    await h.draft.flush();
    h.draft.handleAssistantMessageBoundary(); // lane C, textless current
    const idA = h.frames.find((frame) => frame.text === "message A")!.id;
    const idB = h.frames.find((frame) => frame.text === "message B")!.id;

    await h.draft.finalize("message C");
    await h.draft.drain();

    // Frame-level M173c still holds.
    expect(bubbleOrder(h.frames)).toEqual(["message A", "message B", "message C"]);
    const idC = h.frames.find((frame) => frame.text === "message C")!.id;

    expect(h.snapshots).toHaveLength(1);
    const snap = h.snapshots[0];
    expect(snap.answers).toEqual([
      { id: idA, text: "message A" },
      { id: idB, text: "message B" },
    ]);
    expect(snap.remove).toEqual([]);
    // C's legitimate bubble is neither reordered nor removed.
    expect(snap.answers.map((a) => a.id)).not.toContain(idC);
    expect(snap.remove).not.toContain(idC);
  });

  it("M212d: a streamed collapse — the current lane's AUTHORITATIVE final text is kept (tail not truncated), empty remove", async () => {
    // M173b shape: A and B stream, B is the last and text-bearing so its final
    // settles it via the IMMEDIATE (correctly-routed) path. That final is
    // authoritative for B, so the snapshot shows B's FINAL text ("second answer",
    // NOT the streamed "second ans"). A received no final of its own, so it keeps
    // its streamed text.
    const h = makeDraftHarness();
    h.draft.handleAssistantMessageBoundary();
    h.draft.pushAnswerText({ text: "first ans" });
    await h.draft.flush();
    h.draft.handleAssistantMessageBoundary();
    h.draft.pushAnswerText({ text: "second ans" });
    await h.draft.flush();
    const idA = h.frames.find((frame) => frame.text === "first ans")!.id;
    const idB = h.frames.find((frame) => frame.text === "second ans")!.id;

    await h.draft.finalize("second answer");
    await h.draft.drain();

    expect(h.snapshots).toHaveLength(1);
    const snap = h.snapshots[0];
    expect(snap.answers).toEqual([
      { id: idA, text: "first ans" }, // no final of its own → streamed text
      { id: idB, text: "second answer" }, // correctly-routed final → authoritative
    ]);
    expect(snap.remove).toEqual([]);
  });

  it("M212d2: a lone collapse whose final adds a tail BEYOND the last partial — the snapshot keeps the FULL final text (tail-preservation guard)", async () => {
    // The open VERIFY-1 edge: core's message_end reconciliation can make the final
    // longer than the last streamed partial. On the common immediate path the
    // final is correctly routed to its own lane, so the snapshot MUST show the
    // full final text — dropping the tail would regress the common path and the
    // north-star "final is not droppable".
    const h = makeDraftHarness();
    h.draft.handleAssistantMessageBoundary();
    h.draft.pushAnswerText({ text: "Hello" }); // last partial is a strict prefix
    await h.draft.flush();
    const id = h.frames.find((frame) => frame.text === "Hello")!.id;

    await h.draft.finalize("Hello, world — the full answer."); // final adds a tail
    await h.draft.drain();

    expect(h.snapshots).toHaveLength(1);
    const snap = h.snapshots[0];
    expect(snap.answers).toEqual([
      { id, text: "Hello, world — the full answer." },
    ]);
    expect(snap.remove).toEqual([]);
  });

  it("M212e: an independent NOTICE final is never named in `remove` and never an answer", async () => {
    // A notice (deliverIndependentFinal) is UNIQUE content, not answer content —
    // it must be preserved by the client, so it is neither in `answers` nor in
    // `remove`.
    const h = makeDraftHarness();
    h.draft.handleAssistantMessageBoundary();
    h.draft.pushAnswerText({ text: "the answer" });
    await h.draft.flush();
    const idA = h.frames.find((frame) => frame.text === "the answer")!.id;

    await h.draft.deliverIndependentFinal({ text: "Heads up: something happened.", isStatusNotice: true });
    await h.draft.drain();

    const noticeId = h.frames.find((frame) => frame.text === "Heads up: something happened.")!.id;
    expect(h.snapshots).toHaveLength(1);
    const snap = h.snapshots[0];
    expect(snap.answers.map((a) => a.id)).toEqual([idA]);
    expect(snap.remove).toEqual([]);
    expect(snap.remove).not.toContain(noticeId);
  });

  it("M212f: a failed-lane recovery block is named in `remove` (its lane is now an answer)", async () => {
    // M172b shape: A streams but its progress frame fails (not materialized); the
    // authorized block recovers A's content independently. Under the snapshot, A's
    // streamed text IS an answer (minted id), so the recovery block DUPLICATES it
    // and is named in `remove`.
    const h = makeDraftHarness({
      decide: (attempt) =>
        attempt.type === "progress" && attempt.text === "A answer" ? false : true,
    });
    h.draft.handleAssistantMessageBoundary();
    h.draft.pushAnswerText({ text: "A answer" });
    await h.draft.flush(); // progress fails → lane streamed but not materialized (no id)
    await h.draft.deliverAuthorizedBlock({ text: "A answer", assistantMessageIndex: 1 });
    await h.draft.drain();

    const blockId = h.frames.find((frame) => frame.text === "A answer")!.id;
    expect(h.snapshots).toHaveLength(1);
    const snap = h.snapshots[0];
    // A appears as an answer (minted id, streamed text); the recovery block is removed.
    expect(snap.answers.map((a) => a.text)).toEqual(["A answer"]);
    expect(snap.remove).toEqual([blockId]);
  });

  it("M212g: an overflow final whose message NEVER STREAMED is UNIQUE content — never named in `remove` (content-loss guard)", async () => {
    // K>=2 tool-only-last turn where the last text message C streams NO partial
    // (its content lives only in its final). A,B stream and materialize; C does
    // not, so `materializedAnswerLanes()` = [A,B] and C's final tC OVERFLOWS to an
    // independent bubble. C is NOT in `answers` (it never streamed), so tC is
    // UNIQUE content — marking it in `remove` would make the client DELETE it (a
    // regression vs the pre-#212 mis-ordered-but-visible bubble). The turn-level
    // guard (streamed-lane-count 2 != finals-count 3) must leave `remove` empty.
    const h = makeDraftHarness();
    h.draft.handleAssistantMessageBoundary(); // first boundary: no-op
    h.draft.pushAnswerText({ text: "A" }); // lane A (gen 0), streams + materializes
    await h.draft.flush();
    h.draft.handleAssistantMessageBoundary(); // → lane B; A auto-settles
    h.draft.pushAnswerText({ text: "B" }); // lane B (gen 1), streams + materializes
    await h.draft.flush();
    h.draft.handleAssistantMessageBoundary(); // → lane C (gen 2); B auto-settles
    // Lane C streams NOTHING — a non-streaming text message.
    h.draft.handleAssistantMessageBoundary(); // → tool-only lane (gen 3); C is textless

    const idA = h.frames.find((frame) => frame.text === "A")!.id;
    const idB = h.frames.find((frame) => frame.text === "B")!.id;

    await h.draft.finalize("tA");
    await h.draft.finalize("tB");
    await h.draft.finalize("tC"); // C's final — its ONLY delivery of C's content
    await h.draft.drain();

    // tC overflows to an independent bubble (C never materialized as a lane).
    const tcFrame = h.frames.find((frame) => frame.text === "tC")!;
    expect(tcFrame.id).not.toBe(idA);
    expect(tcFrame.id).not.toBe(idB);

    expect(h.snapshots).toHaveLength(1);
    const snap = h.snapshots[0];
    // Only the streamed messages are answers; C is not (it never streamed).
    expect(snap.answers).toEqual([
      { id: idA, text: "A" },
      { id: idB, text: "B" },
    ]);
    // CRITICAL: the unique overflow bubble is NOT named for removal — its content
    // is not in `answers`, so the client must preserve it.
    expect(snap.remove).toEqual([]);
    expect(snap.remove).not.toContain(tcFrame.id);
  });

  // #172 — a block carries no content the partials did not already stream (core
  // feeds the same visible text to `onPartialReply` and the block chunker). When
  // a message's own lane has already rendered that content, re-delivering the
  // block as an independent bubble double-renders it (2 messages → 4 bubbles).
  // The controller stamps each lane with core's 1-based `assistantMessageIndex`
  // from the boundary callbacks and suppresses a block whose stamped lane has
  // materialized — while preserving independent delivery for every recovery
  // shape (unmatched/unstamped/failed-lane/index-less).
  it("M172a: a 2-message partial+block turn renders 2 lane bubbles, no independent block bubbles (redundant blocks suppressed)", async () => {
    const h = makeDraftHarness();
    // Message A: boundary #1 (swallowed) stamps the gen-0 lane index 1, the
    // partial streams and materializes A's bubble.
    h.draft.handleAssistantMessageBoundary();
    h.draft.pushAnswerText({ text: "A answer" });
    await h.draft.flush();
    const idA = h.frames.find((frame) => frame.text === "A answer")!.id;
    // Core re-delivers A's already-streamed text as an authorized block carrying
    // its 1-based index → redundant with the lane → suppressed (no wire frame).
    await expect(
      h.draft.deliverAuthorizedBlock({ text: "A answer", assistantMessageIndex: 1 }),
    ).resolves.toBe(false);

    // Message B: boundary #2 rotates to a fresh lane stamped index 2.
    h.draft.handleAssistantMessageBoundary();
    h.draft.pushAnswerText({ text: "B answer" });
    await h.draft.flush();
    const idB = h.frames.find((frame) => frame.text === "B answer")!.id;
    await expect(
      h.draft.deliverAuthorizedBlock({ text: "B answer", assistantMessageIndex: 2 }),
    ).resolves.toBe(false);

    await h.draft.drain();

    expect(idA).not.toBe(idB);
    // Exactly two bubbles — the two lanes — and NO independent block bubble.
    expect(successfulIds(h.frames)).toEqual([idA, idB]);
    expect(bubbleOrder(h.frames)).toEqual(["A answer", "B answer"]);
  });

  it("M172b: a lane whose partial frame failed to ship is NOT materialized, so its block STILL delivers independently (recovery preserved)", async () => {
    const h = makeDraftHarness({
      decide: (attempt) =>
        attempt.type === "progress" && attempt.text === "A answer" ? false : true,
    });
    h.draft.handleAssistantMessageBoundary(); // stamps the gen-0 lane index 1
    h.draft.pushAnswerText({ text: "A answer" });
    await h.draft.flush(); // progress send FAILS → lane streamed but not materialized
    expect(h.frames.filter((frame) => frame.text === "A answer")).toEqual([]);

    // The block is A's only chance to reach the client, so it must NOT be
    // suppressed — it degrades to independent delivery.
    await expect(
      h.draft.deliverAuthorizedBlock({ text: "A answer", assistantMessageIndex: 1 }),
    ).resolves.toBe(true);
    expect(h.frames.some((frame) => frame.text === "A answer")).toBe(true);
  });

  it("M172c: a block whose index matches no stamped lane still delivers independently (degradation)", async () => {
    const h = makeDraftHarness();
    h.draft.handleAssistantMessageBoundary(); // stamps the gen-0 lane index 1
    h.draft.pushAnswerText({ text: "A answer" });
    await h.draft.flush();

    // Index 2 was never stamped onto any lane (no second boundary opened it), so
    // there is nothing to match — the block cannot be proven redundant and is
    // delivered rather than dropped.
    await expect(
      h.draft.deliverAuthorizedBlock({ text: "late block", assistantMessageIndex: 2 }),
    ).resolves.toBe(true);
    expect(h.frames.some((frame) => frame.text === "late block")).toBe(true);
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
        h.draft.noteDeliveryLifecycle(lifecycle, {
          deliveryKind: "block",
          assistantMessageIndex: 0,
        });
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
    h.draft.noteDeliveryLifecycle("settled", {
      deliveryKind: "block",
      assistantMessageIndex: 0,
    });
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
    h.draft.noteDeliveryLifecycle("settled", { deliveryKind: "block" });
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

  it("M6g/F5: actual notices stay independent without settling a real-block barrier", async () => {
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
      await h.draft.deliverAuthorizedBlock({ text: "prior actual block" });
      h.draft.noteDeliveryLifecycle("settled", {
        deliveryKind: "block",
        assistantMessageIndex: 0,
      });
      h.draft.noteBlockReplyQueued({ assistantMessageIndex: 0 });
      h.draft.handleAssistantMessageBoundary();
      h.draft.pushAnswerText({ text: "B" });
      await h.draft.deliverAuthorizedBlock({ text: "actual notice", ...flag });
      h.draft.noteDeliveryLifecycle("settled", {
        deliveryKind: "block",
        assistantMessageIndex: 0,
      });
      expect(h.frames.some((frame) => frame.text === "B")).toBe(false);

      await h.draft.deliverAuthorizedBlock({ text: "actual block" });
      h.draft.noteDeliveryLifecycle("settled", {
        deliveryKind: "block",
        assistantMessageIndex: 0,
      });
      const idB = h.frames.find((frame) => frame.text === "B")!.id;
      const noticeId = h.frames.find((frame) => frame.text === "actual notice")!.id;
      const blockId = h.frames.find((frame) => frame.text === "actual block")!.id;
      const priorBlockId = h.frames.find((frame) => frame.text === "prior actual block")!.id;
      expect(new Set([idA, idB, noticeId, blockId, priorBlockId]).size).toBe(5);
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
      h.draft.noteDeliveryLifecycle(lifecycle, {
        deliveryKind: "block",
        assistantMessageIndex: 0,
      });
      expect(h.frames.map((frame) => frame.text)).toEqual(["B"]);
    }

    const cleanupBeforeBoundary = makeDraftHarness();
    cleanupBeforeBoundary.draft.handleAssistantMessageBoundary();
    cleanupBeforeBoundary.draft.noteBlockReplyQueued({ assistantMessageIndex: 0 });
    cleanupBeforeBoundary.draft.noteDeliveryLifecycle("skip", {
      deliveryKind: "block",
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
    indexless.draft.noteDeliveryLifecycle("cancel", { deliveryKind: "block" });
    expect(indexless.frames).toEqual([]);
    await indexless.draft.drain();
    expect(indexless.frames.map((frame) => frame.text)).toEqual(["B"]);

    const duplicate = makeDraftHarness();
    duplicate.draft.handleAssistantMessageBoundary();
    duplicate.draft.handleAssistantMessageBoundary();
    duplicate.draft.pushAnswerText({ text: "B" });
    duplicate.draft.noteBlockReplyQueued({ assistantMessageIndex: 0 });
    duplicate.draft.noteBlockReplyQueued({ assistantMessageIndex: 0 });
    duplicate.draft.noteDeliveryLifecycle("settled", {
      deliveryKind: "block",
      assistantMessageIndex: 0,
    });
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
      deliveryKind: "block",
      assistantMessageIndex: 0,
      isStatusNotice: true,
    });
    h.draft.noteBlockReplyQueued({ assistantMessageIndex: 0 });
    h.draft.handleAssistantMessageBoundary();
    h.draft.pushAnswerText({ text: "B" });

    expect(h.frames.map((frame) => frame.text)).toEqual(["A", "A"]);
    h.draft.noteDeliveryLifecycle("cancel", {
      deliveryKind: "block",
      assistantMessageIndex: 0,
    });
    expect(h.frames.map((frame) => frame.text)).toEqual(["A", "A", "B"]);
  });

  /**
   * SUPERSEDED EXPECTATION, deliberately rewritten (#94 round 8). This fixture
   * used to assert that a block and a notice sharing an index stay ambiguous
   * FOREVER — B was held until terminal drain. That was the old
   * `retireSoleLifecycleRecord` cardinality bail, and it is the defect this
   * round removes: two records at one index meant NEITHER ever retired, which
   * with the turn-wide release gate stalled the whole turn.
   *
   * Cardinality is gone from BOTH paths now. The `skip` carries its payload, so
   * it retires the NOTICE token it names; the settlement is paired with the real
   * block delivery, so it retires that block's reservation. Each record is
   * released by its own event and the barrier lifts as soon as its own block has
   * settled, instead of both sitting pending until drain because they happened
   * to share an index.
   */
  it("M6h/F3: a shared index strands nothing — each record retires on its own event", async () => {
    const h = makeDraftHarness();
    h.draft.handleAssistantMessageBoundary();
    h.draft.pushAnswerText({ text: "A" });
    h.draft.noteBlockReplyQueued({ assistantMessageIndex: 0 });
    h.draft.noteBlockReplyQueued({ assistantMessageIndex: 0, isStatusNotice: true });
    h.draft.handleAssistantMessageBoundary();
    h.draft.pushAnswerText({ text: "B partial" });

    h.draft.noteDeliveryLifecycle("skip", {
      deliveryKind: "block",
      assistantMessageIndex: 0,
      isStatusNotice: true,
    });
    await h.draft.deliverAuthorizedBlock({ text: "F-A" });
    h.draft.noteDeliveryLifecycle("settled", {
      deliveryKind: "block",
      assistantMessageIndex: 0,
    });
    // The skip retired the notice token it named; the real block's own
    // settlement then released ITS reservation, and B follows in order — no
    // longer stranded until drain.
    expect(h.frames.map((frame) => frame.text)).toEqual(["A", "A", "F-A", "B partial"]);

    await h.draft.drain();
    expect(h.frames.map((frame) => frame.text)).toEqual([
      "A",
      "A",
      "F-A",
      "B partial",
      "B partial",
    ]);
  });

  it("M6h/F4: an indexed skip opens an empty predecessor barrier", async () => {
    const h = makeDraftHarness();
    h.draft.handleAssistantMessageBoundary();
    h.draft.noteBlockReplyQueued({ assistantMessageIndex: 0 });
    h.draft.handleAssistantMessageBoundary();
    h.draft.pushAnswerText({ text: "B partial" });
    await h.draft.flush();
    expect(h.attempts).toEqual([]);

    h.draft.noteDeliveryLifecycle("skip", {
      deliveryKind: "block",
      assistantMessageIndex: 0,
    });
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
    h.draft.noteDeliveryLifecycle("settled", {
      deliveryKind: "block",
      assistantMessageIndex: 0,
    });
    expect(h.frames.map((frame) => frame.text)).toEqual(["F-A1"]);

    await h.draft.deliverAuthorizedBlock({ text: "F-A2" });
    h.draft.noteDeliveryLifecycle("settled", { deliveryKind: "block" });
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
    h.draft.noteDeliveryLifecycle("settled", {
      deliveryKind: "block",
      assistantMessageIndex: 0,
    });
    expect(h.frames.map((frame) => frame.text)).toEqual(["A", "A", "actual-1", "B"]);

    h.draft.noteBlockReplyQueued({ assistantMessageIndex: 0 });
    h.draft.handleAssistantMessageBoundary();
    h.draft.pushAnswerText({ text: "C" });
    const beforeDuplicateSettled = [...h.frames];
    h.draft.noteDeliveryLifecycle("settled", {
      deliveryKind: "block",
      assistantMessageIndex: 0,
    });
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
      h.draft.noteDeliveryLifecycle("settled", { deliveryKind: "block" });
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

  /**
   * #94 — mid-stream `<thinking>`: the cleaned cumulative text goes BACKWARDS
   * while the provider is still appending to the same message.
   *
   * Measured through the SDK's own strippers (the exact sequence below):
   *   "Hi"                              -> "Hi"
   *   "Hi <"                            -> "Hi <"
   *   "Hi <thi"                         -> "Hi <thi"
   *   "Hi <thinking>"                   -> "Hi"        <- SHRINK
   *   "Hi <thinking>z</thinking> there" -> "Hi  there" <- and now it diverges
   *
   * Two separate guards are needed and BOTH are load-bearing here: without the
   * shrink guard the fourth partial renders backwards flicker AND makes the
   * fifth look like a new message; without the raw-extension term in the
   * missed-boundary check the fifth rotates the lane on its own. Either failure
   * splits one answer across two bubbles.
   */
  /**
   * #94 — the tool-only first assistant message.
   *
   * Lane 0 closes with no text (the message was only a tool call), so it is an
   * unresolved ordering barrier in front of lane 1. Until this fix it stayed
   * that way until terminal drain and the answer streamed NOTHING — the live
   * defect the e2e turn-2 fixture reproduces against a real gateway.
   *
   * The barrier is real for a DIFFERENT lane shape (a message whose text is
   * still coming as a block), and the two are indistinguishable at this instant,
   * so the release is time-boxed to one streaming window rather than immediate.
   */
  it("M6j: a text-less predecessor releases the live lane after one streaming window", async () => {
    vi.useFakeTimers();
    try {
      const h = makeDraftHarness({ throttleMs: 600 });
      h.draft.handleAssistantMessageBoundary();
      h.draft.pushEvent(toolStart());
      await h.draft.flush();
      const scaffoldFrames = h.frames.length;
      expect(scaffoldFrames).toBe(1);

      h.draft.handleAssistantMessageBoundary();
      h.draft.pushAnswerText({ text: "the answer" });
      await h.draft.flush();
      // Inside the window the barrier still holds — a late block for lane 0
      // would still land first.
      expect(h.frames).toHaveLength(scaffoldFrames);

      // A tool event lands just before the release, so the progress throttle is
      // freshly closed. The released frame must not wait behind it: on a turn
      // whose answer is shorter than one throttle interval, that wait means the
      // settle discards the frame and the answer never streams at all.
      await vi.advanceTimersByTimeAsync(590);
      h.draft.pushEvent(toolStart("tool-2"));
      await h.draft.flush();
      const beforeRelease = h.frames.length;

      await vi.advanceTimersByTimeAsync(10);
      expect(h.frames).toHaveLength(beforeRelease + 1);
      expect(h.frames.at(-1)).toMatchObject({ type: "progress", text: "the answer" });
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * The release must refuse to go PAST a predecessor that is unresolved for any
   * reason other than being empty. The M6b/M6c fixtures pin that barrier before
   * the window — they run on resolved-promise chains, so no macrotask boundary
   * is crossed and the timer never fires — which leaves the timer path itself
   * unpinned. These are their in-window twins.
   */
  it.each([
    ["an indexed reservation", { assistantMessageIndex: 0 }],
    ["an indexless reservation", {}],
  ])("M6m: the release never crosses a predecessor holding %s", async (_name, queued) => {
    vi.useFakeTimers();
    try {
      const h = makeDraftHarness({ throttleMs: 600 });
      h.draft.handleAssistantMessageBoundary();
      h.draft.handleAssistantMessageBoundary();
      h.draft.pushAnswerText({ text: "B partial" });
      // The late block for the text-less first message lands INSIDE the window:
      // this is the shape the barrier exists for.
      h.draft.noteBlockReplyQueued(queued);
      await h.draft.flush();

      await vi.advanceTimersByTimeAsync(1_500);
      expect(h.frames).toEqual([]);

      // …and the barrier still resolves the ordinary way.
      await h.draft.deliverAuthorizedBlock({ text: "fallback-A" });
      h.draft.noteDeliveryLifecycle("settled", {
        deliveryKind: "block",
        ...queued,
      });
      await h.draft.drain();
      // Message 0's block is on the wire FIRST — the ordering the barrier
      // exists to protect — and B settles exactly once behind it. (The indexed
      // variant also emits B's progress once the reservation retires, so assert
      // the order and the settle count rather than an exact frame list.)
      const texts = h.frames.map((frame) => frame.text);
      expect(texts[0]).toBe("fallback-A");
      expect(texts.slice(1).every((text) => text === "B partial")).toBe(true);
      expect(
        h.frames.filter((frame) => frame.type === "final" && frame.text === "B partial"),
      ).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("M6r: a tool-only lane releases TWO following messages, not just the first", async () => {
    // The release scan runs against `currentLane()` at FIRE time. With a second
    // successor, that is C — and B is by then closed, unresolved and holding
    // text, because lane 0 is still blocking it. Treating B as a barrier
    // deadlocks the pair: lane 0 blocks B, B's unresolved state blocks lane 0's
    // release, and rescheduling fails identically forever, so NEITHER message
    // streams. B is a fellow victim of the same block, not a barrier.
    vi.useFakeTimers();
    try {
      const h = makeDraftHarness({ throttleMs: 600 });
      h.draft.handleAssistantMessageBoundary();
      h.draft.pushEvent(toolStart()); // lane 0: tool-only
      h.draft.handleAssistantMessageBoundary();
      h.draft.pushAnswerText({ text: "B text" }); // lane 1 — schedules the release
      h.draft.handleAssistantMessageBoundary();
      h.draft.pushAnswerText({ text: "C text" }); // lane 2 — B closes before it fires
      await h.draft.flush();

      await vi.advanceTimersByTimeAsync(1_500);
      // B settles in model order, C streams live behind it.
      expect(h.frames.some((frame) => frame.type === "final" && frame.text === "B text")).toBe(
        true,
      );
      expect(h.frames.some((frame) => frame.text === "C text")).toBe(true);

      await h.draft.drain();
      const finals = h.frames.filter((frame) => frame.type === "final");
      expect(finals.map((frame) => frame.text)).toEqual(["B text", "C text"]);
      expect(new Set(finals.map((frame) => frame.id)).size).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * #94 — the index base and the release timer meet.
   *
   * Core's queued-block context is 1-BASED on the pinned core (message A = 1),
   * while lane generations are 0-based, so `assistantMessageIndexMatchesLane`
   * mis-attaches A's reservation to B — or, when A's block is queued while A is
   * still the current lane, attaches it nowhere at all because generation 1 does
   * not exist yet. Either way lane A is left text-less with an EMPTY barrier
   * list, which is exactly the shape the release timer treats as "tool-only,
   * nothing is coming". It then releases A and B streams ahead of A's block.
   *
   * Measured before the fix, as bubble first-appearance order (which is what
   * decides screen position — a terminal frame lands in the bubble its first
   * frame created):  ["B text", "A block"].
   *
   * These fixtures are deliberately 1-BASED. A 0-based fixture cannot see this
   * defect at all, and 0 is a value the pinned core never emits.
   */
  it("M6t: a pending block reservation blocks the release, whatever lane it attached to", async () => {
    vi.useFakeTimers();
    try {
      const h = makeDraftHarness({ throttleMs: 600 });
      h.draft.handleAssistantMessageBoundary(); // lane 0 = A, text-less
      h.draft.noteBlockReplyQueued({ assistantMessageIndex: 1 }); // A's block, 1-based
      h.draft.handleAssistantMessageBoundary(); // lane 1 = B
      h.draft.pushAnswerText({ text: "B text" });
      await h.draft.flush();

      await vi.advanceTimersByTimeAsync(1_500);
      expect(h.frames).toEqual([]); // B must not stream while A's block is in flight

      await h.draft.deliverAuthorizedBlock({ text: "A block" });
      await h.draft.drain();

      const firstAppearance: string[] = [];
      for (const frame of h.frames) {
        if (!firstAppearance.includes(frame.id)) firstAppearance.push(frame.id);
      }
      const textOf = (id: string) => h.frames.find((frame) => frame.id === id)!.text;
      expect(firstAppearance.map(textOf)).toEqual(["A block", "B text"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("M6u: a retired reservation stops blocking the release", async () => {
    // The gate is turn-wide, so it has to clear the ordinary way or it would
    // reintroduce the stall it is guarding.
    vi.useFakeTimers();
    try {
      const h = makeDraftHarness({ throttleMs: 600 });
      h.draft.handleAssistantMessageBoundary();
      h.draft.noteBlockReplyQueued({ assistantMessageIndex: 1 });
      h.draft.handleAssistantMessageBoundary();
      h.draft.pushAnswerText({ text: "B text" });
      await h.draft.deliverAuthorizedBlock({ text: "A block" });
      h.draft.noteDeliveryLifecycle("settled", {
        deliveryKind: "block",
        assistantMessageIndex: 1,
      });
      await h.draft.flush();

      await vi.advanceTimersByTimeAsync(1_500);
      expect(h.frames.map((frame) => frame.text)).toEqual(["A block", "B text"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("M6v: a scaffold frame never evicts a pending answer frame", async () => {
    // One pending slot, last-write-wins across kinds: a tool event arriving
    // while an answer frame is queued-but-unsent used to replace it, and the
    // answer's first visible update was simply lost. Bounded to before the
    // answer's first SENT frame (after that, previews are gated off), which is
    // precisely the opening of a tool-first turn.
    vi.useFakeTimers();
    try {
      const h = makeDraftHarness({ throttleMs: 600 });
      h.draft.handleAssistantMessageBoundary();
      h.draft.pushEvent(toolStart()); // sends, closing the throttle window
      expect(h.frames).toHaveLength(1);

      // No `flush()` anywhere in here: flushing force-sends the pending frame
      // and would hide the very eviction this pins.
      h.draft.pushAnswerText({ text: "answer text" }); // queued, not yet sent
      h.draft.pushEvent(toolStart("tool-2")); // must NOT take the pending slot
      expect(h.frames).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(600);
      expect(h.frames.at(-1)).toMatchObject({ type: "progress", text: "answer text" });
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * #94 — one assistant message emitting TWO block payloads.
   *
   * CROSSES TWO GUARDS: `retireSoleLifecycleRecord`'s cardinality bail and the
   * turn-wide pending-reservation gate. Core stamps every block payload of a
   * message with that message's index (plan §14.4), so two blocks means two
   * records at one index — which the old "exactly one candidate" rule refused to
   * retire, leaving BOTH pending and, through the gate, stalling the whole turn.
   * One settlement retires one record, so N records drain in N settlements.
   */
  it("M6w: two blocks in one assistant message both retire, and the turn keeps streaming", async () => {
    vi.useFakeTimers();
    try {
      const h = makeDraftHarness({ throttleMs: 600 });
      h.draft.handleAssistantMessageBoundary();
      h.draft.pushEvent(toolStart());
      h.draft.noteBlockReplyQueued({ assistantMessageIndex: 1 });
      h.draft.noteBlockReplyQueued({ assistantMessageIndex: 1 });
      await h.draft.deliverAuthorizedBlock({ text: "A block one" });
      await h.draft.deliverAuthorizedBlock({ text: "A block two" });
      h.draft.noteDeliveryLifecycle("settled", {
        deliveryKind: "block",
        assistantMessageIndex: 1,
      });
      h.draft.noteDeliveryLifecycle("settled", {
        deliveryKind: "block",
        assistantMessageIndex: 1,
      });

      h.draft.handleAssistantMessageBoundary();
      h.draft.pushAnswerText({ text: "B streams" });
      await h.draft.flush();
      await vi.advanceTimersByTimeAsync(2_000);

      expect(
        h.frames.filter((frame) => frame.type === "progress").map((frame) => frame.text),
      ).toContain("B streams");
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * #94 — a notice sharing an index with a real block, queued SECOND.
   *
   * CROSSES TWO GUARDS: the notice/real classification at the settlement seam
   * and the same cardinality bail. Order must not matter: each settlement is
   * paired with the delivery it belongs to, so the notice token and the block
   * reservation each retire on their own payload's settlement whichever was
   * queued first.
   */
  it("M6x: a notice queued after a real block at one index leaves nothing stuck", async () => {
    vi.useFakeTimers();
    try {
      const h = makeDraftHarness({ throttleMs: 600 });
      h.draft.handleAssistantMessageBoundary();
      h.draft.pushEvent(toolStart());
      h.draft.noteBlockReplyQueued({ assistantMessageIndex: 1 });
      h.draft.noteBlockReplyQueued({ assistantMessageIndex: 1, isStatusNotice: true });
      await h.draft.deliverAuthorizedBlock({ text: "real-1" });
      h.draft.noteDeliveryLifecycle("settled", {
        deliveryKind: "block",
        assistantMessageIndex: 1,
      });
      await h.draft.deliverAuthorizedBlock({ text: "notice-1", isStatusNotice: true });
      h.draft.noteDeliveryLifecycle("settled", {
        deliveryKind: "block",
        assistantMessageIndex: 1,
      });

      h.draft.handleAssistantMessageBoundary();
      h.draft.pushAnswerText({ text: "B streams" });
      await h.draft.flush();
      await vi.advanceTimersByTimeAsync(2_000);

      expect(
        h.frames.filter((frame) => frame.type === "progress").map((frame) => frame.text),
      ).toContain("B streams");
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * #94 — the cancel/skip sibling of the round-8 settlement stall.
   *
   * CROSSES TWO GUARDS: the classified `skip`/`cancel` retirement and the
   * turn-wide pending-reservation gate. A real block cancelled by `beforeDeliver`
   * at an index it shares with a notice used to hit the cardinality bail — two
   * records, retire neither — so its reservation stayed pending, the gate stayed
   * closed, and no later lane streamed for the rest of the turn. Bubbles still
   * settled at drain, so this cost liveness rather than text.
   */
  it.each([["cancel", "cancel" as const], ["skip", "skip" as const]])(
    "M6y: a %s at an index shared with a notice leaves nothing pending",
    async (_name, lifecycle) => {
      vi.useFakeTimers();
      try {
        const h = makeDraftHarness({ throttleMs: 600 });
        h.draft.handleAssistantMessageBoundary();
        h.draft.pushEvent(toolStart());
        h.draft.noteBlockReplyQueued({ assistantMessageIndex: 1 });
        h.draft.noteBlockReplyQueued({ assistantMessageIndex: 1, isStatusNotice: true });
        // The real block never reaches delivery — cancelled/skipped upstream.
        h.draft.noteDeliveryLifecycle(lifecycle, {
          deliveryKind: "block",
          assistantMessageIndex: 1,
        });
        // …and the notice does the same, so nothing is left outstanding.
        h.draft.noteDeliveryLifecycle(lifecycle, {
          deliveryKind: "block",
          assistantMessageIndex: 1,
          isStatusNotice: true,
        });

        h.draft.handleAssistantMessageBoundary();
        h.draft.pushAnswerText({ text: "B streams" });
        await h.draft.flush();
        await vi.advanceTimersByTimeAsync(2_000);

        expect(
          h.frames.filter((frame) => frame.type === "progress").map((frame) => frame.text),
        ).toContain("B streams");
      } finally {
        vi.useRealTimers();
      }
    },
  );

  /**
   * #94 — held lane text must not be overtaken by a later message's payload.
   *
   * CROSSES TWO GUARDS: the predecessor barrier (a lane may not stream ahead of
   * an unresolved text-less predecessor, released only after one throttle
   * window) and independent delivery (authorized visible output, deliberately
   * neither throttled nor queued). Inside the window the held lane owns no bubble
   * id, so a later payload takes the next slot — and because the widget appends
   * on an unknown id, the later assistant message sits ABOVE the earlier one
   * permanently. Drain does not repair it; drain is what emits the earlier text,
   * into the wrong slot.
   *
   * Needs no `assistantMessageIndex` anywhere: a plain tool-only first message
   * is enough to hold M1 back.
   */
  it("M6z: a later message's block never overtakes earlier held text", async () => {
    vi.useFakeTimers();
    try {
      const h = makeDraftHarness({ throttleMs: 600 });
      h.draft.handleAssistantMessageBoundary(); // M0: tool-only
      h.draft.pushEvent(toolStart());
      h.draft.handleAssistantMessageBoundary(); // M1
      h.draft.pushAnswerText({ text: "M1-STREAMED-TEXT" });
      h.draft.handleAssistantMessageBoundary(); // M2
      await h.draft.deliverAuthorizedBlock({ text: "M2-BLOCK-BODY" });
      await h.draft.drain();

      expect(bubbleOrder(h.frames)).toEqual(["M1-STREAMED-TEXT", "M2-BLOCK-BODY"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("M6z2: a terminal notice does not overtake earlier held text either", async () => {
    // Same crossing through `deliverIndependentFinal`. Here the held text is in
    // the CURRENT lane, which must claim its slot with a progress frame rather
    // than be settled — the message is still being written.
    vi.useFakeTimers();
    try {
      const h = makeDraftHarness({ throttleMs: 600 });
      h.draft.handleAssistantMessageBoundary(); // M0: tool-only
      h.draft.pushEvent(toolStart());
      h.draft.handleAssistantMessageBoundary(); // M1
      h.draft.pushAnswerText({ text: "M1-STREAMED-TEXT" });
      await h.draft.deliverIndependentFinal({
        text: "Context is getting long, compacting…",
        isStatusNotice: true,
      });
      await h.draft.drain();

      expect(bubbleOrder(h.frames)).toEqual([
        "M1-STREAMED-TEXT",
        "Context is getting long, compacting…",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("M6z3: with a block still outstanding, the order is left alone", async () => {
    // The in-flight case, and the limit of this fix. A pending reservation means
    // the arriving payload may BE an earlier message's block, which has to land
    // ABOVE the held text — and nothing at this seam can tell whose payload it
    // is (that identity is #111's). So the flush stands down and today's
    // behaviour is kept, rather than risking the inverse inversion.
    vi.useFakeTimers();
    try {
      const h = makeDraftHarness({ throttleMs: 600 });
      h.draft.handleAssistantMessageBoundary();
      h.draft.pushEvent(toolStart());
      h.draft.handleAssistantMessageBoundary();
      h.draft.pushAnswerText({ text: "M1-STREAMED-TEXT" });
      h.draft.handleAssistantMessageBoundary();
      h.draft.noteBlockReplyQueued({ assistantMessageIndex: 3 }); // outstanding
      await h.draft.deliverAuthorizedBlock({ text: "M2-BLOCK-BODY" });
      await h.draft.drain();

      expect(bubbleOrder(h.frames)).toEqual(["M2-BLOCK-BODY", "M1-STREAMED-TEXT"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("M6z4: an in-flight earlier block still lands above later held text", async () => {
    // The counterexample that keeps M6z3's stand-down whole-function rather than
    // scoped to the current-lane slot claim. Measured in round 10: letting the
    // earlier-lanes loop run while a block is outstanding fixes M6z3's residual
    // but inverts THIS — lane 0's own block arrives while lane 1 holds text, and
    // the loop settles lane 1 first, putting assistant message 1 above message 0.
    //
    // The two shapes are distinguished only by WHOSE block just arrived, which is
    // the delivery identity this seam does not have (#111). Scoping the loop by
    // `barrierGeneration` instead would rest the ordering on the 1-based index
    // matcher that is already documented as unsound, so it is not a way out.
    vi.useFakeTimers();
    try {
      const h = makeDraftHarness({ throttleMs: 600 });
      h.draft.handleAssistantMessageBoundary(); // M0, text-less
      h.draft.pushEvent(toolStart());
      h.draft.noteBlockReplyQueued({ assistantMessageIndex: 1 }); // M0's block, in flight
      h.draft.handleAssistantMessageBoundary(); // M1
      h.draft.pushAnswerText({ text: "M1-HELD-TEXT" });
      h.draft.handleAssistantMessageBoundary(); // M2 is current
      await h.draft.deliverAuthorizedBlock({ text: "M0-BLOCK-BODY" });
      await h.draft.drain();

      expect(bubbleOrder(h.frames)).toEqual(["M0-BLOCK-BODY", "M1-HELD-TEXT"]);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * #94 — the ordering flush must never cost a held message.
   *
   * CROSSES TWO GUARDS: the flush's slot claim and `laneTerminalSuppressed`. A
   * held lane has text but no wire presence. When the flush claimed its slot and
   * the transport blipped, `recordLaneFailure` stamped the lane, `resolution`
   * stayed `"open"` (only a SUCCESSFUL send materializes), and the stamp then
   * read as "this lane may never be delivered" — so terminal drain skipped it and
   * the message was gone. A speculative attempt had reduced what the lane was
   * guaranteed at drain.
   *
   * M14c is the case that MUST keep suppressing: that lane attempted the wire
   * through the ordinary path and has no predecessors. The distinction is whether
   * the lane asked for the attempt, which is what the speculative mode encodes.
   */
  it.each([
    ["returns false", false as const],
    ["throws", "throw" as const],
  ])("M6z5: a slot claim that %s still leaves the held message intact", async (_n, outcome) => {
    const h = makeDraftHarness({
      throttleMs: 10_000,
      decide: (attempt) =>
        attempt.type === "progress" && attempt.text === "M1-STREAMED-TEXT" ? outcome : true,
    });
    h.draft.handleAssistantMessageBoundary(); // M0: tool-only, closes text-less
    h.draft.pushEvent(toolStart());
    h.draft.handleAssistantMessageBoundary(); // M1
    h.draft.pushAnswerText({ text: "M1-STREAMED-TEXT" }); // held behind M0
    await h.draft.deliverAuthorizedBlock({ text: "NOTICE", isStatusNotice: true });
    await h.draft.drain();

    expect(h.frames.map((frame) => frame.text)).toContain("M1-STREAMED-TEXT");
  });

  it("M6z6: the same through the terminal-independent path", async () => {
    const h = makeDraftHarness({
      throttleMs: 10_000,
      decide: (attempt) =>
        !(attempt.type === "progress" && attempt.text === "M1-STREAMED-TEXT"),
    });
    h.draft.handleAssistantMessageBoundary();
    h.draft.pushEvent(toolStart());
    h.draft.handleAssistantMessageBoundary();
    h.draft.pushAnswerText({ text: "M1-STREAMED-TEXT" });
    await h.draft.deliverIndependentFinal({ text: "SORRY-ERROR" });
    await h.draft.drain();

    expect(h.frames.map((frame) => frame.text)).toContain("M1-STREAMED-TEXT");
  });

  it("M6z7: CONTROL — the same transport failure with no independent delivery", async () => {
    // This is what makes the diagnosis unarguable: identical blip, no flush, and
    // the message survives. It is the flush that turns a survivable failure into
    // permanent loss, not the transport.
    const h = makeDraftHarness({
      throttleMs: 10_000,
      decide: (attempt) =>
        !(attempt.type === "progress" && attempt.text === "M1-STREAMED-TEXT"),
    });
    h.draft.handleAssistantMessageBoundary();
    h.draft.pushEvent(toolStart());
    h.draft.handleAssistantMessageBoundary();
    h.draft.pushAnswerText({ text: "M1-STREAMED-TEXT" });
    await h.draft.drain();

    expect(h.frames.map((frame) => frame.text)).toContain("M1-STREAMED-TEXT");
  });

  it("M6z8: a claimed earlier lane settles in place, at the id it claimed", async () => {
    // The flush now claims a slot for CLOSED earlier lanes too, so they emit a
    // progress frame before their terminal one. Harmless by construction — a
    // closed lane can gain no more text, so the bubble is created with exactly
    // the text drain will settle — and asserted here rather than assumed.
    vi.useFakeTimers();
    try {
      const h = makeDraftHarness({ throttleMs: 600 });
      h.draft.handleAssistantMessageBoundary(); // M0 tool-only
      h.draft.pushEvent(toolStart());
      h.draft.handleAssistantMessageBoundary(); // M1
      h.draft.pushAnswerText({ text: "M1-TEXT" });
      h.draft.handleAssistantMessageBoundary(); // M2 current: M1 is now closed
      await h.draft.deliverAuthorizedBlock({ text: "M2-BLOCK" });
      await h.draft.drain();

      const claim = h.frames.find(
        (frame) => frame.type === "progress" && frame.text === "M1-TEXT",
      )!;
      const terminal = h.frames.find(
        (frame) => frame.type === "final" && frame.text === "M1-TEXT",
      )!;
      expect(claim.id).toBe(terminal.id);
      expect(bubbleOrder(h.frames)).toEqual(["M1-TEXT", "M2-BLOCK"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("M6n: a reservation arriving PAST the window inverts order — accepted, not a bug", async () => {
    // The cost of the time-boxed release, recorded so it cannot be mistaken for
    // a defect later. Once the window closes, the empty predecessor is treated
    // as a tool-only message; a block that arrives afterwards is delivered
    // independently and therefore lands BELOW the answer that already streamed.
    // The alternative is the stall the release exists to fix, and a settle is
    // never delayed to avoid this.
    vi.useFakeTimers();
    try {
      const h = makeDraftHarness({ throttleMs: 600 });
      h.draft.handleAssistantMessageBoundary();
      h.draft.handleAssistantMessageBoundary();
      h.draft.pushAnswerText({ text: "B partial" });
      await h.draft.flush();
      await vi.advanceTimersByTimeAsync(1_500);
      expect(h.frames.map((frame) => frame.text)).toEqual(["B partial"]);

      // Too late to hold anything back.
      h.draft.noteBlockReplyQueued({});
      await h.draft.deliverAuthorizedBlock({ text: "late block for message 0" });
      await h.draft.drain();

      expect(h.frames.map((frame) => frame.text)).toEqual([
        "B partial",
        "late block for message 0",
        "B partial",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("M6o: an answer that finishes inside the window streams nothing, and that is correct", async () => {
    // The counterpart to M6j. A turn shorter than one streaming window settles
    // straight from the scaffold: no answer `progress` frame is expected, and
    // the settle is not delayed to manufacture one.
    vi.useFakeTimers();
    try {
      const h = makeDraftHarness({ throttleMs: 600 });
      h.draft.handleAssistantMessageBoundary();
      h.draft.pushEvent(toolStart());
      h.draft.handleAssistantMessageBoundary();
      h.draft.pushAnswerText({ text: "quick answer" });
      await expect(h.draft.finalize("quick answer")).resolves.toBe(true);

      expect(h.frames.filter((frame) => frame.type === "progress")).toHaveLength(1);
      expect(h.frames.at(-1)).toMatchObject({ type: "final", text: "quick answer" });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(h.frames.filter((frame) => frame.type === "final")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("M6p: stop() clears a pending release timer", async () => {
    vi.useFakeTimers();
    try {
      const h = makeDraftHarness({ throttleMs: 600 });
      h.draft.handleAssistantMessageBoundary();
      h.draft.handleAssistantMessageBoundary();
      h.draft.pushAnswerText({ text: "B partial" });
      await h.draft.flush();
      expect(vi.getTimerCount()).toBeGreaterThan(0);

      h.draft.stop();
      await h.draft.flush();
      expect(vi.getTimerCount()).toBe(0);

      // A lifecycle event after stop still reaches `releaseReadyLanes`, which
      // must not arm a new timer that nothing will ever clear.
      h.draft.noteDeliveryLifecycle("settled", { deliveryKind: "block" });
      await h.draft.flush();
      expect(vi.getTimerCount()).toBe(0);

      await vi.advanceTimersByTimeAsync(5_000);
      expect(h.frames).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("M6k: a settle inside the window never waits for the release timer", async () => {
    vi.useFakeTimers();
    try {
      const h = makeDraftHarness({ throttleMs: 600 });
      h.draft.handleAssistantMessageBoundary();
      h.draft.pushEvent(toolStart());
      h.draft.handleAssistantMessageBoundary();
      h.draft.pushAnswerText({ text: "the answer" });

      // No timer advance at all: the settle path resolves the empty predecessor
      // itself, so a turn that finishes inside the window behaves exactly as it
      // did before the timer existed.
      await expect(h.draft.finalize("the answer")).resolves.toBe(true);
      expect(h.frames.at(-1)).toMatchObject({ type: "final", text: "the answer" });

      // …and the pending timer is CLEARED by drain, not merely harmless when it
      // fires. A timer surviving its turn is a leak, and a live one would keep
      // the host process awake; the frame count alone cannot see either, so
      // assert the timer itself is gone.
      const settledFrames = h.frames.length;
      await h.draft.drain();
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(h.frames).toHaveLength(settledFrames);
    } finally {
      vi.useRealTimers();
    }
  });

  it("M7b: a mid-stream <thinking> tag never splits one answer into two bubbles", async () => {
    const warn = vi.fn();
    const h = makeDraftHarness({ logger: { warn } });
    h.draft.handleAssistantMessageBoundary();
    for (const text of [
      "Hi",
      "Hi <",
      "Hi <thi",
      "Hi <thinking>",
      "Hi <thinking>z</thinking> there",
    ]) {
      h.draft.pushAnswerText({ text });
      await h.draft.flush();
    }
    await expect(h.draft.finalize("Hi there")).resolves.toBe(true);

    expect(successfulIds(h.frames)).toHaveLength(1);
    expect(h.frames.filter((frame) => frame.type === "final")).toEqual([
      { type: "final", id: h.frames[0]!.id, text: "Hi there" },
    ]);
    // The ambiguous bare `<` is held at its safe prefix; once `thi` proves this
    // is not one of the distinctive tool markers, literal streaming resumes.
    // The 4th partial ("Hi", shorter than "Hi <thi") is still dropped.
    expect(h.frames.map((frame) => frame.text)).toEqual([
      "Hi",
      "Hi ",
      "Hi <thi",
      "Hi  there",
      "Hi there",
    ]);
    // …and no partial of this one message is ever read as a new message.
    expect(warn).not.toHaveBeenCalledWith(
      expect.stringContaining("contract violation"),
    );
  });

  it("M7c: a Reasoning:-prefixed partial never reaches the wire", async () => {
    // Some providers emit the model's reasoning as ordinary partial text under a
    // "Reasoning:\n" prefix — the tag strippers leave it untouched (measured),
    // so the prefix is the only signal. Core drops those partials
    // (message-handler.process-CcPQD8zK.js:691) and so must this channel: they
    // are not the answer, and rendering them leaks reasoning into the bubble.
    const h = makeDraftHarness();
    h.draft.handleAssistantMessageBoundary();
    h.draft.pushAnswerText({ text: "Reasoning:\nweighing the options" });
    await h.draft.flush();

    expect(h.frames).toEqual([]);
    expect(h.draft.snapshotText()).toBe("");

    // The real answer that follows still streams normally.
    h.draft.pushAnswerText({ text: "The answer is 4." });
    await h.draft.flush();
    expect(h.frames.map((frame) => frame.text)).toEqual(["The answer is 4."]);
  });

  /**
   * #94 — the raw baseline must never move BACKWARDS.
   *
   * The missed-boundary fail-safe compares each payload against the lane's last
   * raw partial. Rewinding that baseline to a swallowed shorter payload disables
   * the fail-safe for the rest of the turn: everything afterwards "extends" the
   * rewound value, so a genuinely new assistant message is never recognised and
   * the previous message's body is overwritten in place — the #94 data-loss
   * class, reintroduced through the guard meant to prevent a split.
   *
   * The trigger is ordinary: message 2's FIRST streamed chunk being a prefix of
   * message 1's text. With token-sized deltas a one-character collision ("D"
   * here) is the common case, not a contrived one.
   */
  it("M7d: a swallowed shrink never disarms the missed-boundary fail-safe", async () => {
    const warn = vi.fn();
    const h = makeDraftHarness({ logger: { warn } });
    h.draft.handleAssistantMessageBoundary();
    h.draft.pushAnswerText({ text: "Done." });
    h.draft.pushAnswerText({ text: "Done. Roster listed." });
    // --- core misses the structured boundary here ---
    h.draft.pushAnswerText({ text: "D" }); // shrink: swallowed for display
    h.draft.pushAnswerText({ text: "Different answer entirely." });
    await h.draft.drain();

    const finals = h.frames.filter((frame) => frame.type === "final");
    expect(finals.map((frame) => frame.text)).toEqual([
      "Done. Roster listed.",
      "Different answer entirely.",
    ]);
    expect(new Set(finals.map((frame) => frame.id)).size).toBe(2);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("contract violation"));
  });

  it("M7e: a non-prefix first chunk still rotates, unchanged", async () => {
    // The control for M7d: nothing about the fix may weaken the fail-safe on the
    // shape it exists for.
    const warn = vi.fn();
    const h = makeDraftHarness({ logger: { warn } });
    h.draft.handleAssistantMessageBoundary();
    h.draft.pushAnswerText({ text: "Done." });
    h.draft.pushAnswerText({ text: "Done. Roster listed." });
    h.draft.pushAnswerText({ text: "Oops" });
    h.draft.pushAnswerText({ text: "Oops, different answer." });
    await h.draft.drain();

    const finals = h.frames.filter((frame) => frame.type === "final");
    expect(finals.map((frame) => frame.text)).toEqual([
      "Done. Roster listed.",
      "Oops, different answer.",
    ]);
    expect(new Set(finals.map((frame) => frame.id)).size).toBe(2);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("contract violation"));
  });

  it("M7g: an authoritative replace starts a new baseline for later deltas", async () => {
    // Forward-only holds WITHIN a message. A `replace:true` update supersedes
    // the cumulative text rather than continuing it, so measuring it against the
    // old baseline pins the baseline to superseded text and every later delta
    // composes on the wrong thing — "old" + "er" instead of "new" + "er". This
    // crosses two guards that are individually correct: the replace exemption in
    // the shrink path, and the forward-only rule in the baseline write.
    const h = makeDraftHarness();
    h.draft.handleAssistantMessageBoundary();
    h.draft.pushAnswerText({ text: "old" });
    h.draft.pushAnswerText({ text: "new", replace: true });
    h.draft.pushAnswerText({ delta: "er" });
    await h.draft.drain();

    const finals = h.frames.filter((frame) => frame.type === "final");
    expect(finals.map((frame) => frame.text)).toEqual(["newer"]);
  });

  it("M7f: delta-only updates compose on the raw stream across a swallowed shrink", async () => {
    // `{delta}` without `{text}` is its own path: the accumulator has to compose
    // on the RAW baseline, or a swallowed shrink folds the stripped tag fragment
    // back into the text ("Hi <thiz</thinking> there").
    const h = makeDraftHarness();
    h.draft.handleAssistantMessageBoundary();
    h.draft.pushAnswerText({ delta: "Hi" });
    h.draft.pushAnswerText({ delta: " <thi" });
    h.draft.pushAnswerText({ delta: "nking>" }); // cleaned shrinks to "Hi"
    h.draft.pushAnswerText({ delta: "z</thinking> there" });
    await h.draft.flush();

    expect(h.draft.snapshotText()).toBe("Hi  there");
    expect(successfulIds(h.frames)).toHaveLength(1);
  });

  /**
   * #120, KNOWN UNFIXED — a second message whose WHOLE text is a strict prefix
   * of the first is erased from the wire. This test pins the exact two assertion
   * failures produced by the defect: it PASSES only while the current one-final,
   * one-id signature is present and turns RED the moment someone fixes or changes
   * it, so the fix cannot land without updating the expectations deliberately.
   *
   * The shape crosses two guards, both correct in isolation. M7d pins the case
   * where message 2's first chunk is a prefix and a LATER chunk grows past
   * message 1 — that later chunk is what the missed-boundary fail-safe sees.
   * Here no chunk ever grows past it: "Done." is a strict prefix of
   * "Done. Roster listed." from its first character to its last, so every
   * partial of message 2 is swallowed by the shrink guard, the fail-safe never
   * sees a divergence, and `finalize` writes "Done." onto message 1's bubble.
   *
   * WHY IT IS NOT FIXED HERE. Every candidate signal is produced by ordinary
   * single-message turns too, because core runs `sanitizeUserFacingText` over
   * every cumulative payload and its tag strippers make our input a sawtooth
   * (see `lastRawAnswerText`):
   *
   *   - "the raw text went backwards"            -> every completing core tag
   *   - "...twice in a row, growing"             -> M7k, two adjacent tool calls
   *   - "the final is a strict prefix of what
   *      the lane displayed"                     -> every message ENDING in a
   *                                                 tool call: the sanitized
   *                                                 final drops the tag text
   *
   * Measured on core 2026.7.1-2. The last one also rules out deferring the
   * decision to the end of the stream, since that is where it is evaluated.
   * The distinction is not carried by the text at all — it has to come from the
   * boundary signal, which is precisely what is missing in this scenario.
   *
   * The premise is real, not hypothetical: the pinned core's provider-capabilities/
   * Codex native path gates `onAssistantMessageStart` behind a sticky per-run
   * `assistantStarted` flag while successive eligible `final_answer` items can
   * restart cumulative `onPartialReply` text with no second boundary.
   */
  it("M7h: KNOWN DEFECT #120 — a strict-prefix second message erases the first", async () => {
    const warn = vi.fn();
    const h = makeDraftHarness({ logger: { warn } });
    h.draft.handleAssistantMessageBoundary();
    h.draft.pushAnswerText({ text: "Done." });
    h.draft.pushAnswerText({ text: "Done. Roster listed." });
    // --- core misses the structured boundary here ---
    h.draft.pushAnswerText({ text: "D" });
    h.draft.pushAnswerText({ text: "Don" });
    h.draft.pushAnswerText({ text: "Done." });
    await expect(h.draft.finalize("Done.")).resolves.toBe(true);
    await h.draft.drain();

    const finals = h.frames.filter((frame) => frame.type === "final");
    const desiredTexts = [
      "Done. Roster listed.",
      "Done.",
    ];

    const expectKnownAssertionFailure = (
      assertion: () => void,
      signature: { actual: unknown; expected: unknown },
    ) => {
      let failure: unknown;
      try {
        assertion();
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({ name: "AssertionError", ...signature });
    };

    // What SHOULD happen. Today only "Done." is finalised, on message 1's id:
    // "Done. Roster listed." is overwritten and never survives as a bubble.
    expectKnownAssertionFailure(
      () => expect(finals.map((frame) => frame.text)).toEqual(desiredTexts),
      { actual: ["Done."], expected: desiredTexts },
    );
    expectKnownAssertionFailure(
      () => expect(successfulIds(h.frames).length).toBe(2),
      { actual: 1, expected: 2 },
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it("M7i: a single backwards partial is swallowed, never read as a restart", async () => {
    // The controller-level twin of channel.test.ts "ignores a shrinking
    // cumulative partial". A backwards cumulative payload is what core emits
    // the instant one of ITS tag strippers closes a tag, so it is ordinary
    // in-message traffic; rotating on it splits one answer into two bubbles.
    const warn = vi.fn();
    const h = makeDraftHarness({ logger: { warn } });
    h.draft.handleAssistantMessageBoundary();
    h.draft.pushAnswerText({ text: "Hello world" });
    h.draft.pushAnswerText({ text: "Hello" });
    await expect(h.draft.finalize("Hello final")).resolves.toBe(true);
    await h.draft.drain();

    expect(h.frames.map((frame) => frame.text)).toEqual(["Hello world", "Hello final"]);
    expect(successfulIds(h.frames)).toHaveLength(1);
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("contract violation"));
  });

  /**
   * M7k — THE TRAP. Two adjacent tool-call tags in ONE assistant message.
   *
   * This is a real core payload stream, not a hand-written one: the text
   * `Here you go.<tool_call>{"n":1}</tool_call><tool_call>{"n":2}</tool_call> Done.`
   * fed one character at a time through `sanitizeUserFacingText` on core
   * 2026.7.1-2, keeping each distinct output. It is inlined rather than
   * regenerated because reaching that function means importing a hash-bearing
   * `dist/` path, which rots at every pin bump (#122).
   *
   * The stream is a SAWTOOTH: it climbs to "Here you go.<tool_call>", drops to
   * "Here you go." when core strips the completed pair, climbs the identical
   * path again for the second tag, drops again, then finishes. Two consecutive
   * backwards payloads, the second growing from the first — inside one message.
   *
   * That is why #120 cannot be fixed by reading the text (see M7h). A guard
   * keying on that pair shipped in review and produced THREE bubbles here, the
   * first two byte-identical: the user saw "Here you go.<tool_call>" twice.
   * Assert distinctness so no future attempt can reintroduce a duplicate.
   */
  it("M7k: an in-message tag sawtooth never emits a duplicate bubble", async () => {
    const h = makeDraftHarness();
    h.draft.handleAssistantMessageBoundary();
    for (const text of [
      "H", "He", "Her", "Here", "Here ", "Here y", "Here yo", "Here you",
      "Here you ", "Here you g", "Here you go", "Here you go.",
      "Here you go.<", "Here you go.<t", "Here you go.<to", "Here you go.<too",
      "Here you go.<tool", "Here you go.<tool_", "Here you go.<tool_c",
      "Here you go.<tool_ca", "Here you go.<tool_cal", "Here you go.<tool_call",
      "Here you go.<tool_call>",
      "Here you go.", // core strips the first completed pair
      "Here you go.<", "Here you go.<t", "Here you go.<to", "Here you go.<too",
      "Here you go.<tool", "Here you go.<tool_", "Here you go.<tool_c",
      "Here you go.<tool_ca", "Here you go.<tool_cal", "Here you go.<tool_call",
      "Here you go.<tool_call>",
      "Here you go.", // and the second
      "Here you go. ", "Here you go. D", "Here you go. Do", "Here you go. Don",
      "Here you go. Done", "Here you go. Done.",
    ]) {
      h.draft.pushAnswerText({ text });
    }
    await expect(h.draft.finalize("Here you go. Done.")).resolves.toBe(true);
    await h.draft.drain();

    const finals = h.frames.filter((frame) => frame.type === "final");
    const texts = finals.map((frame) => frame.text);
    // The invariant that the reverted guard broke: never the same text twice.
    expect(new Set(texts).size).toBe(texts.length);
    // #129: the first exact marker makes the lane sticky until the durable
    // final, so neither raw marker is finalized as a separate bubble.
    expect(texts).toEqual(["Here you go. Done."]);
    expect(successfulIds(h.frames)).toHaveLength(1);
  });

  const angleMarkerCases = [
    ["tool_call", 'Hello <tool_call>{"x":1}</tool_call> Answer', "Hello  Answer"],
    [
      "tool_calls",
      "Hello <tool_calls><parameter>x</parameter></tool_calls> Answer",
      "Hello  Answer",
    ],
    ["tool_result", 'Hello <tool_result>{"x":1}</tool_result> Answer', "Hello  Answer"],
    [
      "function_call",
      'Hello <function_call>{"x":1}</function_call> Answer',
      "Hello  Answer",
    ],
    [
      "function_calls",
      "Hello <function_calls><parameter>x</parameter></function_calls> Answer",
      "Hello  Answer",
    ],
    [
      "function_response",
      'Hello <function_response>{"x":1}</function_response> Answer',
      "Hello  Answer",
    ],
    [
      "function",
      'Hello\n<function name="bash">{"x":1}</function>\nAnswer',
      "Hello\n\nAnswer",
    ],
    [
      "antml:invoke",
      'Hello <antml:invoke>{"x":1}</antml:invoke> Answer',
      "Hello  Answer",
    ],
    [
      "antml:parameter",
      'Hello <antml:parameter>{"x":1}</antml:parameter> Answer',
      "Hello  Answer",
    ],
    ["final", "Hello <final>Answer</final>", "Hello Answer"],
  ] as const;

  it.each(angleMarkerCases)(
    "M7l: pinned %s sanitizer prefixes stay on one clean lane",
    async (_name, source, expected) => {
      const h = makeDraftHarness();
      h.draft.handleAssistantMessageBoundary();
      await expect(replayPinnedStreamPrefixes(h.draft, source)).resolves.toBe(expected);
      await expect(h.draft.finalize(expected)).resolves.toBe(true);
      await h.draft.drain();

      expect(bubbleOrder(h.frames)).toEqual([expected]);
      expect(successfulIds(h.frames)).toHaveLength(1);
      expect(h.frames.every((frame) => !/<(?:\/?\s*)?(?:tool_|function|antml:|final\b)/.test(frame.text))).toBe(
        true,
      );
    },
  );

  it("M7l1: a suppressed-empty tool-only marker cannot escape at the next boundary", async () => {
    const h = makeDraftHarness();
    h.draft.handleAssistantMessageBoundary();
    h.draft.pushAnswerText({ text: "<tool_call>" });
    await h.draft.flush();
    expect(h.frames).toEqual([]);

    // Core's later empty callback is suppressed. The next boundary must discard
    // the exact quarantine instead of restoring the opening marker.
    h.draft.handleAssistantMessageBoundary();
    h.draft.pushAnswerText({ text: "Answer" });
    await h.draft.drain();
    expect(bubbleOrder(h.frames)).toEqual(["Answer"]);
    expect(successfulIds(h.frames)).toHaveLength(1);
  });

  it("M7l2: the earliest outer marker survives nested sanitized sawteeth", async () => {
    const source =
      'Hello <tool_call><function_call>{"name":"x"}</function_call></tool_call> there';
    const expected = "Hello  there";
    const h = makeDraftHarness();
    h.draft.handleAssistantMessageBoundary();
    await expect(replayPinnedStreamPrefixes(h.draft, source)).resolves.toBe(expected);
    await h.draft.finalize(expected);
    await h.draft.drain();

    expect(bubbleOrder(h.frames)).toEqual([expected]);
    expect(successfulIds(h.frames)).toHaveLength(1);
    expect(h.frames.some((frame) => frame.text.includes("<tool_call"))).toBe(false);
  });

  it.each([
    ["tool_calls", [12, 48, 56]],
    ["function_calls", [16, 56, 64]],
  ] as const)(
    "M7l3: pinned coalesced %s unwrap cuts cannot release an exact wrapper",
    async (tag, cuts) => {
      const source = `<${tag}><parameter>x</parameter></${tag}> Answer`;
      const callbacks = cuts.map((end) =>
        sanitizeAssistantVisibleStreamText(source.slice(0, end)),
      );
      expect(callbacks).toEqual([
        `<${tag}>`,
        `<${tag}>x</${tag}`,
        " Answer",
      ]);

      const hidden = makeDraftHarness();
      hidden.draft.handleAssistantMessageBoundary();
      for (const text of callbacks) hidden.draft.pushAnswerText({ text });
      await hidden.draft.drain();
      expect(hidden.frames).toEqual([]);

      const visibleCallbacks = cuts.map((end) =>
        sanitizeAssistantVisibleStreamText(`Hello ${source.slice(0, end)}`),
      );
      expect(visibleCallbacks).toEqual([
        `Hello <${tag}>`,
        `Hello <${tag}>x</${tag}`,
        "Hello  Answer",
      ]);
      const visible = makeDraftHarness();
      visible.draft.handleAssistantMessageBoundary();
      for (const text of visibleCallbacks) visible.draft.pushAnswerText({ text });
      await visible.draft.finalize("Hello  Answer");
      await visible.draft.drain();
      expect(bubbleOrder(visible.frames)).toEqual(["Hello  Answer"]);
      expect(successfulIds(visible.frames)).toHaveLength(1);
      expect(visible.frames.some((frame) => frame.text.includes(`<${tag}`))).toBe(false);
    },
  );

  it("M7l4: incomplete terminal fallback is visible-prefix-only", async () => {
    const visible = makeDraftHarness();
    visible.draft.handleAssistantMessageBoundary();
    visible.draft.pushAnswerText({ text: "see <tool_cal" });
    await visible.draft.drain();
    expect(bubbleOrder(visible.frames)).toEqual(["see <tool_cal"]);

    const anchorZero = makeDraftHarness();
    anchorZero.draft.handleAssistantMessageBoundary();
    anchorZero.draft.pushAnswerText({ text: "<tool_cal" });
    await anchorZero.draft.drain();
    expect(anchorZero.frames).toEqual([]);

    const exact = makeDraftHarness();
    exact.draft.handleAssistantMessageBoundary();
    exact.draft.pushAnswerText({ text: "see <tool_call>" });
    await exact.draft.drain();
    expect(bubbleOrder(exact.frames)).toEqual(["see "]);
  });

  it("M7l5: a boundary restores an incomplete literal before the next lane", async () => {
    const h = makeDraftHarness();
    h.draft.handleAssistantMessageBoundary();
    h.draft.pushAnswerText({ text: "see <tool_cal" });
    h.draft.handleAssistantMessageBoundary();
    h.draft.pushAnswerText({ text: "Second" });
    await h.draft.drain();
    expect(bubbleOrder(h.frames)).toEqual(["see <tool_cal", "Second"]);
    expect(successfulIds(h.frames)).toHaveLength(2);
  });

  it("M7l6: a deferred tail resolves before an independent terminal", async () => {
    const h = makeDraftHarness();
    h.draft.handleAssistantMessageBoundary();
    h.draft.pushAnswerText({ text: "<tool_call>" });
    await h.draft.flush();
    await h.draft.deliverIndependentFinal({ text: "ERROR" });
    await h.draft.drain();

    expect(bubbleOrder(h.frames)).toEqual(["ERROR"]);

    const visible = makeDraftHarness();
    visible.draft.handleAssistantMessageBoundary();
    visible.draft.pushAnswerText({ text: "before <tool_cal" });
    await visible.draft.flush();
    await visible.draft.deliverIndependentFinal({ text: "ERROR" });
    await visible.draft.drain();
    expect(bubbleOrder(visible.frames)).toEqual(["before <tool_cal", "ERROR"]);
    expect(successfulIds(visible.frames)).toHaveLength(2);
  });

  it.each([
    ["plain", "Use <tool_call> literally."],
    ["inline code", 'Use `<tool_call>{"x":1}</tool_call>` literally.'],
    ["fenced code", '```xml\n<tool_call>{"x":1}</tool_call>\n```'],
  ])("M7l7: an authoritative final restores %s control-looking text", async (_name, source) => {
    expect(sanitizeAssistantVisibleStreamText(source)).toBe(source);
    const h = makeDraftHarness();
    h.draft.handleAssistantMessageBoundary();
    await replayPinnedStreamPrefixes(h.draft, source);
    // Code regions are intentionally not parsed in the adapter: doing so was
    // cubic over cumulative callbacks with many spans. A control-looking
    // partial stays quarantined until this authoritative final.
    expect(h.frames.some((frame) => frame.text.includes("<tool_call"))).toBe(false);
    await h.draft.finalize(source);
    await h.draft.drain();
    expect(bubbleOrder(h.frames)).toEqual([source]);
    expect(successfulIds(h.frames)).toHaveLength(1);
    expect(h.frames.every((frame) => source.startsWith(frame.text))).toBe(true);
  });

  it("M7l8: delta and replace updates cannot unlock an exact quarantine", async () => {
    const delta = makeDraftHarness();
    delta.draft.handleAssistantMessageBoundary();
    delta.draft.pushAnswerText({ text: "Hello <tool_cal" });
    delta.draft.pushAnswerText({ delta: 'l>{"x":1}</tool_call> Answer' });
    await delta.draft.finalize("Hello  Answer");
    await delta.draft.drain();
    expect(bubbleOrder(delta.frames)).toEqual(["Hello  Answer"]);
    expect(successfulIds(delta.frames)).toHaveLength(1);

    const replace = makeDraftHarness();
    replace.draft.handleAssistantMessageBoundary();
    replace.draft.pushAnswerText({ text: "Hello <tool_call>" });
    replace.draft.pushAnswerText({ text: "replacement", replace: true });
    await replace.draft.flush();
    expect(replace.frames.some((frame) => frame.text === "replacement")).toBe(false);
    await replace.draft.finalize("replacement");
    expect(bubbleOrder(replace.frames)).toEqual(["replacement"]);
    expect(successfulIds(replace.frames)).toHaveLength(1);
  });

  it("M7l10: the angle scan stays bounded on repeated target-like literals", async () => {
    const callbackCount = 256;
    let source = "";
    const h = makeDraftHarness();
    h.draft.handleAssistantMessageBoundary();
    const indexOf = vi.spyOn(String.prototype, "indexOf");
    try {
      for (let index = 0; index < callbackCount; index += 1) {
        source += "`<tool_calligraphy>` ";
        h.draft.pushAnswerText({ text: source });
        await h.draft.flush();
      }
      const angleSearches = indexOf.mock.calls.filter(([needle]) => needle === "<").length;
      const cumulativeCandidateBound = (callbackCount * (callbackCount + 3)) / 2;
      expect(angleSearches).toBeLessThanOrEqual(cumulativeCandidateBound + callbackCount * 2);
    } finally {
      indexOf.mockRestore();
    }
    await h.draft.finalize(source);
    expect(bubbleOrder(h.frames)).toEqual([source]);
    expect(successfulIds(h.frames)).toHaveLength(1);
  });

  it("M7l12: a nonextension rotates only when it loses the held safe prefix", async () => {
    const restart = makeDraftHarness();
    restart.draft.handleAssistantMessageBoundary();
    restart.draft.pushAnswerText({ text: "First <tool_cal" });
    await restart.draft.flush();
    restart.draft.pushAnswerText({ text: "Second" });
    await restart.draft.finalize("Second final");
    await restart.draft.drain();
    expect(bubbleOrder(restart.frames)).toEqual(["First <tool_cal", "Second final"]);
    expect(successfulIds(restart.frames)).toHaveLength(2);

    for (const retraction of ["Hello", "Hello Answer"]) {
      const hidden = makeDraftHarness();
      hidden.draft.handleAssistantMessageBoundary();
      hidden.draft.pushAnswerText({ text: "Hello <tool_cal" });
      hidden.draft.pushAnswerText({ text: retraction });
      await hidden.draft.finalize("Hello Answer");
      await hidden.draft.drain();
      expect(bubbleOrder(hidden.frames)).toEqual(["Hello Answer"]);
      expect(successfulIds(hidden.frames)).toHaveLength(1);
    }

    const anchorZero = makeDraftHarness();
    anchorZero.draft.handleAssistantMessageBoundary();
    anchorZero.draft.pushAnswerText({ text: "<tool_cal" });
    anchorZero.draft.pushAnswerText({ text: "Second" });
    await anchorZero.draft.drain();
    expect(anchorZero.frames).toEqual([]);
  });

  it("M7l13: no-final exact literals retain the suppressed-empty safety policy", async () => {
    const exactPrefix = "Use <tool_call>";
    const literalSource = `${exactPrefix} literally.`;
    const hiddenSource = `${exactPrefix}{"x":1}</tool_call>`;
    expect(sanitizeAssistantVisibleStreamText(exactPrefix)).toBe(exactPrefix);
    expect(sanitizeAssistantVisibleStreamText(literalSource)).toBe(literalSource);
    expect(sanitizeAssistantVisibleStreamText(hiddenSource)).toBe("Use");

    // Both raw histories produce the same exact-prefix callback. Releasing it
    // at that point would leak the hidden history when its later empty callback
    // is suppressed, so without a durable final both settle only the safe text.
    for (const source of [literalSource, hiddenSource]) {
      const h = makeDraftHarness();
      h.draft.handleAssistantMessageBoundary();
      await replayPinnedStreamPrefixes(h.draft, source);
      await h.draft.drain();
      expect(bubbleOrder(h.frames)).toEqual(["Use "]);
      expect(h.frames.some((frame) => frame.text.includes("<tool_call"))).toBe(false);
    }

    for (const source of [
      "<tool_call> literally.",
      '<tool_call>{"x":1}</tool_call>',
    ]) {
      const anchorZero = makeDraftHarness();
      anchorZero.draft.handleAssistantMessageBoundary();
      await replayPinnedStreamPrefixes(anchorZero.draft, source);
      await anchorZero.draft.drain();
      expect(anchorZero.frames).toEqual([]);
    }

    // A complete callback that lexically disproves every allowlisted name is
    // safe without reconstructing any payload grammar.
    const disproved = "Use <tool_calligraphy> literally.";
    const literal = makeDraftHarness();
    literal.draft.handleAssistantMessageBoundary();
    literal.draft.pushAnswerText({ text: disproved });
    await literal.draft.drain();
    expect(bubbleOrder(literal.frames)).toEqual([disproved]);
  });

  it("M7l14: end-of-callback names remain literal until a boundary proves otherwise", async () => {
    const source = "Use <tool_calligraphy> literally.";
    expect(sanitizeAssistantVisibleStreamText(source)).toBe(source);

    const charwise = makeDraftHarness();
    charwise.draft.handleAssistantMessageBoundary();
    await replayPinnedStreamPrefixes(charwise.draft, source);
    await charwise.draft.drain();
    expect(bubbleOrder(charwise.frames)).toEqual([source]);
    expect(successfulIds(charwise.frames)).toHaveLength(1);
    expect(charwise.frames.every((frame) => source.startsWith(frame.text))).toBe(true);

    const exactPrefix = "Use <tool_call";
    expect(sanitizeAssistantVisibleStreamText(exactPrefix)).toBe(exactPrefix);
    const twoCallbacks = makeDraftHarness();
    twoCallbacks.draft.handleAssistantMessageBoundary();
    twoCallbacks.draft.pushAnswerText({ text: exactPrefix });
    twoCallbacks.draft.pushAnswerText({ text: source });
    await twoCallbacks.draft.drain();
    expect(bubbleOrder(twoCallbacks.frames)).toEqual([source]);

    const noFinal = makeDraftHarness();
    noFinal.draft.handleAssistantMessageBoundary();
    noFinal.draft.pushAnswerText({ text: exactPrefix });
    await noFinal.draft.drain();
    expect(bubbleOrder(noFinal.frames)).toEqual([exactPrefix]);

    const fifo = makeDraftHarness();
    fifo.draft.handleAssistantMessageBoundary();
    fifo.draft.pushAnswerText({ text: "Use <tool_call" });
    await fifo.draft.flush();
    await fifo.draft.deliverIndependentFinal({ text: "ERROR" });
    await fifo.draft.drain();
    expect(bubbleOrder(fifo.frames)).toEqual(["Use <tool_call", "ERROR"]);
    expect(successfulIds(fifo.frames)).toHaveLength(2);
  });

  it("M7l15: non-XML core-name boundaries monotonically release literals", async () => {
    for (const source of [
      "Use <tool_call!> literally.",
      "Use <function=> literally.",
      "Use <final!> literally.",
    ]) {
      expect(sanitizeAssistantVisibleStreamText(source)).toBe(source);
      const h = makeDraftHarness();
      h.draft.handleAssistantMessageBoundary();
      await replayPinnedStreamPrefixes(h.draft, source);
      await h.draft.drain();
      expect(bubbleOrder(h.frames)).toEqual([source]);
      expect(successfulIds(h.frames)).toHaveLength(1);
      expect(h.frames.every((frame) => source.startsWith(frame.text))).toBe(true);
    }
  });

  it("M7l16: valid XML boundaries retain hidden-tag quarantine", async () => {
    for (const source of [
      '<tool_call >{"x":1}</tool_call>',
      "<tool_call/>",
      '<tool_call>{"x":1}</tool_call>',
    ]) {
      expect(sanitizeAssistantVisibleStreamText(source)).toBe("");
      const hidden = makeDraftHarness();
      hidden.draft.handleAssistantMessageBoundary();
      await replayPinnedStreamPrefixes(hidden.draft, source);
      await hidden.draft.drain();
      expect(hidden.frames).toEqual([]);
    }

    for (const source of [
      'Hello <tool_call >{"x":1}</tool_call> Answer',
      "Hello <tool_call/> Answer",
      'Hello <tool_call>{"x":1}</tool_call> Answer',
    ]) {
      expect(sanitizeAssistantVisibleStreamText(source)).toBe("Hello  Answer");
      const visible = makeDraftHarness();
      visible.draft.handleAssistantMessageBoundary();
      await replayPinnedStreamPrefixes(visible.draft, source);
      await visible.draft.finalize("Hello  Answer");
      await visible.draft.drain();
      expect(bubbleOrder(visible.frames)).toEqual(["Hello  Answer"]);
      expect(successfulIds(visible.frames)).toHaveLength(1);
      expect(visible.frames.some((frame) => frame.text.includes("<tool_call"))).toBe(false);
    }
  });

  /**
   * #94 — a notice block between two real blocks used to stall every later
   * message for the rest of the turn.
   *
   * A notice delivery records no disposition, so its `settled` event finds none
   * outstanding; the old code then required `blockDispositions.length === 0` to
   * retire anything, which is false the moment any earlier block has settled. Its
   * token stayed `pending`, the next real block at the same index became
   * ambiguous, and that block's ordering reservation held its lane until terminal
   * drain — so a following message's partials never reached the wire.
   *
   * The control is the same sequence with the notice removed: it must stream.
   * Both run past the release window, so the stall cannot be confused with the
   * ordinary text-less-predecessor hold.
   */
  it.each([
    ["a notice between the real blocks", true],
    ["control: no notice", false],
  ])("M6s: %s never stalls a later message", async (_name, withNotice) => {
    vi.useFakeTimers();
    try {
      const h = makeDraftHarness({ throttleMs: 600 });
      h.draft.handleAssistantMessageBoundary();
      h.draft.noteBlockReplyQueued({ assistantMessageIndex: 0 });
      await h.draft.deliverAuthorizedBlock({ text: "real-0" });
      h.draft.noteDeliveryLifecycle("settled", {
        deliveryKind: "block",
        assistantMessageIndex: 0,
      });

      h.draft.handleAssistantMessageBoundary();
      if (withNotice) {
        h.draft.noteBlockReplyQueued({ assistantMessageIndex: 1, isStatusNotice: true });
        await h.draft.deliverAuthorizedBlock({ text: "notice-1", isStatusNotice: true });
        h.draft.noteDeliveryLifecycle("settled", {
          deliveryKind: "block",
          assistantMessageIndex: 1,
        });
      }
      h.draft.noteBlockReplyQueued({ assistantMessageIndex: 1 });
      await h.draft.deliverAuthorizedBlock({ text: "real-1" });
      h.draft.noteDeliveryLifecycle("settled", {
        deliveryKind: "block",
        assistantMessageIndex: 1,
      });

      h.draft.handleAssistantMessageBoundary();
      h.draft.pushAnswerText({ text: "C text" });
      await h.draft.flush();
      await vi.advanceTimersByTimeAsync(2_000);

      expect(h.frames.map((frame) => frame.text)).toContain("C text");
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * #94 — a transient send failure must not TRUNCATE a visible message.
   *
   * CROSSES TWO GUARDS: `recordLaneFailure`'s revision stamp (right: never
   * blind-retry the frame that just failed) and the terminal-frame gate (was
   * reading that stamp as "this lane may never be delivered"). They agree for a
   * lane that never materialized and diverge for one that already owns a bubble:
   * the user is left staring at whatever text last succeeded, permanently,
   * because the client finalizes the working draft in place on `turn_settled`.
   *
   * The transport recovers immediately here — lane B's frames all succeed — so
   * nothing about the failure is sticky except the guard.
   *
   * Control against `origin/develop`'s controller, same shape: it attempts the
   * terminal frame and carries the FULL text. This restores that per-lane.
   */
  it("M14a: a materialized lane still settles after a transient progress failure", async () => {
    const h = makeDraftHarness({
      decide: (attempt) => !(attempt.type === "progress" && attempt.text.startsWith("A par tial")),
    });
    h.draft.handleAssistantMessageBoundary();
    h.draft.pushAnswerText({ text: "A par" });
    const idA = h.frames[0]!.id;
    h.draft.pushAnswerText({ text: "A par tial answer" });
    h.draft.handleAssistantMessageBoundary();
    h.draft.pushAnswerText({ text: "B draft" });
    await h.draft.finalize("B final");
    await h.draft.drain();

    // Lane A reaches a terminal frame, at its own id, carrying the text the
    // failed revision was trying to show — not the stale prefix.
    const terminalA = h.frames.find((frame) => frame.type === "final" && frame.id === idA);
    expect(terminalA?.text).toBe("A par tial answer");
    expect(h.frames.map((frame) => `${frame.type}:${frame.text}`)).toEqual([
      "progress:A par",
      "final:A par tial answer",
      "progress:B draft",
      "final:B final",
    ]);
  });

  it("M14b: the drain-only shape settles too", async () => {
    // Same defect reached without a second message or an ordinary final — the
    // turn just ends. `develop` settles this shape as well (verified against its
    // controller), so leaving it stuck was a regression, not inherited.
    const h = makeDraftHarness({
      decide: (attempt) => !attempt.text.includes("Hello world"),
    });
    h.draft.handleAssistantMessageBoundary();
    h.draft.pushAnswerText({ text: "Hel" });
    const id = h.frames[0]!.id;
    h.draft.pushAnswerText({ text: "Hello world" });
    await h.draft.drain();

    expect(h.attempts.some((attempt) => attempt.type === "final" && attempt.id === id)).toBe(true);
  });

  it("M14c: a lane that never materialized is still suppressed, and never retries", async () => {
    // The other side of the same gate, and the reason it cannot simply be
    // deleted: a lane whose FIRST frame failed has shown the user nothing, so
    // settling it would invent a bubble. It must also not retry in a loop now
    // that the terminal path is open — `releaseReadyLanes` runs repeatedly.
    const h = makeDraftHarness({ decide: () => false });
    h.draft.handleAssistantMessageBoundary();
    h.draft.pushAnswerText({ text: "never seen" });
    await h.draft.drain();
    await h.draft.drain();

    expect(h.frames).toEqual([]);
    expect(h.attempts.filter((attempt) => attempt.type === "final")).toHaveLength(0);
    expect(h.attempts).toHaveLength(1);
  });

  it("M14d: a lane whose TERMINAL frame fails attempts it exactly once", async () => {
    // The fix opens a settle path that was previously closed, and
    // `releaseReadyLanes` iterates — so the failed terminal must latch.
    const h = makeDraftHarness({ decide: (attempt) => attempt.type !== "final" });
    h.draft.handleAssistantMessageBoundary();
    h.draft.pushAnswerText({ text: "visible" });
    h.draft.handleAssistantMessageBoundary();
    h.draft.pushAnswerText({ text: "second" });
    await h.draft.drain();
    await h.draft.drain();

    expect(h.attempts.filter((attempt) => attempt.type === "final" && attempt.text === "visible"))
      .toHaveLength(1);
  });

  /**
   * FLAGGED FOR JUDGEMENT — this expectation is INVERTED from what it was, and
   * it is one half of a pair. If the absorb counter comes back, so does the old
   * assertion; revert them together or neither.
   *
   * WHAT IT USED TO PROTECT: after the fail-safe rotated on a missed boundary,
   * a boundary arriving afterwards was treated as the LATE arrival for that same
   * seam and swallowed, so it could not rotate a second time. In #23's
   * controller a double roll appended a spurious separator inside the single
   * per-turn bubble, so swallowing was the cheaper error.
   *
   * WHY THE SHAPE IS NOT REACHABLE: core fires the boundary BEFORE that
   * message's first chunk is processed — `handleMessageStart`
   * (selection-BfRwHcjH.js:3788) and the stream-item-id change at :3859-3867,
   * which fires the boundary and only then handles the chunk — and this seam
   * puts boundaries and partials on one FIFO, so a boundary cannot trail its own
   * message's partials. The fixture's own body shows the inconsistency: the text
   * after the boundary is `"B later"`, a CONTINUATION of B's cumulative text. A
   * real boundary means a new message, whose cumulative text restarts. So this
   * sequence needs core both to omit B's boundary and to emit a boundary
   * mid-message, and the swallow it justified is what deleted the next real
   * message.
   *
   * The cost of the new behaviour is the reverse and much smaller: one spurious
   * rotation, whose empty lane emits no bubble at all (§6.2-3, M6).
   */
  it("M8: a boundary after a defensive rotation opens a new lane", async () => {
    const h = makeDraftHarness();
    h.draft.handleAssistantMessageBoundary();
    h.draft.pushAnswerText({ text: "A" });
    h.draft.pushAnswerText({ text: "B" }); // missed boundary -> defensive rotation
    const idB = h.frames.at(-1)!.id;

    h.draft.handleAssistantMessageBoundary(); // a REAL boundary: a new message
    h.draft.pushAnswerText({ text: "B later" });
    await h.draft.finalize("B final");

    // B keeps its own bubble and its own text; the new message gets its own id.
    const idC = h.frames.at(-1)!.id;
    expect(idC).not.toBe(idB);
    expect(h.frames.filter((frame) => frame.id === idB).at(-1)!.text).toBe("B");
    expect(h.frames.at(-1)).toEqual({ type: "final", id: idC, text: "B final" });
    expect(successfulIds(h.frames)).toHaveLength(3);
  });

  /**
   * #94 — a real boundary after a defensive rotation must open a new lane.
   *
   * CROSSES TWO GUARDS: the missed-boundary fail-safe and the boundary handler.
   * The fail-safe rotated for B's missing boundary and left a counter saying "one
   * boundary already handled"; the next REAL boundary — C's — was then swallowed
   * by that counter, so C's finalize landed on B's lane and overwrote it. B was
   * gone from the wire entirely.
   *
   * The control is the important half: the identical no-partial-for-C shape with
   * all three boundaries present renders all three messages. That is what shows
   * the absorb, not the missing partial, is the cause. Note the shape only bites
   * when C has no partial of its own — give C a partial and the fail-safe fires
   * a second time and happens to compensate, which is how this hid.
   */
  it("M15a: a real boundary after a defensive rotation is not swallowed", async () => {
    const h = makeDraftHarness();
    h.draft.handleAssistantMessageBoundary();
    h.draft.pushAnswerText({ text: "message A" });
    h.draft.pushAnswerText({ text: "message B" }); // B's boundary missing
    h.draft.handleAssistantMessageBoundary(); // C's REAL boundary
    await h.draft.finalize("message C");
    await h.draft.drain();

    expect(bubbleOrder(h.frames)).toEqual(["message A", "message B", "message C"]);
  });

  it("M15b: CONTROL — all boundaries present, same no-partial-for-C shape", async () => {
    const h = makeDraftHarness();
    h.draft.handleAssistantMessageBoundary();
    h.draft.pushAnswerText({ text: "message A" });
    h.draft.handleAssistantMessageBoundary();
    h.draft.pushAnswerText({ text: "message B" });
    h.draft.handleAssistantMessageBoundary();
    await h.draft.finalize("message C");
    await h.draft.drain();

    expect(bubbleOrder(h.frames)).toEqual(["message A", "message B", "message C"]);
  });

  it("M15c: the fail-safe itself still rotates on a diverging partial", async () => {
    // The other side of the deletion: removing the counter must not weaken the
    // fail-safe it was bolted onto.
    const warn = vi.fn();
    const h = makeDraftHarness({ logger: { warn } });
    h.draft.handleAssistantMessageBoundary();
    h.draft.pushAnswerText({ text: "message A" });
    h.draft.pushAnswerText({ text: "message B" }); // no boundary ever arrives
    await h.draft.finalize("message B final");
    await h.draft.drain();

    expect(bubbleOrder(h.frames)).toEqual(["message A", "message B final"]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("contract violation"));
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
    // POLICY: message order wins over notice-claims-P. Signed off by the tech
    // lead in round 10, for these reasons — recorded so it is not re-litigated:
    //
    //  - a terminal notice is about the TURN ending, so it belongs after the
    //    answer, not above it. "One utterance, one bubble, in model order" has
    //    no carve-out for notices; and
    //  - the scaffold bubble was the progress indicator for the message still
    //    being written, so that message's lane is the natural owner of the slot.
    //    Handing P to the held lane satisfies the no-ghost rule (§6.2-3) exactly
    //    as well as handing it to the notice, and gets the order right too — the
    //    notice-claims-P version was paying a correctness cost for nothing.
    //
    // This case used to assert the terminal notice claims P and renders ABOVE
    // the lane text held behind an unresolved predecessor — the same permanent
    // inversion this round fixes everywhere else, since the widget appends on an
    // unknown id and whoever emits first owns the higher slot forever.
    //
    // The P-claim RULE is unchanged ("the first successful claimant owns P", and
    // the three cases above still pin it for a notice). What changed is who is
    // first once a lane is holding text: message order now decides, so the
    // retained answer claims the scaffold slot and the notice appends below it.
    expect(retained.id).toBe(orderedP);
    expect(terminal.id).not.toBe(orderedP);
    expect(ordered.frames.indexOf(retained)).toBeLessThan(ordered.frames.indexOf(terminal));
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
  function setup(sendResults: boolean[] = []) {
    const frames: Array<{ id: string; turnId: string; text: string }> = [];
    let sendIndex = 0;
    const transport = {
      sendReasoning: (_peer: string, id: string, turnId: string, text: string) => {
        const sent = sendResults[sendIndex++] ?? true;
        if (sent) frames.push({ id, turnId, text });
        return sent;
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
    controller.pushDurableBlock({ text: "" });
    controller.pushDurableBlock({});
    controller.push({ text: "real" });
    expect(frames.map((frame) => frame.text)).toEqual(["real"]);
  });

  it("emits equal and shared-prefix durable blocks in full under distinct ids", () => {
    const { controller, frames } = setup();
    controller.pushDurableBlock({ text: "Plan" });
    controller.pushDurableBlock({ text: "Plan" });
    controller.pushDurableBlock({ text: "Plan carefully" });

    expect(frames.map((frame) => frame.text)).toEqual(["Plan", "Plan", "Plan carefully"]);
    expect(new Set(frames.map((frame) => frame.id)).size).toBe(3);
  });

  it("suppresses the CLI final replay only while its equal live burst is open", () => {
    const { controller, frames } = setup();
    controller.push({ text: "Plan" });
    // Pinned CLI shape: no onReasoningEnd; the final live snapshot is prepended
    // to the result as an equal durable isReasoning payload.
    controller.pushDurableBlock({ text: "Plan" });
    expect(frames.map((frame) => frame.text)).toEqual(["Plan"]);

    // Once the live burst was closed, an equal independent durable block is not
    // a proven replay and must retain its own wire id.
    controller.pushDurableBlock({ text: "Plan" });
    expect(frames.map((frame) => frame.text)).toEqual(["Plan", "Plan"]);
    expect(frames[0]?.id).not.toBe(frames[1]?.id);
  });

  it("emits the CLI durable replay when its matching live send was rejected", () => {
    const { controller, frames } = setup([false, true]);
    controller.push({ text: "Plan" });
    controller.pushDurableBlock({ text: "Plan" });

    expect(frames.map((frame) => frame.text)).toEqual(["Plan"]);
  });

  it("closes live reasoning before emitting a non-equal durable block in full", () => {
    const { controller, frames } = setup();
    controller.push({ text: "Plan" });
    controller.pushDurableBlock({ text: "Plan carefully" });

    expect(frames.map((frame) => frame.text)).toEqual(["Plan", "Plan carefully"]);
    expect(frames[0]?.id).not.toBe(frames[1]?.id);
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

  it("recognizes an open burst's exact raw snapshot after display-prefix stripping", () => {
    const { controller, frames } = setup();
    controller.push({ text: "AAA" });
    controller.endBurst();
    controller.push({ text: "AAABBB" }); // displayed as BBB; raw snapshot is AAABBB

    controller.pushDurableBlock({ text: "AAABBB" });
    expect(frames.map((frame) => frame.text)).toEqual(["AAA", "BBB"]);

    // The replay closed the live burst; equality no longer suppresses an
    // independent durable block.
    controller.pushDurableBlock({ text: "AAABBB" });
    expect(frames.map((frame) => frame.text)).toEqual(["AAA", "BBB", "AAABBB"]);
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
