/**
 * #246 half A — RUNTIME DECODING OF EVERY INBOUND FRAME, CLIENT SIDE.
 *
 * `openMessage` (`e2e-crypto-browser.ts`) returns the decrypted payload as
 * `unknown`, and both of this client's receive doors used to cast that away
 * (`openMessage(payload, key) as InboundMessage | null`). `deliverInbound` then
 * forwarded whatever it was to every listener, so an arbitrary JSON value
 * reached the wrapper's reducer, its seq cursor and its state.
 *
 * This module is the one validator on that path. It answers exactly one question
 * — "is this object one of the frames this build's wire contract describes?" —
 * about SHAPE ONLY: the frame's `type`, the envelope fields every frame may
 * carry, and per type the fields the CONTRACT declares, at the primitive-type
 * level. Content questions stay where they already live (`case "history"`'s deep
 * per-row discrimination, `applyTurnSnapshot`'s answer filter, the
 * approval-snapshot legs); this file does not duplicate them.
 *
 * ⚠️ ZERO-DEPENDENCY, HAND-ROLLED, LIKE THE REST OF THIS PACKAGE. No schema
 * library — `packages/client/package.json` declares no `dependencies` and that
 * is a shipped property of the browser bundle, not an accident.
 *
 * ⚠️ A REFUSED FRAME IS DROPPED, AND FOR A SEQ-BEARING FRAME THAT IS THE WHOLE
 * POINT. The wrapper advances `lastAppliedSeq` only for a frame it actually
 * FOLDED (`handleFrame` returns that), so a refused frame leaves the cursor
 * alone, the next frame reads as a gap, `get_difference` re-serves the canonical
 * journal row and the view converges. Advancing past a frame we refused would
 * close the very gap that heals it — the defect this slice fixes.
 *
 * ⚠️ THE FRAME IS RETURNED AS-IS ON SUCCESS (cast, never rebuilt). An additive
 * field a NEWER plugin sends must survive to whatever reads it; rebuilding here
 * would strip it silently. Rejecting an unknown extra field would be worse — the
 * wire is explicitly additive (`channel-contract.ts` says so on nearly every
 * member) — so unknown fields are ignored, never refused.
 *
 * ⚠️ FIELDS ARE READ WITH `Object.hasOwn`. An INHERITED name (off a polluted
 * `Object.prototype`) reads as ABSENT here rather than being accepted as the
 * frame's own value. `JSON.parse` materialises an own `__proto__` key rather than
 * setting a prototype, so the two shapes together are what "prototype-poisoned
 * payload" means on this path.
 */

import type { InboundMessage } from "./nats-client.js";
import type { DurableEvent } from "./durable-view-reducer.js";

/**
 * Every inbound frame type this build knows — the `type` union of
 * `InboundMessage` (`nats-client.ts`), which mirrors the plugin's
 * `OutboundWsMessage`. A frame outside this set is DROPPED at the door with a
 * warn instead of falling through the wrapper's `default`-less `handleFrame`.
 *
 * ⚠️ THAT IS A REAL (SMALL) CHANGE IN WHAT AN OLDER CLIENT DOES WITH A NEWER
 * SERVER'S FRAME, AND IT IS THE POINT OF PAIRING THIS WITH THE PROTOCOL BUMP
 * (#246 half B): before, an unknown type was silently ignored; now it is dropped
 * with one diagnostic line. Both outcomes are "the frame does nothing"; the
 * difference is that the drop is VISIBLE. Nothing else changes — an unknown type
 * is not in `SEQ_BEARING_INBOUND_TYPES`, so it never carried the cursor either.
 */
export const KNOWN_INBOUND_TYPES = [
  "agent_message",
  "progress",
  "reasoning",
  "tool_activity",
  "turn_settled",
  "turn_snapshot",
  "approval_request",
  "approval_resolved",
  "approval_snapshot",
  "typing",
  "history",
  "commands",
  "ack",
  "inbound_rejected",
  "user_committed",
  "difference",
] as const;

export type KnownInboundType = (typeof KNOWN_INBOUND_TYPES)[number];

