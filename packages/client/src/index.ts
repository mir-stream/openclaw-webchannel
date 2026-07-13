/**
 * Public API for `@mir-stream/webchannel-client` — a framework-agnostic, zero-dependency
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
export { filterCommandCatalog } from "./command-filter.js";
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
  CommandCatalogEntry,
  CommandCatalogArg,
} from "./types.js";
// SaaS bootstrap key-pin validator — exported so a downstream host (rota-crew)
// can run a contract test against the client's ACTUAL bootstrap parsing logic
// instead of a re-implementation (F2 lesson: a silent seam break slipped past a
// type-only downstream CI). `parseBootstrapResponse` is a pure validator.
export {
  parseBootstrapResponse,
  parseAndStorePinnedKeys,
  type BootstrapPayload,
  type PinnedKeys,
  type CnfClaim,
  type CnfJwk,
} from "./saas-bootstrap.js";
// Wire-protocol version for the client↔plugin register handshake (see
// ./protocol.ts). Exported so a downstream host can assert lockstep.
export { WEBCHANNEL_PROTOCOL_VERSION } from "./protocol.js";
