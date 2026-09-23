import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebChannelNATSClient } from "./nats-client-wrapper.js";
import { inboundSubject, outboundSubject, type InboundMessage, type OutboundMessage } from "./nats-client.js";
import { openMessage, sealMessage } from "./e2e-crypto-browser.js";
import { generateDevicePopKeyPair } from "./pop-register.js";
import {
  AGENT, FakeNatsWS, JWT, PEER, TENANT, generateDeviceX25519,
  installFakeWebSocket, makeAgentIdentity, registerAgent, settleUntil,
} from "./nats-client-wrapped.test-harness.js";

const IN = inboundSubject(TENANT, AGENT, PEER);
const OUT = outboundSubject(TENANT, AGENT, PEER);
const TIMEOUT = 1_000;
const wrappers: WebChannelNATSClient[] = [];
let restore: () => void;
beforeEach(() => { restore = installFakeWebSocket(); });
afterEach(() => {
  for (const wrapper of wrappers.splice(0)) wrapper.close();
  vi.restoreAllMocks();
  vi.useRealTimers();
  restore();
});

function inside(wrapper: WebChannelNATSClient) {
  return wrapper as unknown as {
    activeTurnStallTimer: unknown;
    applicationTurns: Map<string, unknown>;
    heldStallTimer: unknown;
    client: {
      requestApplicationRecovery: () => boolean;
      liveRetryTimer: unknown;
      unackedLedger: Map<string, unknown>;
    };
  };
}

/** Real registration/crypto/decoder/reducer; only the relay and plugin are fixtures. */
async function setup(options: { timeout?: number; heartbeat?: number; recovery?: "snapshot" | "difference" } = {}) {
  const identity = makeAgentIdentity();
  const x = await generateDeviceX25519();
  const pop = await generateDevicePopKeyPair();
  const key = new Uint8Array(32).fill(39);
  const registration = registerAgent(key, x.publicRaw, identity);
  const control = { admitted: true, ack: true, registrations: 0, interrupted: false, settleBeforeAck: false,
    cancelled: new Set<string>() };
  const received: Array<Extract<OutboundMessage, { type: "user_message" }>> = [];
  const differences: Array<Extract<OutboundMessage, { type: "get_difference" }>> = [];
  const deliver = (frame: InboundMessage, server = FakeNatsWS.instances.at(-1)!) => {
    server.deliverToClient(OUT, sealMessage({ accountId: AGENT, tenant: TENANT, sub: PEER }, key, frame));
  };
  const row = () => ({
    id: "server-user", role: "user" as const, text: received[0]!.text!,
    turnId: received[0]!.id!, randomId: received[0]!.random_id!,
    requestState: "interrupted" as const, seq: 2,
  });
  FakeNatsWS.sharedHandler = (subject, payload, server, reply) => {
    if (subject.endsWith(".register")) {
      const isRegister = JSON.parse(payload).op === "register";
      if (isRegister) {
        control.registrations++;
        control.admitted = true;
      }
      return Promise.resolve(registration(subject, payload, server, reply)).then(() => {
        if (isRegister) deliver({ type: "history", highWaterSeq: control.interrupted ? 2 : 0,
          messages: control.interrupted && options.recovery === "snapshot" ? [row()] : [] }, server);
      });
    }
    if (subject !== IN || !control.admitted) return;
    const frame = openMessage(payload, key) as OutboundMessage;
    if (frame.type === "user_message") {
      received.push(frame);
      if (control.settleBeforeAck) deliver({ type: "turn_settled", turnId: frame.id }, server);
      if (control.ack) deliver({ type: "ack", ids: [frame.id!],
        ...(control.cancelled.has(frame.id!) ? { cancelled: [frame.id!] } : {}) }, server);
    } else if (frame.type === "get_difference") {
      differences.push(frame);
      deliver({ type: "difference", afterSeq: frame.afterSeq, nonce: frame.nonce, maxSeq: 2, partial: false,
        events: options.recovery === "difference" ? [
          { seq: 1, event: { kind: "user", id: "server-user", text: row().text,
            turnId: row().turnId, randomId: row().randomId, requestState: "started" } },
          { seq: 2, event: { kind: "requestState", id: "server-user", state: "interrupted" } },
        ] : [] }, server);
    }
  };
  const wrapper = new WebChannelNATSClient({
    natsUrl: "ws://fixture", bootstrapJwt: JWT, accountId: AGENT, tenant: TENANT, peerId: PEER,
    ackStallTimeoutMs: options.timeout ?? TIMEOUT, heartbeatIntervalMs: options.heartbeat ?? 0,
    reconnectBaseMs: 1, reconnectCapMs: 1,
    registration: { devicePrivateKey: pop.privateKey, deviceX25519PrivateKey: x.privateKey,
      pinnedAgentPublicKey: identity.publicB64url },
  });
  wrappers.push(wrapper);
  wrapper.connect();
  await settleUntil(() => wrapper.getState().connected, { label: "authenticated session" });
  return { wrapper, control, received, differences, deliver, row };
}

