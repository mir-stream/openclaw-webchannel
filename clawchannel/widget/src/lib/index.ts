/**
 * Public API barrel for the reusable ClawChannel widget (future
 * `@clawchannel/widget`). Consumers import from here; everything else under
 * `lib/` is an internal implementation detail.
 */
export { useClawChannel } from "./useClawChannel.js";
export { Chat } from "./Chat.js";
export type {
  ChatRole,
  ChatMessage,
  ApprovalDecision,
  ApprovalOption,
  ApprovalRequest,
  ConnectionStatus,
  UseClawChannelOptions,
} from "./useClawChannel.js";
