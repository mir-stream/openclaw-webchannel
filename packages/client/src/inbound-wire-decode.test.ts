/**
 * #246 half A — the client's inbound wire decoder.
 *
 * `openMessage` returns `unknown` and both receive doors used to cast it to
 * `InboundMessage`, so an arbitrary JSON value reached every message listener,
 * the wrapper's reducer and its seq cursor. These pin what the decoder admits
 * and what it refuses, per frame type — and, just as deliberately, the places it
 * stays PERMISSIVE, because refusing a frame the plugin legitimately sends costs
 * a `get_difference` round-trip (or delivered content) rather than nothing.
 *
 * The cursor consequence of a refusal — the invariant that a seq-bearing frame
 * advances `lastAppliedSeq` iff it was folded — is pinned in
 * `nats-client-wrapper-gap-sync.test.ts`, against the wrapper.
 */

import { describe, it, expect } from "vitest";

import {
  KNOWN_INBOUND_TYPES,
  decodeDurableEvent,
  decodeInboundMessage,
  isCommittedEcho,
  isWireSeq,
} from "./inbound-wire-decode.js";

function decode(raw: unknown): { ok: true } | { ok: false; type: unknown; reason: string } {
  const result = decodeInboundMessage(raw);
  if (result.ok) return { ok: true };
  return result.failure.kind === "unknown-type"
    ? { ok: false, type: result.failure.type, reason: "unknown-type" }
    : { ok: false, type: result.failure.type, reason: result.failure.reason };
}

const accepts = (raw: unknown) => expect(decode(raw)).toEqual({ ok: true });
const refuses = (raw: unknown) => expect(decode(raw).ok).toBe(false);

/** One valid frame per known type — the positive control for every case below. */
const VALID: Record<string, unknown> = {
  agent_message: { type: "agent_message", id: "a1", text: "final", turnId: "t1", seq: 2 },
  progress: { type: "progress", id: "a1", text: "working…", turnId: "t1", seq: 1 },
  reasoning: { type: "reasoning", id: "r1", turnId: "t1", text: "thinking", seq: 3 },
  tool_activity: { type: "tool_activity", id: "c1", turnId: "t1", name: "bash", argKeys: ["cmd"], seq: 4 },
  turn_settled: { type: "turn_settled", turnId: "t1", outcome: "ok" },
  turn_snapshot: { type: "turn_snapshot", turnId: "t1", answers: [{ id: "a1", text: "final" }], remove: [], seq: 5 },
  approval_request: { type: "approval_request", id: "x1", kind: "exec", title: "t", prompt: "p", options: [], seq: 6 },
  approval_resolved: { type: "approval_resolved", id: "x1", decision: "deny", seq: 7 },
  approval_snapshot: { type: "approval_snapshot", approvals: [], resolved: [] },
  typing: { type: "typing" },
  history: { type: "history", messages: [], highWaterSeq: 9 },
  commands: { type: "commands", commands: [] },
  ack: { type: "ack", ids: ["u-0"], committed: [{ random_id: "r-1", messageId: "m-1", seq: 8 }] },
  inbound_rejected: { type: "inbound_rejected", ids: ["u-0"], reason: "overloaded" },
  user_committed: { type: "user_committed", id: "webchannel-user-2", text: "hi", turnId: "t1", seq: 2, random_id: "r-1" },
  difference: { type: "difference", events: [] },
};