const KNOWN_TYPES: ReadonlySet<string> = new Set(KNOWN_INBOUND_TYPES);

type AssertNever<T extends never> = T;

/**
 * COMPILE-TIME DRIFT GUARD, BOTH DIRECTIONS — the list above must name exactly
 * the members of `InboundMessage["type"]`.
 *
 * A type ADDED to that union but not listed here would be refused at the door:
 * a new frame the plugin sends and this client silently never acts on, with only
 * a warn line to show for it. A type listed here but absent from the union would
 * claim a validation no frame can satisfy. Either way tsc fails on this alias
 * instead, which is the only mechanism that keeps a hand-written mirror honest.
 * (The per-type `switch` in `decodeInboundMessage` is exhaustive over this same
 * list for the same reason: it returns a value, so a missing `case` fails to
 * compile.)
 */
export type KnownInboundTypesAreExact = [
  AssertNever<Exclude<InboundMessage["type"], KnownInboundType>>,
  AssertNever<Exclude<KnownInboundType, InboundMessage["type"]>>,
];

/** The three real approval decisions — `ApprovalDecision` in `types.ts`. */
const APPROVAL_DECISIONS: ReadonlySet<string> = new Set([
  "allow-once",
  "allow-always",
  "deny",
]);

export type InboundDecodeFailure =
  | { kind: "unknown-type"; type: unknown }
  | { kind: "invalid-fields"; type: KnownInboundType; reason: string };

export type InboundDecodeResult =
  | { ok: true; message: InboundMessage }
  | { ok: false; failure: InboundDecodeFailure };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** OWN properties only — see the module docblock on inherited names. */
function field(record: Record<string, unknown>, name: string): unknown {
  return Object.hasOwn(record, name) ? record[name] : undefined;
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * A per-conversation `seq`, wherever one appears (a frame's own, an `ack`
 * entry's, a `history` high-water, a `difference` event's).
 *
 * NON-NEGATIVE SAFE INTEGER, and every conjunct earns its place: the cursor is a
 * MONOTONE high-water, so a `NaN`, a fractional value or `1e21` accepted here
 * would move it somewhere no real seq can reach and gate out every subsequent
 * frame — silent, permanent loss of everything after it. This is the one numeric
 * field on the wire where a wrong value is worse than a missing one.
 */
export function isWireSeq(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isArrayOfRecords(value: unknown): value is Array<Record<string, unknown>> {
  return Array.isArray(value) && value.every((entry) => isRecord(entry));
}

/**
 * ONE `ack.committed` entry — the server's durable `messageId` for a client
 * `random_id`, plus (since #244 half A) the user opener's `seq`.
 *
 * THE ONE RULE, shared by the three places that read these entries: this
 * decoder, `adoptCommittedIds` (which re-keys the optimistic bubble) and the
 * cursor advance beside it. Keeping it in one predicate is what makes "no
 * malformed value reaches adoption or the cursor" checkable rather than a claim
 * spread over three copies — and it is why the cursor may NOT advance on an
 * entry whose identity fields are malformed: the `seq` is only evidence that a
 * user row was committed if the entry naming that row is itself intact.
 *
 * `seq` is OPTIONAL: the plugin's contract makes it required, but an older build
 * (pre-#244 half A) echoed none and its acks must still adopt. A PRESENT but
 * malformed one refuses the WHOLE entry, adoption included — half an entry
 * accepted is how one rule becomes two — and it costs nothing real: the door
 * decoder refuses the frame carrying it before any of this runs.
 */
export function isCommittedEcho(
  entry: unknown,
): entry is { random_id: string; messageId: string; seq?: number } {
  if (!isRecord(entry)) return false;
  if (!isNonEmptyString(field(entry, "random_id"))) return false;
  if (!isNonEmptyString(field(entry, "messageId"))) return false;
  const seq = field(entry, "seq");
  return seq === undefined || isWireSeq(seq);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

/** `Array<{id: string; text: string}>` — the `answers` shape of a seal/turn_snapshot. */
function isAnswerArray(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) => isRecord(entry) && isString(field(entry, "id")) && isString(field(entry, "text")),
    )
  );
}

