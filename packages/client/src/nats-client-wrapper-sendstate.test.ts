import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebChannelNATSClient } from "./nats-client-wrapper.js";
import {
  inboundSubject,
  outboundSubject,
  type OutboundMessage,
} from "./nats-client.js";
import { openMessage, sealMessage } from "./e2e-crypto-browser.js";
import { generateDevicePopKeyPair } from "./pop-register.js";
import {
  AGENT,
  FakeNatsWS,
  JWT,
  PEER,
  TENANT,
  generateDeviceX25519,
  installFakeWebSocket,
  makeAgentIdentity,
  registerAgent,
  settle,
  type AgentIdentity,
  type ServerHandler,
} from "./nats-client-wrapped.test-harness.js";
import type { ChatMessage, SendFailure, SendReceipt } from "./types.js";
import { WEBCHANNEL_PROTOCOL_VERSION } from "./protocol.js";

// ---------------------------------------------------------------------------
// P0-4 — wrapper-level receipt + ChatMessage.sendState behavior (D5). Runs the
// real WebChannelNATSClient over the fake NATS socket with a register-delivered
// conversation key, so `completed` promotion, receipt handles, held/terminal
// ownership, and the coalesce-anchor contract are exercised end to end.
// ---------------------------------------------------------------------------

const IN = inboundSubject(TENANT, AGENT, PEER);
const OUT = outboundSubject(TENANT, AGENT, PEER);

let restore: () => void;
beforeEach(() => { restore = installFakeWebSocket(); });
afterEach(() => restore());

type Setup = {
  wrapper: WebChannelNATSClient;
  K: Uint8Array;
  identity: AgentIdentity;
  devicePublicRaw: Uint8Array;
  received: string[];
  control: { ack: boolean };
};

/**
 * A registered wrapper over the fake socket; auto-acks user_messages by default.
 * `opts.connect === false` returns the wrapper UNCONNECTED (no dial, no session
 * key) so a caller can queue pre-connect sends and drive `connect()` itself —
 * the only way to exercise a multi-entry `flushQueue()` drain.
 */
async function connectWrapper(
  control: { ack: boolean } = { ack: true },
  opts: { connect?: boolean } = {},
): Promise<Setup> {
  const pop = await generateDevicePopKeyPair();
  const x = await generateDeviceX25519();
  const identity = makeAgentIdentity();
  const K = new Uint8Array(32).fill(55);
  const received: string[] = [];
  const registration = registerAgent(K, x.publicRaw, identity);
  const handler: ServerHandler = async (s, p, server, reply) => {
    await registration(s, p, server, reply);
    if (s !== IN) return;
    const msg = openMessage(p, K) as { type?: string; id?: string } | null;
    if (msg?.type !== "user_message" || !msg.id) return;
    received.push(msg.id);
    if (control.ack) {
      server.deliverToClient(OUT, sealMessage({ accountId: AGENT, tenant: TENANT, sub: PEER }, K, { type: "ack", ids: [msg.id] } as unknown as OutboundMessage));
    }
  };
  FakeNatsWS.sharedHandler = handler;
  const wrapper = new WebChannelNATSClient({
    natsUrl: "ws://127.0.0.1:4222",
    bootstrapJwt: JWT,
    accountId: AGENT,
    tenant: TENANT,
    peerId: PEER,
    heartbeatIntervalMs: 0,
    registration: {
      devicePrivateKey: pop.privateKey,
      deviceX25519PrivateKey: x.privateKey,
      pinnedAgentPublicKey: identity.publicB64url,
    },
  });
  if (opts.connect !== false) {
    wrapper.connect();
    await settle();
  }
  return { wrapper, K, identity, devicePublicRaw: x.publicRaw, received, control };
}

const userBubble = (w: WebChannelNATSClient, text: string): ChatMessage | undefined =>
  w.getState().messages.find((m) => m.role === "user" && m.text === text);
const deliverOut = (K: Uint8Array, msg: Record<string, unknown>): void => {
  FakeNatsWS.instances.at(-1)!.deliverToClient(OUT, sealMessage({ accountId: AGENT, tenant: TENANT, sub: PEER }, K, msg as unknown as OutboundMessage));
};
/** Record the distinct sendState sequence of the first user bubble matching `text`. */
function trackBubble(w: WebChannelNATSClient, text: string): string[] {
  const seq: string[] = [];
  w.subscribe((s) => {
    const m = s.messages.find((x) => x.role === "user" && x.text === text);
    if (m?.sendState && seq[seq.length - 1] !== m.sendState) seq.push(m.sendState);
  });
  return seq;
}

describe("WebChannelNATSClient — P0-4 receipt + sendState (wrapper)", () => {
  // T-hp: queued → sent → accepted → completed, each once (ack then ok settle).
  it("T-hp: a happy-path send reaches completed on turn_settled{ok}", async () => {
    const h = await connectWrapper();
    const seq = trackBubble(h.wrapper, "hello");
    h.wrapper.send("hello");
    await settle();
    const wireId = userBubble(h.wrapper, "hello")!.wireId!;
    deliverOut(h.K, { type: "turn_settled", turnId: wireId, outcome: "ok" });
    await settle();
    expect(seq).toEqual(["queued", "sent", "accepted", "completed"]);
    h.wrapper.close();
  });

  // T-tf: send → ack → turn_settled{error} → accepted then failed{turn-failed}.
  it("T-tf: turn_settled{error} fails the anchor as turn-failed (retryable)", async () => {
    const h = await connectWrapper();
    const seq = trackBubble(h.wrapper, "boom");
    h.wrapper.send("boom");
    await settle();
    const wireId = userBubble(h.wrapper, "boom")!.wireId!;
    deliverOut(h.K, { type: "turn_settled", turnId: wireId, outcome: "error" });
    await settle();
    expect(seq).toEqual(["queued", "sent", "accepted", "failed"]);
    expect(userBubble(h.wrapper, "boom")!.sendFailure).toMatchObject({ reason: "turn-failed", retryable: true });
    h.wrapper.close();
  });

  for (const scenario of [
    { outcome: "ok" as const, state: "completed" as const, reason: undefined },
    { outcome: "error" as const, state: "failed" as const, reason: "turn-failed" as const },
  ]) {
    it(`commits missing-ACK turn_settled{${scenario.outcome}} before typing settlement can close`, async () => {
      const h = await connectWrapper({ ack: false });
      const receipt = h.wrapper.send(`settle-${scenario.outcome}`)!;
      await settle();
      expect(receipt.snapshot().state).toBe("sent");
      const wireId = userBubble(h.wrapper, `settle-${scenario.outcome}`)!.wireId!;

      deliverOut(h.K, { type: "typing" });
      await settle();
      let closed = false;
      const unsubscribe = h.wrapper.subscribe((state) => {
        if (!closed && state.isTyping === false) {
          closed = true;
          h.wrapper.close();
        }
      });

      deliverOut(h.K, { type: "turn_settled", turnId: wireId, outcome: scenario.outcome });
      await settle();
      expect(closed).toBe(true);
      expect(receipt.snapshot().state).toBe(scenario.state);
      if (scenario.reason) {
        expect(receipt.snapshot().failure).toMatchObject({ reason: scenario.reason, retryable: true });
      } else {
        expect(receipt.snapshot().failure).toBeUndefined();
      }
      expect(receipt.snapshot().failure?.reason).not.toBe("closed");
      unsubscribe();
    });
  }

  // T-st: an acked send with NO turn_settled ends at accepted — completed forbidden
  // (a /stop-killed message is acked as admitted but never runs a turn).
  it("T-st: an acked-but-never-settled send stays accepted, never completed", async () => {
    const h = await connectWrapper();
    const seq = trackBubble(h.wrapper, "stopped");
    h.wrapper.send("stopped");
    await settle();
    expect(seq).toEqual(["queued", "sent", "accepted"]);
    expect(seq).not.toContain("completed");
    h.wrapper.close();
  });

  // T-co: a coalesced 3-send burst settles as ONE turn — only the anchor
  // (wireId === turnId) reaches completed; the earlier two stay accepted.
  it("T-co: coalesce anchor — only the anchor bubble completes, prior sends stay accepted", async () => {
    const h = await connectWrapper();
    h.wrapper.send("c1");
    h.wrapper.send("c2");
    h.wrapper.send("c3");
    await settle();
    const anchorWire = userBubble(h.wrapper, "c3")!.wireId!;
    deliverOut(h.K, { type: "turn_settled", turnId: anchorWire, outcome: "ok" });
    await settle();
    expect(userBubble(h.wrapper, "c1")!.sendState).toBe("accepted");
    expect(userBubble(h.wrapper, "c2")!.sendState).toBe("accepted");
    expect(userBubble(h.wrapper, "c3")!.sendState).toBe("completed");
    h.wrapper.close();
  });

  // T-mv (a): a legacy plugin (turn_settled WITHOUT outcome) never fabricates
  // completed — the send stays accepted while the UI still settles.
  it("T-mv(a): a legacy turn_settled (no outcome) leaves the send accepted, UI still settles", async () => {
    const h = await connectWrapper();
    const seq = trackBubble(h.wrapper, "legacy");
    h.wrapper.send("legacy");
    await settle();
    // typing then a no-outcome settle: isTyping must clear, sendState must NOT complete.
    deliverOut(h.K, { type: "typing" });
    await settle();
    const wireId = userBubble(h.wrapper, "legacy")!.wireId!;
    deliverOut(h.K, { type: "turn_settled", turnId: wireId });
    await settle();
    expect(seq).toEqual(["queued", "sent", "accepted"]);
    expect(userBubble(h.wrapper, "legacy")!.sendState).toBe("accepted");
    expect(h.wrapper.getState().isTyping).toBe(false); // UI settled
    h.wrapper.close();
  });

  // Forward-compat tolerance: a turn_settled{outcome} whose turnId matches no
  // anchor is a safe no-op (never crashes or mis-promotes). NOTE: this is NOT the
  // T-mv(b) "new plugin + OLD client" case — that half is a STRUCTURAL guarantee
  // (outcome is an additive field the client re-declares zero-dep; an old client
  // simply never reads it), not something the new client can exercise. Documented,
  // not claimed here.
  it("forward-compat: an outcome for an unknown turn is a safe no-op", async () => {
    const h = await connectWrapper();
    h.wrapper.send("keep");
    await settle();
    expect(() => deliverOut(h.K, { type: "turn_settled", turnId: "no-such-turn", outcome: "ok" })).not.toThrow();
    await settle();
    expect(userBubble(h.wrapper, "keep")!.sendState).toBe("accepted"); // unchanged
    h.wrapper.close();
  });
});

