/**
 * v6 delivery-render — WIRE FRAME → JOURNAL EVENT (issue #239, doc §15.3).
 *
 * The plugin is the Telegram *server*: it owns a durable store and the client is
 * a pure view of it (doc §0). This module is the PURE half of that store — it
 * decides which outbound frames are durable MESSAGES and what event each one
 * becomes, and it renders the store's failure diagnostic for a log line.
 * `delivery-journal.ts` persists what this returns; #239's second and third
 * halves wire both into the egress and inbound-accept seams so that every
 * durable event is committed BEFORE its frame is published
 * (persist-before-publish, NOT-list N6, doc §16.2-2, which reverses v5 §15.8's
 * commit-after).
 *
 * ⚠️ `journalFailureDiagnostic` LIVES HERE BECAUSE BOTH SEAMS NEED IT AND IT
 * MUST BE ONE DOOR. It shipped in `nats-channel.ts` when egress was the only
 * caller; the accept seam (half 3) needs the same value-free status, and the
 * measurement in its docblock is the kind of thing that must not exist in two
 * copies free to drift. This module is the only home both seams already import
 * as a value — `nats-channel.ts` takes `DeliveryJournal` type-only on purpose so
 * it pulls in no database runtime, so `delivery-journal.ts` could not be it.
 *
 * ⚠️ `JournalEvent` IS THE CLIENT'S `DurableEvent` — ONE TYPE, NOT A MIRROR.
 * It is a plain alias of the export from
 * `packages/client/src/durable-view-reducer.ts`, imported by cross-package
 * SOURCE path. The whole v6 bet is that ONE pure reducer computes BOTH the live
 * view and history (`history == live` BY CONSTRUCTION, doc §15.4), and two event
 * shapes free to drift are two reducers — a server-side projection that can
 * invent its own ordering/supersession rule is exactly the regression this
 * redesign exists to kill (N8). An alias makes the drift unrepresentable instead
 * of merely detected.
 *
 * ⚠️ AND THE ALIAS IS WHAT MADE THE OLD GUARD OBSOLETE, NOT A REVIEWER'S
 * PREFERENCE. Until #240 the two were separate declarations held together by a
 * compile-time STRICT TYPE-IDENTITY assertion in `delivery-journal-event.test.ts`
 * (identity rather than mutual assignability, because assignability is blind to
 * an OPTIONAL field added on one side only — `revision?: number`, #241,
 * doc §16.2-4 — and that was measured, not reasoned). #240 makes the reducer a
 * dependency of the plugin's PRODUCTION source rather than of its tests only:
 * `journal-history.ts` imports `applyDurableEvent` and folds journal rows
 * through it. (Half 1 gives it no caller, so it is not yet reached at run time
 * — that is half 2's wiring, and it does not change which package the type
 * belongs to.) The cross-package import is therefore no longer a test-only
 * affordance and the second declaration had no reason to exist. With
 * one type the assertion degenerates to `Equals<T, T>` — a guard that CANNOT
 * fail — so it was deleted rather than kept. That is the same judgement already
 * recorded below about the `Object.keys` guard, and for the same reason: a guard
 * that cannot fail is worse than no guard, because a header like this one can
 * cite it as coverage.
 *
 * ⚠️ THE `Object.keys` GUARD IS ALSO GONE, AND WAS GONE FIRST. It was a runtime
 * enumeration of each kind's field names, advertised as making a divergence
 * greppable. It could not do that: `DurableEvent` is never read at runtime and
 * its type annotation is erased, so a field added to one side left it green
 * while the identity alias went red, a field added to BOTH left it green while
 * quietly falsifying its own "optional fields included" claim, and a RENAME
 * surfaced as a type error at its object literal — the exact failure mode it
 * claimed to spare the reader. `vitest run` does not typecheck, so under the
 * command that ran it, it asserted nothing the types did not already decide.
 *
 * ⚠️ AND DO NOT READ "it isn't in `JournalEvent`" AS "it is non-durable by
 * design" — that is NOT-list N3/N7, and BOUNDARY 2 of the reducer says the event
 * set WILL grow (doc §15.9 requires tool and reasoning messages to become
 * durable MESSAGES; only pure indicators stay ephemeral). It already grew once:
 * #242 half 1 made `reasoning` durable — one row per BURST rather than per
 * frame, and only when the account OPTS IN via `capabilities.reasoningDurable`
 * (default OFF, a separate switch from the default-ON live lane; see that case
 * and `resolveReasoningDurable`) — so its `null` now has TWO reasons and they
 * mean different things: "this account does not store reasoning" and "this frame
 * is a live draft, not the burst's content".
 *
 * It has since grown again: #242 half 3 made TOOL ACTIVITY durable — one row per
 * FRAME rather than per call, and with NO account opt-in, both of which are the
 * opposite of the reasoning answer and are argued at that case.
 *
 * And again, for the last time on §15.9's list: #242 half 4 made APPROVALS
 * durable — `approval_request` and `approval_resolved` become TWO append-only
 * events that the shared reducer folds into ONE card, with no account opt-in
 * (argued from the approval's own content at its case, since the tool argument
 * does not transfer — an approval carries real free text). `approval_snapshot`
 * stays `null` PERMANENTLY: it is a replay, not a message.
 *
 * ⚠️ THE HEADER USED TO SAY APPROVALS NEEDED **#241**'s REVISION MODEL FIRST.
 * That was wrong and the retraction is at the `approval_request` case, where the
 * next reader meets it. Nothing is revised: two events, one fold.
 *
 * ⚠️ AND `notice` NEVER NEEDED A CASE OF ITS OWN, so do not go looking for the
 * one §15.9 names. Notices, route apologies and the `/stop` operator-allowlist
 * notice all go out through `NatsChannel.sendText` carrying an id minted at the
 * delivery act (#238), so the `agent_message` branch below has journaled them as
 * `bubble`s since #239.
 *
 * Every `null` below carries its reason, and the ones that are merely deferred
 * say "not yet" rather than "no".
 */
