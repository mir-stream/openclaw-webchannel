/**
 * Public API for `@mir-stream/webchannel-client` — a framework-agnostic, zero-dependency
 * browser client carrying WebChannel's *functionality* (NATS connection,
 * reconnect, wire protocol, progress drafts, approvals, transcript state)
 * WITHOUT React. Wrap it in any UI (vanilla DOM, Vue, or a thin React hook).
 */
export {
  WebChannelNATSClient,
  type WebChannelNATSClientOptions,
} from "./nats-client-wrapper.js";
export {
  generateDevicePopKeyPair,
  popSignedMessage,
  signPop,
  registerWithPop,
  unregisterWithPop,
  PopRejectedError,
  type PopOp,
  type DevicePopKeyPair,
  type DevicePopJwk,
  type RegisterWithPopOptions,
  type UnregisterWithPopOptions,
  type RegisterPublishFn,
} from "./pop-register.js";
// NOTE: `generateClientNonce` is deliberately NOT exported. The register
// freshness anchor has exactly one legitimate producer — `registerWithPop`,
// which mints one per attempt internally. Handing embedders a way to supply
// their own anchor invites reusing or persisting it, which is precisely the
// property the anchor exists to prevent.
export { filterCommandCatalog } from "./command-filter.js";
export type {
  ChatRole,
  ChatMessage,
  ReasoningItem,
  ApprovalDecision,
  ApprovalOption,
  ApprovalRequest,
  ConnectionStatus,
  WebChannelErrorCause,
  WebChannelState,
  WebChannelOptions,
  Listener,
  CommandCatalogEntry,
  CommandCatalogArg,
  // P0-4: the observable send-result contract.
  SendState,
  SendFailure,
  SendReceipt,
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
