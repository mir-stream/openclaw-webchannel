/**
 * v6 #239 — the frame→event mapper.
 *
 * ⚠️ THIS FILE USED TO CARRY THE MIRROR GUARD TOO, AND IT IS GONE BECAUSE THE
 * THING IT GUARDED NO LONGER EXISTS. `JournalEvent` was a second declaration
 * structurally identical to the client's `DurableEvent`, held together by a
 * compile-time STRICT TYPE-IDENTITY assertion here. #240 turned the plugin into
 * a RUNTIME consumer of the client's reducer (`journal-history.ts`), so
 * `delivery-journal-event.ts` now ALIASES `DurableEvent` outright — one type,
 * one reducer, `history == live` by construction (N8) with nothing left to
 * drift. Against an alias the assertion reads `Equals<T, T>`: it cannot fail,
 * and a guard that cannot fail is worse than no guard, because a file header can
 * cite it as coverage. Deleted for exactly the reason the `Object.keys` guard
 * before it was deleted — that argument is written out at length in
 * `delivery-journal-event.ts`'s header. Do not reinstate either one.
 */
import { describe, expect, it } from "vitest";

import type { OutboundWsMessage } from "./channel-contract.js";
import {
  isIdlessDurableFrame,
  isSeqBearingFrame,
  journalEventForInboundUser,
  journalEventForOutbound,
} from "./delivery-journal-event.js";

const TURN = "turn-1";

describe("journalEventForOutbound maps the durable frames", () => {
  it("maps an id-bearing agent_message to a bubble", () => {
    expect(
      journalEventForOutbound({
        type: "agent_message",
        text: "final answer",
        id: "a-7",
        turnId: TURN,
        assistantMessageIndex: 3,
      }),
    ).toEqual({
      kind: "bubble",
      answerId: "a-7",
      text: "final answer",
      turnId: TURN,
    });
  });

  it("maps a progress frame to a placement WITHOUT its rolling draft text", () => {
    // §15.9: the rolling "Working…" draft is an INDICATOR, not a message. The
    // durable text is authored later by a bubble or a seal.
    const event = journalEventForOutbound({
      type: "progress",
      id: "a-7",
      text: "Working…",
      turnId: TURN,
    });
    expect(event).toEqual({ kind: "placement", answerId: "a-7", turnId: TURN });
    expect(JSON.stringify(event)).not.toContain("Working");
  });

  it("maps a turn_snapshot to a seal, copying answers and remove", () => {
    const answers = [{ id: "a-7", text: "one" }];
    const remove = ["a-8"];
    const event = journalEventForOutbound({
      type: "turn_snapshot",
      turnId: TURN,
      answers,
      remove,
    });
    expect(event).toEqual({
      kind: "seal",
      turnId: TURN,
      answers: [{ id: "a-7", text: "one" }],
      remove: ["a-8"],
    });
    // Copied, not aliased: the caller mutating the frame afterwards must not
    // reach into an event the journal is about to persist.
    expect((event as { answers: unknown }).answers).not.toBe(answers);
    expect((event as { remove: unknown }).remove).not.toBe(remove);
    // ⚠️ THE ELEMENT CHECK, NOT JUST THE ARRAY CHECK. `answers: [...frame.answers]`
    // is a shallow copy that still aliases every element object, and it passes
    // the array-identity line above while completely falsifying the mapper's
    // "self-contained value the caller cannot mutate" claim. `.map()` is what
    // makes that claim true, and this is the line that requires it.
    expect(
      (event as { answers: Array<{ id: string }> }).answers[0],
    ).not.toBe(answers[0]);
  });

  it("omits turnId entirely when the wire omitted it", () => {
    // Not `turnId: undefined`: JSON.stringify drops that, so an always-present
    // key would make the appended event and the one read back differ.
    const bubble = journalEventForOutbound({
      type: "agent_message",
      text: "no turn",
      id: "a-7",
    });
    expect(Object.keys(bubble as object)).toEqual(["kind", "answerId", "text"]);
    const placement = journalEventForOutbound({
      type: "progress",
      id: "a-7",
      text: "Working…",
    });
    expect(Object.keys(placement as object)).toEqual(["kind", "answerId"]);
  });
});