import type { OutboundWsMessage } from "./channel-contract.js";
// #123: the diagnostic below is interpolated into a log line, so every value it
// renders is quoted and escaped. `log-safe.ts` is a regex and `JSON.stringify`
// and nothing else, so this module keeps the property its importers actually
// need — NO DATABASE/IO RUNTIME DEPENDENCY, which is why `nats-channel.ts` can
// take `DeliveryJournal` type-only and still call in here for values.
import { logSafe } from "./log-safe.js";
// TYPE-ONLY, and the target has no imports AT ALL (its DEPENDENCY CONTRACT
// forbids them, `node:` builtins included), so this line adds no runtime
// dependency in either sense — it is erased under `verbatimModuleSyntax`, and
// even a value import of that module would pull in nothing.
import type { DurableEvent } from "../../client/src/durable-view-reducer.js";

/**
 * The ordered event stream the plugin journals: THE SAME TYPE the client's
 * reducer consumes, not a copy of it. See the file header for why this is an
 * alias rather than a second declaration guarded by an assertion.
 */
export type JournalEvent = DurableEvent;

/**
 * Upper bound on a CLIENT-supplied user-message id. See
 * `journalEventForInboundUser`; deliberately NOT part of `isUsableMessageId`.
 *
 * Same value and same reason as `ingress-dedupe.ts`'s
 * `MAX_INGRESS_DEDUPE_ID_LENGTH`, which is this plugin's established handling of
 * `user_message.id`.
 *
 * Exported because `delivery-journal.ts`'s `append` enforces the SAME bound at
 * the mechanism — two doors, and they must not drift to two numbers.
 */
export const MAX_INBOUND_USER_ID_LENGTH = 128;

/**
 * Is this a usable durable message id — a NON-EMPTY STRING?
 *
 * ONE definition of "id-less", shared by the `agent_message` branch of the
 * mapper, by `isIdlessDurableFrame`, and by `journalEventForInboundUser`, so no
 * two of them can disagree about what an id-less message is.
 *
 * ⚠️ `typeof`, NOT just `!== undefined`. The wire does not validate this field —
 * `InboundWsMessage` types it `id?: string`, and a JSON client sends `null` for
 * "absent" — so a non-string genuinely arrives here. A truthiness- or
 * `undefined`-only check lets `null` reach `.length` and throw a bare
 * `TypeError: Cannot read properties of null (reading 'length')`, which defeats
 * the entire reason `journalEventForInboundUser` is a function rather than an
 * object literal: a NAMED failure. `["a"]` and `{ length: 3 }` likewise used to
 * pass and then fail much later, at SQLite bind time.
 *
 * ⚠️ THE ≤128 LENGTH BOUND IS NOT HERE, AND THAT ASYMMETRY IS DELIBERATE. It
 * belongs to the inbound seam only, because the two seams face different
 * threats: a user id is client-supplied and hostile input, while an agent id is
 * PLUGIN-MINTED (`message-adapter.ts`'s `nextMessageId()`, `webchannel-<ms>-<6
 * chars>` — 31 chars, verified in-tree). Applying the bound to agent ids would
 * classify an over-long minted id as id-less, and an id-less durable frame is
 * dropped from the journal — silently discarding DELIVERED text, which is N10.
 * Refusing to store is the safe answer for input we did not create; it is the
 * unsafe answer for output we already sent.
 *
 * ⚠️ AND SINCE #242 half 3 THERE IS AN EXCEPTION TO "PLUGIN-MINTED" — NAMED HERE
 * SO THE PARAGRAPH ABOVE IS NOT READ AS COVERING EVERY CALLER. The
 * `tool_activity` branch calls this predicate on a TOOL id, and that id is NOT
 * ours: `inbound.ts`'s `createCall` prefers the upstream `toolCallId`/`itemId`
 * straight off the agent event stream, so any non-empty string of any length can
 * arrive here. The reasoning above still decides the ANSWER — the frame has
 * already been delivered to the client under that id, so refusing to store it is
 * the N8/N10 divergence, not a defence — but the premise it rests on is
 * narrower than it reads. The unbounded SIZE that follows is **#321**; the fix
 * belongs at the producer or the wire, not in this predicate. DO NOT ADD A BOUND
 * HERE.
 *
 * `""` IS id-less HERE and is NOT id-less for `progress` — the two wire sites
 * genuinely differ and the reducer's BOUNDARY 1 pins why. The client's
 * `agent_message` handler branches on `if (id)` (TRUTHY), so `""` falls into its
 * mint branch and gets a fresh local `a-<n>`; its `progress` handler keys on
 * `id ?? ""` (NULLISH), so `""` survives there as a real id. Writing
 * `answerId: frame.id ?? ""` for the DURABLE frame — the natural thing, because
 * it mirrors the progress site verbatim — would collapse N id-less finals into
 * ONE durable row while live shows N bubbles: an N8 live≠history divergence
 * landing right here.
 */
function isUsableMessageId(id: unknown): id is string {
  return typeof id === "string" && id.length > 0;
}

/**
 * Is this an `agent_message` with no usable id?
 *
 * Post-#238 the answer is always NO: all four `sendText` call sites that used to
 * omit an id now mint one at the delivery act (the reducer's BOUNDARY 1
 * enumerates them, in the past tense). So an id-less durable frame reaching the
 * journal is a REGRESSION, not a case to handle — which is why this exists as an
 * OBSERVABLE predicate rather than as a silent `null`. Half 2 logs it at `error`.
 *
 * ⚠️ DO NOT "handle" it by minting a server-side id here and keeping the text.
 * N10 says never drop text, and that instinct is right in general — but by the
 * time a frame reaches this mapper it has ALREADY LEFT for the client, which
 * mints its own local `a-<n>` for it. A journal row under a DIFFERENT id is
 * precisely the live≠history divergence (N8) this store exists to kill. The real
 * repair is the plugin minting the id BEFORE the frame goes out, so client and
 * journal agree by construction — doc §16.2-1, issue **#243**. Not built here.
 */
