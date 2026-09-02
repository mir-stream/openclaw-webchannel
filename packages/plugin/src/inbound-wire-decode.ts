/**
 * #246 half A — RUNTIME DECODING OF EVERY INBOUND WIRE FRAME.
 *
 * Both of this plugin's receive doors used to end in a CAST:
 * `JSON.parse(msg.payload.toString()) as InboundWsMessage` (the plaintext lane)
 * and `opened.message as InboundWsMessage` (the crypto lane, where
 * `openEnvelope` hands back `unknown`). A cast is a claim, not a check, so every
 * peer-shaped value the JSON allowed reached `dispatchInbound` and, through it,
 * the turn handler, the ingress dedupe, the delivery journal and core.
 *
 * This module is the one validator on that path. It answers exactly one
 * question — "is this object one of the frames this build's wire contract
 * describes?" — and it answers it about SHAPE ONLY:
 *
 *  - `type` is one of the five known inbound types;
 *  - every field the contract declares REQUIRED is present with the declared
 *    primitive type;
 *  - every OPTIONAL field, when present, has the declared primitive type;
 *  - the ONE bound that already exists on this path — `MAX_INBOUND_USER_ID_LENGTH`
 *    — is applied to the two client-supplied ids.
 *
 * ⚠️ SHAPE, NOT SEMANTICS, AND THE LINE IS DELIBERATE. `load_history` is checked
 * to the TYPES the contract declares and no further — `before`/`beforeTurnId`
 * strings, `limit` a number — because every question beyond that is
 * `planHistoryFetch`/`historyPageBefore`'s, and they ANSWER all of them: a
 * fractional limit is floored and served, a non-finite or non-positive one falls
 * back to the configured page size, a cursor naming no row is an honest empty
 * page. Duplicating any of that here would create a second schema free to
 * disagree with the one that owns it — the same reason `journal-history.ts`'s
 * `isKnownJournalEvent` checks the kind and nothing else.
 *
 * ⚠️ `get_difference`'s `afterSeq` IS RANGE-CHECKED, AND THAT IS NOT A CONTRADICTION
 * OF THE PARAGRAPH ABOVE — it is the same rule with a different downstream. There
 * is no planner on that path: the value goes STRAIGHT into
 * `delivery-journal.read`, which REFUSES a non-integer or negative window by
 * throwing. So the check has no owner further down to defer to, and it is the
 * pre-existing guard (`nats-channel.ts`'s `dispatchInbound`, #244 half B) moved
 * here unchanged rather than a new rule invented at this seam. The test to apply
 * before adding a numeric check here is not "is it a number" but "does anything
 * downstream already decide this" — for `load_history.limit` something did, and
 * an earlier revision of this file broke a legal request by not asking.
 *
 * ⚠️ WHY THE DECODER IS AT LEAST AS STRICT AS THE INGRESS SEAM. `user_message`'s
 * `id` and `random_id` are refused here unless they satisfy the SAME predicate
 * `ingress-dedupe.ts`'s `usableId` applies (non-empty string within
 * `MAX_INBOUND_USER_ID_LENGTH`) — the bound `delivery-journal.ts`'s
 * `appendInboundUser` documents as a CALLER-VALIDATED PRECONDITION, because it
 * stores `randomId ?? turnId` and INDEXES it without re-bounding either. The wire
 * `id` IS that `turnId`, so the bound applied here is the one protecting that
 * index. It is also the bound the store enforces at its own mechanism (`append`
 * throws on an empty or over-long `user` id) and the one
 * `journalEventForInboundUser` enforces at the other, currently unused, door into
 * a `user` row — three doors, one number, on purpose.
 *
 * An ABSENT `id` is still admitted, because it is legal on the wire (older
 * clients send none); only a PRESENT-and-unusable one is refused. So the accept
 * seam's `no-usable-id` journal-gap path stays reachable — through the absent
 * case, which is now the only way in from this door.
 *
 * ⚠️ FIELDS ARE READ WITH `Object.hasOwn`, NOT WITH A PLAIN PROPERTY READ. Two
 * shapes answer a plain read: an INHERITED name (`{"type":"user_message"}` whose
 * `text` comes off a polluted `Object.prototype`) and a payload whose own
 * `__proto__` key `JSON.parse` faithfully materialises. Reading own properties
 * only means an inherited value is INVISIBLE (treated as absent) rather than
 * silently accepted — the same reasoning `journal-history.ts` spells out for
 * `isKnownJournalEvent`.
 *
 * Size bounds on the frame as a whole are #294/#325 and are NOT here.
 */

