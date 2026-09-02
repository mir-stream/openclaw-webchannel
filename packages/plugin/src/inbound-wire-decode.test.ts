/**
 * #246 half A — the plugin's inbound wire decoder.
 *
 * Both receive doors used to end in a CAST, so every peer-shaped value the JSON
 * allowed reached `dispatchInbound`. These pin what the decoder admits and what
 * it refuses, field by field.
 *
 * ⚠️ THE TWO GUARDS THAT MOVED HERE MUST BEHAVE IDENTICALLY. `approval_decision`
 * and `get_difference` were validated inside `dispatchInbound`; their conditions
 * are now `case`s in the decoder. The end-to-end evidence that the OUTCOME did
 * not change — same drop, same warn text, same peer rendering — is
 * `nats-channel-typing.test.ts`, which drives the real channel through the real
 * door; what is pinned here is the per-field decision itself.
 */

import { describe, it, expect } from "vitest";

import {
  KNOWN_INBOUND_WS_TYPES,
  decodeInboundWsMessage,
} from "./inbound-wire-decode.js";
import { MAX_INBOUND_USER_ID_LENGTH } from "./delivery-journal-event.js";

/** The decoded message, or a failure description that reads in a diff. */
function decode(raw: unknown): { ok: true } | { ok: false; type: unknown; reason: string } {
  const result = decodeInboundWsMessage(raw);
  if (result.ok) return { ok: true };
  return result.failure.kind === "unknown-type"
    ? { ok: false, type: result.failure.type, reason: "unknown-type" }
    : { ok: false, type: result.failure.type, reason: result.failure.reason };
}

const accepts = (raw: unknown) => expect(decode(raw)).toEqual({ ok: true });
const refuses = (raw: unknown) => expect(decode(raw).ok).toBe(false);

describe("#246 half A — decodeInboundWsMessage: the frame envelope", () => {
  it("accepts one valid frame of every known type", () => {
    const valid: Record<string, unknown> = {
      user_message: { type: "user_message", text: "hello" },
      approval_decision: { type: "approval_decision", id: "exec-1", decision: "deny" },
      load_history: { type: "load_history" },
      get_difference: { type: "get_difference", afterSeq: 0, nonce: "n0" },
      load_commands: { type: "load_commands" },
    };
    // Every member of the exported set has a case here — a new inbound type
    // cannot be added without deciding what a valid one looks like.
    expect(Object.keys(valid).sort()).toEqual([...KNOWN_INBOUND_WS_TYPES].sort());
    for (const frame of Object.values(valid)) accepts(frame);
  });

  it("refuses an unknown type, and names it for the log line", () => {
    expect(decode({ type: "typing" })).toEqual({
      ok: false, type: "typing", reason: "unknown-type",
    });
    expect(decode({ type: "USER_MESSAGE", text: "x" })).toEqual({
      ok: false, type: "USER_MESSAGE", reason: "unknown-type",
    });
  });

  it("refuses a non-string or missing type", () => {
    expect(decode({ type: 7 })).toEqual({ ok: false, type: 7, reason: "unknown-type" });
    expect(decode({ text: "hello" })).toEqual({
      ok: false, type: undefined, reason: "unknown-type",
    });
  });

  it("refuses a payload that is not an object at all", () => {
    // `null` is the interesting one: the old crypto door cast it and then read
    // `.type` off it OUTSIDE its try/catch, so the TypeError escaped into the
    // transport's message emit.
    for (const raw of [null, undefined, 5, "user_message", true, [], [{ type: "user_message", text: "x" }]]) {
      expect(decode(raw)).toEqual({ ok: false, type: undefined, reason: "unknown-type" });
    }
  });

  it("reads OWN properties only — an inherited `type` or `text` is invisible", () => {
    const inheritedType = Object.create({ type: "user_message", text: "hello" }) as object;
    expect(decode(inheritedType)).toEqual({
      ok: false, type: undefined, reason: "unknown-type",
    });
    const inheritedText = Object.create({ text: "hello" }) as { type?: string };
    inheritedText.type = "user_message";
    refuses(inheritedText);
  });

  it("is not fooled by a JSON `__proto__` key", () => {
    // `JSON.parse` materialises `__proto__` as an OWN property rather than
    // setting the prototype, so this object's real `text` is still absent.
    const poisoned = JSON.parse('{"type":"user_message","__proto__":{"text":"hello"}}') as unknown;
    refuses(poisoned);
    // And nothing leaked into the global prototype on the way through.
    expect(({} as { text?: unknown }).text).toBeUndefined();
  });
});