export function isIdlessDurableFrame(frame: OutboundWsMessage): boolean {
  return frame.type === "agent_message" && !isUsableMessageId(frame.id);
}

/**
 * The outbound frame types that CARRY a per-conversation `seq` on the wire (#244
 * half A) — exactly the durable frames `journalEventForOutbound` maps to a
 * non-null event, each of which occupies a seq and declares `seq?` in
 * `channel-contract.ts`. `sendToPeer` stamps `seq` on a frame iff this predicate
 * accepts it (and the journal actually allocated one).
 *
 * ⚠️ THIS SET AND `journalEventForOutbound`'s NON-NULL SET MUST STAY IDENTICAL,
 * AND THE LINK IS ENFORCED BY TEST, NOT BY THE COMPILER. A durable type added to
 * the mapper but not here would allocate a seq that never rides the wire — the
 * exact phantom gap #244 exists to prevent, and nothing here would catch it.
 * `delivery-journal-event.test.ts`'s drift guard drives one canonical frame of
 * EVERY `OutboundWsMessage` type (an exhaustive `Record`, so a NEW variant is a
 * compile error there) through both this predicate and the mapper and asserts
 * they agree. Keep the two lists in step.
 *
 * ⚠️ THE INBOUND USER OPENER ALSO CONSUMES A SEQ (`appendInboundUser`) BUT IS NOT
 * AN OUTBOUND FRAME — its seq rides the `ack.committed` echo, not a durable frame
 * (doc §16.2-6). So "every seq the client sees" is this set's frames PLUS that
 * echo, which is what makes the client's stream contiguous.
 */
export type SeqBearingFrame = Extract<
  OutboundWsMessage,
  {
    type:
      | "agent_message"
      | "progress"
      | "turn_snapshot"
      | "reasoning"
      | "tool_activity"
      | "approval_request"
      | "approval_resolved";
  }
>;

export function isSeqBearingFrame(frame: OutboundWsMessage): frame is SeqBearingFrame {
  switch (frame.type) {
    case "agent_message":
    case "progress":
    case "turn_snapshot":
    case "reasoning":
    case "tool_activity":
    case "approval_request":
    case "approval_resolved":
      return true;
    default:
      return false;
  }
}

/**
 * Per-account policy this mapper needs. Resolved ONCE at account start and
 * carried on the channel — never read from config per frame.
 */
export type JournalPolicy = {
  /**
   * #242 half 1: is reasoning content DURABLE for this account
   * (`capabilities.reasoningDurable`, `account-config.ts`)? DEFAULT OFF.
   *
   * Separate from `capabilities.reasoning`, which governs the LIVE LANE and
   * keeps its #113 default-ON. `resolveReasoningDurable`'s docblock carries the
   * full argument; the one line to remember is that #113's default-ON was a
   * decision to render a volatile live lane, and it does not inherit to a
   * decision to permanently record plaintext to disk.
   */
  reasoningDurable?: boolean;
};

/**
 * Map one outbound frame to the event the journal must persist, or `null` when
 * the frame is not (or not yet) a durable message.
 *
 * The `switch` is EXHAUSTIVE by construction: the `default` assigns `frame` to
 * `never`, so a new `OutboundWsMessage` variant is a COMPILE ERROR here rather
 * than a silently unjournaled message.
 *
 * ⚠️ `policy` IS OPTIONAL AND ITS OMISSION IS THE SAFE DIRECTION, NOT AN
 * OVERSIGHT. A caller that forgets it journals LESS, never more: every field is
 * a per-account permission to store something, so absent reads as "not
 * permitted". Making it required would have been compiler-checked but would
 * force every existing call site to restate a default it does not care about,
 * and the wiring is proven where it actually matters — a channel-level test
 * drives the REAL `NatsChannel` with the flag on and off and counts rows.
 */
