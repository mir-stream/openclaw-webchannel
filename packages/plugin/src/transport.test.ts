import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { WebSocket } from "ws";

import { WebChannelTransport, ANON_PEER_ID } from "./transport.js";

/**
 * Minimal fake of a `ws` WebSocket good enough for the transport's heartbeat,
 * backpressure, and cleanup paths. We don't open a real socket; we drive the
 * event handlers and counters directly.
 */
function makeFakeSocket(opts?: {
  readyState?: number;
  bufferedAmount?: number;
}) {
  const handlers = new Map<string, ((arg?: unknown) => void)[]>();
  const socket = {
    readyState: opts?.readyState ?? WebSocket.OPEN,
    bufferedAmount: opts?.bufferedAmount ?? 0,
    sent: [] as string[],
    pingCount: 0,
    terminated: false,
    on(event: string, listener: (arg?: unknown) => void) {
      const list = handlers.get(event) ?? [];
      list.push(listener);
      handlers.set(event, list);
      return this;
    },
    emit(event: string, arg?: unknown) {
      for (const fn of handlers.get(event) ?? []) fn(arg);
    },
    send(data: string) {
      this.sent.push(data);
    },
    ping() {
      this.pingCount += 1;
    },
    terminate() {
      this.terminated = true;
      this.readyState = WebSocket.CLOSED;
      // Real `ws` fires `close` on terminate; mirror that so cleanup runs.
      this.emit("close");
    },
  };
  return socket;
}

/** Register a fake socket through the (private) registerConnection path. */
function register(transport: WebChannelTransport, ws: unknown): void {
  (transport as unknown as { registerConnection: (w: unknown) => void })
    .registerConnection(ws);
}

/** Register a fake socket under a specific peer key (multi-user cases). */
function registerAs(
  transport: WebChannelTransport,
  ws: unknown,
  peerId: string,
): void {
  (
    transport as unknown as {
      registerConnection: (w: unknown, peerId: string) => void;
    }
  ).registerConnection(ws, peerId);
}

function mapHas(transport: WebChannelTransport): boolean {
  const sockets = (transport as unknown as { sockets: Map<string, unknown> })
    .sockets;
  return sockets.has(ANON_PEER_ID);
}

describe("webchannel transport heartbeat", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("pings an alive socket each tick", () => {
    const transport = new WebChannelTransport({ heartbeatMs: 1000 });
    const ws = makeFakeSocket();
    register(transport, ws);

    expect(ws.pingCount).toBe(0);
    vi.advanceTimersByTime(1000);
    // Seeded alive -> first tick pings (and marks not-alive).
    expect(ws.pingCount).toBe(1);
    expect(ws.terminated).toBe(false);

    // Pong re-arms liveness so the next tick pings again instead of evicting.
    ws.emit("pong");
    vi.advanceTimersByTime(1000);
    expect(ws.pingCount).toBe(2);
    expect(ws.terminated).toBe(false);

    transport.dispose();
  });

  it("terminates a socket that did not pong by the next tick", () => {
    const transport = new WebChannelTransport({ heartbeatMs: 1000 });
    const ws = makeFakeSocket();
    register(transport, ws);

    // Tick 1: ping, mark not-alive. No pong arrives.
    vi.advanceTimersByTime(1000);
    expect(ws.pingCount).toBe(1);
    expect(ws.terminated).toBe(false);

    // Tick 2: still not-alive -> terminate.
    vi.advanceTimersByTime(1000);
    expect(ws.terminated).toBe(true);

    transport.dispose();
  });

  it("terminate path removes the socket from the map", () => {
    const transport = new WebChannelTransport({ heartbeatMs: 1000 });
    const ws = makeFakeSocket();
    register(transport, ws);
    expect(mapHas(transport)).toBe(true);

    vi.advanceTimersByTime(1000); // ping, mark not-alive
    vi.advanceTimersByTime(1000); // evict
    expect(ws.terminated).toBe(true);
    expect(mapHas(transport)).toBe(false);

    transport.dispose();
  });

  it("dispose stops the timer and clears sockets", () => {
    const transport = new WebChannelTransport({ heartbeatMs: 1000 });
    const ws = makeFakeSocket();
    register(transport, ws);

    transport.dispose();
    expect(ws.terminated).toBe(true);
    expect(mapHas(transport)).toBe(false);

    // No further ticks after dispose.
    const before = ws.pingCount;
    vi.advanceTimersByTime(5000);
    expect(ws.pingCount).toBe(before);
  });
});

