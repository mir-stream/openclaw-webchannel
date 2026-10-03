/** DM policy shared by runtime admission, schema diagnostics and core audit. */
import type { DmPolicy } from "openclaw/plugin-sdk/config-contracts";
import { createChannelPairingChallengeIssuer, readChannelAllowFromStore } from "openclaw/plugin-sdk/channel-pairing";
import { upsertChannelPairingRequest } from "openclaw/plugin-sdk/conversation-runtime";

export type DmSecurityConfig = {
  allowFrom?: readonly string[];
  dmPolicy?: DmPolicy;
  /** Deprecated config spelling; doctor supplies the canonical replacement. */
  dmSecurity?: string;
};

export type DmAdmission = {
  allowed: boolean;
  reason: "open-policy" | "allowlisted" | "not-allowlisted" |
    "default-deny-empty-allowlist" | "disabled" | "invalid-policy" | "pairing-required";
};

const POLICIES = new Set(["pairing", "allowlist", "open", "disabled"]);
const OPEN_ALIASES = new Set(["all", "any", "anyone", "everyone", "public"]);

export function normalizeDmAllowEntry(entry: string): string {
  return entry.trim().replace(/^webchannel:/i, "").trim();
}

/** The canonical field wins within one account; only legacy spellings normalize. */
export function resolveDmPolicy(cfg: { dmPolicy?: unknown; dmSecurity?: unknown } = {}): DmPolicy {
  if (cfg.dmPolicy !== undefined) {
    if (typeof cfg.dmPolicy === "string" && POLICIES.has(cfg.dmPolicy)) return cfg.dmPolicy as DmPolicy;
    throw new Error('dmPolicy must be pairing, allowlist, open or disabled');
  }
  if (cfg.dmSecurity !== undefined) {
    if (typeof cfg.dmSecurity === "string") {
      const policy = cfg.dmSecurity.trim().toLowerCase();
      if (OPEN_ALIASES.has(policy)) return "open";
      if (POLICIES.has(policy)) return policy as DmPolicy;
    }
    throw new Error('legacy dmSecurity must name a supported DM policy; migrate to dmPolicy');
  }
  return "open";
}

/** Validate the effective account after channel/account inheritance. */
export function validateDmConfig(cfg: Record<string, unknown>): void {
  const policy = resolveDmPolicy(cfg);
  const allow = cfg.allowFrom;
  if (allow !== undefined && (!Array.isArray(allow) || !allow.every(value => typeof value === "string"))) {
    throw new Error("allowFrom must be an array of sender IDs");
  }
  if (policy === "open" && !(allow as string[] | undefined)?.some(value => value.trim() === "*")) {
    throw new Error('dmPolicy="open" (the default) requires allowFrom to explicitly include "*"');
  }
  if (policy === "allowlist" && !(allow as string[] | undefined)?.some(value => normalizeDmAllowEntry(value).length > 0)) {
    throw new Error('dmPolicy="allowlist" requires at least one allowFrom sender ID');
  }
}

/** Pure Telegram/SDK semantics. Only pairing reads the approved-pair store. */
export function resolveDmAdmission(peerId: string, cfg: DmSecurityConfig | undefined, storeAllowFrom: readonly string[] = []): DmAdmission {
  let policy: DmPolicy;
  try { policy = resolveDmPolicy(cfg); }
  catch { return { allowed: false, reason: "invalid-policy" }; }
  if (policy === "disabled") return { allowed: false, reason: "disabled" };
  const configured = Array.isArray(cfg?.allowFrom) ? cfg.allowFrom : [];
  const allow = [...configured, ...(policy === "pairing" ? storeAllowFrom : [])]
    .filter((entry): entry is string => typeof entry === "string").map(normalizeDmAllowEntry);
  if (allow.includes("*")) return { allowed: true, reason: policy === "open" ? "open-policy" : "allowlisted" };
  if (allow.includes(peerId)) return { allowed: true, reason: "allowlisted" };
  if (policy === "pairing") return { allowed: false, reason: "pairing-required" };
  return { allowed: false, reason: allow.length ? "not-allowlisted" : "default-deny-empty-allowlist" };
}

/** SDK-owned challenge issuance keeps pending-request limits and code semantics. */
export async function enforceDmAdmission(input: {
  peerId: string;
  accountId: string;
  config: DmSecurityConfig;
  sendPairingReply: (text: string) => Promise<void>;
  readStore?: typeof readChannelAllowFromStore;
  upsertPairingRequest?: typeof upsertChannelPairingRequest;
}): Promise<DmAdmission> {
  let policy: DmPolicy;
  try { policy = resolveDmPolicy(input.config); }
  catch { return { allowed: false, reason: "invalid-policy" }; }
  const store = policy === "pairing"
    ? await (input.readStore ?? readChannelAllowFromStore)("webchannel", process.env, input.accountId)
    : [];
  const admission = resolveDmAdmission(input.peerId, input.config, store);
  if (admission.reason === "pairing-required") {
    await createChannelPairingChallengeIssuer({
      channel: "webchannel", accountId: input.accountId,
      upsertPairingRequest: params => (input.upsertPairingRequest ?? upsertChannelPairingRequest)({
        ...params, channel: "webchannel", accountId: input.accountId,
      }),
    })({ senderId: input.peerId, senderIdLine: `Your WebChannel user id: ${input.peerId}`, sendPairingReply: input.sendPairingReply });
  }
  return admission;
}