export function journalEventForOutbound(
  frame: OutboundWsMessage,
  policy?: JournalPolicy,
): JournalEvent | null {
  switch (frame.type) {
    case "agent_message":
      // The durable agent bubble. `""` and absent are both refused — see
      // `isUsableMessageId` and `isIdlessDurableFrame`.
      return isUsableMessageId(frame.id)
        ? {
            kind: "bubble",
            answerId: frame.id,
            text: frame.text,
            ...optionalTurnId(frame.turnId),
          }
        : null;
    case "progress":
      // The lane's SLOT CLAIM. `frame.id` is `string` on the wire and is
      // journaled VERBATIM — including `""`, which the client keeps as a real
      // id (`id ?? ""`), so a placement under `""` is faithful.
      //
      // The text is deliberately NOT journaled: doc §15.9 classifies the rolling
      // "Working…" draft as an INDICATOR, not a message. The durable text is
      // authored later by a `bubble` or a `seal`.
      //
      // ⚠️ "LATER" IS NOT GUARANTEED, and #240's projector must not assume it.
      // A lane that gets `progress` and then neither a `bubble` nor a
      // `seal.answers` entry — an aborted turn, a connection dropped before the
      // drain — leaves a placement whose text is never authored. Live renders
      // NOTHING there (the client's `dropSpentDrafts` removes the spent draft at
      // turn end), but `applyPlacement` appends an empty agent bubble and
      // nothing in the journal removes it, because the `draftOnly` flag that
      // drives the drop is client-local and deliberately never journaled. So a
      // naive replay shows a phantom empty bubble live never showed — N8, by
      // omission. Journaling the placement is still right (it is what carries
      // the ORDER), and the repair is derivable from the journal alone: a
      // placement whose answerId never reappears.
      //
      // ⚠️ THAT SLICE HAS SHIPPED AND DID NOT DO IT. This comment used to say
      // the fold "belongs to the slice that serves history"; #240 half 2 IS
      // that slice, and it wired the projection up without the repair — so the
      // phantom bubble is reachable in a real history read today, not a
      // prediction. Ownership stays with **#251** (what should render for such
      // a lane) and **#264** (deriving it from events alone). Do not write the
      // fold into the projection: a supersession rule invented server-side is
      // N8, which is the whole thing this store exists to prevent.
      return {
        kind: "placement",
        answerId: frame.id,
        ...optionalTurnId(frame.turnId),
      };
    case "turn_snapshot":
      // Turn-end reconciliation. `answers` and `remove` are COPIED rather than
      // aliased so the event is a self-contained value the caller cannot mutate
      // out from under the journal.
      return {
        kind: "seal",
        turnId: frame.turnId,
        answers: frame.answers.map((answer) => ({
          id: answer.id,
          text: answer.text,
        })),
        remove: [...frame.remove],
      };
    case "reasoning":
      // ⚠️ OUTER GATE FIRST: IS REASONING DURABLE FOR THIS ACCOUNT AT ALL?
      // `capabilities.reasoningDurable` (`account-config.ts`'s
      // `resolveReasoningDurable`) DEFAULTS OFF, so this returns `null` for
      // every reasoning frame unless an operator opted in.
      //
      // ⚠️ THE GATE IS HERE, AT THE JOURNALING SEAM, AND NOT ON THE LANE — that
      // placement is the decision, not an implementation detail. Closing the
      // lane instead would regress #113 (the live reasoning stream the client
      // renders) to buy a storage property, i.e. pay for it in a completely
      // different currency. With the gate here the lane is untouched: every live
      // `reasoning` frame still goes out, INCLUDING the `final: true` close
      // frame, and only the row is withheld. The channel-level tests assert
      // exactly that pairing.
      //
      // ⚠️ AND IT IS CHECKED BEFORE THE `final` TEST BELOW, DELIBERATELY. The
      // account permission is the OUTER question ("may we store reasoning?");
      // `final` is the inner one ("is this the frame worth storing?"). Reading
      // them in the other order works today and would still be correct, but it
      // reads as though `final` were the gate and the permission a refinement of
      // it, which is backwards and is how the two get merged again later.
      if (policy?.reasoningDurable !== true) return null;
      // DURABLE, but ONLY the frame that CLOSES a burst (#242 half 1, §15.9).
      //
      // ⚠️ `final` IS NOT A NICETY — WITHOUT IT THIS CASE IS O(n²) BYTES PER
      // BURST. `message-adapter.ts`'s `createReasoningDraftController` calls
      // `sendReasoning` on EVERY cumulative token update, unthrottled, and each
      // frame carries the whole text so far. Journaling those would write one
      // row per token, each holding the full burst, and would multiply row count
      // by orders of magnitude into an already quadratic replay (#286). The
      // controller therefore emits ONE extra frame per burst carrying
      // `final: true`, and only that one is recorded here.
      //
      // A frame WITHOUT the flag is a live cumulative draft and is deliberately
      // not durable — the same classification §15.9 gives the rolling `progress`
      // draft, and for the same reason: the durable content is authored once, at
      // close.
      //
      // ⚠️ THE ADMISSION RULE TRACKS THE CLIENT'S, AND IS VERY SLIGHTLY STRICTER.
      // The live handler is
      // `if (!msg.id || !msg.turnId || typeof msg.text !== "string" || msg.text.length === 0) return;`
      // (`nats-client-wrapper.ts`'s `case "reasoning"`), i.e. non-empty id,
      // non-empty turnId, non-empty string text. The reason to track it is that
      // both margins are expensive: journaling a frame the client REFUSES puts a
      // message in history that live never rendered (N8, gaining), and refusing
      // one the client ACCEPTS loses delivered content (N8, losing).
      //
      // The one difference, stated rather than glossed: the client's `!msg.id`
      // is a TRUTHINESS test, so it would accept a truthy NON-STRING id (`7`,
      // `["a"]`), while `isUsableMessageId` requires `typeof === "string"`. That
      // is deliberate — nothing runtime-validates an OUTBOUND frame (#246
      // half A decodes the INBOUND doors only, and these frames are ours), and a
      // non-string id fails much later at SQLite bind time — and it is
      // unreachable in practice, since the only producer of these frames is
      // `message-adapter.ts`'s controller passing a minted string. So "the same
      // rule" is true for every value either side can actually see; it is not
      // true field-for-field, and an earlier revision of this comment said it
      // was.
      //
      // `turnId` is required here where `bubble`/`placement` treat it as
      // optional, because the wire genuinely differs: `reasoning.turnId` is
      // `string`, `progress.turnId` is `string | undefined`.
      //
      // The text check is written out rather than routed through
      // `isUsableMessageId`: that predicate is the ONE definition of "id-less"
      // and its docblock is entirely about identity, so borrowing it for a body
      // field would make a later change to either one silently change the other.
      return frame.final === true &&
        isUsableMessageId(frame.id) &&
        isUsableMessageId(frame.turnId) &&
        typeof frame.text === "string" &&
        frame.text.length > 0
        ? {
            kind: "reasoning",
            id: frame.id,
            turnId: frame.turnId,
            text: frame.text,
          }
        : null;
    case "tool_activity":
      // DURABLE since #242 half 3 (§15.9) — and EVERY frame is journaled, not
      // just a closing one.
      //
      // ⚠️ THAT IS THE OPPOSITE OF `reasoning` ABOVE, AND IT IS FORCED BY THE
      // FRAME SHAPE — MEASURED on `inbound.ts`'s `createAgentToolActivitySink`,
      // not assumed from the neighbouring case. One tool call on the `tool`
      // stream emits:
      //
      //   {turnId, id, name:"read_file", phase:"start", argKeys:["path","limit"]}
      //   {turnId, id, phase:"update"}
      //   {turnId, id, phase:"end", status:"completed"}
      //
      // The frames are SPARSE DELTAS that refine one call: `argKeys` is emitted
      // only on a NON-terminal frame and `status` only on a terminal one, so the
      // CLOSING frame carries neither `name` nor `argKeys`. A `final`-style flag
      // would therefore journal a PARTIAL — history would show a nameless,
      // argKey-less call where live showed `read_file(path, limit)`, which is
      // N8 live≠history.
      //
      // ⚠️ AND THE MERGE IS NOT DONE HERE. The alternative to a closing frame is
      // storing the merged record, which would need a per-`(turnId,id)`
      // accumulator at this seam and would make the stored row a projection the
      // PLUGIN computed — a second implementation of a merge the live client
      // also performs, free to drift. That is precisely what this module's
      // header refuses (the `JournalEvent` alias exists so ONE reducer computes
      // both views), so the frame is stored verbatim and
      // `durable-view-reducer.ts`'s `applyTool` stays the only merge in the
      // system. Cost: one row per frame rather than per call. Each row is SMALL
      // IN PRACTICE — not bounded: nothing here, at `sendToolActivity`, or at
      // the producer caps `argKeys`'s key COUNT or key LENGTH, so "bounded size"
      // would be an assumption dressed as a property (**#321**). Still
      // far from reasoning's O(n²) BYTES, where every frame carried the whole
      // cumulative text; and it feeds #286's quadratic replay and #311's
      // row-bounded pages either way. ⚠️ DO NOT ADD A CAP HERE — that is a
      // producer/wire decision, not this mapper's.
      //
      // ⚠️ NO `policy` GATE, UNLIKE `reasoning` — deliberate, and argued rather
      // than inherited. `reasoningDurable` guards the model's chain-of-thought
      // PLAINTEXT; a tool row has none. The two fields that carry that argument
      // are ENFORCED at the producer, and were re-verified against it:
      //   - `argKeys` is `Object.keys(args)` (`inbound.ts`) — key NAMES only,
      //     never values. This is the load-bearing privacy clause;
      //   - `summary` is count-only: `readSafePatchSummary` either derives it
      //     from array LENGTHS or requires ≤96 chars matching an anchored count
      //     grammar, and its only callers are the `patch` paths.
      //
      // ⚠️ AND TWO CLAIMS THAT USED TO SIT HERE ARE FALSE — MEASURED, so do not
      // restore them as reassurance. This comment asserted "`phase` comes from a
      // five-member set, `status` from enumerated verdicts":
      //   - `status` IS A PASS-THROUGH. `explicitTerminalToolStatus` returns
      //     `readEventString(data, "status")` verbatim for ANY non-empty string,
      //     mapping only `"error"` → `"failed"`;
      //   - `phase` is checked against `TOOL_EVENT_PHASES` on the `tool` and
      //     `item` streams ONLY. The `command_output`/`patch` branch gates on
      //     `isTerminalToolActivity` — which can pass on `status` alone — and
      //     then forwards `phase` UNCHECKED.
      // Neither weakens the privacy argument (both are verdict labels, not
      // content), which is why the gate stays absent; but the argument now rests
      // on the two fields above rather than on an enumeration nothing enforces.
      //
      // The live lane already gates storage for free: the producer is
      // constructed only in `progress`/`partial` streaming modes, so a
      // `block`/`off` account emits no such frame and journals no row.
      //
      // The admission rule tracks the client's `case "tool_activity"` exactly —
      // non-empty string `id` and `turnId`, and `argKeys` filtered to strings —
      // so nothing is journaled that the client refuses (N8, gaining) and
      // nothing the client accepts is dropped (N10).
      return isUsableMessageId(frame.id) && isUsableMessageId(frame.turnId)
        ? {
            kind: "tool",
            id: frame.id,
            turnId: frame.turnId,
            // Each optional field is an ABSENT KEY when the frame omitted it,
            // never an explicit `undefined`: `applyTool` merges by spread, so a
            // present-and-`undefined` `name` would ERASE the one the `start`
            // frame carried.
            ...(typeof frame.name === "string" ? { name: frame.name } : {}),
            ...(typeof frame.phase === "string" ? { phase: frame.phase } : {}),
            ...(typeof frame.status === "string" ? { status: frame.status } : {}),
            ...(typeof frame.summary === "string" ? { summary: frame.summary } : {}),
            ...(Array.isArray(frame.argKeys)
              ? {
                  argKeys: frame.argKeys.filter(
                    (k): k is string => typeof k === "string",
                  ),
                }
              : {}),
          }
        : null;
    case "approval_request":
      // DURABLE since #242 half 4 (§15.9) — the approval CARD's content.
      //
      // ⚠️ THE "IT NEEDS #241 FIRST" ARGUMENT THAT STOOD HERE FOR THREE SLICES
      // IS RETRACTED, AND IS RECORDED RATHER THAN DELETED BECAUSE IT IS THE
      // OBVIOUS THING TO RE-DERIVE. It read: every durable message before this
      // one is one-directional, the plugin delivers content and later REVISES
      // it; an approval is BIDIRECTIONAL, so the resolution changes this
      // message's content by a USER ACTION rather than by a delivery revision,
      // which is **#241**'s typed edit/revision territory. The premise is
      // correct — this really is the first message a user action changes — and
      // the conclusion does not follow, because nothing here is revised. The
      // request and the resolution are TWO APPEND-ONLY EVENTS and
      // `durable-view-reducer.ts` folds them into ONE message, which is exactly
      // the relationship `seal` already has to `bubble`. #241 was never a
      // prerequisite.
      //
      // ⚠️ NO `policy` GATE, UNLIKE `reasoning`, AND THE TOOL ARGUMENT DOES NOT
      // TRANSFER — this one is argued from the approval's own content, because
      // an approval genuinely carries free text where a tool row carries none.
      // MEASURED at the producer (`approvals.ts`'s `buildApprovalRequestPayload`):
      // `title` and `description` come straight off the SDK's
      // `PendingApprovalView`, and `prompt` is composed as
      // `` `${view.title}: ${view.commandPreview || view.commandText}` `` for an
      // exec approval and `` `${view.title}: ${view.toolName || view.pluginId}` ``
      // for a plugin one. So the free text this row adds is THE COMMAND THE
      // AGENT ASKED TO RUN, plus the SDK's own title/description for it.
      //
      // Three reasons that is not the class `reasoningDurable` exists to gate:
      //  - §15.9 names the class precisely, and it is a different one: reasoning
      //    "routinely quotes tool output, file contents and user prompts" — it is
      //    content the transcript does not otherwise hold. An approval card holds
      //    the command, and the journal ALREADY stores, with no opt-in, the user
      //    prompt that asked for it (`user`) and the agent's prose about it
      //    (`bubble`/`seal`);
      //  - the card is a MESSAGE THE USER WAS SHOWN AND ACTED ON. It cannot be
      //    withheld from the client — you cannot approve what you cannot see — so
      //    unlike a chain of thought there is no disclosure decision left to make
      //    at this seam, only a retention one;
      //  - and the tie-breaker runs the OTHER WAY here. The reasoning gate chose
      //    the cheap-to-reverse direction because absence cost only an
      //    explanation. An approval's absence costs the record of a USER'S
      //    CONSENT: a reloaded transcript would show the agent running a command
      //    with nothing saying anyone authorised it. Not storing is the expensive
      //    direction, not the cheap one.
      //
      // ⚠️ STATE THE COST HONESTLY, BECAUSE IT IS REAL AND IT IS NEW. An exec
      // approval row puts a command line WITH ITS ARGUMENT VALUES on disk, where
      // half 3's `tool` row deliberately carries argument KEY NAMES only. This
      // slice therefore widens what reaches disk relative to half 3, and #299
      // (retention/pruning at the store) is still unimplemented. That is
      // accepted, not overlooked, and it is the argument above that pays for it —
      // not silence.
      //
      // ⚠️ THE `kind` FIELD IS RENAMED TO `approvalKind` ON THE WAY IN. The wire
      // payload calls it `kind` (`"exec" | "plugin"`) and `JournalEvent`'s own
      // discriminant is also `kind`; a verbatim copy would collide the two
      // meanings on one key and make the event union undiscriminable. Spreading
      // `...request` here would do exactly that silently, which is why every
      // field is written out.
      //
      // The admission rule is `isUsableMessageId` on the id alone — the same
      // predicate every other durable branch uses — because everything else on
      // the payload is either enumerated (`kind`, `options[].decision`) or
      // free text the client renders as-is with no non-empty requirement (the
      // live `case "approval_request"` defaults each of them, `title: msg.title ?? ""`).
      // Refusing a blank title here would drop a card live rendered (N10).
      return isUsableMessageId(frame.id)
        ? {
            kind: "approval",
            id: frame.id,
            approvalKind: frame.kind,
            title: frame.title,
            ...(frame.description !== undefined
              ? { description: frame.description }
              : {}),
            prompt: frame.prompt,
            // COPIED, not aliased, so the event is a self-contained value the
            // caller cannot mutate out from under the journal — the same rule
            // the `seal` branch above applies to `answers`/`remove`.
            options: frame.options.map((option) => ({
              decision: option.decision,
              label: option.label,
              style: option.style,
            })),
            ...(frame.expiresAtMs !== undefined
              ? { expiresAtMs: frame.expiresAtMs }
              : {}),
          }
        : null;
    case "approval_resolved":
      // DURABLE since #242 half 4 — the card's STATE CHANGE, as its own
      // append-only row. `applyApprovalResolution` folds it onto the `approval`
      // row that precedes it in this same stream.
      //
      // ⚠️ EXPIRY IS NOT A SEPARATE EVENT AND MUST NEVER BECOME ONE. A card that
      // times out server-side arrives here as an ordinary resolution —
      // `approvals.ts`'s `buildExpiredResult` returns
      // `{kind:"update", payload:{decision:"deny"}}`, which reaches
      // `updateEntry` and publishes a real `approval_resolved{decision:"deny"}`.
      // What is left over is a card whose `expiresAtMs` passed with no frame at
      // all, and THAT is a wall-clock comparison the reducer's PURITY CONTRACT
      // forbids: an expiry folded at replay time would make one journal project
      // differently on two reads. Expiredness is derived at RENDER, from the
      // `expiresAtMs` this row already carries.
      return isUsableMessageId(frame.id)
        ? { kind: "approvalResolution", id: frame.id, decision: frame.decision }
        : null;
    case "approval_snapshot":
      // NEVER durable — and this one is NOT deferred work, unlike the two above
      // ever were.
      //
      // It is a server→client REPLAY of approval state the store already holds,
      // exactly like the `history` case below: journaling it would write the
      // store's own output back into the store, duplicating rows the
      // `approval`/`approvalResolution` events already carry. Do not schedule it.
      //
      // ⚠️ "THE STORE ALREADY HOLDS IT" WAS NOT TRUE WHEN THIS WAS WRITTEN, and
      // the gap it left is worth remembering rather than quietly closing. Half 4
      // journaled approvals inside `sendToPeer`, below its refusals, so a card
      // the transport refused got NO row while the pending map kept it and this
      // frame re-delivered it live — the snapshot was then the SOLE carrier of a
      // card the user saw and acted on, and its resolution landed as an orphan
      // (#341, N8/N3). #341 made the store hold it: the row is written at the
      // delivery act above the refusals, or failing that at resolution time (see
      // `approvals.ts`'s two legs). The verdict here never changed; only its
      // premise became true.
      //
      // ⚠️ AND THE TWO STORES ARE NOW DELIBERATELY ASYMMETRIC IN ONE DIRECTION —
      // an N8 reader should meet this here rather than derive it. This frame
      // replays only what is STILL PENDING (plus recently-resolved outcomes); the
      // journal keeps the card forever. So a card created while the peer was
      // disconnected, never pushed, and then EXPIRED before the peer returned is
      // absent from this frame and present in history, carrying the
      // denial-equivalent verdict `buildExpiredResult` produced — a decision the
      // user never saw live. That is intended Telegram-server behaviour, not a
      // leak: the server created the service message and recorded what became of
      // it; the device simply missed the window. It is history GAINING a row live
      // never showed, so it is worth stating that it was accepted knowingly.
      //
      // ⚠️ IT IS ALSO WHAT MAKES A REPLAYED CARD SAFE, so do not read "not
      // durable" as "not load-bearing". `nats-register.ts` sends this frame on
      // EVERY successful register, unconditionally; the client renders a card
      // that came from `history` non-interactive and lets ONLY this frame arm
      // one again. It is the authority for "what is still open", which is
      // precisely why it must not also be a stored message.
      return null;
    case "turn_settled":
      // Control frame. It carries no content and the client renders no bubble
      // for it; the turn's durable content is the `seal` that precedes it.
      return null;
    case "typing":
      // Pure indicator (§15.9). It is not a message live either, so omitting it
      // creates no live≠history gap.
      return null;
    case "history":
      // Server→client REPLAY. Journaling it would journal the store's own
      // output back into the store.
      return null;
    case "difference":
      // #244 half B — server→client REPLAY of events the store already holds
      // (`get_difference` catch-up). Journaling it would write the store's own
      // output back in, exactly like `history` above. NOT seq-bearing either —
      // `isSeqBearingFrame` rejects it, and the drift test pins the two agreeing.
      return null;
    case "user_committed":
      // #245 Part B — the immediate multi-device BROADCAST of a user message the
      // store ALREADY committed (`appendInboundUser` minted its id/seq before this
      // frame was built). Journaling it would write the store's own output back in,
      // duplicating the `user` row `appendInboundUser` wrote — exactly the
      // `difference`/`history` shape above. NOT seq-bearing either: its `seq` is
      // set at construction from `appendInboundUser`'s return, not stamped by
      // `sendToPeer`, so `isSeqBearingFrame` rejects it and the drift test pins
      // the two agreeing.
      return null;
    case "commands":
      // Catalog data, not a transcript message.
      return null;
    case "ack":
      // Transport control (receipt bookkeeping), not a message.
      return null;
    case "inbound_rejected":
      // Transport control (backpressure), not a message. The user message it
      // refers to was never accepted, so nothing durable exists to record.
      return null;
    default: {
      // Exhaustiveness gate: a new `OutboundWsMessage` variant fails to compile
      // here instead of being silently dropped from the durable stream.
      const _never: never = frame;
      return _never;
    }
  }
}

