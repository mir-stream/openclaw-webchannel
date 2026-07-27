import type { EnrollmentRequest, EnrollmentResponse } from "./device-flow-types.js";

export function serializeEnrollmentRequest(request: EnrollmentRequest): Record<string, unknown> {
  return {
    agentPublicKey: request.agentPublicKey,
    accountId: request.accountId,
    tenant: request.tenant,
    ...(request.pluginVersion !== undefined ? { pluginVersion: request.pluginVersion } : {}),
    ...(request.protocolVersion !== undefined ? { protocolVersion: request.protocolVersion } : {}),
  };
}

export function serializeEnrollmentResponse(response: EnrollmentResponse): Record<string, unknown> {
  return {
    device_code: response.device_code,
    user_code: response.user_code,
    verification_uri: response.verification_uri,
    verification_uri_complete: response.verification_uri_complete,
    expires_in: response.expires_in,
    interval: response.interval,
  };
}

export function serializeBootstrapResponse(
  base: { jwt: string; peerId: string; jwksUrl?: string; natsUrl?: string },
  agentPublicKey: string | null,
): Record<string, unknown> {
  return {
    jwt: base.jwt,
    peerId: base.peerId,
    ...(agentPublicKey ? { agentPublicKey } : {}),
    ...(base.jwksUrl !== undefined ? { jwksUrl: base.jwksUrl } : {}),
    ...(base.natsUrl !== undefined ? { natsUrl: base.natsUrl } : {}),
  };
}
