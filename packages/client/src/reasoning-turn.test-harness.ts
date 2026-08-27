/**
 * THE SHARED REASONING-TURN FIXTURE — one definition, two packages (#242 half 2).
 *
 * ⚠️ WHY THIS FILE EXISTS. The "live == history" property is proved by a PAIR of
 * tests that cannot see each other: `packages/client/src/durable-view-reducer.test.ts`
 * drives the real wrapper and replays a `history` frame, while
 * `packages/plugin/src/journal-history.test.ts` drives the real
 * `journalEventForOutbound` and the real projection. The client package is
 * zero-dependency and may not import the plugin, so the two halves originally
 * carried INDEPENDENT hand-written literals — and review found the obvious hole:
 * editing one (reordering it, or adding a `role` to a reasoning row) left the
 * other green, so the pair asserted much less than its comment claimed.
 *
 * One fixture, imported by both, is what makes the claim true. It lives in the
 * CLIENT package because the dependency already runs that way — the plugin
 * imports client source (`journal-history.ts` → `durable-view-reducer.ts`), so
 * this adds no new edge and no new direction.
 *
 * ⚠️ THE `.test-harness.ts` SUFFIX IS LOAD-BEARING, NOT A NAMING WHIM.
 * `packages/client/tsconfig.build.json` excludes that suffix from the published
 * bundle — the mechanism this repo already built for "test scaffolding, NOT
 * public API", after `*.test.ts` alone let scaffolding ship. Renaming this file
 * to a plain `.ts` would publish it. (The literal glob is in that config; it
 * cannot be quoted inside a docblock, because it contains the token that closes
 * one.) It also has NO imports, so the zero-dependency contract is untouched
 * either way.
 *
 * Everything here is PLAIN DATA. Neither package may add behaviour to it: a
 * fixture that computes is a third implementation of the thing under test.
 */

export const REASONING_TURN = "turn-1";

/** One outbound wire frame, in the shape both sides already speak. */
export type ReasoningTurnFrame = {
  type: "reasoning" | "progress" | "agent_message";
  id: string;
  text: string;
  turnId: string;
  final?: boolean;
};

/**
 * A durable row a replay of the turn must serve, WITHOUT `ts`.
 *
 * `ts` is deliberately absent: it is a projection concern the plugin sources
 * from journal row timestamps, so pinning a value here would force the client
 * half to know about `created_ms`. The plugin test asserts `ts` separately.
 */
export type ReasoningTurnRow =
  | { kind: "reasoning"; id: string; turnId: string; text: string }
  | { id: string; role: "user" | "agent"; text: string };

/**
 * ── FIXTURE A: THE ORDINARY TURN ──
 *
 * A burst streams token by token and CLOSES, then the answer streams and
 * finalizes, then a second burst, then a second answer. Every burst closes
 * before the next answer's `progress`, so live and replay agree exactly — this
 * is the fixture the `live == history` cases on both sides consume.
 */
export const ORDINARY_TURN_FRAMES: readonly ReasoningTurnFrame[] = [
  { type: "reasoning", id: "r1", turnId: REASONING_TURN, text: "Let" },
  { type: "reasoning", id: "r1", turnId: REASONING_TURN, text: "Let me" },
  { type: "reasoning", id: "r1", turnId: REASONING_TURN, text: "Let me think" },
  { type: "reasoning", id: "r1", turnId: REASONING_TURN, text: "Let me think", final: true },
  { type: "progress", id: "A", turnId: REASONING_TURN, text: "Working…" },
  { type: "agent_message", id: "A", turnId: REASONING_TURN, text: "first answer" },
  { type: "reasoning", id: "r2", turnId: REASONING_TURN, text: "and also", final: true },
  { type: "agent_message", id: "B", turnId: REASONING_TURN, text: "second answer" },
];

/** What a replay of `ORDINARY_TURN_FRAMES` must serve, in order. */
export const ORDINARY_TURN_ROWS: readonly ReasoningTurnRow[] = [
  { kind: "reasoning", id: "r1", turnId: REASONING_TURN, text: "Let me think" },
  { id: "A", role: "agent", text: "first answer" },
  { kind: "reasoning", id: "r2", turnId: REASONING_TURN, text: "and also" },
  { id: "B", role: "agent", text: "second answer" },
];

/**
 * ── FIXTURE B: THE INTERLEAVED TURN — A CHARACTERIZATION, NOT A SPEC ──
 *
 * ⚠️ THIS FIXTURE EXISTS BECAUSE THE GAP BETWEEN THE TWO HALVES OF THE PAIR HAD
 * A COUNTEREXAMPLE IN IT. Fixture A closes every burst before the next answer's
 * `progress`, so it can never see GAP 2b (`journal-history.ts`'s conversion
 * loop). This one is the smallest stream that does: the answer's `placement` row
 * is journaled BETWEEN the burst's first delivered frame and its closing frame.
 *
 *   LIVE   [r1, A]  — `applyReasoning` appended r1 on the FIRST frame
 *   REPLAY [A, r1]  — the journal holds only the closing frame, after A's slot
 *
 * Both packages drive it and PIN BOTH SIDES, so the divergence is measured
 * rather than argued, and a future slice that closes it turns two tests red in
 * two packages instead of quietly disagreeing with a comment.
 *
 * ⚠️ IT IS NOT A CLAIM THAT PINNED CORE PRODUCES THIS FRAME ORDER. Core's
 * reasoning end fires at `thinking_end` / `</think>`, both of which precede
 * visible answer text on the pinned runners. The burst here closes via
 * `endBurst`, MID-TURN — which is exactly why the old "safe if `endBurst`,
 * broken if closed at turn end" dichotomy was a false universal.
 */
export const INTERLEAVED_TURN_FRAMES: readonly ReasoningTurnFrame[] = [
  { type: "reasoning", id: "r1", turnId: REASONING_TURN, text: "th" },
  { type: "progress", id: "A", turnId: REASONING_TURN, text: "Working…" },
  { type: "reasoning", id: "r1", turnId: REASONING_TURN, text: "thinking", final: true },
  { type: "agent_message", id: "A", turnId: REASONING_TURN, text: "because" },
];

/** What the LIVE client renders for `INTERLEAVED_TURN_FRAMES`. */
export const INTERLEAVED_TURN_LIVE_IDS: readonly string[] = ["r1", "A"];

/** What a REPLAY of the same turn serves. ⚠️ Deliberately different. */
export const INTERLEAVED_TURN_REPLAY_IDS: readonly string[] = ["A", "r1"];
