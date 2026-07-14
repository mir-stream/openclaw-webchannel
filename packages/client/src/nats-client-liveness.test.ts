/**
 * CL2 (terminal auth failure) + CL3 (client liveness heartbeat) tests for the
 * low-level NatsClient.
 *
 * CL2: an authoritative `-ERR` auth rejection must stop reconnecting and surface
 * to onError, while a per-subject permissions `-ERR` must NOT (the connection
 * stays up).
 *
 * CL3: while connected the client PINGs on an interval; a missed PONG (half-open
 * socket) forces a teardown + reconnect instead of silently losing messages.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NatsClient } from "./nats-client.js";

// ---------------------------------------------------------------------------
// Controllable fake nats-server WebSocket (non-NKEY path: CONNECT on open).
// ---------------------------------------------------------------------------
class FakeWS {
  static instances: FakeWS[] = [];
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  /** When false, the server ignores client PINGs (simulates a dead link). */
  static respondPong = true;

  url: string;
  binaryType = "blob";
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  onclose: (() => void) | null = null;
  closed = false;
  pings = 0;

  constructor(url: string) {
    this.url = url;
    FakeWS.instances.push(this);
    queueMicrotask(() => {
      this.readyState = FakeWS.OPEN;
      this.onopen?.();
    });
  }

  send(data: string): void {
    if (data.startsWith("CONNECT")) return;
    if (data.startsWith("PING")) {
      this.pings += 1;
      if (FakeWS.respondPong) this.emit("PONG\r\n");
      return;
    }
    // SUB/PUB/UNSUB/PONG — irrelevant here.
  }

  close(): void {
    this.readyState = FakeWS.CLOSED;
    this.closed = true;
    this.onclose?.();
  }

  /** Inject a server→client protocol frame. */
  serverEmit(frame: string): void {
    this.emit(frame);
  }

  private emit(frame: string): void {
    this.onmessage?.({ data: frame });
  }
}

let originalWebSocket: unknown;

beforeEach(() => {
  originalWebSocket = (globalThis as { WebSocket?: unknown }).WebSocket;
  (globalThis as { WebSocket: unknown }).WebSocket = FakeWS;
  FakeWS.instances = [];
  FakeWS.respondPong = true;
});

afterEach(() => {
  (globalThis as { WebSocket: unknown }).WebSocket = originalWebSocket;
  vi.useRealTimers();
});

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("CL2 — terminal auth failure", () => {
  it("stops reconnecting and fires onError on an authorization -ERR", async () => {
    const client = new NatsClient({
      url: "ws://127.0.0.1:4222",
      accountId: "a",
      tenant: "t",
      peerId: "p",
      heartbeatIntervalMs: 0, // isolate CL2 from the heartbeat
    });
    const errors: Error[] = [];
    const causes: Array<string | undefined> = [];
    client.onError((e, cause) => { errors.push(e); causes.push(cause); });
    let lastConnected = false;
    client.onState((c) => { lastConnected = c; });

    client.connect();
    await flush();
    expect(lastConnected).toBe(true);
    const ws = FakeWS.instances[0];

    // Server rejects the credentials authoritatively.
    ws.serverEmit("-ERR 'Authorization Violation'\r\n");
    await flush();

    expect(errors).toHaveLength(1);
    expect(errors[0].message).toMatch(/authorization/i);
    // P1-7: a violation is a credential never/no-longer acceptable → auth-rejected.
    expect(causes).toEqual(["auth-rejected"]);
    expect(lastConnected).toBe(false);
    expect(ws.closed).toBe(true);

    // No reconnect: give it ample time; the instance count must not grow.
    await new Promise((r) => setTimeout(r, 50));
    expect(FakeWS.instances).toHaveLength(1);
  });

  it("does NOT treat a per-subject permissions -ERR as terminal", async () => {
    const client = new NatsClient({
      url: "ws://127.0.0.1:4222",
      accountId: "a",
      tenant: "t",
      peerId: "p",
      heartbeatIntervalMs: 0,
    });
    const errors: Error[] = [];
    client.onError((e) => errors.push(e));
    let lastConnected = false;
    client.onState((c) => { lastConnected = c; });

    client.connect();
    await flush();
    const ws = FakeWS.instances[0];

    ws.serverEmit("-ERR 'Permissions Violation for Subscription to \"foo.bar\"'\r\n");
    await flush();

    // Non-terminal: no onError, connection stays up, socket not closed.
    expect(errors).toHaveLength(0);
    expect(lastConnected).toBe(true);
    expect(ws.closed).toBe(false);

    client.disconnect();
  });

  it("treats an -ERR 'Authentication Timeout' as TRANSIENT, not terminal", async () => {
    const client = new NatsClient({
      url: "ws://127.0.0.1:4222",
      accountId: "a",
      tenant: "t",
      peerId: "p",
      heartbeatIntervalMs: 0,
    });
    const errors: Error[] = [];
    client.onError((e) => errors.push(e));

    client.connect();
    await flush();
    const ws = FakeWS.instances[0];

    // A slow/sleeping client can miss the auth window — retrying WILL work, so
    // this must not become terminal (review finding #2).
    ws.serverEmit("-ERR 'Authentication Timeout'\r\n");
    await flush();

    expect(errors).toHaveLength(0);
    expect(ws.closed).toBe(false);

    client.disconnect();
  });

  it("treats an -ERR 'User Authentication Expired' as terminal", async () => {
    const client = new NatsClient({
      url: "ws://127.0.0.1:4222",
      accountId: "a",
      tenant: "t",
      peerId: "p",
      heartbeatIntervalMs: 0,
    });
    const errors: Error[] = [];
    const causes: Array<string | undefined> = [];
    client.onError((e, cause) => { errors.push(e); causes.push(cause); });

    client.connect();
    await flush();
    FakeWS.instances[0].serverEmit("-ERR 'User Authentication Expired'\r\n");
    await flush();

    expect(errors).toHaveLength(1); // expired creds → terminal
    // P1-7: a TTL lapse on a valid credential → auth-expired (distinct from a
    // violation), so scene ⑤ can say "Credentials expired". The human message
    // matches the cause: "credentials expired", NOT the violation path's
    // "authorization rejected" (which would read discordant under that heading).
    expect(errors[0].message).toMatch(/credentials expired/i);
    expect(errors[0].message).not.toMatch(/authorization rejected/i);
    expect(causes).toEqual(["auth-expired"]);
  });
});

