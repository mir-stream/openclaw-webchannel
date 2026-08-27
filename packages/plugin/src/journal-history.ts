/**
 * v6 delivery-render — HISTORY PROJECTED OUT OF THE PLUGIN'S OWN JOURNAL
 * (issue #240, doc §15.4).
 *
 * The plugin is the Telegram *server*: it owns the durable store and the client
 * is a pure view of it (doc §0). History used to be read back out of core's
 * agent transcript, which is precisely what §0 forbids (NOT-list N2); #240
 * half 2 deleted that path, and this module replaced it — one conversation's
 * journal, folded into the message list the `history` frame carries.
 *
 * ⚠️ IT REPLAYS THE SHARED REDUCER. IT DOES NOT RE-IMPLEMENT IT. Every ordering,
 * supersession, tombstone and resurrect rule comes from
 * `packages/client/src/durable-view-reducer.ts`'s `applyDurableEvent` — the SAME
 * function the live client render folds frame-by-frame. That is the whole v6
 * bet: `history == live` holds BY CONSTRUCTION rather than because two
 * implementations happen to agree, and a server-side projection free to invent
 * one rule of its own is the exact regression this redesign exists to kill (N8).
 * Everything below is PROJECTION concern — chunking, `ts`, unknown kinds, paging,
 * and the `firstSeenMs` bookkeeping — and none of it may grow into a second
 * transition table. That list is what this module OWNS; it is not a list of
 * every way the two views can differ, and the next block is the counter-example.
 *
 * ── ⚠️ KNOWN live≠history GAPS, AND THIS MODULE IS WHERE THEY BECOME VISIBLE ──
 *
 * "`history == live` by construction" is the bet, not a proof, and there are two
 * standing exceptions that show up the moment a real conversation is replayed.
 * READ THIS BEFORE CONCLUDING THE PROJECTION IS WRONG.
 *
 * GAP 2 — REASONING IS DURABLE BUT UNSENDABLE (#242 half 1). For an account
 * that opted in via `capabilities.reasoningDurable` (default OFF — see
 * `account-config.ts`'s `resolveReasoningDurable`), the journal
 * records one row per reasoning burst and the fold places it in the view, but
 * the `history` wire frame carries `HistoryMessage`, whose `role` is
 * `"user" | "agent"` and which therefore cannot express a role-less reasoning
 * message. So the conversion loop in `projectJournalHistory` DROPS reasoning
 * entries on the way out, and a reload shows no reasoning where live showed it.
 * That is deliberate and scoped: half 1 is the SERVER side only. Half 2 widens
 * the frame and moves the client's render onto the reducer together, so the two
 * sides start agreeing in one step rather than passing through a state where the
 * wire carries a field no client reads. The drop is commented at the exact line
 * that performs it.
 *
 * GAP 1 — the phantom empty bubble:
 *
 * A lane that receives a `progress` and then NEITHER a `bubble` NOR a
 * `seal.answers` entry — an aborted turn, or a connection dropped before the
 * drain — leaves a `placement` whose text is never authored. The two sides then
 * disagree:
 *   - REPLAY (here): `applyPlacement`'s APPEND BRANCH (the one taken when no
 *     text entry holds the id) adds `{kind:"text", role:"agent", text:""}` and
 *     nothing in the reducer or the journal ever removes it, so
 *     `projectJournalHistory` emits a PHANTOM EMPTY AGENT BUBBLE;
 *   - LIVE: the client renders nothing there. `mergeDurable` skips the entry —
 *     its `if (this.isSpentDraft(next)) continue;` guard, just before the
 *     `out.push` (`nats-client-wrapper.ts`; both of these are cited by SYMBOL
 *     because the line numbers here rotted within one commit) — and
 *     `isSpentDraft` keys on the CLIENT-LOCAL `draftOnly` flag, deliberately
 *     never journaled, because §15.9 classifies the rolling draft as an
 *     indicator rather than a message.
 * So the rule that hides it is expressed in a field the server does not have.
 * That is N8 by OMISSION, and it is the reason this file cannot claim the
 * equality unconditionally.
 *
 * ⚠️ IT IS NOT THIS SLICE'S TO FIX, AND THE OBVIOUS FIX IS FORBIDDEN HERE. The
 * repair is derivable from the log alone — "a placement whose answerId never
 * reappears" — and writing that fold into this module is EXACTLY the second
 * transition table the paragraph above forbids: a supersession rule invented
 * server-side, which is how N8 gets reintroduced by the code meant to prevent
 * it. **#251** owns what should render for such a lane (settled: nothing — core's
 * built-in Telegram extension deletes an unfinalized preview at turn end) and
 * **#264** owns deriving it from events alone, which may require a turn-close
 * event and therefore **#241** / the reducer's BOUNDARY 2. The placement mapper
 * in `delivery-journal-event.ts` records the same fact at the point the event is
 * created; this block exists so the reader who hits the phantom bubble in a
 * replay finds it here too.
 *
 * ⚠️ THIS IS NOW THE ONLY HISTORY READ PATH. #240 half 2 wired both call sites
 * (the register-time snapshot and the `load_history` pager) to
 * `serveHistoryRequest` below and DELETED the core transcript reader with them:
 * the `runtime.subagent` session-message read, the `AsyncResource`
 * operator-scope detour, the transcript normalizer and `history-sanitize.ts`
 * are gone from this package. `history.ts` survives as the wire type + config +
 * request-plan module and nothing else. Both call sites live in
 * `history-serve.ts`, which owns the deferral, the per-peer in-flight bound and
 * the failure policy; `nats-account-runtime.ts` only wires it.
 *
 * ⚠️ THE CLIENT'S AGENT-SIDE ADOPTION TIERS ARE GONE, and that is a consequence
 * of this module rather than a separate cleanup. Because the journal serves the
 * delivery-act id, an agent bubble the client rendered live carries the id the
 * snapshot carries — so it matches by ID, and an agent row that does NOT match
 * by id has no local counterpart at all. Four data-loss defects were found in
 * that block across four review rounds before the tiers were deleted rather
 * than patched a fifth time. `case "history"` in `nats-client-wrapper.ts` now
 * matches an agent row by id or fresh-inserts it; it never guesses.
 *
 * ⚠️ USER ROWS STILL TEXT-MATCH, AND THE RESIDUAL IS REAL. The client renders a
 * user echo under a local `u-<n>` while the accept seam journals the inbound
 * WIRE id, so user ids do NOT agree and tier 2 is how the echo is recovered.
 * That is the ordinal/text inference N5 forbids, still running on one path.
 * **#302** owns removing it and stays OPEN, blocked on **#243** giving a user
 * message one shared id. (The #104/#227/#228 doc §5 originally cited for this
 * are all CLOSED.)
 *
 * ⚠️ NEVER SANITIZE HERE. Do not reintroduce `sanitizeHistoryText` or anything
 * like it. The journal stores the EXACT text that was published to the client,
 * so re-sanitizing on the way out would make history differ from live by
 * construction — N8, introduced by the one module whose job is to prevent it.
 * The deleted sanitizer existed ONLY because the core-transcript reader received
 * raw model output that the live path never showed verbatim; that input no
 * longer reaches this package, so the module had no subject left.
 *
 * ⚠️ AND NEVER SORT. The reducer's slot-claim order IS the order — a `placement`
 * fixes a lane's position, and a `seal` may legitimately permute answer slots
 * afterwards, so the `ts` values below can be NON-MONOTONE with respect to the
 * emitted array. That is correct, not a bug: sorting by `ts` would override the
 * reducer and reintroduce N8. Measured, because `HistoryMessage`'s docblock used
 * to claim the widget "can sort by recency" and that claim was stale: there is no
 * `.sort(`/`.toSorted(` in any non-test file under `packages/client/src`, and
 * none in the widget tree at `demo/web/src/` either — where `presentation.ts` and
 * `app.ts` actually render the list. `ts` is hydration metadata, not an ordering
 * key. The docblock was corrected in half 2; this is the measurement behind it.
 *
 * ── MEMORY IS BOUNDED BY CONSTRUCTION ──
 *
 * `DeliveryJournal.read`'s docblock flags its unbounded default as a MEMORY
 * DECISION and quantifies it: at 20 000 rows of ~1.2 KB an unbounded read materializes
 * AND `JSON.parse`s the whole conversation synchronously — ~75 ms and ~25 MB of
 * live objects. This module answers that by never issuing one. It folds in
 * `HISTORY_REPLAY_CHUNK_ROWS`-sized pages, so what is alive at once is the
 * projected view, ONE chunk, and the `firstSeenMs` map — that last one is easy to
 * omit from this sentence and it is not free: it is O(DISTINCT IDS EVER NAMED),
 * which is strictly larger than the view, because an id removed by a `seal` and
 * never resurrected stays in the map while leaving the view. It is the same
 * ORDER as the view (one small entry per id, no text), so the bound holds — but
 * "the view and one chunk" is not the whole list.
 *
 * ⚠️ THAT BOUNDS THE LIVE SET, NOT THE ALLOCATION CHURN, and the distinction was
 * measured. Allocation is the reducer's DEFAULT: a transition that changes the
 * durable view returns a NEW array covering the whole view (structural sharing at
 * the ENTRY level, not the array level), so a 20 000-event replay allocates and
 * discards up to ~20 000 arrays of up to 10 000 pointers. UP TO, not exactly —
 * three paths hand the input array straight back instead: `applyPlacement`'s
 * `turnId === prev.turnId` no-op on a repeat claim, `applySeal`'s
 * no-valid-answers-and-no-removes early return, and `applySeal`'s blank-turnId
 * guard. That list is EXHAUSTIVE, and the ARRAY IDENTITY table in
 * `durable-view-reducer.ts`'s own header is where it is maintained — read it
 * there rather than re-deriving it here. `MIXED_STREAM` in the test file
 * exercises the first, via its repeat placement claim. So ~20 000 is an UPPER
 * BOUND on the arrays, not a count of them. The measurement is unaffected: heap
 * BEFORE a forced GC came out HIGHER for the chunked replay (+85.5 MB) than for
 * the unbounded read (+48.0 MB), while retained heap after one came out lower
 * (+11.8 MB vs +22.0 MB). Neither number is a defect — one is garbage, one is the
 * live set — but do not quote the chunking as a bound on GC pressure. It is a
 * bound on what is retained.
 *
 * ── COST: A PAGE IS A FULL REPLAY, AND THE REPLAY IS QUADRATIC ──
 *
 * Both page selectors below operate on the FULL projection, so serving any page
 * replays the entire conversation. That is correct (the reducer is the only
 * thing allowed to decide order) but it is not free, and doc §15.4 says
 * pagination should eventually come off the materialized `journal_message` read
 * model. That table is NOT built here — it is **#286**, filed off the numbers
 * below.
 *
 * MEASURED against a real `openDeliveryJournal` on this dev box (zfs, WAL +
 * `synchronous = FULL`), a realistic mixed stream (user / 3 placements /
 * 3 bubbles / seal per turn) at the ~1.2 KB payload size the store docblock
 * calls dominant, warm cache, best of three runs, milliseconds:
 *
 *   events  messages  raw unbounded read  fold only  project@128  @512  @4096
 *    1 000       500                 2.9        3.3          6.8    6.2    5.9
 *    5 000     2 500                15.0       62.0         77.6   77.0   74.2
 *   10 000     5 000                30.8      269.6        316.7  312.7  310.4
 *   20 000    10 000                60.9    1 323.3      1 449.6 1449.1 1430.9
 *
 * Three things fall out of that table, and only the first was expected:
 *
 *  1. CHUNK SIZE IS NOT A TIME/MEMORY TRADE — and that has to be stated in the
 *     unit that is true at each end, because the RATIO is not flat. 128 vs 4096
 *     is +1.3% at 20 000 events (1449.6 vs 1430.9) and +2.0% at 10 000; the
 *     spread WIDENS as a fraction on short conversations (+4.6% at 5 000, +15.3%
 *     at 1 000), because there the fold is small enough that the extra reads
 *     stop disappearing into it. But at 1 000 events that 15.3% is 0.9 ms of
 *     wall clock (6.8 vs 5.9). So: ~1% where the projection is expensive, under
 *     a millisecond where it is not, and no size where the memory bound buys
 *     back time worth having — see `HISTORY_REPLAY_CHUNK_ROWS`. Quote BOTH ends
 *     in their own unit; a single percentage across the table is false at three
 *     of these four sizes whichever one you pick.
 *  2. THE SQL IS NOT THE COST. The raw unbounded read is linear and small
 *     (~61 ms at 20 000 — the same ORDER as the ~75 ms in
 *     `DeliveryJournal.read`'s docblock, not a match for it; the two runs differ
 *     by 19%); the projection is 24x that.
 *  3. ⚠️ THE COST IS THE SHARED REDUCER'S FOLD, AND IT IS QUADRATIC IN
 *     CONVERSATION LENGTH. `fold only` is `reduceDurableView` over rows already
 *     parsed, so the gap up to `project@512` is this module's own overhead — the
 *     reads, the `JSON.parse`, the `firstSeenMs` bookkeeping and the final
 *     `view.map`. That overhead is 9.5% at 20 000 events (1449.1 vs 1323.3),
 *     and it is a much larger fraction of a much smaller number lower down the
 *     table: 16% at 10 000, 24% at 5 000, 88% at 1 000 — where the entire
 *     projection is 6.2 ms and the constant costs simply have nothing to hide
 *     behind. Read it as "the fold dominates once the conversation is long
 *     enough for the projection to matter", never as a fixed ~9% surcharge.
 *     The fold itself grows ~4–5x per 2x of events (62.0 → 269.6 is 4.35x,
 *     269.6 → 1 323.3 is 4.91x — quote the range, not one exponent) because
 *     `applyPlacement`/`applyBubble` upsert by `view.findIndex` and each
 *     view-changing transition allocates a fresh array of the whole view. That
 *     is inherent to the reducer, is fine LIVE (one event at a time
 *     against a short view), and must NOT be "optimized" here — a faster private
 *     fold in the plugin is a second implementation, which is N8. The fix is the
 *     materialized read model of §15.4 (**#286**), which replays incrementally
 *     from a checkpoint instead of from zero; the hard part there is PROVING a
 *     checkpointed projection equivalent to a full replay, not the table.
 *
 * Memory behaves as intended and was measured the same way (heap retained after
 * a forced GC, 20 000 events): the unbounded read holds +22.0 MB live, the
 * chunked projection +11.8 MB — and the latter is the RESULT (10 000 messages),
 * not a transient.
 *
 * So: fine per RECONNECT at today's conversation lengths, already ~1.4 s at
 * 20 000 events, and not viable per page-scroll. That is #286's job.
 *
 * ⚠️ AND HALF 2 SHIPPED THE CUTOVER ANYWAY, WITH MITIGATIONS THAT ARE NOT A FIX.
 * `history-serve.ts` does two things, and they are worth stating separately
 * because an earlier version of this paragraph ran them together and got the
 * second one wrong:
 *  - DEFERRAL. Both call sites schedule the fold, so it never runs on the turn
 *    that requested it — the register reply publishes before the snapshot is
 *    projected. This changes WHO ELSE GETS TO RUN, not the CPU spent.
 *  - A PER-PEER IN-FLIGHT LATCH. For ONE peer a burst of `load_history` frames
 *    does NOT become "one turn per page": the first is scheduled and the rest
 *    are DROPPED. Interleaving one fold per turn is what happens across
 *    DIFFERENT peers.
 * Neither is a bound on depth or on rate. A 20 000-event conversation still
 * costs ~1.4 s of blocked loop PER PAGE, and pages are unbounded — a depth bound
 * was built and reverted because total length is checkable before a fold and
 * cursor depth is not, so a length gate destroys reach instead of limiting it
 * (`history-serve.ts`'s header has the full argument). Do not read the deferral
 * or the latch as the cost being handled; #286 is the fix.
 */
