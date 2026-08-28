import { ANON_PEER_ID } from "./auth.js";
import type { CommandCatalogEntry } from "./commands-catalog.js";

export const WEBCHANNEL_ID = "webchannel";
export { ANON_PEER_ID };
/**
 * ⚠️ THIS FILE IS THE ONLY DECLARATION OF THE HISTORY WIRE ROW (#305).
 *
 * There used to be two — this one and `history.ts`'s — and they had already
 * drifted on `ts` (optional here, required there). #242 half 2 collapsed them:
 * `history.ts` now RE-EXPORTS `HistoryMessage` from here and expresses its
 * projection-side "`ts` is always present" as `ProjectedHistoryMessage`, a type
 * DERIVED from this one, so the relationship is checked by tsc instead of
 * asserted in prose. Do not restate this shape anywhere else.
 *
 * ⚠️ "DO NOT RESTATE" IS A DIRECTIVE, NOT A CENSUS — and the difference is not
 * pedantry, it is the fifth time in one review that counting the other sites
 * produced a false claim. A previous revision said "ONE EXCEPTION EXISTS" and
 * named `nats-client.ts`; that was itself wrong, because
 * `reasoning-turn.test-harness.ts` declares a second structural copy of both
 * arms. Restatements that DO exist, and why each is tolerated:
 *  - `packages/client/src/nats-client.ts` — one flat record with optional
 *    `kind`/`role`/`turnId`, not this union, because that package is
 *    zero-dependency and may not import the plugin. It discriminates at RUNTIME,
 *    where wire values must be validated anyway.
 *  - `packages/client/src/reasoning-turn.test-harness.ts` — both arms minus
 *    `ts`, as the shared FIXTURE two packages assert against. Same dependency
 *    reason; it is plain data with no imports.
 * Neither is load-bearing for the wire SHAPE, which is this file's. The rule for
 * anyone reading: add no more, and if you must, say why here.
 */

/**
 * A chat bubble on the hydration wire — the row shape that has always been
 * here.
 *
 * ⚠️ `kind` IS ABSENT ON THIS VARIANT, ON THE WIRE AS WELL AS IN THE TYPE, and
 * that is the whole backward-compatibility story (see `HistoryMessage`). A text
 * row serialized by this build is byte-identical to one serialized before #242
 * half 2.
 *
 * #95: hydration reproduces the role, sanitized text, order, row identity, and
 * optional timestamp present in this projection. It does not reproduce every
 * live-bubble property or every relationship available in the raw transcript.
 * Specifically absent:
 *
 *  - `turnId`. `handleInboundMessage` derives the live value from the client's
 *    `user_message.id`; that exact client-generated id is not available on the
 *    stored messages returned to this projection. Raw user boundaries and tool
 *    structure can still provide structural grouping evidence, but they cannot
 *    recover the exact live correlation id.
 *  - a terminal-turn failure verdict. `AssistantMessage.stopReason === "error"`
 *    describes a stored model attempt/message and may precede a successful
 *    retry or fallback. Textless or sanitized-away attempts produce no row, so
 *    the projection cannot expose a retry-safe terminal failure signal.
 *  - `working`, `wireId`, `sendState` — live-only client state.
 *  - the TYPING flag and the rolling PROGRESS DRAFT — ephemeral by design,
 *    matching what Telegram does.
 *    ⚠️ NEITHER REASONING NOR TOOL ACTIVITY IS ON THAT LIST ANY MORE. #242 made
 *    reasoning durable (server side in half 1, readable in half 2) and tool
 *    activity durable in half 3; both travel as sibling variants below.
 *    `docs/P1_REASONING_LANE_PLAN.md`'s "ephemeral by design" line is superseded
 *    for both and still holds for the two named above.
 *    ⚠️ AND "tool progress" WAS AN AMBIGUOUS NAME FOR TWO DIFFERENT THINGS,
 *    which is why this line is rewritten rather than shortened: the rolling
 *    `progress` DRAFT (an indicator, still ephemeral) and the structured
 *    `tool_activity` LANE (a message, now durable). §15.9's message-vs-indicator
 *    test separates them; the old wording let one word cover both.
 *
 * Full rationale: `docs/ISSUE_95_HISTORY_CONTRACT_PLAN.md`.
 */
export type HistoryTextMessage = {
  /**
   * Never present. The discriminant lives here as `undefined` so tsc treats the
   * two variants as a discriminated union rather than as two overlapping
   * records — and so that WRITING a `kind` onto a text row is a compile error.
   */
  kind?: undefined;
  id: string;
  role: "user" | "agent";
  text: string;
  ts?: number;
};