describe("WebChannelNATSClient — synchronous callback outbound FIFO", () => {
  it("commits immediate A before its state subscriber can send B", async () => {
    const h = await connectWrapper({ ack: false });
    let injected = false;
    let secondReceipt: ReturnType<WebChannelNATSClient["send"]>;
    let secondSnapshotInside: ChatMessage["sendState"];
    const unsubscribe = h.wrapper.subscribe((state) => {
      if (injected || !state.messages.some((m) => m.role === "user" && m.text === "immediate-A")) return;
      injected = true;
      secondReceipt = h.wrapper.send("immediate-B");
      secondSnapshotInside = secondReceipt!.snapshot().state;
    });

    const firstReceipt = h.wrapper.send("immediate-A")!;
    await settle();
    const userMessages = h.wrapper.getState().messages.filter((m) => m.role === "user");
    expect(userMessages.map((m) => m.text)).toEqual(["immediate-A", "immediate-B"]);
    expect(h.received.slice(-2)).toEqual(userMessages.map((m) => m.wireId));
    expect(firstReceipt.snapshot().state).toBe("sent");
    // B's low tracker reached sent inside A's queued callback; B's serialized
    // sent event has not fanned out yet, but its synchronous snapshot is current.
    expect(secondSnapshotInside).toBe("sent");
    expect(secondReceipt!.snapshot().state).toBe("sent");

    unsubscribe();
    h.wrapper.close();
  });

  it("commits the final held A before its release subscriber can send B", async () => {
    const h = await connectWrapper({ ack: false });
    deliverOut(h.K, { type: "typing" });
    await settle();
    const heldReceipt = h.wrapper.send("held-final-A")!;
    expect((h.wrapper as unknown as { held: unknown[] }).held).toHaveLength(1);

    let injected = false;
    let secondReceipt: ReturnType<WebChannelNATSClient["send"]>;
    const unsubscribe = h.wrapper.subscribe((state) => {
      const released = state.messages.find((m) => m.text === "held-final-A");
      if (injected || released?.pending === true || !released?.wireId) return;
      injected = true;
      // This is the final held entry: held[] is empty, so B takes the immediate
      // path and would jump A unless A already owns its low-level queue position.
      secondReceipt = h.wrapper.send("after-final-B");
    });

    deliverOut(h.K, { type: "turn_settled", turnId: "prior-turn" });
    await settle();
    const userMessages = h.wrapper.getState().messages.filter((m) => m.role === "user");
    expect(userMessages.map((m) => m.text)).toEqual(["held-final-A", "after-final-B"]);
    expect(h.received.slice(-2)).toEqual(userMessages.map((m) => m.wireId));
    expect(heldReceipt.snapshot().state).toBe("sent");
    expect(secondReceipt!.snapshot().state).toBe("sent");

    unsubscribe();
    h.wrapper.close();
  });

  it("reports nested post-close B as failed before its serialized callbacks drain", async () => {
    const h = await connectWrapper({ ack: false });
    const bubbleStates = trackBubble(h.wrapper, "post-close-B");
    const receiptEvents: Array<{ event: ChatMessage["sendState"]; snapshot: ChatMessage["sendState"] }> = [];
    let injected = false;
    let nestedReceipt: SendReceipt | undefined;
    let snapshotInside: ReturnType<SendReceipt["snapshot"]> | undefined;
    const unsubscribe = h.wrapper.subscribe((state) => {
      const trigger = state.messages.find((m) => m.text === "close-trigger-A");
      if (injected || trigger?.sendState !== "queued") return;
      injected = true;
      h.wrapper.close();
      nestedReceipt = h.wrapper.send("post-close-B")!;
      nestedReceipt.subscribe((event) => {
        receiptEvents.push({ event: event.state, snapshot: nestedReceipt!.snapshot().state });
      });
      // B's queued/failed callbacks are FIFO-deferred behind A's current queued
      // fanout, but the low tracker has already synchronously reached failed.
      snapshotInside = nestedReceipt.snapshot();
    });

    const triggerReceipt = h.wrapper.send("close-trigger-A")!;
    await settle();

    expect(injected).toBe(true);
    expect(snapshotInside).toMatchObject({
      state: "failed",
      failure: { reason: "closed", retryable: false },
    });
    expect(triggerReceipt.snapshot()).toMatchObject({ state: "failed", failure: { reason: "closed" } });
    expect(nestedReceipt!.snapshot()).toEqual(snapshotInside);
    expect(bubbleStates).toEqual(["queued", "failed"]);
    expect(receiptEvents).toEqual([{ event: "failed", snapshot: "failed" }]);
    expect(userBubble(h.wrapper, "post-close-B")).toMatchObject({
      sendState: "failed",
      sendFailure: { reason: "closed", retryable: false },
    });
    unsubscribe();
  });

  it("reports nested post-terminal B as failed before its serialized callbacks drain", async () => {
    const h = await connectWrapper({ ack: false });
    const bubbleStates = trackBubble(h.wrapper, "post-terminal-B");
    const receiptEvents: Array<{ event: ChatMessage["sendState"]; snapshot: ChatMessage["sendState"] }> = [];
    let injected = false;
    let nestedReceipt: SendReceipt | undefined;
    let snapshotInside: ReturnType<SendReceipt["snapshot"]> | undefined;
    const unsubscribe = h.wrapper.subscribe((state) => {
      const trigger = state.messages.find((m) => m.text === "terminal-trigger-A");
      if (injected || trigger?.sendState !== "sent") return;
      injected = true;
      FakeNatsWS.instances.at(-1)!.onmessage?.({ data: "-ERR 'Authorization Violation'\r\n" });
      nestedReceipt = h.wrapper.send("post-terminal-B")!;
      nestedReceipt.subscribe((event) => {
        receiptEvents.push({ event: event.state, snapshot: nestedReceipt!.snapshot().state });
      });
      // The terminal latch and low tracker have advanced even though B's public
      // queued/failed events must wait for A's current fanout to finish.
      snapshotInside = nestedReceipt.snapshot();
    });

    const triggerReceipt = h.wrapper.send("terminal-trigger-A")!;
    await settle();

    expect(injected).toBe(true);
    expect(snapshotInside).toMatchObject({
      state: "failed",
      failure: { reason: "terminal", cause: "auth-rejected", retryable: false },
    });
    expect(triggerReceipt.snapshot()).toMatchObject({ state: "failed", failure: { reason: "terminal" } });
    expect(nestedReceipt!.snapshot()).toEqual(snapshotInside);
    expect(bubbleStates).toEqual(["queued", "failed"]);
    expect(receiptEvents).toEqual([{ event: "failed", snapshot: "failed" }]);
    expect(userBubble(h.wrapper, "post-terminal-B")).toMatchObject({
      sendState: "failed",
      sendFailure: { reason: "terminal", cause: "auth-rejected", retryable: false },
    });
    expect(h.wrapper.getState().status).toBe("error");
    unsubscribe();
  });
});

