import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WebChannelNATSClient } from "./nats-client-wrapper.js";
import type { InboundMessage } from "./nats-client.js";
import type { ChatMessage } from "./types.js";

/**
 * The texts of the USER bubbles, in transcript order.
 *
 * ⚠️ IT NARROWS ON `kind` FIRST, AND THAT IS THE POINT. `ChatMessage` is a
 * tagged union whose `reasoning` and `tool` variants carry neither `role` nor
 * `text`, so `messages.filter((m) => m.role === "user")` — what these two call
 * sites used to inline — could not narrow anything: `Array.filter` keeps the
 * element type unless its predicate is a type guard, so the following `.map`
 * still saw the whole union. Selecting the bubble arm by its absent tag makes
 * the intent ("the user's own bubbles") explicit and the result a real
 * `string[]`, without changing which messages are selected: a row with no
 * `role` never satisfied `role === "user"` at runtime either.
 */
function userTexts(messages: readonly ChatMessage[]): string[] {
  return messages.flatMap((m) => (m.kind === undefined && m.role === "user" ? [m.text] : []));
}

const registration = {
  devicePrivateKey: {} as CryptoKey,
  deviceX25519PrivateKey: {} as CryptoKey,
};

type WrapperInternals = {
  client: {
    requestApplicationRecovery: () => boolean;
    sendUserMessage: (text: string, id?: string) => string;
    notifySessionListeners: () => void;
    notifyErrorListeners: (error: Error, cause?: string) => void;
    getAckStallTimeoutMs: () => number;
    client: { connected: boolean; notifyStateListeners: () => void };
  };
  state: Record<string, unknown>;
  sessionEstablished: boolean;
  everSessionEstablished: boolean;
  held: Array<{ localId: string; text: string; receiptKey: string }>;
  heldStallSinceAt: number | null;
  heldStallRecoveryIssued: boolean;
  heldStallTimer: unknown;
  heldStallTimerGeneration: number;
  staleDraftTimer: unknown;
  handleMessage: (message: InboundMessage) => void;
  beginHeldStallEpisode: (ready: boolean) => void;
};

const inside = (wrapper: WebChannelNATSClient) => wrapper as unknown as WrapperInternals;

function makeWrapper(timeout = 1_000): WebChannelNATSClient {
  return new WebChannelNATSClient({
    natsUrl: "ws://127.0.0.1:4222",
    bootstrapJwt: "jwt",
    accountId: "account",
    tenant: "tenant",
    peerId: "peer",
    registration,
    heartbeatIntervalMs: 0,
    ackStallTimeoutMs: timeout,
  });
}

function makeReady(wrapper: WebChannelNATSClient): void {
  const value = inside(wrapper);
  value.state = { ...value.state, connected: true, status: "connected" };
  value.sessionEstablished = true;
  value.everSessionEstablished = true;
}

function frame(wrapper: WebChannelNATSClient, message: InboundMessage): void {
  inside(wrapper).handleMessage(message);
}

function startTypingHold(wrapper: WebChannelNATSClient, text = "held") {
  frame(wrapper, { type: "typing" });
  const receipt = wrapper.send(text)!;
  const bubble = wrapper.getState().messages.find((message) => message.text === text)!;
  return { receipt, bubble };
}

