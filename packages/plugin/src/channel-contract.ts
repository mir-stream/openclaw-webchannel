import { ANON_PEER_ID } from "./auth.js";
import type { CommandCatalogEntry } from "./commands-catalog.js";
// #244 half B: the `difference` frame carries RAW journal events for the client
// to fold onto the view it already holds — so it is typed by the client reducer's
// `DurableEvent`, the SAME type the journal stores (`delivery-journal-event.ts`'s
// `JournalEvent` is an alias of it). TYPE-ONLY and cross-package by source path,
// exactly like `delivery-journal-event.ts`'s import of the same type: erased under
// `verbatimModuleSyntax`, so it adds no runtime dependency and no import cycle.
import type { DurableEvent } from "../../client/src/durable-view-reducer.js";

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
 *    ⚠️ NEITHER REASONING NOR TOOL ACTIVITY NOR APPROVALS ARE ON THAT LIST ANY
 *    MORE. #242 made reasoning durable (server side in half 1, readable in
 *    half 2), tool activity durable in half 3 and approval cards durable in
 *    half 4; all three travel as sibling variants below.
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
 * record is the N8 shape. The absence is ALSO what MADE the widening safe for
 * older clients, which is the reason the union is shaped this way rather than as
 * an optional `role` — read the SUPERSESSION note under the census before citing
 * that half, because since #246 it is history and the N8 half is not:
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
 *   ⚠️ SUPERSEDED AS A COMPATIBILITY ARGUMENT BY #246 — KEPT AS THE RECORD OF WHY
 *   THIS UNION IS SHAPED THIS WAY. `WEBCHANNEL_PROTOCOL_VERSION` went 3 → 4 and
 *   both sides refuse a mismatch, so every one of those 15 tags is now REFUSED AT
 *   REGISTER (terminal `protocol_mismatch`, 426) and none of them can receive
 *   this row at all. The census is still TRUE, and it is still why the row was
 *   safe to ship in #242 before that gate existed — but do not cite it as a live
 *   back-compat guarantee, and do not "restore compatibility" by re-adding a
 *   `role`: the N8 reason in the first paragraph is the one that still binds.
 *   The same supersession applies verbatim to the tool and approval variants
 *   below: each restates the census for its own row and each defers to this block
 *   for the reasoning, so the note is written here ONCE rather than three times.
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
 * ONE NATIVE HITL APPROVAL CARD on the hydration wire (#242 half 4).
 *
 * ⚠️ IT HAS NO `role`, for the reason the reasoning variant above gives in full,
 * and the same MEASURED backward-compatibility argument applies UNCHANGED: the
 * shipped client's `case "history"` runs
 * `if (m.role !== "user" && m.role !== "agent") continue;` before any tier
 * matching, and that guard is present exactly once in the `nats-client-wrapper.ts`
 * of every one of the 15 released tags (`git tag --list 'v*'`), so an older
 * client DROPS this row and a newer one renders it. The widening stays strictly
 * additive. (An older client drops it TWICE over, in fact: it also has no
 * `text`, and every released `case "history"` guards `typeof m.text !== "string"`
 * ahead of the role test. The `role` argument is the one that is measured across
 * the tag set, so it is the one quoted.)
 *
 * ⚠️ THIS ROW IS THE FOLD OF **TWO** JOURNAL EVENTS — the `approval` request and
 * a later `approvalResolution` — merged by the shared reducer before serving,
 * exactly as the tool row is the fold of many `tool` deltas. The wire carries the
 * card WITH its state, so the client needs no second frame to make it complete.
 *
 * ⚠️ THE PAYLOAD'S OWN `kind` RIDES AS `approvalKind`. `ApprovalRequestPayload`
 * calls it `kind` (`"exec" | "plugin"`), which is this union's DISCRIMINANT;
 * carrying it verbatim would collide two meanings on one key. The rename is the
 * same at all three layers (`DurableMessage`, this row, `ChatApprovalMessage`).
 *
 * ⚠️ `resolvedDecision` NEVER CARRIES THE `"unknown"` SENTINEL. That value is a
 * CLIENT-side reconciliation outcome (#15 — "decided while this device wasn't
 * looking"), produced only by `approval_snapshot`'s Leg B; nothing on the server
 * can journal it, so nothing on this wire can serve it.
 *
 * ⚠️ AND THIS ROW IS NOT AN INVITATION TO ACT. A replayed approval is rendered
 * NON-INTERACTIVE by the client whatever its `resolvedDecision` says — the live
 * `approval_snapshot` is the only authority for "still open". See
 * `ChatApprovalMessage`'s `actionable`.
 *
 * ⚠️ **#311** APPLIES HERE HARDEST, AND IS NOT FIXED BY THIS SLICE: a history
 * page is bounded by ROW COUNT, not by bytes, and this variant carries `title`,
 * `prompt`, `description` AND an `options[]` array — so an approval row is
 * LARGER than a tool row. Like tool and unlike reasoning it has no storage
 * opt-in, so it appears at the DEFAULT configuration.
 */
export type HistoryApprovalMessage = {
  kind: "approval";
  id: string;
  approvalKind: "exec" | "plugin";
  title: string;
  description?: string;
  prompt: string;
  options: readonly ApprovalOption[];
  expiresAtMs?: number;
  resolvedDecision?: ApprovalDecision;
  ts?: number;
};

/**
 * One row on the hydration wire: a chat bubble, a completed reasoning burst, a
 * merged tool call, or an approval card.
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
  | HistoryToolMessage
  | HistoryApprovalMessage;

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
  // #243 half 1: `random_id` is the client's idempotency key — a fresh token the
  // client mints per logical user message and reuses on every retry. The plugin's
  // ingress dedupe keys on it (see `ingressDedupeKey`) instead of the wire `id`.
  // It is SEPARATE from `id`, which remains the durable id in half 1; half 2 moves
  // durable-id ownership to the server and this key is what carries retry
  // idempotency once it can no longer ride the journal's message_id. Optional to
  // mirror the wire (older clients omit it).
  | { type: "user_message"; text: string; id?: string; random_id?: string }
  | { type: "approval_decision"; id: string; decision: ApprovalDecision }
  /**
   * Page older history.
   *
   * `beforeTurnId` COMPLETES THE CURSOR, and it is strictly ADDITIVE (#320).
   * `before` alone names a row by id, which is sufficient only while no id can
   * name two projected rows. A TOOL id can: it is turn-local on both of its
   * paths, and a tool row is addressed by the PAIR `(turnId, id)` everywhere the
   * view keys on it (`durable-view-reducer.ts`'s `applyTool` upserts on exactly
   * that pair), so an id-only cursor can name two rows and `historyPageBefore`
   * then refuses it as ambiguous. Sending the pair resolves it.
   *
   * OMITTING IT IS SUPPORTED AND UNCHANGED — an older peer that sends only
   * `before` gets exactly the id-only behaviour, ambiguity guard included
   * (`demo/web/src/history-paging.test.ts` measures that rather than asserting
   * it). Newer peers set it for a TOOL cursor only, for two different reasons: a
   * BUBBLE row has no `turnId` on this wire to pair with at all
   * (`HistoryTextMessage` above), while a REASONING cursor stays id-only by a
   * deliberate choice that carries a stated residual —
   * `demo/web/src/presentation.ts`'s `oldestHistoryCursor` argues it. Do not
   * summarise either as "these ids are globally unique": user bubble ids are
   * peer-supplied (#293) and that claim is false of them.
   */
  | { type: "load_history"; before?: string; beforeTurnId?: string; limit?: number }
  /**
   * #244 half B (doc §16.2-6, Telegram pts/qts): request the durable events the
   * client is MISSING — everything with `seq > afterSeq`. The client sends this
   * when a durable frame arrives with a `seq` beyond the contiguous next one (a
   * gap: an at-most-once NATS drop left a hole), passing its last-applied seq as
   * `afterSeq`. The server answers with a `difference` frame (below). This is the
   * mid-stream analogue of `load_history`: same read, but RAW events forward from
   * a cursor rather than a projected page backward from one.
   */
  | { type: "get_difference"; afterSeq: number }
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
      /**
       * #244 half A (doc §16.2-6, Telegram pts/qts): the per-conversation
       * contiguous `seq` this frame's DURABLE row was allocated at egress
       * (`delivery-journal.ts` `append` → `{seq}`), stamped by `sendToPeer` after
       * the persist-before-publish commit. Monotone within a conversation; a
       * future client (half B) tracks the last-applied `seq` and detects gaps.
       *
       * ⚠️ IT RIDES EVERY DURABLE FRAME, NOT JUST THIS ONE, AND CONTIGUITY IS THE
       * REASON. Each frame `journalEventForOutbound` maps to a journal event
       * occupies a per-conversation `seq`: the SEVEN durable outbound types are
       * `agent_message`, `progress`, `turn_snapshot`, `reasoning` (only the
       * journaled `final` frame, and only when `reasoningDurable` is on),
       * `tool_activity`, `approval_request`, `approval_resolved`
       * (`isSeqBearingFrame` is their single source of truth). If `seq` rode only
       * some of them the client's stream would have holes where the others
       * consumed a seq unseen — and half B would read those as phantom gaps and
       * fire a spurious `getDifference`. So the field is declared on all seven and
       * `sendToPeer` stamps it on whichever frame was actually journaled.
       *
       * ⚠️ ONE SEQ-CONSUMER IS NOT AN OUTBOUND FRAME: the INBOUND USER opener.
       * `appendInboundUser` allocates from the SAME per-conversation counter, so a
       * user message holds seq N and the turn's first agent frame holds N+1 — but
       * the user opener never rides a durable frame (the client authored it). Its
       * seq therefore rides the `ack.committed` echo instead (see the `ack` member
       * and `CommittedUserMessage`). So "every seq the client sees" is the seven
       * frames here PLUS that echo; together they are gapless. Without the echo
       * carrying it, the first agent frame of every turn would look like a gap.
       *
       * OPTIONAL ON THE WIRE, AND STILL SO: a frame whose journal append was
       * refused or failed — or a non-durable frame (a live reasoning DRAFT, an
       * id-less `agent_message`) — ships WITHOUT it, and the client tolerates the
       * absence.
       *
       * ⚠️ TWO CLAIMS THAT USED TO SIT HERE ARE BOTH DEAD. "Half A only EXPOSES
       * the field — nothing consumes it yet" ended with #244 half B: the client
       * tracks `lastAppliedSeq` off this field and fires `getDifference` on a gap
       * (`nats-client-wrapper.ts`). And "older clients ignore it" is no longer a
       * back-compat guarantee worth stating — #246 took the wire to v4 under an
       * exact-match register gate, so a client that ignores `seq` cannot connect.
       * Optionality is now about which FRAMES carry it, not about which PEERS
       * read it.
       */
      seq?: number;
    }
  | { type: "progress"; id: string; text: string; turnId?: string; /** #244 half A — see `agent_message`. */ seq?: number }
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
      /**
       * #244 half A — see `agent_message`. Present ONLY on the burst-closing
       * (`final`) frame that the journal actually recorded, and ONLY when
       * `capabilities.reasoningDurable` is on: a live cumulative DRAFT is not
       * journaled, so it carries no `seq` (it is not part of the durable stream
       * the client's cursor counts).
       */
      seq?: number;
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
      /** #244 half A — see `agent_message`. Every `tool_activity` delta is durable. */
      seq?: number;
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
   * turn agent bubble (notices, errors, adopted history) is preserved. It shipped
   * in 0.7.0 as additive and safely ignorable by an old client, under protocol v3
   * and with no bump; #246 has since taken the wire to v4, so "an old client
   * ignores it" no longer describes a peer that can connect.
   */
  | {
      type: "turn_snapshot";
      turnId: string;
      answers: Array<{ id: string; text: string }>;
      remove: string[];
      /** #244 half A — see `agent_message`. */
      seq?: number;
    }
  | ({ type: "approval_request"; /** #244 half A — see `agent_message`. */ seq?: number } & ApprovalRequestPayload)
  | { type: "approval_resolved"; id: string; decision: ApprovalDecision; /** #244 half A — see `agent_message`. */ seq?: number }
  | { type: "approval_snapshot"; approvals: ApprovalRequestPayload[]; resolved?: Array<{ id: string; decision: ApprovalDecision }> }
  | { type: "typing" }
  | {
      type: "history";
      messages: HistoryMessage[];
      /**
       * #244 half A (doc §16.2-6): the conversation's authoritative high-water
       * `seq` at snapshot time — the journal's current `MAX(seq)` for this
       * conversation. It is the baseline a reconnecting client (half B) resumes
       * gap detection from: every durable live frame after the snapshot carries a
       * `seq` and the client can tell a contiguous stream from a gap against this
       * number. Populated only on the register-time SNAPSHOT (`history-serve.ts`'s
       * `sendSnapshot`); a `load_history` PAGE serves OLDER rows and carries no
       * high-water — which is why it stays optional on the wire. It is NOT
       * optional for the peer: since #244 half B the client seeds its cursor from
       * this field — in `nats-client-wrapper.ts`'s `handleMessage` POST-DISPATCH
       * block, which runs after `case "history"` has hydrated and says so, NOT in
       * the case arm itself — and since #246's
       * v4 exact-match gate a client that ignores it cannot connect. The old
       * "additive and optional — older clients ignore it, and half A only exposes
       * it" reading is dead on both halves.
       */
      highWaterSeq?: number;
    }
  | { type: "commands"; commands: CommandCatalogEntry[] }
  | {
      type: "ack";
      ids: string[];
      /**
       * #243 half 2a (doc §16.2-1): the durable user messageId the SERVER minted
       * for each fresh admission, and the SAME id re-echoed for a deduped retry,
       * keyed by the client `random_id`. ⚠️ "The CURRENT client IGNORES it
       * (adoption is half 2b)" WAS TRUE AND NO LONGER IS — half 2b landed, and the
       * client adopts its optimistic bubble onto `messageId` off this array
       * (`nats-client-wrapper.ts`). Nor is "an older client that only reads `ids`
       * is unaffected" a live guarantee: #246's v4 exact-match gate refuses such a
       * peer. It rides `ack` because that frame already reports per-id acceptance;
       * see `IngressResultFrame`.
       *
       * #244 half A: each entry now also carries the user message's per-conversation
       * `seq`. The inbound user turn-opener consumes a seq (`appendInboundUser`,
       * from the SAME counter as egress) but NEVER rides a durable wire frame, so
       * without this the client would see the turn's first agent frame at seq N
       * while holding last-applied N-2 — a phantom gap on every turn (doc §16.2-6).
       * This ack echo is the user seq's only carrier. A deduped retry echoes the
       * SAME first-admission seq. ⚠️ "Still ignored by the current client in half
       * A" IS STALE: half B consumes it — `advanceCursor(entry.seq)` per entry in
       * the wrapper's `ack` arm. (`adoptCommittedIds` alone still ignores `seq`;
       * that is one call site, not the frame.)
       */
      committed?: Array<{ random_id: string; messageId: string; seq: number }>;
    }
  | { type: "inbound_rejected"; ids: string[]; reason: "overloaded" }
  /**
   * #245 Part B (doc §16.2-8, the Telegram multi-device model): the immediate
   * BROADCAST of a just-committed inbound USER message to ALL of the account's
   * devices, so a user's own send appears on their OTHER devices NOW rather than
   * only when the agent next responds.
   *
   * ⚠️ IT IS A DELIVERY OF AN ALREADY-JOURNALED EVENT, NOT A NEW DURABLE ROW.
   * `appendInboundUser` has already committed the `user` event (that is where its
   * `id`/`seq`/`random_id` come from); this frame merely ships it live. So, like
   * `difference` and `history`, it is EXCLUDED from `journalEventForOutbound`/
   * `isSeqBearingFrame` — re-journaling it would write the store's own output back
   * in. Its `seq` is set at CONSTRUCTION from `appendInboundUser`'s return
   * (`nats-channel.ts`'s `sendUserCommitted`), NOT stamped by `sendToPeer`'s
   * seq-bearing path (which only touches frames `isSeqBearingFrame` accepts).
   *
   * ⚠️ `seq` IS REQUIRED HERE, unlike the `seq?` on the durable frames. The user
   * opener's seq is known at commit and is the whole point of the frame for a
   * NON-ORIGIN device: it advances that device's cursor so the turn's first agent
   * frame at `seq+1` reads as contiguous rather than a phantom gap (doc §16.2-6).
   *
   * ⚠️ `random_id` IS THE ORIGIN's RECONCILIATION KEY. The origin device adopts
   * its optimistic bubble onto this `id` by matching `random_id` (the same
   * correlation `ack.committed`/#337 use) and then folds a no-op — ONE bubble. A
   * non-origin device has no linkage for this `random_id`, so the adopt is a
   * no-op and it APPENDS the user event. Absent for a send that carried no
   * `random_id`.
   *
   * ⚠️ THE GAP-SYNC FALLBACK IS NOT A BACK-COMPAT STORY — IT IS THE AT-MOST-ONCE
   * STORY, which is why #246's v4 bump leaves it standing. This broadcast rides
   * core NATS pub/sub, so it can simply be DROPPED en route to a fully current
   * device; when it is, the next agent frame opens a gap and `get_difference`
   * converges the user event anyway. The broadcast is purely an IMMEDIACY
   * optimization over that path. (It read as "an older client that does not know
   * this type drops it" before v4; under exact-match there is no such peer — the
   * property is unchanged, only the reason for it.)
   */
  | { type: "user_committed"; id: string; text: string; turnId?: string; seq: number; random_id?: string }
  /**
   * #244 half B (doc §16.2-6): the answer to `get_difference` — the RAW journal
   * events with `seq > afterSeq`, each paired with its `seq`, in ascending `seq`
   * order. The client folds each `event` through the SAME reducer it folds live
   * frames through (`applyDurableEvent`), advances its last-applied seq to the max
   * seq here, then drains any frames it buffered while the request was in flight.
   *
   * ⚠️ RAW EVENTS, NOT A PROJECTED PAGE — and that is what keeps half B #286-free.
   * The `history` snapshot/page runs the quadratic full replay
   * (`projectJournalHistory`) server-side and ships `HistoryMessage[]`; a
   * difference ships the journal rows VERBATIM and lets the client fold them onto
   * the view it already holds. The server does NOT run the reducer here.
   *
   * ⚠️ NOT SEQ-BEARING and NOT journaled — like `history`, it is a server→client
   * REPLAY, so `isSeqBearingFrame`/`journalEventForOutbound` both reject/null it.
   * A `seq` on the FRAME would be meaningless (it carries many); the per-event
   * `seq` inside `events` is the cursor the client advances.
   *
   * ⚠️ MAY BE PARTIAL. The server caps the response (a huge gap would overflow
   * `max_payload`); the client advances to the max seq it received and re-requests
   * for the rest when the next durable frame (or a buffered one) still sits beyond
   * the contiguous next seq. So a difference guarantees FORWARD PROGRESS, not
   * completeness in one round-trip.
   */
  | { type: "difference"; events: Array<{ seq: number; event: DurableEvent }> };

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
  /**
   * #244 half A: `highWaterSeq` is the conversation's authoritative `MAX(seq)`,
   * attached to the register-time SNAPSHOT frame only (the pager omits it).
   * Additive and optional — see the `history` member of `OutboundWsMessage`.
   */
  sendHistory(peerId: string, messages: HistoryMessage[], highWaterSeq?: number): boolean;
  /**
   * #244 half B: answer a `get_difference` with RAW events (`seq > afterSeq`), in
   * ascending `seq` order. Optional so an older channel impl is not forced to
   * implement it — see the `difference` member of `OutboundWsMessage`.
   */
  sendDifference?(
    peerId: string,
    events: Array<{ seq: number; event: DurableEvent }>,
  ): boolean;
  /**
   * #245 Part B: broadcast a just-committed inbound user message to the account's
   * devices. Optional so an older channel impl is not forced to implement it — see
   * the `user_committed` member of `OutboundWsMessage`. `seq`/`id`/`random_id`
   * come from `appendInboundUser`'s return; the frame is NOT journaled here (the
   * event already is).
   */
  sendUserCommitted?(
    peerId: string,
    message: { id: string; text: string; turnId?: string; seq: number; random_id?: string },
  ): boolean;
  sendApprovalRequest(peerId: string, request: ApprovalRequestPayload): boolean;
  sendApprovalResolved(peerId: string, id: string, decision: ApprovalDecision): boolean;
  sendApprovalSnapshot(peerId: string, approvals: ApprovalRequestPayload[], resolved?: Array<{ id: string; decision: ApprovalDecision }>): boolean;
  sendAck?(
    peerId: string,
    ids: string[],
    committed?: Array<{ random_id: string; messageId: string; seq: number }>,
  ): boolean;
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
  sendHistory(_peerId: string, _messages: HistoryMessage[], _highWaterSeq?: number): boolean { return false; }
  sendDifference(_peerId: string, _events: Array<{ seq: number; event: DurableEvent }>): boolean { return false; }
  sendUserCommitted(_peerId: string, _message: { id: string; text: string; turnId?: string; seq: number; random_id?: string }): boolean { return false; }
  sendApprovalRequest(_peerId: string, _request: ApprovalRequestPayload): boolean { return false; }
  sendApprovalResolved(_peerId: string, _id: string, _decision: ApprovalDecision): boolean { return false; }
  sendApprovalSnapshot(_peerId: string, _approvals: ApprovalRequestPayload[], _resolved?: Array<{ id: string; decision: ApprovalDecision }>): boolean { return false; }
  sendAck(_peerId: string, ids: string[], _committed?: Array<{ random_id: string; messageId: string; seq: number }>): boolean { return ids.length === 0; }
  sendInboundRejected(_peerId: string, ids: string[]): boolean { return ids.length === 0; }
}