const invalid = (type: KnownInboundType, reason: string): InboundDecodeResult => ({
  ok: false,
  failure: { kind: "invalid-fields", type, reason },
});

const accept = (raw: Record<string, unknown>): InboundDecodeResult => ({
  ok: true,
  message: raw as unknown as InboundMessage,
});

/**
 * Decode ONE inbound frame.
 *
 * ⚠️ WHERE THIS IS STRICT AND WHERE IT IS PERMISSIVE IS DECIDED PER FIELD, by
 * reading what the PRODUCER can emit and what the CONSUMER already tolerates —
 * not by applying "required in the type ⇒ required here" uniformly. Both margins
 * cost something real: refusing a frame the plugin legitimately sends drops
 * delivered content (N8) or buys a needless `get_difference` round-trip per
 * frame, while accepting a shape the handler cannot express lets a malformed
 * value into the view (N8). The per-`case` notes below record which way each
 * field went and why.
 */
export function decodeInboundMessage(raw: unknown): InboundDecodeResult {
  if (!isRecord(raw)) {
    return { ok: false, failure: { kind: "unknown-type", type: undefined } };
  }
  const type = field(raw, "type");
  if (typeof type !== "string" || !KNOWN_TYPES.has(type)) {
    return { ok: false, failure: { kind: "unknown-type", type } };
  }
  const known = type as KnownInboundType;

  // ── Envelope: fields any frame may carry, checked once. ──
  const seq = field(raw, "seq");
  if (seq !== undefined && !isWireSeq(seq)) {
    return invalid(known, "seq must be a non-negative safe integer");
  }
  for (const name of ["id", "turnId", "text"] as const) {
    const value = field(raw, name);
    if (value !== undefined && !isString(value)) {
      return invalid(known, `${name} must be a string`);
    }
  }

  switch (known) {
    case "agent_message":
      // `text` is the payload and the contract makes it required; an
      // `agent_message` without one is not a bubble. `id` may be ABSENT — that is
      // the documented legacy-plugin path the wrapper mints a client-local id for
      // (it predates #238's mint-at-the-delivery-act) — and the envelope check
      // above already refused a non-string one.
      if (!isString(field(raw, "text"))) return invalid(known, "text must be a string");
      return accept(raw);

    case "progress":
      // ⚠️ DELIBERATELY THE MOST PERMISSIVE CASE, AND `""` IS LEGAL HERE. The
      // journal records a progress frame's id VERBATIM, `""` included
      // (`delivery-journal-event.ts`'s `case "progress"`: "`frame.id` is `string`
      // on the wire and is journaled VERBATIM — including `""`, which the client
      // keeps as a real id"), and the wrapper's handler keys on `id ?? ""`
      // (NULLISH — the reducer's BOUNDARY 1 pins why this differs from the
      // `bubble` site). Refusing an empty or absent id would make the LIVE view
      // disagree with the difference-folded one for a row the store can hold —
      // an N8 divergence manufactured at this line. Every current emit site does
      // send a non-empty id (`message-adapter.ts` sends `reservation.id`
      // — a minted `nextMessageId()` or a truthy `lane.id` — and `preview.id`,
      // itself a `nextMessageId()`), so the permissiveness costs nothing today; it
      // is here because the STORE, not the producer, defines what must round-trip.
      return accept(raw);

    case "reasoning":
      // Strict, and it MATCHES the journal's admission rule exactly (non-empty
      // id, non-empty turnId, non-empty string text — `journalEventForOutbound`'s
      // `case "reasoning"`, whose docblock states that tracking the client's rule
      // is what keeps both N8 and N10 margins closed). Empty text is not a
      // legitimate frame, checked at ALL THREE producers in `message-adapter.ts`
      // rather than at the one that came to mind: `push` returns early on
      // `text.length === 0` (and again when stripping the stale prefix empties
      // it), `closeLiveBurst` sends the burst-closing frame only under
      // `if (lastDeliveredText.length > 0)`, and `pushDurableBlock` returns early
      // on the same emptiness test. So no producer emits one, and classing it
      // malformed costs no `get_difference` round-trip.
      if (!isNonEmptyString(field(raw, "id"))) return invalid(known, "id must be non-empty");
      if (!isNonEmptyString(field(raw, "turnId"))) {
        return invalid(known, "turnId must be non-empty");
      }
      if (!isNonEmptyString(field(raw, "text"))) {
        return invalid(known, "text must be a non-empty string");
      }
      return accept(raw);

    case "tool_activity": {
      // `id` + `turnId` are the correlation PAIR `applyTool` upserts on, and the
      // same non-empty rule the journal mapper applies. The display fields are
      // optional deltas; `argKeys` must be an array (the handler re-filters it to
      // strings — that filter is the "key names only, never values" contract and
      // stays where it is).
      if (!isNonEmptyString(field(raw, "id"))) return invalid(known, "id must be non-empty");
      if (!isNonEmptyString(field(raw, "turnId"))) {
        return invalid(known, "turnId must be non-empty");
      }
      for (const name of ["name", "phase", "status", "summary"] as const) {
        const value = field(raw, name);
        if (value !== undefined && !isString(value)) {
          return invalid(known, `${name} must be a string`);
        }
      }
      const argKeys = field(raw, "argKeys");
      if (argKeys !== undefined && !Array.isArray(argKeys)) {
        return invalid(known, "argKeys must be an array");
      }
      return accept(raw);
    }

    case "turn_settled": {
      // ⚠️ `outcome` IS CHECKED AS A STRING, NOT AGAINST THE TWO LITERALS, AND
      // THAT IS DELIBERATE. The handler already treats anything that is neither
      // `"ok"` nor `"error"` as the legacy outcome-less frame: it settles the
      // turn and honestly leaves the send at `accepted`. If a later build adds a
      // third outcome, degrading to "settle without promotion" is correct;
      // REFUSING the frame would leave the composer wedged on a turn that ended.
      const outcome = field(raw, "outcome");
      if (outcome !== undefined && !isString(outcome)) {
        return invalid(known, "outcome must be a string");
      }
      return accept(raw);
    }

    case "turn_snapshot": {
      // `turnId` is the key the seal folds on — `applyTurnSnapshot` refuses an
      // empty one, so refusing it here is the same rule at the door. `answers`
      // and `remove` are checked as SHAPES only where present: the handler's own
      // filters (non-empty answer ids, duplicate-id dedupe) are content rules and
      // stay there. Absence is tolerated because the handler tolerates it — an
      // answer-less, remove-less snapshot is an accepted no-op, not a malformed
      // frame.
      if (!isNonEmptyString(field(raw, "turnId"))) {
        return invalid(known, "turnId must be non-empty");
      }
      const answers = field(raw, "answers");
      if (answers !== undefined && !isAnswerArray(answers)) {
        return invalid(known, "answers must be an array of {id, text}");
      }
      const remove = field(raw, "remove");
      if (remove !== undefined && !isStringArray(remove)) {
        return invalid(known, "remove must be an array of strings");
      }
      return accept(raw);
    }

    case "approval_request": {
      // A card is addressed by its `id` on the wire and in the journal
      // (`journalEventForOutbound` refuses an id-less one), and the handler
      // already refuses `""` for exactly that reason. The payload fields are
      // checked as types where present — the handler supplies defaults for absent
      // ones, and an OLDER server that omitted one still renders.
      //
      // ⚠️ `options` IS CHECKED AS "AN ARRAY OF OBJECTS", NOT PER BUTTON. The
      // three-decision union is CLOSED TODAY but the renderer only maps over the
      // entries; refusing a card because one button carries a decision this build
      // does not know would drop a prompt the user must answer for the turn to
      // continue — strictly worse than rendering a button we pass back verbatim.
      if (!isNonEmptyString(field(raw, "id"))) return invalid(known, "id must be non-empty");
      const kind = field(raw, "kind");
      if (kind !== undefined && kind !== "exec" && kind !== "plugin") {
        return invalid(known, "kind must be exec or plugin");
      }
      for (const name of ["title", "description", "prompt"] as const) {
        const value = field(raw, name);
        if (value !== undefined && !isString(value)) {
          return invalid(known, `${name} must be a string`);
        }
      }
      const options = field(raw, "options");
      if (options !== undefined && !isArrayOfRecords(options)) {
        return invalid(known, "options must be an array of objects");
      }
      const expiresAtMs = field(raw, "expiresAtMs");
      if (expiresAtMs !== undefined && typeof expiresAtMs !== "number") {
        return invalid(known, "expiresAtMs must be a number");
      }
      return accept(raw);
    }

    case "approval_resolved":
      // STRICT ON `decision`, unlike `approval_request`'s buttons, because this
      // one is FOLDED INTO DURABLE STATE (`applyApprovalResolution` writes it as
      // the card's `resolvedDecision`) and the journal mapper admits the same
      // three values. An unrecognised decision here would render a card as
      // resolved with an outcome no renderer can express — the shape the
      // handler's own guard already refuses.
      if (!isNonEmptyString(field(raw, "id"))) return invalid(known, "id must be non-empty");
      if (!APPROVAL_DECISIONS.has(field(raw, "decision") as string)) {
        return invalid(known, "decision must be allow-once, allow-always or deny");
      }
      return accept(raw);

    case "approval_snapshot": {
      // Envelope only. The reconciliation's three legs already discriminate every
      // entry (`typeof p.id !== "string" || p.id.length === 0` ⇒ skip), and its
      // per-entry rules are content decisions that belong there.
      const approvals = field(raw, "approvals");
      if (approvals !== undefined && !isArrayOfRecords(approvals)) {
        return invalid(known, "approvals must be an array of objects");
      }
      const resolved = field(raw, "resolved");
      if (resolved !== undefined && !isArrayOfRecords(resolved)) {
        return invalid(known, "resolved must be an array of objects");
      }
      return accept(raw);
    }

    case "typing":
      // No fields. The type alone is the signal.
      return accept(raw);

    case "history": {
      // TOP LEVEL ONLY, and that boundary is deliberate: `case "history"` is the
      // one thoroughly validated handler in the wrapper — it discriminates the
      // row union variant by variant — so re-checking rows here would be a second
      // schema free to disagree with it. What it cannot defend against is
      // `messages` not being an array at all, and a `highWaterSeq` that would
      // launch the cursor past every future frame.
      const messages = field(raw, "messages");
      if (!Array.isArray(messages)) return invalid(known, "messages must be an array");
      const highWaterSeq = field(raw, "highWaterSeq");
      if (highWaterSeq !== undefined && !isWireSeq(highWaterSeq)) {
        return invalid(known, "highWaterSeq must be a non-negative safe integer");
      }
      return accept(raw);
    }

    case "commands": {
      const commands = field(raw, "commands");
      if (commands !== undefined && !Array.isArray(commands)) {
        return invalid(known, "commands must be an array");
      }
      return accept(raw);
    }

    case "ack": {
      // ⚠️ FRAME-LEVEL DROP FOR A MALFORMED `committed` ENTRY, NOT ENTRY-LEVEL.
      // The alternative — filter the bad entries and admit the rest — means
      // REBUILDING the frame here, which is the one thing this decoder does not
      // do (an additive field would be stripped with it), and it would put a
      // second, quieter admission rule beside the two consumers that already have
      // one. So the whole frame goes, and nothing is lost by it: every one of the
      // ack's three jobs has a healing path — an unacked ledger entry is
      // re-published BOTH in-session (`armLiveRetryTimer`/`retryDueUnacked` in
      // `nats-client.ts` re-seal every entry whose retry is due, on the same
      // connection) and on the next session's replay, deduped either way by
      // `random_id`; id adoption is re-run by the difference fold's `randomId`
      // match (#337); and the un-advanced user seq shows up as the very next
      // agent frame's gap, which `get_difference` heals. Both consumers keep
      // their own per-entry guards regardless: this decoder is not allowed to be
      // the only thing standing between the wire and the cursor.
      const ids = field(raw, "ids");
      if (ids !== undefined && !isStringArray(ids)) {
        return invalid(known, "ids must be an array of strings");
      }
      const committed = field(raw, "committed");
      if (committed !== undefined) {
        if (!Array.isArray(committed) || !committed.every(isCommittedEcho)) {
          return invalid(
            known,
            "committed must be an array of {random_id, messageId, seq?} echoes",
          );
        }
      }
      return accept(raw);
    }

    case "inbound_rejected": {
      const ids = field(raw, "ids");
      if (ids !== undefined && !isStringArray(ids)) {
        return invalid(known, "ids must be an array of strings");
      }
      const reason = field(raw, "reason");
      if (reason !== undefined && !isString(reason)) {
        return invalid(known, "reason must be a string");
      }
      return accept(raw);
    }

    case "user_committed":
      // The multi-device broadcast of a COMMITTED user event: it carries the
      // `id`/`text` the journal already holds — a SERVER mint,
      // `webchannel-user-<seq>`, assigned inside the same transaction as the seq
      // — and the handler refuses an empty id or a non-string text for exactly
      // that reason: an id-less user row cannot exist in the store at all
      // (`delivery-journal.ts`'s `append` throws on one).
      if (!isNonEmptyString(field(raw, "id"))) return invalid(known, "id must be non-empty");
      if (!isString(field(raw, "text"))) return invalid(known, "text must be a string");
      return accept(raw);

    case "difference": {
      // TOP LEVEL ONLY — each event is validated where it is FOLDED
      // (`decodeDurableEvent`, below), because that is where the live-vs-catch-up
      // asymmetry lives: a refused LIVE frame must not advance the cursor, while
      // a refused event INSIDE a difference must, or the catch-up is re-requested
      // forever.
      const events = field(raw, "events");
      if (events !== undefined && !Array.isArray(events)) {
        return invalid(known, "events must be an array");
      }
      return accept(raw);
    }
  }
}

