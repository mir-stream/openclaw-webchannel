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

/**
 * The same conversation as the JOURNAL actually serves it, which is what every
 * MID-SESSION test below must use.
 *
 * The ids are the difference and it is the whole point: an agent row carries the
 * DELIVERY-ACT id (`webchannel-…`) — byte-identical to the id the live frame
 * carried — and a user row carries the inbound WIRE id, which is a random token
 * and never the client's local `u-<n>` echo id. `TWO_STEP_ROWS`' `core-…` ids
 * cannot arise from the journal at all; they are kept only where the test is
 * genuinely id-agnostic (the cold-reload block, which hydrates into empty state).
 */
const JOURNAL_TWO_STEP_ROWS: Row[] = [
  { id: "wire-8f3a1c", role: "user", text: "which agents are configured?", ts: 1 },
  { id: "webchannel-1", role: "agent", text: "Let me check that.", ts: 2 },
  { id: "webchannel-2", role: "agent", text: "You have three: alpha, beta, gamma.", ts: 3 },
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
   * The ordinary post-cutover case: every agent row TIER-1 matches (same
   * delivery-act id), the user row tier-2 adopts, and the live and reloaded
   * timelines agree exactly.
   *
   * ⚠️ RE-BASED ONTO JOURNAL IDS. This used to deliver `TWO_STEP_ROWS`
   * (`core-…`) into a live session and pass because tier 2/3 GUESSED the agent
   * correspondence. Those tiers are deleted, and a `core-` agent id is a shape
   * the journal cannot emit, so the old fixture now asserts nothing about
   * production — it would just measure how many duplicates an impossible frame
   * produces. The convergence property it is named for is real and is what is
   * asserted here, against the ids the server actually sends.
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
    deliver(live, history(...JOURNAL_TWO_STEP_ROWS));

    const cold = makeWrapper();
    deliver(cold, history(...JOURNAL_TWO_STEP_ROWS));

    expect(timeline(live)).toEqual(timeline(cold));
    expect(live.getState().messages).toHaveLength(3);
    expect(live.getState().messages.map((m) => m.id)).toEqual([
      "wire-8f3a1c",
      "webchannel-1",
      "webchannel-2",
    ]);
  });

  /**
   * TIER-3 REMOVAL GUARD — the positional probe must not come back.
   *
   * ⚠️ THIS TEST WAS `tier 3 adopts positionally when live text differs from
   * stored text` AND IT ASSERTED THE OPPOSITE. It is inverted rather than
   * deleted because the SHAPE is still the one that matters: an agent row that
   * matches no local text, arriving right after a row that DID match, is exactly
   * what the old probe would have grabbed. The probe adopted the next agent
   * bubble on the theory that a reply follows the message it answers — which is
   * a guess, and post-cutover a provably wrong one: if this device had rendered
   * that answer, the row would carry its id and tier 1 would have matched.
   * Missing tier 1 means there is no local counterpart, so the row must
   * FRESH-INSERT and the local bubble must survive untouched.
   *
   * The old fixture's premise is doubly dead: it needed live text ≠ stored text,
   * which the journal cannot produce (it stores exactly what was published).
   */
  it("does not positionally adopt an agent row that matches no local text", () => {
    const w = makeWrapper();
    w.send("which agents are configured?");
    // An answer THIS device rendered live.
    deliver(w, {
      type: "agent_message",
      id: "webchannel-1",
      text: "the answer this device rendered",
    });

    // A snapshot whose user row matches (so the old probe would have had an
    // anchor) followed by an agent row this device never rendered — a turn from
    // another device, or one that landed while this tab was away.
    deliver(
      w,
      history(
        { id: "wire-8f3a1c", role: "user", text: "which agents are configured?", ts: 1 },
        { id: "webchannel-7", role: "agent", text: "an answer this device never saw", ts: 2 },
      ),
    );

    // Three bubbles: the adopted user echo, the inserted row, and the local
    // answer INTACT. Under tier 3 this was two — `webchannel-1`'s text was
    // overwritten with the incoming row's and a delivered answer was destroyed.
    expect(w.getState().messages.map((m) => `${m.id}|${m.role}|${m.text}`)).toEqual([
      "wire-8f3a1c|user|which agents are configured?",
      "webchannel-7|agent|an answer this device never saw",
      "webchannel-1|agent|the answer this device rendered",
    ]);
  });

  /**
   * WHERE THE SNAPSHOT'S ROWS OUTNUMBER THE SEEDED LIVE BUBBLES: this device
   * rendered only the SECOND answer (the first frame was missed), and the
   * snapshot carries both.
   *
   * Post-cutover the reducer no longer has to guess which is which: row 2's id
   * is unknown here so it fresh-inserts, row 3's id IS the local bubble's so
   * tier 1 matches it in place, and the cursor puts the insert ahead of it. The
   * post-condition is the one this test is named for and it holds exactly — the
   * final timeline equals the cold-reload timeline, nothing duplicated, nothing
   * lost.
   *
   * ⚠️ RE-BASED ONTO JOURNAL IDS, AND IT MATTERS FOR THIS ONE SPECIFICALLY.
   * Under `TWO_STEP_ROWS`' `core-` ids this was the minimal reproducer for the
   * "displaced identity" defect (an adoption left the displaced id in `seen`, so
   * the snapshot's own later row for it was dropped) — and it did NOT catch that
   * defect, because pre-cutover ids never collided with local ones. It also
   * absorbs the separate `keeps a row whose id was displaced by a tier-3
   * adoption` case added while that defect was being fixed: same fixture, same
   * property, and with agent adoption gone there is no longer a distinct
   * mechanism to pin.
   */
  it("converges when incoming rows outnumber seeded live bubbles", () => {
    const w = makeWrapper();
    w.send("which agents are configured?");
    deliver(w, {
      type: "agent_message",
      id: "webchannel-2",
      text: "You have three: alpha, beta, gamma.",
    });
    expect(timeline(w)).toEqual([
      "user:which agents are configured?",
      "agent:You have three: alpha, beta, gamma.",
    ]);

    deliver(w, history(...JOURNAL_TWO_STEP_ROWS));

    const cold = makeWrapper();
    deliver(cold, history(...JOURNAL_TWO_STEP_ROWS));

    expect(timeline(w)).toEqual(timeline(cold));
    expect(w.getState().messages).toHaveLength(3);
    expect(w.getState().messages.map((m) => m.id)).toEqual([
      "wire-8f3a1c",
      "webchannel-1",
      "webchannel-2",
    ]);
  });

  /**
   * A `working:true` progress draft keeps its live id, so the upcoming
   * progress/final upserts still land on it.
   *
   * ⚠️ THE MECHANISM CHANGED — this is now an OUTCOME guard. The draft used to
   * be protected by an explicit `!m.working` clause in the adoption predicate;
   * that predicate is user-only now, and `working` is an agent-bubble state, so
   * a draft is out of reach because AGENT rows cannot adopt at all. The assertion
   * is kept because the user-visible property is what matters and a future
   * change could reintroduce the hazard by a different route.
   */
  it("never adopts onto a working progress draft", () => {
    const w = makeWrapper();
    w.send("q");
    deliver(w, { type: "progress", id: "draft-1", text: "Working…" });
    const draftBefore = w.getState().messages.find((m) => m.working === true);
    expect(draftBefore?.id).toBe("draft-1");

    deliver(w, history({ id: "webchannel-9", role: "agent", text: "Working…", ts: 9 }));

    const draftAfter = w.getState().messages.find((m) => m.working === true);
    expect(draftAfter?.id).toBe("draft-1");
  });
});


