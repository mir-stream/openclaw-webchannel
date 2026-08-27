import { ANON_PEER_ID } from "./auth.js";
import type { CommandCatalogEntry } from "./commands-catalog.js";

export const WEBCHANNEL_ID = "webchannel";
export { ANON_PEER_ID };
/**
 * A normalized transcript row on the hydration wire.
 *
 * #95: hydration reproduces the role, sanitized text, order, row identity, and
 * optional timestamp present in this projection. It does not reproduce every
 * live-bubble property or every relationship available in the raw transcript.
 * Specifically absent:
 *
 *  - `turnId`. `handleInboundMessage` derives the live value from the client's
 *    `user_message.id`; that exact client-generated id is not available on the
 *    stored messages returned to this projection. Raw user boundaries and tool
 *    structure can still provide structural grouping evidence, but they cannot
 *    recover the exact live correlation id.
 *  - a terminal-turn failure verdict. `AssistantMessage.stopReason === "error"`
 *    describes a stored model attempt/message and may precede a successful
 *    retry or fallback. Textless or sanitized-away attempts produce no row, so
 *    the projection cannot expose a retry-safe terminal failure signal.
 *  - `working`, `wireId`, `sendState` — live-only client state.
 *  - reasoning previews, typing, and tool progress — ephemeral by design
 *    (`docs/P1_REASONING_LANE_PLAN.md`), matching what Telegram does.
 *
 * Full rationale: `docs/ISSUE_95_HISTORY_CONTRACT_PLAN.md`.
 */
export type HistoryMessage = {
  id: string;
  role: "user" | "agent";
  text: string;
  ts?: number;
};

export type ApprovalDecision = "allow-once" | "allow-always" | "deny";
export type ApprovalOption = { decision: ApprovalDecision; label: string; style: string };
export type ApprovalRequestPayload = {
  id: string;
  kind: "exec" | "plugin";
  title: string;
  description?: string;
  prompt: string;
  options: ApprovalOption[];
  expiresAtMs?: number;
};

export type InboundWsMessage =
  | { type: "user_message"; text: string; id?: string }
  | { type: "approval_decision"; id: string; decision: ApprovalDecision }
  | { type: "load_history"; before?: string; limit?: number }
  | { type: "load_commands" };

export type OutboundWsMessage =
  | {
      type: "agent_message";
      text: string;
      id?: string;
      turnId?: string;
      /**
       * Observed run/attempt-local ordinal for an authorized block delivery.
       * It can repeat after model fallback and is not a durable hydration key.
       */
      assistantMessageIndex?: number;
    }
  | { type: "progress"; id: string; text: string; turnId?: string }
  | {
      type: "reasoning";
      id: string;
      turnId: string;
      text: string;
      /**
       * #242 half 1 (doc §15.9/§16.2-5): THIS frame closes the reasoning burst.
       * Its `text` is the burst's DURABLE text, and it is the ONLY `reasoning`
       * frame the delivery journal records
       * (`delivery-journal-event.ts`'s `case "reasoning"`). Absent or `false`
       * means a LIVE CUMULATIVE DRAFT update — not durable, exactly as
       * `progress` is not durable.
       *
       * ⚠️ THE FLAG EXISTS BECAUSE THE LIVE STREAM IS UNTHROTTLED.
       * `message-adapter.ts`'s `createReasoningDraftController` sends one frame
       * per cumulative token update, each carrying the whole text so far, so
       * journaling every `reasoning` frame would write O(n²) bytes per burst.
       * With the flag a burst costs exactly one row.
       *
       * ADDITIVE AND OPTIONAL: an older client ignores the extra key and takes
       * the frame down its ordinary `reasoning` path. That path is NOT inert,
       * and calling it a "render no-op" understates it — what actually happens
       * is:
       *  - `upsertReasoning` replaces the entry under the SAME id with the SAME
       *    text, so the rendered reasoning list is unchanged in content;
       *  - `disarmStaleDraftsByTurn(turnId)` runs, which only DELETES ids from
       *    the client's stale-draft watch set — it touches no message;
       *  - `setState` fires, so subscribers see one extra notification.
       * The disarm is the only behavioural effect, and it is safe here because
       * of WHEN this frame is sent: every burst close happens inside the turn,
       * and `inbound.ts` emits this turn's `turn_settled` afterwards (its
       * `reasoning?.stop()` runs in the `finally`, before the settlement block),
       * so any draft this frame disarms is still finalized by the turn's own
       * terminal frame.
       *
       * The cost is one extra copy of the burst's text on the wire per burst,
       * and it is accepted.
       */
      final?: boolean;
    }
  | {
      type: "tool_activity";
      turnId: string;
      id: string;
      name?: string;
      phase?: string;
      status?: string;
      summary?: string;
      argKeys?: string[];
    }
  | { type: "turn_settled"; turnId: string; outcome: "ok" | "error" }
  /**
   * #212 (Phase 3, targeted): the plugin's authoritative, ordered set of the
   * turn's AGENT ANSWER bubbles, emitted at drain (after the buffered-final
   * flush, before `turn_settled`). `answers` is the answer lanes in the plugin's
   * generation order — `id` reuses a lane's materialized wire id or a freshly
   * minted id for a lane that streamed but never reached the wire (failed-frame
   * recovery); `text` is each lane's STREAMED answer text, immune to a
   * mis-routed final top-up. `remove` names the bubble ids the plugin KNOWS it
   * mis-routed answer content onto (overflow independents; recovery blocks whose
   * lane is now in `answers`). The client replaces ONLY these — every other
   * turn agent bubble (notices, errors, adopted history) is preserved. Additive
   * and safely ignorable by an old client (no protocol bump).
   */
  | {
      type: "turn_snapshot";
      turnId: string;
      answers: Array<{ id: string; text: string }>;
      remove: string[];
    }
  | ({ type: "approval_request" } & ApprovalRequestPayload)
  | { type: "approval_resolved"; id: string; decision: ApprovalDecision }
  | { type: "approval_snapshot"; approvals: ApprovalRequestPayload[]; resolved?: Array<{ id: string; decision: ApprovalDecision }> }
  | { type: "typing" }
  | { type: "history"; messages: HistoryMessage[] }
  | { type: "commands"; commands: CommandCatalogEntry[] }
  | { type: "ack"; ids: string[] }
  | { type: "inbound_rejected"; ids: string[]; reason: "overloaded" };