// ---------------------------------------------------------------------------
// Difference events
// ---------------------------------------------------------------------------

/**
 * The `DurableEvent` kinds this build's reducer knows — kept in step with
 * `applyDurableEvent`'s switch (`durable-view-reducer.ts`).
 *
 * A `difference` from a NEWER plugin may carry a kind outside this set (#253's
 * retained-unknown rows); such an event is SKIPPED, and its seq still advances
 * the cursor — exactly as the server's `projectJournalHistory` counts an
 * `unsupportedEvents` row rather than stalling on it.
 */
const KNOWN_DURABLE_EVENT_KIND_LIST = [
  "user",
  "placement",
  "bubble",
  "seal",
  "reasoning",
  "tool",
  "approval",
  "approvalResolution",
  "messageEdited",
  "messageDeleted",
] as const satisfies readonly DurableEvent["kind"][];

const KNOWN_DURABLE_EVENT_KINDS: ReadonlySet<string> = new Set(KNOWN_DURABLE_EVENT_KIND_LIST);

/**
 * COMPILE-TIME DRIFT GUARD — "kept in step with `applyDurableEvent`'s switch"
 * used to be a request to the next reader; this makes it a build error.
 *
 * The `satisfies` above catches a kind listed here that the reducer does not
 * know; this catches the direction that actually loses data — a kind the reducer
 * DOES fold that this set omits, which would make every catch-up carrying one
 * skip it (and advance past it), so the row would never land at all until a
 * reconnect replayed history.
 */