describe('journalEventForOutbound and the "" pair (reducer BOUNDARY 1)', () => {
  it('KEEPS answerId "" for a placement — the client keys progress on `id ?? ""`', () => {
    expect(
      journalEventForOutbound({ type: "progress", id: "", text: "x", turnId: TURN }),
    ).toEqual({ kind: "placement", answerId: "", turnId: TURN });
  });

  it('REFUSES answerId "" for a bubble — the client branches on `if (id)`', () => {
    // The natural mapper writes `answerId: frame.id ?? ""` for both sites,
    // mirroring the progress case. That collapses N id-less finals into ONE
    // durable row while live shows N bubbles (N8).
    const frame: OutboundWsMessage = {
      type: "agent_message",
      text: "final",
      id: "",
      turnId: TURN,
    };
    expect(journalEventForOutbound(frame)).toBeNull();
    expect(isIdlessDurableFrame(frame)).toBe(true);
  });
});

describe("an id-less agent_message is not persisted, and IS observable", () => {
  const idless: OutboundWsMessage = {
    type: "agent_message",
    text: "an id-less final",
    turnId: TURN,
  };

  it("returns null rather than minting a server-side id", () => {
    // Post-#238 this frame is a REGRESSION, not a case to handle: the frame is
    // about to be published to the client, which mints its own local `a-<n>`, so a
    // journal row under a different id is the very N8 divergence this store
    // exists to kill. #243 is the real repair (mint BEFORE egress).
    expect(journalEventForOutbound(idless)).toBeNull();
  });

  it("is reported by isIdlessDurableFrame so half 2 can log it at error", () => {
    expect(isIdlessDurableFrame(idless)).toBe(true);
  });

  it("does not flag anything else as an id-less durable frame", () => {
    expect(
      isIdlessDurableFrame({ type: "progress", id: "", text: "x" }),
    ).toBe(false);
    expect(
      isIdlessDurableFrame({ type: "agent_message", text: "t", id: "a-1" }),
    ).toBe(false);
    expect(isIdlessDurableFrame({ type: "typing" })).toBe(false);
  });
});

/**
 * #242 half 1 — reasoning is durable, ONE ROW PER BURST.
 *
 * The controller sends a `reasoning` frame on every cumulative token update,
 * each carrying the whole text so far, so the flag is what stands between this
 * mapper and O(n²) bytes per burst. These cases pin both sides of it, and pin
 * that the admission rule is the LIVE CLIENT'S rule — anything else is a
 * live≠history divergence created right here.
 */
/**
 * #242 half 1 — THE OUTER GATE: does this account journal reasoning at all?
 *
 * `capabilities.reasoningDurable` defaults OFF, so these cases are about the
 * permission rather than about the frame. They are kept in their own describe,
 * ahead of the content rules below, because the two answer different questions
 * and merging them is exactly how the live lane and the on-disk record got
 * conflated in the first place.
 */
describe("journalEventForOutbound — the reasoningDurable gate (#242 half 1)", () => {
  const closing: OutboundWsMessage = {
    type: "reasoning",
    id: "r-1",
    turnId: TURN,
    text: "the whole thought",
    final: true,
  };

  it("journals NOTHING when the policy is absent — the shipped default", () => {
    // A caller that forgets the policy journals LESS, never more.
    expect(journalEventForOutbound(closing)).toBeNull();
    expect(journalEventForOutbound(closing, {})).toBeNull();
  });

  it("journals NOTHING when reasoningDurable is false or malformed", () => {
    expect(journalEventForOutbound(closing, { reasoningDurable: false })).toBeNull();
    for (const value of ["true", 1, {}, null, undefined]) {
      expect(
        journalEventForOutbound(closing, {
          reasoningDurable: value as unknown as boolean,
        }),
        `reasoningDurable: ${JSON.stringify(value)} must not open the journal`,
      ).toBeNull();
    }
  });

  it("does not gate any OTHER durable kind — the flag is reasoning-only", () => {
    // Non-vacuity for the whole describe: if the gate were placed wrong (say, in
    // `journalOutbound` instead of this case) it would silence bubbles too, and
    // every reasoning assertion above would still pass.
    const bubble = journalEventForOutbound({
      type: "agent_message",
      id: "a-1",
      text: "hi",
      turnId: TURN,
    });
    expect(bubble).toEqual({ kind: "bubble", answerId: "a-1", text: "hi", turnId: TURN });
    expect(
      journalEventForOutbound({ type: "progress", id: "a-1", text: "…", turnId: TURN }),
    ).toEqual({ kind: "placement", answerId: "a-1", turnId: TURN });
  });
});

