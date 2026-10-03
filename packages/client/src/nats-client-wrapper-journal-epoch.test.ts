import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebChannelNATSClient } from "./nats-client-wrapper.js";
import { inboundSubject, outboundSubject, type InboundMessage, type OutboundMessage } from "./nats-client.js";
import { openMessage, sealMessage } from "./e2e-crypto-browser.js";
import { generateDevicePopKeyPair } from "./pop-register.js";
import {
  AGENT, FakeNatsWS, JWT, PEER, TENANT, generateDeviceX25519, installFakeWebSocket,
  makeAgentIdentity, registerAgent, settleUntil,
} from "./nats-client-wrapped.test-harness.js";

function setup() {
  const wrapper = new WebChannelNATSClient({ natsUrl: "ws://127.0.0.1:4222", bootstrapJwt: "test",
    accountId: "a", tenant: "t", peerId: "p",
    registration: { devicePrivateKey: {} as CryptoKey, deviceX25519PrivateKey: {} as CryptoKey } });
  const inner = wrapper as unknown as {
    handleMessage(msg: InboundMessage): void;
    cursor: { state: string; last: number; afterSeq: number; nonce: string };
    client: { getDifference: ReturnType<typeof vi.fn>; requestApplicationRecovery: ReturnType<typeof vi.fn>;
      sendUserMessage: ReturnType<typeof vi.fn>; hasPendingRandomId: ReturnType<typeof vi.fn> };
  };
  inner.client.getDifference = vi.fn();
  inner.client.requestApplicationRecovery = vi.fn(() => true);
  inner.client.sendUserMessage = vi.fn();
  inner.client.hasPendingRandomId = vi.fn(() => true);
  const send = (msg: InboundMessage) => inner.handleMessage(msg);
  send({ type: "history", epoch: "old", highWaterSeq: 10,
    messages: [{ id: "webchannel-user-1", role: "user", text: "OLD question", seq: 1 }] });
  return { wrapper, inner, send };
}

