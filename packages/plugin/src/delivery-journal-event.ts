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
 * TOOL ACTIVITY and the APPROVAL frames are still `null` and are marked "#242
 * half 2". Every `null` below carries its reason, and the ones owned by #242 say
 * "not yet" rather than "no".
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
      // ⚠️ THE ADMISSION RULE IS THE CLIENT'S, FIELD FOR FIELD, AND THAT IS THE
      // POINT. The live handler is
      // `if (!msg.id || !msg.turnId || typeof msg.text !== "string" || msg.text.length === 0) return;`
      // (`nats-client-wrapper.ts`'s `case "reasoning"`), i.e. non-empty id,
      // non-empty turnId, non-empty string text — `isUsableMessageId` is exactly
      // that predicate with the type check the wire does not perform. Journaling
      // a frame the client REFUSES would put a message in history that live
      // never rendered (N8, in the gaining direction); refusing one the client
      // accepts would lose delivered content (N10). Neither margin is available,
      // so the two rules must be the same rule.
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
      // NOT YET durable — #242 half 2. Same as `reasoning` was: Telegram
      // preserves service messages and so must we; the event model has to grow
      // first. Half 1 grew it for reasoning only.
      return null;
    case "approval_request":
      // NOT YET durable — #242 half 2. An approval is a MESSAGE by §15.9's
      // message-vs-indicator test, not an indicator.
      return null;
    case "approval_resolved":
      // NOT YET durable — #242 half 2. It is the state change of the message
      // above.
      return null;
    case "approval_snapshot":
      // NOT YET durable — #242 half 2. Also a REPLAY of approvals the store
      // already owns once that half lands; see the `history` case for why
      // replays are not journaled.
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
 * The inbound user message's journal event.
 *
 * Exported alongside the outbound mapper so half 3 has nothing to invent at the
 * accept seam: doc §15.7 makes the plugin the ONLY SSOT for user messages, so
 * this event is the durable record of the accept, written before the ack.
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
