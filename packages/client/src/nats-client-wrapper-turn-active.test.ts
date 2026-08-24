import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebChannelNATSClient } from "./nats-client-wrapper.js";
import {
  WebChannelNatsClient,
  inboundSubject,
  outboundSubject,
  type NatsClientOptions,
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

// ---------------------------------------------------------------------------
// #96 — `state.turnActive`: a client-side, TURN-SCOPED "this turn is still open"
// signal.
//
// The defect: the plugin emits ONE `typing` frame per turn and the client clears
// `isTyping` on the first agent output, so after the first bubble settles a
// multi-step turn (more tool calls, a second assistant message, an approval
// wait) presents as answer → silence → another answer, with NO in-flight signal
// in client state at all. `turnActive` is that missing input: open from the
// publish that starts the turn until that turn settles (or a safety point
// closes it).
//
// It is ADVISORY — it must never influence send/hold/release/receipts/reconnect,
// so the P1-9 hold behavior is asserted unchanged here as a tripwire.
// ---------------------------------------------------------------------------

const IN = inboundSubject(TENANT, AGENT, PEER);
const OUT = outboundSubject(TENANT, AGENT, PEER);

let restore: () => void;
beforeEach(() => { restore = installFakeWebSocket(); });
afterEach(() => { vi.useRealTimers(); restore(); });

type Setup = {
  wrapper: WebChannelNATSClient;
  K: Uint8Array;
  received: string[];
  /** Flip `.ack` mid-test to stop/resume acking (read per inbound frame). */
  control: { ack: boolean };
};

/**
 * The unacked-ledger cap, read from the class instead of duplicating the
 * literal — the eviction tests below must move with it, not silently stop
 * exercising eviction if it ever changes.
 */
const MAX_UNACKED = (WebChannelNatsClient as unknown as { MAX_UNACKED: number }).MAX_UNACKED;

/**
 * A registered wrapper over the fake socket; acks user_messages unless
 * `control.ack` is turned off (the ingress-failure cases below need no ack).
 *
 * The fake server ONLY acks — it never fabricates `turn_settled`. The current
 * dispatcher emits one same-outcome frame per coalesced member, in arrival order
 * with the LAST-id anchor last. Every test below delivers the frames it models
 * by hand; the one-frame prefix-sweep cases deliberately cover an older
 * anchor-only plugin or a missing earlier member frame.
 */
async function connectWrapper(
  control: { ack: boolean } = { ack: true },
  opts: { connect?: boolean } = {},
): Promise<Setup> {
  const pop = await generateDevicePopKeyPair();
  const x = await generateDeviceX25519();
  const identity: AgentIdentity = makeAgentIdentity();
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
    // Pin the reconnect backoff far beyond any `settle()` window. The default is
    // jittered (`Math.random()`), so a test that drops the socket would otherwise
    // race a redial + re-register against its own assertions.
    reconnectBaseMs: 60_000,
    reconnectCapMs: 60_000,
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
  return { wrapper, K, received, control };
}

const deliverOut = (K: Uint8Array, msg: Record<string, unknown>): void => {
  FakeNatsWS.instances.at(-1)!.deliverToClient(OUT, sealMessage({ accountId: AGENT, tenant: TENANT, sub: PEER }, K, msg as unknown as OutboundMessage));
};
const wireIdOf = (w: WebChannelNATSClient, text: string): string =>
  w.getState().messages.find((m) => m.role === "user" && m.text === text)!.wireId!;
const hasWorkingDraft = (w: WebChannelNATSClient): boolean =>
  w.getState().messages.some((m) => m.working === true);
const heldOf = (w: WebChannelNATSClient) =>
  (w as unknown as { held: Array<{ text: string; localId: string }> }).held;
/** White-box view of the open-turn set (the same idiom the P1-9 suites use for `held`). */
const openTurnsOf = (w: WebChannelNATSClient): Set<string> =>
  (w as unknown as { openTurns: Set<string> }).openTurns;

describe("WebChannelNATSClient — #96 turnActive (turn-scoped in-flight signal)", () => {
  it("a pre-connect queued send opens only after its first real publication", async () => {
    const h = await connectWrapper({ ack: false }, { connect: false });
    const receipt = h.wrapper.send("queued before connect")!;
    const wireId = wireIdOf(h.wrapper, "queued before connect");
    const publishedSnapshots: Array<{ sendState: string | undefined; turnActive: boolean | undefined }> = [];
    h.wrapper.subscribe((state) => {
      const bubble = state.messages.find((m) => m.wireId === wireId);
      if (bubble?.sendState === "sent") {
        publishedSnapshots.push({ sendState: bubble.sendState, turnActive: state.turnActive });
      }
    });

    expect(receipt.snapshot().state).toBe("queued");
    expect([...openTurnsOf(h.wrapper)]).toEqual([]);
    expect(h.wrapper.getState().turnActive).toBeUndefined();

    h.wrapper.connect();
    await settle();

    expect(h.received).toEqual([wireId]);
    expect(receipt.snapshot().state).toBe("sent");
    expect([...openTurnsOf(h.wrapper)]).toEqual([wireId]);
    expect(h.wrapper.getState().turnActive).toBe(true);
    expect(publishedSnapshots).toContainEqual({ sendState: "sent", turnActive: true });
    h.wrapper.close();
  });

  it("connect(); send() keeps a queued turn closed until publication", async () => {
    const h = await connectWrapper({ ack: true }, { connect: false });

    h.wrapper.connect();
    const receipt = h.wrapper.send("README sequence")!;
    const wireId = wireIdOf(h.wrapper, "README sequence");
    expect(receipt.snapshot().state).toBe("queued");
    expect([...openTurnsOf(h.wrapper)]).toEqual([]);
    expect(h.wrapper.getState().turnActive).toBeUndefined();

    await settle();
    expect(h.received).toEqual([wireId]);
    expect(receipt.snapshot().state).toBe("accepted");
    expect([...openTurnsOf(h.wrapper)]).toEqual([wireId]);
    expect(h.wrapper.getState().turnActive).toBe(true);
    h.wrapper.close();
  });

  // THE core defect: the gap after the first agent bubble settles.
  it("stays true after the first agent bubble settles (isTyping false, no working draft)", async () => {
    const h = await connectWrapper();
    expect(h.wrapper.getState().turnActive).toBeUndefined(); // absent before the first turn

    h.wrapper.send("do a multi-step thing");
    await settle();
    const turnId = wireIdOf(h.wrapper, "do a multi-step thing");
    expect(h.wrapper.getState().turnActive).toBe(true); // open at publish

    deliverOut(h.K, { type: "typing" });
    await settle();
    expect(h.wrapper.getState().isTyping).toBe(true);
    expect(h.wrapper.getState().turnActive).toBe(true);

    deliverOut(h.K, { type: "progress", id: "webchannel-d1", text: "reading files…", turnId });
    await settle();
    expect(h.wrapper.getState().isTyping).toBe(false); // typing already gone
    expect(h.wrapper.getState().turnActive).toBe(true);

    // The first bubble settles: today this is the point where EVERY in-flight
    // signal vanished, and the rest of the turn looked like completion.
    deliverOut(h.K, { type: "agent_message", id: "webchannel-d1", text: "here is step one", turnId });
    await settle();
    expect(h.wrapper.getState().isTyping).toBe(false);
    expect(hasWorkingDraft(h.wrapper)).toBe(false);
    expect(h.wrapper.getState().turnActive).toBe(true); // ← the whole point of #96

    // A second bubble later in the SAME turn keeps it open too.
    deliverOut(h.K, { type: "agent_message", id: "webchannel-d2", text: "and step two", turnId });
    await settle();
    expect(h.wrapper.getState().turnActive).toBe(true);

    h.wrapper.close();
  });

  it("turn_settled{ok} closes the turn", async () => {
    const h = await connectWrapper();
    h.wrapper.send("hello");
    await settle();
    const turnId = wireIdOf(h.wrapper, "hello");
    deliverOut(h.K, { type: "agent_message", text: "hi", turnId });
    await settle();
    expect(h.wrapper.getState().turnActive).toBe(true);

    deliverOut(h.K, { type: "turn_settled", turnId, outcome: "ok" });
    await settle();
    expect(h.wrapper.getState().turnActive).toBe(false);
    h.wrapper.close();
  });

  it("turn_settled{error} closes the turn", async () => {
    const h = await connectWrapper();
    h.wrapper.send("boom");
    await settle();
    deliverOut(h.K, { type: "turn_settled", turnId: wireIdOf(h.wrapper, "boom"), outcome: "error" });
    await settle();
    expect(h.wrapper.getState().turnActive).toBe(false);
    h.wrapper.close();
  });

  // A legacy plugin fires turn_settled from a `finally` with NO outcome. The
  // settlement is what ends the turn — the outcome only drives the send receipt.
  it("a legacy turn_settled with NO outcome still closes the turn", async () => {
    const h = await connectWrapper();
    h.wrapper.send("legacy");
    await settle();
    const bubble = () => h.wrapper.getState().messages.find((m) => m.text === "legacy")!;
    deliverOut(h.K, { type: "turn_settled", turnId: bubble().wireId! });
    await settle();
    expect(h.wrapper.getState().turnActive).toBe(false);
    expect(bubble().sendState).toBe("accepted"); // no fabricated `completed` (P0-4)
    h.wrapper.close();
  });

  // An approval wait is NOT the end of a turn — the agent is blocked on the
  // user, so `isTyping` goes false (unchanged) while `turnActive` stays true and
  // the widget renders the approval card with render priority.
  it("an approval mid-turn clears isTyping but keeps the turn active", async () => {
    const h = await connectWrapper();
    h.wrapper.send("run something");
    await settle();
    deliverOut(h.K, { type: "typing" });
    await settle();
    expect(h.wrapper.getState().isTyping).toBe(true);

    deliverOut(h.K, {
      type: "approval_request",
      id: "ap-1",
      kind: "exec",
      title: "Run",
      prompt: "rm -rf /tmp/x",
      options: [{ decision: "allow-once", label: "Allow", style: "success" }],
    });
    await settle();
    expect(h.wrapper.getState().isTyping).toBe(false); // unchanged behavior
    expect(h.wrapper.getState().approvals).toHaveLength(1);
    expect(h.wrapper.getState().turnActive).toBe(true); // the turn has NOT ended

    // Deciding it does not end the turn either — only turn_settled does.
    h.wrapper.decide("ap-1", "allow-once");
    deliverOut(h.K, { type: "approval_resolved", id: "ap-1", decision: "allow-once" });
    await settle();
    expect(h.wrapper.getState().turnActive).toBe(true);
    h.wrapper.close();
  });

  // Compatibility/fallback: an older plugin emits only the LAST-id anchor for a
  // coalesced turn, or the current plugin's earlier member frame is lost. The
  // later anchor must still sweep the prefix so B is not orphaned.
  it("a legacy/missing-member anchor settle sweeps the coalesced prefix", async () => {
    const h = await connectWrapper();
    h.wrapper.send("A");
    await settle();
    const a = wireIdOf(h.wrapper, "A");

    // A's first bubble settles, so the hold predicate is quiet again and B and C
    // publish immediately — while the agent is still running turn A.
    deliverOut(h.K, { type: "agent_message", text: "A step one", turnId: a });
    await settle();
    h.wrapper.send("B");
    h.wrapper.send("C");
    await settle();
    const b = wireIdOf(h.wrapper, "B");
    const c = wireIdOf(h.wrapper, "C");
    expect(new Set([a, b, c]).size).toBe(3);
    expect([...openTurnsOf(h.wrapper)]).toEqual([a, b, c]);

    deliverOut(h.K, { type: "turn_settled", turnId: a, outcome: "ok" });
    await settle();
    expect(h.wrapper.getState().turnActive).toBe(true); // B+C still running
    expect([...openTurnsOf(h.wrapper)]).toEqual([b, c]);

    // Model either an older anchor-only producer or loss of B's current-plugin
    // member frame: only C's later anchor frame reaches this client. Without the
    // prefix sweep B would sit in the set forever (a permanent false spinner).
    deliverOut(h.K, { type: "turn_settled", turnId: c, outcome: "ok" });
    await settle();
    expect([...openTurnsOf(h.wrapper)]).toEqual([]);
    expect(h.wrapper.getState().turnActive).toBe(false);
    h.wrapper.close();
  });

  // Same legacy/missing-member fallback, but the coalesced turn THROWS. The
  // anchor's `turn_settled{error}` promotes its exact receipt to
  // failed{turn-failed}; that must not consume the settle's own id before the
  // prefix sweep runs, or every earlier wireId is stranded.
  it("a legacy/missing-member error settle sweeps the coalesced prefix too", async () => {
    const h = await connectWrapper();
    h.wrapper.send("A");
    await settle();
    const a = wireIdOf(h.wrapper, "A");
    deliverOut(h.K, { type: "agent_message", text: "A step one", turnId: a });
    await settle();
    h.wrapper.send("B");
    h.wrapper.send("C");
    await settle();
    const b = wireIdOf(h.wrapper, "B");
    const c = wireIdOf(h.wrapper, "C");
    expect([...openTurnsOf(h.wrapper)]).toEqual([a, b, c]);

    deliverOut(h.K, { type: "turn_settled", turnId: a, outcome: "ok" });
    await settle();
    expect([...openTurnsOf(h.wrapper)]).toEqual([b, c]);

    // B+C ran as one coalesced turn and only C's anchor frame arrives here.
    deliverOut(h.K, { type: "turn_settled", turnId: c, outcome: "error" });
    await settle();
    expect([...openTurnsOf(h.wrapper)]).toEqual([]); // B swept, not stranded
    expect(h.wrapper.getState().turnActive).toBe(false);
    // The P0-4 outcome still lands on the anchor exactly as before.
    expect(h.wrapper.getState().messages.find((m) => m.text === "C")).toMatchObject({
      sendState: "failed", sendFailure: { reason: "turn-failed", retryable: true },
    });
    h.wrapper.close();
  });

  it("a legacy/missing-member anchor settle sweeps a released held burst", async () => {
    const h = await connectWrapper();
    h.wrapper.send("first");
    await settle();
    const first = wireIdOf(h.wrapper, "first");
    deliverOut(h.K, { type: "typing" });
    await settle();
    h.wrapper.send("held-1");
    h.wrapper.send("held-2");
    await settle();
    expect(heldOf(h.wrapper)).toHaveLength(2);

    deliverOut(h.K, { type: "turn_settled", turnId: first, outcome: "ok" });
    await settle();
    // Both released FIFO → two open turns, but the agent coalesces the burst.
    const h1 = wireIdOf(h.wrapper, "held-1");
    const h2 = wireIdOf(h.wrapper, "held-2");
    expect([...openTurnsOf(h.wrapper)]).toEqual([h1, h2]);
    expect(h.wrapper.getState().turnActive).toBe(true);

    // Model an older anchor-only producer or a lost h1 member frame.
    deliverOut(h.K, { type: "turn_settled", turnId: h2, outcome: "ok" });
    await settle();
    expect([...openTurnsOf(h.wrapper)]).toEqual([]);
    expect(h.wrapper.getState().turnActive).toBe(false);
    h.wrapper.close();
  });

  // Forward/foreign-turn tolerance: a settle for a turn this client never opened
  // (another device's turn, a replayed frame) must not sweep anything or throw.
  it("a turn_settled for an unknown turnId sweeps nothing and corrupts nothing", async () => {
    const h = await connectWrapper();
    h.wrapper.send("keep");
    await settle();
    const keep = wireIdOf(h.wrapper, "keep");
    deliverOut(h.K, { type: "agent_message", text: "step one", turnId: keep });
    await settle();
    h.wrapper.send("keep too");
    await settle();
    const keepToo = wireIdOf(h.wrapper, "keep too");
    const before = h.wrapper.getState().messages;

    expect(() => deliverOut(h.K, { type: "turn_settled", turnId: "no-such-turn", outcome: "ok" })).not.toThrow();
    await settle();
    expect([...openTurnsOf(h.wrapper)]).toEqual([keep, keepToo]); // set intact, in order
    expect(h.wrapper.getState().turnActive).toBe(true);
    expect(h.wrapper.getState().messages.map((m) => m.text)).toEqual(before.map((m) => m.text));

    // …and a real settle still sweeps correctly afterwards.
    deliverOut(h.K, { type: "turn_settled", turnId: keepToo, outcome: "ok" });
    await settle();
    expect([...openTurnsOf(h.wrapper)]).toEqual([]);
    expect(h.wrapper.getState().turnActive).toBe(false);
    h.wrapper.close();
  });

  // The receipt hook closes a turn ONLY for `overloaded`, the one failure that is
  // a good proxy for the agent never having received the message (a proxy, not a
  // proof — see the wrapper's note on post-admission rejection). Anything a
  // settle might still name is left to the prefix sweep: removing it early would
  // make that sweep's `has(turnId)` guard fail and strand every earlier wireId.
  describe("a terminally-failed send and the open-turn set", () => {
    it("failed{overloaded} closes its turn (the ordinary ingress-rejection case)", async () => {
      const h = await connectWrapper({ ack: false });
      const receipt = h.wrapper.send("over capacity")!;
      await settle();
      const wireId = wireIdOf(h.wrapper, "over capacity");
      expect(h.wrapper.getState().turnActive).toBe(true);

      deliverOut(h.K, { type: "inbound_rejected", ids: [wireId], reason: "overloaded" });
      await settle();
      expect(receipt.snapshot()).toMatchObject({
        state: "failed", failure: { reason: "overloaded", retryable: true },
      });
      expect([...openTurnsOf(h.wrapper)]).toEqual([]);
      expect(h.wrapper.getState().turnActive).toBe(false);
      h.wrapper.close();
    });

    // failed{evicted} must NOT close its turn. Eviction is a CLIENT-side
    // unacked-ledger cap drop, and a lost ack is not a failed delivery: the agent
    // may well have received the message, coalesced it, and be about to settle
    // the turn under that very id. This models exactly that — an evicted id that
    // later arrives as the settle's turnId — and asserts the prefix still sweeps.
    it("failed{evicted} leaves its turn open, so a settle naming it still sweeps", async () => {
      const h = await connectWrapper();
      // Two acked sends: out of the ledger, but their turns are open.
      h.wrapper.send("W1");
      h.wrapper.send("W2");
      await settle();
      const w1 = wireIdOf(h.wrapper, "W1");
      const w2 = wireIdOf(h.wrapper, "W2");

      // W3's ack is lost, so it becomes the oldest unacked ledger entry…
      h.control.ack = false;
      const w3Receipt = h.wrapper.send("W3")!;
      await settle();
      const w3 = wireIdOf(h.wrapper, "W3");

      // …and later unacked sends push the ledger past the cap, evicting it.
      for (let i = 0; i < MAX_UNACKED; i++) h.wrapper.send(`filler-${i}`);
      await settle();
      expect(w3Receipt.snapshot()).toMatchObject({
        state: "failed", failure: { reason: "evicted", retryable: true },
      });
      expect(openTurnsOf(h.wrapper).has(w3)).toBe(true); // left for the sweep

      // Model an older anchor-only producer or lost W1/W2 member frames: the
      // agent got and coalesced {W1,W2,W3}, and W3's anchor frame still arrives.
      deliverOut(h.K, { type: "turn_settled", turnId: w3, outcome: "ok" });
      await settle();
      for (const id of [w1, w2, w3]) expect(openTurnsOf(h.wrapper).has(id)).toBe(false);
      expect(openTurnsOf(h.wrapper).size).toBe(MAX_UNACKED); // only the fillers remain
      expect(h.wrapper.getState().turnActive).toBe(true);
      h.wrapper.close();
    });

    // The bubble-less arm of the same close. A receipt record deliberately
    // outlives its render bubble (P0-4), so the flip must still be published when
    // there is no bubble left to patch it onto.
    it("closes the turn even when the failing send's bubble is gone", async () => {
      const h = await connectWrapper({ ack: false });
      h.wrapper.send("vanishing");
      await settle();
      const wireId = wireIdOf(h.wrapper, "vanishing");
      // Drop the bubble, keeping the receipt — what retraction/adoption does.
      const holder = h.wrapper as unknown as { state: { messages: unknown[] } };
      holder.state = { ...holder.state, messages: [] };

      deliverOut(h.K, { type: "inbound_rejected", ids: [wireId], reason: "overloaded" });
      await settle();
      expect([...openTurnsOf(h.wrapper)]).toEqual([]);
      expect(h.wrapper.getState().turnActive).toBe(false);
      h.wrapper.close();
    });
  });

  // `openTurn` refuses on a retired or closed instance: those sends fail
  // immediately and no turn will ever run, so opening one would latch.
  describe("a retired or closed instance opens no turns", () => {
    it("a send after a terminal error opens nothing", async () => {
      const h = await connectWrapper();
      FakeNatsWS.instances.at(-1)!.onmessage?.({ data: "-ERR 'Authorization Violation'\r\n" });
      await settle();
      expect(h.wrapper.getState().status).toBe("error");

      h.wrapper.send("after terminal");
      await settle();
      expect([...openTurnsOf(h.wrapper)]).toEqual([]);
      expect(h.wrapper.getState().turnActive).toBeUndefined();
      h.wrapper.close();
    });

    it("a send after close() opens nothing", async () => {
      const h = await connectWrapper();
      h.wrapper.close();

      h.wrapper.send("after close");
      await settle();
      expect([...openTurnsOf(h.wrapper)]).toEqual([]);
      expect(h.wrapper.getState().turnActive).toBeUndefined();
    });
  });

  // Control lane: abort text is dispatched with `controlLane: true`, which sets
  // `settlementEligible = false` in the plugin (inbound.ts) — no `turn_settled`
  // ever arrives, so opening a turn for it would latch the flag forever.
  it("an NL abort publish does not open a turn (no latch)", async () => {
    const h = await connectWrapper();
    h.wrapper.send("abort");
    await settle();
    expect(h.received).toHaveLength(1); // it really was published
    expect(h.wrapper.getState().turnActive).toBeUndefined();
    h.wrapper.close();
  });

  it("an explicit /stop closes the live turn and does not open one of its own", async () => {
    const h = await connectWrapper();
    h.wrapper.send("long job");
    await settle();
    deliverOut(h.K, { type: "typing" });
    await settle();
    expect(h.wrapper.getState().turnActive).toBe(true);

    h.wrapper.send("/stop");
    await settle();
    expect(h.received).toHaveLength(2); // the /stop was published
    expect(h.wrapper.getState().isTyping).toBe(false);
    expect(h.wrapper.getState().turnActive).toBe(false); // finalize swept it, /stop opened nothing
    h.wrapper.close();
  });

  it("an explicit /stop consumes a pre-connect queued turn before replay", async () => {
    const h = await connectWrapper({ ack: true }, { connect: false });
    const queued = h.wrapper.send("queued before stop")!;
    h.wrapper.send("/stop");

    expect(queued.snapshot().state).toBe("queued");
    expect([...openTurnsOf(h.wrapper)]).toEqual([]);
    expect(h.wrapper.getState().turnActive).not.toBe(true);

    h.wrapper.connect();
    await settle();

    expect(h.received).toHaveLength(2);
    expect(queued.snapshot().state).toBe("accepted");
    expect([...openTurnsOf(h.wrapper)]).toEqual([]);
    expect(h.wrapper.getState().turnActive).not.toBe(true);
    h.wrapper.close();
  });

  it("an explicit /stop preserves a follow-up created by its cancellation fanout", async () => {
    const h = await connectWrapper();
    h.wrapper.send("active");
    await settle();
    deliverOut(h.K, { type: "typing" });
    await settle();
    const cancelled = h.wrapper.send("cancel me")!;
    let followUp: ReturnType<WebChannelNATSClient["send"]>;
    cancelled.subscribe((snapshot) => {
      if (snapshot.state === "failed") followUp = h.wrapper.send("after stop");
    });

    h.wrapper.send("/stop");
    await settle();

    const followUpBubble = h.wrapper.getState().messages.find((m) => m.text === "after stop")!;
    expect(followUp!.snapshot().state).toBe("accepted");
    expect(followUpBubble.wireId).toBeDefined();
    expect([...openTurnsOf(h.wrapper)]).toEqual([followUpBubble.wireId]);
    expect(h.wrapper.getState().turnActive).toBe(true);
    h.wrapper.close();
  });

  describe("safety points force-close every open turn", () => {
    it("a raw disconnect closes them", async () => {
      const h = await connectWrapper({ ack: false });
      h.wrapper.send("in flight");
      await settle();
      const wireId = wireIdOf(h.wrapper, "in flight");
      expect(h.wrapper.getState().turnActive).toBe(true);

      FakeNatsWS.instances.at(-1)!.close();
      await settle();
      expect(h.wrapper.getState().connected).toBe(false);
      expect(h.wrapper.getState().turnActive).toBe(false);

      // A delayed ack/replay is a later authoritative transition, but this turn
      // already spent its one-way opening latch before the disconnect sweep.
      (h.wrapper as unknown as {
        client: { emitSendState: (id: string, state: "accepted") => void };
      }).client.emitSendState(wireId, "accepted");
      expect([...openTurnsOf(h.wrapper)]).toEqual([]);
      expect(h.wrapper.getState().turnActive).toBe(false);
      h.wrapper.close();
    });

    it("a raw disconnect consumes a sent callback still queued in the global fanout", async () => {
      const h = await connectWrapper();
      let injected = false;
      const unsubscribe = h.wrapper.subscribe((state) => {
        const a = state.messages.find((m) => m.text === "A");
        if (injected || a?.sendState !== "accepted") return;
        injected = true;
        h.wrapper.send("B"); // low tracker reaches sent; wrapper callback is queued behind A's ack
        FakeNatsWS.instances.at(-1)!.close();
      });

      h.wrapper.send("A");
      await settle();

      expect(injected).toBe(true);
      expect(h.wrapper.getState().messages.find((m) => m.text === "B")?.sendState).not.toBe("queued");
      expect(h.wrapper.getState().connected).toBe(false);
      expect([...openTurnsOf(h.wrapper)]).toEqual([]);
      expect(h.wrapper.getState().turnActive).toBe(false);
      unsubscribe();
      h.wrapper.close();
    });

    it("a synchronous raw loss inside ws.send cannot open on trailing sent", async () => {
      const h = await connectWrapper({ ack: false });
      const socket = FakeNatsWS.instances.at(-1)!;
      socket.handler = (subject, _payload, server) => {
        if (subject === IN) server.close(); // ws.send still returns normally
      };

      const receipt = h.wrapper.send("loss inside publish")!;
      await settle();

      expect(receipt.snapshot().state).toBe("sent");
      expect(h.wrapper.getState().connected).toBe(false);
      expect([...openTurnsOf(h.wrapper)]).toEqual([]);
      expect(h.wrapper.getState().turnActive).not.toBe(true);
      h.wrapper.close();
    });

    it("a raw disconnect consumes sent queued ahead of failed{evicted}", async () => {
      const h = await connectWrapper();
      let injected = false;
      const unsubscribe = h.wrapper.subscribe((state) => {
        const a = state.messages.find((m) => m.text === "A");
        if (injected || a?.sendState !== "accepted") return;
        injected = true;
        h.wrapper.send("B");
        const b = wireIdOf(h.wrapper, "B");
        (h.wrapper as unknown as {
          client: {
            trackerFail: (
              id: string,
              failure: { reason: "evicted"; retryable: true },
            ) => void;
          };
        }).client.trackerFail(b, { reason: "evicted", retryable: true });
        FakeNatsWS.instances.at(-1)!.close();
      });

      h.wrapper.send("A");
      await settle();

      expect(injected).toBe(true);
      expect(h.wrapper.getState().messages.find((m) => m.text === "B")).toMatchObject({
        sendState: "failed",
        sendFailure: { reason: "evicted", retryable: true },
      });
      expect([...openTurnsOf(h.wrapper)]).toEqual([]);
      expect(h.wrapper.getState().turnActive).toBe(false);
      unsubscribe();
      h.wrapper.close();
    });

    it("a terminal error closes them", async () => {
      const h = await connectWrapper();
      h.wrapper.send("in flight");
      await settle();
      expect(h.wrapper.getState().turnActive).toBe(true);

      FakeNatsWS.instances.at(-1)!.onmessage?.({ data: "-ERR 'Authorization Violation'\r\n" });
      await settle();
      expect(h.wrapper.getState().status).toBe("error");
      expect(h.wrapper.getState().isTyping).toBe(false);
      expect(h.wrapper.getState().turnActive).toBe(false);
      h.wrapper.close();
    });

    it("close() closes them", async () => {
      const h = await connectWrapper();
      h.wrapper.send("in flight");
      await settle();
      expect(h.wrapper.getState().turnActive).toBe(true);

      h.wrapper.close();
      expect(h.wrapper.getState().turnActive).toBe(false);
    });

    // close() re-entrancy: a listener the teardown notifies may reopen the
    // instance. The sweep must still land, and it must not be published from
    // INSIDE the pre-disconnect window (that window carries no state fanout).
    it("close() with a listener that reconnects still closes them", async () => {
      const h = await connectWrapper();
      h.wrapper.send("in flight");
      await settle();
      expect(h.wrapper.getState().turnActive).toBe(true);

      // Instrument the teardown boundary: nothing may fan out before it.
      const inner = (h.wrapper as unknown as { client: { disconnect: () => void } }).client;
      const realDisconnect = inner.disconnect.bind(inner);
      let disconnectStarted = false;
      vi.spyOn(inner, "disconnect").mockImplementation(() => {
        disconnectStarted = true;
        realDisconnect();
      });

      let fanoutsBeforeDisconnect = 0;
      let reconnected = false;
      const unsubscribe = h.wrapper.subscribe(() => {
        if (!disconnectStarted) fanoutsBeforeDisconnect++;
        if (reconnected) return;
        reconnected = true;
        h.wrapper.connect(); // reopens the wrapper mid-teardown
      });

      h.wrapper.close();
      expect(fanoutsBeforeDisconnect).toBe(0); // the pre-teardown window stays silent
      expect(reconnected).toBe(true);
      expect([...openTurnsOf(h.wrapper)]).toEqual([]);
      expect(h.wrapper.getState().turnActive).toBe(false);

      unsubscribe();
      h.wrapper.close();
    });

    // The other half of the same guard: a send admitted by the reopening
    // listener belongs to the replacement lifecycle. #81 now holds it until the
    // replacement session exists, so the old turn closes first and the new turn
    // opens only when that held send is actually published.
    it("close() hands turn ownership to the reopening listener's published replacement", async () => {
      const h = await connectWrapper();
      h.wrapper.send("in flight");
      await settle();
      expect(h.wrapper.getState().turnActive).toBe(true);

      let reopened = false;
      const unsubscribe = h.wrapper.subscribe(() => {
        if (reopened) return;
        reopened = true;
        h.wrapper.connect();
        h.wrapper.send("replacement");
      });

      h.wrapper.close();
      expect(reopened).toBe(true);
      let replacement = h.wrapper.getState().messages.find((m) => m.text === "replacement")!;
      expect(replacement.pending).toBe(true);
      expect(replacement.wireId).toBeUndefined();
      expect([...openTurnsOf(h.wrapper)]).toEqual([]);
      expect(h.wrapper.getState().turnActive).toBe(false); // the old turn is gone

      await settle();
      replacement = h.wrapper.getState().messages.find((m) => m.text === "replacement")!;
      expect(replacement.pending).not.toBe(true);
      expect(replacement.wireId).toBeDefined();
      expect([...openTurnsOf(h.wrapper)]).toEqual([replacement.wireId]);
      expect(h.wrapper.getState().turnActive).toBe(true); // the published replacement owns it

      unsubscribe();
      h.wrapper.close();
    });

    it("preserves turn eligibility for publishes staged in the replacement FIFO", async () => {
      const h = await connectWrapper();
      h.wrapper.send("old turn");
      await settle();
      expect(h.wrapper.getState().turnActive).toBe(true);

      const inner = (h.wrapper as unknown as { client: { connect: () => void } }).client;
      const realInnerConnect = inner.connect.bind(inner);
      let injected = false;
      const connectSpy = vi.spyOn(inner, "connect").mockImplementation(() => {
        if (!injected) {
          injected = true;
          // Both calls occur while the replacement FIFO is being committed.
          // Control-lane text must remain non-settling; ordinary text must open.
          h.wrapper.send("/stop");
          h.wrapper.send("replacement from dial");
        }
        realInnerConnect();
      });

      let reopened = false;
      const unsubscribe = h.wrapper.subscribe((state) => {
        if (reopened || state.turnActive !== false) return;
        reopened = true;
        h.wrapper.connect();
      });

      try {
        h.wrapper.close();
        expect(reopened).toBe(true);
        expect(injected).toBe(true);

        const stop = h.wrapper.getState().messages.find((m) => m.text === "/stop")!;
        const replacement = h.wrapper.getState().messages.find(
          (m) => m.text === "replacement from dial",
        )!;
        expect(stop.wireId).toBeDefined();
        expect(replacement.wireId).toBeDefined();
        expect(stop.sendState).toBe("queued");
        expect(replacement.sendState).toBe("queued");
        expect([...openTurnsOf(h.wrapper)]).toEqual([]);
        expect(openTurnsOf(h.wrapper).has(stop.wireId!)).toBe(false);
        expect(h.wrapper.getState().turnActive).toBe(false);

        await settle();
        expect([...openTurnsOf(h.wrapper)]).toEqual([replacement.wireId]);
        expect(openTurnsOf(h.wrapper).has(stop.wireId!)).toBe(false);
        expect(h.wrapper.getState().turnActive).toBe(true); // publish/ack opened; no settle yet
        deliverOut(h.K, { type: "turn_settled", turnId: replacement.wireId, outcome: "ok" });
        await settle();
        expect(h.wrapper.getState().turnActive).toBe(false);
      } finally {
        unsubscribe();
        connectSpy.mockRestore();
        h.wrapper.close();
      }
    });
  });

  // P1-9 tripwire: `turnActive` is advisory. The hold predicate still keys off
  // `turnInFlight()` (typing / working draft) ONLY, so neither an open turn nor
  // a released follow-up changes when a message leaves the client.
  describe("P1-9 regression guard — holding/release is untouched", () => {
    it("a send during an open-but-quiet turn publishes IMMEDIATELY (never held)", async () => {
      const h = await connectWrapper();
      h.wrapper.send("first");
      await settle();
      const turnId = wireIdOf(h.wrapper, "first");
      deliverOut(h.K, { type: "typing" });
      deliverOut(h.K, { type: "agent_message", text: "partial answer", turnId });
      await settle();
      // The turn is open, but nothing is typing and no draft is working.
      expect(h.wrapper.getState().turnActive).toBe(true);
      expect(h.wrapper.getState().isTyping).toBe(false);

      h.wrapper.send("follow-up");
      await settle();
      expect(heldOf(h.wrapper)).toHaveLength(0);
      expect(h.received).toHaveLength(2); // published, not held
      expect(h.wrapper.getState().messages.find((m) => m.text === "follow-up")!.pending).toBeUndefined();
      h.wrapper.close();
    });

    it("a held follow-up still releases on turn_settled, and its own turn opens", async () => {
      const h = await connectWrapper();
      // Record every distinct `turnActive` value a subscriber can observe.
      const seen: Array<boolean | undefined> = [];
      const unsubscribe = h.wrapper.subscribe((s) => {
        if (seen[seen.length - 1] !== s.turnActive) seen.push(s.turnActive);
      });
      h.wrapper.send("first");
      await settle();
      const turnId = wireIdOf(h.wrapper, "first");
      deliverOut(h.K, { type: "typing" });
      await settle();

      h.wrapper.send("held follow-up");
      await settle();
      expect(heldOf(h.wrapper).map((e) => e.text)).toEqual(["held follow-up"]); // held, as today
      expect(h.received).toHaveLength(1);

      deliverOut(h.K, { type: "turn_settled", turnId, outcome: "ok" });
      await settle();
      expect(heldOf(h.wrapper)).toHaveLength(0); // released on the same settle
      expect(h.received).toHaveLength(2);
      const released = h.wrapper.getState().messages.find((m) => m.text === "held follow-up")!;
      expect(released.pending).toBe(false);
      expect(released.wireId).toBeDefined();
      expect(h.wrapper.getState().turnActive).toBe(true); // the release opened its own turn

      // The signal is NOT gapless across this boundary, and that is honest: the
      // settle reducer flips it false, then the trailing `maybeRelease()` in the
      // same tick opens the follow-up's turn and flips it back. A subscriber does
      // observe true → false → true. Semantically correct — the follow-up's turn
      // genuinely had not started while the previous one was still running — but
      // a widget that animates on every transition will see the blip.
      expect(seen).toEqual([true, false, true]);

      deliverOut(h.K, { type: "turn_settled", turnId: released.wireId!, outcome: "ok" });
      await settle();
      expect(h.wrapper.getState().turnActive).toBe(false);
      expect(seen).toEqual([true, false, true, false]);
      unsubscribe();
      h.wrapper.close();
    });
  });
});

// ---------------------------------------------------------------------------
// Cases that need fake timers or a hand-placed state edge run against the
// reducer-level harness (no socket): the real onState/onSession callbacks with a
// directly-opened release gate, exactly like the §3.6.2 suite in
// nats-client-wrapper.test.ts.
// ---------------------------------------------------------------------------
describe("WebChannelNATSClient — #96 turnActive, valve and release edges", () => {
  type Frame = Record<string, unknown> & { type: string };

  const makeWrapper = (): WebChannelNATSClient =>
    new WebChannelNATSClient({
      natsUrl: "ws://127.0.0.1:4222",
      bootstrapJwt: "eyJ-bootstrap",
      accountId: "a",
      tenant: "t",
      peerId: "p",
      heartbeatIntervalMs: 0,
      // #81's held watchdog has its own suite; keep this one deterministic.
      ackStallTimeoutMs: 0,
      registration: {
        devicePrivateKey: {} as CryptoKey,
        deviceX25519PrivateKey: {} as CryptoKey,
      } as NonNullable<NatsClientOptions["registration"]>,
    });
  const inner = (w: WebChannelNATSClient) =>
    (w as unknown as {
      client: {
        sendUserMessage: (t: string, id?: string) => string;
        notifySessionListeners: () => void;
        emitSendState: (id: string, state: "sent" | "accepted") => void;
      };
    }).client;
  const publishAs = (
    w: WebChannelNATSClient,
    id: string | undefined,
    state: "sent" | "accepted" = "sent",
  ): string => {
    const wireId = id ?? "w-1";
    inner(w).emitSendState(wireId, state);
    return wireId;
  };
  const deliver = (w: WebChannelNATSClient, frame: Frame): void =>
    (w as unknown as { handleMessage: (m: Frame) => void }).handleMessage(frame);
  /** Open the release gate without a socket (the §3.6.2 suite's idiom). */
  function goOnline(w: WebChannelNATSClient): void {
    const holder = w as unknown as {
      state: Record<string, unknown>;
      sessionEstablished: boolean;
      rawTransportConnected: boolean;
    };
    holder.state = { ...holder.state, connected: true, status: "connected" };
    holder.sessionEstablished = true;
    holder.rawTransportConnected = true;
  }

  it("the expiring valve sweeps open turns alongside the wedged draft", () => {
    vi.useFakeTimers();
    const w = makeWrapper();
    goOnline(w);
    vi.spyOn(inner(w), "sendUserMessage").mockImplementation(
      (_text, id) => publishAs(w, id),
    );

    w.send("wedged turn");
    expect(w.getState().turnActive).toBe(true);
    deliver(w, { type: "progress", id: "webchannel-d", text: "partial…", turnId: "T" });
    // Session re-establishes with the draft still working → arm the valve.
    inner(w).notifySessionListeners();

    vi.advanceTimersByTime(29_000);
    expect(w.getState().turnActive).toBe(true); // grace not expired yet

    vi.advanceTimersByTime(1_000);
    // Setup probe only — this test is about `turnActive` below. #251: the draft
    // never received durable text, so expiry drops the bubble rather than
    // flipping it working:false in place.
    expect(w.getState().messages.some((m) => m.id === "webchannel-d")).toBe(false);
    expect(w.getState().turnActive).toBe(false); // no proof of life → no claim
    w.close();
  });

  it("an accepted callback that skips sent opens atomically with the receipt", () => {
    const w = makeWrapper();
    goOnline(w);
    const snapshots: Array<{ sendState: string | undefined; turnActive: boolean | undefined }> = [];
    w.subscribe((state) => {
      const bubble = state.messages.find((m) => m.text === "fast ack");
      if (bubble?.sendState === "accepted") {
        snapshots.push({ sendState: bubble.sendState, turnActive: state.turnActive });
      }
    });
    vi.spyOn(inner(w), "sendUserMessage").mockImplementation(
      (_text, id) => publishAs(w, id, "accepted"),
    );

    const receipt = w.send("fast ack")!;

    expect(receipt.snapshot().state).toBe("accepted");
    expect(openTurnsOf(w).size).toBe(1);
    expect(w.getState().turnActive).toBe(true);
    expect(snapshots).toEqual([{ sendState: "accepted", turnActive: true }]);
    w.close();
  });

  it("an early outcome-less settle closes the open prefix but its replay is a no-op", () => {
    const w = makeWrapper();
    goOnline(w);
    vi.spyOn(inner(w), "sendUserMessage").mockImplementation((text, id) => {
      const wireId = id ?? "w-1";
      if (text === "B") deliver(w, { type: "turn_settled", turnId: wireId });
      return publishAs(w, wireId);
    });

    w.send("A");
    const a = wireIdOf(w, "A");
    expect([...openTurnsOf(w)]).toEqual([a]);
    const bReceipt = w.send("B")!;
    const b = wireIdOf(w, "B");

    expect(bReceipt.snapshot().state).toBe("sent");
    expect([...openTurnsOf(w)]).toEqual([]);
    expect(w.getState().turnActive).toBe(false);

    w.send("C");
    const c = wireIdOf(w, "C");
    expect([...openTurnsOf(w)]).toEqual([c]);
    deliver(w, { type: "turn_settled", turnId: b }); // replayed old local settle
    expect([...openTurnsOf(w)]).toEqual([c]);
    expect(w.getState().turnActive).toBe(true);
    w.close();
  });

  it("a normal settle does not rescan lifetime-retained wire history", () => {
    const w = makeWrapper();
    goOnline(w);
    vi.spyOn(inner(w), "sendUserMessage").mockImplementation(
      (_text, id) => publishAs(w, id),
    );

    for (let i = 0; i < 3; i++) {
      w.send(`history-${i}`);
      deliver(w, {
        type: "turn_settled",
        turnId: wireIdOf(w, `history-${i}`),
        outcome: "ok",
      });
    }
    w.send("current");
    const current = wireIdOf(w, "current");
    const retainedWireMap = (w as unknown as {
      wireIdToReceiptKey: Map<string, string>;
    }).wireIdToReceiptKey;
    const wireHistoryScan = vi.spyOn(retainedWireMap, Symbol.iterator);

    deliver(w, { type: "turn_settled", turnId: current, outcome: "ok" });

    expect(wireHistoryScan).not.toHaveBeenCalled();
    expect(w.getState().turnActive).toBe(false);
    w.close();
  });

  // The release loop's bubble-absent arm: a re-entrant listener can remove a held
  // bubble while the drain is running. The text is still published (a release is
  // a commit), so the turn still opens — and with no staged bubble patch to ride
  // along, the flip has to be published on its own, AFTER the send owns its
  // outbound position (the commit-then-expose shape the sibling arm gets from
  // `stageReceiptStateThenCommit`).
  it("a release whose bubble vanished opens its turn, and publishes the flip after the send", () => {
    const w = makeWrapper();
    goOnline(w);
    const order: string[] = [];
    vi.spyOn(inner(w), "sendUserMessage").mockImplementation((_text, id) => {
      order.push("send");
      return publishAs(w, id);
    });

    deliver(w, { type: "typing" }); // turn in flight → the send is held
    w.send("held");
    expect(heldOf(w)).toHaveLength(1);
    expect(w.getState().turnActive).toBeUndefined(); // nothing published yet

    // Strip the pending bubble, leaving the held entry — the exact state the
    // loop's `if (bubble)` guard exists for.
    const localId = heldOf(w)[0].localId;
    const holder = w as unknown as { state: { messages: Array<{ id: string }> } };
    holder.state = {
      ...holder.state,
      messages: holder.state.messages.filter((m) => m.id !== localId),
    };

    w.subscribe((s) => { if (s.turnActive === true) order.push("flip"); });
    deliver(w, { type: "turn_settled", turnId: "T" }); // settles → releases

    expect(heldOf(w)).toHaveLength(0);
    expect(openTurnsOf(w).size).toBe(1); // the released text owns a turn
    expect(w.getState().turnActive).toBe(true);
    // Fanned out (not merely assigned), and only after the publish committed —
    // a listener reached earlier could have jumped the released entry's queue slot.
    expect(order).toEqual(["send", "flip"]);
    w.close();
  });

  it("a bubble-less release cannot resurrect turnActive after re-entrant close", () => {
    const w = makeWrapper();
    goOnline(w);
    let publishes = 0;
    vi.spyOn(inner(w), "sendUserMessage").mockImplementation((_text, id) => {
      publishes++;
      const wireId = publishAs(w, id);
      if (publishes === 2) w.close();
      return wireId;
    });

    w.send("active");
    const activeTurnId = wireIdOf(w, "active");
    deliver(w, { type: "typing" }); // turn in flight → the follow-up is held
    w.send("held");
    const localId = heldOf(w)[0].localId;
    const holder = w as unknown as { state: { messages: Array<{ id: string }> } };
    holder.state = {
      ...holder.state,
      messages: holder.state.messages.filter((m) => m.id !== localId),
    };

    deliver(w, { type: "turn_settled", turnId: activeTurnId });

    expect(publishes).toBe(2);
    expect(heldOf(w)).toHaveLength(0);
    expect([...openTurnsOf(w)]).toEqual([]);
    expect(w.getState().turnActive).toBe(false);
  });
});