describe("#414 journal epoch", () => {
  it("clears an empty new epoch without confusing an ordinary reconnect with a reset", () => {
    const { wrapper, inner, send } = setup();
    try {
      send({ type: "history", epoch: "old", highWaterSeq: 10, messages: [] });
      expect(wrapper.getState().messages.map(m => m.text)).toEqual(["OLD question"]);
      send({ type: "history", epoch: "new", highWaterSeq: 0, messages: [] });
      expect(wrapper.getState().messages).toEqual([]);
      expect(inner.cursor).toMatchObject({ state: "synced", last: 0 });
      expect(inner.client.requestApplicationRecovery).not.toHaveBeenCalled();
      send({ type: "user_committed", epoch: "new", id: "webchannel-user-1", text: "NEW question", seq: 1 });
      expect(wrapper.getState().messages.map(m => m.text)).toEqual(["NEW question"]);
    } finally { wrapper.close(); }
  });

  it("cannot restart recovery after a subscriber closes during the cold reset", () => {
    const { wrapper, inner, send } = setup();
    try {
      const unsubscribe = wrapper.subscribe(state => {
        if (state.messages.length === 0) { unsubscribe(); wrapper.close(); }
      });
      send({ type: "user_committed", epoch: "new", id: "webchannel-user-1", text: "NEW question", seq: 1 });
      expect(wrapper.getState().messages).toEqual([]);
      expect(inner.client.requestApplicationRecovery).not.toHaveBeenCalled();
    } finally { wrapper.close(); }
  });

  it("cold-resets a lower snapshot, row versions and tombstones, and ignores the retired epoch", () => {
    const { wrapper, inner, send } = setup();
    try {
      send({ type: "turn_snapshot", epoch: "old", seq: 11, turnId: "turn", answers: [], remove: ["answer"] });
      send({ type: "history", epoch: "new", highWaterSeq: 2, messages: [
        { id: "webchannel-user-1", role: "user", text: "NEW question", seq: 1 },
        { id: "answer", role: "agent", text: "NEW answer", seq: 2 },
      ] });
      expect(wrapper.getState().messages.map(m => m.text)).toEqual(["NEW question", "NEW answer"]);
      expect(inner.cursor).toMatchObject({ state: "synced", last: 2 });
      send({ type: "history", epoch: "old", highWaterSeq: 20,
        messages: [{ id: "webchannel-user-1", role: "user", text: "stale", seq: 20 }] });
      send({ type: "user_committed", epoch: "old", id: "stale", text: "stale", seq: 21 });
      expect(wrapper.getState().messages.map(m => m.text)).toEqual(["NEW question", "NEW answer"]);
      expect(inner.client.getDifference).not.toHaveBeenCalled();
    } finally { wrapper.close(); }
  });

  it("accepts a reused user ID on the non-origin device when live beats the new snapshot", () => {
    const { wrapper, inner, send } = setup();
    try {
      send({ type: "user_committed", epoch: "new", id: "webchannel-user-1", text: "NEW question", seq: 1 });
      expect(wrapper.getState().messages.map(m => m.text)).toEqual(["NEW question"]);
      expect(inner.cursor.last).toBe(1);
      expect(inner.client.requestApplicationRecovery).toHaveBeenCalledTimes(1);
      send({ type: "history", epoch: "new", highWaterSeq: 1,
        messages: [{ id: "webchannel-user-1", role: "user", text: "NEW question", seq: 1 }] });
      expect(wrapper.getState().messages).toHaveLength(1);
    } finally { wrapper.close(); }
  });

  it("keeps an unconfirmed own send and receipt when the first new-epoch frame is its ACK", () => {
    const { wrapper, inner, send } = setup();
    try {
      const receipt = wrapper.send("NEW question")!;
      const [, wireId, randomId] = inner.client.sendUserMessage.mock.calls[0]!;
      send({ type: "ack", epoch: "new", ids: [wireId],
        committed: [{ random_id: randomId, messageId: "webchannel-user-1", seq: 1 }] });
      send({ type: "user_committed", epoch: "new", id: "webchannel-user-1", text: "NEW question",
        random_id: randomId, turnId: wireId, seq: 1 });
      expect(wrapper.getState().messages).toMatchObject([
        { id: "webchannel-user-1", text: "NEW question", receiptKey: receipt.id, wireId },
      ]);
      expect(wrapper.getState().messages).toHaveLength(1);
      expect(inner.cursor.last).toBe(1);
    } finally { wrapper.close(); }
  });

  it("only a correlated difference can reset the epoch, dropping old buffered frames and retries", () => {
    vi.useFakeTimers();
    const { wrapper, inner, send } = setup();
    try {
      send({ type: "agent_message", epoch: "old", id: "old-buffer", text: "old buffer", seq: 12 });
      const nonce = inner.cursor.nonce;
      send({ type: "difference", epoch: "new", afterSeq: 10, nonce: "another-device",
        maxSeq: 10, partial: false, events: [] });
      expect(wrapper.getState().messages.map(m => m.text)).toEqual(["OLD question"]);
      expect(inner.cursor.nonce).toBe(nonce);
      send({ type: "difference", epoch: "new", afterSeq: 10, nonce, maxSeq: 10, partial: false, events: [] });
      expect(wrapper.getState().messages).toEqual([]);
      expect(inner.cursor.state).toBe("unseeded");
      expect(inner.client.requestApplicationRecovery).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(60_000);
      expect(inner.client.getDifference).toHaveBeenCalledTimes(1);
    } finally { wrapper.close(); vi.useRealTimers(); }
  });
});

type WireUser = Extract<OutboundMessage, { type: "user_message" }>;

