import type { ChannelOutboundContext } from "openclaw/plugin-sdk/channel-contract";
import type { WebChannelPeerChannel } from "./channel-contract.js";
import { isWebchannelAccountEnabled, resolveWebchannelAccountId } from "./account-config.js";

export type ResolveOutboundTransport = (accountId: string) => WebChannelPeerChannel | undefined;

/**
 * The exact listed account a core-initiated outbound act names. Target
 * resolution (#402) and both send surfaces share it, so a target is never
 * admitted under one account and delivered under another.
 */
export function resolveOutboundAccountId(cfg: unknown, accountId?: string | null): string {
  const resolved = resolveWebchannelAccountId(cfg, accountId);
  if (resolved === undefined) {
    throw new Error(`[webchannel] outbound account ${JSON.stringify(accountId)} is not a valid listed account`);
  }
  if (!isWebchannelAccountEnabled(cfg, resolved)) {
    throw new Error(`[webchannel] outbound account ${JSON.stringify(resolved)} is disabled`);
  }
  return resolved;
}

/** Both SDK send surfaces resolve the selected account at the delivery act. */
export function resolveOutboundTransport(
  ctx: Pick<ChannelOutboundContext, "cfg" | "accountId">,
  transport: WebChannelPeerChannel,
  resolveAccountTransport?: ResolveOutboundTransport,
): WebChannelPeerChannel {
  if (!resolveAccountTransport) return transport;
  const accountId = resolveOutboundAccountId(ctx.cfg, ctx.accountId);
  const target = resolveAccountTransport(accountId);
  if (!target) {
    throw new Error(`[webchannel] outbound account ${JSON.stringify(accountId)} is not running`);
  }
  return target;
}