describe("journalEventForOutbound — reasoning content rules (#242 half 1)", () => {
  const closing: OutboundWsMessage = {
    type: "reasoning",
    id: "r-1",
    turnId: TURN,
    text: "the whole thought",
    final: true,
  };
  /**
   * ⚠️ EVERY CASE BELOW OPTS IN EXPLICITLY, AND THAT IS LOAD-BEARING. These
   * assert the CONTENT rules — `final`, id, turnId, text. Without the opt-in the
   * refusals would all pass for the wrong reason (the outer gate), and the file
   * would claim to check the `final` distinction while checking nothing.
   */
  const DURABLE = { reasoningDurable: true } as const;

  it("maps the burst-closing frame to a reasoning event", () => {
    expect(journalEventForOutbound(closing, DURABLE)).toEqual({
      kind: "reasoning",
      id: "r-1",
      turnId: TURN,
      text: "the whole thought",
    });
  });

  it("does not carry `final` into the event — being final is WHY there is one", () => {
    expect(Object.keys(journalEventForOutbound(closing, DURABLE) as object)).toEqual([
      "kind",
      "id",
      "turnId",
      "text",
    ]);
  });

  it("refuses a live cumulative draft, whether the flag is absent or false", () => {
    // The O(n²) case: one row per token, each holding the whole burst.
    const { final: _final, ...draft } = closing;
    expect(journalEventForOutbound(draft as OutboundWsMessage, DURABLE)).toBeNull();
    expect(journalEventForOutbound({ ...closing, final: false }, DURABLE)).toBeNull();
  });

  it("refuses a closing frame with no usable id", () => {
    expect(journalEventForOutbound({ ...closing, id: "" }, DURABLE)).toBeNull();
    // The wire validates nothing at runtime; a JSON client sends `null` for
    // "absent", and a missing key arrives as `undefined`.
    expect(
      journalEventForOutbound({ ...closing, id: undefined as unknown as string }, DURABLE),
    ).toBeNull();
    expect(
      journalEventForOutbound({ ...closing, id: null as unknown as string }, DURABLE),
    ).toBeNull();
  });

  it("refuses a closing frame with no usable turnId", () => {
    // Not optional here, unlike on bubble/placement: the wire types
    // `reasoning.turnId` as `string`, the reducer's reasoning variant requires
    // it, and the live client DROPS a reasoning frame that lacks one — so a row
    // without it would be history showing what live never rendered.
    expect(journalEventForOutbound({ ...closing, turnId: "" }, DURABLE)).toBeNull();
    expect(
      journalEventForOutbound({ ...closing, turnId: undefined as unknown as string }, DURABLE),
    ).toBeNull();
  });

  it("refuses empty or non-string text, exactly as the live client does", () => {
    // `nats-client-wrapper.ts`'s `case "reasoning"` returns early on
    // `typeof msg.text !== "string" || msg.text.length === 0`. Journaling what
    // the client refuses to render is N8 in the gaining direction.
    expect(journalEventForOutbound({ ...closing, text: "" }, DURABLE)).toBeNull();
    expect(
      journalEventForOutbound({ ...closing, text: undefined as unknown as string }, DURABLE),
    ).toBeNull();
  });
});