async function setupEncryptedEpochHarness() {
  const key = new Uint8Array(32).fill(43);
  const identity = makeAgentIdentity();
  const pop = await generateDevicePopKeyPair();
  const x = await generateDeviceX25519();
  const registration = registerAgent(key, x.publicRaw, identity);
  const received: WireUser[] = [];
  FakeNatsWS.sharedHandler = async (subject, payload, server, replyTo) => {
    await registration(subject, payload, server, replyTo);
    if (subject !== inboundSubject(TENANT, AGENT, PEER)) return;
    const message = openMessage(payload, key) as OutboundMessage | null;
    if (message?.type === "user_message") received.push(message);
  };
  const wrapper = new WebChannelNATSClient({
    natsUrl: "ws://fixture", bootstrapJwt: JWT, accountId: AGENT, tenant: TENANT, peerId: PEER,
    reconnectBaseMs: 1, reconnectCapMs: 1, heartbeatIntervalMs: 0, ackStallTimeoutMs: 0,
    registration: {
      devicePrivateKey: pop.privateKey,
      deviceX25519PrivateKey: x.privateKey,
      pinnedAgentPublicKey: identity.publicB64url,
    },
  });
  wrapper.connect();
  await settleUntil(() => wrapper.getState().connected, { label: "encrypted epoch harness" });
  const deliver = (message: InboundMessage, socket = FakeNatsWS.instances.at(-1)!) => {
    socket.deliverToClient(
      outboundSubject(TENANT, AGENT, PEER),
      sealMessage({ accountId: AGENT, tenant: TENANT, sub: PEER }, key, message),
    );
  };
  const lowLevel = () => (wrapper as unknown as { client: {
    unackedLedger: Map<string, unknown>;
  } }).client;
  deliver({ type: "history", epoch: "A", highWaterSeq: 0, messages: [] });
  return { wrapper, received, deliver, lowLevel };
}

