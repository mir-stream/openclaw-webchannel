/**
 * Public API for `openclaw-webchannel-client` — a framework-agnostic, zero-dependency
 * browser client carrying WebChannel's *functionality* (WS connection,
 * reconnect, wire protocol, progress drafts, approvals, transcript state)
 * WITHOUT React. Wrap it in any UI (vanilla DOM, Vue, or a thin React hook).
 */
export { WebChannelClient } from "./client.js";
export { WebChannelNATSClient } from "./nats-client-wrapper.js";
export {
  generateDevicePopKeyPair,
  popSignedMessage,
  signPop,
  registerWithPop,
  PopRejectedError,
  type DevicePopKeyPair,
  type DevicePopJwk,
  type RegisterWithPopOptions,
} from "./pop-register.js";
export type {
  ChatRole,
  ChatMessage,
  ApprovalDecision,
  ApprovalOption,
  ApprovalRequest,
  ConnectionStatus,
  WebChannelState,
  WebChannelOptions,
  Listener,
} from "./types.js";
