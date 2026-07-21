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
import type { ChatMessage, SendFailure } from "./types.js";
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

/** A registered wrapper over the fake socket; auto-acks user_messages by default. */
async function connectWrapper(control: { ack: boolean } = { ack: true }): Promise<Setup> {
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
  wrapper.connect();
  await settle();
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
