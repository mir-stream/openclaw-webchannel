import { createPrivateKey } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createPersistentDedupe } from "openclaw/plugin-sdk/persistent-dedupe";
import { createBoundedInboundDebouncer } from "../packages/plugin/src/bounded-inbound-debouncer.js";
import { ConversationKeyStore } from "../packages/plugin/src/conversation-key-store.js";
import { openDeliveryJournal } from "../packages/plugin/src/delivery-journal.js";
import { createDispatchRecovery } from "../packages/plugin/src/dispatch-recovery.js";
import { createIngressDebounceCallbacks } from "../packages/plugin/src/ingress-debounce-callbacks.js";
import { CancelledInboundFallbackTombstones, createIngressOnFlush } from "../packages/plugin/src/ingress-dedupe.js";
import { createIngressOutcomeStore } from "../packages/plugin/src/ingress-outcome.js";
import { BoundedOverflowResolver } from "../packages/plugin/src/inbound-overflow-resolver.js";
import { DEFAULT_BUSY_TURN_LIMITS, estimateRetainedMessageBytes, InboundRetentionBudget } from "../packages/plugin/src/inbound-retention.js";
import type { UserMessageLike } from "../packages/plugin/src/inbound-queue.js";
import { NatsChannel } from "../packages/plugin/src/nats-channel.js";
import type { NatsTransport } from "../packages/plugin/src/nats-transport.js";
import { createStopControl } from "../packages/plugin/src/stop-control.js";
import { WebChannelNATSClient } from "../packages/client/src/nats-client-wrapper.js";
import { inboundSubject, type InboundMessage } from "../packages/client/src/nats-client.js";
import { openMessage, sealMessage } from "../packages/client/src/e2e-crypto-browser.js";
import { generateDevicePopKeyPair } from "../packages/client/src/pop-register.js";
import {
  AGENT, FakeNatsWS, JWT, PEER, TENANT, generateDeviceX25519,
  installFakeWebSocket, makeAgentIdentity, registerAgent, settleUntil,
} from "../packages/client/src/nats-client-wrapped.test-harness.js";

type Item = { peerId: string; message: UserMessageLike };
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

