import { describe, it, expect } from "vitest";

import { WebChannelNATSClient } from "./nats-client-wrapper.js";

/**
 * WP B (#95): hydration contract — given a `history` frame, reproduce the
 * client's timeline deterministically.
 *
 * ⚠️ THE PREMISE WAS REWRITTEN BY #240 HALF 2. This docblock used to say these
 * tests "reproduce the current NORMALIZER's history row projection", and cited
 * WP A (`packages/plugin/src/history-utterance-correspondence.test.ts`) as the
 * companion fixture. Both references are dead: the plugin no longer normalizes a
 * core transcript — history is projected from its own delivery journal
 * (`journal-history.ts`) — and that WP A file was DELETED with the normalizer it
 * characterized. Do not derive any claim from it.
 *
 * What these tests actually pin is unchanged and still entirely ours: the CLIENT
 * side of the contract. They take a `history` frame as GIVEN and assert what the
 * wrapper does with it. That is deliberately independent of where the rows come
 * from, which is why the cutover did not invalidate them — but it does mean they
 * say nothing about whether the server's rows are faithful. Server-side fidelity
 * now lives in `journal-history.test.ts` and `history-serve.test.ts`.
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
 * A projected history sequence: one user turn answered by two agent bubbles.
 *
 * (It was described as "built from WP A's explicit multi-step fixture" — WP A
 * was the plugin-side normalizer characterization, deleted with the normalizer
 * by #240 half 2. The rows are just rows; nothing here depends on how a server
 * produced them.)
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
  /**
   * ⚠️ AN EARLIER REVISION OF THIS NOTE CALLED TIER 3 "DEAD IN PRODUCTION SINCE
   * #240 HALF 2". THAT WAS WRONG, and the two `#240 half 2` describes at the
   * bottom of this file are the proof: an unauthored-placement row
   * (`{agent, ""}`) reached tier 3 and OVERWROTE the next real answer. It is
   * unreachable for that shape now only because the wrapper FILTERS those rows
   * on arrival — a fix, not a property of the cutover.
   *
   * What IS true: this fixture's specific shape — a snapshot id differing from
   * the live id AND stored text differing from live text — cannot arise from the
   * journal, which stores the delivery-act id and the exact published text. So
   * this test characterizes a branch that production no longer drives THIS WAY,
   * while other rows can still reach it. Keep it while the tier exists.
   *
   * Removing the tier is tracked at doc §5's non-scope list ("client text/위치
   * 매칭 제거", #104/#227/#228) — not a "§15.6 follow-up list", which does not
   * exist; §15.6 in fact says the adoption block is removable TOGETHER with the
   * cutover.
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
 * #240 half 2 — TWO DATA-LOSS DEFECTS THE CUTOVER MADE REACHABLE.
 *
 * ⚠️ THESE ARE REGRESSIONS OF THE SERVER CHANGE, SURFACING IN CLIENT CODE THAT
 * WAS NOT EDITED. Both were mis-scoped as "the client still works" during
 * review, on the reasoning that agent bubbles simply move from tier 3 to tier 1.
 * They do — and the id change that makes them do it is exactly what breaks these
 * two paths. Each test below is PAIRED with a `core-`-id control reproducing the
 * pre-cutover input, so the diff between them IS the regression.
 */
