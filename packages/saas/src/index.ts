/**
 * WebChannel SaaS trust chain core — public API.
 *
 * This package provides:
 *   - setupTrustChain: One-time offline initialization of the SaaS trust root
 *   - DeviceFlowEnrollment: RFC 8628 device flow enrollment for plugins
 *   - Type exports: Trust chain artifacts and enrollment types
 *
 * USAGE:
 *   import { setupTrustChain, DeviceFlowEnrollment } from '@mir-stream/webchannel-saas';
 *
 *   const trustChain = await setupTrustChain({
 *     operatorName: 'my-saas-operator',
 *     accountName: 'tenant-123',
 *   });
 *
 *   // Store trustChain.private securely (SaaS-only)
 *   // Load trustChain.natsConfig into nats-server
 *   // Publish trustChain.jwks at JWKS endpoint
 *
 *   const enrollment = new DeviceFlowEnrollment({
 *     saasTrustChain: trustChain.private,
 *     natsAccountConfig: trustChain.natsConfig,
 *     saasBaseUrl: 'https://saas.com',
 *     jwksUrl: 'https://saas.com/.well-known/jwks.json',
 *     bootstrapUrl: 'https://saas.com/bootstrap',
 *   });
 */

export { setupTrustChain } from "./setup-trust-chain.js";
export { generateRsaKeypair } from "./setup-trust-chain.js";
export { loadOrCreateTrustChain } from "./persistent-trust-chain.js";
export {
  prepareFullResolverNatsConfig,
  renderFullResolverNatsConfig,
  type FullResolverNatsConfigOptions,
  type PrepareFullResolverNatsConfigOptions,
  type PreparedFullResolverNatsConfig,
} from "./nats-server-config.js";
export {
  DeviceFlowEnrollment,
  EnrollmentValidationError,
  type ApproveOutcome,
} from "./device-flow-enrollment.js";
export {
  agentKeyRegistryKey,
  type ActivationId,
  type AgentKeyId,
  type AgentKeyRecord,
  type AgentKeyRegistry,
  type RegisterAgentKeyResult,
} from "./agent-key-registry.js";
export {
  MemoryEnrollmentRepository,
  UserCodeCollisionError,
  DeviceCodeCollisionError,
  CommitPayloadMismatchError,
  type EnrollmentRepository,
  type MemoryEnrollmentRepositoryOptions,
  type ClaimApprovalOutcome,
  type CommitApprovalPayload,
  type CommitApprovalOutcome,
  type TryExpireOutcome,
  type ReconcileOutcome,
} from "./enrollment-repository.js";
export { runAgentKeyRegistryConformance } from "./agent-key-registry-conformance.js";
export {
  runEnrollmentRepositoryConformance,
  enrollmentRepositoryConformanceCases,
  interpose,
  barrier,
  type InterposeHooks,
  type EnrollmentRepositoryFaultControl,
  type EnrollmentRepositoryConformanceOptions,
  type EnrollmentRepositoryConformanceCase,
  type EnrollmentRepositoryConformanceReport,
} from "./enrollment-repository-conformance.js";
export { buildBootstrapClaims } from "./bootstrap-claims.js";
export type {
  BootstrapClaims,
  BootstrapClaimsInput,
  DeviceCnfJwk,
  DevicePopJwk,
} from "./bootstrap-claims.js";
// 0.1.2 additive public API: RS256 bootstrap-JWT signer + browser NATS creds.
export { createBootstrapIssuer, type BootstrapIssuer } from "./bootstrap-issuer.js";
export {
  issueBrowserCredentials,
  type BrowserCredentials,
  type IssueBrowserCredentialsOptions,
} from "./nats-user-creds.js";
export { addRevocation } from "./account-revocation.js";
export type {
  SetupTrustChainResult,
  SaasTrustChainPrivate,
  NatsAccountConfig,
  NatsSelfContainedAccountConfig,
  NatsExternalAccountConfig,
  ExternalNatsAccount,
  JwksDocument,
  JwkRsaPublicKey,
} from "./types.js";
export type { SetupTrustChainOptions } from "./setup-trust-chain.js";
export type {
  EnrollmentRequest,
  EnrollmentResponse,
  PollRequest,
  PendingEnrollment,
  EnrollmentRecord,
  NatsUserCredentials,
  EnrollmentResult,
  DeviceFlowError,
} from "./device-flow-types.js";