describe("WebChannelNATSClient — explicit /stop reentrant replacement ordering", () => {
  it("commits /stop before releasing B from a held-receipt cancellation callback", async () => {
    const h = await connectWrapper({ ack: false });
    deliverOut(h.K, { type: "typing" });
    await settle();

    const heldReceipt = h.wrapper.send("stop-held-H")!;
    let cancellationCallbacks = 0;
    let replacementReceipt: SendReceipt | undefined;
    let replacementSnapshotInside: ChatMessage["sendState"];
    heldReceipt.subscribe((event) => {
      if (event.failure?.reason !== "cancelled") return;
      cancellationCallbacks++;
      replacementReceipt = h.wrapper.send("stop-callback-B")!;
      replacementSnapshotInside = replacementReceipt.snapshot().state;
    });

    const stopReceipt = h.wrapper.send("/stop")!;
    await settle();

    const stopBubble = userBubble(h.wrapper, "/stop")!;
    const replacementBubble = userBubble(h.wrapper, "stop-callback-B")!;
    const oldBubble = userBubble(h.wrapper, "stop-held-H")!;
    expect(cancellationCallbacks).toBe(1);
    expect(replacementSnapshotInside).toBe("queued");
    expect(h.received).toEqual([stopBubble.wireId, replacementBubble.wireId]);
    expect(h.wrapper.getState().messages.filter((m) => m.role === "user").map((m) => m.text)).toEqual([
      "stop-held-H",
      "/stop",
      "stop-callback-B",
    ]);
    expect(stopReceipt.snapshot().state).toBe("sent");
    expect(replacementReceipt!.snapshot().state).toBe("sent");
    expect(replacementBubble).toMatchObject({ pending: false, sendState: "sent" });
    expect(replacementBubble.wireId).toBeDefined();
    expect((h.wrapper as unknown as { held: unknown[] }).held).toHaveLength(0);
    expect(heldReceipt.snapshot()).toMatchObject({
      state: "failed",
      failure: { reason: "cancelled", retryable: false },
    });
    expect(oldBubble).toMatchObject({
      pending: false,
      retracted: true,
      sendState: "failed",
      sendFailure: { reason: "cancelled", retryable: false },
    });
    h.wrapper.close();
  });

  it("commits /stop before releasing C from its local-finalization state callback", async () => {
    const h = await connectWrapper({ ack: false });
    deliverOut(h.K, { type: "typing" });
    await settle();

    const heldReceipt = h.wrapper.send("finalize-held-H")!;
    let injected = false;
    let replacementReceipt: SendReceipt | undefined;
    let replacementSnapshotInside: ChatMessage["sendState"];
    const unsubscribe = h.wrapper.subscribe((state) => {
      const oldBubble = state.messages.find((m) => m.text === "finalize-held-H");
      if (injected || state.isTyping !== false || oldBubble?.retracted !== true) return;
      injected = true;
      replacementReceipt = h.wrapper.send("finalize-state-C")!;
      replacementSnapshotInside = replacementReceipt.snapshot().state;
    });

    const stopReceipt = h.wrapper.send("/stop")!;
    await settle();

    const stopBubble = userBubble(h.wrapper, "/stop")!;
    const replacementBubble = userBubble(h.wrapper, "finalize-state-C")!;
    const oldBubble = userBubble(h.wrapper, "finalize-held-H")!;
    expect(injected).toBe(true);
    expect(replacementSnapshotInside).toBe("queued");
    expect(h.received).toEqual([stopBubble.wireId, replacementBubble.wireId]);
    expect(h.wrapper.getState().messages.filter((m) => m.role === "user").map((m) => m.text)).toEqual([
      "finalize-held-H",
      "/stop",
      "finalize-state-C",
    ]);
    expect(stopReceipt.snapshot().state).toBe("sent");
    expect(replacementReceipt!.snapshot().state).toBe("sent");
    expect(replacementBubble).toMatchObject({ pending: false, sendState: "sent" });
    expect(replacementBubble.wireId).toBeDefined();
    expect((h.wrapper as unknown as { held: unknown[] }).held).toHaveLength(0);
    expect(heldReceipt.snapshot()).toMatchObject({
      state: "failed",
      failure: { reason: "cancelled", retryable: false },
    });
    expect(oldBubble).toMatchObject({
      pending: false,
      retracted: true,
      sendState: "failed",
      sendFailure: { reason: "cancelled", retryable: false },
    });
    unsubscribe();
    h.wrapper.close();
  });
});

describe("WebChannelNATSClient — P0-4 receipt handle (T-rc)", () => {
  type Snap = { state: ChatMessage["sendState"]; failure?: SendFailure };

  // T-rc (a): held(queued) → release(sent) → accepted → adoption. The receipt id
  // is immutable; subscribed AFTER send the callback sequence is exactly
  // [sent, accepted] (2), and the id-adopting snapshot fires 0 receipt callbacks.
  it("T-rc(a): a held receipt observes [sent, accepted]; adoption fires no callback and keeps the id", async () => {
    const h = await connectWrapper();
    deliverOut(h.K, { type: "typing" }); // turn in flight → the next send holds
    await settle();
    const receipt = h.wrapper.send("held-msg")!;
    expect(receipt.snapshot().state).toBe("queued");
    const cbs: Snap[] = [];
    receipt.subscribe((s) => cbs.push(s));
    const idBefore = receipt.id;

    // Settle the turn → release → publish → auto-ack → accepted.
    deliverOut(h.K, { type: "turn_settled", turnId: "T" });
    await settle();
    expect(cbs.map((c) => c.state)).toEqual(["sent", "accepted"]);

    // History adoption rewrites the bubble id — the receipt id is unchanged and
    // no send-state callback fires.
    deliverOut(h.K, {
      type: "history",
      messages: [{ id: "srv-held", role: "user", text: "held-msg" }],
    });
    await settle();
    expect(receipt.id).toBe(idBefore);
    expect(cbs.map((c) => c.state)).toEqual(["sent", "accepted"]); // no extra callback
    expect(h.wrapper.getState().messages.some((m) => m.id === "srv-held")).toBe(true); // adopted
    h.wrapper.close();
  });

  // T-rc (b): held → /stop → failed{cancelled} exactly once; a following
  // retract() removes the bubble but the receipt still reports failed{cancelled}
  // with no further callback.
  it("T-rc(b): /stop cancels the held receipt once; retract keeps snapshot, no extra callback", async () => {
    const h = await connectWrapper();
    deliverOut(h.K, { type: "typing" });
    await settle();
    const receipt = h.wrapper.send("cancel-me")!;
    const cbs: Snap[] = [];
    receipt.subscribe((s) => cbs.push(s));

    h.wrapper.send("/stop"); // markHeldRetracted → failed{cancelled}
    expect(cbs).toHaveLength(1);
    expect(cbs[0]).toMatchObject({ state: "failed", failure: { reason: "cancelled", retryable: false } });

    const retractedId = h.wrapper.getState().messages.find((m) => m.retracted)!.id;
    expect(h.wrapper.retract(retractedId)).toBe(true);
    expect(cbs).toHaveLength(1); // no further callback
    expect(receipt.snapshot().state).toBe("failed");
    expect(receipt.snapshot().failure).toMatchObject({ reason: "cancelled" });
    h.wrapper.close();
  });

  // T-rc (c): repeated snapshot() calls are side-effect free and stable.
  it("T-rc(c): repeated snapshot() is stable and side-effect free", async () => {
    const h = await connectWrapper();
    const receipt = h.wrapper.send("plain")!;
    await settle();
    const a = receipt.snapshot();
    const b = receipt.snapshot();
    expect(a).toEqual(b);
    expect(a.state).toBe("accepted");
    h.wrapper.close();
  });

  // T-rc (d): a transition arriving while a receipt callback runs stays consistent
  // — a re-entrant snapshot() inside the callback sees the just-applied state.
  it("T-rc(d): a re-entrant snapshot inside the callback is consistent", async () => {
    const h = await connectWrapper();
    const receipt = h.wrapper.send("reentrant")!;
    const seen: Array<ChatMessage["sendState"]> = [];
    receipt.subscribe((s) => { seen.push(receipt.snapshot().state); expect(receipt.snapshot().state).toBe(s.state); });
    await settle();
    expect(seen).toContain("accepted");
    h.wrapper.close();
  });

  it("serializes teardown re-entry so two receipt listeners see sent→failed with matching snapshots", async () => {
    const h = await connectWrapper({ ack: false }, { connect: false });
    const receipt = h.wrapper.send("receipt-reentrant-close")!;
    const first: Array<{ event: ChatMessage["sendState"]; snapshot: ChatMessage["sendState"] }> = [];
    const second: Array<{ event: ChatMessage["sendState"]; snapshot: ChatMessage["sendState"] }> = [];
    receipt.subscribe((event) => first.push({ event: event.state, snapshot: receipt.snapshot().state }));
    receipt.subscribe((event) => second.push({ event: event.state, snapshot: receipt.snapshot().state }));

    let closed = false;
    h.wrapper.subscribe((state) => {
      const bubble = state.messages.find((m) => m.text === "receipt-reentrant-close");
      if (!closed && bubble?.sendState === "sent") {
        closed = true;
        h.wrapper.close();
      }
    });

    h.wrapper.connect();
    await settle();
    expect(closed).toBe(true);
    for (const events of [first, second]) {
      expect(events.map((event) => event.event)).toEqual(["sent", "failed"]);
      expect(events.every((event) => event.event === event.snapshot)).toBe(true);
    }
    expect(receipt.snapshot()).toMatchObject({ state: "failed", failure: { reason: "closed" } });
  });

  it("queues a nested turn outcome until the current receipt fanout is complete", async () => {
    const h = await connectWrapper({ ack: false }, { connect: false });
    const receipt = h.wrapper.send("nested-wrapper-outcome")!;
    const wireId = userBubble(h.wrapper, "nested-wrapper-outcome")!.wireId!;
    const observed: Array<{ event: ChatMessage["sendState"]; snapshot: ChatMessage["sendState"] }> = [];
    receipt.subscribe((event) => observed.push({ event: event.state, snapshot: receipt.snapshot().state }));

    let settled = false;
    h.wrapper.subscribe((state) => {
      const bubble = state.messages.find((m) => m.text === "nested-wrapper-outcome");
      if (!settled && bubble?.sendState === "sent") {
        settled = true;
        // Synchronous fake-socket delivery re-enters the wrapper reducer while
        // the `sent` bubble notification is still on the stack.
        deliverOut(h.K, { type: "turn_settled", turnId: wireId, outcome: "error" });
      }
    });

    h.wrapper.connect();
    await settle();
    expect(settled).toBe(true);
    expect(observed.map((event) => event.event)).toEqual(["sent", "failed"]);
    expect(observed.every((event) => event.event === event.snapshot)).toBe(true);
    expect(receipt.snapshot()).toMatchObject({
      state: "failed",
      failure: { reason: "turn-failed", retryable: true },
    });
    h.wrapper.close();
  });
});