type AssertNeverKind<T extends never> = T;
export type KnownDurableEventKindsAreExact = AssertNeverKind<
  Exclude<DurableEvent["kind"], (typeof KNOWN_DURABLE_EVENT_KIND_LIST)[number]>
>;

export type DurableEventDecodeResult =
  | { ok: true; event: DurableEvent }
  /** The kind is outside this build's set — a newer plugin's row. */
  | { ok: false; kind: "unknown-kind" }
  /** A kind we DO know, carrying a shape the fold cannot use. */
  | { ok: false; kind: "malformed"; eventKind: string; reason: string };

/**
 * ⭐ THE LIVE/CATCH-UP ASYMMETRY, STATED ONCE, HERE. Both `applyDifference` and
 * the wrapper's seq-cursor site point at this paragraph rather than restating it.
 *
 *  - A LIVE seq-bearing frame that fails validation is dropped and the cursor is
 *    NOT advanced. The next frame then reads as a gap, one `get_difference` goes
 *    out, and the server re-serves the canonical journal row — so the refusal
 *    COSTS a round-trip and LOSES nothing.
 *  - An event inside a `difference` that fails validation is skipped and the
 *    cursor IS advanced past it. A difference is the authoritative catch-up: it
 *    is the answer to the very request a gap would raise, so freezing the cursor
 *    on it would re-request the same unusable row forever. This is the same
 *    treatment an UNKNOWN kind already gets, and the same one the server's
 *    `projectJournalHistory` gives a row it cannot fold.
 *
 * The two are not in tension — they are the same rule ("never let a bad row
 * wedge the stream") applied where each door can still recover.
 *
 * ⚠️ EVERY FIELD A FOLD ARM DEREFERENCES IS CHECKED HERE, not just the ones the
 * reducer would notice. `foldDifferenceEvent` iterates `event.answers` for a
 * `seal` and indexes `event.answerId` for a `bubble`/`placement` BEFORE the
 * reducer sees them, so a missing `answers` throws inside the fold. That throw is
 * swallowed by the client's listener dispatch, which leaves `differenceInFlight`
 * stuck true and buffers every later durable frame until the transport drops —
 * a silent wedge. `applyDifference` carries a `finally` against it too; this
 * predicate is what makes the arm unreachable in the first place.
 */