import {
  applyDurableEvent,
  type DurableView,
} from "../../client/src/durable-view-reducer.js";
// Type-only, all four. This module must stay pure and IO-free: importing
// `delivery-journal.ts` for a VALUE would drag `node:sqlite` (and the SDK's
// sqlite runtime) into anything that touches history projection. The reader
// arrives as a PARAMETER instead.
//
// `history.ts` is type-only for a WEAKER reason than it used to be — half 2
// emptied that file of everything but the wire type, the config resolver and
// `planHistoryFetch`, so a value import would no longer drag in
// `node:async_hooks` or a transcript reader. Keep it type-only anyway: the
// dependency runs the other way round in `serveHistoryRequest`'s design (the
// PLAN is data handed in, not a function this module calls), and a value edge
// here is the first step back toward the two modules knowing about each other.
import type {
  DeliveryJournal,
  RetainedJournalEvent,
} from "./delivery-journal.js";
import type { JournalEvent } from "./delivery-journal-event.js";
import type { HistoryFetchPlan, HistoryMessage } from "./history.js";

/**
 * The journal read seam, taken verbatim off the store's own interface so the two
 * cannot drift into two signatures.
 */
export type JournalReader = DeliveryJournal["read"];

/**
 * Rows pulled per `read` call during a replay.
 *
 * WHY 512. At the ~1.2 KB payload size `delivery-journal.ts` measures as
 * dominant, one chunk is ~0.6 MB of live row objects, so the peak this module
 * holds is the projected view plus that — against the +22.0 MB an unbounded read
 * retains at 20 000 rows (measured; the store docblock says ~25 MB). Smaller
 * would shrink an already-small number while multiplying prepared-statement
 * round trips (20 000 rows is 40 reads at this size, 400 at 50); larger walks
 * back toward the unbounded read and makes the bound stop meaning anything.
 *
 * ⚠️ THE VALUE IS NOT A TIME/MEMORY TRADE — THAT WAS MEASURED, AND THERE IS NO
 * TRADE TO MAKE. Across 128, 512 and 4096 the whole spread is 1.3% at 20 000
 * events and 2.0% at 10 000; it widens to 15.3% at 1 000 events, which is 0.9 ms
 * of wall clock (see the table in the file header). Both ends say the same thing,
 * because the replay's cost is the reducer's fold and not the reads: ~1% where
 * the projection is expensive, under a millisecond where it is cheap. So pick the
 * value on memory alone and do not "tune" it for speed; there is nothing there to
 * win.
 *
 * The projected VIEW is not bounded by this and cannot be — it is the answer.
 */