/**
 * The inbound user message's journal event, from a CLIENT-supplied id.
 *
 * Exported alongside the outbound mapper so half 3 has nothing to invent at the
 * accept seam: doc §15.7 makes the plugin the ONLY SSOT for user messages, so
 * this event is the durable record of the accept, written before the ack.
 *
 * ⚠️ NO LONGER ON THE ACCEPT PATH AS OF #243 half 2a. The accept seam now mints
 * the durable id SERVER-side inside the store's transaction
 * (`delivery-journal.ts`'s `appendInboundUser`, tied to the seq per doc §16.2-1),
 * so it builds its `user` event there and does not route through this mapper. The
 * client-supplied-id VALIDATION below therefore guards no live caller today — it
 * is retained for any hand-built `user` event and for the tests that pin the
 * contract, and because `append` enforces the same bound at the mechanism. Item 4
 * of the slice: the accept seam's id check moved from "bound hostile input" to
 * "trust our own mint".
 *
 * ⚠️ THROWS on an id that is absent, empty, not a string, or longer than
 * `MAX_INBOUND_USER_ID_LENGTH`. That is the whole point of it existing as a
 * function rather than an object literal at the call site.
 *
 * `InboundWsMessage.user_message.id` is OPTIONAL and CLIENT-supplied, and the
 * wire validates NOTHING about it. This plugin's established handling of that
 * exact field is `ingress-dedupe.ts`'s `ingressDedupeKey`: string, non-empty,
 * ≤128 chars, and anything else is treated as id-less rather than persisted.
 * Its docblock gives the reason — a hostile peer can send a non-string or a
 * ~1 MB string, and a recorded id is persisted, so bounding it bounds the
 * storage-amplification surface. This function adopts that whole rule, not part
 * of it: an unbounded id here is amplified THREE times per row (the `payload`
 * copy, the indexed `message_id` copy, and the `journal_user_once` entry), so
 * fifty 1 MB ids are ~150 MB of journal.
 *
 * Each refusal is a real reproduced failure, not a hypothetical:
 *  - `""` — two genuinely DIFFERENT user messages both under `""` collide on
 *    `journal_user_once`, the second append returns `inserted: false`, and that
 *    is exactly the value this store's contract tells the accept seam to read as
 *    an ordinary non-destructive retry (§15.8). The second message's TEXT is
 *    then gone from the only SSOT user messages have (§15.7) — silent
 *    user-content loss, and history shows one bubble where live showed two (N8);
 *  - `null` — what a JSON client sends for "absent"; it used to reach `.length`
 *    and throw an unnamed `TypeError`;
 *  - `["a"]` / `{ length: 3 }` — used to pass and fail later at SQLite bind time;
 *  - a 1 MB id — see the amplification above.
 *
 * It throws rather than returning `null` because this runs BEFORE accept: a
 * loud failure in half 3's accept-seam tests
 * (`ingress-dedupe-delivery-journal.test.ts`) is the outcome we want, whereas a
 * `null` would invite the accept path to shrug and continue unjournaled.
 * `isUsableMessageId` is the same predicate the durable-frame branch uses, so
 * the two cannot drift on what "id-less" means; the LENGTH bound is added only
 * here, and that docblock explains why it must not be shared.
 */
