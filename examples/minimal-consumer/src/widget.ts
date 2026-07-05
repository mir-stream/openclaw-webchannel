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

export function createWidgetClient(): WebChannelNATSClient {
  return new WebChannelNATSClient({
    natsUrl: "wss://nats.example.com",
    bootstrapJwt: "example.bootstrap.jwt",
    accountId: "example-account",
    tenant: "example-tenant",
    peerId: "example-peer",
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
