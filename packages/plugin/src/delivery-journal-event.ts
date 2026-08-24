/**
 * v6 delivery-render — WIRE FRAME → JOURNAL EVENT (issue #239, doc §15.3).
 *
 * The plugin is the Telegram *server*: it owns a durable store and the client is
 * a pure view of it (doc §0). This module is the PURE half of that store — it
 * decides which outbound frames are durable MESSAGES and what event each one
 * becomes. `delivery-journal.ts` persists what this returns; #239's second half
 * wires both into the egress and inbound-accept seams so that every durable
 * event is committed BEFORE its frame is published (persist-before-publish,
 * NOT-list N6, doc §16.2-2, which reverses v5 §15.8's commit-after).
 *
 * ⚠️ `JournalEvent` IS A MIRROR OF `DurableEvent`, NOT A SEPARATE MODEL.
 * `packages/client/src/durable-view-reducer.ts` is the AUTHORITY; the two must
 * stay structurally identical, because the whole v6 bet is that ONE pure reducer
 * computes BOTH the live view and history (`history == live` BY CONSTRUCTION,
 * doc §15.4). Two shapes that drift are two reducers, and a server-side
 * projection free to invent its own ordering/supersession rule is exactly the
 * regression this redesign exists to kill (N8).
 *
 * There is no shared package yet and creating one is NOT in this slice: #240 is
 * where the plugin actually RUNS the reducer, and it unifies the two. Until then
 * the mirror is held by two things, both in `delivery-journal-event.test.ts`:
 *  - a compile-time MUTUAL-ASSIGNABILITY assertion between `JournalEvent` and
 *    the client's `DurableEvent` (imported by cross-package source path, the
 *    established pattern — see `durable-view-reducer-contract.test.ts`), which
 *    is what actually goes red on a divergence;
 *  - a runtime enumeration of each kind's FIELD NAMES, so the divergence is also
 *    greppable by someone reading the failure rather than the types.
 *
 * ⚠️ AND DO NOT READ "it isn't in `JournalEvent`" AS "it is non-durable by
 * design" — that is NOT-list N3/N7, and BOUNDARY 2 of the reducer says the event
 * set WILL grow (doc §15.9 requires tool and reasoning messages to become
 * durable MESSAGES; only pure indicators stay ephemeral). Every `null` below
 * carries its reason, and the ones owned by #242 say "not yet" rather than "no".
 */
import type { OutboundWsMessage } from "./channel-contract.js";

/**
 * The ordered event stream the plugin journals. Structural mirror of
 * `DurableEvent` in `packages/client/src/durable-view-reducer.ts` — see the
 * file header before changing a single field name.
 */
export type JournalEvent =
  | { kind: "user"; id: string; text: string; turnId?: string }
  | { kind: "placement"; answerId: string; turnId?: string }
  | { kind: "bubble"; answerId: string; text: string; turnId?: string }
  | {
      kind: "seal";
      turnId: string;
      answers: Array<{ id: string; text: string }>;
      remove?: string[];
    };

/**
 * A durable agent frame's id, or `undefined` when the frame carries none.
 *
 * ONE definition of "id-less", used by both the mapper and
 * `isIdlessDurableFrame`, so the predicate can never disagree with the branch it
 * is supposed to describe.
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
function durableFrameId(id: string | undefined): id is string {
  return id !== undefined && id.length > 0;
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
  return frame.type === "agent_message" && !durableFrameId(frame.id);
}

/**
 * Map one outbound frame to the event the journal must persist, or `null` when
 * the frame is not (or not yet) a durable message.
 *
 * The `switch` is EXHAUSTIVE by construction: the `default` assigns `frame` to
 * `never`, so a new `OutboundWsMessage` variant is a COMPILE ERROR here rather
 * than a silently unjournaled message.
 */
export function journalEventForOutbound(
  frame: OutboundWsMessage,
): JournalEvent | null {
  switch (frame.type) {
    case "agent_message":
      // The durable agent bubble. `""` and absent are both refused — see
      // `durableFrameId` and `isIdlessDurableFrame`.
      return durableFrameId(frame.id)
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
      // NOT YET durable — #242. §15.9 requires reasoning content that belongs in
      // the transcript to become a durable message; the 4-kind model cannot
      // express it, so it is absent, not exempt (N3/N7).
      return null;
    case "tool_activity":
      // NOT YET durable — #242. Same as `reasoning`: Telegram preserves service
      // messages and so must we; the event model has to grow first.
      return null;
    case "approval_request":
      // NOT YET durable — #242. An approval is a MESSAGE by §15.9's
      // message-vs-indicator test, not an indicator.
      return null;
    case "approval_resolved":
      // NOT YET durable — #242. It is the state change of the message above.
      return null;
    case "approval_snapshot":
      // NOT YET durable — #242. Also a REPLAY of approvals the store already
      // owns once #242 lands; see the `history` case for why replays are not
      // journaled.
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
 * Exported alongside the outbound mapper so half 2 has nothing to invent at the
 * accept seam: doc §15.7 makes the plugin the ONLY SSOT for user messages, so
 * this event is the durable record of the accept, written before the ack.
 */
export function journalEventForInboundUser(input: {
  id: string;
  text: string;
  turnId?: string;
}): JournalEvent {
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