export interface WebChannelPeerChannel {
  sendText(
    peerId: string,
    text: string,
    id?: string,
    turnId?: string,
    assistantMessageIndex?: number,
  ): boolean;
  sendProgress(peerId: string, id: string, text: string, turnId?: string): boolean;
  finalizeDraft(
    peerId: string,
    id: string,
    text: string,
    turnId?: string,
    assistantMessageIndex?: number,
  ): boolean;
  /**
   * `final` marks the frame that CLOSES this burst — the only one the journal
   * records (#242 half 1). See the `reasoning` member of `OutboundWsMessage`.
   */
  sendReasoning(
    peerId: string,
    id: string,
    turnId: string,
    text: string,
    final?: boolean,
  ): boolean;
  sendToolActivity(
    peerId: string,
    activity: {
      id: string;
      turnId: string;
      name?: string;
      phase?: string;
      status?: string;
      summary?: string;
      argKeys?: string[];
    },
  ): boolean;
  sendTurnSettled(peerId: string, turnId: string, outcome: "ok" | "error"): boolean;
  sendTurnSnapshot(
    peerId: string,
    turnId: string,
    answers: Array<{ id: string; text: string }>,
    remove: string[],
  ): boolean;
  sendTyping(peerId: string): boolean;
  sendHistory(peerId: string, messages: HistoryMessage[]): boolean;
  sendApprovalRequest(peerId: string, request: ApprovalRequestPayload): boolean;
  sendApprovalResolved(peerId: string, id: string, decision: ApprovalDecision): boolean;
  sendApprovalSnapshot(peerId: string, approvals: ApprovalRequestPayload[], resolved?: Array<{ id: string; decision: ApprovalDecision }>): boolean;
  sendAck?(peerId: string, ids: string[]): boolean;
  sendInboundRejected?(peerId: string, ids: string[]): boolean;
}

export class NullPeerChannel implements WebChannelPeerChannel {
  sendText(_peerId: string, _text: string, _id?: string, _turnId?: string, _assistantMessageIndex?: number): boolean { return false; }
  sendProgress(_peerId: string, _id: string, _text: string, _turnId?: string): boolean { return false; }
  finalizeDraft(_peerId: string, _id: string, _text: string, _turnId?: string, _assistantMessageIndex?: number): boolean { return false; }
  sendReasoning(_peerId: string, _id: string, _turnId: string, _text: string, _final?: boolean): boolean { return false; }
  sendToolActivity(_peerId: string, _activity: { id: string; turnId: string; name?: string; phase?: string; status?: string; summary?: string; argKeys?: string[] }): boolean { return false; }
  sendTurnSettled(_peerId: string, _turnId: string, _outcome: "ok" | "error"): boolean { return false; }
  sendTurnSnapshot(_peerId: string, _turnId: string, _answers: Array<{ id: string; text: string }>, _remove: string[]): boolean { return false; }
  sendTyping(_peerId: string): boolean { return false; }
  sendHistory(_peerId: string, _messages: HistoryMessage[]): boolean { return false; }
  sendApprovalRequest(_peerId: string, _request: ApprovalRequestPayload): boolean { return false; }
  sendApprovalResolved(_peerId: string, _id: string, _decision: ApprovalDecision): boolean { return false; }
  sendApprovalSnapshot(_peerId: string, _approvals: ApprovalRequestPayload[], _resolved?: Array<{ id: string; decision: ApprovalDecision }>): boolean { return false; }
  sendAck(_peerId: string, ids: string[]): boolean { return ids.length === 0; }
  sendInboundRejected(_peerId: string, ids: string[]): boolean { return ids.length === 0; }
}
