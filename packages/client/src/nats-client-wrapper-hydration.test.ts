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
    deliver(w, { type: "agent_message", id: "webchannel-1", text: "LIVE reformatted answer" });

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
