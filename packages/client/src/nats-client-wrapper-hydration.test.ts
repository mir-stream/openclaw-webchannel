import { describe, it, expect } from "vitest";

import { WebChannelNATSClient } from "./nats-client-wrapper.js";

/**
 * WP B (#95): hydration contract — the transcript row is CANONICAL and the live
 * timeline must converge to it.
 *
 * SCOPE OF "CANONICAL", stated precisely because the naive reading is false:
 * the transcript is canonical for ORDER and BOUNDARY IDENTITY. It is NOT
 * row-set-equal to the set of live utterances — WP A
 * (`packages/plugin/src/history-utterance-correspondence.test.ts`) measured a
 * single-tool-round turn rendering as ONE live bubble while producing TWO
 * transcript rows, because core appends one assistant message per model step and
 * the mid-turn status text is overwritten in the live progress draft rather than
 * settled as its own bubble.
 *
 * So these tests assert two different things, and the distinction matters:
 *   - For a COLD reload (hydration into empty state) the timeline MUST be exactly
 *     one bubble per row, in row order. That is the contract.
 *   - For a MID-SESSION snapshot landing on live bubbles, the timeline must
 *     CONVERGE to the row sequence without duplicating or losing anything. Where
 *     rows outnumber live bubbles, convergence necessarily mutates a live bubble
 *     and appends — that is characterized here, not asserted to be desirable.
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
 * A transcript for one user question answered across two model steps. This is
 * the exact shape WP A measured: two agent rows, one live utterance.
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
   * TIER 3, the fragile path. Core stores raw model output while the live path
   * delivers sanitized text, so tier 2 misses on agent rows and the POSITIONAL
   * anchor must carry the adoption. Boundaries and order must still converge.
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

    // One user bubble and one agent bubble — no duplicate — and the canonical
    // stored text won.
    expect(timeline(w)).toEqual(["user:which agents are configured?", "agent:STORED raw answer"]);
    expect(w.getState().messages.map((m) => m.id)).toEqual(["core-1", "core-2"]);
  });

  /**
   * TIER 3 WHERE ROWS OUTNUMBER LIVE BUBBLES — the case WP A proved is real.
   *
   * Live produced ONE agent bubble for this turn (the mid-turn status text was
   * overwritten in the progress draft). The snapshot carries TWO agent rows.
   * CHARACTERIZATION of what the reducer actually does, not an endorsement:
   * convergence to the transcript is achieved by REWRITING the live bubble's text
   * to the first row and APPENDING the second. The user-visible artifact is a
   * bubble that mutates its text under them.
   *
   * What matters for the contract is the post-condition, and it does hold: the
   * final timeline equals the cold-reload timeline exactly — same boundaries,
   * same order, nothing duplicated, nothing lost.
   */
  it("converges to the row sequence when a turn's rows outnumber its live bubbles", () => {
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

describe("#95 WP B — additive wire fields (no protocol bump)", () => {
  /**
   * REGRESSION GUARD, scoped honestly: nothing in the reducer ACCEPTS unknown
   * fields — it builds a fresh row from known fields and never enumerates the
   * input, so unknown fields are ignored by omission. This test exists to fail if
   * someone later adds a strict validator that would REJECT them, which is what
   * would silently force a protocol bump.
   *
   * `WEBCHANNEL_PROTOCOL_VERSION` is enforced as strict equality in both
   * directions with no negotiation (`nats-register.ts:392-398`,
   * `nats-client.ts:1872-1881`), so a bump hard-fails every deployed pair until
   * both redeploy. Keeping additive fields genuinely additive is what avoids it.
   */
  it("tolerates rows carrying unknown/future optional fields", () => {
    const w = makeWrapper();
    deliver(
      w,
      history(
        { id: "core-1", role: "user", text: "hi", ts: 1, somethingNew: { nested: true } },
        { id: "core-2", role: "agent", text: "hello", ts: 2, failed: false, seq: 42 },
      ),
    );

    expect(timeline(w)).toEqual(["user:hi", "agent:hello"]);
  });

  /**
   * The mirror property: a row from an OLDER plugin omits the new optional fields
   * entirely and must hydrate identically. Absent `failed` reads as "not failed" —
   * a genuinely failed turn from an old plugin renders as an ordinary bubble,
   * which is exactly today's behaviour. Named in the plan as a documented
   * degradation, not a silent one.
   */
  it("hydrates rows that omit the new optional fields", () => {
    const withFields = makeWrapper();
    deliver(
      withFields,
      history({ id: "core-1", role: "agent", text: "boom", ts: 1, failed: false }),
    );
    const withoutFields = makeWrapper();
    deliver(withoutFields, history({ id: "core-1", role: "agent", text: "boom", ts: 1 }));

    expect(timeline(withFields)).toEqual(timeline(withoutFields));
  });

  /** `ts` is optional on the wire; a row without it must still hydrate in order. */
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