/**
 * #240 half 2 — THE AGENT PATH NO LONGER ADOPTS. Tier 2 rejects agent rows and
 * tier 3 is deleted.
 *
 * FOUR data-loss defects were found here in four consecutive review rounds of
 * one PR, each patched by adding a rule and each rule failing to cover the next
 * instance: (1) tier 1 matched without claiming its index; (2) an unauthored
 * `{agent, ""}` placement row reached tier 3 and overwrote the next real answer;
 * (3) `adoptAt` did not retire the id it displaced; (4) a history-HYDRATED agent
 * bubble was itself adoptable, so an older page destroyed the newest answer.
 *
 * The tiers existed to GUESS a correspondence the cutover made unnecessary: the
 * journal serves the delivery-act id and the live bubble carries that same id,
 * so an agent row that misses tier 1 has NO local counterpart and every adoption
 * of one overwrote a different message. The tests below pin the deletion in both
 * directions the guessing used to go — by text (old tier 2) and by position
 * (old tier 3) — plus the cross-frame case that produced defect (4).
 *
 * ⚠️ THE `core-`-ID CONTROLS THAT USED TO LIVE HERE ARE DELETED, not moved. They
 * existed to show "the cutover is what changed the outcome" by running the same
 * fixture under both id namespaces. With agent adoption gone, NEITHER namespace
 * adopts, so a control has no differential left to demonstrate — and a `core-`
 * agent id is a shape the journal cannot emit in the first place.
 */