describe("journalEventForOutbound returns null for every non-durable frame", () => {
  // ONE case per `OutboundWsMessage` variant, so the list is visibly exhaustive
  // against `channel-contract.ts`. A new variant is already a COMPILE error in
  // the mapper's `default`; this table is what makes the RUNTIME classification
  // reviewable.
  //
  // ⚠️ `null` here is never evidence that a frame is non-durable BY DESIGN
  // (NOT-list N3/N7). What is left in this table after #242 half 4 is: ID-LESS
  // forms of frames that ARE durable, genuine indicators/control frames, and
  // `approval_snapshot`, which is a replay. No row here is a deferred slice any
  // more — §15.9's durable list is complete.
  const nonDurable: Array<[string, OutboundWsMessage]> = [
    // A LIVE CUMULATIVE DRAFT — no `final`. #242 half 1 made reasoning durable,
    // but only the burst-closing frame; see the dedicated describe below for the
    // durable side and for why the split exists.
    ["reasoning without final (a live draft)", { type: "reasoning", id: "r-1", turnId: TURN, text: "thinking" }],
    // ⚠️ `tool_activity` IS DURABLE SINCE #242 half 3, so what stands here is its
    // ID-LESS form only — refused for the same reason an id-less `agent_message`
    // is, since a row under no identity cannot be reconciled. Exactly ONE entry,
    // like `reasoning`'s draft shape above and for the same mechanical reason:
    // `covered` below compares sorted arrays against a list naming each type
    // once, so a second entry would break that count. The turnId-less form and
    // the durable cases live in the dedicated describe further down.
    ["tool_activity with no id (durable otherwise)", { type: "tool_activity", id: "", turnId: TURN, name: "bash" }],
    // ⚠️ THE TWO APPROVAL FRAMES ARE DURABLE SINCE #242 half 4, so what stands
    // here is their ID-LESS form only — same treatment, and same one-entry-per-
    // type constraint, as `tool_activity` above. Their durable cases live in the
    // dedicated describe further down.
    [
      "approval_request with no id (durable otherwise)",
      {
        type: "approval_request",
        id: "",
        kind: "exec",
        title: "run",
        prompt: "ok?",
        options: [{ decision: "allow-once", label: "Allow", style: "primary" }],
      },
    ],
    ["approval_resolved with no id (durable otherwise)", { type: "approval_resolved", id: "", decision: "deny" }],
    // ⚠️ `approval_snapshot` STAYS, AND IT IS THE ONE ROW HERE THAT IS NOT
    // "not yet". It is a server→client REPLAY of state this store already holds
    // — journaling it would write the store's own output back into the store,
    // duplicating the `approval`/`approvalResolution` rows. Not scheduled, ever.
    ["approval_snapshot (a REPLAY — never durable, not deferred)", { type: "approval_snapshot", approvals: [] }],
    ["turn_settled (control frame)", { type: "turn_settled", turnId: TURN, outcome: "ok" }],
    ["typing (pure indicator)", { type: "typing" }],
    ["history (server→client replay)", { type: "history", messages: [] }],
    ["commands (catalog, not a message)", { type: "commands", commands: [] }],
    ["ack (transport control)", { type: "ack", ids: ["u-0"] }],
    ["inbound_rejected (transport control)", { type: "inbound_rejected", ids: ["u-0"], reason: "overloaded" }],
    // #244 half B: a `difference` is a server→client REPLAY of events the store
    // already holds — journaling it would write the store's own output back in,
    // exactly like `history`. NOT seq-bearing either (the drift describe pins that).
    ["difference (a REPLAY — never durable)", { type: "difference", afterSeq: 0, nonce: "n0", events: [], partial: false, maxSeq: 0 }],
    // #245 Part B: a `user_committed` is the multi-device BROADCAST of a user event
    // the store ALREADY committed (`appendInboundUser`) — journaling it would write
    // the store's own output back in, exactly like `difference`/`history`. NOT
    // seq-bearing either (its seq is set at construction, not stamped by sendToPeer).
    ["user_committed (a BROADCAST of an already-committed event)", { type: "user_committed", id: "webchannel-user-1", text: "hi", seq: 1 }],
  ];

  it.each(nonDurable)("%s", (_label, frame) => {
    // ⚠️ RUN WITH reasoningDurable ON, DELIBERATELY. The table's reasoning row
    // is a live draft, and under the shipped default-OFF it would come back
    // `null` for the WRONG reason — the account gate rather than the missing
    // `final` flag — leaving the row asserting nothing about drafts. Opting in
    // makes each row say what it claims: even for an account that DOES store
    // reasoning, none of these frames is a durable message.
    expect(journalEventForOutbound(frame, { reasoningDurable: true })).toBeNull();
  });

  it("keeps the null-table's frame types matching a hand-listed union", () => {
    // ⚠️ WHAT THIS DOES AND DOES NOT DO. It compares two HAND-MAINTAINED lists —
    // the `nonDurable` table's frame types plus the three durable ones, against
    // the literal list below. It does NOT read `OutboundWsMessage`, so it cannot
    // notice a new wire variant on its own, and despite the old name it does not
    // check "exactly once" either (both sides are sorted arrays; a duplicate on
    // one side simply has to appear on the other).
    //
    // The real exhaustiveness guarantee is the mapper's `default: const _never:
    // never = frame`, which makes a new variant a COMPILE error. This case earns
    // its place only as the reminder that lands next to that compile error: when
    // tsc points at the mapper, this list is the other place to update.
    // `reasoning` is deliberately NOT here. It is durable ONLY with
    // `final: true` (#242 half 1), and the `nonDurable` table above carries its
    // draft shape — so it appears exactly once in `covered`, which is what this
    // comparison needs. Its durable side is covered by its own describe.
    const durableTypes = ["agent_message", "progress", "turn_snapshot"];
    const covered = [
      ...durableTypes,
      ...nonDurable.map(([, frame]) => frame.type),
    ].sort();
    expect(covered).toEqual(
      [
        "ack",
        "agent_message",
        "approval_request",
        "approval_resolved",
        "approval_snapshot",
        "commands",
        "difference",
        "history",
        "inbound_rejected",
        "progress",
        "reasoning",
        "tool_activity",
        "turn_settled",
        "turn_snapshot",
        "typing",
        "user_committed",
      ].sort(),
    );
  });
});

