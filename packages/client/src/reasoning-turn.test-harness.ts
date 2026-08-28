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

/**
 * ── FIXTURE C: THE TOOL TURN (#242 half 3) ──
 *
 * ⚠️ THIS FIXTURE EXISTS TO PIN THE ONE PROPERTY THE SLICE IS FOR: a tool call
 * delivered LIVE and the same call REPLAYED from the journal produce the same
 * view — same content, same position. Like the two above it is imported by BOTH
 * packages (`durable-view-reducer.test.ts` drives the real wrapper,
 * `journal-history.test.ts` drives the real `journalEventForOutbound` and the
 * real projection), so editing it turns tests red on both sides instead of
 * letting two hand-written literals drift.
 *
 * ⚠️ THE FRAME SEQUENCE IS RECORDED FROM THE REAL PRODUCER, NOT INVENTED. It was
 * measured by driving `inbound.ts`'s `createAgentToolActivitySink` with a
 * `start`/`update` pair on the `tool` stream and a TERMINAL event on the `patch`
 * stream for the same correlated call. Both streams feed one public id, which is
 * why one fixture can carry both `argKeys` and `summary`: `inbound.ts` emits
 * `argKeys` on the `tool` stream and ONLY when the frame is non-terminal, and
 * emits `summary` only for a patch (`readSafePatchSummary`'s count grammar) —
 * the `tool` stream never produces one. That is also why the call is named
 * `apply_patch`: a `read_file` closing with a patch summary would be invented.
 *
 * The property that makes this fixture worth having is visible in it: the
 * CLOSING frame carries `status` and `summary` but NEITHER `name` NOR `argKeys`,
 * so any scheme that journals one "final" frame stores a partial. Every frame is
 * journaled and `applyTool` folds them, which is why the expected row below
 * carries fields drawn from THREE different frames.
 */
export const TOOL_TURN = "turn-2";

/** One outbound `tool_activity` wire frame, in the shape both sides speak. */
export type ToolTurnFrame = {
  type: "tool_activity";
  id: string;
  turnId: string;
  name?: string;
  phase?: string;
  status?: string;
  summary?: string;
  argKeys?: readonly string[];
};

/**
 * A durable tool row a replay must serve, WITHOUT `ts` — same reason
 * `ReasoningTurnRow` omits it: `ts` is a projection concern the plugin sources
 * from journal row timestamps, and the plugin test asserts it separately.
 */
export type ToolTurnRow = {
  kind: "tool";
  id: string;
  turnId: string;
  name?: string;
  phase?: string;
  status?: string;
  summary?: string;
  argKeys?: readonly string[];
};

/**
 * A turn with ONE tool call spanning three frames and ONE answer — and NO user
 * message (this sentence claimed one, and neither `TOOL_TURN_FRAMES` nor
 * `TOOL_TURN_ROWS` has ever contained it). The tool frames straddle the
 * answer's `progress` on purpose: the call
 * STARTS before the lane claims its slot and ENDS after, so the fixture also
 * pins that a tool call holds the position of its FIRST frame rather than
 * drifting to where it completed.
 */
export const TOOL_TURN_FRAMES: readonly (ToolTurnFrame | ReasoningTurnFrame)[] = [
  {
    type: "tool_activity",
    id: "call-1",
    turnId: TOOL_TURN,
    name: "apply_patch",
    phase: "start",
    argKeys: ["path", "patch"],
  },
  { type: "tool_activity", id: "call-1", turnId: TOOL_TURN, phase: "update" },
  { type: "progress", id: "A", turnId: TOOL_TURN, text: "Working…" },
  {
    type: "tool_activity",
    id: "call-1",
    turnId: TOOL_TURN,
    phase: "end",
    status: "completed",
    summary: "2 added, 1 modified",
  },
  { type: "agent_message", id: "A", turnId: TOOL_TURN, text: "the answer" },
];

/**
 * What BOTH a live render and a replay of `TOOL_TURN_FRAMES` must produce.
 *
 * ⚠️ THE TOOL ROW IS THE MERGE OF ALL THREE FRAMES: `name`/`argKeys` from
 * `start`, `status`/`summary` from `end`, and `phase` from `end` because it is
 * the last frame to carry one. A `final`-frame-only design would produce
 * `{id, turnId, phase:"end", status:"completed", summary:"…"}` here — no `name`,
 * no `argKeys` — which is precisely the live≠history divergence this slice
 * exists to prevent, and asserting the merged shape is what makes that
 * regression fail rather than pass quietly.
 *
 * ⚠️ THE `summary` IS HERE TO PIN THE PLUGIN'S THREE FORWARDING SITES, and it is
 * the only field in this fixture that exists for that reason rather than for the
 * merge/position claims. `summary` crosses `delivery-journal-event.ts`'s
 * `case "tool_activity"` (frame → journal event) and `journal-history.ts`'s
 * conversion loop (view entry → served row); before it was added, deleting
 * either spread left `delivery-journal-event.test.ts`, `journal-history.test.ts`
 * and `nats-channel-delivery-journal.test.ts` all green, because no plugin
 * fixture carried one. It is not a spare field: `delivery-journal-event.ts`
 * names `summary` as one of the two clauses the no-separate-opt-in decision now
 * rests on, so losing it between disk and wire is a silent live≠history (N8).
 * The third site,
 * `nats-channel.ts`'s `sendToolActivity` payload, is NOT reachable from this
 * fixture — nothing drives that method from here — and is pinned by its own
 * literal in `nats-channel-delivery-journal.test.ts`.
 *
 * ⚠️ AND THE TOOL ROW COMES FIRST, BEFORE THE ANSWER. That is the position
 * claim: the call's first frame preceded `progress A`, so the fold appends it
 * ahead of A's slot on BOTH sides. A design that keyed position off the
 * COMPLETING frame would put it after the answer.
 */
export const TOOL_TURN_ROWS: readonly (ToolTurnRow | { id: string; role: "user" | "agent"; text: string })[] = [
  {
    kind: "tool",
    id: "call-1",
    turnId: TOOL_TURN,
    name: "apply_patch",
    phase: "end",
    status: "completed",
    summary: "2 added, 1 modified",
    argKeys: ["path", "patch"],
  },
  { id: "A", role: "agent", text: "the answer" },
];