describe("#240 half 2 — the agent path no longer adopts (tiers 2 and 3 deleted)", () => {
  it("keeps two identical agent answers as two bubbles", () => {
    // Row 1 shares the delivery-act id with the live bubble → tier 1, in place.
    // Row 2 carries the SAME TEXT under a different id → no local counterpart,
    // so it fresh-inserts after it. Under tier 2 it adopted onto the bubble row
    // 1 had just identified and one delivered answer disappeared (defect 1).
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

  it("does not adopt an agent row onto a same-text local bubble with a different id", () => {
    // TIER-2 REMOVAL GUARD, deliberately MINIMAL: one local answer, one snapshot
    // row, identical text, different ids. Text equality is not identity — these
    // are two distinct utterances, and a row that matches no id has no local
    // counterpart, so it must insert rather than rename the local bubble.
    //
    // Kept to a single row on purpose. The obvious richer fixture (this device
    // holds the LATER of two identical answers, the snapshot carries both) is
    // ALREADY green on the pre-deletion code — the second row tier-1 matches and
    // the first one's adoption is invisible in the final array — so it would
    // have looked like a guard while discriminating nothing.
    //
    // (Repurposed from `keeps a row whose id was displaced by a tier-2
    // adoption`. That name described the defect-3 hazard, which needed an
    // adoption to displace an AGENT id — impossible now.)
    const w = makeWrapper();
    deliver(w, { type: "agent_message", id: "webchannel-2", text: "ok" });
    deliver(w, history({ id: "webchannel-1", role: "agent", text: "ok", ts: 1 }));

    expect(w.getState().messages.map((m) => `${m.id}|${m.role}|${m.text}`)).toEqual([
      "webchannel-1|agent|ok",
      "webchannel-2|agent|ok",
    ]);
  });

  /**
   * DEFECT (4), THE CROSS-FRAME CASE — the one no earlier test covered, and the
   * reason this became a deletion instead of a fifth rule.
   *
   * Frame 1 is the register snapshot; the bubbles it HYDRATES carry
   * `webchannel-` ids, exactly like live ones. The user then pages older
   * (`loadHistory({before, limit})`, as `demo/web/src/widget.ts` does) and frame
   * 2 is a strictly-older page whose answer happens to read the same — "OK" is
   * the obvious collision, but any repeated phrasing does it.
   *
   * The old predicate was named `isLocalLiveId` and tested
   * `id.startsWith("webchannel-")`, so it could not tell a hydrated bubble from
   * a live one. The older page's row therefore adopted onto the NEWEST answer
   * and destroyed it. Correct behaviour is four bubbles: two turns, both intact,
   * the older pair prepended.
   */
  it("an older page does not adopt onto bubbles a previous snapshot hydrated", () => {
    const w = makeWrapper();
    deliver(
      w,
      history(
        { id: "wire-new", role: "user", text: "again?", ts: 10 },
        { id: "webchannel-new", role: "agent", text: "OK", ts: 11 },
      ),
    );
    expect(w.getState().messages).toHaveLength(2);

    // What the widget's "load older" button does: the oldest non-local id as the
    // cursor. The request itself is staged (no socket here); the page arrives as
    // the frame below.
    const oldest = w.getState().messages.find((m) => !m.working && !m.pending && !m.retracted);
    w.loadHistory({ before: oldest?.id, limit: 20 });

    deliver(
      w,
      history(
        { id: "wire-old", role: "user", text: "ready?", ts: 1 },
        { id: "webchannel-old", role: "agent", text: "OK", ts: 2 },
      ),
    );

    expect(w.getState().messages.map((m) => `${m.id}|${m.role}|${m.text}`)).toEqual([
      "wire-old|user|ready?",
      "webchannel-old|agent|OK",
      "wire-new|user|again?",
      "webchannel-new|agent|OK",
    ]);
  });

  it("still dedups a repeated snapshot of one bubble (no over-claiming)", () => {
    // The tier-1 claim must not break ordinary idempotence: re-delivering the
    // same frame twice is still a no-op.
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

/**
 * #240 half 2 — THE USER PATH STILL ADOPTS, AND MUST.
 *
 * Tier 2 is retained for user rows only. This is an N5 text inference the north
 * star forbids, kept because the ids do not agree yet: the client renders its
 * echo under `mintLocalBubbleId("u")` → `u-<n>` and carries the wire id only as
 * the durable event's `turnId`, while the plugin journals the WIRE id. So a user
 * row legitimately misses tier 1, and deleting tier 2 for users would
 * fresh-insert every user row of every snapshot — duplicating every message this
 * device has sent.
 *
 * The residual is owned by **#302**, which stays OPEN, and is unblocked only by
 * **#243**. These tests are what makes the retention safe to ship in the
 * meantime; they must keep passing until #243 changes the id story.
 */
describe("#240 half 2 — the user path still converges (tier 2 retained, #302/#243)", () => {
  it("adopts the wire id onto the local echo — one bubble, not two", () => {
    const w = makeWrapper();
    w.send("hello there");
    const localId = w.getState().messages[0].id;
    expect(localId.startsWith("u-")).toBe(true);

    // A reconnect snapshot carries that message under the id the journal holds:
    // the inbound WIRE id, which is a random token and never the `u-<n>` echo.
    deliver(w, history({ id: "wire-3f9c22", role: "user", text: "hello there", ts: 1 }));

    expect(w.getState().messages).toHaveLength(1);
    expect(w.getState().messages[0].id).toBe("wire-3f9c22");
    expect(w.getState().messages[0].text).toBe("hello there");
  });

  it("adopts two identical user messages onto two distinct echoes", () => {
    // Where a broken pool duplicates: same text twice. Each snapshot row must
    // take its own local echo, in order — not both land on the first.
    const w = makeWrapper();
    w.send("ping");
    w.send("ping");
    expect(w.getState().messages).toHaveLength(2);

    deliver(
      w,
      history(
        { id: "wire-aaa111", role: "user", text: "ping", ts: 1 },
        { id: "wire-bbb222", role: "user", text: "ping", ts: 2 },
      ),
    );

    expect(w.getState().messages).toHaveLength(2);
    expect(w.getState().messages.map((m) => `${m.id}|${m.text}`)).toEqual([
      "wire-aaa111|ping",
      "wire-bbb222|ping",
    ]);
  });
});

/**
 * #240 half 2 — AN UNAUTHORED PLACEMENT ROW IS DROPPED ON ARRIVAL.
 *
 * ⚠️ RENAMED FROM "…must never reach tier 3", WHICH IS NO LONGER THE REASON.
 * The filter was originally defended as the only thing keeping tier 3
 * unreachable for this shape; tier 3 is deleted, so an unfiltered phantom row
 * would now merely fresh-insert a blank bubble. The filter stays for the reason
 * that always mattered and is simpler: LIVE renders nothing for a lane that
 * never authored durable text (`dropSpentDrafts`), so history must not render a
 * phantom empty bubble either, or the two diverge — N8, from the one path whose
 * contract is that they agree.
 */
describe("#240 half 2 — an unauthored placement row is dropped on arrival", () => {
  it("drops the placement row and leaves the real answer that follows it intact", () => {
    // `webchannel-P` is a lane that got a `progress` and never any durable text
    // (aborted turn / dropped connection). Live drops it via `dropSpentDrafts`;
    // the journal cannot, because that rule keys on the client-local `draftOnly`
    // flag, which §15.9 deliberately never journals.
    const w = makeWrapper();
    w.send("hi");
    deliver(w, { type: "agent_message", id: "webchannel-2", text: "real answer" });

    deliver(
      w,
      history(
        { id: "wire-77aa10", role: "user", text: "hi", ts: 1 },
        { id: "webchannel-P", role: "agent", text: "", ts: 2 },
        { id: "webchannel-2", role: "agent", text: "real answer", ts: 3 },
      ),
    );

    expect(w.getState().messages.map((m) => `${m.id}|${m.role}|${m.text}`)).toEqual([
      "wire-77aa10|user|hi",
      "webchannel-2|agent|real answer",
    ]);
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

/**
 * #242 half 2 — a `history` frame can now carry REASONING ROWS.
 *
 * `case "history"` predates reasoning entirely, so every rule in it was written
 * about a row with a `role`. These cases pin what each of those rules does when
 * it meets a row that has none, which is the shape the plugin now serves.
 */
describe("history hydration — reasoning rows (#242 half 2)", () => {
  const reasoningRow = (id: string, turnId: string, text: string, ts?: number): Row =>
    ({ kind: "reasoning", id, turnId, text, ...(ts === undefined ? {} : { ts }) }) as unknown as Row;

  it("hydrates a cold reload into one entry per row, in row order", () => {
    const w = makeWrapper();
    deliver(
      w,
      history(
        { id: "u1", role: "user", text: "why?", ts: 1 },
        reasoningRow("r1", "t1", "let me think", 2),
        { id: "a1", role: "agent", text: "because", ts: 3 },
      ),
    );
    expect(w.getState().messages.map((m) => m.id)).toEqual(["u1", "r1", "a1"]);
    expect(w.getState().messages[1]).toEqual({
      kind: "reasoning",
      id: "r1",
      turnId: "t1",
      text: "let me think",
      ts: 2,
    });
    // The public derived surface follows.
    expect(w.getState().reasoning).toEqual([
      { id: "r1", turnId: "t1", text: "let me think" },
    ]);
  });

  it("tier 1 matches a block this device rendered live — no duplicate", () => {
    const w = makeWrapper();
    deliver(w, { type: "reasoning", id: "r1", turnId: "t1", text: "thinking" });
    deliver(w, history(reasoningRow("r1", "t1", "thinking", 5)));
    expect(w.getState().messages.map((m) => m.id)).toEqual(["r1"]);
  });

  it("an EMPTY reasoning row is refused, exactly as the live frame is", () => {
    // ⚠️ THIS CASE ASSERTED THE OPPOSITE IN ROUND 1 — it pinned the row as KEPT,
    // on the true-but-insufficient ground that the empty-AGENT-row filter tests
    // `role` and so cannot reach a role-less row. It cannot; that is why the
    // rule had to be added to the reasoning branch instead. Measured: live,
    // `{type:"reasoning", text:""}` yields `messages: []` (the
    // `msg.text.length === 0` guard); before this fix the same content arriving
    // as a history row RENDERED — an empty `<details>` the live path never
    // draws. Agreement is the property, not which door is stricter.
    const live = makeWrapper();
    deliver(live, { type: "reasoning", id: "r1", turnId: "t1", text: "" });
    expect(live.getState().messages).toEqual([]);

    const replayed = makeWrapper();
    deliver(replayed, history(reasoningRow("r1", "t1", "", 1)));
    expect(replayed.getState().messages).toEqual([]);
    expect(replayed.getState().reasoning).toEqual([]);
  });

  it("keeps a NON-empty reasoning row past the empty-agent-row filter", () => {
    // Non-vacuity for the case above: the admission rule must be the TEXT rule
    // in the reasoning branch, not the agent filter widening to eat every
    // role-less row.
    const w = makeWrapper();
    deliver(w, history(reasoningRow("r1", "t1", "kept", 1)));
    expect(w.getState().messages.map((m) => m.id)).toEqual(["r1"]);
  });

  it("drops a reasoning row with no usable turnId rather than inventing one", () => {
    const w = makeWrapper();
    deliver(
      w,
      history(
        { kind: "reasoning", id: "r1", text: "orphan", ts: 1 } as unknown as Row,
        { kind: "reasoning", id: "r2", turnId: "", text: "orphan", ts: 2 } as unknown as Row,
        { id: "a1", role: "agent", text: "kept", ts: 3 },
      ),
    );
    expect(w.getState().messages.map((m) => m.id)).toEqual(["a1"]);
  });

  it("tier 2 can never adopt onto, or from, a reasoning row", () => {
    // The user echo and the reasoning block carry IDENTICAL text, so a
    // text-only match would swap them. Two independent guards stop it: the
    // incoming row's `if (m.role === "user")`, and the adoptable pool's
    // `isAdoptableUserEcho`.
    const w = makeWrapper();
    w.send("same text");
    deliver(w, { type: "reasoning", id: "r-live", turnId: "t1", text: "same text" });
    deliver(
      w,
      history(
        { id: "wire-u1", role: "user", text: "same text", ts: 1 },
        reasoningRow("r-hist", "t1", "same text", 2),
      ),
    );
    const ids = w.getState().messages.map((m) => m.id);
    // The user echo adopted the WIRE id (tier 2, as designed) ...
    expect(ids).toContain("wire-u1");
    expect(ids).not.toContain("u-0");
    // ... the live reasoning block kept its own id, untouched ...
    expect(ids).toContain("r-live");
    // ... and the snapshot's reasoning row fresh-inserted rather than adopting.
    expect(ids).toContain("r-hist");
    // Nothing was destroyed: two reasoning entries, one user echo. ⚠️ THE ORDER
    // IS `r-hist` FIRST, and that is the ordered-insertion cursor (#16) working
    // as designed, not a reasoning quirk: the adopted user echo walks the cursor
    // to its own index + 1, so the next fresh row lands immediately after it —
    // ahead of `r-live`, which is a purely local block this snapshot does not
    // carry. Any snapshot that DID carry it would tier-1 match instead.
    expect(ids).toEqual(["wire-u1", "r-hist", "r-live"]);
    expect(w.getState().reasoning.map((r) => r.id)).toEqual(["r-hist", "r-live"]);
  });

  it("an older PAGE prepends its reasoning rows in order, before the live tail", () => {
    const w = makeWrapper();
    deliver(w, { type: "agent_message", id: "a-new", turnId: "t2", text: "recent" });
    deliver(
      w,
      history(
        { id: "u-old", role: "user", text: "older", ts: 1 },
        reasoningRow("r-old", "t1", "older thought", 2),
      ),
    );
    expect(w.getState().messages.map((m) => m.id)).toEqual(["u-old", "r-old", "a-new"]);
  });

  /**
   * ⚠️ TIER 1 REQUIRES THE KINDS TO AGREE, and these two cases are why.
   *
   * `seen`/`localIndexByKey` are built from ALL of `state.messages`, which since
   * half 2 mixes both kinds. The two id spaces are NOT provably disjoint —
   * `durable-view-reducer.ts`'s `findTextIndex` docblock retracts the id-shape
   * argument outright: agent ids come from the same `nextMessageId()` as
   * reasoning ids, and USER ids are client-supplied and validated only as a
   * non-empty string within `MAX_INBOUND_USER_ID_LENGTH`, so a peer can send
   * `webchannel-…` verbatim. So a snapshot row CAN collide with a locally-held
   * entry of the other kind, and a kind-blind tier 1 silently DROPS it — never
   * inserted, never rendered — while the same row renders fine on a fresh load.
   * That is a live≠history content loss (N10).
   */
  it("a TEXT row colliding with a held REASONING id is inserted, not dropped", () => {
    const w = makeWrapper();
    deliver(w, { type: "reasoning", id: "dup", turnId: "t1", text: "thinking" });
    deliver(w, history({ id: "dup", role: "agent", text: "the answer", ts: 5 }));

    // The reasoning block survives untouched, and the text row RENDERS.
    expect(w.getState().messages.map((m) => `${m.kind ?? "text"}|${m.id}|${m.text}`)).toEqual([
      "text|dup|the answer",
      "reasoning|dup|thinking",
    ]);
    expect(w.getState().reasoning.map((r) => r.id)).toEqual(["dup"]);
  });

  it("a REASONING row colliding with a held BUBBLE id is inserted, not dropped", () => {
    const w = makeWrapper();
    deliver(w, { type: "agent_message", id: "dup", turnId: "t1", text: "the answer" });
    deliver(w, history(reasoningRow("dup", "t1", "thinking", 5)));

    // The bubble survives untouched, and the reasoning row RENDERS.
    expect(w.getState().messages.map((m) => `${m.kind ?? "text"}|${m.id}|${m.text}`)).toEqual([
      "reasoning|dup|thinking",
      "text|dup|the answer",
    ]);
    expect(w.getState().reasoning.map((r) => r.id)).toEqual(["dup"]);
  });

  it("is IDEMPOTENT across repeated pages carrying the same collision", () => {
    // ⚠️ THE CASE THE FIRST FIX GOT WRONG, PINNED SO IT CANNOT COME BACK. That
    // fix kept the id-keyed index and added a `kindAgrees` conjunct. Page 1
    // fresh-inserted correctly, but the index is KIND-BLIND and LAST-WINS, so
    // once the pair existed `get("dup")` returned the REASONING entry's index,
    // `kindAgrees` was false forever, and the text row inserted AGAIN on every
    // page — unbounded duplicate growth on every reconnect, worse than the drop
    // it replaced. Keying the index by (kind, id) is what makes page 2 a plain
    // tier-1 match. A snapshot arrives on every register, so "the same page
    // twice" is the ordinary case, not an exotic one.
    const w = makeWrapper();
    deliver(w, { type: "reasoning", id: "dup", turnId: "t1", text: "thinking" });
    const page = (): void => {
      deliver(w, history({ id: "dup", role: "agent", text: "the answer", ts: 5 }));
    };
    page();
    const afterFirst = w.getState().messages.map((m) => `${m.kind ?? "text"}|${m.id}|${m.text}`);
    expect(afterFirst).toEqual(["text|dup|the answer", "reasoning|dup|thinking"]);

    page();
    expect(w.getState().messages.map((m) => `${m.kind ?? "text"}|${m.id}|${m.text}`)).toEqual(
      afterFirst,
    );
    page();
    expect(w.getState().messages.map((m) => `${m.kind ?? "text"}|${m.id}|${m.text}`)).toEqual(
      afterFirst,
    );
  });

  it("still drops a repeat of the same id WITHIN one page — both kinds", () => {
    // The other half of the kind conjunct, pinned so a future edit cannot buy
    // the cross-kind fix by re-admitting within-page repeats. A fresh insert
    // adds to `seen` WITHOUT adding to `localIndexByKey`, so "seen but not
    // locally held" means "a repeat of an id earlier in THIS page" — still a
    // match, and still a drop.
    const text = makeWrapper();
    deliver(
      text,
      history(
        { id: "d1", role: "agent", text: "one", ts: 1 },
        { id: "d1", role: "agent", text: "two", ts: 2 },
      ),
    );
    expect(text.getState().messages.map((m) => `${m.id}|${m.text}`)).toEqual(["d1|one"]);

    const reasoning = makeWrapper();
    deliver(
      reasoning,
      history(reasoningRow("d2", "t1", "one", 1), reasoningRow("d2", "t1", "two", 2)),
    );
    expect(reasoning.getState().messages.map((m) => `${m.id}|${m.text}`)).toEqual(["d2|one"]);
  });

  it("each member of a same-id pair keeps its own overlay past an unrelated frame", () => {
    // ⚠️ `mergeDurable`'s `prevById` WAS THE SIBLING OF THE `case "history"`
    // INDEX — kind-blind and last-wins over the same mixed array. The cross-kind
    // fresh insert above DELIBERATELY produces a same-id pair, so `get(id)`
    // returned whichever member sat later in the array and the kind guard turned
    // that into `base === undefined` for the EARLIER one — dropping the WHOLE
    // overlay, not one field. `ts` is the visible symptom; the same loss takes
    // `receiptKey` (so `patchBubbleByReceiptKey` can never find the bubble
    // again), `wireId` (`promoteAnchor`) and `pending` (`retract()` returns
    // false for a bubble still held). Any durable frame re-merges the whole
    // view, so ONE unrelated message is the whole trigger.
    const bubbleLast = makeWrapper();
    deliver(bubbleLast, { type: "reasoning", id: "dup", turnId: "t1", text: "thinking" });
    deliver(bubbleLast, history({ id: "dup", role: "user", text: "the question", ts: 5 }));
    const bubbleBefore = bubbleLast.getState().messages.find((m) => m.kind === undefined);
    expect(bubbleBefore?.ts).toBe(5);
    deliver(bubbleLast, { type: "agent_message", id: "other", turnId: "t2", text: "unrelated" });
    expect(bubbleLast.getState().messages.find((m) => m.kind === undefined)?.ts).toBe(5);

    // The mirror image: the REASONING entry is the earlier member, and `ts` is
    // the one client-local field it can hold.
    const reasoningFirst = makeWrapper();
    deliver(reasoningFirst, { type: "agent_message", id: "dup", turnId: "t1", text: "answer" });
    deliver(reasoningFirst, history(reasoningRow("dup", "t1", "thinking", 7)));
    const reasoningBefore = reasoningFirst
      .getState()
      .messages.find((m) => m.kind === "reasoning");
    expect(reasoningBefore?.ts).toBe(7);
    deliver(reasoningFirst, {
      type: "agent_message",
      id: "other",
      turnId: "t2",
      text: "unrelated",
    });
    expect(reasoningFirst.getState().messages.find((m) => m.kind === "reasoning")?.ts).toBe(7);
  });
});