describe("#242 half 3 — tool_activity is durable, EVERY frame, no policy gate", () => {
  /**
   * ⚠️ THE MEASURED FRAME TRIPLE. Recorded by driving `inbound.ts`'s
   * `createAgentToolActivitySink` with a `start`/`update`/`end` event sequence on
   * the `tool` stream; it is not invented. The property it pins is that the
   * CLOSING frame carries `status` but NEITHER `name` NOR `argKeys`, which is
   * what rules out a `final`-style flag: journaling only that frame would store a
   * nameless, argKey-less call.
   */
  const START: OutboundWsMessage = {
    type: "tool_activity",
    id: "call-1",
    turnId: TURN,
    name: "read_file",
    phase: "start",
    argKeys: ["path", "limit"],
  };
  const UPDATE: OutboundWsMessage = {
    type: "tool_activity",
    id: "call-1",
    turnId: TURN,
    phase: "update",
  };
  const END: OutboundWsMessage = {
    type: "tool_activity",
    id: "call-1",
    turnId: TURN,
    phase: "end",
    status: "completed",
  };

  it("journals the frame VERBATIM as a delta — every one of the three", () => {
    expect(journalEventForOutbound(START)).toEqual({
      kind: "tool",
      id: "call-1",
      turnId: TURN,
      name: "read_file",
      phase: "start",
      argKeys: ["path", "limit"],
    });
    expect(journalEventForOutbound(UPDATE)).toEqual({
      kind: "tool",
      id: "call-1",
      turnId: TURN,
      phase: "update",
    });
    expect(journalEventForOutbound(END)).toEqual({
      kind: "tool",
      id: "call-1",
      turnId: TURN,
      phase: "end",
      status: "completed",
    });
  });

  it("the CLOSING frame alone is a PARTIAL — this is why there is no `final` flag", () => {
    // The regression guard for the whole design decision. If someone reworks
    // this case to journal only the terminal frame, THIS is what the journal
    // would hold for the call — and the live client rendered `read_file` with
    // its arg key names.
    const closing = journalEventForOutbound(END);
    expect(closing).not.toBeNull();
    expect(Object.hasOwn(closing!, "name")).toBe(false);
    expect(Object.hasOwn(closing!, "argKeys")).toBe(false);
    // And the opening frame is the only one that carries them.
    expect(journalEventForOutbound(START)).toMatchObject({
      name: "read_file",
      argKeys: ["path", "limit"],
    });
  });

  it("omits an absent field as an ABSENT KEY, never an explicit undefined", () => {
    // Load-bearing: `applyTool` merges by spread, so a present-and-`undefined`
    // `name` on the closing frame would ERASE the one `start` carried.
    expect(Object.keys(journalEventForOutbound(UPDATE)!).sort()).toEqual(
      ["id", "kind", "phase", "turnId"].sort(),
    );
  });

  it("is journaled with NO policy — tool durability has no account opt-in", () => {
    // Unlike reasoning, whose row is withheld unless `reasoningDurable` is on.
    //
    // ⚠️ EACH CALL IS COMPARED AGAINST A LITERAL, NEVER AGAINST ANOTHER CALL OF
    // THE SAME FUNCTION. This case used to read
    // `expect(journalEventForOutbound(START, {})).toEqual(journalEventForOutbound(START))`,
    // which asserts nothing: both sides move together, so introducing an
    // opt-OUT (`if (policy?.toolDurable === false) return null;`) would turn
    // both into `null` and leave the case green — the exact regression its name
    // promises to catch. The literal is what makes a withheld row fail.
    const row = {
      kind: "tool",
      id: "call-1",
      turnId: TURN,
      name: "read_file",
      phase: "start",
      argKeys: ["path", "limit"],
    };
    expect(journalEventForOutbound(START)).toEqual(row);
    expect(journalEventForOutbound(START, {})).toEqual(row);
    expect(journalEventForOutbound(START, { reasoningDurable: false })).toEqual(row);
    expect(journalEventForOutbound(START, { reasoningDurable: true })).toEqual(row);
  });

  it("filters argKeys to strings — the wire is untrusted and this reaches disk", () => {
    expect(
      journalEventForOutbound({
        type: "tool_activity",
        id: "call-1",
        turnId: TURN,
        argKeys: ["ok", 7, null, { a: 1 }, "fine"] as unknown as string[],
      }),
    ).toEqual({ kind: "tool", id: "call-1", turnId: TURN, argKeys: ["ok", "fine"] });
  });

  it("REFUSES a frame with no usable id or turnId — a row needs an identity", () => {
    // The admission rule tracks the client's `case "tool_activity"` exactly, so
    // nothing is journaled that the live client refuses.
    expect(
      journalEventForOutbound({ type: "tool_activity", id: "", turnId: TURN }),
    ).toBeNull();
    expect(
      journalEventForOutbound({ type: "tool_activity", id: "call-1", turnId: "" }),
    ).toBeNull();
  });
});

