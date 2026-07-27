/**
 * Widget surface — imports ONLY the browser-widget public API from
 * `@mir-stream/webchannel-client` by package name. Instantiating the client
 * against a minimal options object (no live network) proves the widget surface
 * compiles cleanly through the package's exports -> dist .d.ts. Raw transport
 * (`nats-client`) stays unreachable.
 */

import {
  WebChannelNATSClient,
  type WebChannelState,
  type ApprovalRequest,
} from "@mir-stream/webchannel-client";

export async function createWidgetClient(): Promise<WebChannelNATSClient> {
  const pop = (await crypto.subtle.generateKey(
    { name: "Ed25519" }, false, ["sign", "verify"],
  )) as CryptoKeyPair;
  const x25519 = (await crypto.subtle.generateKey(
    { name: "X25519" }, false, ["deriveBits"],
  )) as CryptoKeyPair;
  return new WebChannelNATSClient({
    natsUrl: "wss://nats.example.com",
    bootstrapJwt: "example.bootstrap.jwt",
    accountId: "example-account",
    tenant: "example-tenant",
    peerId: "example-peer",
    registration: {
      devicePrivateKey: pop.privateKey,
      deviceX25519PrivateKey: x25519.privateKey,
      pinnedAgentPublicKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    },
  });
}

/** Exercise the public state/approval types so they are load-bearing here. */
export function summarize(state: WebChannelState): {
  status: string;
  pendingApprovals: ApprovalRequest[];
} {
  return {
    status: state.status,
    pendingApprovals: state.approvals.filter((a) => a.resolvedDecision === undefined),
  };
}
