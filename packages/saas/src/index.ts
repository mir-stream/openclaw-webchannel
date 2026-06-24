/**
 * WebChannel SaaS trust chain core — public API.
 *
 * This package provides:
 *   - setupTrustChain: One-time offline initialization of the SaaS trust root
 *   - DeviceFlowEnrollment: RFC 8628 device flow enrollment for plugins
 *   - Type exports: Trust chain artifacts and enrollment types
 *
 * USAGE:
 *   import { setupTrustChain, DeviceFlowEnrollment } from '@openclaw/webchannel-saas';
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
export { DeviceFlowEnrollment, MemoryEnrollmentStore, type EnrollmentStore } from "./device-flow-enrollment.js";
export type {
  SetupTrustChainResult,
  SaasTrustChainPrivate,
  NatsAccountConfig,
  JwksDocument,
  JwkRsaPublicKey,
  SetupTrustChainOptions,
} from "./types.js";
export type {
  EnrollmentRequest,
  EnrollmentResponse,
  PollRequest,
  PendingEnrollment,
  NatsUserCredentials,
  EnrollmentResult,
  DeviceFlowError,
} from "./device-flow-types.js";