export const HISTORY_REPLAY_CHUNK_ROWS = 512;

/**
 * The kinds THIS BUILD can fold, derived from the event union rather than
 * written out as a string array.
 *
 * `Record<JournalEvent["kind"], true>` is what makes a new kind impossible to
 * forget: the day the event model grows, tsc fails HERE with a missing property
 * instead of letting the new kind be silently counted as unsupported forever.
 *
 * ⚠️ THAT IS NOT A PREDICTION ANY MORE — IT FIRED. #242 half 1 added
 * `reasoning`, and this object is one of the places tsc pointed at. The device
 * works; keep it derived, and never "simplify" it to a string literal array.
 */
const KNOWN_EVENT_KINDS: Record<JournalEvent["kind"], true> = {
  user: true,
  placement: true,
  bubble: true,
  seal: true,
  reasoning: true,
};

/**
 * Can this row's event reach `applyDurableEvent` at all?
 *
 * ⚠️ `typeof === "string"` AND `Object.hasOwn` — not `kind in KNOWN_EVENT_KINDS`,
 * not a truthiness read, and not `Object.hasOwn` on its own. `kind` comes off a
 * `JSON.parse`d payload, so it is attacker-shaped only in the sense that a future
 * build writes it, but there are two ways a non-kind answers yes:
 *  - INHERITED NAMES. `"constructor"`, `"toString"` and `"__proto__"` all answer
 *    truthy through the prototype chain, which `Object.hasOwn` refuses.
 *  - NON-STRINGS THAT STRINGIFY. `Object.hasOwn` runs `ToPropertyKey` on its
 *    second argument, so `{"kind": ["user"]}` becomes the key `"user"` and
 *    PASSES. The `typeof` gate is what stops that one; `Object.hasOwn` alone
 *    cannot, because the coercion happens inside it. And do NOT delete the gate
 *    as redundant with `RetainedJournalEvent`'s `kind: string`: that annotation
 *    describes an unvalidated `JSON.parse` cast (delivery-journal.ts:739), so it
 *    is a claim about the row, not a check on it — which is exactly the friction
 *    that field's own docblock says it exists to create.
 *
 * ⚠️ BE PRECISE ABOUT WHICH DOOR THAT SECOND ONE COMES THROUGH — it is NOT our
 * own `append`. MEASURED on `node:sqlite`: `append` binds `event.kind` and
 * `JSON.stringify(event)` as parameters of ONE `insertEvent.run(...)`
 * (delivery-journal.ts:666-674), and binding an ARRAY or an OBJECT throws before
 * any row is written, so `{"kind":["user"]}` cannot be stored by this build at
 * all. A NUMBER kind does bind and round-trip — and `Object.hasOwn(K, 7)` is
 * already `false`, so `hasOwn` alone handles that one. Through the plugin's own
 * write path the `typeof` gate is therefore a no-op, and the reachable callers
 * are the ones that did not go through `append`: a hand-edited or foreign-written
 * database, and — today, in this process — any INJECTED `JournalReader`, which is
 * this function's public seam and is exactly what the test uses. Cheap, correct,
 * and defending the seam we actually expose; not a claim that our own writer can
 * produce it.
 * Both land in the same place if they get through: `applyDurableEvent`'s `switch`
 * compares with `===`, matches no case, falls off the end and returns `undefined`
 * while the signature declares `DurableView` — so the NEXT event throws while
 * naming the WRONG event. That is the one outcome this predicate exists to
 * prevent, and it is why the guard is on the VALUE, not just on the lookup.
 *
 * Beyond the kind it checks nothing. A row whose kind is `"user"` but whose
 * payload lacks `id` still passes, and that is deliberate: the journal is our own
 * write path, and validating field-by-field here would be a second schema free to
 * disagree with the reducer's. Note the store is a NARROWER backstop than it
 * looks — `append` validates the `user` id only (non-empty string, within
 * `MAX_INBOUND_USER_ID_LENGTH`; delivery-journal.ts:629-655) and takes `text` and
 * `turnId` as given. The property that a journaled `user.text` really is a
 * `string` is established at the ACCEPT seam instead, where `ingress-dedupe.ts`
 * filters the batch on `typeof pending.text === "string"` before appending and
 * reports the rest as a journal gap. So "the write path already checked" is
 * true, but it is true at a different door than this one.
 *
 * (That last one is cited by its CONDITION rather than a line range on purpose.
 * It is the only anchor in this file pointing into a seam that a different,
 * still-open slice is actively rewriting — the range moved twice during this
 * PR's own review — and nothing in the repo checks in-repo `file.ts:NNN`
 * anchors (**#288**). A grep-stable predicate survives that churn; a number does
 * not, and a number that has gone stale reads as authority.)
 */