describe("#246 half A — decodeInboundMessage: the frame envelope", () => {
  it("accepts one valid frame of every known type", () => {
    // The table covers the exported set exactly — a new inbound type cannot be
    // added without deciding what a valid one looks like.
    expect(Object.keys(VALID).sort()).toEqual([...KNOWN_INBOUND_TYPES].sort());
    for (const frame of Object.values(VALID)) accepts(frame);
  });

  it("refuses an unknown type and names it for the log line", () => {
    expect(decode({ type: "wat" })).toEqual({ ok: false, type: "wat", reason: "unknown-type" });
    expect(decode({ type: 7 })).toEqual({ ok: false, type: 7, reason: "unknown-type" });
    expect(decode({ id: "a1" })).toEqual({ ok: false, type: undefined, reason: "unknown-type" });
  });

  it("refuses a payload that is not an object", () => {
    for (const raw of [null, undefined, 5, "typing", true, [], [VALID.typing]]) {
      expect(decode(raw)).toEqual({ ok: false, type: undefined, reason: "unknown-type" });
    }
  });

  it("reads OWN properties only, and is not fooled by a JSON `__proto__` key", () => {
    expect(decode(Object.create({ type: "typing" }) as object)).toEqual({
      ok: false, type: undefined, reason: "unknown-type",
    });
    const poisoned = JSON.parse('{"type":"agent_message","__proto__":{"text":"x"}}') as unknown;
    refuses(poisoned);
    expect(({} as { text?: unknown }).text).toBeUndefined();
  });

  it("refuses any `seq` that could move the cursor somewhere no real seq can reach", () => {
    // The cursor is a monotone high-water: a bad value here is worse than a
    // missing one, because everything after it is gated out in silence.
    for (const seq of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2, "3", null]) {
      refuses({ ...(VALID.agent_message as object), seq });
    }
    accepts({ ...(VALID.agent_message as object), seq: 0 });
    // ABSENT is fine and is not a gap: a live reasoning draft and an id-less
    // agent_message both ride the wire without one.
    const { seq: _seq, ...noSeq } = VALID.agent_message as { seq: number };
    accepts(noSeq);
  });

  it("refuses a non-string id/turnId/text on any frame that carries one", () => {
    refuses({ ...(VALID.agent_message as object), id: 7 });
    refuses({ ...(VALID.agent_message as object), turnId: {} });
    refuses({ ...(VALID.progress as object), text: 5 });
  });
});

describe("#246 half A — decodeInboundMessage: the durable frames", () => {
  it("agent_message requires text but tolerates an absent id (the legacy mint path)", () => {
    const { id: _id, ...noId } = VALID.agent_message as { id: string };
    accepts(noId);
    const { text: _text, ...noText } = VALID.agent_message as { text: string };
    refuses(noText);
    refuses({ ...(VALID.agent_message as object), text: null });
  });

  it("progress stays PERMISSIVE — `\"\"` and an absent id are both real", () => {
    // The journal records a progress id VERBATIM including `""`, and the handler
    // keys on `id ?? ""`. Refusing either would make the live view disagree with
    // the difference-folded one for a row the store can hold.
    accepts({ type: "progress", id: "", text: "working…", turnId: "t1", seq: 1 });
    accepts({ type: "progress", text: "working…", turnId: "t1", seq: 1 });
    accepts({ type: "progress", id: "a1", turnId: "t1", seq: 1 });
    // Still a shape check: a non-string id is not an id.
    refuses({ type: "progress", id: 7, text: "working…", seq: 1 });
  });

  it("reasoning requires non-empty id, turnId and text — the journal's own admission rule", () => {
    refuses({ type: "reasoning", id: "", turnId: "t1", text: "x" });
    refuses({ type: "reasoning", id: "r1", turnId: "", text: "x" });
    refuses({ type: "reasoning", id: "r1", turnId: "t1", text: "" });
    refuses({ type: "reasoning", id: "r1", turnId: "t1" });
    // A live cumulative DRAFT (no `final`, no `seq`) is an ordinary frame.
    accepts({ type: "reasoning", id: "r1", turnId: "t1", text: "half a thought" });
  });

  it("tool_activity requires the (id, turnId) pair applyTool upserts on", () => {
    refuses({ type: "tool_activity", id: "", turnId: "t1" });
    refuses({ type: "tool_activity", id: "c1", turnId: "" });
    refuses({ type: "tool_activity", id: "c1" });
    refuses({ type: "tool_activity", id: "c1", turnId: "t1", argKeys: "cmd" });
    refuses({ type: "tool_activity", id: "c1", turnId: "t1", phase: 3 });
    // The delta shape: everything but the pair may be absent.
    accepts({ type: "tool_activity", id: "c1", turnId: "t1" });
  });

  it("turn_snapshot requires a turnId and well-shaped arrays, tolerating their absence", () => {
    refuses({ type: "turn_snapshot", turnId: "", answers: [] });
    refuses({ type: "turn_snapshot", answers: [] });
    refuses({ type: "turn_snapshot", turnId: "t1", answers: [{ id: "a1" }] });
    refuses({ type: "turn_snapshot", turnId: "t1", answers: "a1" });
    refuses({ type: "turn_snapshot", turnId: "t1", remove: [7] });
    // An empty seal is an accepted no-op, not a malformed frame.
    accepts({ type: "turn_snapshot", turnId: "t1" });
  });

  it("user_committed requires the committed row's identity and text", () => {
    refuses({ type: "user_committed", id: "", text: "hi", seq: 2 });
    refuses({ type: "user_committed", text: "hi", seq: 2 });
    refuses({ type: "user_committed", id: "webchannel-user-2", seq: 2 });
    refuses({ type: "user_committed", id: "webchannel-user-2", text: 5, seq: 2 });
  });
});