export function journalEventForInboundUser(input: {
  id: string;
  text: string;
  turnId?: string;
}): JournalEvent {
  if (!isUsableMessageId(input.id)) {
    throw new Error(
      "webchannel: journalEventForInboundUser requires a non-empty string id " +
        "— a user message must be journaled under its own identity, and an " +
        "empty or non-string id collapses distinct messages onto one row " +
        `(doc §15.7); received ${typeof input.id}`,
    );
  }
  if (input.id.length > MAX_INBOUND_USER_ID_LENGTH) {
    throw new Error(
      "webchannel: journalEventForInboundUser requires an id of at most " +
        `${MAX_INBOUND_USER_ID_LENGTH} characters (received ${input.id.length}); ` +
        "an unbounded client id is amplified three times per journaled row " +
        "(see ingress-dedupe.ts's ingressDedupeKey, the same bound and reason)",
    );
  }
  return {
    kind: "user",
    id: input.id,
    text: input.text,
    ...optionalTurnId(input.turnId),
  };
}

/**
 * Omit `turnId` entirely when the wire omitted it, rather than writing an
 * explicit `undefined`. `JSON.stringify` drops an `undefined` value, so an
 * always-present key would make the in-memory event and the one read back out of
 * the journal structurally different objects for no reason.
 */