import type { ApprovalDecision, InboundWsMessage } from "./channel-contract.js";
import { MAX_INBOUND_USER_ID_LENGTH } from "./delivery-journal-event.js";

/**
 * The inbound frame types this build understands. The list IS the wire contract's
 * `InboundWsMessage` union, and `decodeInboundWsMessage` fails
 * `"unknown-type"` for anything else — which is where the `Unknown message type`
 * warn that `dispatchInbound`'s `default:` used to emit now lives.
 */
export const KNOWN_INBOUND_WS_TYPES = [
  "user_message",
  "approval_decision",
  "load_history",
  "get_difference",
  "load_commands",
] as const;

export type KnownInboundWsType = (typeof KNOWN_INBOUND_WS_TYPES)[number];

const KNOWN_TYPES: ReadonlySet<string> = new Set(KNOWN_INBOUND_WS_TYPES);

type AssertNever<T extends never> = T;

/**
 * COMPILE-TIME DRIFT GUARD, BOTH DIRECTIONS — the list above must name exactly
 * the members of `InboundWsMessage`.
 *
 * A type ADDED to the contract but not listed here would be refused at the door:
 * a new feature that silently never arrives, with only a warn line to show for
 * it. A type listed here but absent from the contract would claim a validation
 * that no frame can satisfy. Either way tsc fails on this alias instead, which
 * is the only mechanism that keeps a hand-written mirror honest. (The per-type
 * `switch` in `decodeInboundWsMessage` is exhaustive over this same list for the
 * same reason: it returns a value, so a missing `case` fails to compile.)
 */
export type KnownInboundWsTypesAreExact = [
  AssertNever<Exclude<InboundWsMessage["type"], KnownInboundWsType>>,
  AssertNever<Exclude<KnownInboundWsType, InboundWsMessage["type"]>>,
];

/** The three decisions the wire may carry — `channel-contract.ts`'s `ApprovalDecision`. */
const APPROVAL_DECISIONS: ReadonlySet<string> = new Set<ApprovalDecision>([
  "allow-once",
  "allow-always",
  "deny",
]);

/**
 * Why a frame was refused.
 *
 * `unknown-type` carries the raw `type` because the log line for it is the
 * peer-facing one (`Unknown message type: …`, `logSafe`-wrapped at the call
 * site); every other failure carries a KNOWN type plus a `reason` built only
 * from this module's own literals — no peer bytes ever reach a `reason`.
 */
export type InboundWsDecodeFailure =
  | { kind: "unknown-type"; type: unknown }
  | { kind: "invalid-fields"; type: KnownInboundWsType; reason: string };

export type InboundWsDecodeResult =
  | { ok: true; message: InboundWsMessage }
  | { ok: false; failure: InboundWsDecodeFailure };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** OWN properties only — see the module docblock on inherited names. */
function field(record: Record<string, unknown>, name: string): unknown {
  return Object.hasOwn(record, name) ? record[name] : undefined;
}

/**
 * A client-supplied id this pipeline can key on: a non-empty string within the
 * shared bound. Same predicate and same bound as `ingress-dedupe.ts`'s
 * `usableId` — two doors, one rule, deliberately not two numbers.
 */
function isUsableWireId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_INBOUND_USER_ID_LENGTH
  );
}

const invalid = (
  type: KnownInboundWsType,
  reason: string,
): InboundWsDecodeResult => ({ ok: false, failure: { kind: "invalid-fields", type, reason } });

/**
 * Decode ONE inbound frame off the wire.
 *
 * Returns the SAME object on success (cast, not rebuilt): an additive field a
 * newer peer sends must survive to whatever eventually reads it, and rebuilding
 * here would silently strip it. The one thing a caller must still do is strip
 * PLUGIN-INTERNAL properties a peer may not supply — `normalizeInboundUserMessage`
 * owns that, and it is a different job from this one (it drops unknown fields;
 * this refuses malformed known ones).
 */