function isKnownJournalEvent(
  event: RetainedJournalEvent,
): event is JournalEvent {
  return (
    typeof event.kind === "string" &&
    Object.hasOwn(KNOWN_EVENT_KINDS, event.kind)
  );
}

/** What one conversation's journal projects to. */
export type JournalHistoryProjection = {
  /** The durable view, in the REDUCER's order, with `ts` attached. */
  messages: HistoryMessage[];
  /**
   * Rows dropped because this build does not know their kind. NOT a silent
   * drop — see `projectJournalHistory`'s note on why the count is the whole
   * point.
   */
  unsupportedEvents: number;
  /**
   * Messages whose `ts` could not be sourced from a first appearance. Expected
   * to be 0 forever on today's event set; see the `ts` note below.
   */
  tsFallbacks: number;
};

/**
 * Replay one conversation's journal into the history view.
 *
 * `read` is injected rather than imported so this module stays pure and
 * database-free; pass `journal.read` bound to the open store.
 *
 * ── READ FAILURE: THIS MODULE DOES NOT CATCH, AND NEITHER DOES `serveHistoryRequest` ──
 *
 * A store failure PROPAGATES from here, through `serveHistoryRequest`, to the
 * two call sites in `history-serve.ts`. The reason is narrow: one log
 * path per failure rather than two, so the site that owns the policy also owns
 * the log line.
 *
 * ⚠️ AND THE POLICY IS "NO FRAME", NEVER "AN EMPTY FRAME". The deleted
 * core-transcript wrapper caught and returned `[]` — a failed read rendered as
 * "no history" — which was sound only because core's transcript was a SECOND
 * copy of the truth, so a failed read degraded a convenience view while the real
 * conversation sat untouched. Under §15.6 the journal is the ONLY store, and
 * catch-and-return-`[]` now turns a broken read into a conversation that LOOKS
 * EMPTY to its owner: unrecoverable in a way a crash is not, because nobody is
 * told anything. Do not reintroduce that wrapper.
 *
 * The design forbids it in as many words: doc §15.6's write-failure line ends
 * "조용한 빈-세션 위장 금지" — no silent empty-session impersonation. It is
 * written about WRITE failures; a read failure that renders as `[]` is the same
 * impersonation reached from the other side.
 *
 * This is also the SAME argument the `chunkRows` validation below is made from,
 * and the two must not contradict each other: that throw exists precisely
 * because an empty projection is indistinguishable from an empty conversation.
 * A caller that then swallowed a read failure into `[]` would hand back the exact
 * value the throw refuses to produce. What the two live call sites do instead is
 * log at `error` and send NO `history` frame at all.
 *
 * ── CHUNKED FOLD ──
 *
 * Reads `chunkRows` at a time, advancing `afterSeq` to the last row's `seq`, and
 * stops when a chunk comes back short. Only the view, one chunk and the
 * `firstSeenMs` map are ever live; that is the answer to the memory warning in
 * `DeliveryJournal.read`'s docblock.
 *
 * THROWS if `chunkRows` is not an integer >= 1 — see the inline note; a
 * non-positive one would return an empty projection indistinguishable from an
 * empty conversation.
 *
 * The loop ALSO stops — BEFORE folding the chunk — if a chunk's last `seq`
 * failed to advance past the `afterSeq` it was given. That is defensive: `read`
 * returns `seq`-ordered rows and its `selectRows` filters `seq > afterSeq`, so a
 * non-advancing chunk cannot happen against the real store. But the failure mode
 * it prevents is an INFINITE LOOP inside a history read, which is not an
 * acceptable way for this function to be wrong, so a fake or a future reader
 * that violates the ordering contract gets a truncated history instead of a hung
 * gateway. Checking BEFORE the fold rather than after is what keeps the guard
 * from corrupting the view on its way out: rows are ordered, so a chunk that did
 * not advance is entirely rows already folded, and folding them twice duplicates
 * every `user` bubble in it (`applyUser` blind-appends).
 *
 * ── AN UNKNOWN KIND IS COUNTED, NEVER FOLDED ──
 *
 * A row whose kind is outside `KNOWN_EVENT_KINDS` is counted into
 * `unsupportedEvents` and dropped from the fold. Dropping is chosen ONLY because
 * the alternative is worse: `applyDurableEvent`'s `switch` has NO `default`, so
 * an out-of-union kind falls off the end and returns `undefined` while the
 * signature declares `DurableView`, and the NEXT event then throws
 * (`Cannot read properties of undefined (reading 'findIndex')`) while NAMING THE
 * WRONG EVENT. That is measured and documented at length in the reducer's own
 * header. Do not "fix" this by adding a `default:` to the reducer — the absence
 * is deliberate there, and this module may not touch it.
 *
 * ⚠️ THE COUNT IS WHAT KEEPS THIS FROM BEING THE SILENT DROP THE REDUCER'S
 * HEADER REJECTS. It is not a diagnostic nicety; it is the difference between
 * "a quietly incomplete history with no signal to anyone" and a caller that can
 * see its own truth was withheld.
 *
 * ⚠️ AND THE COUNT DOES NOT TELL YOU WHICH DIRECTION THE ERROR WENT. Skipping a
 * forward kind that ADDS content yields a history missing a message; skipping a
 * forward kind that REMOVES content — a tombstone/redaction event, the shape
 * #241 is most likely to introduce — yields the OPPOSITE error, a history
 * showing content a newer build deleted. Both arrive as "1". So a non-zero count
 * is "this projection is not authoritative", never "1 row is missing".
 *
 * The REAL answer is retain-and-render-as-unsupported — keep the slot and show
 * "not supported by your version", the way the Telegram app does — which needs a
 * non-closed union and is **#241/#253**, not this slice. (#246 is the protocol
 * version bump, a different issue; an earlier revision cited it here.)
 *
 * ── WHERE `ts` COMES FROM ──
 *
 * `DurableMessage` has no timestamp (it is client-local overlay by §0.1) and
 * `HistoryMessage` requires `ts: number`, so this module sources it: the
 * `created_ms` of the row whose event FIRST NAMES that id — `user.id`,
 * `placement.answerId`, `bubble.answerId`, `reasoning.id`, and every
 * `seal.answers[].id` — never overwritten afterwards.
 *
 * First-appearance rather than last-write, for two reasons. An EDIT does not
 * change a message's timestamp (Telegram behaves the same way), so a `bubble`
 * revising text, a `seal` re-authoring it, and a post-`remove` resurrect must
 * all keep the original moment. And first-appearance is deterministic and
 * monotone in `seq`, so the same journal always yields the same `ts`.
 *
 * A `seal` that MINTS an answer which never egressed a bubble — the #215
 * create-or-update recovery — is a genuine first appearance and takes the seal
 * row's `createdMs`. There is no earlier row to take it from.
 *
 * FALLBACK: a message in the final view with no recorded first appearance takes
 * the last processed row's `createdMs` and increments `tsFallbacks`. That path
 * is UNREACHABLE on today's event set — every `DurableMessage` id is introduced
 * by one of the five events above, all of which record — and it exists so that a
 * new kind which introduces an id cannot ship `ts: undefined` or `NaN` onto the
 * wire while nobody notices. The counter is how the caller finds out it happened.
 *
 * ⚠️ IT IS ALSO COUNTED OVER THE EMITTED LIST, NOT THE VIEW. Reasoning messages
 * are dropped before this step (see the conversion loop), so they can neither
 * raise nor mask this counter — which is right, because the counter is about
 * what `ts` reaches the WIRE.
 */