describe("WebChannelNATSClient — P0-4 held/terminal ownership (T-cl, T-re)", () => {
  // T-cl: close() fails an unacked (ledgered) send AND a held send with
  // failed{closed}; a /stop-retracted bubble is preserved untouched. (The pure
  // queued-vs-ledger sweep on disconnect is covered at the low level in
  // nats-client-sendstate.test.ts; here the wrapper-owned held[] path is the
  // point, driven only through public API + real sealed frames.)
  it("T-cl: close() fails unacked + held with failed{closed}; retracted preserved", async () => {
    const h = await connectWrapper({ ack: false });

    // Unacked: an idle send over the live session → ledger (never acked).
    h.wrapper.send("unacked");
    await settle();

    // A real sealed `typing` frame puts a turn in flight so the next send holds;
    // /stop then retracts it (failed{cancelled}) — proving it survives close.
    deliverOut(h.K, { type: "typing" });
    await settle();
    h.wrapper.send("to-retract"); // held
    h.wrapper.send("/stop"); // retracts "to-retract" → failed{cancelled}, clears turn state
    const retracted = h.wrapper.getState().messages.find((m) => m.retracted && m.text === "to-retract")!;

    // Fresh turn (real typing frame) → a held send that close() must fail.
    deliverOut(h.K, { type: "typing" });
    await settle();
    h.wrapper.send("held"); // held[]

    h.wrapper.close();

    for (const text of ["unacked", "held"]) {
      const m = userBubble(h.wrapper, text)!;
      expect(m.sendState).toBe("failed");
      expect(m.sendFailure).toMatchObject({ reason: "closed", retryable: false });
    }
    // Retracted bubble is unchanged (still cancelled, still retracted).
    const afterRetract = h.wrapper.getState().messages.find((m) => m.id === retracted.id)!;
    expect(afterRetract.retracted).toBe(true);
    expect(afterRetract.sendFailure).toMatchObject({ reason: "cancelled" });
    // Structures cleared.
    expect((h.wrapper as unknown as { held: unknown[] }).held).toHaveLength(0);
  });

  // T-re: a GENUINE terminal failure (driven through the socket's -ERR protocol
  // line, not a private method call) sweeps in the mandated order — low-level
  // pending sweep → wrapper held sweep → a re-entrant send from a held receipt
  // subscriber immediate-fails → state moves to "error".
  it("T-re: a genuine -ERR terminal sweeps low-level → held → re-entrant → error, in order", async () => {
    const h = await connectWrapper({ ack: false });
    const order: string[] = [];

    // A ledgered (published-but-unacked) pending send → swept by the low level.
    const unackedReceipt = h.wrapper.send("unacked")!;
    await settle();
    expect(unackedReceipt.snapshot().state).toBe("sent");
    unackedReceipt.subscribe((s) => { if (s.state === "failed") order.push("lowlevel-unacked-failed"); });

    // A held send → swept by the wrapper; its subscriber re-enters send(). Turn
    // in flight via a real sealed `typing` frame.
    deliverOut(h.K, { type: "typing" });
    await settle();
    const heldReceipt = h.wrapper.send("held")!;
    let injected: ChatMessage["sendState"] | undefined;
    heldReceipt.subscribe((s) => {
      if (s.state !== "failed") return;
      order.push("wrapper-held-failed");
      const r = h.wrapper.send("during-terminal"); // re-entrant during the sweep
      injected = r?.snapshot().state;
      if (injected === "failed") order.push("reentrant-immediate-failed");
    });
    h.wrapper.subscribe((st) => { if (st.status === "error" && order.at(-1) !== "state-error") order.push("state-error"); });

    // Genuine terminal: emit the -ERR literal on the live socket's protocol stream.
    FakeNatsWS.instances.at(-1)!.onmessage?.({ data: "-ERR 'Authorization Violation'\r\n" });
    await settle();

    expect(unackedReceipt.snapshot()).toMatchObject({ state: "failed", failure: { reason: "terminal", cause: "auth-rejected" } });
    expect(heldReceipt.snapshot()).toMatchObject({ state: "failed", failure: { reason: "terminal" } });
    expect(injected).toBe("failed");
    expect(userBubble(h.wrapper, "during-terminal")?.sendState).toBe("failed");
    expect(h.wrapper.getState().status).toBe("error");
    expect(order).toEqual([
      "lowlevel-unacked-failed",
      "wrapper-held-failed",
      "reentrant-immediate-failed",
      "state-error",
    ]);
  });

  // T-re: a state listener calling close() during a send does not corrupt state
  // (mutate-before-notify; re-entrant disconnect is honored).
  it("T-re: a listener calling close() mid-transition leaves consistent state", async () => {
    const h = await connectWrapper();
    let closed = false;
    h.wrapper.subscribe((s) => {
      if (!closed && s.messages.some((m) => m.role === "user")) {
        closed = true;
        h.wrapper.close();
      }
    });
    expect(() => h.wrapper.send("boom")).not.toThrow();
    await settle();
    expect(h.wrapper.getState().status === "reconnecting" || h.wrapper.getState().status === "connected").toBe(true);
  });
});

