import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { describe, expect, it, vi } from "vitest";

import {
  NatsConnectionClosedError,
  NatsLifecycleAbortError,
  NatsTransport,
  NatsUnexpectedResponseError,
} from "./nats-transport.js";

class FakeSocket extends EventEmitter {
  readyState: number = WebSocket.CONNECTING;
  sent: unknown[] = [];
  closeCalls = 0;
  terminateCalls = 0;
  closeConfirms = true;
  forceConfirms = true;
  closeThrows = false;
  forceThrows = false;
  send(value: unknown) { this.sent.push(value); }
  close() {
    this.closeCalls++;
    if (this.closeThrows) throw new Error("close failed");
    if (this.closeConfirms) { this.readyState = WebSocket.CLOSED; this.emit("close", 1000, Buffer.alloc(0)); }
  }
  terminate() {
    this.terminateCalls++;
    if (this.forceThrows) throw new Error("terminate failed");
    if (this.forceConfirms) { this.readyState = WebSocket.CLOSED; this.emit("close", 1006, Buffer.alloc(0)); }
  }
}

describe("NatsTransport startup ownership", () => {
  it("does not dial an already-aborted signal and aborts an in-flight handshake", async () => {
    let factoryCalls = 0;
    const socket = new FakeSocket();
    const transport = new NatsTransport({
      url: "ws://example",
      handshakeTimeoutMs: 0,
      _wsFactory: () => { factoryCalls++; return socket as unknown as WebSocket; },
    });
    const already = new AbortController(); already.abort();
    await expect(transport.connect(already.signal)).rejects.toBeInstanceOf(NatsLifecycleAbortError);
    expect(factoryCalls).toBe(0);

    const active = new AbortController();
    const connecting = transport.connect(active.signal);
    active.abort();
    await expect(connecting).rejects.toBeInstanceOf(NatsLifecycleAbortError);
    expect(socket.terminateCalls).toBe(1);
  });

  it.each([503, 401])("owns and destroys an unexpected HTTP %i upgrade response", async (statusCode) => {
      const socket = new FakeSocket();
      const transport = new NatsTransport({ url: "ws://example", handshakeTimeoutMs: 0, _wsFactory: () => socket as unknown as WebSocket });
      const connecting = transport.connect();
      const response = { statusCode, resume: vi.fn(), destroy: vi.fn(), socket: { destroy: vi.fn() } };
      socket.emit("unexpected-response", {}, response);
      const failure = await connecting.catch((error) => error);
      expect(failure).toBeInstanceOf(NatsUnexpectedResponseError);
      expect((failure as NatsUnexpectedResponseError).statusCode).toBe(statusCode);
      expect(response.resume).toHaveBeenCalledOnce();
      expect(response.destroy).toHaveBeenCalledOnce();
      expect(response.socket.destroy).toHaveBeenCalledOnce();
      expect(socket.terminateCalls).toBe(1);
    });

  it("removes handshake-only listeners on success and all owned listeners on shutdown", async () => {
    const socket = new FakeSocket();
    const transport = new NatsTransport({ url: "ws://example", handshakeTimeoutMs: 0, _wsFactory: () => socket as unknown as WebSocket });
    const connecting = transport.connect();
    socket.readyState = WebSocket.OPEN;
    socket.emit("open");
    socket.emit("message", Buffer.from("PONG\r\n"));
    await connecting;

    expect(socket.listenerCount("open")).toBe(0);
    expect(socket.listenerCount("unexpected-response")).toBe(0);
    expect(socket.listenerCount("message")).toBe(1);
    expect(socket.listenerCount("error")).toBe(1);
    expect(socket.listenerCount("close")).toBe(1);

    const report = await transport.closeGracefully(10, 10);
    expect(report.socketClosed).toBe(true);
    expect(socket.listenerCount("message")).toBe(0);
    expect(socket.listenerCount("error")).toBe(0);
    expect(socket.listenerCount("close")).toBe(0);
  });

  it("reports physical closure only from CLOSED/close evidence and retains a probe handle", async () => {
    vi.useFakeTimers();
    const socket = new FakeSocket();
    socket.readyState = WebSocket.OPEN;
    socket.closeConfirms = false;
    socket.forceConfirms = false;
    const transport = new NatsTransport({ url: "ws://example", _wsFactory: () => socket as unknown as WebSocket });
    void transport.connect().catch(() => {});
    const closing = transport.closeGracefully(10, 10);
    await vi.advanceTimersByTimeAsync(20);
    const report = await closing;
    expect(report).toMatchObject({ reconnectSuppressed: true, socketClosed: false, gracefulTimedOut: true, forcedTerminationAttempted: true });
    expect(report.closeHandle).toBeDefined();
    socket.forceConfirms = true;
    const probe = report.closeHandle!.probe();
    await vi.advanceTimersByTimeAsync(20);
    expect((await probe).socketClosed).toBe(true);
    vi.useRealTimers();
  });

  it("terminates CONNECTING immediately and escalates CLOSING only after the graceful bound", async () => {
    const connectingSocket = new FakeSocket();
    const connectingTransport = new NatsTransport({ url: "ws://example", _wsFactory: () => connectingSocket as unknown as WebSocket });
    void connectingTransport.connect().catch(() => {});
    expect(await connectingTransport.closeGracefully(10, 10)).toMatchObject({
      socketClosed: true,
      gracefulTimedOut: false,
      forcedTerminationAttempted: true,
    });
    expect(connectingSocket.closeCalls).toBe(0);
    expect(connectingSocket.terminateCalls).toBe(1);

    vi.useFakeTimers();
    const closingSocket = new FakeSocket();
    closingSocket.readyState = WebSocket.CLOSING;
    const closingTransport = new NatsTransport({ url: "ws://example", _wsFactory: () => closingSocket as unknown as WebSocket });
    void closingTransport.connect().catch(() => {});
    const closing = closingTransport.closeGracefully(10, 10);
    expect(closingSocket.terminateCalls).toBe(0);
    await vi.advanceTimersByTimeAsync(10);
    expect(await closing).toMatchObject({ socketClosed: true, gracefulTimedOut: true, forcedTerminationAttempted: true });
    expect(closingSocket.closeCalls).toBe(0);
    expect(closingSocket.terminateCalls).toBe(1);
    vi.useRealTimers();
  });

  it("escalates an OPEN socket whose graceful close never confirms, then confirms force", async () => {
    vi.useFakeTimers();
    const socket = new FakeSocket();
    socket.readyState = WebSocket.OPEN;
    socket.closeConfirms = false;
    const transport = new NatsTransport({ url: "ws://example", _wsFactory: () => socket as unknown as WebSocket });
    void transport.connect().catch(() => {});
    const closing = transport.closeGracefully(10, 10);
    await vi.advanceTimersByTimeAsync(10);
    expect(await closing).toMatchObject({ socketClosed: true, gracefulTimedOut: true, forcedTerminationAttempted: true });
    expect(socket.closeCalls).toBe(1);
    expect(socket.terminateCalls).toBe(1);
    vi.useRealTimers();
  });

  it("delivers a typed post-PONG disconnect cause to private lifecycle listeners", async () => {
    const socket = new FakeSocket();
    const transport = new NatsTransport({ url: "ws://example", handshakeTimeoutMs: 0, _wsFactory: () => socket as unknown as WebSocket });
    const connecting = transport.connect();
    socket.readyState = WebSocket.OPEN;
    socket.emit("open");
    socket.emit("message", Buffer.from("PONG\r\n"));
    await connecting;
    const causes: unknown[] = [];
    transport.on("disconnect", (cause) => causes.push(cause));
    socket.readyState = WebSocket.CLOSED;
    socket.emit("close", 1012, Buffer.alloc(0));
    expect(causes).toHaveLength(1);
    expect(causes[0]).toMatchObject({ name: "NatsConnectionClosedError", closeCode: 1012 });
    expect(causes[0]).toBeInstanceOf(NatsConnectionClosedError);
  });

  it("escalates a throwing graceful close immediately and reports a failed force truthfully", async () => {
    const socket = new FakeSocket();
    socket.readyState = WebSocket.OPEN;
    socket.closeThrows = true;
    socket.forceThrows = true;
    const transport = new NatsTransport({ url: "ws://example", _wsFactory: () => socket as unknown as WebSocket });
    void transport.connect().catch(() => {});
    const report = await transport.closeGracefully(10, 10);
    expect(report).toMatchObject({
      reconnectSuppressed: true,
      socketClosed: false,
      gracefulTimedOut: false,
      forcedTerminationAttempted: true,
    });
    expect(socket.closeCalls).toBe(1);
    expect(socket.terminateCalls).toBe(1);
  });
});