export function projectJournalHistory(
  read: JournalReader,
  conversationId: string,
  options?: { chunkRows?: number },
): JournalHistoryProjection {
  // Exposed so the chunk-boundary equivalence test can vary it and assert a real
  // property (one big read == many small reads) instead of restating the default.
  const chunkRows = options?.chunkRows ?? HISTORY_REPLAY_CHUNK_ROWS;
  // ⚠️ VALIDATED, AND THE THROW IS THE POINT. Against the REAL store a
  // non-positive or non-integer value is already loud — `read` runs it through
  // `requireCount` (delivery-journal.ts:721/727). Against an INJECTED reader it
  // is not: `chunkRows: 0` makes every chunk come back empty, the loop exits on
  // its first iteration, and the caller gets an empty projection
  // INDISTINGUISHABLE FROM AN EMPTY CONVERSATION. The store ranks that outcome
  // the same way — but ⚠️ NEITHER of the two places it says so is about THIS
  // trigger, so neither is being inherited here:
  //   - `read`'s IMPLEMENTATION comment (delivery-journal.ts:717-720) is where
  //     the phrase "a SILENTLY EMPTY history, which is the worse of the two by
  //     far" lives, and it is about a `NaN` `afterSeq` binding as NULL so
  //     `seq > NULL` is never true — nothing to do with page size;
  //   - the INTERFACE docblock (delivery-journal.ts:263) is the page-size one,
  //     and it refuses a silent default because that yields "a silently
  //     TRUNCATED history" — the milder cousin of this failure, not this one.
  // The argument stands on its own either way: a history that lies about being
  // empty is unrecoverable in a way a crash is not, because nobody is told
  // anything. Same rule and same
  // wording shape as the store's `requireCount`, so the two doors cannot
  // disagree about what a legal page size is.
  if (!Number.isInteger(chunkRows) || chunkRows < 1) {
    throw new Error(
      "webchannel: projectJournalHistory chunkRows must be an integer >= 1 " +
        `(received ${String(chunkRows)}); a non-positive page size yields an ` +
        "empty projection indistinguishable from an empty conversation",
    );
  }

  let view: DurableView = [];
  const firstSeenMs = new Map<string, number>();
  let unsupportedEvents = 0;
  let afterSeq = 0;
  // The `ts` fallback's source. Set for EVERY row read, unsupported ones
  // included: "the last row we processed" is the honest anchor for a message we
  // could not date, and an unsupported row is still evidence of when the
  // conversation was being written.
  let lastCreatedMs: number | undefined;

  for (;;) {
    const rows = read(conversationId, { afterSeq, limit: chunkRows });
    if (rows.length === 0) break;
    const lastSeq = rows[rows.length - 1].seq;
    // ⚠️ THE ADVANCEMENT CHECK RUNS BEFORE THE FOLD, NOT AFTER IT. Rows come
    // back `seq`-ordered, so a chunk whose LAST seq did not pass `afterSeq` is
    // entirely rows we have already folded — folding it again would duplicate a
    // `user` bubble (`applyUser` blind-appends) on the way out of the loop, i.e.
    // the guard against a hang would itself corrupt the view it terminated.
    // Refuse the chunk, then stop. Defensive: see the docblock — the real
    // `selectRows` filters `seq > afterSeq`, so this cannot fire against the
    // store.
    if (!(lastSeq > afterSeq)) break;
    for (const row of rows) {
      lastCreatedMs = row.createdMs;
      const event = row.event;
      if (!isKnownJournalEvent(event)) {
        unsupportedEvents += 1;
        continue;
      }
      recordFirstSeen(firstSeenMs, event, row.createdMs);
      view = applyDurableEvent(view, event);
    }
    // A short chunk is the end of the log — the ordinary exit. An exactly-full
    // final chunk costs one more (empty) read, which is the price of not
    // guessing.
    if (rows.length < chunkRows) break;
    afterSeq = lastSeq;
  }

  let tsFallbacks = 0;
  const messages: HistoryMessage[] = [];
  for (const message of view) {
    // ⚠️ #242 half 1: REASONING IS IN THE DURABLE VIEW AND CANNOT GO ON THE
    // WIRE YET. This is a shape limit, not a judgement about the content — read
    // the two facts in this order:
    //  - the view ABOVE HOLDS IT. The journal has one row per reasoning burst
    //    and `applyDurableEvent` folded it into `view` at the position it was
    //    delivered. Nothing is missing from the projection;
    //  - `HistoryMessage` — the one this module imports, `history.ts`'s, which
    //    is its OWN declaration requiring `ts: number` rather than a re-export
    //    of the wire-shaped `channel-contract.ts` type — is
    //    `{ id, role, text, ts }`. `role` is `"user" | "agent"` and a reasoning
    //    message HAS NO ROLE: the wire frame carries none, and the reducer's
    //    `DurableMessage` refuses to invent one. There is no value to put there,
    //    so there is no frame to send. (Both declarations have the same `role`,
    //    so widening is a two-file change, which is half 2's problem.)
    // Half 2 widens the frame and moves the client's render onto the reducer IN
    // ONE STEP, which is what makes `live == history` close atomically for
    // reasoning; widening the frame here alone would ship a field no client
    // reads. Do NOT "fix" this by giving reasoning `role: "agent"` — that is a
    // fabricated claim in the SSOT (N8), and it would render reasoning as an
    // answer bubble on every existing client.
    //
    // The two page selectors are unaffected BY CONSTRUCTION: they operate on
    // this list, and their cursor is an id taken FROM it, so a reasoning id can
    // never become a cursor the client cannot resolve. `ts` is still recorded
    // for these ids (see `recordFirstSeen`), which is what half 2 inherits.
    if (message.kind !== "text") continue;
    const seen = firstSeenMs.get(message.id);
    if (seen !== undefined) {
      messages.push({ id: message.id, role: message.role, text: message.text, ts: seen });
      continue;
    }
    tsFallbacks += 1;
    // `lastCreatedMs` is defined whenever the view is non-empty (a message can
    // only exist because a row produced it), so the `0` is unreachable and is
    // here to keep the type honest rather than as a policy.
    messages.push({
      id: message.id,
      role: message.role,
      text: message.text,
      ts: lastCreatedMs ?? 0,
    });
  }

  return { messages, unsupportedEvents, tsFallbacks };
}