// ---------------------------------------------------------------------------
// T-lg: a throwing embedder state listener must never cost a send. Under the D4
// commit order sendUserMessage runs AFTER the bubble is rendered, so an unguarded
// setState notify loop would abort publish() / the maybeRelease() drain and strand
// the receipt at `queued` forever.
// ---------------------------------------------------------------------------
describe("WebChannelNATSClient — P0-4 state-listener fault isolation (T-lg)", () => {
  let errSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { errSpy = vi.spyOn(console, "error").mockImplementation(() => {}); });
  afterEach(() => errSpy.mockRestore());

  // T-lg(a): publish() path — the throw is swallowed, the frame still goes out,
  // and the receipt leaves `queued`.
  it("T-lg(a): a throwing state listener does not abort publish; the send still reaches a terminal-bound state", async () => {
    const h = await connectWrapper();
    h.wrapper.subscribe(() => { throw new Error("embedder render bug"); });

    let receipt: ReturnType<WebChannelNATSClient["send"]>;
    expect(() => { receipt = h.wrapper.send("guarded"); }).not.toThrow();
    await settle();

    const wireId = userBubble(h.wrapper, "guarded")?.wireId;
    expect(wireId).toBeDefined();
    expect(h.received).toContain(wireId); // the frame really was published
    expect(receipt!.snapshot().state).not.toBe("queued");
    expect(receipt!.snapshot().state).toBe("accepted"); // auto-acked by the fake
    expect(errSpy).toHaveBeenCalled();
    h.wrapper.close();
  });

  // T-lg(b): maybeRelease() path — the drain loop must survive a mid-loop throw,
  // so the SECOND held entry behind the first is released too (an unguarded loop
  // aborts after the first shift(), stranding the rest of held[] forever).
  it("T-lg(b): a throwing state listener does not abort the held drain; every held entry releases", async () => {
    const h = await connectWrapper();
    deliverOut(h.K, { type: "typing" }); // turn in flight → both sends hold
    await settle();
    const r1 = h.wrapper.send("held-1")!;
    const r2 = h.wrapper.send("held-2")!;
    expect(r1.snapshot().state).toBe("queued");
    expect(r2.snapshot().state).toBe("queued");

    h.wrapper.subscribe(() => { throw new Error("embedder render bug"); });

    const before = h.received.length;
    deliverOut(h.K, { type: "turn_settled", turnId: "T" }); // → release drain
    await settle();

    expect(h.received.length).toBe(before + 2); // BOTH published, loop not aborted
    for (const text of ["held-1", "held-2"]) {
      const m = userBubble(h.wrapper, text)!;
      expect(m.wireId).toBeDefined();
      expect(h.received).toContain(m.wireId);
    }
    expect(r1.snapshot().state).not.toBe("queued");
    expect(r2.snapshot().state).not.toBe("queued");
    expect((h.wrapper as unknown as { held: unknown[] }).held).toHaveLength(0);
    h.wrapper.close();
  });
});

// ---------------------------------------------------------------------------
// T-cx: the register-before-send window's OTHER vector — a send registered onto
// an explicitly-CLOSED instance must not strand at `queued`. `close()` returns
// normally (never throws), so the setState try/catch guard (T-lg) does NOT cover
// it; a connection-scoped `disconnected` gate in the low level fails the send
// `failed{closed}` so the receipt AND bubble reach a terminal state. Covers the
// re-entrant close()-mid-render race (publish + held-release) and a plain send()
// after close(). Companion invariant test to T-lg.
// ---------------------------------------------------------------------------
describe("WebChannelNATSClient — P0-4 send onto a closed instance (T-cx)", () => {
  // T-cx(a): a state subscriber that close()s during publish()'s render — before
  // sendUserMessage runs — must still land the send at failed{closed}, not queued.
  it("T-cx(a): close() from a state subscriber mid-publish fails that send failed{closed}", async () => {
    const h = await connectWrapper();
    let closedOnce = false;
    h.wrapper.subscribe((s) => {
      if (!closedOnce && s.messages.some((m) => m.role === "user" && m.text === "boom")) {
        closedOnce = true;
        h.wrapper.close(); // → disconnect() before this send's sendUserMessage runs
      }
    });
    const receipt = h.wrapper.send("boom")!;
    await settle();
    expect(closedOnce).toBe(true);
    expect(receipt.snapshot()).toMatchObject({ state: "failed", failure: { reason: "closed", retryable: false } });
    const bubble = userBubble(h.wrapper, "boom")!;
    expect(bubble.sendState).toBe("failed");
    expect(bubble.sendFailure).toMatchObject({ reason: "closed", retryable: false });
  });

  // T-cx(b): the held-release path — a subscriber that close()s while a held
  // message is being released (the entry already shifted off held[], the bubble
  // moved to the tail) must fail that released send failed{closed}, not queued.
  it("T-cx(b): close() from a subscriber mid-release fails the released send failed{closed}", async () => {
    const h = await connectWrapper();
    deliverOut(h.K, { type: "typing" }); // turn in flight → the next send holds
    await settle();
    const receipt = h.wrapper.send("held-boom")!;
    expect(receipt.snapshot().state).toBe("queued");

    let closedOnce = false;
    h.wrapper.subscribe((s) => {
      // Fires when release moves the held bubble to the tail (pending flipped off),
      // synchronously BEFORE its sendUserMessage — close() here wins the race.
      if (!closedOnce && s.messages.some((m) => m.text === "held-boom" && m.pending !== true)) {
        closedOnce = true;
        h.wrapper.close();
      }
    });

    deliverOut(h.K, { type: "turn_settled", turnId: "T" }); // settle → release drain
    await settle();
    expect(closedOnce).toBe(true);
    expect(receipt.snapshot()).toMatchObject({ state: "failed", failure: { reason: "closed", retryable: false } });
    const bubble = userBubble(h.wrapper, "held-boom")!;
    expect(bubble.sendState).toBe("failed");
    expect(bubble.sendFailure).toMatchObject({ reason: "closed", retryable: false });
  });

  // T-cx(c): a plain send() AFTER close() — no re-entrancy — must fail failed{closed}
  // immediately, never stuck at queued on the dead instance.
  it("T-cx(c): a plain send() after close() fails failed{closed}, never stuck queued", async () => {
    const h = await connectWrapper();
    h.wrapper.close();
    const receipt = h.wrapper.send("after-close")!;
    expect(receipt.snapshot().state).not.toBe("queued");
    expect(receipt.snapshot()).toMatchObject({ state: "failed", failure: { reason: "closed", retryable: false } });
    const bubble = userBubble(h.wrapper, "after-close")!;
    expect(bubble.sendState).toBe("failed");
    expect(bubble.sendFailure).toMatchObject({ reason: "closed", retryable: false });
  });

  // T-cx(d): the hold path. close() does NOT settle a live `working` draft (only
  // the terminal path does) and it clears the staleness valve, so turnInFlight()
  // stays true forever afterwards. Without the wrapper's `closed` gate the send
  // is pushed into held[], whose only drain is onSession — never fired again on a
  // closed instance — and the receipt is stranded at `queued`.
  it("T-cx(d): send() after close() with a live working draft fails failed{closed}, never held", async () => {
    const h = await connectWrapper();
    deliverOut(h.K, { type: "progress", id: "webchannel-d", text: "partial…", turnId: "T" });
    await settle();
    expect(h.wrapper.getState().messages.some((m) => m.working)).toBe(true); // turn in flight

    h.wrapper.close();
    const receipt = h.wrapper.send("after-close-midturn")!;
    await settle();
    expect(receipt.snapshot()).toMatchObject({ state: "failed", failure: { reason: "closed", retryable: false } });
    const bubble = userBubble(h.wrapper, "after-close-midturn")!;
    expect(bubble.sendState).toBe("failed");
    expect(bubble.pending).not.toBe(true);
  });

  // T-cx(e): the `closed` gate is scoped to the closed window only — an ordinary
  // in-flight turn on an OPEN instance still holds (queued) as P1-9 §3.1 requires.
  it("T-cx(e): with no close(), a send during a live turn still holds at queued", async () => {
    const h = await connectWrapper();
    deliverOut(h.K, { type: "typing" });
    await settle();
    const receipt = h.wrapper.send("still-held")!;
    await settle();
    expect(receipt.snapshot().state).toBe("queued");
    expect(userBubble(h.wrapper, "still-held")!.pending).toBe(true);
    h.wrapper.close();
  });

  // T-cx(f): `closed` is connection-scoped, not permanent — after close() →
  // connect() the hold behaviour is restored.
  it("T-cx(f): close() then connect() restores holding", async () => {
    const h = await connectWrapper();
    h.wrapper.close();
    h.wrapper.connect();
    await settle();
    deliverOut(h.K, { type: "typing" });
    await settle();
    const receipt = h.wrapper.send("re-held")!;
    await settle();
    expect(receipt.snapshot().state).toBe("queued");
    expect(userBubble(h.wrapper, "re-held")!.pending).toBe(true);
    h.wrapper.close();
  });
});