export function decodeDurableEvent(event: unknown): DurableEventDecodeResult {
  if (!isRecord(event)) return { ok: false, kind: "unknown-kind" };
  const kind = field(event, "kind");
  if (typeof kind !== "string" || !KNOWN_DURABLE_EVENT_KINDS.has(kind)) {
    return { ok: false, kind: "unknown-kind" };
  }
  const bad = (reason: string): DurableEventDecodeResult => ({
    ok: false,
    kind: "malformed",
    eventKind: kind,
    reason,
  });
  const ok = (): DurableEventDecodeResult => ({
    ok: true,
    event: event as unknown as DurableEvent,
  });

  switch (kind) {
    case "user":
      // The journal refuses an id-less user row at its own mechanism
      // (`delivery-journal.ts`'s `append` throws on one, and `appendInboundUser`
      // mints the id itself), so a row here without one did not come from this
      // store.
      if (!isNonEmptyString(field(event, "id"))) return bad("id must be non-empty");
      if (!isString(field(event, "text"))) return bad("text must be a string");
      if (!optionalString(event, "turnId")) return bad("turnId must be a string");
      if (!optionalString(event, "randomId")) return bad("randomId must be a string");
      return ok();

    case "placement":
      // `answerId` may be `""` — the journal records a progress frame's id
      // verbatim and the reducer keys on it (see `case "progress"` above). It is
      // read as an object key by the fold's overlay, so the STRING-ness is what
      // matters.
      if (!isString(field(event, "answerId"))) return bad("answerId must be a string");
      if (!optionalString(event, "turnId")) return bad("turnId must be a string");
      return ok();

    case "bubble":
      // Non-empty, unlike `placement`: `journalEventForOutbound` refuses an
      // id-less durable frame (`isUsableMessageId`), so no `bubble` row in this
      // store carries `""`.
      if (!isNonEmptyString(field(event, "answerId"))) {
        return bad("answerId must be non-empty");
      }
      if (!isString(field(event, "text"))) return bad("text must be a string");
      if (!optionalString(event, "turnId")) return bad("turnId must be a string");
      return ok();

    case "seal":
      // `answers` is ITERATED by the fold arm before the reducer sees it, and
      // each entry's `id` is used as an overlay key — the exact shape whose
      // absence throws.
      if (!isNonEmptyString(field(event, "turnId"))) return bad("turnId must be non-empty");
      if (!isAnswerArray(field(event, "answers"))) {
        return bad("answers must be an array of {id, text}");
      }
      if (field(event, "remove") !== undefined && !isStringArray(field(event, "remove"))) {
        return bad("remove must be an array of strings");
      }
      return ok();

    case "reasoning":
      if (!isNonEmptyString(field(event, "id"))) return bad("id must be non-empty");
      if (!isNonEmptyString(field(event, "turnId"))) return bad("turnId must be non-empty");
      if (!isString(field(event, "text"))) return bad("text must be a string");
      return ok();

    case "tool":
      // The `(turnId, id)` pair is what `applyTool` upserts on; the rest are
      // optional delta fields the merge spreads.
      if (!isNonEmptyString(field(event, "id"))) return bad("id must be non-empty");
      if (!isNonEmptyString(field(event, "turnId"))) return bad("turnId must be non-empty");
      for (const name of ["name", "phase", "status", "summary"] as const) {
        if (!optionalString(event, name)) return bad(`${name} must be a string`);
      }
      if (field(event, "argKeys") !== undefined && !isStringArray(field(event, "argKeys"))) {
        return bad("argKeys must be an array of strings");
      }
      return ok();

    case "approval": {
      if (!isNonEmptyString(field(event, "id"))) return bad("id must be non-empty");
      const approvalKind = field(event, "approvalKind");
      if (approvalKind !== "exec" && approvalKind !== "plugin") {
        return bad("approvalKind must be exec or plugin");
      }
      if (!isString(field(event, "title"))) return bad("title must be a string");
      if (!isString(field(event, "prompt"))) return bad("prompt must be a string");
      if (!optionalString(event, "description")) return bad("description must be a string");
      if (!isArrayOfRecords(field(event, "options"))) {
        return bad("options must be an array of objects");
      }
      const expiresAtMs = field(event, "expiresAtMs");
      if (expiresAtMs !== undefined && typeof expiresAtMs !== "number") {
        return bad("expiresAtMs must be a number");
      }
      return ok();
    }

    case "approvalResolution":
      // Same rule as the live `approval_resolved` frame — the decision is folded
      // into durable state, so an unrecognised one has no representation.
      if (!isNonEmptyString(field(event, "id"))) return bad("id must be non-empty");
      if (!APPROVAL_DECISIONS.has(field(event, "decision") as string)) {
        return bad("decision must be allow-once, allow-always or deny");
      }
      return ok();

    case "messageEdited":
      if (!isNonEmptyString(field(event, "id"))) return bad("id must be non-empty");
      if (!isString(field(event, "text"))) return bad("text must be a string");
      // The revision is COMPARED (`> (prev.revision ?? 0)`), so a non-number
      // would silently lose every comparison and the edit would vanish rather
      // than being reported.
      if (!Number.isSafeInteger(field(event, "revision"))) {
        return bad("revision must be a safe integer");
      }
      if (!optionalString(event, "turnId")) return bad("turnId must be a string");
      return ok();

    case "messageDeleted":
      if (!isNonEmptyString(field(event, "id"))) return bad("id must be non-empty");
      if (!Number.isSafeInteger(field(event, "revision"))) {
        return bad("revision must be a safe integer");
      }
      if (!optionalString(event, "turnId")) return bad("turnId must be a string");
      return ok();
  }
  // Unreachable while every listed kind has a `case`: `kind` was checked against
  // the set above. Written as a MALFORMED refusal rather than a cast or an
  // `unknown-kind` so a kind added to the list without a `case` here is skipped
  // AND reported (`applyDifference` warns only on `malformed`; `unknown-kind` is
  // silent by design) — never folded unvalidated, never silently dropped.
  return bad("no decoder case");
}

/** True when the field is absent or a string — the shape of every optional `turnId`. */
function optionalString(record: Record<string, unknown>, name: string): boolean {
  const value = field(record, name);
  return value === undefined || typeof value === "string";
}