describe("#246 half A — decodeInboundMessage: the approval frames", () => {
  it("approval_request refuses an id-less card and a mistyped payload", () => {
    refuses({ ...(VALID.approval_request as object), id: "" });
    refuses({ ...(VALID.approval_request as object), kind: "shell" });
    refuses({ ...(VALID.approval_request as object), title: 7 });
    refuses({ ...(VALID.approval_request as object), options: "allow" });
    refuses({ ...(VALID.approval_request as object), options: [null] });
    refuses({ ...(VALID.approval_request as object), expiresAtMs: "soon" });
    // Older servers omitted individual payload fields; the handler defaults them.
    accepts({ type: "approval_request", id: "x1" });
  });

  it("approval_request does NOT vet each button's decision", () => {
    // Deliberate: the card is what unblocks the turn, and the renderer only maps
    // over the entries. Dropping a prompt because one button carries a decision
    // this build does not know is strictly worse than passing it back verbatim.
    accepts({ ...(VALID.approval_request as object), options: [{ decision: "allow-later", label: "L", style: "s" }] });
  });

  it("approval_resolved DOES vet the decision — it is folded into durable state", () => {
    for (const decision of ["allow-once", "allow-always", "deny"]) {
      accepts({ type: "approval_resolved", id: "x1", decision });
    }
    refuses({ type: "approval_resolved", id: "x1", decision: "unknown" });
    refuses({ type: "approval_resolved", id: "x1" });
    refuses({ type: "approval_resolved", id: "", decision: "deny" });
  });

  it("approval_snapshot is checked at the envelope only", () => {
    refuses({ type: "approval_snapshot", approvals: "none" });
    refuses({ type: "approval_snapshot", approvals: [7] });
    refuses({ type: "approval_snapshot", resolved: {} });
    // The per-entry rules stay in the reconciliation's three legs.
    accepts({ type: "approval_snapshot" });
    accepts({ type: "approval_snapshot", approvals: [{ id: "x1" }], resolved: [{ id: "x2" }] });
  });
});