function optionalTurnId(turnId: string | undefined): { turnId?: string } {
  return turnId === undefined ? {} : { turnId };
}

/**
 * The value-free part of a journal-write failure, for the warning line.
 *
 * ⚠️ `error.message` IS DELIBERATELY EXCLUDED, AND THE EARLIER "it can carry the
 * bound SQL parameters" JUSTIFICATION WAS WRONG — MEASURED, not assumed. Seven
 * failure shapes were driven against a real `openDeliveryJournal`/`node:sqlite`,
 * every one journaling a distinctive marker string as the bubble text:
 *
 *   append after close()       message "database is not open"          code ERR_INVALID_STATE (no errcode)
 *   table dropped underneath   message "no such table: journal_event"  code ERR_SQLITE_ERROR errcode 1    errstr "SQL logic error"
 *   sidecar holds BEGIN EXCL.  message "database is locked"            code ERR_SQLITE_ERROR errcode 5    errstr "database is locked"
 *   raw UNIQUE/PK conflict     message "UNIQUE constraint failed: t.a" code ERR_SQLITE_ERROR errcode 1555 errstr "constraint failed"
 *   NOT NULL violation         message "NOT NULL constraint failed: t.a"                     errcode 1299
 *   CHECK violation            message "CHECK constraint failed: n < 5"                      errcode 275
 *   read-only file / corrupted main file — DID NOT THROW at all (WAL: the write
 *   lands in the already-open `-wal` sidecar)
 *
 * The marker never appeared in `message`, in any own property, or in the stack.
 * So the message is not a plaintext leak. It is still excluded because it is
 * FREE-FORM text with no contract — the CHECK case shows it echoing schema
 * source verbatim — whereas `code`/`errcode`/`errstr` are enumerated constants.
 * Those three are also what actually answers the operator's question, which was
 * the other half of the objection to swallowing everything. Among the shapes
 * ACTUALLY MEASURED above, `ERR_INVALID_STATE` (the handle was closed under us),
 * `ERR_SQLITE_ERROR`+errcode 1 (the schema is gone) and `ERR_SQLITE_ERROR`+errcode
 * 5 (another writer holds the lock) are three different incidents with three
 * different fixes, and the status is the only field that separates them.
 *
 * ⚠️ THE PROPERTY READS ARE GUARDED, and both callers depend on that. Each runs
 * this inside the `catch` that isolates the journal from its seam — a thrown
 * object with a throwing getter (or a Proxy trap) would escape that catch and
 * then the seam itself: at egress that is `sendToPeer` throwing, which
 * `message-adapter.ts` turns into a permanently lost message; at the accept seam
 * it is `onFlush` rejecting, which the bounded debouncer's `pump` swallows with
 * no log at all. "Nothing in the tree throws from a getter today" is the same
 * argument that was rejected for the mapper, so it is rejected here.
 */
export function journalFailureDiagnostic(error: unknown): string {
  if (typeof error !== "object" || error === null) {
    // Not an Error at all (a thrown string could BE message text) — report only
    // that fact.
    return `code=${logSafe(`<thrown-${typeof error}>`)}`;
  }
  let code: unknown;
  let errcode: unknown;
  let errstr: unknown;
  try {
    ({ code, errcode, errstr } = error as {
      code?: unknown;
      errcode?: unknown;
      errstr?: unknown;
    });
  } catch {
    // A throwing getter or a Proxy trap. The diagnostic is best-effort; the
    // isolation is not.
    return `code=${logSafe("<unreadable>")}`;
  }
  const parts = [
    `code=${typeof code === "string" ? logSafe(code) : logSafe("<none>")}`,
  ];
  // Absent on the SDK's own state errors (ERR_INVALID_STATE), present on
  // everything that reached SQLite.
  if (typeof errcode === "number") parts.push(`errcode=${errcode}`);
  if (typeof errstr === "string") parts.push(`errstr=${logSafe(errstr)}`);
  return parts.join(" ");
}