/**
 * ONE COMPLETED REASONING BURST on the hydration wire (#242 half 2).
 *
 * ⚠️ IT HAS NO `role`, AND THAT IS NOT AN OVERSIGHT TO FIX. The live `reasoning`
 * frame carries none and `DurableMessage` (the reducer's SSOT shape, which this
 * mirrors) refuses to invent one — a fabricated author inside the system of
 * record is the N8 shape. The absence is also what makes the widening SAFE FOR
 * OLDER CLIENTS, which is the reason the union is shaped this way rather than
 * as an optional `role`:
 *
 *   MEASURED against the shipped client's `case "history"`
 *   (`packages/client/src/nats-client-wrapper.ts`): its per-row validation runs
 *   `if (m.role !== "user" && m.role !== "agent") continue;` BEFORE any tier
 *   matching or insertion. A row with no `role` therefore takes that `continue`
 *   and is DROPPED — never adopted, never inserted, never rendered as an agent
 *   bubble. So an older client shows a reload without the reasoning blocks,
 *   exactly as it does today, and a newer one shows them.
 *
 *   That guard is not new in this slice, and it is not a claim about ONE build:
 *   `git show <tag>:packages/client/src/nats-client-wrapper.ts | grep -c` finds
 *   it exactly ONCE in EVERY ONE of the 15 released tags — v0.1.0 through
 *   v0.1.8, v0.2.0, v0.4.0, v0.5.0, v0.6.0, v0.6.1, v0.7.0. There is no
 *   published client that predates it, so there is no version of this package
 *   that mis-renders the new row.
 *
 *   ⚠️ TWO COUNTING TRAPS, BOTH HIT WHILE ESTABLISHING THIS. The first draft
 *   listed FIVE tags and read as exhaustive — a partial list in exhaustive
 *   clothing, and weaker than the truth. The correction offered in review was
 *   "all 17 tags", which is also wrong: `git tag` returns 17, but two of them
 *   (`archive/issue-53-pre-rebase-checkpoint`, `issue-94-pr2-superseded`) are
 *   working checkpoints, not releases. 15 is the number of things a peer can
 *   actually be running. Re-derive it with `git tag --list 'v*'`, not `git tag`.
 *
 * `turnId` is REQUIRED, following the live frame (`turnId: string`) and
 * `DurableMessage`'s reasoning variant. `ts` is the same hydration metadata the
 * text variant carries — see `history.ts`'s note; it is NOT an ordering key.
 */
export type HistoryReasoningMessage = {
  kind: "reasoning";
  id: string;
  turnId: string;
  text: string;
  ts?: number;
};

/**
 * ONE TOOL CALL on the hydration wire, MERGED (#242 half 3).
 *
 * ⚠️ IT HAS NO `role`, for the reason the reasoning variant above gives in full,
 * and the same MEASURED backward-compatibility argument applies UNCHANGED: the
 * shipped client's `case "history"` runs
 * `if (m.role !== "user" && m.role !== "agent") continue;` before any tier
 * matching, and that guard is present exactly once **in
 * `packages/client/src/nats-client-wrapper.ts`** in every one of the 15 released
 * tags (`git tag --list 'v*'`), so an older client DROPS this row and a newer one
 * renders it. The widening stays strictly additive.
 *
 * ⚠️ THE FILE SCOPE IS NOT DECORATION — the reasoning variant's docblock above
 * carries it and warns about exactly this trap, and this sentence had dropped it.
 * Unscoped the claim is FALSE: in v0.1.0–v0.2.0 the same guard also appears once
 * in `packages/client/src/client.ts`, so a repo-wide `grep -c` finds it twice in
 * ten of the fifteen tags. The conclusion is unchanged (the wrapper is the
 * `case "history"` path, and every tag has the guard there); only the census is.
 *
 * ⚠️ THIS ROW IS THE FOLD OF MANY JOURNAL ROWS, NOT ONE OF THEM. The journal
 * stores one event per `tool_activity` FRAME (a delta — see `DurableEvent`'s
 * tool arm for the measured frame shape that forces it), and
 * `journal-history.ts` replays them through the shared `applyTool` before
 * serving. So the wire carries the merged call and the client needs no
 * accumulation of its own.
 *
 * ⚠️ `turnId` IS PART OF THE IDENTITY, NOT DECORATION — the producer's tool id
 * is unique within a RUN, so a consumer must key on the PAIR. It is REQUIRED
 * here, following the live frame (`turnId: string`) and `DurableMessage`'s tool
 * variant.
 *
 * ⚠️ `argKeys` CARRIES ARGUMENT KEY NAMES ONLY — NEVER VALUES. That trust
 * boundary is established at the producer (`Object.keys(args)`), re-filtered
 * where the wire is read, and it must survive to disk and back out unchanged.
 * `summary` is likewise count-only (`inbound.ts`'s `readSafePatchSummary`).
 * Neither field is free text, which is why tool durability needs no separate
 * storage opt-in the way reasoning does.
 *
 * ⚠️ **#311** APPLIES HERE AND IS NOT FIXED BY THIS SLICE: a history page is
 * bounded by ROW COUNT, not by bytes, and this variant adds another content
 * class to the same frame. A reader meeting a large page meets it here.
 */
