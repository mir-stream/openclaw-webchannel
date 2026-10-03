/**
 * #418: exercise the pinned core's message-action -> send RPC -> durable send
 * path. Only the gateway socket is replaced: its client hands serialized RPC
 * params to core's real server handler under the gateway's plugin registry.
 * The CLI registry has no account runtimes. NATS encryption and SQLite are real.
 */
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
let sendHandlers: { send: CoreCall };
let createEmptyRegistry: () => Registry;
let setActiveRegistry: (registry: Registry) => void;
let gatewayTesting: {
  setDepsForTests: (deps: Record<string, unknown>) => void;
  resetDepsForTests: () => void;
};
let suiteRoot: string;
let root: string;
let cfg: OpenClawConfig;
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
  sendHandlers = await loadCoreExport("send-", "src/gateway/server-methods/send.ts", "sendHandlers");
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
      accounts: { default: { tenant: "tenant-a" }, other: { tenant: "tenant-b" } },
    } },
  };
  primary = createRuntime("default", "tenant-a");
  named = createRuntime("other", "tenant-b");
  gatewayPlugin = createNatsWebChannelPlugin(new Map([["default", primary], ["other", named]]));
  cliPlugin = createNatsWebChannelPlugin(new Map());
  gatewayUnavailable = false;
  connections = [];
  requests = [];
  const context = { getRuntimeConfig: () => cfg, dedupe: new Map() };
  gatewayTesting.setDepsForTests({
    getRuntimeConfig: () => cfg,
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
          expect(method).toBe("send");
          activate(gatewayPlugin);
          return new Promise((resolve, reject) => {
            void sendHandlers.send({
              params: wireParams, context,
              client: { connect: { scopes: ["operator.write"] } },
              respond: (ok: boolean, payload: unknown, error?: { message: string }) => {
                if (ok) resolve(payload);
                else reject(new Error(error?.message));
              },
            }).catch(reject);
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
    ...(gateway ? { gateway } : {}),
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
    expect(requests).toEqual([{ method: "send", params: expect.objectContaining({
      channel: "webchannel", accountId: "other", to: PEER, message: TEXT,
    }) }]);
  });

  it("keeps the agent message tool's backend path deliverable without recursive RPC", async () => {
    activate(gatewayPlugin);
    // createMessageTool in the pinned core passes this backend identity to
    // runMessageAction, the same action runner used by the CLI above.
    const result = await messageAction({ clientName: "gateway-client", clientDisplayName: "agent", mode: "backend" });
    const messageId = expectDelivered();
    expect(result.payload).toMatchObject({ via: "gateway", result: { messageId } });
    expect(connections).toHaveLength(1);
    expect(connections[0]).toMatchObject({ clientName: "gateway-client", mode: "backend" });
    expect(requests).toHaveLength(1);
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
    gatewayPlugin = createNatsWebChannelPlugin(new Map([["default", primary]]));
    await expect(messageAction()).rejects.toThrow('[webchannel] outbound account "other" is not running');
    expect(requests).toHaveLength(1);
    expect(primary.transport.frames).toEqual([]);
    expect(primary.journal.read(PEER)).toEqual([]);
    expect(named.transport.frames).toEqual([]);
    expect(named.journal.read(PEER)).toEqual([]);
  });
});
