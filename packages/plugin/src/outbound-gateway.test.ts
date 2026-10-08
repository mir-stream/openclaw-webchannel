/**
 * #418: exercise the pinned core's message-action -> plugin handoff RPC -> durable send
 * path. The gateway socket is replaced: its client hands serialized RPC
 * params to the plugin's server handler under the gateway's plugin registry.
 * The CLI registry has no account runtimes. NATS publish is recorded in memory;
 * encryption and SQLite are real. CLI and gateway use separate configurations.
 * Tests assert actual transcript content as well as frames and journal entries.
 */
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";

import { ConversationKeyStore } from "./conversation-key-store.js";
import { openDeliveryJournal } from "./delivery-journal.js";
import { generateKeyPair } from "./e2e-crypto.js";
import { openEnvelope } from "./e2e-session.js";
import { createNatsWebChannelPlugin } from "./nats-account-runtime.js";
import { NatsChannel } from "./nats-channel.js";
import type { NatsTransport } from "./nats-transport.js";
import { createOutboundHandoffHandler, registerOutboundHandoff, WEBCHANNEL_SEND_METHOD } from "./outbound-handoff.js";
import { buildWebchannelPeerSessionKey } from "./session-route.js";
import { tupleStoragePaths } from "./storage-paths.js";
import { loadCoreExport } from "./test-fixtures/core-outbound-internals.js";

// Private core entry points have no public SDK types. Keep that boundary here;
// loadCoreExport resolves original export names rather than hashed bundle names.
type CoreCall = (params: Record<string, any>) => Promise<any>;
type Plugin = ReturnType<typeof createNatsWebChannelPlugin>;
type Registry = { channels: Array<{ pluginId: string; plugin: Plugin; source: string }> };
type GatewayClientOptions = {
  mode: string;
  clientName: string;
  onHelloOk: (hello: object) => void;
  onClose: (code: number, reason: string) => void;
};
let runMessageAction: CoreCall;
let dispatchCronDelivery: CoreCall;
let handoffHandler: ReturnType<typeof createOutboundHandoffHandler>;
let gatewayRuntimes: Map<string, ReturnType<typeof createRuntime>>;
let createEmptyRegistry: () => Registry;
let setActiveRegistry: (registry: Registry) => void;
let gatewayTesting: {
  setDepsForTests: (deps: Record<string, unknown>) => void;
  resetDepsForTests: () => void;
};
let suiteRoot: string;
let root: string;
let cfg: OpenClawConfig;
let gatewayCfg: OpenClawConfig;
let primary: ReturnType<typeof createRuntime>;
let named: ReturnType<typeof createRuntime>;
let gatewayPlugin: Plugin;
let cliPlugin: Plugin;
let gatewayUnavailable: boolean;
let connections: GatewayClientOptions[];
let requests: Array<{ method: string; params: Record<string, any> }>;
const PEER = "Alice";
const TEXT = "account-private outbound message";

class RecordingTransport extends EventEmitter {
  connected = true;
  effectiveOutboundLimit = 1_000_000;
  frames: Array<{ subject: string; payload: Buffer }> = [];
  subscribe(): number { return 1; }
  unsubscribe(): void {}
  publish(subject: string, payload: string | Uint8Array): void {
    this.frames.push({ subject, payload: Buffer.from(payload) });
  }
}

function createRuntime(accountId: string, tenant: string) {
  const scope = { accountId, tenant, storageRoot: root };
  const keyStore = new ConversationKeyStore(scope);
  const journal = openDeliveryJournal({ databasePath: tupleStoragePaths(scope).deliveryJournalPath });
  const transport = new RecordingTransport();
  const channel = new NatsChannel(
    transport as unknown as NatsTransport, accountId, tenant,
    { keyStore, identityKeyPair: generateKeyPair() }, undefined,
    { deliveryJournal: journal },
  );
  channel.registerPeer(PEER);
  return { ...scope, keyStore, journal, transport, channel };
}

function activate(plugin: Plugin): void {
  const registry = createEmptyRegistry();
  registry.channels.push({ pluginId: "webchannel", plugin, source: "outbound-gateway-test" });
  setActiveRegistry(registry);
}