async function withClock() {
  const h = await setup();
  vi.useFakeTimers();
  const request = vi.spyOn(inside(h.wrapper).client, "requestApplicationRecovery").mockReturnValue(true);
  const receipt = h.wrapper.send("work")!;
  expect(receipt.snapshot().state).toBe("accepted");
  return { ...h, receipt, request, turnId: h.received[0]!.id! };
}

describe("accepted-turn application recovery", () => {
  it.each(["snapshot", "difference"] as const)(
    "recovers interrupted work through replacement registration and %s while relay PONG stays healthy",
    async (recovery) => {
      const wire = vi.spyOn(FakeNatsWS.prototype, "send");
      const h = await setup({ timeout: 80, heartbeat: 5, recovery });
      const receipt = h.wrapper.send("long operation")!;
      expect(receipt.snapshot().state).toBe("accepted");
      h.deliver({ type: "typing" });
      expect(h.wrapper.getState()).toMatchObject({ connected: true, isTyping: true, turnActive: true });
      expect(inside(h.wrapper).client.unackedLedger.size).toBe(0);
      expect(inside(h.wrapper).client.liveRetryTimer).toBeNull();
      expect(inside(h.wrapper).heldStallTimer).toBeNull();
      h.control.admitted = false; // Plugin loses admission; the relay remains healthy.
      h.control.interrupted = true; // Model the replacement plugin's durable verdict.
      await settleUntil(() => receipt.snapshot().state === "interrupted", { label: "recovered interrupted outcome" });
      expect(h.control.registrations).toBe(2);
      expect(h.differences).toHaveLength(1);
      expect(h.wrapper.getState()).toMatchObject({ connected: true, isTyping: false, turnActive: false });
      expect(h.wrapper.getState().messages).toEqual([expect.objectContaining({
        id: "server-user", requestState: "interrupted", sendState: "interrupted",
      })]);
      expect(h.received).toHaveLength(1); // Accepted work was never republished.
      expect(wire.mock.calls.some(([frame]) => frame === "PING\r\n")).toBe(true);
      expect(inside(h.wrapper).activeTurnStallTimer).toBeNull();
      await new Promise((resolve) => setTimeout(resolve, 180));
      expect(h.control.registrations).toBe(2);
    },
  );

  it("continues watching a silent accepted turn across successful registrations without resending or settling it", async () => {
    const h = await setup({ timeout: 80 });
    const receipt = h.wrapper.send("silent operation")!;
    await settleUntil(() => h.control.registrations >= 3 && h.wrapper.getState().connected,
      { label: "second active-turn recovery" });
    expect(receipt.snapshot().state).toBe("accepted");
    expect(h.received).toHaveLength(1);
    h.deliver({ type: "turn_settled", turnId: h.received[0]!.id, outcome: "ok" });
    expect(receipt.snapshot().state).toBe("completed");
    expect(inside(h.wrapper).activeTurnStallTimer).toBeNull();
  });

  it("consumes a lost cancellation ACK on replacement replay without watching an absent journal row", async () => {
    const h = await setup({ timeout: 80, heartbeat: 5 });
    h.control.ack = false;
    const receipt = h.wrapper.send("cancelled before admission")!;
    const id = h.received[0]!.id!;
    expect(receipt.snapshot().state).toBe("sent");
    // The durable cancellation survives, but its initial receipt was lost.
    h.control.cancelled.add(id);
    h.control.ack = true;
    FakeNatsWS.instances.at(-1)!.close();
    await settleUntil(() => receipt.snapshot().state === "accepted" && h.wrapper.getState().connected,
      { label: "terminal cancellation ACK on replay" });
    expect(h.received.map((frame) => frame.id)).toEqual([id, id]);
    expect(inside(h.wrapper).applicationTurns.size).toBe(0);
    expect(inside(h.wrapper).activeTurnStallTimer).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(h.control.registrations).toBe(2);
    expect(receipt.snapshot().state).toBe("accepted");
  });

  it.each([
    { type: "typing" },
    { type: "progress", id: "draft", text: "still running" },
    { type: "reasoning", id: "reason", turnId: "turn", text: "thinking" },
    { type: "tool_activity", id: "tool", turnId: "turn", phase: "start" },
    { type: "agent_message", id: "answer", text: "first answer" },
  ] satisfies InboundMessage[])("resets the accepted interval on authenticated $type activity", async (frame) => {
    const h = await withClock();
    vi.advanceTimersByTime(900);
    h.deliver(frame);
    vi.advanceTimersByTime(999);
    expect(h.request).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(h.request).toHaveBeenCalledTimes(1);
    expect(h.receipt.snapshot().state).toBe("accepted");
  });

  it("counts authenticated activity at arrival even when gap recovery buffers the frame", async () => {
    const h = await withClock();
    h.control.admitted = false; // No difference response.
    vi.advanceTimersByTime(900);
    h.deliver({ type: "progress", id: "draft", text: "alive", seq: 4 });
    vi.advanceTimersByTime(999);
    expect(h.request).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(h.request).toHaveBeenCalledTimes(1);
  });

  it("ignores relay traffic, plaintext, bad ciphertext, and unrelated ACKs", async () => {
    const h = await withClock();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.advanceTimersByTime(900);
    const socket = FakeNatsWS.instances.at(-1)!;
    socket.onmessage?.({ data: "PONG\r\n" });
    socket.deliverToClient(OUT, JSON.stringify({ type: "typing" }));
    socket.deliverToClient(OUT, sealMessage({ accountId: AGENT, tenant: TENANT, sub: PEER },
      new Uint8Array(32).fill(1), { type: "typing" }));
    h.deliver({ type: "ack", ids: ["foreign"] });
    vi.advanceTimersByTime(100);
    expect(h.request).toHaveBeenCalledTimes(1);
  });

  it.each(["ok", "error", undefined] as const)("retires the watchdog on turn_settled outcome %s", async (outcome) => {
    const h = await withClock();
    h.deliver({ type: "turn_settled", turnId: h.turnId, outcome });
    expect(inside(h.wrapper).activeTurnStallTimer).toBeNull();
    vi.advanceTimersByTime(3 * TIMEOUT);
    expect(h.request).not.toHaveBeenCalled();
    expect(h.receipt.snapshot().state).toBe(outcome === "ok" ? "completed" : outcome === "error" ? "failed" : "accepted");
  });

  it("settles a coalesced prefix in publish order when ACKs arrive out of order", async () => {
    const h = await setup();
    vi.useFakeTimers();
    h.control.ack = false;
    h.wrapper.send("first");
    h.wrapper.send("second");
    const [first, second] = h.received;
    h.deliver({ type: "ack", ids: [second!.id!, first!.id!] });
    h.deliver({ type: "turn_settled", turnId: second!.id });
    expect(inside(h.wrapper).applicationTurns.size).toBe(0);
    expect(inside(h.wrapper).activeTurnStallTimer).toBeNull();
  });

  it("cannot reopen a legacy settlement that beats its first accepted callback", async () => {
    const h = await setup();
    vi.useFakeTimers();
    h.control.settleBeforeAck = true;
    const receipt = h.wrapper.send("settles immediately")!;
    expect(receipt.snapshot().state).toBe("accepted");
    expect(inside(h.wrapper).applicationTurns.size).toBe(0);
    expect(inside(h.wrapper).activeTurnStallTimer).toBeNull();
  });

  it("settlement fanout cannot retire a new accepted turn sent by a receipt subscriber", async () => {
    const h = await withClock();
    h.receipt.subscribe(({ state }) => {
      if (state === "completed") h.wrapper.send("next turn");
    });
    h.deliver({ type: "turn_settled", turnId: h.turnId, outcome: "ok" });
    expect(inside(h.wrapper).applicationTurns.size).toBe(1);
    expect(h.received).toHaveLength(2);
    vi.advanceTimersByTime(TIMEOUT);
    expect(h.request).toHaveBeenCalledTimes(1);
  });

  it("ignores an expired callback from before newer authenticated activity", async () => {
    const h = await setup();
    vi.useFakeTimers();
    const scheduled = vi.spyOn(globalThis, "setTimeout");
    h.wrapper.send("work");
    const callback = scheduled.mock.calls.find(([, ms]) => ms === TIMEOUT)![0] as () => void;
    const request = vi.spyOn(inside(h.wrapper).client, "requestApplicationRecovery").mockReturnValue(true);
    vi.advanceTimersByTime(900);
    h.deliver({ type: "typing" });
    callback();
    expect(request).not.toHaveBeenCalled();
    vi.advanceTimersByTime(TIMEOUT);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("a local stop request alone cannot declare accepted work settled", async () => {
    const h = await withClock();
    h.wrapper.send("/stop");
    expect(inside(h.wrapper).applicationTurns.size).toBe(1);
    expect(h.receipt.snapshot().state).toBe("accepted");
    vi.advanceTimersByTime(TIMEOUT);
    expect(h.request).toHaveBeenCalledTimes(1);
  });

  it("retires only the cancellation ACK's exact IDs while normal committed ACKs still adopt identity", async () => {
    const h = await setup();
    vi.useFakeTimers();
    h.control.ack = false;
    const first = h.wrapper.send("quiet admitted turn")!;
    const cancelled = h.wrapper.send("cancelled debounce input")!;
    const later = h.wrapper.send("later admitted turn")!;
    const [a, b, c] = h.received;
    h.deliver({ type: "ack", ids: [a!.id!, b!.id!, c!.id!], cancelled: [b!.id!],
      committed: [{ random_id: a!.random_id!, messageId: "durable-A" }] });
    expect([first, cancelled, later].map((receipt) => receipt.snapshot().state)).toEqual(["accepted", "accepted", "accepted"]);
    expect([...inside(h.wrapper).applicationTurns.keys()]).toEqual([a!.id, c!.id]);
    expect(h.wrapper.getState().messages[0].id).toBe("durable-A");
    expect(h.wrapper.getState().turnActive).toBe(true);
    // A foreign/duplicate cancellation proves nothing about either neighbor.
    h.deliver({ type: "ack", ids: [b!.id!, "other-device"], cancelled: [b!.id!, "other-device"] });
    expect([...inside(h.wrapper).applicationTurns.keys()]).toEqual([a!.id, c!.id]);
    // Ordinary coalesced settlement retains its prefix semantics.
    h.deliver({ type: "turn_settled", turnId: c!.id });
    expect(inside(h.wrapper).applicationTurns.size).toBe(0);
    expect(inside(h.wrapper).activeTurnStallTimer).toBeNull();
  });

  it.each([false, true])("retires a cancellation before acceptance fanout (already ACKed=%s)", async (alreadyAcked) => {
    const h = await setup();
    vi.useFakeTimers();
    h.control.ack = alreadyAcked;
    const receipt = h.wrapper.send("cancelled")!;
    const id = h.received[0]!.id!;
    let observed: { watched: boolean; active: boolean | undefined } | undefined;
    receipt.subscribe(({ state }) => {
      if (state === "accepted") {
        observed = { watched: inside(h.wrapper).applicationTurns.has(id), active: h.wrapper.getState().turnActive };
      }
    });
    const request = vi.spyOn(inside(h.wrapper).client, "requestApplicationRecovery").mockReturnValue(true);
    h.deliver({ type: "ack", ids: [id], cancelled: [id] });
    expect(observed).toEqual(alreadyAcked ? undefined : { watched: false, active: false });
    expect(inside(h.wrapper).applicationTurns.size).toBe(0);
    expect(inside(h.wrapper).activeTurnStallTimer).toBeNull();
    vi.advanceTimersByTime(5 * TIMEOUT);
    expect(request).not.toHaveBeenCalled();
    expect(receipt.snapshot().state).toBe("accepted");
  });

  it("commits all cancellation facts before any ACK listener can run an older timer", async () => {
    const h = await withClock();
    h.control.ack = false;
    const second = h.wrapper.send("second cancelled input")!;
    const secondId = h.received[1]!.id!;
    second.subscribe(({ state }) => {
      if (state === "accepted") vi.advanceTimersByTime(TIMEOUT);
    });
    h.deliver({ type: "ack", ids: [secondId, h.turnId], cancelled: [secondId, h.turnId] });
    expect(h.request).not.toHaveBeenCalled();
    expect(inside(h.wrapper).applicationTurns.size).toBe(0);
    expect(inside(h.wrapper).activeTurnStallTimer).toBeNull();
  });

  it("preserves a new accepted turn sent reentrantly by a cancelled input's receipt listener", async () => {
    const h = await setup();
    vi.useFakeTimers();
    h.control.ack = false;
    const receipt = h.wrapper.send("cancelled input")!;
    const id = h.received[0]!.id!;
    receipt.subscribe(({ state }) => {
      if (state === "accepted") {
        h.control.ack = true;
        h.wrapper.send("new work");
      }
    });
    h.deliver({ type: "ack", ids: [id], cancelled: [id] });
    expect([...inside(h.wrapper).applicationTurns.keys()]).toEqual([h.received[1]!.id]);
    expect(h.wrapper.getState().turnActive).toBe(true);
    const request = vi.spyOn(inside(h.wrapper).client, "requestApplicationRecovery").mockReturnValue(true);
    vi.advanceTimersByTime(TIMEOUT);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("cancellation timer cleanup cannot retire new work created by that cleanup hook", async () => {
    const h = await withClock();
    const oldTimer = inside(h.wrapper).activeTurnStallTimer;
    const clear = globalThis.clearTimeout;
    let sent = false;
    vi.spyOn(globalThis, "clearTimeout").mockImplementation((timer) => {
      clear(timer);
      if (timer === oldTimer && !sent) {
        sent = true;
        h.wrapper.send("replacement work");
      }
    });
    h.deliver({ type: "ack", ids: [h.turnId], cancelled: [h.turnId] });
    expect(sent).toBe(true);
    expect([...inside(h.wrapper).applicationTurns.keys()]).toEqual([h.received[1]!.id]);
    expect(h.wrapper.getState().turnActive).toBe(true);
    vi.advanceTimersByTime(TIMEOUT);
    expect(h.request).toHaveBeenCalledTimes(1);
  });

  it.each(["typing", "draft"] as const)("settles cancelled running %s UI when the ordinary settlement was lost", async (activity) => {
    const h = await withClock();
    h.deliver(activity === "typing" ? { type: "typing" }
      : { type: "progress", id: "cancelled-draft", turnId: h.turnId, text: "partial" });
    h.deliver({ type: "ack", ids: [h.turnId], cancelled: [h.turnId] });
    expect(h.wrapper.getState()).toMatchObject({ turnActive: false, isTyping: false });
    expect(h.wrapper.getState().messages.some((row) => row.working)).toBe(false);
    expect(h.receipt.snapshot().state).toBe("accepted");
    vi.advanceTimersByTime(5 * TIMEOUT);
    expect(h.request).not.toHaveBeenCalled();
    // A delayed copy cannot clear fresh unscoped activity from another device.
    h.deliver({ type: "typing" });
    h.deliver({ type: "ack", ids: [h.turnId], cancelled: [h.turnId] });
    expect(h.wrapper.getState().isTyping).toBe(true);
  });

  it("cancelling B cannot clear unrelated A's typing, draft, or turn ownership", async () => {
    const h = await withClock();
    h.wrapper.send("B");
    const b = h.received[1]!.id!;
    h.deliver({ type: "progress", id: "draft-A", turnId: h.turnId, text: "A is working" });
    h.deliver({ type: "progress", id: "draft-B", turnId: b, text: "B is working" });
    h.deliver({ type: "typing" });
    h.deliver({ type: "ack", ids: [b], cancelled: [b] });
    expect(h.wrapper.getState()).toMatchObject({ turnActive: true, isTyping: true });
    expect(h.wrapper.getState().messages.find((row) => row.id === "draft-A")?.working).toBe(true);
    expect(h.wrapper.getState().messages.some((row) => row.id === "draft-B" && row.working)).toBe(false);
    expect([...inside(h.wrapper).applicationTurns.keys()]).toEqual([h.turnId]);
    vi.advanceTimersByTime(TIMEOUT);
    expect(h.request).toHaveBeenCalledTimes(1);
  });

  it("preserves remote started typing and a held follow-up when the first cancellation proof arrives on retry", async () => {
    const h = await setup({ timeout: 10_000 });
    vi.useFakeTimers();
    h.control.ack = false;
    const cancelled = h.wrapper.send("A stopped before admission")!;
    const a = h.received[0]!.id!;
    // Another device stopped A, but this device missed that cancellation ACK.
    // Its next turn B has authoritative running state, without any local owner
    // or working draft to protect the conversation's unscoped typing.
    h.deliver({ type: "user_committed", id: "remote-user", turnId: "remote-B",
      random_id: "remote-random", text: "B from another device", requestState: "queued", seq: 1 });
    h.deliver({ type: "request_state", id: "remote-user", turnId: "remote-B", state: "started", seq: 2 });
    h.deliver({ type: "typing" });
    const followup = h.wrapper.send("C held behind B")!;
    expect(cancelled.snapshot().state).toBe("sent");
    expect(followup.snapshot().state).toBe("queued");
    expect(h.wrapper.getState().messages.some((row) => row.working)).toBe(false);

    h.control.cancelled.add(a);
    h.control.ack = true;
    vi.advanceTimersByTime(1_100); // The ordinary same-ID delivery retry gets A's first proof.
    expect(cancelled.snapshot().state).toBe("accepted");
    expect(inside(h.wrapper).applicationTurns.has(a)).toBe(false);
    expect(h.wrapper.getState().messages.find((row) => row.id === "remote-user")?.requestState).toBe("started");
    expect.soft(h.wrapper.getState().isTyping).toBe(true);
    expect.soft(followup.snapshot().state).toBe("queued");
    expect(h.received.map((frame) => frame.id)).toEqual([a, a]);
    expect(inside(h.wrapper).applicationTurns.size).toBe(0);
    expect(inside(h.wrapper).activeTurnStallTimer).toBeNull();

    h.deliver({ type: "request_state", id: "remote-user", turnId: "remote-B", state: "completed", seq: 3 });
    h.deliver({ type: "turn_settled", turnId: "remote-B", outcome: "ok" });
    expect(h.wrapper.getState().isTyping).toBe(false);
    expect(followup.snapshot().state).toBe("accepted");
    expect(cancelled.snapshot().state).toBe("accepted");
    expect(h.received.map((frame) => frame.text)).toEqual([
      "A stopped before admission", "A stopped before admission", "C held behind B",
    ]);
    expect([...inside(h.wrapper).applicationTurns.keys()]).toEqual([h.received[2]!.id]);
  });

  it.each([
    ["live", "queued"], ["live", "started"], ["history", "queued"], ["history", "started"],
  ] as const)("protects remote work learned from %s in state %s after typing", async (source, state) => {
    const h = await withClock();
    h.deliver({ type: "typing" });
    const remote = { id: "remote-user", role: "user" as const, text: "remote work",
      turnId: "remote-B", requestState: state, seq: 2 };
    if (source === "history") h.deliver({ type: "history", messages: [remote] });
    else {
      h.deliver({ type: "user_committed", id: remote.id, text: remote.text,
        turnId: remote.turnId, requestState: "queued", seq: 1 });
      h.deliver({ type: "request_state", id: remote.id, turnId: remote.turnId, state, seq: 2 });
    }
    // A delayed older snapshot cannot remove the independently known work.
    h.deliver({ type: "history", messages: [{ ...remote, requestState: "completed", seq: 1 }] });
    const followup = h.wrapper.send("held")!;
    h.deliver({ type: "ack", ids: [h.turnId], cancelled: [h.turnId] });
    expect(h.wrapper.getState().messages.find((row) => row.id === remote.id)?.requestState).toBe(state);
    expect(h.wrapper.getState().isTyping).toBe(true);
    expect(followup.snapshot().state).toBe("queued");
    expect(h.receipt.snapshot().state).toBe("accepted");
    expect(inside(h.wrapper).applicationTurns.size).toBe(0);
    expect(inside(h.wrapper).activeTurnStallTimer).toBeNull();
    h.deliver({ type: "turn_settled", turnId: remote.turnId, outcome: "ok" });
    expect(h.wrapper.getState().isTyping).toBe(false);
    expect(followup.snapshot().state).toBe("accepted");
  });

  it.each([
    ["live", "completed"], ["live", "failed"], ["live", "cancelled"], ["live", "interrupted"],
    ["history", "completed"], ["history", "failed"], ["history", "cancelled"], ["history", "interrupted"],
  ] as const)("allows cancellation cleanup after %s reconciles a remote %s outcome", async (source, state) => {
    const h = await withClock();
    const remote = { id: "remote-user", role: "user" as const, text: "remote work",
      turnId: "remote-B", requestState: "started" as const, seq: 1 };
    h.deliver({ type: "user_committed", id: remote.id, text: remote.text,
      turnId: remote.turnId, requestState: remote.requestState, seq: 1 });
    h.deliver({ type: "typing" });
    if (source === "history") h.deliver({ type: "history", messages: [{ ...remote, requestState: state, seq: 2 }] });
    else h.deliver({ type: "request_state", id: remote.id, turnId: remote.turnId, state, seq: 2 });
    // Older active history must not resurrect a settled neighbor as an owner.
    h.deliver({ type: "history", messages: [remote] });
    expect(h.wrapper.getState().messages.find((row) => row.id === remote.id)?.requestState).toBe(state);
    h.deliver({ type: "ack", ids: [h.turnId], cancelled: [h.turnId] });
    expect(h.wrapper.getState().isTyping).toBe(false);
    expect(h.receipt.snapshot().state).toBe("accepted");
    expect(inside(h.wrapper).activeTurnStallTimer).toBeNull();
    vi.advanceTimersByTime(3 * TIMEOUT);
    expect(h.request).not.toHaveBeenCalled();
  });

  it.each(["queued", "started"] as const)("cleans up an exactly cancelled local %s row before its journal terminal arrives", async (requestState) => {
    const h = await withClock();
    h.deliver({ type: "user_committed", id: "local-user", text: "work", turnId: h.turnId,
      random_id: h.received[0]!.random_id, requestState, seq: 1 });
    h.deliver({ type: "typing" });
    h.deliver({ type: "ack", ids: [h.turnId], cancelled: [h.turnId] });
    expect(h.wrapper.getState().isTyping).toBe(false);
    expect(h.wrapper.getState().messages.find((row) => row.id === "local-user")?.requestState).toBe(requestState);
    expect(h.receipt.snapshot().state).toBe("accepted");
    expect(inside(h.wrapper).applicationTurns.size).toBe(0);
    expect(inside(h.wrapper).activeTurnStallTimer).toBeNull();
    vi.advanceTimersByTime(3 * TIMEOUT);
    expect(h.request).not.toHaveBeenCalled();
  });

  it("rechecks remote started ownership learned during exact draft cleanup", async () => {
    const h = await withClock();
    h.deliver({ type: "progress", id: "cancelled-draft", turnId: h.turnId, text: "partial" });
    h.deliver({ type: "typing" });
    const followup = h.wrapper.send("held")!;
    let injected = false;
    const unsubscribe = h.wrapper.subscribe((state) => {
      if (!injected && !state.messages.some((row) => row.id === "cancelled-draft")) {
        injected = true;
        h.deliver({ type: "user_committed", id: "remote-user", text: "remote work",
          turnId: "remote-B", requestState: "queued", seq: 1 });
        h.deliver({ type: "request_state", id: "remote-user", turnId: "remote-B", state: "started", seq: 2 });
      }
    });
    h.deliver({ type: "ack", ids: [h.turnId], cancelled: [h.turnId] });
    unsubscribe();
    expect(injected).toBe(true);
    expect(h.wrapper.getState().isTyping).toBe(true);
    expect(followup.snapshot().state).toBe("queued");
    expect(h.receipt.snapshot().state).toBe("accepted");
    expect(inside(h.wrapper).applicationTurns.size).toBe(0);
    expect(inside(h.wrapper).activeTurnStallTimer).toBeNull();
    h.deliver({ type: "turn_settled", turnId: "remote-B", outcome: "ok" });
    expect(followup.snapshot().state).toBe("accepted");
  });

  it("a fresh cancellation ACK cannot clear typing received reentrantly after its proof", async () => {
    const h = await setup();
    vi.useFakeTimers();
    h.control.ack = false;
    const receipt = h.wrapper.send("cancelled input")!;
    const id = h.received[0]!.id!;
    h.deliver({ type: "typing" });
    receipt.subscribe(({ state }) => {
      if (state === "accepted") h.deliver({ type: "typing" });
    });
    h.deliver({ type: "ack", ids: [id], cancelled: [id] });
    expect(h.wrapper.getState().isTyping).toBe(true);
    expect(inside(h.wrapper).applicationTurns.size).toBe(0);
    expect(inside(h.wrapper).activeTurnStallTimer).toBeNull();
  });

  it.each(["malformed", "not-subset"] as const)("rejects %s cancellation data before any receipt or watchdog effect", async (kind) => {
    const h = await setup();
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    h.control.ack = false;
    const receipt = h.wrapper.send("must remain unacked")!;
    const id = h.received[0]!.id!;
    h.deliver({ type: "ack", ids: [id], cancelled: kind === "malformed" ? [1] : ["foreign"] } as InboundMessage);
    expect(receipt.snapshot().state).toBe("sent");
    expect(inside(h.wrapper).client.unackedLedger.has(id)).toBe(true);
    expect(inside(h.wrapper).applicationTurns.has(id)).toBe(true);
    h.deliver({ type: "ack", ids: [id] });
    expect(receipt.snapshot().state).toBe("accepted");
    expect(inside(h.wrapper).activeTurnStallTimer).not.toBeNull();
  });

  it.each(["queued", "started"] as const)("keeps recovery for durable %s work after another input was cancelled", async (state) => {
    const h = await withClock();
    const other = h.wrapper.send("cancelled neighbor")!;
    const otherId = h.received[1]!.id!;
    h.deliver({ type: "ack", ids: [otherId], cancelled: [otherId] });
    h.deliver({ type: "history", messages: [{ id: "durable-work", role: "user", text: "work",
      randomId: h.received[0]!.random_id, turnId: h.turnId, requestState: state, seq: 1 }] });
    expect(other.snapshot().state).toBe("accepted");
    expect([...inside(h.wrapper).applicationTurns.keys()]).toEqual([h.turnId]);
    vi.advanceTimersByTime(TIMEOUT);
    expect(h.request).toHaveBeenCalledTimes(1);
    expect(h.receipt.snapshot().state).toBe("accepted");
  });

  it.each(["close", "terminal"] as const)("cleans up on %s and fences an already queued callback", async (end) => {
    const h = await setup();
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const scheduled = vi.spyOn(globalThis, "setTimeout");
    h.wrapper.send("work");
    const callback = scheduled.mock.calls.find(([, ms]) => ms === TIMEOUT)![0] as () => void;
    const request = vi.spyOn(inside(h.wrapper).client, "requestApplicationRecovery");
    if (end === "close") h.wrapper.close();
    else FakeNatsWS.instances.at(-1)!.onmessage?.({ data: "-ERR 'Authorization Violation'\r\n" });
    callback();
    vi.advanceTimersByTime(3 * TIMEOUT);
    expect(request).not.toHaveBeenCalled();
    expect(inside(h.wrapper).activeTurnStallTimer).toBeNull();
    expect(inside(h.wrapper).applicationTurns.size).toBe(0);
  });

  it("a reentrant close during timer replacement cannot install a retired timer", async () => {
    const h = await withClock();
    const clear = globalThis.clearTimeout;
    let closed = false;
    vi.spyOn(globalThis, "clearTimeout").mockImplementation((timer) => {
      clear(timer);
      if (!closed) { closed = true; h.wrapper.close(); }
    });
    h.deliver({ type: "typing" });
    expect(inside(h.wrapper).activeTurnStallTimer).toBeNull();
    expect(h.wrapper.getState().isTyping).toBe(false);
    vi.advanceTimersByTime(3 * TIMEOUT);
    expect(h.request).not.toHaveBeenCalled();
  });

  it("preserves replacement sends admitted by a timer cleanup hook during close", async () => {
    const h = await setup();
    vi.useFakeTimers();
    h.wrapper.send("old turn");
    const timer = inside(h.wrapper).activeTurnStallTimer;
    const clear = globalThis.clearTimeout;
    let replacement: ReturnType<WebChannelNATSClient["send"]>;
    let reopened = false;
    vi.spyOn(globalThis, "clearTimeout").mockImplementation((handle) => {
      clear(handle);
      if (!reopened && handle === timer) {
        reopened = true;
        h.wrapper.connect();
        replacement = h.wrapper.send("replacement turn");
      }
    });
    h.wrapper.close();
    // vi.waitFor advances this clock while native registration crypto settles.
    // Keep the timer spy in the same fake-clock lifetime through afterEach.
    await vi.waitFor(() => expect(replacement?.snapshot().state).toBe("accepted"));
    expect(h.received.map((msg) => msg.text)).toEqual(["old turn", "replacement turn"]);
    expect(inside(h.wrapper).applicationTurns.size).toBe(1);
    expect(inside(h.wrapper).activeTurnStallTimer).not.toBeNull();
  });

  it.each([
    ["held", false], ["unacked", false], ["held", true], ["unacked", true],
  ] as const)("arbitrates with the existing %s watchdog (existing fires first: %s)", async (lane, existingFirst) => {
    const h = await setup();
    vi.useFakeTimers();
    h.wrapper.send("accepted");
    if (lane === "held") h.deliver({ type: "typing" });
    else h.control.ack = false;
    const followup = h.wrapper.send("followup")!;
    const request = vi.spyOn(inside(h.wrapper).client, "requestApplicationRecovery");
    vi.advanceTimersByTime(500);
    if (existingFirst) h.deliver({ type: "request_state", id: "server-user", turnId: "turn", state: "started" });
    vi.advanceTimersByTime(500);
    expect(request).toHaveBeenCalledTimes(1);
    expect(inside(h.wrapper).activeTurnStallTimer).toBeNull();
    expect(inside(h.wrapper).heldStallTimer).toBeNull();
    expect(h.received.filter((msg) => msg.text === "accepted")).toHaveLength(1);
    expect(followup.snapshot().state).toBe(lane === "held" ? "queued" : "sent");
  });

  it("does not watch idle tabs, unaccepted messages, control sends, or timeout zero", async () => {
    const h = await setup({ timeout: 0 });
    vi.useFakeTimers();
    h.wrapper.send("work");
    expect(inside(h.wrapper).activeTurnStallTimer).toBeNull();
    vi.advanceTimersByTime(100_000);
    expect(h.control.registrations).toBe(1);
    h.wrapper.close();
    vi.useRealTimers();
    const idle = await setup();
    vi.useFakeTimers();
    expect(inside(idle.wrapper).activeTurnStallTimer).toBeNull();
    idle.wrapper.send("/stop");
    expect(inside(idle.wrapper).activeTurnStallTimer).toBeNull();
    idle.control.ack = false;
    idle.wrapper.send("unaccepted");
    expect(inside(idle.wrapper).activeTurnStallTimer).toBeNull();
  });
});
