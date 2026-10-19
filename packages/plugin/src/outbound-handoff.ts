/**
 * CLI handoff over the public SDK. Telegram's outbound-adapter.ts sends in
 * process to its server; WebChannel's server is the running account runtime.
 * Pin the caller's selected tuple, then let that gateway own the transcript.
 */
import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { ChannelMessageActionAdapter, ChannelOutboundAdapter } from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig, OpenClawPluginApi } from "openclaw/plugin-sdk/channel-core";
import { jsonResult } from "openclaw/plugin-sdk/channel-actions";
import { resolveDefaultAgentId } from "openclaw/plugin-sdk/config-runtime";
import { buildOutboundSessionContext, sendDurableMessageBatch } from "openclaw/plugin-sdk/channel-outbound";
import type { ChannelMessageSendResult, ChannelMessageSendTextContext } from "openclaw/plugin-sdk/channel-outbound";
import { callGatewayFromCli, ErrorCodes, errorShape } from "openclaw/plugin-sdk/gateway-runtime";
import type { GatewayRequestHandlers } from "openclaw/plugin-sdk/gateway-runtime";
import { normalizeInteractiveReply, normalizeMessagePresentation } from "openclaw/plugin-sdk/interactive-runtime";
import type { InteractiveReply, MessagePresentation, ReplyPayloadDelivery } from "openclaw/plugin-sdk/interactive-runtime";
import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import { recordSessionMetaFromInbound, resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import { resolveOutboundAccountId, type ResolveOutboundTransport } from "./outbound-account.js";
import { requireOutboundPeerId, requireRegisteredPeer, type ResolveServingScope } from "./outbound-target.js";
import { buildWebchannelPeerSessionKey } from "./session-route.js";
import { tupleStoragePaths } from "./storage-paths.js";
import { nextMessageId } from "./message-adapter.js";

export const WEBCHANNEL_SEND_METHOD = "webchannel.send";
const BINDING_FIELD = "webchannelOutboundBinding";
const MEDIA_FIELDS = ["media", "mediaUrl", "mediaUrls", "buffer"] as const;
// Core's own error for media without text on an adapter without sendMedia (deliver.ts).
const NO_TEXT_FALLBACK = "Plugin outbound adapter does not implement sendMedia and no text fallback is available for media payload";
type Binding = { accountId: string; tenant: string; storageRoot: string };
type Content = { text: string; presentation?: MessagePresentation; interactive?: InteractiveReply; delivery?: ReplyPayloadDelivery };
type SendRequest = Binding & Content & { peerId: string; agentId: string; idempotencyKey: string };
type Serving = { resolveServingScope: ResolveServingScope; resolveOutboundTransport: ResolveOutboundTransport };

function bindingFor(cfg: OpenClawConfig, accountId: string | null | undefined, peerId: string, resolveScope?: ResolveServingScope): Binding {
  const scope = requireRegisteredPeer(cfg, accountId, peerId, resolveScope);
  return { accountId: scope.accountId, tenant: scope.tenant, storageRoot: resolve(tupleStoragePaths(scope).storageRoot) };
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("[webchannel] invalid outbound handoff");
  return value as Record<string, unknown>;
}

function stringField(value: Record<string, unknown>, field: string): string {
  const text = value[field];
  if (typeof text !== "string" || !text.trim()) throw new Error(`[webchannel] invalid outbound handoff field ${field}`);
  return text;
}

/**
 * Core lets presentation/interactive blocks stand in for text. Forward them
 * unrendered, with delivery options, so the gateway's core renders and applies
 * them as on the direct path. The CLI drops unusable values as core does; the
 * RPC (strict) refuses them.
 */
function readContent(fields: Record<string, unknown>, textField: string, { strict = false, media = false } = {}): Content {
  const text = fields[textField] ?? "";
  const presentation = normalizeMessagePresentation(fields.presentation);
  const interactive = normalizeInteractiveReply(fields.interactive);
  // Core's buildSendPayloadParts passes any plain object through unchanged.
  const delivery = fields.delivery && typeof fields.delivery === "object" && !Array.isArray(fields.delivery)
    ? fields.delivery as ReplyPayloadDelivery : undefined;
  if (strict && fields.presentation !== undefined && !presentation) throw new Error("[webchannel] invalid outbound handoff field presentation");
  if (strict && fields.interactive !== undefined && !interactive) throw new Error("[webchannel] invalid outbound handoff field interactive");
  if (strict && fields.delivery !== undefined && !delivery) throw new Error("[webchannel] invalid outbound handoff field delivery");
  if (typeof text !== "string") throw new Error(`[webchannel] invalid outbound handoff field ${textField}`);
  // Core's fallback for an adapter without sendMedia needs text after rendering.
  if (media && !text.trim() && !presentation) throw new Error(NO_TEXT_FALLBACK);
  if (!text.trim() && !presentation && !interactive) throw new Error(`[webchannel] invalid outbound handoff field ${textField}`);
  return { text, ...(presentation ? { presentation } : {}), ...(interactive ? { interactive } : {}), ...(delivery ? { delivery } : {}) };
}

function readBinding(value: unknown): Binding {
  const fields = record(value);
  return { accountId: stringField(fields, "accountId"), tenant: stringField(fields, "tenant"), storageRoot: stringField(fields, "storageRoot") };
}

function servingBinding(cfg: OpenClawConfig, expected: Binding, peerId: string, serving: Serving) {
  const accountId = resolveOutboundAccountId(cfg, expected.accountId);
  // An alias must not select a different listed account on the other process.
  if (accountId !== expected.accountId) throw new Error("[webchannel] outbound handoff account identity changed");
  const transport = serving.resolveOutboundTransport(accountId);
  if (!transport || !serving.resolveServingScope(accountId)) {
    throw new Error(`[webchannel] outbound account ${JSON.stringify(accountId)} is not running`);
  }
  const actual = bindingFor(cfg, accountId, peerId, serving.resolveServingScope);
  if (actual.tenant !== expected.tenant || actual.storageRoot !== expected.storageRoot) {
    throw new Error("[webchannel] outbound handoff tenant/store changed; refresh CLI configuration and retry");
  }
  return { transport, binding: actual };
}

/** Local sends keep core's direct pipeline; non-serving CLI actions use our RPC. */
export function createOutboundHandoffActions(serving: Serving): ChannelMessageActionAdapter {
  return {
    describeMessageTool: () => ({ actions: ["send"] }),
    supportsAction: ({ action }) => action === "send",
    resolveExecutionMode: () => "local",
    prepareSendPayload: ({ ctx, payload }) => {
      if (ctx.dryRun) return payload;
      const accountId = resolveOutboundAccountId(ctx.cfg, ctx.accountId);
      if (serving.resolveServingScope(accountId)) return payload;
      if (ctx.gateway?.mode !== "cli") throw new Error(`[webchannel] outbound account ${JSON.stringify(accountId)} is not running`);
      return null;
    },
    handleAction: async (ctx) => {
      if (ctx.action !== "send") throw new Error("[webchannel] unsupported outbound action");
      const peerId = requireOutboundPeerId(stringField(ctx.params, "to"));
      const binding = bindingFor(ctx.cfg, ctx.accountId, peerId, serving.resolveServingScope);
      // Core's send pipeline bypasses this action for serving accounts; its
      // message.action RPC does not. Refuse rather than mirror twice or recurse.
      if (serving.resolveServingScope(binding.accountId)) throw new Error("[webchannel] use the direct outbound pipeline for a running account");
      if (ctx.gateway?.mode !== "cli") throw new Error(`[webchannel] outbound account ${JSON.stringify(binding.accountId)} is not running`);
      // As on the direct path, media (including core's TTS audio) is dropped
      // and its text delivered. Media never crosses the RPC.
      const media = MEDIA_FIELDS.some((field) => {
        const value = ctx.params[field];
        return Array.isArray(value) ? value.length > 0 : Boolean(value);
      });
      const request: SendRequest = {
        ...binding, peerId, agentId: ctx.agentId ?? resolveDefaultAgentId(ctx.cfg),
        ...readContent(ctx.params, "message", { media }),
        idempotencyKey: typeof ctx.params.idempotencyKey === "string" && ctx.params.idempotencyKey.trim()
          ? ctx.params.idempotencyKey : randomUUID(),
      };
      const result = await callGatewayFromCli(WEBCHANNEL_SEND_METHOD, {
        url: ctx.gateway?.url, token: ctx.gateway?.token,
        timeout: String(ctx.gateway?.timeoutMs ?? 30_000), json: true,
      }, request, { clientName: ctx.gateway?.clientName, mode: ctx.gateway?.mode, scopes: ["operator.write"], progress: false });
      return jsonResult(result);
    },
  };
}

/**
 * Core sends channelData, interactive and voice payloads here rather than down
 * its text route. Keep that route for this adapter, which has no sendMedia
 * (deliver.ts): media falls back to trimmed text, and fails without any. An
 * unbound payload goes to the plugin's message.send.text, as core's text route
 * would. A bound payload retains its tuple, including across core queue
 * recovery, and is re-checked at the send.
 */
export function createHandoffPayloadSender(
  serving: Serving, sendText: (ctx: ChannelMessageSendTextContext) => Promise<ChannelMessageSendResult>,
): NonNullable<ChannelOutboundAdapter["sendPayload"]> {
  return async (ctx) => {
    const parts = resolveSendableOutboundReplyParts(ctx.payload, { text: ctx.text });
    if (parts.hasMedia && !parts.trimmedText) throw new Error(NO_TEXT_FALLBACK);
    const text = parts.hasMedia ? parts.trimmedText : ctx.text;
    const value = ctx.payload.channelData?.[BINDING_FIELD];
    if (value === undefined) {
      // ctx's callback takes core's OutboundDeliveryResult, not this adapter's
      // ChannelMessageSendResult (core wraps it on its text route); ours never reports.
      const sent = await sendText({ ...ctx, text, onDeliveryResult: undefined });
      return { ...sent, channel: "webchannel", messageId: sent.messageId ?? sent.receipt.primaryPlatformMessageId ?? sent.receipt.platformMessageIds[0] ?? "" };
    }
    const peerId = requireOutboundPeerId(ctx.to);
    const expected = readBinding(value);
    if (ctx.accountId !== expected.accountId) throw new Error("[webchannel] outbound handoff account identity changed");
    const { transport } = servingBinding(ctx.cfg, expected, peerId, serving);
    // No await between this check and the synchronous journal/encrypted send.
    const id = nextMessageId();
    // Same wording as message.send.text, which serves the unbound and direct text routes.
    if (!transport.sendText(peerId, text, id)) {
      throw new Error(`[webchannel] message.send.text failed: targeted send returned false for peer ${peerId}`);
    }
    return { channel: "webchannel", messageId: id };
  };
}

export function createOutboundHandoffHandler(serving: Serving): GatewayRequestHandlers[string] {
  // Same-request retries share the entire send+mirror promise. Cache failures
  // too: a failed RPC response must never blindly repeat a possible delivery.
  const requests = new Map<string, { fingerprint: string; promise: Promise<unknown>; expires: number }>();
  return async ({ params, context, respond, client }) => {
    try {
      const fields = record(params);
      if (MEDIA_FIELDS.some((field) => fields[field] !== undefined)) throw new Error("[webchannel] outbound handoff does not carry media");
      const content = readContent(fields, "text", { strict: true });
      const request: SendRequest = {
        ...readBinding(fields), peerId: stringField(fields, "peerId"), agentId: stringField(fields, "agentId"),
        ...content, idempotencyKey: stringField(fields, "idempotencyKey"),
      };
      if (request.idempotencyKey.length > 200) throw new Error("[webchannel] outbound idempotency key is too long");
      if (request.peerId !== requireOutboundPeerId(request.peerId)) throw new Error("[webchannel] outbound handoff requires a bare peer id");
      const fingerprint = createHash("sha256").update(JSON.stringify(request)).digest("hex");
      const now = Date.now();
      for (const [key, entry] of requests) if (entry.expires <= now) requests.delete(key);
      let entry = requests.get(request.idempotencyKey);
      if (entry && entry.fingerprint !== fingerprint) throw new Error("[webchannel] outbound idempotency key reused for a different request");
      if (!entry) {
        // Completed entries only answer retries; make room before refusing.
        for (const [key, old] of requests) {
          if (requests.size < 1_000) break;
          if (old.expires !== Infinity) requests.delete(key);
        }
        if (requests.size >= 1_000) throw new Error("[webchannel] outbound handoff is busy; retry later");
        const cfg = context.getRuntimeConfig();
        const { binding } = servingBinding(cfg, request, request.peerId, serving);
        const sessionKey = buildWebchannelPeerSessionKey({ cfg, agentId: request.agentId, accountId: binding.accountId, peerId: request.peerId, servingTenant: binding.tenant });
        const promise = (async () => {
          // Best-effort, like core's ensureOutboundSessionEntry on the direct path.
          await recordSessionMetaFromInbound({
            storePath: resolveStorePath(cfg.session?.store, { agentId: request.agentId }), sessionKey,
            ctx: { From: request.peerId, To: request.peerId, SessionKey: sessionKey, AccountId: binding.accountId,
              ChatType: "direct", Provider: "webchannel", Surface: "webchannel", OriginatingChannel: "webchannel", OriginatingTo: request.peerId },
          }).catch(() => undefined);
          const sent = await sendDurableMessageBatch({
            cfg, channel: "webchannel", to: request.peerId, accountId: binding.accountId,
            payloads: [{ ...content, channelData: { [BINDING_FIELD]: binding } }],
            session: buildOutboundSessionContext({ cfg, agentId: request.agentId, sessionKey, conversationType: "direct" }),
            mirror: { agentId: request.agentId, sessionKey, text: request.text, idempotencyKey: request.idempotencyKey },
            gatewayClientScopes: client?.connect?.scopes ?? [],
          });
          if (sent.status === "failed" || sent.status === "partial_failed") throw sent.error;
          return { via: "gateway", deliveryStatus: sent.status, result: sent.results.at(-1) };
        })();
        entry = { fingerprint, promise, expires: Infinity };
        requests.set(request.idempotencyKey, entry);
        const saved = entry;
        void promise.then(() => { saved.expires = Date.now() + 600_000; }, () => { saved.expires = Date.now() + 600_000; });
      }
      respond(true, await entry.promise);
    } catch (error) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, error instanceof Error ? error.message : String(error)));
    }
  };
}

export function registerOutboundHandoff(api: OpenClawPluginApi, serving: Serving): void {
  api.registerGatewayMethod(WEBCHANNEL_SEND_METHOD, createOutboundHandoffHandler(serving), { scope: "operator.write" });
}
