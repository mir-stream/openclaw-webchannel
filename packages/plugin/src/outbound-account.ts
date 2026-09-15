import type { ChannelOutboundContext } from "openclaw/plugin-sdk/channel-contract";
import type { WebChannelPeerChannel } from "./channel-contract.js";
import { isWebchannelAccountEnabled, resolveWebchannelAccountId } from "./account-config.js";

export type ResolveOutboundTransport = (accountId: string) => WebChannelPeerChannel | undefined;

/** Both SDK send surfaces resolve the selected account at the delivery act. */
export function resolveOutboundTransport(
  ctx: Pick<ChannelOutboundContext, "cfg" | "accountId">,
  transport: WebChannelPeerChannel,
  resolveAccountTransport?: ResolveOutboundTransport,
): WebChannelPeerChannel {
  if (!resolveAccountTransport) return transport;
  const accountId = resolveWebchannelAccountId(ctx.cfg, ctx.accountId);
  if (accountId === undefined) {
    throw new Error(`[webchannel] outbound account ${JSON.stringify(ctx.accountId)} is not a valid listed account`);
  }
  if (!isWebchannelAccountEnabled(ctx.cfg, accountId)) {
    throw new Error(`[webchannel] outbound account ${JSON.stringify(accountId)} is disabled`);
  }
  const target = resolveAccountTransport(accountId);
  if (!target) {
    throw new Error(`[webchannel] outbound account ${JSON.stringify(accountId)} is not running`);
  }
  return target;
}