beforeAll(async () => {
  suiteRoot = mkdtempSync(join(tmpdir(), "wc-outbound-gateway-"));
  vi.stubEnv("OPENCLAW_STATE_DIR", suiteRoot);
  vi.stubEnv("OPENCLAW_CONFIG_PATH", join(suiteRoot, "openclaw.json"));
  runMessageAction = await loadCoreExport("message-action-runner-", "src/infra/outbound/message-action-runner.ts", "runMessageAction");
  dispatchCronDelivery = await loadCoreExport("run-delivery.runtime-", "src/cron/isolated-agent/delivery-dispatch.ts", "dispatchCronDelivery");
  createEmptyRegistry = await loadCoreExport("runtime-", "src/plugins/registry-empty.ts", "createEmptyPluginRegistry");
  setActiveRegistry = await loadCoreExport("runtime-", "src/plugins/runtime.ts", "setActivePluginRegistry");
  gatewayTesting = await loadCoreExport("call-", "src/gateway/call.ts", "testing");
});

beforeEach(() => {
  root = mkdtempSync(join(suiteRoot, "send-"));
  vi.stubEnv("OPENCLAW_STATE_DIR", root);
  cfg = {
    gateway: { mode: "local", auth: { mode: "token", token: "fixture-gateway-token" } },
    session: { store: join(root, "sessions.json") },
    channels: { webchannel: {
      storageRoot: root,
      defaultAccount: "default",
      dmPolicy: "open",
      allowFrom: ["*"],
      accounts: { default: { tenant: "tenant-a" }, other: { tenant: "tenant-b" } },
    } },
  };
  gatewayCfg = structuredClone(cfg);
  primary = createRuntime("default", "tenant-a");
  named = createRuntime("other", "tenant-b");
  gatewayRuntimes = new Map([["default", primary], ["other", named]]);
  gatewayPlugin = createNatsWebChannelPlugin(gatewayRuntimes);
  handoffHandler = createOutboundHandoffHandler({
    resolveOutboundTransport: (id) => gatewayRuntimes.get(id)?.channel,
    resolveServingScope: (id) => gatewayRuntimes.get(id),
  });
  cliPlugin = createNatsWebChannelPlugin(new Map());
  gatewayUnavailable = false;
  connections = [];
  requests = [];
  const context = { getRuntimeConfig: () => gatewayCfg, dedupe: new Map() };
  gatewayTesting.setDepsForTests({
    getRuntimeConfig: () => gatewayCfg,
    loadOrCreateDeviceIdentity: () => { throw new Error("fixture must use local shared-token auth"); },
    createGatewayClient: (options: GatewayClientOptions) => {
      connections.push(options);
      if (connections.length > 1) throw new Error("unexpected recursive gateway send");
      return {
        start: () => queueMicrotask(() => {
          if (gatewayUnavailable) options.onClose(1006, "");
          else options.onHelloOk({ features: { methods: ["send"] } });
        }),
        stop: () => {},
        request: async (method: string, params: Record<string, any>) => {
          const wireParams = JSON.parse(JSON.stringify(params));
          requests.push({ method, params: wireParams });
          expect(method).toBe(WEBCHANNEL_SEND_METHOD);
          activate(gatewayPlugin);
          return new Promise((resolve, reject) => {
            void handoffHandler({
              params: wireParams, context,
              client: { connect: { scopes: ["operator.write"] } },
              respond: (ok: boolean, payload: unknown, error?: { message: string }) => {
                if (ok) resolve(payload);
                else reject(new Error(error?.message));
              },
            } as any)?.catch(reject);
          });
        },
      };
    },
  });
});

afterEach(() => {
  gatewayTesting?.resetDepsForTests();
  if (setActiveRegistry) setActiveRegistry(createEmptyRegistry());
  for (const runtime of [primary, named]) {
    runtime?.channel.dispose();
    runtime?.journal.close();
  }
});

afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(suiteRoot, { recursive: true, force: true });
});