describe("#246 half A — decodeInboundMessage: the bulk frames", () => {
  it("history requires a messages ARRAY and a usable high-water", () => {
    refuses({ type: "history" });
    refuses({ type: "history", messages: {} });
    refuses({ type: "history", messages: [], highWaterSeq: -1 });
    refuses({ type: "history", messages: [], highWaterSeq: "9" });
    // Rows are NOT re-validated here — `case "history"` discriminates the row
    // union variant by variant, and a second schema would be free to disagree.
    accepts({ type: "history", messages: [{ nonsense: true }] });
  });

  it("difference requires an events ARRAY and leaves each event to the fold", () => {
    refuses({ type: "difference", events: {} });
    accepts({ type: "difference" });
    accepts({ type: "difference", events: [{ seq: 1, event: { kind: "nonsense" } }] });
  });

  it("commands and inbound_rejected are checked at the envelope", () => {
    refuses({ type: "commands", commands: "help" });
    refuses({ type: "inbound_rejected", ids: "u-0" });
    refuses({ type: "inbound_rejected", ids: [7] });
    accepts({ type: "commands" });
    accepts({ type: "inbound_rejected", ids: [] });
  });

  it("ack refuses the WHOLE frame when a committed entry is malformed", () => {
    refuses({ type: "ack", ids: "u-0" });
    refuses({ type: "ack", ids: ["u-0"], committed: {} });
    refuses({ type: "ack", ids: ["u-0"], committed: [null] });
    refuses({ type: "ack", ids: ["u-0"], committed: [{ random_id: "", messageId: "m-1" }] });
    refuses({ type: "ack", ids: ["u-0"], committed: [{ random_id: "r-1", messageId: "" }] });
    refuses({ type: "ack", ids: ["u-0"], committed: [{ random_id: "r-1", messageId: "m-1", seq: -1 }] });
    refuses({ type: "ack", ids: ["u-0"], committed: [{ random_id: "r-1", messageId: "m-1", seq: Number.NaN }] });
    // ONE bad entry condemns the frame — see `isCommittedEcho` for why partial
    // acceptance is not on the table here.
    refuses({
      type: "ack",
      ids: ["u-0"],
      committed: [{ random_id: "r-1", messageId: "m-1", seq: 8 }, { random_id: "r-2" }],
    });
    // A pre-#244-half-A server echoed no seq; its acks must still adopt.
    accepts({ type: "ack", ids: ["u-0"], committed: [{ random_id: "r-1", messageId: "m-1" }] });
    accepts({ type: "ack", ids: [] });
    accepts({ type: "ack" });
  });
});

describe("#246 half A — isWireSeq / isCommittedEcho", () => {
  it("isWireSeq admits only a non-negative safe integer", () => {
    expect([0, 1, Number.MAX_SAFE_INTEGER].every(isWireSeq)).toBe(true);
    expect([-1, 1.5, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 2, "1", null, undefined]
      .some(isWireSeq)).toBe(false);
  });

  it("isCommittedEcho is the ONE rule the decoder, the adopt and the cursor share", () => {
    expect(isCommittedEcho({ random_id: "r-1", messageId: "m-1", seq: 3 })).toBe(true);
    expect(isCommittedEcho({ random_id: "r-1", messageId: "m-1" })).toBe(true);
    expect(isCommittedEcho({ random_id: "", messageId: "m-1" })).toBe(false);
    expect(isCommittedEcho({ random_id: "r-1", messageId: "" })).toBe(false);
    expect(isCommittedEcho({ random_id: "r-1", messageId: "m-1", seq: -1 })).toBe(false);
    expect(isCommittedEcho(null)).toBe(false);
    expect(isCommittedEcho("r-1")).toBe(false);
  });
});