describe("NatsClient — partial MSG framing (no infinite loop)", () => {
  it("handles a MSG payload split across two socket frames without hanging", async () => {
    const client = new NatsClient({
      url: "ws://127.0.0.1:4222",
      accountId: "a",
      tenant: "t",
      peerId: "p",
      heartbeatIntervalMs: 0,
    });
    const got: Array<[string, string]> = [];
    client.onRawMessage((s, p) => got.push([s, p]));

    client.connect();
    await flush();
    const ws = FakeWS.instances[0];

    // Header + only PART of the 5-byte payload. Before the fix, drainBuffer would
    // re-extract the same header forever (synchronous infinite loop → tab freeze).
    ws.serverEmit("MSG foo.bar 1 5\r\nHel");
    await flush();
    expect(got).toHaveLength(0); // incomplete, but crucially did NOT hang

    ws.serverEmit("lo\r\n"); // remainder arrives
    await flush();
    expect(got).toEqual([["foo.bar", "Hello"]]);

    client.disconnect();
  });
});

describe("CL3 — heartbeat liveness", () => {
  it("PINGs on the interval while the link is healthy", async () => {
    vi.useFakeTimers();
    const client = new NatsClient({
      url: "ws://127.0.0.1:4222",
      accountId: "a",
      tenant: "t",
      peerId: "p",
      heartbeatIntervalMs: 100,
    });
    client.connect();
    await vi.advanceTimersByTimeAsync(1); // flush open → CONNECT → PONG → connected
    const ws = FakeWS.instances[0];
    const pingsAfterConnect = ws.pings; // the connect handshake PING

    await vi.advanceTimersByTimeAsync(350); // ~3 heartbeat ticks
    expect(ws.pings).toBeGreaterThan(pingsAfterConnect);
    // Healthy link (server PONGs) → no teardown, no reconnect.
    expect(ws.closed).toBe(false);
    expect(FakeWS.instances).toHaveLength(1);

    client.disconnect();
  });

  it("forces a reconnect when a PONG is missed (half-open socket)", async () => {
    vi.useFakeTimers();
    const client = new NatsClient({
      url: "ws://127.0.0.1:4222",
      accountId: "a",
      tenant: "t",
      peerId: "p",
      heartbeatIntervalMs: 100,
      reconnectBaseMs: 10,
      reconnectCapMs: 10,
    });
    client.connect();
    await vi.advanceTimersByTimeAsync(1); // connected
    const first = FakeWS.instances[0];

    // Link goes half-open: server stops answering PINGs.
    FakeWS.respondPong = false;

    // Tick 1 sends a PING (unanswered); tick 2 detects the miss → forceReconnect.
    await vi.advanceTimersByTimeAsync(250);
    expect(first.closed).toBe(true);

    // The scheduled reconnect (base/cap = 10ms) dials a fresh socket.
    await vi.advanceTimersByTimeAsync(20);
    expect(FakeWS.instances.length).toBeGreaterThan(1);

    client.disconnect();
  });
});