describe("journalEventForInboundUser", () => {
  it("builds the user event the accept seam journals", () => {
    expect(
      journalEventForInboundUser({ id: "u-0", text: "hi", turnId: TURN }),
    ).toEqual({ kind: "user", id: "u-0", text: "hi", turnId: TURN });
  });

  it("omits turnId when there is none", () => {
    expect(
      Object.keys(journalEventForInboundUser({ id: "u-0", text: "hi" })),
    ).toEqual(["kind", "id", "text"]);
  });

  it("THROWS on a non-string id with a NAMED error, not a TypeError", () => {
    // `user_message.id` is `id?: string` on the wire and the wire validates
    // nothing; a JSON client sends `null` for "absent". These used to reach
    // `.length` (bare `TypeError: Cannot read properties of null`) or pass the
    // guard entirely and fail later at SQLite bind time — either way defeating
    // the reason this is a function: a NAMED failure.
    for (const id of [null, 7, ["a"], { length: 3 }, undefined]) {
      expect(() =>
        journalEventForInboundUser({ id: id as unknown as string, text: "hi" }),
      ).toThrow(/requires a non-empty string id/);
    }
  });

  it("THROWS on an id longer than the 128-char ingress bound", () => {
    // Same bound and same reason as `ingress-dedupe.ts`'s `ingressDedupeKey`,
    // this plugin's established handling of exactly this field. An unbounded
    // client id is amplified three times per row (payload copy, indexed
    // `message_id` copy, unique-index entry), so fifty 1 MB ids are ~150 MB.
    expect(() =>
      journalEventForInboundUser({ id: "z".repeat(129), text: "hi" }),
    ).toThrow(/at most 128 characters \(received 129\)/);
    expect(() =>
      journalEventForInboundUser({ id: "z".repeat(1_000_000), text: "hi" }),
    ).toThrow(/at most 128 characters/);
    // Exactly at the bound is fine.
    expect(
      journalEventForInboundUser({ id: "z".repeat(128), text: "hi" }).kind,
    ).toBe("user");
  });

  it("does NOT bound the length of a plugin-minted agent id", () => {
    // The asymmetry is deliberate: agent ids are ours, and treating an over-long
    // one as id-less would drop DELIVERED text from the journal (N10). Only the
    // client-supplied inbound id is bounded.
    const longAgentId = "a".repeat(1_000);
    expect(
      journalEventForOutbound({
        type: "agent_message",
        text: "final",
        id: longAgentId,
      }),
    ).toEqual({ kind: "bubble", answerId: longAgentId, text: "final" });
    expect(
      isIdlessDurableFrame({ type: "agent_message", text: "t", id: longAgentId }),
    ).toBe(false);
  });

  it("THROWS on an empty id rather than journaling one", () => {
    // `user_message.id` is optional, client-supplied and unvalidated on the
    // wire. Two DIFFERENT user messages under `""` collide on the
    // `journal_user_once` index; the second append returns `inserted: false`,
    // which this store's contract tells the accept seam to read as an ordinary
    // non-destructive retry (§15.8). The second message's text would be gone
    // from the only SSOT user messages have (§15.7).
    expect(() => journalEventForInboundUser({ id: "", text: "first" })).toThrow(
      /requires a non-empty string id/,
    );
  });

  it("uses the SAME id-less notion as the durable-frame branch", () => {
    // One predicate behind both, so they cannot drift on what `""` means.
    expect(isIdlessDurableFrame({ type: "agent_message", text: "t", id: "" })).toBe(
      true,
    );
    expect(() => journalEventForInboundUser({ id: "", text: "t" })).toThrow();
    expect(
      isIdlessDurableFrame({ type: "agent_message", text: "t", id: "u-0" }),
    ).toBe(false);
    expect(journalEventForInboundUser({ id: "u-0", text: "t" }).kind).toBe("user");
  });
});