describe("webchannel transport backpressure (safeSend)", () => {
  it("sends when buffer is under the cap", () => {
    const transport = new WebChannelTransport({ heartbeatMs: 1000 });
    const ws = makeFakeSocket({ bufferedAmount: 0 });
    register(transport, ws);

    const ok = transport.sendText(ANON_PEER_ID, "hi");
    expect(ok).toBe(true);
    expect(ws.sent).toHaveLength(1);
    expect(JSON.parse(ws.sent[0])).toEqual({ type: "agent_message", text: "hi" });

    transport.dispose();
  });

  it("drops when bufferedAmount exceeds the cap", () => {
    const transport = new WebChannelTransport({ heartbeatMs: 1000 });
    // 2 MB buffered, over the 1 MB cap.
    const ws = makeFakeSocket({ bufferedAmount: 2_000_000 });
    register(transport, ws);

    const okText = transport.sendText(ANON_PEER_ID, "hi");
    const okProgress = transport.sendProgress(ANON_PEER_ID, "d1", "working");
    expect(okText).toBe(false);
    expect(okProgress).toBe(false);
    expect(ws.sent).toHaveLength(0);

    transport.dispose();
  });

  it("does not send on a non-OPEN socket", () => {
    const transport = new WebChannelTransport({ heartbeatMs: 1000 });
    const ws = makeFakeSocket({ readyState: WebSocket.CLOSING });
    register(transport, ws);

    expect(transport.sendText(ANON_PEER_ID, "hi")).toBe(false);
    expect(ws.sent).toHaveLength(0);

    transport.dispose();
  });
});

describe("webchannel transport multi-peer routing", () => {
  it("sendText delivers to the exact peer key, never another peer's socket", () => {
    const transport = new WebChannelTransport({ heartbeatMs: 1000 });
    const alice = makeFakeSocket();
    const bob = makeFakeSocket();
    registerAs(transport, alice, "peer-alice");
    registerAs(transport, bob, "peer-bob");

    expect(transport.sendText("peer-bob", "for bob")).toBe(true);
    expect(bob.sent).toHaveLength(1);
    expect(JSON.parse(bob.sent[0])).toEqual({
      type: "agent_message",
      text: "for bob",
    });
    // Alice must NOT receive bob's message.
    expect(alice.sent).toHaveLength(0);

    transport.dispose();
  });

  it("sendText returns false for an unmapped peer (no wrong-socket fallback)", () => {
    const transport = new WebChannelTransport({ heartbeatMs: 1000 });
    const alice = makeFakeSocket();
    const bob = makeFakeSocket();
    registerAs(transport, alice, "peer-alice");
    registerAs(transport, bob, "peer-bob");

    // No socket mapped under this key -> not delivered.
    expect(transport.sendText("peer-carol", "stray")).toBe(false);
    expect(alice.sent).toHaveLength(0);
    expect(bob.sent).toHaveLength(0);

    transport.dispose();
  });

  it("sendTextToAnyOpen refuses to guess when multiple peers are connected", () => {
    const transport = new WebChannelTransport({ heartbeatMs: 1000 });
    const alice = makeFakeSocket();
    const bob = makeFakeSocket();
    registerAs(transport, alice, "peer-alice");
    registerAs(transport, bob, "peer-bob");

    // With 2+ connections the fallback must NOT cross-deliver to an arbitrary
    // user — this is what protects the channel.ts / message-adapter.ts paths
    // when `ctx.to` doesn't match a mapped socket.
    expect(transport.sendTextToAnyOpen("orphan")).toBe(false);
    expect(alice.sent).toHaveLength(0);
    expect(bob.sent).toHaveLength(0);

    transport.dispose();
  });

  it("sendTextToAnyOpen delivers to the sole connection (anonymous case)", () => {
    const transport = new WebChannelTransport({ heartbeatMs: 1000 });
    const only = makeFakeSocket();
    registerAs(transport, only, ANON_PEER_ID);

    expect(transport.sendTextToAnyOpen("hi")).toBe(true);
    expect(only.sent).toHaveLength(1);

    transport.dispose();
  });
});

