/**
 * Operator surface — imports ONLY from the published package name
 * `@mir-stream/webchannel-saas` (never a relative source path). This proves the
 * legitimate SaaS-operator flow is fully expressible through the public barrel:
 * build a trust chain, stand up a DeviceFlowEnrollment, and drive an
 * enroll -> approve -> poll cycle. It deliberately never touches raw
 * `mintNatsUserCreds` or `assertValidSubjectToken` — those stay unreachable, and
 * the enrollment object mints the correctly-scoped NATS creds internally.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import {
  setupTrustChain,
  loadOrCreateTrustChain,
  DeviceFlowEnrollment,
  MemoryEnrollmentRepository,
  MemoryEnrollmentRepository,
  EnrollmentValidationError,
  buildBootstrapClaims,
  generateRsaKeypair,
  type SetupTrustChainResult,
  type SetupTrustChainOptions,
  type EnrollmentResult,
  type DeviceFlowError,
  type BootstrapClaims,
  type JwkRsaPublicKey,
  type AgentKeyRegistry,
} from "@mir-stream/webchannel-saas";

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SyntaxError("invalid JSON body");
  return value as Record<string, unknown>;
}

function json(res: ServerResponse, status: number, value: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(value));
}

type MinimalEnrollmentHandlerOptions = {
  enrollment: Pick<DeviceFlowEnrollment, "enroll" | "poll" | "approve" | "deny">;
  registry: Pick<AgentKeyRegistry, "revokeActive">;
  bootstrap: () => Promise<Record<string, unknown>> | Record<string, unknown>;
  adminToken?: string;
};

/** A real downstream HTTP handler composed only from public barrel symbols. */
export function createMinimalConsumerEnrollmentHandler(options: MinimalEnrollmentHandlerOptions) {
  const adminToken = options.adminToken ?? process.env.ENROLLMENT_ADMIN_TOKEN;
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
      if (req.method === "OPTIONS") { res.statusCode = 204; res.end(); return; }
      const path = new URL(req.url ?? "/", "http://minimal.invalid").pathname;
      const admin = req.method === "POST" && ["/approve", "/deny", "/revoke"].includes(path);
      if (admin) {
        if (!adminToken) return json(res, 503, { error: "enrollment admin token is not configured" });
        if (req.headers.authorization !== `Bearer ${adminToken}`) return json(res, 401, { error: "unauthorized" });
      }
      const payload = req.method === "POST" ? await readJson(req) : {};
      if (req.method !== "POST") return json(res, 404, { error: "not found" });
      if (path === "/enroll") {
        try {
          const response = await options.enrollment.enroll(payload as never);
          return json(res, 200, { device_code: response.device_code, user_code: response.user_code, verification_uri: response.verification_uri, verification_uri_complete: response.verification_uri_complete, expires_in: response.expires_in, interval: response.interval });
        } catch (error) {
          if (error instanceof EnrollmentValidationError) return json(res, 400, { error: error.message });
          throw error;
        }
      }
      if (path === "/poll") {
        const result = await options.enrollment.poll(payload as never);
        return json(res, "error" in result ? 400 : 200, result);
      }
      if (path === "/bootstrap") return json(res, 200, await options.bootstrap());
      if (path === "/approve") {
        const replaceActivationId = typeof payload.replaceActivationId === "string" ? payload.replaceActivationId : undefined;
        const outcome = await options.enrollment.approve(String(payload.user_code ?? ""), replaceActivationId ? { replaceActivationId } : {});
        switch (outcome.kind) {
          case "conflict": return json(res, 409, { error: "conflict", activationId: outcome.existing?.activationId ?? null, fingerprint: outcome.existing?.keyIdFingerprint ?? null, enrolledAt: outcome.existing?.enrolledAt ?? null });
          case "in_progress": return json(res, 409, { error: "approval_in_progress", error_description: "Approval in progress, retry shortly" });
          case "revoked_key": return json(res, 410, { error: "revoked_key" });
          case "rejected": return json(res, 404, { error: "rejected" });
          case "approved": return json(res, 200, { approved: true, peerId: outcome.result.peerId });
          default: { const exhaustive: never = outcome; return exhaustive; }
        }
      }
      if (path === "/deny") {
        const denied = await options.enrollment.deny(String(payload.user_code ?? ""));
        return json(res, denied ? 200 : 404, { denied });
      }
      if (path === "/revoke") {
        const revoked = await options.registry.revokeActive(String(payload.tenant ?? ""), String(payload.accountId ?? ""));
        return json(res, revoked ? 200 : 404, { revoked });
      }
      return json(res, 404, { error: "not found" });
    } catch (error) {
      if (error instanceof SyntaxError) return json(res, 400, { error: "invalid JSON body" });
      if (!res.headersSent) return json(res, 500, { error: "internal server error" });
      if (!res.writableEnded) res.end();
    }
  };
}

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
    repository: new MemoryEnrollmentRepository({ autoSweep: false }),
  });

  const started = await enrollment.enroll({
    // 43-char base64url of a 32-byte X25519 public key — the exact wire format
    // enroll() validates at ingress (real plugins send their identity key here).
    agentPublicKey: "EpK8GJc3BntN3yEwx5GtfQFyIilwIXaKsrWiqYNkzSo",
    accountId: "example-account",
    tenant: "example-tenant",
  });

  const approved = await enrollment.approve(started.user_code);
  switch (approved.kind) {
    case "approved": break;
    case "conflict": throw new Error(`operator approval conflict: ${JSON.stringify({ status: 409, activationId: approved.existing?.activationId ?? null, fingerprint: approved.existing?.keyIdFingerprint ?? null, enrolledAt: approved.existing?.enrolledAt ?? null })}`);
    case "in_progress": throw new Error(`operator approval failed: ${JSON.stringify({ status: 409, error: "approval_in_progress" })}`);
    case "revoked_key": throw new Error(`operator approval failed: ${JSON.stringify({ status: 410, error: "revoked_key" })}`);
    case "rejected": throw new Error(`operator approval failed: ${JSON.stringify({ status: 404, error: "rejected" })}`);
    default: { const exhaustive: never = approved; throw new Error(String(exhaustive)); }
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