function rawState(wrapper: WebChannelNATSClient, connected: boolean): void {
  const low = inside(wrapper).client.client;
  low.connected = connected;
  low.notifyStateListeners();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("WebChannelNATSClient — #81 held-work recovery", () => {
  it("uses the inner resolved policy and preserves default/zero/max forwarding", () => {
    const omitted = new WebChannelNATSClient({
      natsUrl: "ws://127.0.0.1:4222",
      bootstrapJwt: "jwt",
      accountId: "account",
      tenant: "tenant",
      peerId: "peer",
      registration,
    });
    expect(inside(omitted).client.getAckStallTimeoutMs()).toBe(30_000);
    expect(inside(makeWrapper(0)).client.getAckStallTimeoutMs()).toBe(0);
    expect(inside(makeWrapper(2_147_483_647)).client.getAckStallTimeoutMs()).toBe(2_147_483_647);
    expect(inside(makeWrapper()).client.getAckStallTimeoutMs()).toBe(1_000);
  });

  it("requests one recovery from the first hold's age without failing, releasing, or minting an id", () => {
    const wrapper = makeWrapper();
    makeReady(wrapper);
    const request = vi.spyOn(inside(wrapper).client, "requestApplicationRecovery")
      .mockReturnValue(true);
    const first = startTypingHold(wrapper, "B");
    vi.advanceTimersByTime(600);
    const second = wrapper.send("C")!;
    expect(first.bubble.wireId).toBeUndefined();
    expect(second.snapshot()).toEqual({ state: "queued" });

    vi.advanceTimersByTime(399);
    expect(request).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(request).toHaveBeenCalledTimes(1);
    expect(first.receipt.snapshot()).toEqual({ state: "queued" });
    expect(second.snapshot()).toEqual({ state: "queued" });
    expect(wrapper.getState().messages.filter((message) => message.pending)).toHaveLength(2);
    expect(wrapper.getState().messages.every((message) => message.wireId === undefined)).toBe(true);
    vi.advanceTimersByTime(10_000);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("stages the first held bubble before timer-hook reentry and exposes FIFO only after timer commit", () => {
    const wrapper = makeWrapper();
    makeReady(wrapper);
    frame(wrapper, { type: "typing" });
    const snapshots: Array<{ texts: string[]; timer: unknown; generation: number }> = [];
    wrapper.subscribe((state) => snapshots.push({
      texts: userTexts(state.messages),
      timer: inside(wrapper).heldStallTimer,
      generation: inside(wrapper).heldStallTimerGeneration,
    }));

    const fakeSetTimeout = globalThis.setTimeout;
    let nestedReceipt: ReturnType<WebChannelNATSClient["send"]>;
    let hookTexts: string[] = [];
    let reenter = true;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: TimerHandler, delay?: number) => {
      const timer = fakeSetTimeout(fn, delay);
      if (reenter) {
        reenter = false;
        nestedReceipt = wrapper.send("B");
        hookTexts = userTexts(wrapper.getState().messages);
        expect(snapshots).toEqual([]);
      }
      return timer;
    }) as typeof setTimeout);

    const firstReceipt = wrapper.send("A")!;
    expect(hookTexts).toEqual(["A", "B"]);
    expect(inside(wrapper).held.map((entry) => entry.text)).toEqual(["A", "B"]);
    expect(firstReceipt.snapshot()).toEqual({ state: "queued" });
    expect(nestedReceipt!.snapshot()).toEqual({ state: "queued" });
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({ texts: ["A", "B"] });
    expect(snapshots[0]!.timer).not.toBeNull();
    expect(snapshots[0]!.generation).toBeGreaterThan(0);

    const publish = vi.spyOn(inside(wrapper).client, "sendUserMessage");
    frame(wrapper, { type: "turn_settled", turnId: "turn" });
    expect(publish.mock.calls.map(([text]) => text)).toEqual(["A", "B"]);
    expect(inside(wrapper).held).toHaveLength(0);
    expect(userTexts(wrapper.getState().messages)).toEqual(["A", "B"]);
  });

  it.each(["typing", "progress", "reasoning"] as const)(
    "authenticated live-turn %s activity resets the interval without requiring ids",
    (type) => {
      const wrapper = makeWrapper();
      makeReady(wrapper);
      const request = vi.spyOn(inside(wrapper).client, "requestApplicationRecovery")
        .mockReturnValue(true);
      startTypingHold(wrapper);
      vi.advanceTimersByTime(900);
      frame(wrapper, type === "progress"
        ? { type, text: "still working" }
        : type === "reasoning"
          ? { type }
          : { type });
      vi.advanceTimersByTime(999);
      expect(request).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(request).toHaveBeenCalledTimes(1);
    },
  );

  it("observes id-less agent activity before its reducer, then ordinary release owns cleanup", () => {
    const wrapper = makeWrapper();
    makeReady(wrapper);
    startTypingHold(wrapper);
    vi.advanceTimersByTime(700);
    let observedAge: number | null = null;
    wrapper.subscribe(() => { observedAge ??= inside(wrapper).heldStallSinceAt; });
    frame(wrapper, { type: "agent_message", text: "done" });
    expect(observedAge).toBe(700);
    expect(inside(wrapper).held).toHaveLength(0);
    expect(inside(wrapper).heldStallTimer).toBeNull();
    expect(wrapper.getState().messages.find((message) => message.text === "held")?.pending).toBe(false);
  });

  it.each(["history", "commands", "ack", "inbound_rejected"] as const)(
    "irrelevant %s frames do not reset held age or allowance",
    (type) => {
      const wrapper = makeWrapper();
      makeReady(wrapper);
      const request = vi.spyOn(inside(wrapper).client, "requestApplicationRecovery")
        .mockReturnValue(true);
      startTypingHold(wrapper);
      vi.advanceTimersByTime(900);
      const before = inside(wrapper).heldStallSinceAt;
      frame(wrapper, type === "history"
        ? { type, messages: [] }
        : type === "commands"
          ? { type, commands: [] }
          : type === "ack"
            ? { type, ids: ["unknown"] }
            : { type, ids: ["unknown"], reason: "overloaded" });
      expect(inside(wrapper).heldStallSinceAt).toBe(before);
      vi.advanceTimersByTime(100);
      expect(request).toHaveBeenCalledTimes(1);
    },
  );

  it("raw loss consumes and cancels before state callbacks; onSession alone does not re-arm", () => {
    const wrapper = makeWrapper();
    makeReady(wrapper);
    frame(wrapper, { type: "progress", id: "draft", text: "partial", turnId: "turn" });
    const receipt = wrapper.send("held")!;
    const request = vi.spyOn(inside(wrapper).client, "requestApplicationRecovery")
      .mockReturnValue(true);
    const callbackSnapshots: Array<{ issued: boolean; timer: unknown }> = [];
    wrapper.subscribe(() => callbackSnapshots.push({
      issued: inside(wrapper).heldStallRecoveryIssued,
      timer: inside(wrapper).heldStallTimer,
    }));

    rawState(wrapper, false);
    expect(callbackSnapshots[0]).toEqual({ issued: true, timer: null });
    expect(wrapper.getState()).toMatchObject({ status: "reconnecting", connected: false });
    vi.advanceTimersByTime(5_000);
    expect(request).not.toHaveBeenCalled();

    inside(wrapper).client.notifySessionListeners();
    expect(wrapper.getState()).toMatchObject({ status: "connected", connected: true });
    expect(inside(wrapper).heldStallRecoveryIssued).toBe(true);
    expect(inside(wrapper).heldStallTimer).toBeNull();
    vi.advanceTimersByTime(1_000);
    expect(request).not.toHaveBeenCalled();
    expect(receipt.snapshot()).toEqual({ state: "queued" });
  });

  it("a hold born non-ready spends its allowance and onSession alone does not arm it", () => {
    const wrapper = makeWrapper();
    frame(wrapper, { type: "progress", id: "draft", text: "partial", turnId: "turn" });
    const receipt = wrapper.send("offline-held")!;
    const request = vi.spyOn(inside(wrapper).client, "requestApplicationRecovery")
      .mockReturnValue(true);
    expect(inside(wrapper).heldStallRecoveryIssued).toBe(true);
    expect(inside(wrapper).heldStallTimer).toBeNull();
    inside(wrapper).client.notifySessionListeners();
    vi.advanceTimersByTime(5_000);
    expect(request).not.toHaveBeenCalled();
    expect(receipt.snapshot()).toEqual({ state: "queued" });
  });

  it("reports readiness only from onSession and keeps replacement raw-open non-ready", () => {
    const wrapper = makeWrapper(0);
    const seen: Array<{ status: string; connected: boolean }> = [];
    wrapper.subscribe((state) => seen.push({ status: state.status, connected: state.connected }));
    rawState(wrapper, true);
    expect(wrapper.getState()).toMatchObject({ status: "connecting", connected: false });
    inside(wrapper).client.notifySessionListeners();
    expect(wrapper.getState()).toMatchObject({ status: "connected", connected: true });
    rawState(wrapper, false);
    rawState(wrapper, true);
    expect(wrapper.getState()).toMatchObject({ status: "reconnecting", connected: false });
    inside(wrapper).client.notifySessionListeners();
    expect(wrapper.getState()).toMatchObject({ status: "connected", connected: true });
    expect(seen).toContainEqual({ status: "connecting", connected: false });
    expect(seen).toContainEqual({ status: "reconnecting", connected: false });
  });

  it("a ready-state listener closing synchronously prevents trailing watch, release, or revival", () => {
    const wrapper = makeWrapper();
    makeReady(wrapper);
    frame(wrapper, { type: "progress", id: "draft", text: "partial", turnId: "turn" });
    const receipt = wrapper.send("held")!;
    rawState(wrapper, false);
    const publish = vi.spyOn(inside(wrapper).client, "sendUserMessage");
    wrapper.subscribe((state) => {
      if (state.connected) wrapper.close();
    });
    inside(wrapper).client.notifySessionListeners();
    expect(wrapper.getState()).toMatchObject({ status: "reconnecting", connected: false });
    expect(inside(wrapper).sessionEstablished).toBe(false);
    expect(inside(wrapper).staleDraftTimer).toBeNull();
    expect(publish).not.toHaveBeenCalled();
    expect(receipt.snapshot()).toMatchObject({ state: "failed", failure: { reason: "closed" } });
  });

  it("every final-owner path retires the timer before callbacks", () => {
    const exercise = (remove: (wrapper: WebChannelNATSClient, localId: string) => void) => {
      const wrapper = makeWrapper();
      makeReady(wrapper);
      const request = vi.spyOn(inside(wrapper).client, "requestApplicationRecovery")
        .mockReturnValue(true);
      const { bubble } = startTypingHold(wrapper);
      const snapshots: unknown[] = [];
      wrapper.subscribe(() => {
        if (inside(wrapper).held.length === 0) snapshots.push(inside(wrapper).heldStallTimer);
      });
      remove(wrapper, bubble.id);
      expect(inside(wrapper).held).toHaveLength(0);
      expect(inside(wrapper).heldStallTimer).toBeNull();
      expect(snapshots.every((timer) => timer === null)).toBe(true);
      vi.advanceTimersByTime(5_000);
      expect(request).not.toHaveBeenCalled();
    };

    exercise((wrapper) => frame(wrapper, { type: "turn_settled", turnId: "turn" }));
    exercise((wrapper, id) => { wrapper.retract(id); });
    exercise((wrapper) => { wrapper.send("/stop"); });
    exercise((wrapper) => { wrapper.close(); });
    exercise((wrapper) => {
      inside(wrapper).client.notifyErrorListeners(new Error("terminal"), "auth-rejected");
    });
  });

  it("tokenized clear reentry leaves the nested held timer authoritative", () => {
    const wrapper = makeWrapper();
    makeReady(wrapper);
    const request = vi.spyOn(inside(wrapper).client, "requestApplicationRecovery")
      .mockReturnValue(true);
    startTypingHold(wrapper, "first");
    vi.advanceTimersByTime(100);
    const fakeClear = globalThis.clearTimeout;
    let reenter = true;
    vi.spyOn(globalThis, "clearTimeout").mockImplementation((timer) => {
      fakeClear(timer);
      if (reenter) {
        reenter = false;
        wrapper.send("nested");
      }
    });

    frame(wrapper, { type: "typing" });
    expect(inside(wrapper).held.map((entry) => entry.text)).toEqual(["first", "nested"]);
    expect(inside(wrapper).heldStallTimer).not.toBeNull();
    vi.advanceTimersByTime(999);
    expect(request).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("final-release timer-clear reentry cannot publish a nested send ahead of its owner", () => {
    const wrapper = makeWrapper();
    makeReady(wrapper);
    startTypingHold(wrapper, "first");
    const publish = vi.spyOn(inside(wrapper).client, "sendUserMessage");
    const fakeClear = globalThis.clearTimeout;
    let reenter = true;
    vi.spyOn(globalThis, "clearTimeout").mockImplementation((timer) => {
      fakeClear(timer);
      if (reenter) {
        reenter = false;
        wrapper.send("nested");
      }
    });

    frame(wrapper, { type: "turn_settled", turnId: "turn" });
    expect(publish.mock.calls.map(([text]) => text)).toEqual(["first", "nested"]);
    expect(inside(wrapper).held).toHaveLength(0);
    expect(inside(wrapper).heldStallTimer).toBeNull();
  });

  it("zero disables held recovery without changing ordinary FIFO release", () => {
    const wrapper = makeWrapper(0);
    makeReady(wrapper);
    const request = vi.spyOn(inside(wrapper).client, "requestApplicationRecovery")
      .mockReturnValue(true);
    const receipt = startTypingHold(wrapper).receipt;
    vi.advanceTimersByTime(60_000);
    expect(request).not.toHaveBeenCalled();
    expect(receipt.snapshot()).toEqual({ state: "queued" });
    frame(wrapper, { type: "turn_settled", turnId: "turn" });
    expect(inside(wrapper).held).toHaveLength(0);
    expect(receipt.snapshot().state).toBe("queued");
  });
});