describe("#414 encrypted receive ordering", () => {
  let restore: () => void;
  beforeEach(() => { restore = installFakeWebSocket(); });
  afterEach(() => { restore(); });

  it("gates stale and epochless results before ledger/tracker side effects, while a new-epoch ACK remains authoritative", async () => {
    const h = await setupEncryptedEpochHarness();
    try {
      const first = h.wrapper.send("first")!;
      await settleUntil(() => h.received.length === 1, { label: "first encrypted publish" });
      const a = h.received[0]!;
      expect(first.snapshot().state).toBe("sent");
      expect(h.lowLevel().unackedLedger.size).toBe(1);

      h.deliver({ type: "ack", epoch: "B", ids: [a.id!],
        committed: [{ random_id: a.random_id!, messageId: "b-user-1", seq: 1 }] });
      expect(first.snapshot().state).toBe("accepted");
      expect(h.lowLevel().unackedLedger.size).toBe(0);
      expect(h.wrapper.getState().messages).toMatchObject([
        { id: "b-user-1", text: "first", receiptKey: first.id, wireId: a.id },
      ]);
      h.deliver({ type: "turn_settled", epoch: "B", turnId: a.id, outcome: "ok" });

      const second = h.wrapper.send("second")!;
      await settleUntil(() => h.received.length === 2, { label: "second encrypted publish" });
      const b = h.received[1]!;
      for (const stale of [
        { type: "inbound_rejected", epoch: "A", ids: [b.id!], reason: "overloaded" },
        { type: "inbound_rejected", ids: [b.id!], reason: "overloaded" },
        { type: "ack", epoch: "A", ids: [b.id!], cancelled: [b.id!], unaccepted: [b.id!] },
      ] satisfies InboundMessage[]) h.deliver(stale);
      expect(second.snapshot().state).toBe("sent");
      expect(h.lowLevel().unackedLedger.size).toBe(1);

      const unsubscribe = second.subscribe((snapshot) => {
        if (snapshot.state === "accepted") h.wrapper.close();
      });
      h.deliver({ type: "ack", epoch: "B", ids: [b.id!],
        committed: [{ random_id: b.random_id!, messageId: "b-user-2", seq: 2 }] });
      unsubscribe();
      expect(second.snapshot().state).toBe("accepted");
      expect(h.lowLevel().unackedLedger.size).toBe(0);
      expect(h.wrapper.getState().messages.some((row) => row.id === "b-user-2")).toBe(false);
    } finally { h.wrapper.close(); }
  });

  it("retains an ACK-lost mapping through replay and separates it from a reused new-epoch server ID", async () => {
    const h = await setupEncryptedEpochHarness();
    try {
      const receipt = h.wrapper.send("original pending send")!;
      await settleUntil(() => h.received.length === 1, { label: "original encrypted publish" });
      const original = h.received[0]!;
      // Another device's uncorrelated page still reconciles exact random IDs,
      // but deliberately does not advance this device's row-version authority.
      h.deliver({ type: "history", epoch: "A", nonce: "another-device", messages: [{
        id: "reused-user-id", role: "user", text: "original pending send",
        randomId: original.random_id, turnId: original.id, seq: 1,
      }] });
      expect(h.wrapper.getState().messages).toMatchObject([
        { id: "reused-user-id", text: "original pending send", receiptKey: receipt.id, wireId: original.id },
      ]);
      expect(h.lowLevel().unackedLedger.size).toBe(1);

      FakeNatsWS.instances[0]!.close();
      await settleUntil(() => FakeNatsWS.instances.length === 2 && h.wrapper.getState().connected,
        { label: "replacement encrypted session" });
      await settleUntil(() => h.received.length === 2, { label: "replayed pending send" });
      expect(h.received[1]).toMatchObject({ id: original.id, random_id: original.random_id,
        text: "original pending send" });

      h.deliver({ type: "history", epoch: "B", highWaterSeq: 1, messages: [
        { id: "reused-user-id", role: "user", text: "new epoch occupant", seq: 1 },
      ] });
      const afterReset = h.wrapper.getState().messages;
      expect(afterReset).toHaveLength(2);
      expect(afterReset).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: "reused-user-id", text: "new epoch occupant" }),
        expect.objectContaining({ text: "original pending send", receiptKey: receipt.id, wireId: original.id }),
      ]));
      expect(afterReset.find((row) => row.receiptKey === receipt.id)?.id).not.toBe("reused-user-id");

      h.deliver({ type: "ack", epoch: "B", ids: [original.id!],
        committed: [{ random_id: original.random_id!, messageId: "b-original", seq: 2 }] });
      h.deliver({ type: "user_committed", epoch: "B", id: "b-original",
        text: "original pending send", random_id: original.random_id, turnId: original.id, seq: 2 });
      expect(receipt.snapshot().state).toBe("accepted");
      expect(h.lowLevel().unackedLedger.size).toBe(0);
      expect(h.wrapper.getState().messages).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: "reused-user-id", text: "new epoch occupant" }),
        expect.objectContaining({ id: "b-original", text: "original pending send",
          receiptKey: receipt.id, wireId: original.id }),
      ]));
    } finally { h.wrapper.close(); }
  });

  it("scopes durable-adoption refusal evidence to the journal epoch", async () => {
    const h = await setupEncryptedEpochHarness();
    try {
      const receipt = h.wrapper.send("accepted only in epoch A")!;
      await settleUntil(() => h.received.length === 1, { label: "epoch A publish" });
      const sent = h.received[0]!;
      h.deliver({ type: "user_committed", epoch: "A", id: "a-user-1",
        text: sent.text, random_id: sent.random_id, turnId: sent.id, seq: 1 });

      h.deliver({ type: "inbound_rejected", epoch: "A", ids: [sent.id!], reason: "policy-denied" });
      expect(receipt.snapshot().state).toBe("sent");
      expect(h.lowLevel().unackedLedger.size).toBe(1);

      h.deliver({ type: "inbound_rejected", epoch: "B", ids: [sent.id!], reason: "policy-denied" });
      expect(receipt.snapshot()).toMatchObject({
        state: "failed", failure: { reason: "policy-denied", retryable: false },
      });
      expect(h.lowLevel().unackedLedger.size).toBe(0);
    } finally { h.wrapper.close(); }
  });
});