describe("#246 half A — decodeInboundWsMessage: user_message", () => {
  it("requires `text` to be a string", () => {
    accepts({ type: "user_message", text: "" });
    refuses({ type: "user_message" });
    refuses({ type: "user_message", text: null });
    refuses({ type: "user_message", text: 42 });
    refuses({ type: "user_message", text: ["hello"] });
  });

  it("admits an ABSENT id — older clients send none — but refuses a present-but-unusable one", () => {
    accepts({ type: "user_message", text: "hi" });
    accepts({ type: "user_message", text: "hi", id: "wire-1" });
    // ⚠️ THE THREE SHAPES THE STORE REFUSES AT ITS OWN MECHANISM — `append`
    // throws on an empty (and a non-string, via the same `typeof` test) `user`
    // id, and `journalEventForInboundUser` throws on all three at the mapper
    // door. Refusing them here means the wire cannot present one.
    refuses({ type: "user_message", text: "hi", id: "" });
    refuses({ type: "user_message", text: "hi", id: null });
    refuses({ type: "user_message", text: "hi", id: ["a"] });
  });

  it("bounds the id at MAX_INBOUND_USER_ID_LENGTH — the same bound the journal seam applies", () => {
    accepts({ type: "user_message", text: "hi", id: "a".repeat(MAX_INBOUND_USER_ID_LENGTH) });
    refuses({ type: "user_message", text: "hi", id: "a".repeat(MAX_INBOUND_USER_ID_LENGTH + 1) });
  });

  it("applies the same rule to `random_id` — it is the ingress dedupe key", () => {
    accepts({ type: "user_message", text: "hi", random_id: "r-1" });
    refuses({ type: "user_message", text: "hi", random_id: "" });
    refuses({ type: "user_message", text: "hi", random_id: 7 });
    refuses({
      type: "user_message", text: "hi",
      random_id: "r".repeat(MAX_INBOUND_USER_ID_LENGTH + 1),
    });
  });

  it("does NOT strip unknown fields — that is `normalizeInboundUserMessage`'s job, at a different door", () => {
    // The decoder answers "is this frame well-formed", not "what may a peer
    // supply". `coalescedIds` is plugin-internal and is stripped downstream; if
    // this test ever goes red because the decoder started rebuilding frames, the
    // additive-wire property went with it.
    const raw = { type: "user_message", text: "hi", coalescedIds: ["x"] };
    const result = decodeInboundWsMessage(raw);
    expect(result.ok).toBe(true);
    expect(result.ok && (result.message as unknown as { coalescedIds?: unknown }).coalescedIds)
      .toEqual(["x"]);
  });
});

describe("#246 half A — decodeInboundWsMessage: approval_decision (moved guard, same rule)", () => {
  it("accepts each of the three real decisions", () => {
    for (const decision of ["allow-once", "allow-always", "deny"]) {
      accepts({ type: "approval_decision", id: "exec-1", decision });
    }
  });

  it("refuses a non-string id and a decision outside the union", () => {
    // The two conditions `dispatchInbound` used to apply, verbatim.
    refuses({ type: "approval_decision", id: 42, decision: "deny" });
    refuses({ type: "approval_decision", decision: "deny" });
    refuses({ type: "approval_decision", id: "exec-1", decision: "bogus" });
    refuses({ type: "approval_decision", id: "exec-1" });
    refuses({ type: "approval_decision", id: "exec-1", decision: null });
  });

  it("keeps the old check's exact tolerance: an EMPTY id still passes", () => {
    // `typeof message.id !== "string"` was the whole id rule, so `""` was
    // admitted and is admitted still. Named rather than tightened: this decoder
    // moved the guard, it did not renegotiate it, and an approval id that is
    // undecidable downstream is a different (approvals) question.
    accepts({ type: "approval_decision", id: "", decision: "deny" });
  });
});

