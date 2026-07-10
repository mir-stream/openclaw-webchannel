/**
 * Operator surface — imports ONLY from the published package name
 * `@mir-stream/webchannel-saas` (never a relative source path). This proves the
 * legitimate SaaS-operator flow is fully expressible through the public barrel:
 * build a trust chain, stand up a DeviceFlowEnrollment, and drive an
 * enroll -> approve -> poll cycle. It deliberately never touches raw
 * `mintNatsUserCreds` or `assertValidSubjectToken` — those stay unreachable, and
 * the enrollment object mints the correctly-scoped NATS creds internally.
 */

import {
  setupTrustChain,
  loadOrCreateTrustChain,
  DeviceFlowEnrollment,
  MemoryEnrollmentStore,
  buildBootstrapClaims,
  generateRsaKeypair,
  type SetupTrustChainResult,
  type SetupTrustChainOptions,
  type EnrollmentResult,
  type DeviceFlowError,
  type BootstrapClaims,
  type JwkRsaPublicKey,
} from "@mir-stream/webchannel-saas";

/** Rotate the JWKS signing key without rebuilding the whole trust chain. */
export async function rotateSigningKey(): Promise<JwkRsaPublicKey> {
  const { publicKeyJwk } = await generateRsaKeypair(2048);
  return publicKeyJwk;
}

/** One-time / load-or-create trust root init through the public API only. */
export async function initTrustChain(
  path: string,
  options: SetupTrustChainOptions = {},
): Promise<SetupTrustChainResult> {
  // Both entry points are barrel-reachable: fresh vs. persisted.
  const fresh = await setupTrustChain(options);
  const persisted = await loadOrCreateTrustChain(path, options);
  return persisted.kid ? persisted : fresh;
}

/**
 * Drive a full RFC-8628 enroll -> approve -> poll cycle against a freshly built
 * trust chain, using only public symbols. Returns the minted enrollment result.
 */
export async function runOperatorEnrollment(): Promise<EnrollmentResult> {
  const trustChain = await setupTrustChain({
    operatorName: "example-operator",
    accountName: "example-tenant",
  });

  const enrollment = new DeviceFlowEnrollment({
    saasTrustChain: trustChain.private,
    natsAccountConfig: trustChain.natsConfig,
    saasBaseUrl: "https://saas.example.com",
    jwksUrl: "https://saas.example.com/.well-known/jwks.json",
    bootstrapUrl: "https://saas.example.com/bootstrap",
    natsUrl: "wss://nats.example.com",
    store: new MemoryEnrollmentStore({ autoSweep: false }),
  });

  const started = await enrollment.enroll({
    // 43-char base64url of a 32-byte X25519 public key — the exact wire format
    // enroll() validates at ingress (real plugins send their identity key here).
    agentPublicKey: "EpK8GJc3BntN3yEwx5GtfQFyIilwIXaKsrWiqYNkzSo",
    accountId: "example-account",
    tenant: "example-tenant",
  });

  const approved = await enrollment.approve(started.user_code);
  if (!approved) {
    throw new Error("operator approval failed");
  }

  const result = await enrollment.poll({ device_code: started.device_code });
  if ("error" in result) {
    const err = result as DeviceFlowError;
    throw new Error(`poll failed: ${err.error}`);
  }
  return result;
}

/** Build a bootstrap-JWT claim object through the public builder. */
export function buildClaims(peerId: string, accountId: string): BootstrapClaims {
  return buildBootstrapClaims({
    iss: "https://saas.example.com",
    peerId,
    accountId,
    tenant: "example-tenant",
    deviceX25519PublicKey: "ZXhhbXBsZS14MjU1MTktZGV2aWNlLXB1YmxpYy1rZXk",
  });
}
