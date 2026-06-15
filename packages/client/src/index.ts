/**
 * Public API for `@clawchannel/client` — a framework-agnostic, zero-dependency
 * browser client carrying ClawChannel's *functionality* (WS connection,
 * reconnect, wire protocol, progress drafts, approvals, transcript state)
 * WITHOUT React. Wrap it in any UI (vanilla DOM, Vue, or a thin React hook).
 */
export { ClawChannelClient } from "./client.js";
export type {
  ChatRole,
  ChatMessage,
  ApprovalDecision,
  ApprovalOption,
  ApprovalRequest,
  ConnectionStatus,
  ClawChannelState,
  ClawChannelOptions,
  Listener,
} from "./types.js";