// ---------------------------------------------------------------------------
// P0-4 (review R1) — F1: a teardown from a state subscriber DURING the
// `flushQueue()` drain. Each `seal()` publishes synchronously and notifies the
// embedder mid-loop; with the old snapshot-and-clear drain the not-yet-sealed
// remainder was invisible to `failAllPending()`/`markTerminalAndSweep`, so it
// was re-queued onto a dead instance and stranded at `queued` forever. Driven
// entirely through the public API (pre-connect sends + a plain `subscribe()`).
// ---------------------------------------------------------------------------
describe("WebChannelNATSClient — P0-4 mid-flush teardown (F1)", () => {
  /** Queue `texts` pre-connect and return their receipts (all at `queued`). */
  async function queuedBatch(h: Setup, texts: string[]) {
    const receipts = texts.map((t) => h.wrapper.send(t)!);
    expect(receipts.map((r) => r.snapshot().state)).toEqual(texts.map(() => "queued"));
    return receipts;
  }
  const states = (rs: Array<{ snapshot: () => { state?: string } }>) => rs.map((r) => r.snapshot().state);

  // F1(a): close() from a subscriber mid-drain — every receipt must end terminal.
  it("F1(a): close() during the flush drain leaves NO send stuck at queued", async () => {
    const h = await connectWrapper({ ack: false }, { connect: false });
    const receipts = await queuedBatch(h, ["m1", "m2", "m3"]);

    let closedOnce = false;
    h.wrapper.subscribe((s) => {
      // Fires as soon as the first drained frame leaves `queued` (→ "sent"),
      // i.e. synchronously inside the drain loop, before m2/m3 are sealed.
      if (closedOnce) return;
      const m1 = s.messages.find((m) => m.text === "m1");
      if (m1?.sendState && m1.sendState !== "queued") {
        closedOnce = true;
        h.wrapper.close();
      }
    });

    h.wrapper.connect();
    await settle();
    expect(closedOnce).toBe(true);
    expect(states(receipts)).toEqual(["failed", "failed", "failed"]);
    for (const r of receipts) {
      expect(r.snapshot()).toMatchObject({ failure: { reason: "closed", retryable: false } });
    }
  });

  // F1(b): the terminal twin — a genuine -ERR emitted from the subscriber mid-drain
  // (synchronously reachable: the literal goes straight onto the socket's protocol
  // stream). The remainder must be swept to failed{terminal}, not stranded.
  it("F1(b): a terminal failure during the flush drain leaves NO send stuck at queued", async () => {
    const h = await connectWrapper({ ack: false }, { connect: false });
    const receipts = await queuedBatch(h, ["t1", "t2", "t3"]);

    let firedOnce = false;
    h.wrapper.subscribe((s) => {
      if (firedOnce) return;
      const t1 = s.messages.find((m) => m.text === "t1");
      if (t1?.sendState && t1.sendState !== "queued") {
        firedOnce = true;
        FakeNatsWS.instances.at(-1)!.onmessage?.({ data: "-ERR 'Authorization Violation'\r\n" });
      }
    });

    h.wrapper.connect();
    await settle();
    expect(firedOnce).toBe(true);
    expect(states(receipts)).toEqual(["failed", "failed", "failed"]);
    for (const r of receipts) {
      expect(r.snapshot()).toMatchObject({ failure: { reason: "terminal", retryable: false } });
    }
    expect(h.wrapper.getState().status).toBe("error");
  });

  // F1(c): control — with no teardown, the live drain still publishes the whole
  // batch in FIFO order and every receipt advances past `queued`.
  it("F1(c): an undisturbed flush publishes every frame in FIFO order", async () => {
    const h = await connectWrapper({ ack: true }, { connect: false });
    const receipts = await queuedBatch(h, ["f1", "f2", "f3"]);

    h.wrapper.connect();
    await settle();
    expect(states(receipts)).toEqual(["accepted", "accepted", "accepted"]);
    // `received` records the server-side arrival order of the sealed user_messages.
    const wireIds = ["f1", "f2", "f3"].map((t) => userBubble(h.wrapper, t)!.wireId!);
    expect(h.received).toEqual(wireIds);
    h.wrapper.close();
  });
});