export type HistoryToolMessage = {
  kind: "tool";
  id: string;
  turnId: string;
  name?: string;
  phase?: string;
  status?: string;
  summary?: string;
  argKeys?: readonly string[];
  ts?: number;
};

/**
 * One row on the hydration wire: a chat bubble, a completed reasoning burst, or
 * a merged tool call.
 *
 * ⚠️ A TAGGED UNION, MIRRORING `DurableMessage` — NOT A WIDENED RECORD. The
 * reducer already solved this shape and its docblock carries the argument: an
 * optional `role` would force every consumer to decide what an absent one means
 * at the point it renders, which is the "infer identity from a missing field"
 * habit v6 exists to remove. Two variants make a consumer that forgot one a
 * COMPILE error.
 *
 * ⚠️ THE TAG IS ABSENT ONLY ON THE TEXT VARIANT, DELIBERATELY. Emitting
 * `kind: "text"` on every bubble would change the serialized form of every row
 * that exists today for no gain; leaving it absent keeps each widening strictly
 * ADDITIVE — an older PLUGIN's rows still parse (no tag ⇒ bubble), and an older
 * CLIENT drops the tagged rows on the `role` guard quoted above.
 */
export type HistoryMessage =
  | HistoryTextMessage
  | HistoryReasoningMessage
  | HistoryToolMessage;

export type ApprovalDecision = "allow-once" | "allow-always" | "deny";
export type ApprovalOption = { decision: ApprovalDecision; label: string; style: string };
export type ApprovalRequestPayload = {
  id: string;
  kind: "exec" | "plugin";
  title: string;
  description?: string;
  prompt: string;
  options: ApprovalOption[];
  expiresAtMs?: number;
};

export type InboundWsMessage =
  | { type: "user_message"; text: string; id?: string }
  | { type: "approval_decision"; id: string; decision: ApprovalDecision }
  | { type: "load_history"; before?: string; limit?: number }
  | { type: "load_commands" };