describe("#240 half 2 — journal ids make a tier-1 match a live adoption target", () => {
  it("keeps two identical agent answers as two bubbles", () => {
    // The live bubble and snapshot row 1 share the delivery-act id, so row 1 is
    // a tier-1 match. Row 2 carries the SAME TEXT under a different id. Without
    // the tier-1 claim, row 2 adopts onto the already-matched bubble and one
    // delivered answer disappears.
    const w = makeWrapper();
    deliver(w, { type: "agent_message", id: "webchannel-1", text: "ok" });
    deliver(
      w,
      history(
        { id: "webchannel-1", role: "agent", text: "ok", ts: 1 },
        { id: "webchannel-2", role: "agent", text: "ok", ts: 2 },
      ),
    );

    expect(w.getState().messages.map((m) => `${m.id}|${m.text}`)).toEqual([
      "webchannel-1|ok",
      "webchannel-2|ok",
    ]);
  });

  it("CONTROL: the same shape with pre-cutover core ids was already correct", () => {
    // `core-…` fails `isLocalLiveId`, so a tier-1-matched bubble never entered
    // the tier-2 pool and the defect could not occur. This is what "the cutover
    // is what changed the outcome" means, stated as a test rather than a claim.
    const w = makeWrapper();
    deliver(w, { type: "agent_message", id: "webchannel-1", text: "ok" });
    deliver(
      w,
      history(
        { id: "core-1", role: "agent", text: "ok", ts: 1 },
        { id: "core-2", role: "agent", text: "ok", ts: 2 },
      ),
    );

    expect(timeline(w)).toEqual(["agent:ok", "agent:ok"]);
  });

  it("still dedups a repeated snapshot of one bubble (no over-claiming)", () => {
    // The claim must not break ordinary idempotence: re-delivering the same
    // frame twice is still a no-op.
    const w = makeWrapper();
    deliver(w, { type: "agent_message", id: "webchannel-1", text: "ok" });
    const frame = history({ id: "webchannel-1", role: "agent", text: "ok", ts: 1 });
    deliver(w, frame);
    deliver(w, frame);

    expect(w.getState().messages.map((m) => `${m.id}|${m.text}`)).toEqual([
      "webchannel-1|ok",
    ]);
  });
});

describe("#240 half 2 — a phantom empty agent row must never reach tier 3", () => {
  it("does not let an unauthored placement overwrite the next real answer", () => {
    // `webchannel-P` is a lane that got a `progress` and never any durable text
    // (aborted turn / dropped connection). Live drops it via `dropSpentDrafts`;
    // the journal cannot, because that rule keys on the client-local `draftOnly`
    // flag. Un-filtered it matches no text, falls to tier 3, and overwrites the
    // real answer that follows it.
    const w = makeWrapper();
    w.send("hi");
    deliver(w, { type: "agent_message", id: "webchannel-2", text: "real answer" });
    const userId = w.getState().messages[0].id;

    deliver(
      w,
      history(
        { id: userId, role: "user", text: "hi", ts: 1 },
        { id: "webchannel-P", role: "agent", text: "", ts: 2 },
        { id: "webchannel-2", role: "agent", text: "real answer", ts: 3 },
      ),
    );

    expect(w.getState().messages.map((m) => `${m.id}|${m.role}|${m.text}`)).toEqual([
      `${userId}|user|hi`,
      "webchannel-2|agent|real answer",
    ]);
  });

  it("CONTROL: the same phantom under a core id also could not adopt", () => {
    // Pre-cutover the phantom row simply did not exist (core's transcript never
    // held an unauthored placement) AND a `core-` id fails `isLocalLiveId`. This
    // pins that the filter, not the id namespace, is what protects us now.
    const w = makeWrapper();
    w.send("hi");
    deliver(w, { type: "agent_message", id: "webchannel-2", text: "real answer" });
    const userId = w.getState().messages[0].id;

    deliver(
      w,
      history(
        { id: userId, role: "user", text: "hi", ts: 1 },
        { id: "core-2", role: "agent", text: "real answer", ts: 2 },
      ),
    );

    expect(timeline(w)).toEqual(["user:hi", "agent:real answer"]);
  });

  it("drops a phantom row on COLD hydration too, rather than rendering a blank", () => {
    const w = makeWrapper();
    deliver(
      w,
      history(
        { id: "webchannel-P", role: "agent", text: "", ts: 1 },
        { id: "webchannel-2", role: "agent", text: "answer", ts: 2 },
      ),
    );

    expect(timeline(w)).toEqual(["agent:answer"]);
  });

  it("treats an all-phantom frame as a no-op, not an empty timeline", () => {
    const w = makeWrapper();
    deliver(w, { type: "agent_message", id: "webchannel-1", text: "kept" });
    deliver(w, history({ id: "webchannel-P", role: "agent", text: "", ts: 1 }));

    expect(timeline(w)).toEqual(["agent:kept"]);
  });

  it("does NOT drop an empty USER row — the rule is agent-only", () => {
    // `isSpentDraft` is agent-only and so is this. A user row is never a spent
    // draft, and widening the filter would silently discard wire content.
    const w = makeWrapper();
    deliver(w, history({ id: "wire-1", role: "user", text: "", ts: 1 }));

    expect(w.getState().messages.map((m) => `${m.id}|${m.role}|${m.text}`)).toEqual([
      "wire-1|user|",
    ]);
  });
});
