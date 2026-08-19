import { describe, it, expect } from "vitest";

import { WebChannelNATSClient } from "./nats-client-wrapper.js";

/**
 * WP B (#95): hydration contract — reproduce the current normalizer's history
 * row projection deterministically.
 *
 * This does not claim that raw transcript rows equal live utterances, or that the
 * projection preserves every transcript relationship. WP A
 * (`packages/plugin/src/history-utterance-correspondence.test.ts`) constructs a
 * contract-compatible fixture in which two visible assistant messages produce
 * two projected rows; separately, the live progress path can settle one draft.
 *
 * So these tests assert two different things, and the distinction matters:
 *   - For a COLD reload (hydration into empty state) the timeline MUST be exactly
 *     one bubble per row, in row order. That is the contract.
 *   - For a MID-SESSION snapshot landing on live bubbles, these tests
 *     characterize the current reconciliation with the projected row sequence.
 *
 * Everything here is category B (our own code): no core behaviour is assumed.
 */

function makeWrapper(): WebChannelNATSClient {
  return new WebChannelNATSClient({
    natsUrl: "ws://127.0.0.1:4222",
    bootstrapJwt: "eyJ-bootstrap",
    accountId: "a",
    tenant: "t",
    peerId: "p",
    registration: {
      devicePrivateKey: {} as CryptoKey,
      deviceX25519PrivateKey: {} as CryptoKey,
    },
  });
}

type AnyFrame = { type: string; [k: string]: unknown };

/** Drive the private inbound dispatcher directly (no socket needed). */
function deliver(wrapper: WebChannelNATSClient, frame: AnyFrame): void {
  (wrapper as unknown as { handleMessage: (m: AnyFrame) => void }).handleMessage(frame);
}

type Row = { id: string; role: string; text: string; ts?: number; [k: string]: unknown };

function history(...messages: Row[]): AnyFrame {
  return { type: "history", messages };
}

/** The timeline as `role:text` pairs — the boundary-and-order projection. */
function timeline(wrapper: WebChannelNATSClient): string[] {
  return wrapper.getState().messages.map((m) => `${m.role}:${m.text}`);
}

/**
 * A projected history sequence built from WP A's explicit multi-step fixture.
 */
const TWO_STEP_ROWS: Row[] = [
  { id: "core-1", role: "user", text: "which agents are configured?", ts: 1 },
  { id: "core-2", role: "agent", text: "Let me check that.", ts: 2 },
  { id: "core-3", role: "agent", text: "You have three: alpha, beta, gamma.", ts: 3 },
];