export type OutboundWsMessage =
  | {
      type: "agent_message";
      text: string;
      id?: string;
      turnId?: string;
      /**
       * Observed run/attempt-local ordinal for an authorized block delivery.
       * It can repeat after model fallback and is not a durable hydration key.
       */
      assistantMessageIndex?: number;
    }
  | { type: "progress"; id: string; text: string; turnId?: string }
  | {
      type: "reasoning";
      id: string;
      turnId: string;
      text: string;
      /**
       * #242 half 1 (doc §15.9/§16.2-5): THIS frame closes the reasoning burst.
       * Its `text` is the burst's DURABLE text, and it is the ONLY `reasoning`
       * frame the delivery journal can record
       * (`delivery-journal-event.ts`'s `case "reasoning"`). Absent or `false`
       * means a LIVE CUMULATIVE DRAFT update — not durable, exactly as
       * `progress` is not durable.
       *
       * ⚠️ "CAN RECORD", NOT "DOES". Whether ANY reasoning row is written is a
       * separate, per-account decision — `capabilities.reasoningDurable`,
       * default OFF. This flag is the WIRE's answer to "which frame carries the
       * burst's content"; it is not a promise that the content is stored. The
       * frame is emitted either way, which is the point: the storage gate lives
       * at the journal, never on the lane.
       *
       * ⚠️ THE FLAG EXISTS BECAUSE THE LIVE STREAM IS UNTHROTTLED.
       * `message-adapter.ts`'s `createReasoningDraftController` sends one frame
       * per cumulative token update, each carrying the whole text so far, so
       * journaling every `reasoning` frame would write O(n²) bytes per burst.
       * With the flag a burst costs exactly one row.
       *
       * ADDITIVE AND OPTIONAL: a client that does not know this key takes the
       * frame down its ordinary `reasoning` path. That path is NOT inert, and
       * calling it a "render no-op" understates it — for the frame #242 half 1
       * ADDED to the wire (`closeLiveBurst`'s: the burst's own id, carrying the
       * text the peer already holds) what actually happens is:
       *
       * ⚠️ THE THREE BULLETS BELOW DESCRIBE THE **half-1-AND-EARLIER CLIENT**,
       * NOT THE CURRENT ONE — read them as the compatibility argument they are.
       * #242 half 2 deleted `upsertReasoning` and routed `case "reasoning"`
       * through `applyDurable`, so on a CURRENT client this frame is an upsert
       * by id into `state.messages` (same id, same text ⇒ same content, a new
       * array), the same disarm, and the same one extra notification. The
       * conclusion is identical on both — which is the point of keeping the old
       * reading: it is what an OLDER peer does, and older peers are exactly who
       * this "additive and optional" claim is about.
       *  - `upsertReasoning` replaces the entry under the SAME id with the SAME
       *    text, so the rendered reasoning list is unchanged in content;
       *  - `disarmStaleDraftsByTurn(turnId)` runs, which only DELETES ids from
       *    the client's stale-draft watch set — it touches no message;
       *  - `setState` fires, so subscribers see one extra notification.
       * The disarm is the only behavioural effect, and it is safe here because
       * of WHEN this frame is sent: every burst close happens inside the turn,
       * and `inbound.ts` emits this turn's `turn_settled` afterwards (its
       * `reasoning?.stop()` runs in the `finally`, before the settlement block),
       * so any draft this frame disarms is still finalized by the turn's own
       * terminal frame.
       *
       * ⚠️ THAT `turn_settled` IS GATED, AND THE GATE IS WHY THE ARGUMENT HOLDS
       * RATHER THAN A HOLE IN IT — check it before "fixing" this. `inbound.ts`
       * settles under `if (settlementEligible)`, which is `!controlLane` and is
       * cleared when admission is denied. On BOTH of those paths NO REASONING
       * CONTROLLER IS EVER BUILT, so there is nothing to close and this frame
       * cannot be sent: `reasoningEnabled` is `!controlLane && …`, so a control
       * lane never constructs one and `reasoning?.stop()` no-ops; and the
       * admission-denied path returns well before the construction site. The two
       * conditions cannot co-occur — an existing controller implies a dispatched
       * turn implies an eligible settlement.
       *
       * ⚠️ AND THE THREE BULLETS ARE NOT UNIVERSAL OVER FRAMES CARRYING THIS
       * FLAG, on any client version.
       * `pushDurableBlock`'s independent-block branch also sets it, on a FRESHLY
       * MINTED id carrying text the client has not seen — so there
       * an older client's `upsertReasoning` takes its APPEND path and its
       * `.slice(-100)` cap can evict the oldest entry (a CURRENT client appends
       * into `state.messages`, which #242 half 2 left uncapped — same append,
       * no eviction). That is not a compatibility concern, because
       * that branch sent a byte-identical frame (minus this key) before the flag
       * existed; it is a warning against reading "same id, same text" as a
       * property of `final` rather than of the burst-closing frame.
       *
       * The cost is one extra copy of the burst's text on the wire per burst,
       * and it is accepted.
       */
      final?: boolean;
    }
  | {
      type: "tool_activity";
      turnId: string;
      id: string;
      name?: string;
      phase?: string;
      status?: string;
      summary?: string;
      argKeys?: string[];
    }
  | { type: "turn_settled"; turnId: string; outcome: "ok" | "error" }
  /**
   * #212 (Phase 3, targeted): the plugin's authoritative, ordered set of the
   * turn's AGENT ANSWER bubbles, emitted at drain (after the buffered-final
   * flush, before `turn_settled`). `answers` is the answer lanes in the plugin's
   * generation order — `id` reuses a lane's materialized wire id or a freshly
   * minted id for a lane that streamed but never reached the wire (failed-frame
   * recovery); `text` is each lane's STREAMED answer text, immune to a
   * mis-routed final top-up. `remove` names the bubble ids the plugin KNOWS it
   * mis-routed answer content onto (overflow independents; recovery blocks whose
   * lane is now in `answers`). The client replaces ONLY these — every other
   * turn agent bubble (notices, errors, adopted history) is preserved. Additive
   * and safely ignorable by an old client (no protocol bump).
   */
  | {
      type: "turn_snapshot";
      turnId: string;
      answers: Array<{ id: string; text: string }>;
      remove: string[];
    }
  | ({ type: "approval_request" } & ApprovalRequestPayload)
  | { type: "approval_resolved"; id: string; decision: ApprovalDecision }
  | { type: "approval_snapshot"; approvals: ApprovalRequestPayload[]; resolved?: Array<{ id: string; decision: ApprovalDecision }> }
  | { type: "typing" }
  | { type: "history"; messages: HistoryMessage[] }
  | { type: "commands"; commands: CommandCatalogEntry[] }
  | { type: "ack"; ids: string[] }
  | { type: "inbound_rejected"; ids: string[]; reason: "overloaded" };