/**
 * Record the FIRST row that names each id in this event. Never overwrites.
 *
 * The `Array.isArray` guard on `seal.answers` mirrors `applySeal`'s own — the
 * reducer tolerates a malformed payload there rather than throwing, and a
 * projection that crashes where the reducer shrugs would be the one place this
 * module is stricter than the rules it is supposed to be replaying.
 *
 * ⚠️ THIS DATES IDS FROM EVENTS THE REDUCER MAY THEN REJECT, AND THAT IS A KNOWN,
 * ACCEPTED DIVERGENCE — not an oversight. `applySeal` refuses a seal outright
 * at its blank-turnId guard when `turnId` is blank or not a string, and drops
 * individual answers whose `id` is `""` or whose `text` is not a string at its
 * `rawAnswers` filter. This function records every
 * `answers[].id` regardless. `journalEventForOutbound` copies `frame.turnId`
 * verbatim, so `seal{turnId:"", answers:[{id:"C",…}]}` really does round-trip
 * through the store: it contributes NOTHING to the view, yet it dates C. A later
 * genuine `bubble C` then materializes with a `ts` sourced from an event that
 * never entered the view at all.
 *
 * ⚠️ THE OBVIOUS FIX IS REFUSED. Mirroring those two guards here would put the
 * reducer's admission rules in a SECOND place, in a different package, with
 * nothing to make the copies go red together — the precise defect class this
 * whole module exists to avoid (N8). Two guards that must agree and cannot be
 * checked against each other WILL drift, and they would drift silently, because
 * a wrong `ts` is invisible in every test that asserts ids and text.
 *
 * The impact is bounded and that is why documenting beats fixing: `ts` is
 * HYDRATION METADATA, not an ordering key (see the NEVER SORT block in the file
 * header — nothing in production reads it to order anything), so the blast radius
 * of a misdated message is a timestamp that reads early. It is not lost content,
 * not a wrong slot, and not a divergence the client can act on. If `ts` ever
 * BECOMES load-bearing, this note is the thing to revisit first, and the right
 * repair is still not a copy of the guards — it is the reducer reporting which
 * events it admitted.
 */