function messageAction(gateway?: object) {
  return runMessageAction({
    cfg, action: "send", agentId: "main",
    params: { channel: "webchannel", target: `webchannel:${PEER}`, accountId: "other", message: TEXT },
    gateway: gateway ?? { clientName: "cli", mode: "cli" },
  });
}

function expectDelivered() {
  expect(primary.transport.frames).toEqual([]);
  expect(primary.journal.read(PEER)).toEqual([]);
  expect(named.transport.frames).toHaveLength(1);
  const frame = named.transport.frames[0];
  expect(frame.subject).toBe(`webchannel.tenant-b.other.${PEER}.out`);
  expect(frame.payload.toString()).not.toContain(TEXT);
  const { message } = openEnvelope(frame.payload, named.keyStore.getOrCreate(PEER));
  expect(message).toMatchObject({ type: "agent_message", text: TEXT, id: expect.any(String) });
  expect(named.journal.read(PEER).map(({ event }) => event)).toEqual([
    { kind: "bubble", answerId: (message as { id: string }).id, text: TEXT },
  ]);
  const sessionKey = buildWebchannelPeerSessionKey({ cfg, agentId: "main", servingTenant: "tenant-b", accountId: "other", peerId: PEER });
  const sessions = JSON.parse(readFileSync(join(root, "sessions.json"), "utf8"));
  expect(transcript(sessionKey)).toContain(TEXT);
  expect(Object.keys(sessions)).toContain(sessionKey);
  expect(Object.keys(sessions)).not.toContain("agent:main:main");
  return (message as { id: string }).id;
}

