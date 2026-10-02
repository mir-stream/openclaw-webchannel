import { describe, expect, it, vi } from "vitest";
import { WebChannelNATSClient } from "./nats-client-wrapper.js";
import type { InboundMessage } from "./nats-client.js";

function setup() {
  const wrapper = new WebChannelNATSClient({ natsUrl: "ws://127.0.0.1:4222", bootstrapJwt: "test",
    accountId: "a", tenant: "t", peerId: "p",
    registration: { devicePrivateKey: {} as CryptoKey, deviceX25519PrivateKey: {} as CryptoKey } });
  const inner = wrapper as unknown as {
    handleMessage(msg: InboundMessage): void;
    cursor: { state: string; last: number; afterSeq: number; nonce: string };
    client: { getDifference: ReturnType<typeof vi.fn>; requestApplicationRecovery: ReturnType<typeof vi.fn>;
      sendUserMessage: ReturnType<typeof vi.fn> };
  };
  inner.client.getDifference = vi.fn();
  inner.client.requestApplicationRecovery = vi.fn(() => true);
  inner.client.sendUserMessage = vi.fn();
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