describe("#95 WP B — cold reload is a faithful reconstruction of the row sequence", () => {
  /**
   * THE CONTRACT. Hydration into empty state — what a reloading tab does — must
   * produce exactly one bubble per row, in row order. No merging, no splitting,
   * no reordering.
   */
  it("produces exactly one bubble per row, in row order", () => {
    const w = makeWrapper();
    deliver(w, history(...TWO_STEP_ROWS));

    expect(timeline(w)).toEqual([
      "user:which agents are configured?",
      "agent:Let me check that.",
      "agent:You have three: alpha, beta, gamma.",
    ]);
    expect(w.getState().messages.map((m) => m.id)).toEqual(["core-1", "core-2", "core-3"]);
  });

  /**
   * Two reloads of the same transcript are indistinguishable — and each is
   * actually populated. The non-emptiness assertion is load-bearing: equality
   * alone passes vacuously when both wrappers hydrate nothing, which is exactly
   * what a dedup set accidentally shared across instances would produce.
   */
  it("is deterministic across repeated reloads, and both are populated", () => {
    const a = makeWrapper();
    deliver(a, history(...TWO_STEP_ROWS));
    const b = makeWrapper();
    deliver(b, history(...TWO_STEP_ROWS));

    expect(timeline(a)).toEqual(timeline(b));
    expect(timeline(a)).toHaveLength(TWO_STEP_ROWS.length);
  });

  /** A re-delivered snapshot must not duplicate or reorder anything. */
  it("is idempotent — re-delivering the same snapshot is a no-op", () => {
    const w = makeWrapper();
    deliver(w, history(...TWO_STEP_ROWS));
    const first = timeline(w);
    deliver(w, history(...TWO_STEP_ROWS));

    expect(timeline(w)).toEqual(first);
  });

  /**
   * Adjacent agent rows with IDENTICAL text are two distinct utterances and must
   * stay two bubbles. Text-equality dedup would collapse them; row identity must
   * win.
   */
  it("keeps adjacent identical-text agent rows as separate bubbles", () => {
    const w = makeWrapper();
    deliver(
      w,
      history(
        { id: "core-1", role: "user", text: "again?", ts: 1 },
        { id: "core-2", role: "agent", text: "Done.", ts: 2 },
        { id: "core-3", role: "agent", text: "Done.", ts: 3 },
      ),
    );

    expect(timeline(w)).toEqual(["user:again?", "agent:Done.", "agent:Done."]);
  });

  /** An older page prepends in row order, ahead of what is already held. */
  it("prepends a paginated older page in row order", () => {
    const w = makeWrapper();
    deliver(w, history(...TWO_STEP_ROWS));
    deliver(
      w,
      history(
        { id: "core-a", role: "user", text: "earlier question", ts: -2 },
        { id: "core-b", role: "agent", text: "earlier answer", ts: -1 },
      ),
    );

    expect(timeline(w)).toEqual([
      "user:earlier question",
      "agent:earlier answer",
      "user:which agents are configured?",
      "agent:Let me check that.",
      "agent:You have three: alpha, beta, gamma.",
    ]);
  });

  /** `ts` is optional on the wire; a row without it still hydrates in order. */
  it("hydrates rows with no ts, preserving row order", () => {
    const w = makeWrapper();
    deliver(
      w,
      history(
        { id: "core-1", role: "user", text: "first" },
        { id: "core-2", role: "agent", text: "second" },
      ),
    );

    expect(timeline(w)).toEqual(["user:first", "agent:second"]);
  });
});

describe("#95 WP B — live timeline converges to the row sequence", () => {
  /**
   * The simple case: live text equals stored text. Tier 2 adopts, and the
   * reloaded and live timelines agree exactly.
   */
  it("a live session and a cold reload of the same transcript agree", () => {
    const live = makeWrapper();
    live.send("which agents are configured?");
    deliver(live, { type: "agent_message", id: "webchannel-1", text: "Let me check that." });
    deliver(live, {
      type: "agent_message",
      id: "webchannel-2",
      text: "You have three: alpha, beta, gamma.",
    });
    deliver(live, history(...TWO_STEP_ROWS));

    const cold = makeWrapper();
    deliver(cold, history(...TWO_STEP_ROWS));

    expect(timeline(live)).toEqual(timeline(cold));
  });

  /**
   * TIER 3, the fragile path. When the live and stored text differ, tier 2
   * misses and the POSITIONAL anchor must carry the adoption.
   */
  it("tier 3 adopts positionally when live text differs from stored text", () => {
    const w = makeWrapper();
    w.send("which agents are configured?");
    deliver(w, {
      type: "agent_message",
      id: "webchannel-1",
      text: "LIVE reformatted answer",
      assistantMessageIndex: 1,
    });

    deliver(
      w,
      history(
        { id: "core-1", role: "user", text: "which agents are configured?", ts: 1 },
        { id: "core-2", role: "agent", text: "STORED raw answer", ts: 2 },
      ),
    );

    // One user bubble and one agent bubble — no duplicate — and the incoming
    // stored text won.
    expect(timeline(w)).toEqual(["user:which agents are configured?", "agent:STORED raw answer"]);
    expect(w.getState().messages.map((m) => m.id)).toEqual(["core-1", "core-2"]);
    expect(w.getState().messages[1]).not.toHaveProperty("assistantMessageIndex");
  });

  /**
   * TIER 3 WHERE THIS FIXTURE'S ROWS OUTNUMBER ITS SEEDED LIVE BUBBLES.
   *
   * The seeded state contains ONE agent bubble while the snapshot carries TWO
   * agent rows. This does not claim how a particular live/core execution reached
   * either shape. It characterizes what the reducer does: convergence to the
   * projection rewrites the live bubble's text to the first row and appends the
   * second.
   *
   * What matters for the contract is the post-condition, and it does hold: the
   * final timeline equals the cold-reload timeline exactly — same boundaries,
   * same order, nothing duplicated, nothing lost.
   */
  it("converges when incoming rows outnumber seeded live bubbles", () => {
    const w = makeWrapper();
    w.send("which agents are configured?");
    deliver(w, {
      type: "agent_message",
      id: "webchannel-1",
      text: "You have three: alpha, beta, gamma.",
    });
    expect(timeline(w)).toEqual([
      "user:which agents are configured?",
      "agent:You have three: alpha, beta, gamma.",
    ]);

    deliver(w, history(...TWO_STEP_ROWS));

    const cold = makeWrapper();
    deliver(cold, history(...TWO_STEP_ROWS));

    expect(timeline(w)).toEqual(timeline(cold));
    expect(w.getState().messages.map((m) => m.id)).toEqual(["core-1", "core-2", "core-3"]);
  });

  /**
   * A `working:true` progress draft is never an adoption target — its live id
   * must survive for the upcoming progress/final upserts. The snapshot row must
   * therefore insert rather than steal the draft's identity.
   */
  it("never adopts onto a working progress draft", () => {
    const w = makeWrapper();
    w.send("q");
    deliver(w, { type: "progress", id: "draft-1", text: "Working…" });
    const draftBefore = w.getState().messages.find((m) => m.working === true);
    expect(draftBefore?.id).toBe("draft-1");

    deliver(w, history({ id: "core-9", role: "agent", text: "Working…", ts: 9 }));

    const draftAfter = w.getState().messages.find((m) => m.working === true);
    expect(draftAfter?.id).toBe("draft-1");
  });
});

