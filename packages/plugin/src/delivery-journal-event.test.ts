/**
 * v6 #239 — the frame→event mapper, and the mirror guard that keeps
 * `JournalEvent` structurally identical to the client's `DurableEvent`.
 *
 * The mirror matters more than any single mapping: the v6 bet is that ONE pure
 * reducer computes both the live view and history, so two event shapes that
 * drift are two reducers (N8). Until #240 unifies them into a shared module,
 * this file is the guard.
 */
import { describe, expect, it } from "vitest";

import type { OutboundWsMessage } from "./channel-contract.js";
import {
  isIdlessDurableFrame,
  journalEventForInboundUser,
  journalEventForOutbound,
  type JournalEvent,
} from "./delivery-journal-event.js";
import type { DurableEvent } from "../../client/src/durable-view-reducer.js";

const TURN = "turn-1";

/**
 * Strict type IDENTITY, not mutual assignability.
 *
 * ⚠️ MUTUAL ASSIGNABILITY IS NOT ENOUGH AND THAT WAS MEASURED, not reasoned:
 * `const a: DurableEvent = {} as JournalEvent` plus the reverse compiles CLEAN
 * when one side gains an OPTIONAL field, because an optional field is satisfied
 * by its absence in both directions. The field that will actually be added is
 * `revision?: number` (#241, doc §16.2-4) — optional, precisely the case the
 * weaker check is blind to.
 *
 * The `(<T>() => T extends X ? 1 : 2)` trick compares the two types as written
 * rather than by assignability, so an optional field on ONE side is a `tsc`
 * error. Proven to fire: adding `revision?: number` to `JournalEvent` produces
 *   error TS2344: Type 'false' does not satisfy the constraint 'true'.
 */
type Equals<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
    ? true
    : false;
type AssertTrue<T extends true> = T;
type _JournalEventMirrorsDurableEvent = AssertTrue<
  Equals<JournalEvent, DurableEvent>
>;

describe("JournalEvent mirrors the client's DurableEvent", () => {
  it("is TYPE-IDENTICAL to DurableEvent (compile-time mirror guard)", () => {
    // The guard itself is the `_JournalEventMirrorsDurableEvent` alias above —
    // it goes red in `tsc`, which is where a type divergence belongs. This case
    // exists so the guard is discoverable from the test list, and so a reader
    // who deletes the alias sees a named test disappear with it.
    const mirrored: DurableEvent = {
      kind: "bubble",
      answerId: "a-0",
      text: "answer",
      turnId: TURN,
    } satisfies JournalEvent;
    expect(mirrored.kind).toBe("bubble");
  });

  it("enumerates the FIELD NAMES of each kind, so a divergence is greppable", () => {
    // Every kind, fully populated (optional fields included). If this list stops
    // matching `durable-view-reducer.ts`'s `DurableEvent`, the compile-time
    // assertion above goes red first — this one exists so the failure NAMES the
    // field instead of printing a type error.
    const fullyPopulated: JournalEvent[] = [
      { kind: "user", id: "u-0", text: "hello", turnId: TURN },
      { kind: "placement", answerId: "a-0", turnId: TURN },
      { kind: "bubble", answerId: "a-0", text: "answer", turnId: TURN },
      {
        kind: "seal",
        turnId: TURN,
        answers: [{ id: "a-0", text: "answer" }],
        remove: ["a-1"],
      },
    ];
    const fieldsByKind = Object.fromEntries(
      fullyPopulated.map((event) => [event.kind, Object.keys(event).sort()]),
    );
    expect(fieldsByKind).toEqual({
      user: ["id", "kind", "text", "turnId"],
      placement: ["answerId", "kind", "turnId"],
      bubble: ["answerId", "kind", "text", "turnId"],
      seal: ["answers", "kind", "remove", "turnId"],
    });
    expect(Object.keys(fieldsByKind).sort()).toEqual([
      "bubble",
      "placement",
      "seal",
      "user",
    ]);
  });
});

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
    // Post-#238 this frame is a REGRESSION, not a case to handle: the frame has
    // already left for the client, which mints its own local `a-<n>`, so a
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

describe("journalEventForOutbound returns null for every non-durable frame", () => {
  // ONE case per `OutboundWsMessage` variant, so the list is visibly exhaustive
  // against `channel-contract.ts`. A new variant is already a COMPILE error in
  // the mapper's `default`; this table is what makes the RUNTIME classification
  // reviewable.
  //
  // ⚠️ `null` here is never evidence that a frame is non-durable BY DESIGN
  // (NOT-list N3/N7). The `#242` rows are "not yet".
  const nonDurable: Array<[string, OutboundWsMessage]> = [
    ["reasoning (#242: durable later)", { type: "reasoning", id: "r-1", turnId: TURN, text: "thinking" }],
    ["tool_activity (#242: durable later)", { type: "tool_activity", id: "t-1", turnId: TURN, name: "bash" }],
    [
      "approval_request (#242: durable later)",
      {
        type: "approval_request",
        id: "ap-1",
        kind: "exec",
        title: "run",
        prompt: "ok?",
        options: [{ decision: "allow-once", label: "Allow", style: "primary" }],
      },
    ],
    ["approval_resolved (#242: durable later)", { type: "approval_resolved", id: "ap-1", decision: "deny" }],
    ["approval_snapshot (#242: durable later)", { type: "approval_snapshot", approvals: [] }],
    ["turn_settled (control frame)", { type: "turn_settled", turnId: TURN, outcome: "ok" }],
    ["typing (pure indicator)", { type: "typing" }],
    ["history (server→client replay)", { type: "history", messages: [] }],
    ["commands (catalog, not a message)", { type: "commands", commands: [] }],
    ["ack (transport control)", { type: "ack", ids: ["u-0"] }],
    ["inbound_rejected (transport control)", { type: "inbound_rejected", ids: ["u-0"], reason: "overloaded" }],
  ];

  it.each(nonDurable)("%s", (_label, frame) => {
    expect(journalEventForOutbound(frame)).toBeNull();
  });

  it("covers every OutboundWsMessage variant exactly once", () => {
    const durableTypes = ["agent_message", "progress", "turn_snapshot"];
    const covered = [
      ...durableTypes,
      ...nonDurable.map(([, frame]) => frame.type),
    ].sort();
    // Mirrors the union in `channel-contract.ts`. A new wire variant makes the
    // mapper fail to compile; this keeps the TEST table from silently lagging.
    expect(covered).toEqual(
      [
        "ack",
        "agent_message",
        "approval_request",
        "approval_resolved",
        "approval_snapshot",
        "commands",
        "history",
        "inbound_rejected",
        "progress",
        "reasoning",
        "tool_activity",
        "turn_settled",
        "turn_snapshot",
        "typing",
      ].sort(),
    );
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

  it("THROWS on an empty id rather than journaling one", () => {
    // `user_message.id` is optional and client-supplied, and `""` is the
    // established fallback shape for it here — so `id: message.id ?? ""` is the
    // likely call. Two DIFFERENT user messages under `""` collide on the
    // `journal_user_once` index; the second append returns `inserted: false`,
    // which this store's contract tells the accept seam to read as an ordinary
    // non-destructive retry (§15.8). The second message's text would be gone
    // from the only SSOT user messages have (§15.7).
    expect(() => journalEventForInboundUser({ id: "", text: "first" })).toThrow(
      /requires a non-empty id/,
    );
    expect(() =>
      journalEventForInboundUser({
        id: undefined as unknown as string,
        text: "first",
      }),
    ).toThrow(/requires a non-empty id/);
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