describe("#242 half 4 — the approval frames are durable, TWO events, no policy gate", () => {
  const request = {
    type: "approval_request",
    id: "ap-1",
    kind: "exec",
    title: "Run a command",
    description: "The agent wants to run a shell command.",
    prompt: "Run a command: rm -rf /tmp/scratch",
    options: [
      { decision: "allow-once", label: "Allow once", style: "success" },
      { decision: "deny", label: "Deny", style: "danger" },
    ],
    expiresAtMs: 1_900_000_000_000,
  } as unknown as OutboundWsMessage;

  it("maps `approval_request` to an `approval` event, renaming the payload's own kind", () => {
    // ⚠️ `approvalKind`, NOT `kind`. The payload calls it `kind` and so does the
    // event union's DISCRIMINANT; carrying it verbatim (or spreading
    // `...request`) would collide the two meanings on one key and make the union
    // undiscriminable. Pinned because a spread is the natural thing to write.
    expect(journalEventForOutbound(request)).toEqual({
      kind: "approval",
      id: "ap-1",
      approvalKind: "exec",
      title: "Run a command",
      description: "The agent wants to run a shell command.",
      prompt: "Run a command: rm -rf /tmp/scratch",
      options: [
        { decision: "allow-once", label: "Allow once", style: "success" },
        { decision: "deny", label: "Deny", style: "danger" },
      ],
      expiresAtMs: 1_900_000_000_000,
    });
  });

  it("maps `approval_resolved` to a SEPARATE append-only event, never an edit", () => {
    expect(
      journalEventForOutbound({
        type: "approval_resolved",
        id: "ap-1",
        decision: "allow-once",
      } as unknown as OutboundWsMessage),
    ).toEqual({ kind: "approvalResolution", id: "ap-1", decision: "allow-once" });
  });

  it("has NO account opt-in — `reasoningDurable: false` still journals both", () => {
    // The decision, made checkable: unlike reasoning and like tool, approval
    // durability is not gated on `capabilities.reasoningDurable`. The argument
    // is at the mapper's `approval_request` case and is made from the payload's
    // own content — a card is a message the user was SHOWN and ACTED ON, and its
    // absence would erase the record of their consent.
    expect(journalEventForOutbound(request, { reasoningDurable: false })).not.toBeNull();
    expect(
      journalEventForOutbound(
        { type: "approval_resolved", id: "ap-1", decision: "deny" } as unknown as OutboundWsMessage,
        { reasoningDurable: false },
      ),
    ).not.toBeNull();
  });

  it("omits an absent optional rather than writing an explicit `undefined`", () => {
    // `JSON.stringify` drops an `undefined` value, so an always-present key makes
    // the in-memory event and the one read back out of the journal structurally
    // different objects. Same rule as the tool arm.
    const event = journalEventForOutbound({
      type: "approval_request",
      id: "ap-2",
      kind: "plugin",
      title: "T",
      prompt: "P",
      options: [],
    } as unknown as OutboundWsMessage);
    expect(Object.keys(event ?? {}).sort()).toEqual(
      ["approvalKind", "id", "kind", "options", "prompt", "title"].sort(),
    );
  });
});

