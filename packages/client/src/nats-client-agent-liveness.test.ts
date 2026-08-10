import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  inboundSubject,
  outboundSubject,
  WebChannelNatsClient,
  type InboundMessage,
} from "./nats-client.js";
import { openMessage, sealMessage } from "./e2e-crypto-browser.js";
import type { SendState } from "./types.js";
import {
  AGENT,
  FakeNatsWS,
  PEER,
  TENANT,
  installFakeWebSocket,
  makeClient,
  registerAgent,
  settle,
  type ServerHandler,
} from "./nats-client-wrapped.test-harness.js";

const IN = inboundSubject(TENANT, AGENT, PEER);
const OUT = outboundSubject(TENANT, AGENT, PEER);

type Scheduled = { id: number; due: number; fn: () => void };

function makeScheduler(start = 0) {
  let now = start;
  let nextId = 0;
  let nextClearHook: ((timer: ReturnType<typeof setTimeout>) => void) | null = null;
  const tasks = new Map<number, Scheduled>();
  const set = (fn: () => void, delay: number) => {
    const id = ++nextId;
    tasks.set(id, { id, due: now + delay, fn });
    return id as unknown as ReturnType<typeof setTimeout>;
  };
  const clear = (timer: ReturnType<typeof setTimeout>) => {
    tasks.delete(timer as unknown as number);
    const hook = nextClearHook;
    nextClearHook = null;
    hook?.(timer);
  };
  const advanceTo = (target: number) => {
    for (let guard = 0; guard < 1_000; guard++) {
      const next = [...tasks.values()]
        .filter((task) => task.due <= target)
        .sort((a, b) => a.due - b.due || a.id - b.id)[0];
      if (!next) {
        now = target;
        return;
      }
      tasks.delete(next.id);
      now = next.due;
      next.fn();
    }
    throw new Error("scheduler did not quiesce");
  };
  return {
    now: () => now,
    set,
    clear,
    advanceTo,
    taskCount: () => tasks.size,
    onNextClear: (hook: (timer: ReturnType<typeof setTimeout>) => void) => {
      nextClearHook = hook;
    },
  };
}

function deliver(
  ws: FakeNatsWS,
  K: Uint8Array,
  message: InboundMessage,
): void {
  ws.deliverToClient(
    OUT,
    sealMessage({ accountId: AGENT, tenant: TENANT, sub: PEER }, K, message),
  );
}

function internal(client: WebChannelNatsClient) {
  return client as unknown as {
    client: { reconnect: () => void };
    ackStallSinceAt: number | null;
    ackStallRecoveryIssued: boolean;
    ackStallMutationEpoch: number;
    unackedLedger: Map<string, { nextRetryAt: number | null }>;
    liveRetryTimer: unknown;
    liveRetryTimerGeneration: number;
    armLiveRetryTimer: () => void;
  };
}

let restore: () => void;
beforeEach(() => { restore = installFakeWebSocket(); });
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  restore();
});