describe("#246 half A — decodeDurableEvent: the difference fold's events", () => {
  const valid: Record<string, unknown> = {
    user: { kind: "user", id: "webchannel-user-2", text: "hi", turnId: "t1", randomId: "r-1" },
    placement: { kind: "placement", answerId: "a1", turnId: "t1" },
    bubble: { kind: "bubble", answerId: "a1", text: "final", turnId: "t1" },
    seal: { kind: "seal", turnId: "t1", answers: [{ id: "a1", text: "final" }], remove: [] },
    reasoning: { kind: "reasoning", id: "r1", turnId: "t1", text: "thinking" },
    tool: { kind: "tool", id: "c1", turnId: "t1", name: "bash", argKeys: ["cmd"] },
    approval: { kind: "approval", id: "x1", approvalKind: "exec", title: "t", prompt: "p", options: [] },
    approvalResolution: { kind: "approvalResolution", id: "x1", decision: "deny" },
    messageEdited: { kind: "messageEdited", id: "a1", text: "fixed", revision: 2 },
    messageDeleted: { kind: "messageDeleted", id: "a1", revision: 3 },
  };

  const bad = (event: unknown) => {
    const result = decodeDurableEvent(event);
    expect(result.ok).toBe(false);
    return result.ok ? "" : result.kind;
  };

  it("accepts one valid event of every kind the reducer folds", () => {
    for (const event of Object.values(valid)) {
      expect(decodeDurableEvent(event).ok).toBe(true);
    }
  });

  it("reports an UNKNOWN kind separately from a MALFORMED known one", () => {
    // The two get the same treatment by the caller (skip, advance) but not the
    // same diagnosis: unknown is version skew, malformed is a defect upstream.
    expect(bad({ kind: "quantum", id: "z" })).toBe("unknown-kind");
    expect(bad(null)).toBe("unknown-kind");
    expect(bad([{ kind: "bubble" }])).toBe("unknown-kind");
    expect(bad({ kind: ["bubble"], answerId: "a1", text: "x" })).toBe("unknown-kind");
    expect(bad({ kind: "bubble", answerId: "a1" })).toBe("malformed");
  });

  it("refuses every shape the fold arms would have dereferenced", () => {
    // ⚠️ `seal` IS THE ONE THAT THREW. `foldDifferenceEvent` iterates
    // `event.answers` and uses each entry's `id` as an overlay key BEFORE the
    // reducer sees the event, so a missing/mistyped `answers` was a TypeError
    // inside the fold — swallowed by the listener dispatch, wedging gap-sync.
    expect(bad({ kind: "seal", turnId: "t1" })).toBe("malformed");
    expect(bad({ kind: "seal", turnId: "t1", answers: "a1" })).toBe("malformed");
    expect(bad({ kind: "seal", turnId: "t1", answers: [null] })).toBe("malformed");
    expect(bad({ kind: "seal", turnId: "t1", answers: [{ id: "a1" }] })).toBe("malformed");
    expect(bad({ kind: "seal", turnId: "", answers: [] })).toBe("malformed");
    expect(bad({ kind: "seal", turnId: "t1", answers: [], remove: [7] })).toBe("malformed");
    // The rest of the arms, one refusal each.
    expect(bad({ kind: "user", id: "", text: "hi" })).toBe("malformed");
    expect(bad({ kind: "user", id: "u1" })).toBe("malformed");
    expect(bad({ kind: "user", id: "u1", text: "hi", randomId: 7 })).toBe("malformed");
    expect(bad({ kind: "placement", answerId: 7 })).toBe("malformed");
    expect(bad({ kind: "placement" })).toBe("malformed");
    expect(bad({ kind: "bubble", answerId: "", text: "x" })).toBe("malformed");
    expect(bad({ kind: "reasoning", id: "r1", turnId: "" , text: "x" })).toBe("malformed");
    expect(bad({ kind: "tool", id: "c1" })).toBe("malformed");
    expect(bad({ kind: "tool", id: "c1", turnId: "t1", argKeys: [7] })).toBe("malformed");
    expect(bad({ kind: "approval", id: "x1", approvalKind: "shell", title: "t", prompt: "p", options: [] })).toBe("malformed");
    expect(bad({ kind: "approval", id: "x1", approvalKind: "exec", title: "t", prompt: "p" })).toBe("malformed");
    expect(bad({ kind: "approvalResolution", id: "x1", decision: "maybe" })).toBe("malformed");
    expect(bad({ kind: "messageEdited", id: "a1", text: "x" })).toBe("malformed");
    expect(bad({ kind: "messageEdited", id: "a1", text: "x", revision: "2" })).toBe("malformed");
    expect(bad({ kind: "messageDeleted", id: "a1" })).toBe("malformed");
  });

  it("keeps `placement.answerId: \"\"` foldable where `bubble.answerId: \"\"` is not", () => {
    // Not an inconsistency: the journal records a progress id verbatim (`""`
    // included) and refuses an id-less durable frame. The validator tracks the
    // store, not a uniform rule.
    expect(decodeDurableEvent({ kind: "placement", answerId: "", turnId: "t1" }).ok).toBe(true);
    expect(decodeDurableEvent({ kind: "bubble", answerId: "", text: "x" }).ok).toBe(false);
  });

  it("reads OWN properties only", () => {
    const inherited = Object.create({ text: "final" }) as { kind?: string; answerId?: string };
    inherited.kind = "bubble";
    inherited.answerId = "a1";
    expect(bad(inherited)).toBe("malformed");
  });
});