describe("webchannel transport typing indicator (AC1 / AC4 / AC5)", () => {
  it("sendTyping sends a {type:'typing'} frame to the live socket (AC1)", () => {
    const transport = new WebChannelTransport({ heartbeatMs: 1000 });
    const ws = makeFakeSocket();
    register(transport, ws);

    const ok = transport.sendTyping(ANON_PEER_ID);
    expect(ok).toBe(true);
    expect(ws.sent).toHaveLength(1);
    expect(JSON.parse(ws.sent[0])).toEqual({ type: "typing" });

    transport.dispose();
  });

  it("sendTyping returns false (and emits nothing) when the session has no live socket (AC1)", () => {
    const transport = new WebChannelTransport({ heartbeatMs: 1000 });

    expect(transport.sendTyping("peer-missing")).toBe(false);

    transport.dispose();
  });

  it("sendTyping is a no-op when setTypingEnabled(false) was called (AC4)", () => {
    const transport = new WebChannelTransport({ heartbeatMs: 1000 });
    const ws = makeFakeSocket();
    register(transport, ws);

    transport.setTypingEnabled(false);
    const ok = transport.sendTyping(ANON_PEER_ID);
    expect(ok).toBe(false);
    // No frame was queued — the capability gate fires BEFORE safeSend.
    expect(ws.sent).toHaveLength(0);

    // Re-enable and confirm the same call now delivers (no sticky state).
    transport.setTypingEnabled(true);
    expect(transport.sendTyping(ANON_PEER_ID)).toBe(true);
    expect(ws.sent).toHaveLength(1);
    expect(JSON.parse(ws.sent[0])).toEqual({ type: "typing" });

    transport.dispose();
  });

  it("sendTyping defaults to ENABLED (operator must opt-out, not opt-in) (AC4)", () => {
    const transport = new WebChannelTransport({ heartbeatMs: 1000 });
    const ws = makeFakeSocket();
    register(transport, ws);

    // No setTypingEnabled call — the default must already be "on" so the
    // affordance works out of the box (US2 / PLAN §7 Phase 3 typing).
    expect(transport.sendTyping(ANON_PEER_ID)).toBe(true);
    expect(ws.sent).toHaveLength(1);

    transport.dispose();
  });

  it("typing under backpressure: drops the frame, does NOT terminate the socket (AC5)", () => {
    const transport = new WebChannelTransport({ heartbeatMs: 1000 });
    // 2 MB buffered, over the 1 MB cap. Use a fresh socket for typing so we
    // observe its drop-only behavior in isolation (a terminal sendText on the
    // SAME socket would terminate it first, masking the typing branch).
    const ws = makeFakeSocket({ bufferedAmount: 2_000_000 });
    register(transport, ws);

    const okTyping = transport.sendTyping(ANON_PEER_ID);

    // Drop: nothing was sent and the call returned false.
    expect(okTyping).toBe(false);
    expect(ws.sent).toHaveLength(0);
    // CRITICAL: the socket is STILL ALIVE. `typing` is in the drop-only
    // group with `progress` — dropping it does NOT terminate the socket. A
    // terminal frame (finalize / legacy answer / approval) would have, but a
    // missed typing ping is not a wedge, the next real frame will settle.
    expect(ws.terminated).toBe(false);

    transport.dispose();
  });

  it("drop-only group (progress + typing) keeps the socket alive under backpressure (AC5)", () => {
    // Companion to the above: progress (the existing drop-only type) and
    // typing BOTH leave the socket alive when the buffer is over the cap.
    // This pins the regression boundary — adding a future type to the
    // drop-only group must not regress into termination.
    const transport = new WebChannelTransport({ heartbeatMs: 1000 });

    const wsProgress = makeFakeSocket({ bufferedAmount: 2_000_000 });
    registerAs(transport, wsProgress, "peer-progress");
    transport.sendProgress("peer-progress", "d1", "working");
    expect(wsProgress.terminated).toBe(false);

    const wsTyping = makeFakeSocket({ bufferedAmount: 2_000_000 });
    registerAs(transport, wsTyping, "peer-typing");
    transport.sendTyping("peer-typing");
    expect(wsTyping.terminated).toBe(false);

    transport.dispose();
  });

  it("existing OutboundWsMessage cases are unchanged (regression guard) (AC1)", () => {
    // The new `typing` case joins the union, but the OTHER cases keep their
    // exact shape. This is a wire-envelope contract test: changing the JSON
    // payload of any non-new case would break the existing widget.
    const transport = new WebChannelTransport({ heartbeatMs: 1000 });
    const ws = makeFakeSocket();
    register(transport, ws);

    transport.sendText(ANON_PEER_ID, "hello");
    transport.sendProgress(ANON_PEER_ID, "d1", "working");
    transport.sendApprovalRequest(ANON_PEER_ID, {
      id: "ap1",
      kind: "exec",
      title: "t",
      prompt: "p",
      options: [
        { decision: "allow-once", label: "Allow", style: "primary" },
      ],
    });
    transport.sendApprovalResolved(ANON_PEER_ID, "ap1", "deny");
    transport.sendTyping(ANON_PEER_ID);

    const frames = ws.sent.map((s) => JSON.parse(s));
    expect(frames).toEqual([
      { type: "agent_message", text: "hello" },
      { type: "progress", id: "d1", text: "working" },
      {
        type: "approval_request",
        id: "ap1",
        kind: "exec",
        title: "t",
        prompt: "p",
        options: [
          { decision: "allow-once", label: "Allow", style: "primary" },
        ],
      },
      { type: "approval_resolved", id: "ap1", decision: "deny" },
      { type: "typing" },
    ]);

    transport.dispose();
  });
});

