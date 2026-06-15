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