function recordFirstSeen(
  firstSeenMs: Map<string, number>,
  event: JournalEvent,
  createdMs: number,
): void {
  const note = (id: unknown): void => {
    if (typeof id !== "string") return;
    if (!firstSeenMs.has(id)) firstSeenMs.set(id, createdMs);
  };
  switch (event.kind) {
    case "user":
      note(event.id);
      return;
    case "placement":
    case "bubble":
      note(event.answerId);
      return;
    case "reasoning":
      // Recorded even though half 1 DROPS reasoning from the emitted
      // `HistoryMessage` list (see `projectJournalHistory`'s conversion): the
      // drop is a wire-shape limitation, not a decision that the message has no
      // moment. Half 2 puts it on the wire and takes the `ts` from here
      // unchanged.
      note(event.id);
      return;
    case "seal":
      if (!Array.isArray(event.answers)) return;
      for (const answer of event.answers) {
        if (answer && typeof answer === "object") note(answer.id);
      }
      return;
    default: {
      // ⚠️ COMPILE-TIME EXHAUSTIVENESS, same device and same reason as
      // `KNOWN_EVENT_KINDS` above. Without it a `switch` over a closed union
      // SILENTLY NO-OPS on a new member: #241 adds a fifth kind, the author is
      // forced to update `KNOWN_EVENT_KINDS` (tsc fails there), the new kind
      // therefore reaches the fold — but nothing records a first appearance for
      // any id it introduces, so every message it creates quietly takes the
      // `lastCreatedMs` fallback. `ts` is hydration metadata and nothing orders
      // on it, so that is invisible in every test asserting ids and text. This
      // makes the second place that must change fail loudly like the first.
      const unhandled: never = event;
      void unhandled;
      return;
    }
  }
}

/**
 * The most recent `limit` messages — the tail fetch, the no-cursor case of
 * `planHistoryFetch`.
 *
 * ⚠️ THE `limit` GUARD IS THE DOWNSTREAM ONE (`limit <= 0` → `[]`), NOT
 * `planHistoryFetch`'s (non-positive / non-finite / non-number → the configured
 * fallback, `history.ts`). Both conventions exist in this package and matching
 * the wrong one, or splitting the difference, would make this a THIRD. This is
 * the right one because these selectors sit DOWNSTREAM of the plan, with no
 * fallback value to sanitize toward — it is the same guard the deleted
 * `history.ts:pageBefore` carried, in the same position. The consequence is
 * inherited too: `NaN <= 0` is false, so a `NaN` limit falls through to `slice`
 * and yields everything. That is `planHistoryFetch`'s job to prevent, in the new
 * path exactly as in the old one, and the test file pins the behaviour so it is
 * visible rather than assumed.
 */
