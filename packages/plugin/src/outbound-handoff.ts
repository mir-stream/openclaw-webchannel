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
import { callGatewayFromCli, ErrorCodes, errorShape } from "openclaw/plugin-sdk/gateway-runtime";
import type { GatewayRequestHandlers } from "openclaw/plugin-sdk/gateway-runtime";
import { recordSessionMetaFromInbound, resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import { resolveOutboundAccountId, type ResolveOutboundTransport } from "./outbound-account.js";
import { requireOutboundPeerId, requireRegisteredPeer, type ResolveServingScope } from "./outbound-target.js";
import { buildWebchannelPeerSessionKey } from "./session-route.js";
import { tupleStoragePaths } from "./storage-paths.js";
import { nextMessageId } from "./message-adapter.js";

export const WEBCHANNEL_SEND_METHOD = "webchannel.send";
const BINDING_FIELD = "webchannelOutboundBinding";
type Binding = { accountId: string; tenant: string; storageRoot: string };
type SendRequest = Binding & { peerId: string; agentId: string; text: string; idempotencyKey: string };
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
      if (ctx.gateway?.mode !== "cli") throw new Error(`[webchannel] outbound account ${JSON.stringify(binding.accountId)} is not running`);
      // Core normally bypasses this action for serving accounts. Refuse an
      // unexpected direct action rather than mirror twice or recurse into RPC.
      if (serving.resolveServingScope(binding.accountId)) throw new Error("[webchannel] use the direct outbound pipeline for a running account");
      if (ctx.params.media || ctx.params.mediaUrl || ctx.params.mediaUrls || ctx.params.buffer) {
        throw new Error("[webchannel] outbound media is unsupported");
      }
      const request: SendRequest = {
        ...binding, peerId, agentId: ctx.agentId ?? resolveDefaultAgentId(ctx.cfg),
        text: stringField(ctx.params, "message"),
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

/** The durable payload retains its tuple, including across core queue recovery. */
export function createHandoffPayloadSender(serving: Serving): NonNullable<ChannelOutboundAdapter["sendPayload"]> {
  return async (ctx) => {
    if (ctx.payload.mediaUrl || ctx.payload.mediaUrls?.length) throw new Error("[webchannel] outbound media is unsupported");
    const value = ctx.payload.channelData?.[BINDING_FIELD];
    const peerId = requireOutboundPeerId(ctx.to);
    if (value === undefined) {
      // Preserve ordinary channelData-bearing text delivery.
      const accountId = resolveOutboundAccountId(ctx.cfg, ctx.accountId);
      const transport = serving.resolveOutboundTransport(accountId);
      if (!transport) throw new Error(`[webchannel] outbound account ${JSON.stringify(accountId)} is not running`);
      const id = nextMessageId();
      if (!transport.sendText(peerId, ctx.text, id)) throw new Error("[webchannel] outbound send failed");
      return { channel: "webchannel", messageId: id };
    }
    const expected = readBinding(value);
    if (ctx.accountId !== expected.accountId) throw new Error("[webchannel] outbound handoff account identity changed");
    const { transport } = servingBinding(ctx.cfg, expected, peerId, serving);
    // No await between this check and the synchronous journal/encrypted send.
    const id = nextMessageId();
    if (!transport.sendText(peerId, ctx.text, id)) throw new Error("[webchannel] outbound send failed");
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
      const request: SendRequest = {
        ...readBinding(fields), peerId: stringField(fields, "peerId"), agentId: stringField(fields, "agentId"),
        text: stringField(fields, "text"), idempotencyKey: stringField(fields, "idempotencyKey"),
      };
      if (request.idempotencyKey.length > 200) throw new Error("[webchannel] outbound idempotency key is too long");
      if (request.peerId !== requireOutboundPeerId(request.peerId)) throw new Error("[webchannel] outbound handoff requires a bare peer id");
      const fingerprint = createHash("sha256").update(JSON.stringify(request)).digest("hex");
      const now = Date.now();
      for (const [key, entry] of requests) if (entry.expires <= now) requests.delete(key);
      let entry = requests.get(request.idempotencyKey);
      if (entry && entry.fingerprint !== fingerprint) throw new Error("[webchannel] outbound idempotency key reused for a different request");
      if (!entry) {
        if (requests.size >= 1_000) throw new Error("[webchannel] outbound handoff is busy; retry later");
        const cfg = context.getRuntimeConfig();
        const { binding } = servingBinding(cfg, request, request.peerId, serving);
        const sessionKey = buildWebchannelPeerSessionKey({ cfg, agentId: request.agentId, accountId: binding.accountId, peerId: request.peerId, servingTenant: binding.tenant });
        const promise = (async () => {
          await recordSessionMetaFromInbound({
            storePath: resolveStorePath(cfg.session?.store, { agentId: request.agentId }), sessionKey,
            ctx: { From: request.peerId, To: request.peerId, SessionKey: sessionKey, AccountId: binding.accountId,
              ChatType: "direct", Provider: "webchannel", Surface: "webchannel", OriginatingChannel: "webchannel", OriginatingTo: request.peerId },
          });
          const sent = await sendDurableMessageBatch({
            cfg, channel: "webchannel", to: request.peerId, accountId: binding.accountId,
            payloads: [{ text: request.text, channelData: { [BINDING_FIELD]: binding } }],
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