describe("#246 half A — decodeInboundWsMessage: load_history", () => {
  it("accepts the cursor shapes the wire declares, including all-absent", () => {
    accepts({ type: "load_history" });
    accepts({ type: "load_history", before: "row-1" });
    accepts({ type: "load_history", before: "tool-1", beforeTurnId: "turn-b", limit: 10 });
  });

  it("refuses a non-string cursor or a non-number limit", () => {
    refuses({ type: "load_history", before: {} });
    refuses({ type: "load_history", before: 5 });
    refuses({ type: "load_history", beforeTurnId: ["turn-b"] });
    refuses({ type: "load_history", limit: "10" });
    refuses({ type: "load_history", limit: [10] });
    refuses({ type: "load_history", limit: null });
  });

  it("ACCEPTS a fractional limit — `planHistoryFetch` floors it and serves a page", () => {
    // ⚠️ REGRESSION PIN. An earlier revision of this decoder required
    // `Number.isSafeInteger`, which is a SEMANTIC rule, not a shape check: the
    // client's public `loadHistory({ limit?: number })` types `20.5` as legal and
    // `planHistoryFetch` serves it as a 20-row page (`Math.floor`), so the door
    // was dropping a legal request with a warn and "load older" never returned.
    accepts({ type: "load_history", limit: 20.5 });
  });

  it("leaves the RANGE and every non-finite value to planHistoryFetch", () => {
    // Shape only: a negative, absurd, `NaN` or `Infinity` limit is a semantic
    // question the pager owns, and it already answers all of them — its predicate
    // is `typeof … === "number" && Number.isFinite(…) && … > 0`, so anything else
    // falls back to the configured page size instead of faulting. A cursor naming
    // no row is likewise an honest empty page, not a protocol error. Duplicating
    // either rule here would be a second schema free to disagree with the first.
    accepts({ type: "load_history", limit: -1 });
    accepts({ type: "load_history", limit: 0 });
    accepts({ type: "load_history", limit: Number.NaN });
    accepts({ type: "load_history", limit: Number.POSITIVE_INFINITY });
    accepts({ type: "load_history", limit: 1_000_000 });
    accepts({ type: "load_history", before: "no-such-row" });
  });
});

describe("#246 half A — decodeInboundWsMessage: get_difference (moved guard, same rule)", () => {
  it("accepts a non-negative integer afterSeq with a usable nonce", () => {
    accepts({ type: "get_difference", afterSeq: 0, nonce: "n0" });
    accepts({ type: "get_difference", afterSeq: 42, nonce: "a".repeat(128) });
  });

  it("refuses everything `delivery-journal.read` cannot take", () => {
    refuses({ type: "get_difference", nonce: "n0" });
    refuses({ type: "get_difference", afterSeq: -1, nonce: "n0" });
    refuses({ type: "get_difference", afterSeq: 1.5, nonce: "n0" });
    refuses({ type: "get_difference", afterSeq: "3", nonce: "n0" });
    refuses({ type: "get_difference", afterSeq: Number.NaN, nonce: "n0" });
    refuses({ type: "get_difference", afterSeq: null, nonce: "n0" });
  });

  it("#356 — refuses a request with no usable nonce: it could not be correlated", () => {
    // The nonce is what a device matches the reply against on the shared `.out`.
    // A request without one can only be answered ambiguously, so it is refused at
    // the door rather than answered into the void.
    refuses({ type: "get_difference", afterSeq: 0 });
    refuses({ type: "get_difference", afterSeq: 0, nonce: "" });
    refuses({ type: "get_difference", afterSeq: 0, nonce: 7 });
    refuses({ type: "get_difference", afterSeq: 0, nonce: null });
    // Bounded like the other two client-supplied tokens: it is echoed verbatim
    // into the reply, so its bytes come out of that reply's payload budget.
    refuses({ type: "get_difference", afterSeq: 0, nonce: "a".repeat(129) });
  });
});

describe("#246 half A — decodeInboundWsMessage: load_commands", () => {
  it("needs nothing beyond the type, and ignores anything else the peer attaches", () => {
    accepts({ type: "load_commands" });
    accepts({ type: "load_commands", limit: 5 });
  });
});