export function recentHistoryPage(
  messages: readonly HistoryMessage[],
  limit: number,
): HistoryMessage[] {
  if (limit <= 0) return [];
  return messages.slice(Math.max(0, messages.length - limit));
}

/**
 * Up to `limit` messages OLDER than `beforeId` — never including the cursor.
 *
 * ⚠️ A CURSOR THAT IS NOT IN THE PROJECTION RETURNS `[]`, AND THAT IS THE
 * CONTRACT, not a degradation. It preserves the deleted `history.ts:pageBefore`'s
 * behaviour and its stated reason: returning newest-N instead would only feed the
 * client duplicates it already dedupes — a SILENT stop — whereas an empty page is
 * the honest "no more history" signal the client wrapper treats as a no-op.
 *
 * What changed with the journal is that the miss became rare, and the wall went
 * away entirely. The old reader had a hard 1000-message `MAX_FETCH_WINDOW`
 * because the SDK seam it read has no cursor and clamps its `limit` upstream;
 * this projection replays the whole log, so there is no window and no wall. Same
 * guard on `limit` as `recentHistoryPage` — see that docblock.
 */
export function historyPageBefore(
  messages: readonly HistoryMessage[],
  beforeId: string,
  limit: number,
): HistoryMessage[] {
  if (!beforeId || limit <= 0) return [];
  const idx = messages.findIndex((message) => message.id === beforeId);
  if (idx === -1) return [];
  return messages.slice(Math.max(0, idx - limit), idx);
}

/** What `serveHistoryRequest` hands back: one page, plus whole-projection health. */
export type ServedHistory = {
  /** The selected page — a slice, not the whole projection. */
  messages: HistoryMessage[];
  /**
   * ⚠️ COUNTED OVER THE WHOLE PROJECTION, NOT THE PAGE. Both are properties of
   * the replay that produced the page, so a page of 10 can carry a non-zero
   * count sourced from a row nowhere near it. That is the useful reading: they
   * say "this projection is not authoritative", never "this page is short by N".
   */
  unsupportedEvents: number;
  tsFallbacks: number;
};

/**
 * Project, then select — the whole history read, for both live call sites.
 *
 * The register-time snapshot and the `load_history` pager differ ONLY in which
 * plan they carry, so composing the three steps here is what keeps them from
 * drifting into two slightly different reads of the same store. Both go through
 * this function; neither is allowed to reach `projectJournalHistory` directly.
 *
 * ⚠️ `conversationId` IS THE `peerId`, and that is the entire scoping story for
 * a history read. Both write seams key the journal by peerId
 * (`nats-channel.ts`'s egress `journal.append(peerId, …)` and `ingress-dedupe.ts`
 * at the accept), and the FILE itself is already scoped to one
 * `(tenant, accountId)` tuple by `tupleStoragePaths(...).deliveryJournalPath`.
 * So there is no session key, no route resolution and no core lookup left in
 * this path — see `session-route-tenant-isolation.test.ts`, which asserts the
 * isolation property against THIS mechanism rather than the deleted one.
 *
 * ⚠️ IT DOES NOT CATCH. A store failure propagates to the caller, whose policy
 * is `logger.error` + NO `history` frame — never a successful-looking empty one.
 * The file header's READ FAILURE block has the argument; do not wrap this in a
 * `try` that returns `[]`.
 *
 * ⚠️ IT RETURNS THE PROJECTION'S DIAGNOSTIC COUNTERS, AND THE CALLER MUST NOT
 * DROP THEM. An earlier revision returned only `messages`, arguing the counters
 * were "provably 0 for every event this build can write" and that logging them
 * needed a rate limiter nobody had yet. Both halves were wrong the same way: the
 * counters exist FOR builds that are not this build, and the missing rate
 * limiter now exists in `history-serve.ts`.
 *
 * The case that killed it is a ROLLBACK. Ship #241 (which widens the event
 * union), write some rows, roll back one release: every new row is an unknown
 * kind, `isKnownJournalEvent` drops all of them, the projection is `[]`, and
 * `sendSnapshot`'s `length > 0` gate suppresses the frame. The peer opens what
 * looks like a brand-new empty conversation and NOTHING is logged anywhere —
 * the same "조용한 빈-세션 위장" the READ FAILURE block above spends 25 lines
 * forbidding, reached through the SUCCESSFUL-read door instead of the failed
 * one. A `[]` that is honest and a `[]` that means "this build cannot read your
 * history" are indistinguishable without these counts.
 *
 * So `history-serve.ts` logs on `unsupportedEvents > 0`, throttled, at `error`
 * — the level follows this file's own words about the count ("this projection
 * is not authoritative"), which is a defect, not a hiccup. **#253**
 * (retain + render unsupported, never silently drop) is still the real answer;
 * this is the signal that the day arrived. (An earlier revision cited #246 for
 * it — verified wrong: #246 is "protocol version bump + runtime wire
 * validation".)
 *
 * COST: this is a FULL REPLAY per call, quadratic in conversation length
 * (~1.45–1.51 s at 20 000 events across #286's two runs; the table in this
 * file's header is one run and tops out at 1449.6 ms). It is
 * SYNCHRONOUS. `history-serve.ts` defers both call sites for that reason, and
 * bounds them to one in flight per peer per kind — see its header.
 */
export function serveHistoryRequest(
  read: JournalReader,
  conversationId: string,
  plan: HistoryFetchPlan,
): ServedHistory {
  const { messages, unsupportedEvents, tsFallbacks } = projectJournalHistory(
    read,
    conversationId,
  );
  return {
    messages:
      plan.kind === "page"
        ? historyPageBefore(messages, plan.beforeId, plan.limit)
        : recentHistoryPage(messages, plan.limit),
    unsupportedEvents,
    tsFallbacks,
  };
}