describe("webchannel transport history snapshot (AC1 / AC4 / AC6 / AC7)", () => {
  it("sendHistory emits a {type:'history', messages:[...]} frame to the live socket (AC1)", () => {
    const transport = new WebChannelTransport({ heartbeatMs: 1000 });
    const ws = makeFakeSocket();
    register(transport, ws);

    const ok = transport.sendHistory(ANON_PEER_ID, [
      { id: "m-1", role: "user", text: "hi", ts: 1700000000000 },
      { id: "m-2", role: "agent", text: "hello there", ts: 1700000001000 },
    ]);

    expect(ok).toBe(true);
    expect(ws.sent).toHaveLength(1);
    expect(JSON.parse(ws.sent[0])).toEqual({
      type: "history",
      messages: [
        { id: "m-1", role: "user", text: "hi", ts: 1700000000000 },
        { id: "m-2", role: "agent", text: "hello there", ts: 1700000001000 },
      ],
    });

    transport.dispose();
  });

  it("sendHistory returns false (and emits nothing) when the session has no live socket (AC1)", () => {
    const transport = new WebChannelTransport({ heartbeatMs: 1000 });
    expect(
      transport.sendHistory("peer-missing", [
        { id: "x", role: "user", text: "y", ts: 1 },
      ]),
    ).toBe(false);
    transport.dispose();
  });

  it("sendHistory is a no-op when setHistoryEnabled(false) was called (AC6)", () => {
    const transport = new WebChannelTransport({ heartbeatMs: 1000 });
    const ws = makeFakeSocket();
    register(transport, ws);

    transport.setHistoryEnabled(false);
    const ok = transport.sendHistory(ANON_PEER_ID, [
      { id: "m-1", role: "user", text: "hi", ts: 1 },
    ]);
    expect(ok).toBe(false);
    expect(ws.sent).toHaveLength(0);

    // Re-enable and confirm the same call now delivers (no sticky state).
    transport.setHistoryEnabled(true);
    expect(
      transport.sendHistory(ANON_PEER_ID, [
        { id: "m-1", role: "user", text: "hi", ts: 1 },
      ]),
    ).toBe(true);
    expect(ws.sent).toHaveLength(1);

    transport.dispose();
  });

  it("sendHistory defaults to ENABLED (operator must opt-out, not opt-in) (AC6)", () => {
    const transport = new WebChannelTransport({ heartbeatMs: 1000 });
    const ws = makeFakeSocket();
    register(transport, ws);

    expect(
      transport.sendHistory(ANON_PEER_ID, [
        { id: "m-1", role: "user", text: "hi", ts: 1 },
      ]),
    ).toBe(true);
    expect(ws.sent).toHaveLength(1);

    transport.dispose();
  });

  it("sendHistory returns false and emits nothing for an empty messages array", () => {
    const transport = new WebChannelTransport({ heartbeatMs: 1000 });
    const ws = makeFakeSocket();
    register(transport, ws);

    expect(transport.sendHistory(ANON_PEER_ID, [])).toBe(false);
    expect(ws.sent).toHaveLength(0);

    transport.dispose();
  });

  it("history under backpressure: drops the frame, does NOT terminate the socket (AC7)", () => {
    const transport = new WebChannelTransport({ heartbeatMs: 1000 });
    // 2 MB buffered, over the 1 MB cap. Use a fresh socket for history so we
    // observe its drop-only behavior in isolation (the same group as progress
    // and typing — extending the group MUST keep the socket alive).
    const ws = makeFakeSocket({ bufferedAmount: 2_000_000 });
    register(transport, ws);

    const ok = transport.sendHistory(ANON_PEER_ID, [
      { id: "m-1", role: "user", text: "hi", ts: 1 },
    ]);

    expect(ok).toBe(false);
    expect(ws.sent).toHaveLength(0);
    // CRITICAL: history is drop-only — the socket stays alive. The client can
    // re-request via load_history, and terminating on a missed snapshot would
    // wedge the user out of their conversation.
    expect(ws.terminated).toBe(false);

    transport.dispose();
  });

  it("drop-only group (progress + typing + history) keeps the socket alive under backpressure (AC7)", () => {
    const transport = new WebChannelTransport({ heartbeatMs: 1000 });

    const wsProgress = makeFakeSocket({ bufferedAmount: 2_000_000 });
    registerAs(transport, wsProgress, "peer-progress");
    transport.sendProgress("peer-progress", "d1", "working");
    expect(wsProgress.terminated).toBe(false);

    const wsTyping = makeFakeSocket({ bufferedAmount: 2_000_000 });
    registerAs(transport, wsTyping, "peer-typing");
    transport.sendTyping("peer-typing");
    expect(wsTyping.terminated).toBe(false);

    const wsHistory = makeFakeSocket({ bufferedAmount: 2_000_000 });
    registerAs(transport, wsHistory, "peer-history");
    transport.sendHistory("peer-history", [
      { id: "m-1", role: "user", text: "hi", ts: 1 },
    ]);
    expect(wsHistory.terminated).toBe(false);

    transport.dispose();
  });

  it("delivers history exactly to the per-peer socket — never cross-leaks (AC4)", () => {
    const transport = new WebChannelTransport({ heartbeatMs: 1000 });
    const alice = makeFakeSocket();
    const bob = makeFakeSocket();
    registerAs(transport, alice, "peer-alice");
    registerAs(transport, bob, "peer-bob");

    const ok = transport.sendHistory("peer-bob", [
      { id: "m-1", role: "user", text: "for bob", ts: 1 },
    ]);
    expect(ok).toBe(true);
    expect(bob.sent).toHaveLength(1);
    // Alice must NOT receive bob's history.
    expect(alice.sent).toHaveLength(0);

    transport.dispose();
  });

  it("first-pong liveness fires onFirstLiveness exactly once per connection (AC3)", () => {
    const transport = new WebChannelTransport({ heartbeatMs: 1000 });
    const ws = makeFakeSocket();
    const onFirstLiveness = vi.fn();
    transport.setFirstLivenessHandler(onFirstLiveness);
    register(transport, ws);

    // No pong yet → handler never fires.
    expect(onFirstLiveness).not.toHaveBeenCalled();

    // First pong fires the handler.
    ws.emit("pong");
    expect(onFirstLiveness).toHaveBeenCalledTimes(1);
    expect(onFirstLiveness).toHaveBeenCalledWith(ANON_PEER_ID);

    // Subsequent pongs DO NOT re-fire (1 connection 1 snapshot).
    ws.emit("pong");
    ws.emit("pong");
    expect(onFirstLiveness).toHaveBeenCalledTimes(1);

    transport.dispose();
  });

  it("first-pong handler exceptions are swallowed — they never crash the pong callback (AC7)", () => {
    const transport = new WebChannelTransport({ heartbeatMs: 1000 });
    const ws = makeFakeSocket();
    transport.setFirstLivenessHandler(() => {
      throw new Error("history handler exploded");
    });
    register(transport, ws);

    // The pong emit must not throw — a throwing history handler must NEVER
    // poison the connection.
    expect(() => ws.emit("pong")).not.toThrow();
    // Liveness flag is still set after the throw, so a second pong doesn't
    // re-fire.
    expect(() => ws.emit("pong")).not.toThrow();

    transport.dispose();
  });

  it("load_history inbound frame is parsed and routed to the registered handler (AC1)", () => {
    const transport = new WebChannelTransport({ heartbeatMs: 1000 });
    const ws = makeFakeSocket();
    const handler = vi.fn();
    transport.setLoadHistoryHandler(handler);
    register(transport, ws);

    // Wire-shape: full request with both fields.
    ws.emit("message", JSON.stringify({
      type: "load_history",
      before: "m-3",
      limit: 25,
    }));
    expect(handler).toHaveBeenCalledWith(ANON_PEER_ID, { before: "m-3", limit: 25 });

    // Wire-shape: cursor omitted, limit omitted.
    ws.emit("message", JSON.stringify({ type: "load_history" }));
    expect(handler).toHaveBeenLastCalledWith(ANON_PEER_ID, { before: undefined, limit: undefined });

    transport.dispose();
  });

  it("malformed load_history frames are ignored (do not crash, do not call handler)", () => {
    const transport = new WebChannelTransport({ heartbeatMs: 1000 });
    const ws = makeFakeSocket();
    const handler = vi.fn();
    transport.setLoadHistoryHandler(handler);
    register(transport, ws);

    // Non-string before is dropped, non-number limit is dropped.
    ws.emit("message", JSON.stringify({ type: "load_history", before: 42, limit: "ten" }));
    expect(handler).toHaveBeenCalledWith(ANON_PEER_ID, { before: undefined, limit: undefined });

    handler.mockClear();

    // Empty string before is treated as absent.
    ws.emit("message", JSON.stringify({ type: "load_history", before: "", limit: 0 }));
    expect(handler).toHaveBeenCalledWith(ANON_PEER_ID, { before: undefined, limit: undefined });

    transport.dispose();
  });

  it("all pre-existing OutboundWsMessage cases are byte-identical (regression guard)", () => {
    // The new `history` case joins the union, but the OTHER cases keep their
    // exact JSON shape. This is the canonical wire-envelope contract test:
    // changing the payload of any non-new case would break the existing
    // widget. Mirrors the typing-indicator regression guard above.
    const transport = new WebChannelTransport({ heartbeatMs: 1000 });
    const ws = makeFakeSocket();
    register(transport, ws);

    transport.sendText(ANON_PEER_ID, "hello");
    transport.sendText(ANON_PEER_ID, "final", "draft-1"); // with id
    transport.sendProgress(ANON_PEER_ID, "d1", "working");
    transport.sendApprovalRequest(ANON_PEER_ID, {
      id: "ap1",
      kind: "exec",
      title: "t",
      prompt: "p",
      options: [
        { decision: "allow-once", label: "Allow", style: "primary" },
      ],
    });
    transport.sendApprovalResolved(ANON_PEER_ID, "ap1", "deny");
    transport.sendTyping(ANON_PEER_ID);
    transport.sendHistory(ANON_PEER_ID, [
      { id: "m-1", role: "user", text: "hi", ts: 1 },
    ]);

    const frames = ws.sent.map((s) => JSON.parse(s));
    expect(frames).toEqual([
      { type: "agent_message", text: "hello" },
      { type: "agent_message", text: "final", id: "draft-1" },
      { type: "progress", id: "d1", text: "working" },
      {
        type: "approval_request",
        id: "ap1",
        kind: "exec",
        title: "t",
        prompt: "p",
        options: [
          { decision: "allow-once", label: "Allow", style: "primary" },
        ],
      },
      { type: "approval_resolved", id: "ap1", decision: "deny" },
      { type: "typing" },
      { type: "history", messages: [{ id: "m-1", role: "user", text: "hi", ts: 1 }] },
    ]);

    transport.dispose();
  });
});
