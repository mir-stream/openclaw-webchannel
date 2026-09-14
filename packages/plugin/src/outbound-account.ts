import type { ChannelOutboundContext } from "openclaw/plugin-sdk/channel-contract";
import type { WebChannelPeerChannel } from "./channel-contract.js";
import { resolveDefaultWebchannelAccountId } from "./account-config.js";

export type ResolveOutboundTransport = (accountId: string) => WebChannelPeerChannel | undefined;

/** Both SDK send surfaces resolve the selected account at the delivery act. */
export function resolveOutboundTransport(
  ctx: Pick<ChannelOutboundContext, "cfg" | "accountId">,
  transport: WebChannelPeerChannel,
  resolveAccountTransport?: ResolveOutboundTransport,
): WebChannelPeerChannel {
  if (!resolveAccountTransport) return transport;
  const accountId = ctx.accountId ?? resolveDefaultWebchannelAccountId(ctx.cfg);
  const target = resolveAccountTransport(accountId);
  if (!target) {
    throw new Error(`[webchannel] outbound account ${JSON.stringify(accountId)} is not running`);
  }
  return target;
}