export function decodeInboundWsMessage(raw: unknown): InboundWsDecodeResult {
  if (!isRecord(raw)) {
    // A non-object payload (`5`, `"x"`, `null`, `[]`) has no type to name. It
    // lands on the same `Unknown message type` line the old `default:` emitted
    // for it, with `undefined` where the type would be.
    return { ok: false, failure: { kind: "unknown-type", type: undefined } };
  }
  const type = field(raw, "type");
  if (typeof type !== "string" || !KNOWN_TYPES.has(type)) {
    return { ok: false, failure: { kind: "unknown-type", type } };
  }
  const known = type as KnownInboundWsType;

  switch (known) {
    case "user_message": {
      const text = field(raw, "text");
      if (typeof text !== "string") return invalid(known, "text must be a string");
      const id = field(raw, "id");
      if (id !== undefined && !isUsableWireId(id)) {
        return invalid(known, "id must be a non-empty string within the id length bound");
      }
      const randomId = field(raw, "random_id");
      if (randomId !== undefined && !isUsableWireId(randomId)) {
        return invalid(
          known,
          "random_id must be a non-empty string within the id length bound",
        );
      }
      return { ok: true, message: raw as unknown as InboundWsMessage };
    }

    case "approval_decision": {
      // MOVED HERE FROM `dispatchInbound`, unchanged in effect: same two
      // conditions, same drop, and the caller still emits the same
      // `Invalid approval_decision from <peer>` warn.
      const id = field(raw, "id");
      if (typeof id !== "string") return invalid(known, "id must be a string");
      const decision = field(raw, "decision");
      if (typeof decision !== "string" || !APPROVAL_DECISIONS.has(decision)) {
        return invalid(known, "decision must be allow-once, allow-always or deny");
      }
      return { ok: true, message: raw as unknown as InboundWsMessage };
    }

    case "load_history": {
      // SHAPE ONLY. `before`/`beforeTurnId` name a row and `limit` asks for a
      // page size; whether they name anything is `planHistoryFetch`'s question,
      // and `historyPageBefore` answers a non-matching cursor with an empty page
      // rather than an error. What is checked here is only that they are the
      // types the contract declares, so a `{}`-shaped `before` can no longer
      // reach the pager.
      const before = field(raw, "before");
      if (before !== undefined && typeof before !== "string") {
        return invalid(known, "before must be a string");
      }
      const beforeTurnId = field(raw, "beforeTurnId");
      if (beforeTurnId !== undefined && typeof beforeTurnId !== "string") {
        return invalid(known, "beforeTurnId must be a string");
      }
      const limit = field(raw, "limit");
      // ⚠️ `typeof === "number"` AND NOTHING MORE — NOT `Number.isSafeInteger`.
      // Round 1 caught that as a SEMANTIC rule wearing a shape check's clothes,
      // and it broke a legal request. `planHistoryFetch` (`history.ts`) admits
      // `typeof request.limit === "number" && Number.isFinite(request.limit) &&
      // request.limit > 0` and then `Math.min(Math.floor(request.limit),
      // MAX_WIRE_HISTORY_LIMIT)`, so a FRACTIONAL limit is legal and served
      // (`20.5` → a 20-row page; pinned by "floors a fractional wire limit
      // (integer-only contract)" in `history.test.ts`), and the client's public
      // `loadHistory({ limit?: number })` types it as such. Everything that
      // predicate rejects — `NaN`, `Infinity`, `0`, a negative — it already
      // handles, by falling back to the configured page size rather than
      // faulting; its docblock says exactly why (a non-finite limit would slip
      // past the page selectors' own `limit <= 0` check). Refusing those here
      // would not add safety, and refusing `20.5` cost the user "load older"
      // entirely: the frame is dropped with a warn and no page ever comes back.
      if (limit !== undefined && typeof limit !== "number") {
        return invalid(known, "limit must be a number");
      }
      return { ok: true, message: raw as unknown as InboundWsMessage };
    }

    case "get_difference": {
      // MOVED HERE FROM `dispatchInbound`, unchanged in effect: the serve path
      // passes `afterSeq` straight to `delivery-journal.read`, which requires a
      // non-negative integer.
      const afterSeq = field(raw, "afterSeq");
      if (typeof afterSeq !== "number" || !Number.isInteger(afterSeq) || afterSeq < 0) {
        return invalid(known, "afterSeq must be a non-negative integer");
      }
      return { ok: true, message: raw as unknown as InboundWsMessage };
    }

    case "load_commands":
      // No fields. The type alone is the request.
      return { ok: true, message: raw as unknown as InboundWsMessage };
  }
}