describe("WebChannelNatsClient — #81 published-work recovery", () => {
  it("validates and resolves the shared timeout in the inner constructor", async () => {
    const base = {
      url: "ws://127.0.0.1:4222",
      jwt: "jwt",
      accountId: "account",
      tenant: "tenant",
      peerId: "peer",
      registration: {
        devicePrivateKey: {} as CryptoKey,
        deviceX25519PrivateKey: {} as CryptoKey,
      },
    };
    expect(new WebChannelNatsClient(base).getAckStallTimeoutMs()).toBe(30_000);
    expect(new WebChannelNatsClient({ ...base, ackStallTimeoutMs: 0 }).getAckStallTimeoutMs()).toBe(0);
    expect(
      new WebChannelNatsClient({ ...base, ackStallTimeoutMs: 2_147_483_647 })
        .getAckStallTimeoutMs(),
    ).toBe(2_147_483_647);
    for (const invalid of [
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      2_147_483_648,
      "1",
      null,
    ]) {
      expect(() => new WebChannelNatsClient({
        ...base,
        ackStallTimeoutMs: invalid as unknown as number,
      })).toThrow(/ackStallTimeoutMs/);
    }
  });

  it("recovers once at the application deadline and replays every original id as sent", async () => {
    const scheduler = makeScheduler();
    const K = new Uint8Array(32).fill(71);
    const h = await makeClient({
      reconnect: true,
      ackStallTimeoutMs: 2_500,
      retryNow: scheduler.now,
      retryRandom: () => 0.5,
      retrySetTimeout: scheduler.set,
      retryClearTimeout: scheduler.clear,
    });
    const registration = registerAgent(K, h.devicePublicRaw, h.identity);
    const received: string[] = [];
    FakeNatsWS.sharedHandler = async (subject, payload, server, replyTo) => {
      await registration(subject, payload, server, replyTo);
      if (subject !== IN) return;
      const message = openMessage(payload, K) as { type?: string; id?: string } | null;
      if (message?.type === "user_message" && message.id) received.push(message.id);
    };
    const states = new Map<string, SendState[]>();
    h.client.onSendState((id, state) => states.set(id, [...(states.get(id) ?? []), state]));
    h.client.connect();
    await settle();
    const reconnect = vi.spyOn(internal(h.client).client, "reconnect");
    const ids = [h.client.sendUserMessage("one"), h.client.sendUserMessage("two")];

    scheduler.advanceTo(2_499);
    expect(reconnect).not.toHaveBeenCalled();
    expect(FakeNatsWS.instances).toHaveLength(1);

    scheduler.advanceTo(2_500);
    expect(reconnect).toHaveBeenCalledTimes(1);
    expect(internal(h.client).ackStallRecoveryIssued).toBe(true);
    await settle(30);
    expect(FakeNatsWS.instances.length).toBeGreaterThanOrEqual(2);
    for (const id of ids) {
      expect(received.filter((seen) => seen === id).length).toBeGreaterThanOrEqual(2);
      expect(states.get(id)).toEqual(["queued", "sent"]);
      expect(h.client.getSendStateSnapshot(id)?.state).toBe("sent");
    }

    // Registration/replay alone never grants another allowance for this episode.
    scheduler.advanceTo(20_000);
    expect(reconnect).toHaveBeenCalledTimes(1);

    deliver(FakeNatsWS.instances.at(-1)!, K, { type: "ack", ids });
    expect(ids.map((id) => h.client.getSendStateSnapshot(id)?.state)).toEqual([
      "accepted",
      "accepted",
    ]);
    expect(internal(h.client).ackStallSinceAt).toBeNull();
    h.client.disconnect();
  });

  it("only an owned ACK/rejection resets the episode and gives remaining work a fresh age", async () => {
    const scheduler = makeScheduler(100);
    const K = new Uint8Array(32).fill(72);
    const h = await makeClient({
      ackStallTimeoutMs: 5_000,
      retryNow: scheduler.now,
      retryRandom: () => 0.5,
      retrySetTimeout: scheduler.set,
      retryClearTimeout: scheduler.clear,
    });
    const registration = registerAgent(K, h.devicePublicRaw, h.identity);
    FakeNatsWS.sharedHandler = registration;
    h.client.connect();
    await settle();
    const reconnect = vi.spyOn(internal(h.client).client, "reconnect").mockImplementation(() => {});
    const a = h.client.sendUserMessage("a");
    const b = h.client.sendUserMessage("b");
    expect(internal(h.client).ackStallSinceAt).toBe(100);

    scheduler.advanceTo(900);
    deliver(FakeNatsWS.instances[0], K, { type: "ack", ids: ["unknown"] });
    expect(internal(h.client).ackStallSinceAt).toBe(100);
    deliver(FakeNatsWS.instances[0], K, {
      type: "inbound_rejected",
      ids: ["also-unknown"],
      reason: "overloaded",
    });
    expect(internal(h.client).ackStallSinceAt).toBe(100);
    (FakeNatsWS.instances[0] as unknown as { emit: (frame: string) => void }).emit("PONG\r\n");
    expect(internal(h.client).ackStallSinceAt).toBe(100);

    scheduler.advanceTo(1_000);
    deliver(FakeNatsWS.instances[0], K, { type: "ack", ids: [a] });
    expect(internal(h.client).ackStallSinceAt).toBe(1_000);
    expect(internal(h.client).ackStallRecoveryIssued).toBe(false);
    expect(internal(h.client).unackedLedger.has(b)).toBe(true);

    // The authenticated owned result grants exactly one complete fresh interval.
    scheduler.advanceTo(5_999);
    expect(reconnect).not.toHaveBeenCalled();
    scheduler.advanceTo(6_000);
    expect(reconnect).toHaveBeenCalledTimes(1);
    scheduler.advanceTo(20_000);
    expect(reconnect).toHaveBeenCalledTimes(1);

    deliver(FakeNatsWS.instances[0], K, {
      type: "inbound_rejected",
      ids: [b],
      reason: "overloaded",
    });
    expect(h.client.getSendStateSnapshot(b)?.state).toBe("failed");
    expect(internal(h.client).ackStallSinceAt).toBeNull();
    expect(internal(h.client).liveRetryTimer).toBeNull();
    h.client.disconnect();
  });

  it("an owned result survives an unknown-ACK clear hook and recomputes one fresh interval", async () => {
    const scheduler = makeScheduler(100);
    const K = new Uint8Array(32).fill(80);
    const h = await makeClient({
      ackStallTimeoutMs: 1_000,
      retryNow: scheduler.now,
      retryRandom: () => 0.5,
      retrySetTimeout: scheduler.set,
      retryClearTimeout: scheduler.clear,
    });
    FakeNatsWS.sharedHandler = registerAgent(K, h.devicePublicRaw, h.identity);
    h.client.connect();
    await settle();
    const reconnect = vi.spyOn(internal(h.client).client, "reconnect").mockImplementation(() => {});
    const a = h.client.sendUserMessage("a");
    const b = h.client.sendUserMessage("b");
    scheduler.advanceTo(400);

    let insideClear = false;
    h.client.onMessage((message) => {
      if (insideClear && message.type === "ack" && message.ids?.includes("unknown")) {
        internal(h.client).armLiveRetryTimer();
      }
    });
    scheduler.onNextClear(() => {
      insideClear = true;
      scheduler.advanceTo(700);
      deliver(FakeNatsWS.instances[0], K, { type: "ack", ids: ["unknown"] });
      insideClear = false;
    });
    deliver(FakeNatsWS.instances[0], K, { type: "ack", ids: [a] });

    expect(h.client.getSendStateSnapshot("unknown")).toBeUndefined();
    expect(internal(h.client).unackedLedger.has(b)).toBe(true);
    expect(internal(h.client).ackStallSinceAt).toBe(700);
    expect(internal(h.client).ackStallRecoveryIssued).toBe(false);
    expect(scheduler.taskCount()).toBe(1);
    scheduler.advanceTo(1_699);
    expect(reconnect).not.toHaveBeenCalled();
    scheduler.advanceTo(1_700);
    expect(reconnect).toHaveBeenCalledTimes(1);
    scheduler.advanceTo(5_000);
    expect(reconnect).toHaveBeenCalledTimes(1);
    h.client.disconnect();
  });

  it("an owned rejection overrides same-episode scheduling installed by a clear-hook send", async () => {
    const scheduler = makeScheduler(100);
    const K = new Uint8Array(32).fill(81);
    const h = await makeClient({
      ackStallTimeoutMs: 1_000,
      retryNow: scheduler.now,
      retryRandom: () => 0.5,
      retrySetTimeout: scheduler.set,
      retryClearTimeout: scheduler.clear,
    });
    FakeNatsWS.sharedHandler = registerAgent(K, h.devicePublicRaw, h.identity);
    h.client.connect();
    await settle();
    const reconnect = vi.spyOn(internal(h.client).client, "reconnect").mockImplementation(() => {});
    const a = h.client.sendUserMessage("a");
    const b = h.client.sendUserMessage("b");
    scheduler.advanceTo(400);

    let c = "";
    let mutationBeforeNested = -1;
    let mutationAfterNested = -1;
    scheduler.onNextClear(() => {
      mutationBeforeNested = internal(h.client).ackStallMutationEpoch;
      scheduler.advanceTo(700);
      c = h.client.sendUserMessage("c-from-clear");
      mutationAfterNested = internal(h.client).ackStallMutationEpoch;
    });
    deliver(FakeNatsWS.instances[0], K, {
      type: "inbound_rejected",
      ids: [a],
      reason: "overloaded",
    });

    expect(mutationAfterNested).toBe(mutationBeforeNested);
    expect(h.client.getSendStateSnapshot(c)?.state).toBe("sent");
    expect([...internal(h.client).unackedLedger.keys()]).toEqual([b, c]);
    expect(internal(h.client).ackStallSinceAt).toBe(700);
    expect(internal(h.client).ackStallRecoveryIssued).toBe(false);
    expect(scheduler.taskCount()).toBe(1);
    scheduler.advanceTo(1_699);
    expect(reconnect).not.toHaveBeenCalled();
    scheduler.advanceTo(1_700);
    expect(reconnect).toHaveBeenCalledTimes(1);
    h.client.disconnect();
  });

  it("clears a valid zero timer handle without leaking timer ownership", async () => {
    const K = new Uint8Array(32).fill(82);
    const cleared: Array<ReturnType<typeof setTimeout>> = [];
    const h = await makeClient({
      ackStallTimeoutMs: 1_000,
      retryNow: () => 0,
      retryRandom: () => 0.5,
      retrySetTimeout: () => 0 as unknown as ReturnType<typeof setTimeout>,
      retryClearTimeout: (timer) => { cleared.push(timer); },
    });
    FakeNatsWS.sharedHandler = registerAgent(K, h.devicePublicRaw, h.identity);
    h.client.connect();
    await settle();
    const id = h.client.sendUserMessage("zero-handle");
    expect(internal(h.client).liveRetryTimer).toBe(0);
    deliver(FakeNatsWS.instances[0], K, { type: "ack", ids: [id] });
    expect(cleared).toContain(0);
    expect(internal(h.client).liveRetryTimer).toBeNull();
    expect(internal(h.client).unackedLedger.size).toBe(0);
    h.client.disconnect();
  });

  it("raw loss consumes the active allowance before replay and cannot race a second reconnect", async () => {
    const scheduler = makeScheduler();
    const K = new Uint8Array(32).fill(73);
    const h = await makeClient({
      reconnect: true,
      ackStallTimeoutMs: 2_000,
      retryNow: scheduler.now,
      retryRandom: () => 0.5,
      retrySetTimeout: scheduler.set,
      retryClearTimeout: scheduler.clear,
    });
    FakeNatsWS.sharedHandler = registerAgent(K, h.devicePublicRaw, h.identity);
    h.client.connect();
    await settle();
    h.client.sendUserMessage("raw-loss");
    scheduler.advanceTo(1_999);
    FakeNatsWS.instances[0].close();
    expect(internal(h.client).ackStallRecoveryIssued).toBe(true);
    expect(scheduler.taskCount()).toBe(0);
    await settle(30);
    expect(FakeNatsWS.instances).toHaveLength(2);
    scheduler.advanceTo(10_000);
    expect(FakeNatsWS.instances).toHaveLength(2);
    h.client.disconnect();
  });

  it("a raw publish failure before episode start does not spend an application allowance", async () => {
    const scheduler = makeScheduler();
    const K = new Uint8Array(32).fill(83);
    const h = await makeClient({
      reconnect: true,
      ackStallTimeoutMs: 2_000,
      retryNow: scheduler.now,
      retryRandom: () => 0.5,
      retrySetTimeout: scheduler.set,
      retryClearTimeout: scheduler.clear,
    });
    const registration = registerAgent(K, h.devicePublicRaw, h.identity);
    let failPublish = true;
    FakeNatsWS.sharedHandler = (subject, payload, server, replyTo) => {
      if (subject === IN && failPublish) {
        failPublish = false;
        throw new Error("synchronous publish failure before episode commit");
      }
      return registration(subject, payload, server, replyTo);
    };
    h.client.connect();
    await settle();
    const id = h.client.sendUserMessage("publish-fails");
    expect(h.client.getSendStateSnapshot(id)?.state).toBe("queued");
    expect(internal(h.client).unackedLedger.has(id)).toBe(true);
    expect(internal(h.client).ackStallSinceAt).toBeNull();
    expect(internal(h.client).ackStallRecoveryIssued).toBe(false);
    expect(scheduler.taskCount()).toBe(0);
    h.client.disconnect();
  });

  it("a wrapper-held recovery request consumes the published allowance and coalesces to one replacement", async () => {
    const scheduler = makeScheduler();
    const K = new Uint8Array(32).fill(79);
    const h = await makeClient({
      reconnect: true,
      ackStallTimeoutMs: 2_000,
      retryNow: scheduler.now,
      retryRandom: () => 0.5,
      retrySetTimeout: scheduler.set,
      retryClearTimeout: scheduler.clear,
    });
    FakeNatsWS.sharedHandler = registerAgent(K, h.devicePublicRaw, h.identity);
    h.client.connect();
    await settle();
    const reconnect = vi.spyOn(internal(h.client).client, "reconnect");
    h.client.sendUserMessage("published-before-held-watchdog");
    scheduler.advanceTo(500);

    // This package-internal call is exactly what the wrapper-held lane makes.
    expect(h.client.requestApplicationRecovery()).toBe(true);
    expect(reconnect).toHaveBeenCalledTimes(1);
    expect(internal(h.client).ackStallRecoveryIssued).toBe(true);
    expect(scheduler.taskCount()).toBe(0);
    await settle(30);
    scheduler.advanceTo(10_000);
    expect(reconnect).toHaveBeenCalledTimes(1);
    expect(FakeNatsWS.instances).toHaveLength(2);
    h.client.disconnect();
  });

  it("disabled mode omits application recovery while ordinary live retry remains active", async () => {
    const scheduler = makeScheduler();
    const K = new Uint8Array(32).fill(74);
    const h = await makeClient({
      ackStallTimeoutMs: 0,
      retryNow: scheduler.now,
      retryRandom: () => 0.5,
      retrySetTimeout: scheduler.set,
      retryClearTimeout: scheduler.clear,
    });
    let deliveries = 0;
    const registration = registerAgent(K, h.devicePublicRaw, h.identity);
    FakeNatsWS.sharedHandler = (subject, payload, server, replyTo) => {
      if (subject === IN) {
        deliveries++;
        return;
      }
      return registration(subject, payload, server, replyTo);
    };
    h.client.connect();
    await settle();
    const reconnect = vi.spyOn(internal(h.client).client, "reconnect");
    h.client.sendUserMessage("retry-only");
    scheduler.advanceTo(35_000);
    expect(deliveries).toBeGreaterThan(1);
    expect(reconnect).not.toHaveBeenCalled();
    h.client.disconnect();
  });

  it.each(["retryRandom", "retryNow"] as const)(
    "restores a provisional send when %s synchronously accepts older work",
    async (selectedHook) => {
      const scheduler = makeScheduler();
      const K = new Uint8Array(32).fill(selectedHook === "retryRandom" ? 84 : 85);
      let client: WebChannelNatsClient | undefined;
      let socket: FakeNatsWS | undefined;
      let firstId = "";
      let callbackId = "";
      let hookArmed = false;
      const runSelectedHook = (hook: typeof selectedHook) => {
        if (!hookArmed || hook !== selectedHook) return;
        hookArmed = false;
        deliver(socket!, K, { type: "ack", ids: [firstId] });
      };
      const h = await makeClient({
        ackStallTimeoutMs: 0,
        retryNow: () => {
          runSelectedHook("retryNow");
          return scheduler.now();
        },
        retryRandom: () => {
          runSelectedHook("retryRandom");
          return 0.5;
        },
        retrySetTimeout: scheduler.set,
        retryClearTimeout: scheduler.clear,
      });
      client = h.client;
      const published: Array<{ id: string; text: string }> = [];
      const registration = registerAgent(K, h.devicePublicRaw, h.identity);
      FakeNatsWS.sharedHandler = (subject, payload, server, replyTo) => {
        if (subject === IN) {
          const message = openMessage(payload, K) as {
            type?: string;
            id?: string;
            text?: string;
          } | null;
          if (message?.type === "user_message" && message.id && message.text) {
            published.push({ id: message.id, text: message.text });
          }
          return;
        }
        return registration(subject, payload, server, replyTo);
      };
      h.client.connect();
      await settle();
      socket = FakeNatsWS.instances[0];
      const reconnect = vi.spyOn(internal(h.client).client, "reconnect");
      h.client.onMessage((message) => {
        if (message.type === "ack" && message.ids?.includes(firstId)) {
          callbackId = client!.sendUserMessage("C-from-ack-callback");
        }
      });

      firstId = h.client.sendUserMessage("A");
      hookArmed = true;
      const secondId = h.client.sendUserMessage("B");

      expect(callbackId).not.toBe("");
      expect(published).toEqual([
        { id: firstId, text: "A" },
        { id: secondId, text: "B" },
        { id: callbackId, text: "C-from-ack-callback" },
      ]);
      expect(h.client.getSendStateSnapshot(firstId)?.state).toBe("accepted");
      expect(h.client.getSendStateSnapshot(secondId)?.state).toBe("sent");
      expect(h.client.getSendStateSnapshot(callbackId)?.state).toBe("sent");
      expect(internal(h.client).unackedLedger.get(secondId)?.nextRetryAt).toBe(1_000);
      expect(internal(h.client).unackedLedger.get(callbackId)?.nextRetryAt).toBe(1_000);
      expect(scheduler.taskCount()).toBe(1);
      expect(reconnect).not.toHaveBeenCalled();

      scheduler.advanceTo(1_000);
      expect(published.map(({ text }) => text)).toEqual([
        "A",
        "B",
        "C-from-ack-callback",
        "B",
        "C-from-ack-callback",
      ]);
      expect(h.client.getSendStateSnapshot(secondId)?.state).toBe("sent");
      expect(h.client.getSendStateSnapshot(callbackId)?.state).toBe("sent");
      expect(reconnect).not.toHaveBeenCalled();
      h.client.disconnect();
    },
  );

  it.each(["retryRandom", "retryNow"] as const)(
    "starts B's stall interval at its first publish after a synchronous %s result",
    async (selectedHook) => {
      const scheduler = makeScheduler();
      const timeoutMs = 1_000;
      const advancedAt = 5_000;
      const K = new Uint8Array(32).fill(selectedHook === "retryRandom" ? 86 : 87);
      let socket: FakeNatsWS | undefined;
      let firstId = "";
      let callbackId = "";
      let hookArmed = false;
      let stallSinceDuringAccepted: number | null | undefined;
      let timersDuringAccepted = -1;
      const runSelectedHook = (hook: typeof selectedHook) => {
        if (!hookArmed || hook !== selectedHook) return;
        hookArmed = false;
        deliver(socket!, K, { type: "ack", ids: [firstId] });
      };
      const h = await makeClient({
        ackStallTimeoutMs: timeoutMs,
        retryNow: () => {
          runSelectedHook("retryNow");
          return scheduler.now();
        },
        retryRandom: () => {
          runSelectedHook("retryRandom");
          return 0.5;
        },
        retrySetTimeout: scheduler.set,
        retryClearTimeout: scheduler.clear,
      });
      const published: Array<{ id: string; text: string }> = [];
      const registration = registerAgent(K, h.devicePublicRaw, h.identity);
      FakeNatsWS.sharedHandler = (subject, payload, server, replyTo) => {
        if (subject === IN) {
          const message = openMessage(payload, K) as {
            type?: string;
            id?: string;
            text?: string;
          } | null;
          if (message?.type === "user_message" && message.id && message.text) {
            published.push({ id: message.id, text: message.text });
          }
          return;
        }
        return registration(subject, payload, server, replyTo);
      };
      h.client.connect();
      await settle();
      socket = FakeNatsWS.instances[0];
      const reconnect = vi.spyOn(internal(h.client).client, "reconnect")
        .mockImplementation(() => {});

      firstId = h.client.sendUserMessage("A");
      h.client.onSendState((id, state) => {
        if (id !== firstId || state !== "accepted") return;
        scheduler.advanceTo(advancedAt);
        stallSinceDuringAccepted = internal(h.client).ackStallSinceAt;
        timersDuringAccepted = scheduler.taskCount();
      });
      h.client.onMessage((message) => {
        if (message.type === "ack" && message.ids?.includes(firstId)) {
          callbackId = h.client.sendUserMessage("C-from-ack-callback");
        }
      });
      hookArmed = true;
      const secondId = h.client.sendUserMessage("B");

      expect(callbackId).not.toBe("");
      expect(stallSinceDuringAccepted).toBeNull();
      expect(timersDuringAccepted).toBe(0);
      expect(published).toEqual([
        { id: firstId, text: "A" },
        { id: secondId, text: "B" },
        { id: callbackId, text: "C-from-ack-callback" },
      ]);
      expect(internal(h.client).ackStallSinceAt).toBe(advancedAt);
      expect(internal(h.client).unackedLedger.get(secondId)?.nextRetryAt)
        .toBe(advancedAt + 1_000);
      expect(internal(h.client).unackedLedger.get(callbackId)?.nextRetryAt)
        .toBe(advancedAt + 1_000);
      expect(h.client.getSendStateSnapshot(secondId)?.state).toBe("sent");
      expect(h.client.getSendStateSnapshot(callbackId)?.state).toBe("sent");
      expect(reconnect).not.toHaveBeenCalled();

      // Drain anything incorrectly armed for the already-elapsed provisional
      // interval. B's real publish above must instead grant a complete timeout.
      scheduler.advanceTo(advancedAt);
      expect(reconnect).not.toHaveBeenCalled();
      scheduler.advanceTo(advancedAt + timeoutMs - 1);
      expect(reconnect).not.toHaveBeenCalled();
      scheduler.advanceTo(advancedAt + timeoutMs);
      expect(reconnect).toHaveBeenCalledTimes(1);
      h.client.disconnect();
    },
  );

  it.each(["ack", "inbound_rejected"] as const)(
    "a synchronous owned %s during raw publish wins over stale episode writes",
    async (type) => {
      const scheduler = makeScheduler();
      const K = new Uint8Array(32).fill(type === "ack" ? 75 : 76);
      const h = await makeClient({
        ackStallTimeoutMs: 1_500,
        retryNow: scheduler.now,
        retryRandom: () => 0.5,
        retrySetTimeout: scheduler.set,
        retryClearTimeout: scheduler.clear,
      });
      const registration = registerAgent(K, h.devicePublicRaw, h.identity);
      const handler: ServerHandler = (subject, payload, server, replyTo) => {
        if (subject === IN) {
          const message = openMessage(payload, K) as { id?: string } | null;
          if (message?.id) {
            deliver(server, K, type === "ack"
              ? { type, ids: [message.id] }
              : { type, ids: [message.id], reason: "overloaded" });
          }
          return;
        }
        return registration(subject, payload, server, replyTo);
      };
      FakeNatsWS.sharedHandler = handler;
      h.client.connect();
      await settle();
      const id = h.client.sendUserMessage(`sync-${type}`);
      expect(h.client.getSendStateSnapshot(id)?.state).toBe(type === "ack" ? "accepted" : "failed");
      expect(internal(h.client).ackStallSinceAt).toBeNull();
      expect(internal(h.client).unackedLedger.size).toBe(0);
      expect(scheduler.taskCount()).toBe(0);
      h.client.disconnect();
    },
  );

  it("orders retry random before the publish clock and prevents stale timer installation on clear reentry", async () => {
    const calls: string[] = [];
    let now = 0;
    let client: WebChannelNatsClient | undefined;
    let reenterOnClear = false;
    let timerId = 0;
    let scheduled: (() => void) | undefined;
    const K = new Uint8Array(32).fill(77);
    const h = await makeClient({
      ackStallTimeoutMs: 1_000,
      retryRandom: () => { calls.push("random"); now = 400; return 0.5; },
      retryNow: () => { calls.push("clock"); return now; },
      retrySetTimeout: (fn) => {
        scheduled = fn;
        return ++timerId as unknown as ReturnType<typeof setTimeout>;
      },
      retryClearTimeout: () => {
        scheduled = undefined;
        if (reenterOnClear) client?.disconnect();
      },
    });
    client = h.client;
    FakeNatsWS.sharedHandler = registerAgent(K, h.devicePublicRaw, h.identity);
    h.client.connect();
    await settle();
    calls.length = 0;
    const id = h.client.sendUserMessage("ordered-hooks");
    expect(calls.slice(0, 2)).toEqual(["random", "clock"]);
    expect(internal(h.client).ackStallSinceAt).toBe(400);
    expect(scheduled).toBeTypeOf("function");

    reenterOnClear = true;
    deliver(FakeNatsWS.instances[0], K, { type: "ack", ids: [id] });
    expect(h.client.getSendStateSnapshot(id)?.state).toBe("accepted");
    expect(internal(h.client).ackStallSinceAt).toBeNull();
    expect(internal(h.client).liveRetryTimer).toBeNull();
    expect(scheduled).toBeUndefined();
  });

  it("suppresses stale onSession after replay publish failure, then allows a genuine later session", async () => {
    const K = new Uint8Array(32).fill(78);
    const h = await makeClient({ reconnect: true, ackStallTimeoutMs: 10_000 });
    const registration = registerAgent(K, h.devicePublicRaw, h.identity);
    let failReplayOnSocket = -1;
    let replayFailed = false;
    let releaseThird = () => {};
    const thirdGate = new Promise<void>((resolve) => { releaseThird = resolve; });
    FakeNatsWS.sharedHandler = (subject, payload, server, replyTo) => {
      const socketIndex = FakeNatsWS.instances.indexOf(server);
      if (subject === IN && socketIndex === failReplayOnSocket && !replayFailed) {
        replayFailed = true;
        throw new Error("synchronous replay failure");
      }
      if (subject !== IN && socketIndex >= 2) {
        return thirdGate.then(() => registration(subject, payload, server, replyTo));
      }
      return registration(subject, payload, server, replyTo);
    };
    let sessions = 0;
    h.client.onSession(() => { sessions++; });
    h.client.connect();
    await settle();
    expect(sessions).toBe(1);
    h.client.sendUserMessage("replay-me");
    failReplayOnSocket = 1;
    h.client.requestApplicationRecovery();
    for (let i = 0; i < 80 && FakeNatsWS.instances.length < 3; i++) await settle(1);
    expect(replayFailed).toBe(true);
    expect(FakeNatsWS.instances.length).toBeGreaterThanOrEqual(3);
    expect(sessions).toBe(1);
    releaseThird();
    await settle(30);
    expect(sessions).toBe(2);
    h.client.disconnect();
  });
});