describe("gateway-owned core outbound delivery (#418)", () => {
  it("sends from a CLI with no account runtime through the gateway's selected account", async () => {
    activate(cliPlugin);
    const result = await messageAction();
    const messageId = expectDelivered();
    expect(result.payload).toMatchObject({ via: "gateway", result: { messageId } });
    expect(connections).toHaveLength(1);
    expect(connections[0]).toMatchObject({ clientName: "cli", mode: "cli" });
    expect(requests).toEqual([{ method: WEBCHANNEL_SEND_METHOD, params: expect.objectContaining({
      accountId: "other", peerId: PEER, text: TEXT, tenant: "tenant-b", storageRoot: root,
    }) }]);
  });

  it("keeps the agent message tool in the serving process without an RPC", async () => {
    activate(gatewayPlugin);
    // createMessageTool in the pinned core passes this backend identity to
    // runMessageAction, the same action runner used by the CLI above.
    const result = await messageAction({ clientName: "gateway-client", clientDisplayName: "agent", mode: "backend" });
    const messageId = expectDelivered();
    expect(result.payload).toMatchObject({ via: "direct", result: { messageId } });
    expect(connections).toEqual([]);
    expect(requests).toEqual([]);
  });

  it("keeps cron delivery inside the gateway without opening an RPC client", async () => {
    activate(gatewayPlugin);
    const result = await dispatchCronDelivery({
      cfgWithAgentDefaults: cfg, agentId: "main", deps: {},
      job: { id: `cron-${root}`, name: "outbound fixture", sessionTarget: "isolated", state: {} },
      agentSessionKey: "agent:main:cron:fixture", runSessionKey: "agent:main:cron:fixture:run:1",
      runStartedAt: Date.now(), sourceDeliveryOutcome: { satisfiesSourceDelivery: false, verifiedMessageToolDelivery: false },
      deliveryRequested: true, deliveryBestEffort: false,
      resolvedDelivery: { ok: true, channel: "webchannel", to: PEER, accountId: "other", mode: "explicit" },
      deliveryPayloads: [{ text: TEXT }], synthesizedText: TEXT, outputText: TEXT,
      isAborted: () => false, withRunSession: (value: unknown) => value,
    });
    expect(result).toMatchObject({ delivered: true, deliveryAttempted: true });
    expectDelivered();
    expect(connections).toEqual([]);
    expect(requests).toEqual([]);
  });

  it("reports core's gateway-unavailable diagnosis and doctor remedy before any send", async () => {
    activate(cliPlugin);
    gatewayUnavailable = true;
    await expect(messageAction()).rejects.toThrow(
      /gateway closed \(1006[\s\S]*Gateway process stopped or became unreachable[\s\S]*Run `openclaw doctor` for diagnostics\./,
    );
    expect(requests).toEqual([]);
    expect(primary.transport.frames).toEqual([]);
    expect(named.transport.frames).toEqual([]);
    expect(named.journal.read(PEER)).toEqual([]);
  });

  it("distinguishes an unavailable account on a reachable gateway without a sibling send", async () => {
    activate(cliPlugin);
    gatewayRuntimes.delete("other");
    await expect(messageAction()).rejects.toThrow('[webchannel] outbound account "other" is not running');
    expect(requests).toHaveLength(1);
    expect(primary.transport.frames).toEqual([]);
    expect(primary.journal.read(PEER)).toEqual([]);
    expect(named.transport.frames).toEqual([]);
    expect(named.journal.read(PEER)).toEqual([]);
  });
});


function sessionKey(accountId: string, tenant: string, config = cfg) {
  return buildWebchannelPeerSessionKey({ cfg: config, agentId: "main", servingTenant: tenant, accountId, peerId: PEER });
}

function transcript(key: string, store = join(root, "sessions.json")): string {
  if (!existsSync(store)) return "";
  const session = JSON.parse(readFileSync(store, "utf8"))[key];
  const file = session && (session.sessionFile ?? join(root, `${session.sessionId}.jsonl`));
  return file && existsSync(file) ? readFileSync(file, "utf8") : "";
}

function expectNothingSent() {
  expect(primary.transport.frames).toEqual([]);
  expect(named.transport.frames).toEqual([]);
  expect(primary.journal.read(PEER)).toEqual([]);
  expect(named.journal.read(PEER)).toEqual([]);
  expect(existsSync(join(root, "sessions.json"))).toBe(false);
}

describe("CLI/gateway identity boundary (#457)", () => {
  it("rejects an explicit account's different tenant and store before send or transcript", async () => {
    const local = cfg.channels!.webchannel as any;
    local.storageRoot = join(root, "cli-store");
    local.accounts.other.tenant = "tenant-cli";
    new ConversationKeyStore({ storageRoot: local.storageRoot, tenant: "tenant-cli", accountId: "other" }).getOrCreate(PEER);
    activate(cliPlugin);
    await expect(messageAction()).rejects.toThrow("handoff tenant/store changed");
    expectNothingSent();
  });

  it("rejects a different store even when tenant and account names match", async () => {
    const local = cfg.channels!.webchannel as any;
    local.storageRoot = join(root, "cli-store");
    new ConversationKeyStore({ storageRoot: local.storageRoot, tenant: "tenant-b", accountId: "other" }).getOrCreate(PEER);
    activate(cliPlugin);
    await expect(messageAction()).rejects.toThrow("handoff tenant/store changed");
    expectNothingSent();
  });

  it("pins the CLI default even when the gateway has a different default", async () => {
    (gatewayCfg.channels!.webchannel as any).defaultAccount = "other";
    activate(cliPlugin);
    const result = await runMessageAction({ cfg, action: "send", agentId: "main", gateway: { clientName: "cli", mode: "cli" },
      params: { channel: "webchannel", target: PEER, message: TEXT } });
    expect(result.payload.via).toBe("gateway");
    expect(requests[0].params.accountId).toBe("default");
    expect(primary.transport.frames).toHaveLength(1);
    expect(named.transport.frames).toEqual([]);
    expect(primary.journal.read(PEER)).toHaveLength(1);
    expect(transcript(sessionKey("default", "tenant-a"))).toContain(TEXT);
    expect(transcript(sessionKey("other", "tenant-b"))).toBe("");
  });

  it("lets the gateway choose transcript configuration without writing a CLI transcript", async () => {
    cfg.session = { store: join(root, "cli-sessions.json"), identityLinks: { cli: [`webchannel:${PEER}`] } };
    gatewayCfg.session = { store: join(root, "sessions.json"), identityLinks: { server: [`webchannel:${PEER}`] } };
    activate(cliPlugin);
    await messageAction();
    expect(named.transport.frames).toHaveLength(1);
    expect(transcript(sessionKey("other", "tenant-b", gatewayCfg))).toContain(TEXT);
    expect(existsSync(join(root, "cli-sessions.json"))).toBe(false);
    expect(transcript(sessionKey("other", "tenant-b", cfg))).toBe("");
  });

  it("preserves exact listed account spelling across a canonical CLI alias", async () => {
    for (const config of [cfg, gatewayCfg]) {
      const accounts = (config.channels!.webchannel as any).accounts;
      accounts.Other = accounts.other;
      delete accounts.other;
    }
    named.channel.dispose(); named.journal.close();
    named = createRuntime("Other", "tenant-b");
    gatewayRuntimes.delete("other"); gatewayRuntimes.set("Other", named);
    activate(cliPlugin);
    await messageAction();
    expect(requests[0].params.accountId).toBe("Other");
    expect(named.transport.frames[0].subject).toBe("webchannel.tenant-b.Other.Alice.out");
    expect(transcript(sessionKey("Other", "tenant-b"))).toContain(TEXT);
  });

  it("does not reinterpret an exact listed account as an alias on the gateway", async () => {
    const accounts = (gatewayCfg.channels!.webchannel as any).accounts;
    accounts.Other = accounts.other; delete accounts.other;
    activate(cliPlugin);
    await expect(messageAction()).rejects.toThrow("handoff account identity changed");
    expectNothingSent();
  });

  it("refuses disabled gateway accounts before any write", async () => {
    (gatewayCfg.channels!.webchannel as any).accounts.other.enabled = false;
    activate(cliPlugin);
    await expect(messageAction()).rejects.toThrow('outbound account "other" is disabled');
    expectNothingSent();
  });

  it("keeps dry run side-effect free", async () => {
    activate(cliPlugin);
    const result = await runMessageAction({ cfg, action: "send", agentId: "main", dryRun: true,
      params: { channel: "webchannel", target: PEER, accountId: "other", message: TEXT } });
    expect(result.dryRun).toBe(true);
    expect(connections).toEqual([]);
    expectNothingSent();
  });

  it("refuses an agent account outage instead of handing an already-routed send to another runtime", async () => {
    gatewayRuntimes.delete("other");
    activate(gatewayPlugin);
    await expect(messageAction({ clientName: "gateway-client", mode: "backend" })).rejects.toThrow('outbound account "other" is not running');
    expect(connections).toEqual([]);
    expect(named.transport.frames).toEqual([]);
    expect(transcript(sessionKey("other", "tenant-b"))).toBe("");
  });

  it("registers the handoff RPC with operator.write scope", () => {
    const registerGatewayMethod = vi.fn();
    registerOutboundHandoff({ registerGatewayMethod } as any, {
      resolveOutboundTransport: (id) => gatewayRuntimes.get(id)?.channel,
      resolveServingScope: (id) => gatewayRuntimes.get(id),
    });
    expect(registerGatewayMethod).toHaveBeenCalledWith(WEBCHANNEL_SEND_METHOD, expect.any(Function), { scope: "operator.write" });
  });

  it("rejects a live serving tenant that differs from both config files", async () => {
    named.channel.dispose(); named.journal.close();
    named = createRuntime("other", "tenant-live");
    gatewayRuntimes.set("other", named);
    activate(cliPlugin);
    await expect(messageAction()).rejects.toThrow("handoff tenant/store changed");
    expectNothingSent();
  });

  it("rechecks the tuple at delivery after a runtime changes during the durable pipeline", async () => {
    const original = gatewayPlugin.outbound!.sendPayload!;
    gatewayPlugin.outbound!.sendPayload = async (ctx) => {
      named.channel.dispose(); named.journal.close();
      named = createRuntime("other", "tenant-replacement");
      gatewayRuntimes.set("other", named);
      return original(ctx);
    };
    activate(cliPlugin);
    await expect(messageAction()).rejects.toThrow("handoff tenant/store changed");
    expect(named.transport.frames).toEqual([]);
    expect(named.journal.read(PEER)).toEqual([]);
    expect(transcript(sessionKey("other", "tenant-b"))).toBe("");
    expect(transcript(sessionKey("other", "tenant-replacement"))).toBe("");
  });

  it("deduplicates concurrent repeated RPCs and rejects reuse for different text", async () => {
    activate(gatewayPlugin);
    const params = { accountId: "other", tenant: "tenant-b", storageRoot: root, peerId: PEER,
      agentId: "main", text: TEXT, idempotencyKey: "same-request" };
    const call = (request = params) => new Promise<any>((resolve, reject) => {
      void handoffHandler({ params: request, context: { getRuntimeConfig: () => gatewayCfg },
        client: { connect: { scopes: ["operator.write"] } },
        respond: (ok: boolean, value: unknown, error?: { message: string }) => ok ? resolve(value) : reject(new Error(error?.message)),
      } as any);
    });
    const [a, b] = await Promise.all([call(), call()]);
    expect(a).toEqual(b);
    await expect(call({ ...params, text: "different" })).rejects.toThrow("reused for a different request");
    expectDelivered();
    expect(transcript(sessionKey("other", "tenant-b")).split(TEXT)).toHaveLength(2);
  });
});


describe("text-only outbound suppression", () => {
  afterEach(async () => {
    const { resetGlobalHookRunner } = await import("openclaw/plugin-sdk/plugin-runtime");
    resetGlobalHookRunner();
  });

  it("preserves presentation until core renders its fallback text", async () => {
    const { sendDurableMessageBatch } = await import("openclaw/plugin-sdk/channel-outbound");
    activate(gatewayPlugin);
    const result = await sendDurableMessageBatch({ cfg: gatewayCfg, channel: "webchannel", accountId: "other", to: PEER,
      payloads: [{ presentation: { blocks: [{ type: "text", text: TEXT }] } }],
    });
    expect(result.status).toBe("sent");
    expect(named.transport.frames).toHaveLength(1);
    expect(openEnvelope(named.transport.frames[0].payload, named.keyStore.getOrCreate(PEER)).message)
      .toMatchObject({ type: "agent_message", text: TEXT });
    expect(named.journal.read(PEER)[0].event).toMatchObject({ kind: "bubble", text: TEXT });
  });

  it.each(["cli", "backend"] as const)("suppresses hook-emptied %s sends without a frame, bubble or transcript", async (mode) => {
    const { initializeGlobalHookRunner } = await import("openclaw/plugin-sdk/plugin-runtime");
    const registry = createEmptyRegistry() as any;
    registry.typedHooks.push({ pluginId: "empty-outbound-test", hookName: "message_sending", handler: () => ({ content: "" }) });
    initializeGlobalHookRunner(registry);
    activate(mode === "cli" ? cliPlugin : gatewayPlugin);
    const result = await messageAction(mode === "cli"
      ? { clientName: "cli", mode: "cli" }
      : { clientName: "gateway-client", mode: "backend" });
    expect(result.payload.deliveryStatus).toBe("suppressed");
    expect(primary.transport.frames).toEqual([]);
    expect(named.transport.frames).toEqual([]);
    expect(named.journal.read(PEER)).toEqual([]);
    expect(transcript(sessionKey("other", "tenant-b"))).toBe("");
  });

  it("suppresses unbound metadata-only payloads after hooks too", async () => {
    const { initializeGlobalHookRunner } = await import("openclaw/plugin-sdk/plugin-runtime");
    const { sendDurableMessageBatch } = await import("openclaw/plugin-sdk/channel-outbound");
    const registry = createEmptyRegistry() as any;
    registry.typedHooks.push({ pluginId: "empty-outbound-test", hookName: "message_sending", handler: () => ({ content: "" }) });
    initializeGlobalHookRunner(registry);
    activate(gatewayPlugin);
    const result = await sendDurableMessageBatch({ cfg: gatewayCfg, channel: "webchannel", accountId: "other", to: PEER,
      payloads: [{ text: TEXT, channelData: { extra: "metadata" }, audioAsVoice: true }],
    });
    expect(result.status).toBe("suppressed");
    expect(named.transport.frames).toEqual([]);
    expect(named.journal.read(PEER)).toEqual([]);
  });
});