/**
 * #173 — the keyframe is an AUTHORITATIVE REPLACE of the region it COVERS, not
 * the additive merge `history` performs and not a blanket wipe. The plugin emits
 * it at settlement when it detected the tool-only-turn overwrite path corrupted
 * the live view ([A,A,B]). The client rebuilds the covered region from the rows
 * exactly as a fresh reload would, keeps any strictly-older paginated scrollback
 * the window does not carry, and re-appends its local not-yet-transmitted chips.
 */
describe("#173 WP — keyframe is an authoritative replace", () => {
  function keyframe(...messages: Row[]): AnyFrame {
    return { type: "keyframe", messages };
  }

  const KEYFRAME_ROWS: Row[] = [
    { id: "A", role: "agent", text: "A", ts: 1 },
    { id: "B", role: "agent", text: "B", ts: 2 },
  ];

  /** The live-corruption shape #173 describes: A finalized twice, then B. */
  function seedCorruptLiveView(w: WebChannelNATSClient): void {
    deliver(w, { type: "agent_message", id: "live-1", text: "A" });
    deliver(w, { type: "agent_message", id: "live-2", text: "A" });
    deliver(w, { type: "agent_message", id: "live-3", text: "B" });
    expect(timeline(w)).toEqual(["agent:A", "agent:A", "agent:B"]);
  }

  it("a keyframe [A,B] over a live [A,A,B] yields [A,B] — the extra bubble is gone", () => {
    const w = makeWrapper();
    seedCorruptLiveView(w);

    deliver(w, keyframe(...KEYFRAME_ROWS));

    expect(timeline(w)).toEqual(["agent:A", "agent:B"]);
    // Canonical transcript ids and working:false — the corrupt live ids are gone.
    const messages = w.getState().messages;
    expect(messages.map((m) => m.id)).toEqual(["A", "B"]);
    expect(messages.every((m) => m.working === false)).toBe(true);
  });

  it("ordering and content equal a fresh reload of the same rows", () => {
    const live = makeWrapper();
    seedCorruptLiveView(live);
    deliver(live, keyframe(...KEYFRAME_ROWS));

    // A cold reload hydrates the SAME rows via history into empty state.
    const cold = makeWrapper();
    deliver(cold, history(...KEYFRAME_ROWS));

    expect(timeline(live)).toEqual(timeline(cold));
    expect(live.getState().messages.map((m) => m.id)).toEqual(
      cold.getState().messages.map((m) => m.id),
    );
  });

  it("preserves paginated older scrollback outside the keyframe window", () => {
    const w = makeWrapper();
    // Older scrollback the device paginated in (canonical transcript ids)…
    deliver(
      w,
      history(
        { id: "older1", role: "user", text: "q1", ts: 1 },
        { id: "older2", role: "agent", text: "r1", ts: 2 },
        { id: "older3", role: "user", text: "q2", ts: 3 },
        { id: "older4", role: "agent", text: "r2", ts: 4 },
        { id: "older5", role: "user", text: "q3", ts: 5 },
      ),
    );
    // …then the corrupt live tail ([A,A,B]).
    deliver(w, { type: "agent_message", id: "live-1", text: "A" });
    deliver(w, { type: "agent_message", id: "live-2", text: "A" });
    deliver(w, { type: "agent_message", id: "live-3", text: "B" });
    expect(w.getState().messages.map((m) => m.id)).toEqual([
      "older1",
      "older2",
      "older3",
      "older4",
      "older5",
      "live-1",
      "live-2",
      "live-3",
    ]);

    // The keyframe is a tail window that OVERLAPS at older4 and carries the
    // corrected tail.
    deliver(
      w,
      keyframe(
        { id: "older4", role: "agent", text: "r2", ts: 4 },
        { id: "older5", role: "user", text: "q3", ts: 5 },
        { id: "A", role: "agent", text: "A", ts: 6 },
        { id: "B", role: "agent", text: "B", ts: 7 },
      ),
    );

    // older1..3 kept (uncovered scrollback), older4/5 rebuilt from the keyframe,
    // the extra bubble gone — no truncation to the window.
    expect(w.getState().messages.map((m) => m.id)).toEqual([
      "older1",
      "older2",
      "older3",
      "older4",
      "older5",
      "A",
      "B",
    ]);
  });

  it("falls back to a full replace when the keyframe's oldest id is absent (no overlap)", () => {
    const w = makeWrapper();
    // A live bubble whose id the keyframe does not cover.
    deliver(w, { type: "agent_message", id: "live-x", text: "stale" });

    deliver(
      w,
      keyframe(
        { id: "N1", role: "user", text: "hi", ts: 1 },
        { id: "N2", role: "agent", text: "yo", ts: 2 },
      ),
    );

    // No overlap → full replace with the keyframe rows.
    expect(w.getState().messages.map((m) => m.id)).toEqual(["N1", "N2"]);
    expect(timeline(w)).toEqual(["user:hi", "agent:yo"]);
  });

  it("applying the same keyframe twice is idempotent", () => {
    const w = makeWrapper();
    seedCorruptLiveView(w);

    deliver(w, keyframe(...KEYFRAME_ROWS));
    const once = w.getState().messages;
    deliver(w, keyframe(...KEYFRAME_ROWS));

    expect(w.getState().messages).toEqual(once);
  });

  it("preserves a pending local user chip at the tail", () => {
    const w = makeWrapper();
    seedCorruptLiveView(w);
    // A turn is in flight (typing), so the next send is HELD as a local-only
    // pending chip — never on the wire, absent from the transcript a keyframe
    // rebuilds from.
    deliver(w, { type: "typing" });
    w.send("unsent draft");
    const pending = w
      .getState()
      .messages.find((m) => m.pending === true && m.role === "user");
    expect(pending).toBeDefined();

    deliver(w, keyframe(...KEYFRAME_ROWS));

    const after = w.getState().messages;
    // Agent rows rebuilt from the keyframe, the pending chip re-appended at the tail.
    expect(after.map((m) => `${m.role}:${m.text}`)).toEqual([
      "agent:A",
      "agent:B",
      "user:unsent draft",
    ]);
    const tail = after[after.length - 1];
    expect(tail.pending).toBe(true);
    expect(tail.id).toBe(pending!.id);
  });
});