export interface WebChannelPeerChannel {
  sendText(
    peerId: string,
    text: string,
    id?: string,
    turnId?: string,
    assistantMessageIndex?: number,
  ): boolean;
  sendProgress(peerId: string, id: string, text: string, turnId?: string): boolean;
  finalizeDraft(
    peerId: string,
    id: string,
    text: string,
    turnId?: string,
    assistantMessageIndex?: number,
  ): boolean;
  /**
   * `final` marks the frame that CLOSES this burst — the only one the journal
   * records (#242 half 1). See the `reasoning` member of `OutboundWsMessage`.
   */
  sendReasoning(
    peerId: string,
    id: string,
    turnId: string,
    text: string,
    final?: boolean,
  ): boolean;
  sendToolActivity(
    peerId: string,
    activity: {
      id: string;
      turnId: string;
      name?: string;
      phase?: string;
      status?: string;
      summary?: string;
      argKeys?: string[];
    },
  ): boolean;
  sendTurnSettled(peerId: string, turnId: string, outcome: "ok" | "error"): boolean;
  sendTurnSnapshot(
    peerId: string,
    turnId: string,
    answers: Array<{ id: string; text: string }>,
    remove: string[],
  ): boolean;
  sendTyping(peerId: string): boolean;
  sendHistory(peerId: string, messages: HistoryMessage[]): boolean;
  sendApprovalRequest(peerId: string, request: ApprovalRequestPayload): boolean;
  sendApprovalResolved(peerId: string, id: string, decision: ApprovalDecision): boolean;
  sendApprovalSnapshot(peerId: string, approvals: ApprovalRequestPayload[], resolved?: Array<{ id: string; decision: ApprovalDecision }>): boolean;
  sendAck?(peerId: string, ids: string[]): boolean;
  sendInboundRejected?(peerId: string, ids: string[]): boolean;
}

export class NullPeerChannel implements WebChannelPeerChannel {
  sendText(_peerId: string, _text: string, _id?: string, _turnId?: string, _assistantMessageIndex?: number): boolean { return false; }
  sendProgress(_peerId: string, _id: string, _text: string, _turnId?: string): boolean { return false; }
  finalizeDraft(_peerId: string, _id: string, _text: string, _turnId?: string, _assistantMessageIndex?: number): boolean { return false; }
  sendReasoning(_peerId: string, _id: string, _turnId: string, _text: string, _final?: boolean): boolean { return false; }
  sendToolActivity(_peerId: string, _activity: { id: string; turnId: string; name?: string; phase?: string; status?: string; summary?: string; argKeys?: string[] }): boolean { return false; }
  sendTurnSettled(_peerId: string, _turnId: string, _outcome: "ok" | "error"): boolean { return false; }
  sendTurnSnapshot(_peerId: string, _turnId: string, _answers: Array<{ id: string; text: string }>, _remove: string[]): boolean { return false; }
  sendTyping(_peerId: string): boolean { return false; }
  sendHistory(_peerId: string, _messages: HistoryMessage[]): boolean { return false; }
  sendApprovalRequest(_peerId: string, _request: ApprovalRequestPayload): boolean { return false; }
  sendApprovalResolved(_peerId: string, _id: string, _decision: ApprovalDecision): boolean { return false; }
  sendApprovalSnapshot(_peerId: string, _approvals: ApprovalRequestPayload[], _resolved?: Array<{ id: string; decision: ApprovalDecision }>): boolean { return false; }
  sendAck(_peerId: string, ids: string[]): boolean { return ids.length === 0; }
  sendInboundRejected(_peerId: string, ids: string[]): boolean { return ids.length === 0; }
}