// The relay and registered device are fixtures. Cancellation capture, SQLite,
// ingress replay, ACK construction/packing/encryption, and the client are real.
it.each([false, true])("pre-admission stop does not become permanent active recovery (lost ACK/cold restart=%s)", async (cold) => {
  const root = mkdtempSync(join(tmpdir(), "webchannel-stop-client-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  cleanups.push(installFakeWebSocket());
  const identity = makeAgentIdentity();
  const x = await generateDeviceX25519();
  const pop = await generateDevicePopKeyPair();
  const keyStore = new ConversationKeyStore({ tenant: TENANT, accountId: AGENT, storageRoot: root });
  const key = keyStore.getOrCreate(PEER);
  const registration = registerAgent(key, x.publicRaw, identity);
  const identityKeyPair = { publicKey: identity.publicRaw,
    privateKey: new Uint8Array((createPrivateKey(identity.privatePem).export({ type: "pkcs8", format: "der" }) as Buffer).subarray(-32)) };
  let socket: FakeNatsWS | undefined;
  let loseCancellation = cold;
  let registrations = 0;
  const clientPublishes: UserMessageLike[] = [];
  const serverFrames: InboundMessage[] = [];
  const executions: UserMessageLike[] = [];
  const controls: UserMessageLike[] = [];
  const errors: unknown[] = [];

  class RelayTransport extends EventEmitter {
    connected = true;
    effectiveOutboundLimit = 64 * 1024;
    private sid = 0;
    subscribe() { return ++this.sid; }
    unsubscribe() {}
    publish(subject: string, payload: string | Uint8Array) {
      const wire = typeof payload === "string" ? payload : Buffer.from(payload).toString("utf8");
      const frame = openMessage(wire, key) as InboundMessage;
      serverFrames.push(frame);
      if (loseCancellation && frame.type === "ack" && frame.cancelled?.length) return;
      socket?.deliverToClient(subject, wire);
    }
  }

  const openRuntime = () => {
    const journal = openDeliveryJournal({ databasePath: join(root, "journal.sqlite") });
    const transport = new RelayTransport();
    const channel = new NatsChannel(transport as unknown as NatsTransport, AGENT, TENANT,
      { keyStore, identityKeyPair }, undefined, { deliveryJournal: journal });
    const persistent = (namespacePrefix: string) => createPersistentDedupe({
      pluginId: "webchannel", namespacePrefix, ttlMs: 60_000, memoryMaxSize: 100, stateMaxEntries: 100,
      env: { ...process.env, OPENCLAW_STATE_DIR: join(root, "sdk") },
    });
    const outcomeStore = createIngressOutcomeStore({
      accepted: persistent("accepted"), overloaded: persistent("overloaded"), cancelled: persistent("cancelled"),
    });
    const budget = new InboundRetentionBudget(DEFAULT_BUSY_TURN_LIMITS);
    const token = budget.createSessionToken();
    const sessionToken = () => token;
    let active = true;
    const recovery = createDispatchRecovery({
      store: journal.dispatch!, isActive: () => active, acquirePeer: () => () => {},
      notify: (change) => { channel.sendRequestState(change); }, warn: (error) => errors.push(error),
      dispatcherOptions: { budget, sessionToken },
      handler: async (_peer, message, settle) => { executions.push(message); settle("ok"); },
    });
    recovery.start();
    const fallback = new CancelledInboundFallbackTombstones();
    const resolver = new BoundedOverflowResolver({
      outcomeStore, lookupUserRow: ({ peerId }, id) => journal.lookupUserMessageIdByRandomId(peerId, id),
      sendAck: ({ peerId, id }, committed, cancelled) => channel.sendAck(peerId, [id], committed, cancelled ? [id] : undefined),
      sendRejected: ({ peerId, id }) => channel.sendInboundRejected(peerId, [id]),
    });
    const flush = createIngressOnFlush<Item>({
      accountId: AGENT, outcomeStore, deliveryJournal: journal, dispatchRecovery: recovery,
      beginBatch: (peer) => recovery.beginBatch(peer), cancelledFallback: fallback,
      sendAck: (...args) => channel.sendAck(...args),
      sendInboundRejected: (...args) => channel.sendInboundRejected(...args), isActive: () => active,
    });
    const debouncer = createBoundedInboundDebouncer<Item>({
      debounceMs: 60_000, buildKey: (item) => item.peerId, sessionToken, budget,
      measure: (item) => estimateRetainedMessageBytes(item.message), onFlush: flush,
      ...createIngressDebounceCallbacks<Item>({
        accountId: AGENT, outcomeStore, overflowResolver: resolver, cancelledFallback: fallback,
        deliveryJournal: journal, sessionToken,
        sendAck: (...args) => channel.sendAck(...args),
        sendRejected: (...args) => channel.sendInboundRejected(...args),
      }),
    });
    const stop = createStopControl({
      journal, recovery, debouncer, sendAck: (...args) => channel.sendAck(...args),
      pendingOverflowKey: () => resolver.pendingLogicalKey(token),
      retireOverflow: () => resolver.invalidateSession(token), isActive: () => active,
      dispatchControl: async (_peer, message) => { controls.push(message); }, warn: (error) => errors.push(error),
    });
    channel.setMessageHandler((peerId, message) => {
      if (message.type !== "user_message") return;
      if (message.text === "/stop") stop.handle({ peerId, message }, true);
      else debouncer.push({ peerId, message });
    });
    let closing: Promise<void> | undefined;
    const close = () => closing ??= (async () => {
      active = false;
      debouncer.dispose(); recovery.dispose(); resolver.dispose();
      await stop.dispose();
      channel.dispose(); journal.close();
      expect(budget.usage()).toEqual({ messages: 0, bytes: 0 });
    })();
    cleanups.push(close);
    return { journal, channel, transport, debouncer, budget, close };
  };
  let runtime = openRuntime();
  const IN = inboundSubject(TENANT, AGENT, PEER);
  FakeNatsWS.sharedHandler = async (subject, payload, server, reply) => {
    if (subject.endsWith(".register")) {
      const isRegister = JSON.parse(payload).op === "register";
      if (isRegister) {
        socket = server;
        registrations++;
        runtime.channel.registerPeer(PEER);
      }
      await registration(subject, payload, server, reply);
      if (isRegister) runtime.channel.sendHistory(PEER, [], runtime.journal.maxSeq(PEER));
    } else if (subject === IN) {
      clientPublishes.push(openMessage(payload, key) as UserMessageLike);
      runtime.transport.emit("message", { subject, payload: Buffer.from(payload) });
    }
  };
  const wrapper = new WebChannelNATSClient({
    natsUrl: "ws://fixture", bootstrapJwt: JWT, accountId: AGENT, tenant: TENANT, peerId: PEER,
    ackStallTimeoutMs: 100, heartbeatIntervalMs: 5, reconnectBaseMs: 1, reconnectCapMs: 1,
    registration: { devicePrivateKey: pop.privateKey, deviceX25519PrivateKey: x.privateKey,
      pinnedAgentPublicKey: identity.publicB64url },
  });
  cleanups.push(() => wrapper.close());
  wrapper.connect();
  await settleUntil(() => wrapper.getState().connected, { label: "registered client" });
  const receipt = wrapper.send("cancel before debounce flush")!;
  expect(receipt.snapshot().state).toBe("sent");
  const input = clientPublishes[0]!;
  expect(runtime.debouncer.retainedItems(PEER)).toHaveLength(1);
  // Another authenticated device stops the input; no local /stop UI shortcut.
  runtime.transport.emit("message", { subject: IN, payload: Buffer.from(sealMessage(
    { accountId: AGENT, tenant: TENANT, sub: PEER }, key,
    { type: "user_message", id: "other-device-stop", random_id: "other-device-stop-key", text: "/stop" },
  )) });
  expect(runtime.journal.dispatch!.isCancelled(PEER, input.random_id!)).toBe(true);
  expect(runtime.journal.dispatch!.lookup(PEER, input.random_id!)).toBeUndefined();
  expect(runtime.journal.read(PEER)).toEqual([]);
  if (cold) {
    expect(receipt.snapshot().state).toBe("sent");
    await runtime.close();
    runtime = openRuntime();
    loseCancellation = false;
    socket!.close();
    await settleUntil(() => receipt.snapshot().state === "accepted" && wrapper.getState().connected,
      { label: "cold cancellation replay received" });
    expect(clientPublishes.map((message) => message.id)).toEqual([input.id, input.id]);
  } else {
    expect(receipt.snapshot().state).toBe("accepted");
    expect(clientPublishes).toHaveLength(1);
  }
  expect(serverFrames.some((frame) => frame.type === "ack" && frame.cancelled?.includes(input.id!))).toBe(true);
  expect(wrapper.getState().turnActive).not.toBe(true);
  expect(executions).toEqual([]);
  expect(controls).toHaveLength(1);
  expect(runtime.journal.read(PEER)).toEqual([]);
  expect(runtime.budget.usage()).toEqual({ messages: 0, bytes: 0 });
  const registeredAtCancellation = registrations;
  await new Promise((resolve) => setTimeout(resolve, 350));
  expect(registrations).toBe(registeredAtCancellation);
  expect(receipt.snapshot().state).toBe("accepted");
  expect(errors).toEqual([]);
});