/**
 * #244 half A — DRIFT GUARD: `isSeqBearingFrame` must accept EXACTLY the frame
 * types `journalEventForOutbound` maps to a non-null event.
 *
 * ⚠️ THIS IS THE COMPILE-TIME-ANCHORED LINK the inline `sendToPeer` disjunction
 * lacked. `isSeqBearingFrame` decides which frames get a `seq` stamped, and
 * `journalEventForOutbound` decides which frames consume one — if those sets ever
 * diverge, a durable frame allocates a seq that never rides the wire (or a
 * non-durable one claims a seq it never got), which is the exact phantom gap #244
 * exists to prevent, and nothing else would catch it.
 *
 * `SAMPLES` is a `Record<OutboundWsMessage["type"], …>`, so adding a NEW frame
 * variant to the wire union is a COMPILE ERROR here until a canonical sample is
 * supplied — which forces this guard to weigh in on every future type. Each
 * durable sample is its maximally-journaled variant (reasoning `final: true`,
 * usable ids), driven with `reasoningDurable: true`, so "predicate accepts it"
 * and "mapper journals it" line up type-for-type.
 */
describe("#244 half A — isSeqBearingFrame tracks the mapper's non-null set", () => {
  const SAMPLES: Record<OutboundWsMessage["type"], OutboundWsMessage> = {
    // DURABLE — mapper returns non-null, predicate must accept.
    agent_message: { type: "agent_message", text: "a", id: "a-1", turnId: TURN },
    progress: { type: "progress", id: "a-1", text: "working", turnId: TURN },
    turn_snapshot: { type: "turn_snapshot", turnId: TURN, answers: [], remove: [] },
    reasoning: { type: "reasoning", id: "r-1", turnId: TURN, text: "t", final: true },
    tool_activity: { type: "tool_activity", id: "t-1", turnId: TURN, name: "grep" },
    approval_request: {
      type: "approval_request",
      id: "ap-1",
      kind: "exec",
      title: "T",
      prompt: "P",
      options: [],
    },
    approval_resolved: { type: "approval_resolved", id: "ap-1", decision: "allow-once" },
    // NON-DURABLE — mapper returns null, predicate must reject.
    turn_settled: { type: "turn_settled", turnId: TURN, outcome: "ok" },
    approval_snapshot: { type: "approval_snapshot", approvals: [] },
    typing: { type: "typing" },
    history: { type: "history", messages: [] },
    commands: { type: "commands", commands: [] },
    ack: { type: "ack", ids: [] },
    inbound_rejected: { type: "inbound_rejected", ids: [], reason: "overloaded" },
    // #244 half B — a REPLAY frame; mapper returns null, predicate must reject.
    difference: { type: "difference", afterSeq: 0, nonce: "n0", events: [], partial: false, maxSeq: 0 },
    // #245 Part B — a BROADCAST of an already-committed event; mapper returns null,
    // predicate must reject (its seq is set at construction, not stamped here).
    user_committed: { type: "user_committed", id: "webchannel-user-1", text: "hi", seq: 1 },
  };

  it("accepts a frame IFF the mapper journals it, over every wire type", () => {
    for (const frame of Object.values(SAMPLES)) {
      const journaled =
        journalEventForOutbound(frame, { reasoningDurable: true }) !== null;
      expect(isSeqBearingFrame(frame)).toBe(journaled);
    }
  });

  it("the seq-bearing set is exactly the seven durable outbound frame types", () => {
    const seqBearing = Object.values(SAMPLES)
      .filter((frame) => isSeqBearingFrame(frame))
      .map((frame) => frame.type)
      .sort();
    expect(seqBearing).toEqual(
      [
        "agent_message",
        "approval_request",
        "approval_resolved",
        "progress",
        "reasoning",
        "tool_activity",
        "turn_snapshot",
      ].sort(),
    );
  });
});
