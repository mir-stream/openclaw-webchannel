import { ANON_PEER_ID } from "./auth.js";
import type { CommandCatalogEntry } from "./commands-catalog.js";

export const WEBCHANNEL_ID = "webchannel";
export { ANON_PEER_ID };
/**
 * A hydrated transcript row on the wire.
 *
 * WHAT HYDRATION PRESERVES, and what it does not (#95). A reloaded timeline
 * carries role, text, order, row identity, and failure state — and NOTHING a
 * client derived while live. Specifically absent by design:
 *
 *  - `turnId`. The live turn id is the CLIENT's own `user_message.id`
 *    (`inbound.ts:220-222`); core never stores it, and no field on a stored
 *    message correlates two assistant messages to one agent turn. There is no
 *    value to put here, so grouping cannot survive a reload. See #114 for the
 *    mechanism that would change this.
 *  - `working`, `wireId`, `sendState` — live-only client state.
 *  - reasoning previews, typing, and tool progress — ephemeral by design
 *    (`docs/P1_REASONING_LANE_PLAN.md`), matching what Telegram does.
 *
 * `failed` is ADDITIVE and OMITTED WHEN FALSE; absent means "not failed".
 * Additive optional fields deliberately do NOT bump
 * `WEBCHANNEL_PROTOCOL_VERSION`: the handshake is strict equality with no
 * negotiation, so a bump hard-fails every deployed pair until both redeploy.
 *
 * Full rationale: `docs/ISSUE_95_HISTORY_CONTRACT_PLAN.md`.
 */
export type HistoryMessage = {
  id: string;
  role: "user" | "agent";
  text: string;
  ts?: number;
  failed?: boolean;
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
  | { type: "agent_message"; text: string; id?: string; turnId?: string }
  | { type: "progress"; id: string; text: string; turnId?: string }
  | { type: "reasoning"; id: string; turnId: string; text: string }
  | { type: "turn_settled"; turnId: string; outcome: "ok" | "error" }
  | ({ type: "approval_request" } & ApprovalRequestPayload)
  | { type: "approval_resolved"; id: string; decision: ApprovalDecision }
  | { type: "approval_snapshot"; approvals: ApprovalRequestPayload[]; resolved?: Array<{ id: string; decision: ApprovalDecision }> }
  | { type: "typing" }
  | { type: "history"; messages: HistoryMessage[] }
  | { type: "commands"; commands: CommandCatalogEntry[] }
  | { type: "ack"; ids: string[] }
  | { type: "inbound_rejected"; ids: string[]; reason: "overloaded" };

export interface WebChannelPeerChannel {
  sendText(peerId: string, text: string, id?: string, turnId?: string): boolean;
  sendProgress(peerId: string, id: string, text: string, turnId?: string): boolean;
  finalizeDraft(peerId: string, id: string, text: string, turnId?: string): boolean;
  sendReasoning(peerId: string, id: string, turnId: string, text: string): boolean;
  sendTurnSettled(peerId: string, turnId: string, outcome: "ok" | "error"): boolean;
  sendTyping(peerId: string): boolean;
  sendHistory(peerId: string, messages: HistoryMessage[]): boolean;
  sendApprovalRequest(peerId: string, request: ApprovalRequestPayload): boolean;
  sendApprovalResolved(peerId: string, id: string, decision: ApprovalDecision): boolean;
  sendApprovalSnapshot(peerId: string, approvals: ApprovalRequestPayload[], resolved?: Array<{ id: string; decision: ApprovalDecision }>): boolean;
  sendAck?(peerId: string, ids: string[]): boolean;
  sendInboundRejected?(peerId: string, ids: string[]): boolean;
}

export class NullPeerChannel implements WebChannelPeerChannel {
  sendText(_peerId: string, _text: string, _id?: string, _turnId?: string): boolean { return false; }
  sendProgress(_peerId: string, _id: string, _text: string, _turnId?: string): boolean { return false; }
  finalizeDraft(_peerId: string, _id: string, _text: string, _turnId?: string): boolean { return false; }
  sendReasoning(_peerId: string, _id: string, _turnId: string, _text: string): boolean { return false; }
  sendTurnSettled(_peerId: string, _turnId: string, _outcome: "ok" | "error"): boolean { return false; }
  sendTyping(_peerId: string): boolean { return false; }
  sendHistory(_peerId: string, _messages: HistoryMessage[]): boolean { return false; }
  sendApprovalRequest(_peerId: string, _request: ApprovalRequestPayload): boolean { return false; }
  sendApprovalResolved(_peerId: string, _id: string, _decision: ApprovalDecision): boolean { return false; }
  sendApprovalSnapshot(_peerId: string, _approvals: ApprovalRequestPayload[], _resolved?: Array<{ id: string; decision: ApprovalDecision }>): boolean { return false; }
  sendAck(_peerId: string, ids: string[]): boolean { return ids.length === 0; }
  sendInboundRejected(_peerId: string, ids: string[]): boolean { return ids.length === 0; }
}