// ---------------------------------------------------------------------------
// P0-4 (review R2) — F-A: unacked-ledger EVICTION notifies the embedder, and B3
// moved that notification from a console.warn into a real `trackerFail`. Firing
// it from inside `seal()`'s critical section let a subscriber's `close()` null
// `sessionKey` between the fail-closed check and `sealMessage()`, so `null` flowed
// into the AEAD and `send()` threw a raw crypto TypeError — no receipt returned
// at all. The notification is now deferred to the end of `seal()`.
// ---------------------------------------------------------------------------
describe("WebChannelNATSClient — P0-4 eviction callout vs. the seal (F-A)", () => {
  // The ledger cap is a private constant; 101 unacked sends is the first size
  // that evicts. Keep in sync with `MAX_UNACKED` in nats-client.ts.
  const CAP = 100;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => { errSpy.mockRestore(); warnSpy.mockRestore(); });

  /** Send `n` messages, capturing any synchronous throw instead of failing fast. */
  function sendBurst(w: WebChannelNATSClient, n: number, prefix: string) {
    const receipts: Array<ReturnType<WebChannelNATSClient["send"]>> = [];
    const throws: Array<{ i: number; err: unknown }> = [];
    for (let i = 0; i < n; i++) {
      try {
        receipts.push(w.send(`${prefix}${i}`));
      } catch (err) {
        throws.push({ i, err });
        receipts.push(undefined);
      }
    }
    return { receipts, throws };
  }
  const stateOf = (r: ReturnType<WebChannelNATSClient["send"]>) => r?.snapshot().state;

  // F-A(a): live session. A subscriber closes on the first failed{evicted} — which
  // fires from inside the 101st seal. send() must not throw and nothing may strand.
  it("F-A(a): close() from an eviction subscriber never throws out of send(); no receipt stays queued", async () => {
    const h = await connectWrapper({ ack: false }); // never acked → the ledger fills
    let closedOnce = false;
    h.wrapper.subscribe((s) => {
      if (closedOnce) return;
      if (s.messages.some((m) => m.sendFailure?.reason === "evicted")) {
        closedOnce = true;
        h.wrapper.close();
      }
    });

    const { receipts, throws } = sendBurst(h.wrapper, CAP + 2, "ev-");
    await settle();

    expect(throws).toEqual([]); // no raw crypto TypeError escaping send()
    expect(receipts.every((r) => r !== undefined)).toBe(true);
    expect(closedOnce).toBe(true);
    const stuck = receipts.filter((r) => stateOf(r) !== "failed").length;
    expect(stuck).toBe(0);
    expect(stateOf(receipts[0])).toBe("failed");
    expect(receipts[0]!.snapshot().failure).toMatchObject({ reason: "evicted", retryable: true });
    // The message whose own seal triggered the eviction was recorded in the ledger
    // BEFORE the sweep, so close() reaches it — failed{closed}, never stranded.
    expect(receipts[CAP]!.snapshot().failure).toMatchObject({ reason: "closed" });
  });

  // F-A(b): the same teardown during the pre-connect `flushQueue()` drain, where
  // the throw used to escape `onConnected` as an unhandled rejection, abandon the
  // rest of the drain, and skip notifySessionListeners.
  it("F-A(b): close() from an eviction subscriber mid-flush leaves no unhandled rejection and no stuck send", async () => {
    const h = await connectWrapper({ ack: false }, { connect: false });
    const unhandled: unknown[] = [];
    const onUnhandled = (err: unknown) => unhandled.push(err);
    process.on("unhandledRejection", onUnhandled);
    try {
      const { receipts, throws } = sendBurst(h.wrapper, CAP + 5, "fq-");
      expect(throws).toEqual([]); // queued pre-connect: nothing seals yet

      let closedOnce = false;
      h.wrapper.subscribe((s) => {
        if (closedOnce) return;
        if (s.messages.some((m) => m.sendFailure?.reason === "evicted")) {
          closedOnce = true;
          h.wrapper.close();
        }
      });

      h.wrapper.connect();
      await settle();

      expect(closedOnce).toBe(true);
      expect(unhandled).toEqual([]);
      expect(receipts.filter((r) => stateOf(r) !== "failed").length).toBe(0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  // F-A(c): control — an ordinary eviction with no teardown still reports
  // failed{evicted, retryable:true} and leaves the triggering send at `sent`.
  it("F-A(c): an undisturbed eviction fails the oldest as evicted and does not disturb the live send", async () => {
    const h = await connectWrapper({ ack: false });
    const { receipts, throws } = sendBurst(h.wrapper, CAP + 1, "ok-");
    await settle();

    expect(throws).toEqual([]);
    expect(receipts[0]!.snapshot()).toMatchObject({
      state: "failed", failure: { reason: "evicted", retryable: true },
    });
    // The send whose seal evicted it published normally.
    expect(stateOf(receipts[CAP])).toBe("sent");
    // Everything between the evicted head and the tail is still in the ledger.
    expect(stateOf(receipts[1])).toBe("sent");
    h.wrapper.close();
  });
});

// ---------------------------------------------------------------------------
// P0-4 (review R3) — R3-1: the teardown paths must COMPLETE before they notify.
// Both `close()` and the low-level `disconnect()` used to fire their failure
// sweeps and only then tear the socket down, so an embedder reacting to a failed
// send by calling `connect()` (an ordinary auto-reconnect reflex) dialed from
// inside the sweep and the trailing teardown killed that dial — leaving the gates
// saying "open" with no socket, where a later send held forever (`close()` leaves
// `working` drafts live, and `onSession` never fires again to drain held[]).
// ---------------------------------------------------------------------------
describe("WebChannelNATSClient — P0-4 teardown-then-notify (R3-1)", () => {
  /** The three flags that must agree: wrapper gate, low-level gate, live socket. */
  function coherence(w: WebChannelNATSClient) {
    const wrapperClosed = (w as unknown as { closed: boolean }).closed;
    const mid = (w as unknown as { client: { disconnected: boolean; client: { ws: unknown } } }).client;
    return { wrapperClosed, lowLevelDisconnected: mid.disconnected, hasSocket: mid.client.ws !== null };
  }

  // R3-1(a): connect() re-entered from close()'s held sweep. The embedder's
  // reconnect is honored, the instance ends coherently OPEN, and a later send
  // actually reaches the wire instead of sitting in held[] forever.
  it("R3-1(a): connect() from close()'s notification leaves a coherent live instance; a later send is not stuck", async () => {
    const h = await connectWrapper({ ack: false });
    // A live `working` draft: close() does NOT settle it, so turnInFlight() stays
    // true — this is what made the stranded send permanent.
    deliverOut(h.K, { type: "progress", id: "webchannel-d", text: "partial…", turnId: "T" });
    await settle();
    h.wrapper.send("held-one"); // → held[]
    expect(h.wrapper.getState().messages.some((m) => m.pending)).toBe(true);

    let reconnected = false;
    h.wrapper.subscribe((s) => {
      if (reconnected) return;
      if (s.messages.some((m) => m.sendState === "failed")) {
        reconnected = true;
        h.wrapper.connect(); // the embedder's auto-reconnect reflex
      }
    });

    h.wrapper.close();
    await settle();
    expect(reconnected).toBe(true);

    // Coherent: the re-entrant connect() won, and nothing tore it back down.
    expect(coherence(h.wrapper)).toEqual({
      wrapperClosed: false, lowLevelDisconnected: false, hasSocket: true,
    });

    // A send now still HOLDS — the pre-close `working` draft is untouched, so a
    // turn is legitimately in flight (P1-9 §3.1). The point is that the hold is
    // DRAINABLE on this live instance: settling the turn releases it to the wire.
    // Under the old ordering the instance had no socket, so nothing could ever
    // release it and this receipt stayed `queued` forever.
    const before = h.received.length;
    const late = h.wrapper.send("after-reconnect")!;
    await settle();
    expect(late.snapshot().state).toBe("queued");
    deliverOut(h.K, { type: "turn_settled", turnId: "T" });
    await settle();
    expect(late.snapshot().state).not.toBe("queued");
    expect(h.received.length).toBe(before + 1); // it really went to the wire
    h.wrapper.close();
  });

  // R3-1(b): the low-level twin — connect() re-entered from the `failAllPending`
  // sweep inside disconnect(). Driven by an unacked (ledgered) send so the sweep
  // has something to notify about, with no held[] involved.
  it("R3-1(b): connect() from the low-level disconnect sweep leaves a coherent live instance", async () => {
    const h = await connectWrapper({ ack: false });
    const unacked = h.wrapper.send("unacked")!;
    await settle();
    expect(unacked.snapshot().state).toBe("sent"); // in the ledger, not held[]

    let reconnected = false;
    h.wrapper.subscribe((s) => {
      if (reconnected) return;
      if (s.messages.some((m) => m.sendFailure?.reason === "closed")) {
        reconnected = true;
        h.wrapper.connect();
      }
    });

    h.wrapper.close();
    await settle();
    expect(reconnected).toBe(true);
    expect(unacked.snapshot()).toMatchObject({ state: "failed", failure: { reason: "closed" } });
    expect(coherence(h.wrapper)).toEqual({
      wrapperClosed: false, lowLevelDisconnected: false, hasSocket: true,
    });

    const before = h.received.length;
    const late = h.wrapper.send("late")!;
    await settle();
    expect(late.snapshot().state).not.toBe("queued");
    expect(h.received.length).toBe(before + 1);
    h.wrapper.close();
  });

  it("preserves a fresh no-draft send created by a synchronous reconnecting listener", async () => {
    const h = await connectWrapper({ ack: false });
    const old = h.wrapper.send("old-unacked")!;
    await settle();
    expect(old.snapshot().state).toBe("sent");

    let replacement: ReturnType<WebChannelNATSClient["send"]>;
    let reopened = false;
    const unsubscribe = h.wrapper.subscribe((state) => {
      if (reopened || state.status !== "reconnecting") return;
      reopened = true;
      h.wrapper.connect();
      replacement = h.wrapper.send("fresh-after-close");
    });

    h.wrapper.close();
    expect(reopened).toBe(true);
    expect(old.snapshot()).toMatchObject({ state: "failed", failure: { reason: "closed" } });
    expect(replacement!.snapshot().state).toBe("queued");
    await settle();
    expect(replacement!.snapshot().state).toBe("sent");
    expect(userBubble(h.wrapper, "fresh-after-close")?.wireId).toBeDefined();
    expect(h.received).toContain(userBubble(h.wrapper, "fresh-after-close")!.wireId!);
    expect(replacement!.snapshot().failure).toBeUndefined();

    unsubscribe();
    h.wrapper.close();
  });

  it("preserves a fresh held entry created while close notifies reconnecting state", async () => {
    const h = await connectWrapper();
    deliverOut(h.K, { type: "progress", id: "webchannel-d", text: "working", turnId: "T" });
    await settle();
    const oldHeld = h.wrapper.send("old-held")!;
    expect(oldHeld.snapshot().state).toBe("queued");

    let freshHeld: ReturnType<WebChannelNATSClient["send"]>;
    let reopened = false;
    const unsubscribe = h.wrapper.subscribe((state) => {
      if (reopened || state.status !== "reconnecting") return;
      reopened = true;
      h.wrapper.connect();
      freshHeld = h.wrapper.send("fresh-held-after-close");
    });

    h.wrapper.close();
    await settle();
    expect(reopened).toBe(true);
    expect(oldHeld.snapshot()).toMatchObject({ state: "failed", failure: { reason: "closed" } });
    expect(freshHeld!.snapshot().state).toBe("queued");
    expect(userBubble(h.wrapper, "fresh-held-after-close")?.pending).toBe(true);
    expect((h.wrapper as unknown as { held: Array<{ text: string }> }).held.map((entry) => entry.text))
      .toEqual(["fresh-held-after-close"]);

    // The replacement connection has a session, but the working draft correctly
    // keeps the fresh hold queued until its turn settles.
    deliverOut(h.K, { type: "turn_settled", turnId: "T" });
    await settle();
    expect(freshHeld!.snapshot().state).toBe("accepted");
    expect(userBubble(h.wrapper, "fresh-held-after-close")?.pending).not.toBe(true);

    unsubscribe();
    h.wrapper.close();
  });

  // R3-1(c): controls — the reorder must not change the non-re-entrant paths.
  it("R3-1(c): a plain close() and a sequential close()→connect() behave as before", async () => {
    const h = await connectWrapper({ ack: false });
    deliverOut(h.K, { type: "progress", id: "webchannel-d", text: "partial…", turnId: "T" });
    await settle();
    const held = h.wrapper.send("held-plain")!;
    h.wrapper.send("unacked-plain");
    await settle();

    h.wrapper.close();
    await settle();
    // Both receipt groups still fail{closed}; the instance ends fully closed.
    expect(held.snapshot()).toMatchObject({ state: "failed", failure: { reason: "closed" } });
    expect(userBubble(h.wrapper, "unacked-plain")!.sendFailure).toMatchObject({ reason: "closed" });
    expect((h.wrapper as unknown as { held: unknown[] }).held).toHaveLength(0);
    expect(coherence(h.wrapper)).toEqual({
      wrapperClosed: true, lowLevelDisconnected: true, hasSocket: false,
    });

    // Sequential reopen: gates clear, socket returns, holding is restored.
    h.wrapper.connect();
    await settle();
    expect(coherence(h.wrapper)).toEqual({
      wrapperClosed: false, lowLevelDisconnected: false, hasSocket: true,
    });
    deliverOut(h.K, { type: "typing" });
    await settle();
    expect(h.wrapper.send("re-held")!.snapshot().state).toBe("queued"); // holds again
    h.wrapper.close();
  });
});

// ---------------------------------------------------------------------------
// P0-4 (R3): a CL2 terminal instance is PERMANENTLY retired — a registration-path
// terminal (only the WCNC latch set; the raw transport is NOT terminal) must not
// let a later public connect() flip the sticky "error" to "connected" while every
// send still immediate-fails. Driven entirely through public API + a real
// register round-trip (mismatched protocolVersion reply).
// ---------------------------------------------------------------------------
describe("WebChannelNATSClient — P0-4 permanent terminal retirement", () => {
  async function makeWithMismatchedRegister(): Promise<{
    wrapper: WebChannelNATSClient;
    K: Uint8Array;
    devicePublicRaw: Uint8Array;
    identity: ReturnType<typeof makeAgentIdentity>;
  }> {
    const pop = await generateDevicePopKeyPair();
    const x = await generateDeviceX25519();
    const identity = makeAgentIdentity();
    const K = new Uint8Array(32).fill(9);
    // Real register round-trip whose reply carries an incompatible protocolVersion
    // → onConnected goes terminal (protocol-mismatch) via the production path.
    FakeNatsWS.sharedHandler = registerAgent(K, x.publicRaw, identity, {
      versions: { protocolVersion: WEBCHANNEL_PROTOCOL_VERSION + 1 },
    });
    const wrapper = new WebChannelNATSClient({
      natsUrl: "ws://127.0.0.1:4222",
      bootstrapJwt: JWT,
      accountId: AGENT,
      tenant: TENANT,
      peerId: PEER,
      heartbeatIntervalMs: 0,
      registration: {
        devicePrivateKey: pop.privateKey,
        deviceX25519PrivateKey: x.privateKey,
        pinnedAgentPublicKey: identity.publicB64url,
      },
    });
    return { wrapper, K, devicePublicRaw: x.publicRaw, identity };
  }
  const sessionEstablishedOf = (w: WebChannelNATSClient) =>
    (w as unknown as { sessionEstablished: boolean }).sessionEstablished;
  const staleWatchOf = (w: WebChannelNATSClient) =>
    (w as unknown as { staleDraftWatch: Set<string>; staleDraftTimer: unknown });
  const sessionKeyOf = (w: WebChannelNATSClient) =>
    (w as unknown as { client: { sessionKey: unknown } }).client.sessionKey;

  it("stays 'error' across a later connect(); sends immediate-fail; status never leaves error", async () => {
    const { wrapper: w } = await makeWithMismatchedRegister();
    const statuses: string[] = [];
    w.subscribe((s) => statuses.push(s.status));

    w.connect();
    await settle();
    expect(w.getState().status).toBe("error");
    expect(w.getState().errorCause).toBe("protocol-mismatch");

    // Explicit reconnect: the raw transport redials and emits `connected:true`,
    // but the sticky terminal status must NOT be revived.
    w.connect();
    await settle();
    expect(w.getState().status).toBe("error");
    expect(w.getState().errorCause).toBe("protocol-mismatch");

    // A send on the retired instance resolves immediately to failed{terminal}.
    const receipt = w.send("after terminal");
    expect(receipt?.snapshot()).toMatchObject({
      state: "failed",
      failure: { reason: "terminal", cause: "protocol-mismatch", retryable: false },
    });

    // No flicker: from the first "error" onward, status is only ever "error".
    const firstError = statuses.indexOf("error");
    expect(firstError).toBeGreaterThanOrEqual(0);
    expect(statuses.slice(firstError).every((s) => s === "error")).toBe(true);
    w.close();
  });

  // R4 root fix: even a later connect() whose register WOULD succeed must not
  // re-establish a session on a retired instance — onConnected early-returns on
  // terminalReached, so onSession never fires (no sessionEstablished, no key, no
  // staleness valve).
  it("a later connect() that would complete registration does NOT establish a session", async () => {
    const h = await makeWithMismatchedRegister();
    h.wrapper.connect();
    await settle();
    expect(h.wrapper.getState().status).toBe("error");

    // Swap in a fully VALID register handler — if onConnected ran it would unwrap
    // K and fire onSession. Reconnect and prove it does not.
    FakeNatsWS.sharedHandler = registerAgent(h.K, h.devicePublicRaw, h.identity);
    h.wrapper.connect();
    await settle();

    expect(sessionEstablishedOf(h.wrapper)).toBe(false);
    expect(sessionKeyOf(h.wrapper)).toBeFalsy();
    expect(staleWatchOf(h.wrapper).staleDraftWatch.size).toBe(0);
    expect(staleWatchOf(h.wrapper).staleDraftTimer).toBeNull();
    expect(h.wrapper.getState().status).toBe("error");
    h.wrapper.close();
  });

  // R5: connect() on a retired instance dials NO new socket at all.
  it("connect() on a retired instance dials no new socket", async () => {
    const h = await makeWithMismatchedRegister();
    h.wrapper.connect();
    await settle();
    expect(h.wrapper.getState().status).toBe("error");

    const before = FakeNatsWS.instances.length;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    h.wrapper.connect(); // retired → ignored
    await settle();
    expect(FakeNatsWS.instances.length).toBe(before); // no socket dialed
    expect(warn.mock.calls.some((c) => String(c[0]).includes("terminally retired"))).toBe(true);
    warn.mockRestore();
    h.wrapper.close();
  });

  // R5 race branch: if a socket dialed before the latch reaches onConnected on a
  // retired instance (e.g. a scheduled low-level reconnect firing), it is torn
  // down and NO reconnect timer is armed after its close.
  it("a socket reaching onConnected on a retired instance is torn down with no reconnect", async () => {
    const h = await makeWithMismatchedRegister();
    h.wrapper.connect();
    await settle();
    expect(h.wrapper.getState().status).toBe("error"); // terminalReached is set

    // Simulate the race by dialing the raw transport directly (its own `terminal`
    // flag is false on a registration-path terminal, so it WOULD open).
    const lowLevel = (h.wrapper as unknown as {
      client: { client: { connect: () => void; reconnectTimer: unknown } };
    }).client.client;
    lowLevel.connect();
    await settle();

    const raced = FakeNatsWS.instances[FakeNatsWS.instances.length - 1];
    expect(raced.readyState).toBe(FakeNatsWS.CLOSED); // guard tore it down
    expect(lowLevel.reconnectTimer).toBeNull(); // no reconnect armed
    h.wrapper.close();
  });
});

// ---------------------------------------------------------------------------
// P0-4 (R4): a terminal mid-turn must settle the live-turn UI (typing indicator
// AND any working draft) — the staleness valve only arms on a reconnect a retired
// instance never does. Driven through public paths: a real session, a real live
// frame, then a genuine `-ERR` terminal.
// ---------------------------------------------------------------------------
describe("WebChannelNATSClient — P0-4 terminal settles the live-turn UI", () => {
  it("terminal while typing clears isTyping (no eternal typing…)", async () => {
    const h = await connectWrapper();
    deliverOut(h.K, { type: "typing" });
    await settle();
    expect(h.wrapper.getState().isTyping).toBe(true);

    FakeNatsWS.instances.at(-1)!.onmessage?.({ data: "-ERR 'Authorization Violation'\r\n" });
    await settle();

    expect(h.wrapper.getState().status).toBe("error");
    expect(h.wrapper.getState().isTyping).toBe(false);
  });

  it("terminal while a working draft is live flips it working:false in place", async () => {
    const h = await connectWrapper();
    deliverOut(h.K, { type: "progress", id: "webchannel-d", text: "partial…", turnId: "T" });
    await settle();
    expect(h.wrapper.getState().messages.find((m) => m.id === "webchannel-d")?.working).toBe(true);

    FakeNatsWS.instances.at(-1)!.onmessage?.({ data: "-ERR 'Authorization Violation'\r\n" });
    await settle();

    expect(h.wrapper.getState().status).toBe("error");
    const draft = h.wrapper.getState().messages.find((m) => m.id === "webchannel-d")!;
    expect(draft.working).toBe(false); // settled in place
    expect(draft.text).toBe("partial…"); // text untouched
  });
});

// ---------------------------------------------------------------------------
// T-sl: the additive turn_settled.outcome survives an envelope seal→open
// round-trip (AAD is routing-only; the outcome rides inside the ciphertext).
// ---------------------------------------------------------------------------
describe("P0-4 turn_settled.outcome sealing (T-sl)", () => {
  it("preserves outcome through a sealed-envelope round-trip", () => {
    const K = new Uint8Array(32).fill(3);
    for (const outcome of ["ok", "error"] as const) {
      const wire = sealMessage({ accountId: AGENT, tenant: TENANT, sub: PEER }, K, {
        type: "turn_settled",
        turnId: "t-1",
        outcome,
      });
      expect(openMessage(wire, K)).toEqual({ type: "turn_settled", turnId: "t-1", outcome });
    }
  });
});
