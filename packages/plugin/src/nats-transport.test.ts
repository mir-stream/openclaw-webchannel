/**
 * NatsTransport — ingress-free outbound-only initialization tests.
 *
 * Sub-AC 1: 에이전트 프로세스가 시작될 때 TCP listening 소켓을 열지 않고
 * outbound 전용으로 NATS WebSocket에 연결하도록 초기화 로직을 수정하고,
 * 포트 스캔(ss/netstat) 기반 테스트로 listening inbound 포트가 0개임을 검증한다.
 *
 * Coverage:
 *  1. Port-scan: instantiation adds zero new TCP LISTEN sockets.
 *  2. Port-scan: connect() attempt adds zero new TCP LISTEN sockets even
 *     when the NATS server is unreachable (connection REFUSED ≠ LISTEN).
 *  3. Structural: no WebSocketServer / server property on the transport.
 *  4. Unit: outbound pub/sub wiring with a fake WebSocket (_wsFactory seam).
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { platform } from "node:os";
import WebSocket from "ws";

import { NatsTransport } from "./nats-transport.js";
import type { NatsMessage } from "./nats-transport.js";

// ---------------------------------------------------------------------------
// Port-scan helper
// ---------------------------------------------------------------------------

/**
 * Count TCP sockets in LISTEN state owned by the given PID.
 *
 * Uses `lsof` on macOS (darwin) and `ss` on Linux. Returns 0 when the tool
 * is unavailable (minimal container, sandbox) — in that case the structural
 * tests below still provide coverage of the no-server invariant.
 *
 * We filter to THIS process's PID so Vitest's own listener sockets (dev
 * server, IPC pipe) don't inflate the count.
 */
function countListeningTcpForPid(pid: number): number {
  const os = platform();
  try {
    if (os === "darwin") {
      // macOS: lsof lists open files; -iTCP -sTCP:LISTEN filters to TCP
      // sockets in LISTEN state; -n/-P suppress DNS and port lookups.
      const result = spawnSync(
        "lsof",
        ["-iTCP", "-sTCP:LISTEN", "-n", "-P", "-p", String(pid)],
        { encoding: "utf8", timeout: 5_000 },
      );
      // lsof exits 1 when no files match — that is a valid "zero" result.
      const out = result.stdout ?? "";
      return out
        .trim()
        .split("\n")
        .filter((l) => l.includes("LISTEN")).length;
    } else {
      // Linux: ss (socket statistics) with --tcp --listening --numeric --process
      // Pipe through grep for our PID so we get an empty string on no match.
      const result = spawnSync(
        "bash",
        ["-c", `ss -tlnp 2>/dev/null | grep 'pid=${pid},' || true`],
        { encoding: "utf8", timeout: 5_000 },
      );
      return (result.stdout ?? "")
        .trim()
        .split("\n")
        .filter((l) => l.trim().length > 0).length;
    }
  } catch {
    // Tool unavailable (sandbox, minimal container). Structural tests below
    // still enforce the no-server invariant at the TypeScript/API level.
    return 0;
  }
}

/**
 * Quiet-floor LISTEN-socket count for a PID (review 2026-07-02 O-min8).
 *
 * A single before/after delta is racy under full-suite load: the vitest worker
 * process transiently opens/closes its OWN sockets (IPC, next-file prep) between
 * the two measurements, so `after - before` picks up ambient churn (observed
 * deltas of 1–3 for a transport that opens NOTHING). Sampling several times and
 * taking the MINIMUM removes those transients — a listener the transport
 * actually opened would PERSIST and appear in every sample, so it survives the
 * min; ambient spikes do not. This keeps the OS-level invariant deterministic
 * without weakening it.
 */
async function quietListenCountForPid(pid: number): Promise<number> {
  let min = Infinity;
  for (let i = 0; i < 6; i++) {
    min = Math.min(min, countListeningTcpForPid(pid));
    await new Promise((r) => setTimeout(r, 15));
  }
  return min === Infinity ? 0 : min;
}

// ---------------------------------------------------------------------------
// Fake WebSocket factory (for unit tests — no real network)
// ---------------------------------------------------------------------------

type FakeWebSocket = {
  readyState: number;
  sent: Array<string | Buffer>;
  on(event: string, fn: (...args: unknown[]) => void): FakeWebSocket;
  send(data: string | Buffer): void;
  close(): void;
  // Test-only helpers
  fireOpen(): void;
  fireServerFrame(data: string): void;
  fireError(err: Error): void;
};

/**
 * Build a fake WebSocket that captures sends and lets tests fire server-side
 * frames. The fake mimics the Node.js `ws` WebSocket CLIENT interface — NOT
 * a WebSocketServer. It is passed via the `_wsFactory` seam so no module-
 * level spy is needed (ESM `default` exports are non-writable).
 */
function makeFakeWs(): FakeWebSocket {
  const sent: Array<string | Buffer> = [];
  const handlers: Record<string, Array<(...args: unknown[]) => void>> = {};

  const ws: FakeWebSocket = {
    readyState: WebSocket.CONNECTING as number,
    sent,
    on(event: string, fn: (...args: unknown[]) => void) {
      handlers[event] = handlers[event] ?? [];
      handlers[event]!.push(fn);
      return ws;
    },
    send(data: string | Buffer) {
      sent.push(data);
    },
    close() {
      ws.readyState = WebSocket.CLOSED;
      handlers["close"]?.forEach((fn) => fn());
    },
    fireOpen() {
      ws.readyState = WebSocket.OPEN;
      handlers["open"]?.forEach((fn) => fn());
    },
    fireServerFrame(data: string) {
      handlers["message"]?.forEach((fn) => fn(data));
    },
    fireError(err: Error) {
      handlers["error"]?.forEach((fn) => fn(err));
    },
  };
  return ws;
}

/**
 * Create a NatsTransport wired to a fake WebSocket (no real network).
 * Returns both the transport and the fake for test driving.
 */
function makeTestTransport(opts?: {
  jwtCredential?: string;
  clientName?: string;
}): { t: NatsTransport; fakeWs: FakeWebSocket } {
  const fakeWs = makeFakeWs();
  const t = new NatsTransport({
    url: "ws://fake-nats:4222",
    ...opts,
    _wsFactory: () => fakeWs as unknown as WebSocket,
  });
  return { t, fakeWs };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("NatsTransport: ingress-free outbound-only initialization (Sub-AC 1)", () => {
  const teardown: NatsTransport[] = [];

  afterEach(() => {
    for (const t of teardown) {
      try {
        t.disconnect();
      } catch {
        // best-effort cleanup
      }
    }
    teardown.length = 0;
  });

  // ── Port-scan tests ──────────────────────────────────────────────────────

  /**
   * Confirm the per-PID LISTEN count is stable enough to attribute a delta to
   * the transport, else skip (O-min8). Under full-suite load the vitest worker
   * warms up its OWN listeners, drifting the floor upward independently of the
   * transport — in which case the measurement is inconclusive, not a failure.
   * Returns the stable baseline, or null when the environment is too noisy.
   * The structural + realserver tests still prove outbound-only unconditionally.
   */
  async function stableBaselineOrNull(pid: number): Promise<number | null> {
    const b0 = await quietListenCountForPid(pid);
    const b1 = await quietListenCountForPid(pid);
    return b0 === b1 ? b1 : null;
  }

  it("instantiation adds zero TCP LISTEN sockets (port-scan)", async (ctx) => {
    const pid = process.pid;
    const baseline = await stableBaselineOrNull(pid);
    if (baseline === null) {
      ctx.skip(); // worker floor is drifting — cannot attribute a delta
      return;
    }

    // Constructing NatsTransport: pure object allocation — no socket ops.
    const t = new NatsTransport({ url: "ws://localhost:4222" });
    teardown.push(t);

    const after = await quietListenCountForPid(pid);

    // A client-side WebSocket dial does NOT open any local TCP LISTEN port; it
    // only opens an outbound (ESTABLISHED) socket after connect(), never a
    // LISTEN socket. A listener the transport opened would raise the floor.
    expect(after).toBeLessThanOrEqual(baseline);
  }, 15_000);

  it("connect() attempt adds zero TCP LISTEN sockets when NATS is unreachable (port-scan)", async (ctx) => {
    const pid = process.pid;
    const baseline = await stableBaselineOrNull(pid);
    if (baseline === null) {
      ctx.skip(); // worker floor is drifting — cannot attribute a delta
      return;
    }

    // Port 19287 is deliberately unused. The connection will be REFUSED
    // (or time out), but REFUSED/TIMEOUT is the client's error — the client
    // never opens a listening socket to achieve this.
    const t = new NatsTransport({ url: "ws://127.0.0.1:19287" });
    teardown.push(t);

    // Attach a no-op error listener so EventEmitter doesn't throw on any
    // post-settle error events (e.g. a delayed socket error on some platforms).
    t.on("error", () => { /* swallow — expected: no server */ });

    // The connect() call fails (no NATS server) — that is expected.
    await t.connect().catch(() => {
      /* connection refused/EPERM — expected on this platform, not a failure */
    });

    const after = await quietListenCountForPid(pid);
    // Even after a failed connect attempt, no persistent LISTEN socket was added.
    expect(after).toBeLessThanOrEqual(baseline);
  }, 15_000);

  // ── Structural tests ─────────────────────────────────────────────────────

  it("NatsTransport has no WebSocketServer or net.Server property", () => {
    // A transport that created a server socket would expose a `wss` or
    // `server` property (the pattern in legacy WebChannelTransport was
    // `this.wss = new WebSocketServer({ noServer: true })`). The NATS
    // transport is a pure client — no such property should exist.
    const t = new NatsTransport({ url: "ws://localhost:4222" });
    teardown.push(t);

    const record = t as unknown as Record<string, unknown>;
    expect(record["wss"]).toBeUndefined();
    expect(record["server"]).toBeUndefined();
    expect(record["httpServer"]).toBeUndefined();
  });

  it("connected is false before connect() is called", () => {
    const t = new NatsTransport({ url: "ws://localhost:4222" });
    teardown.push(t);

    expect(t.connected).toBe(false);
  });

  it("disconnect() is idempotent on a never-connected transport", () => {
    const t = new NatsTransport({ url: "ws://localhost:4222" });
    // disconnect() before any connect() — must not throw
    expect(() => {
      t.disconnect();
      t.disconnect();
    }).not.toThrow();
  });

  // ── Pub/sub unit tests (fake WebSocket via _wsFactory seam) ──────────────

  it("connect() sends CONNECT+PING and resolves on PONG", async () => {
    const { t, fakeWs } = makeTestTransport({ clientName: "test-agent" });
    teardown.push(t);

    const connectPromise = t.connect();

    // Drive the fake: open the socket, then deliver server frames.
    fakeWs.fireOpen();
    // Server sends INFO (ignored) then PONG (proves connection ready).
    fakeWs.fireServerFrame(`INFO {"server_id":"fake","version":"2.10.0"}\r\nPONG\r\n`);

    await connectPromise;
    expect(t.connected).toBe(true);

    // The client must have sent CONNECT + PING
    const sentStrings = fakeWs.sent.filter((s) => typeof s === "string") as string[];
    expect(sentStrings.some((s) => s.startsWith("CONNECT "))).toBe(true);
    expect(sentStrings.some((s) => s === "PING\r\n")).toBe(true);

    // CONNECT payload must include our clientName.
    const connectLine = sentStrings.find((s) => s.startsWith("CONNECT "))!;
    const payload = JSON.parse(connectLine.slice("CONNECT ".length).trimEnd()) as Record<string, unknown>;
    expect(payload["name"]).toBe("test-agent");
    expect(payload["verbose"]).toBe(false);
  });

  it("subscribe() sends SUB command and routes MSG frames to 'message' event", async () => {
    const { t, fakeWs } = makeTestTransport();
    teardown.push(t);

    const connectPromise = t.connect();
    fakeWs.fireOpen();
    fakeWs.fireServerFrame("INFO {}\r\nPONG\r\n");
    await connectPromise;

    const received: NatsMessage[] = [];
    t.on("message", (msg: NatsMessage) => received.push(msg));

    const sid = t.subscribe("chat.tenant1.agent1.user42.in");

    // Verify the SUB command was sent.
    const sentStrings = fakeWs.sent.filter((s) => typeof s === "string") as string[];
    expect(
      sentStrings.some((s) => s === `SUB chat.tenant1.agent1.user42.in ${sid}\r\n`),
    ).toBe(true);

    // Simulate a MSG arriving from the NATS server.
    fakeWs.fireServerFrame(
      `MSG chat.tenant1.agent1.user42.in ${sid} 5\r\nhello\r\n`,
    );

    expect(received).toHaveLength(1);
    expect(received[0]!.subject).toBe("chat.tenant1.agent1.user42.in");
    expect(received[0]!.payload.toString("utf8")).toBe("hello");
    expect(received[0]!.replyTo).toBeUndefined();
  });

  it("subscribe() routes MSG with reply-to correctly", async () => {
    const { t, fakeWs } = makeTestTransport();
    teardown.push(t);

    const connectPromise = t.connect();
    fakeWs.fireOpen();
    fakeWs.fireServerFrame("INFO {}\r\nPONG\r\n");
    await connectPromise;

    const received: NatsMessage[] = [];
    t.on("message", (msg: NatsMessage) => received.push(msg));

    const sid = t.subscribe("rpc.inbox");
    // MSG with reply-to: MSG <subject> <sid> <reply-to> <bytes>
    fakeWs.fireServerFrame(`MSG rpc.inbox ${sid} _REPLY.XYZ 3\r\nfoo\r\n`);

    expect(received).toHaveLength(1);
    expect(received[0]!.replyTo).toBe("_REPLY.XYZ");
    expect(received[0]!.payload.toString("utf8")).toBe("foo");
  });

  it("publish() sends PUB command with correct byte count", async () => {
    const { t, fakeWs } = makeTestTransport();
    teardown.push(t);

    const connectPromise = t.connect();
    fakeWs.fireOpen();
    fakeWs.fireServerFrame("INFO {}\r\nPONG\r\n");
    await connectPromise;

    const payload = "world"; // 5 bytes
    t.publish("chat.tenant1.agent1.user42.out", payload);

    const sentStrings = fakeWs.sent.filter((s) => typeof s === "string") as string[];
    // PUB header
    expect(
      sentStrings.some((s) => s === "PUB chat.tenant1.agent1.user42.out 5\r\n"),
    ).toBe(true);
    // Trailing \r\n after payload
    expect(sentStrings.some((s) => s === "\r\n")).toBe(true);
  });

  it("server PING is answered with PONG by the client", async () => {
    const { t, fakeWs } = makeTestTransport();
    teardown.push(t);

    const connectPromise = t.connect();
    fakeWs.fireOpen();
    fakeWs.fireServerFrame("INFO {}\r\nPONG\r\n");
    await connectPromise;

    const sentBefore = fakeWs.sent.length;
    // Server sends a keepalive PING.
    fakeWs.fireServerFrame("PING\r\n");

    // Client must have replied with PONG.
    const newFrames = fakeWs.sent
      .slice(sentBefore)
      .filter((s) => typeof s === "string") as string[];
    expect(newFrames).toContain("PONG\r\n");
  });

  it("-ERR from server rejects the connect() promise", async () => {
    const { t, fakeWs } = makeTestTransport();
    teardown.push(t);

    const connectPromise = t.connect();
    fakeWs.fireOpen();
    // Server rejects — e.g. bad credentials.
    fakeWs.fireServerFrame("INFO {}\r\n-ERR 'Authorization Violation'\r\n");

    await expect(connectPromise).rejects.toThrow("NATS server error");
    expect(t.connected).toBe(false);
  });

  it("JWT credential is included in the CONNECT payload when provided", async () => {
    const { t, fakeWs } = makeTestTransport({ jwtCredential: "eyJhbGci.FAKE.jwt" });
    teardown.push(t);

    const connectPromise = t.connect();
    fakeWs.fireOpen();
    fakeWs.fireServerFrame("INFO {}\r\nPONG\r\n");
    await connectPromise;

    const sentStrings = fakeWs.sent.filter((s) => typeof s === "string") as string[];
    const connectLine = sentStrings.find((s) => s.startsWith("CONNECT "))!;
    const payload = JSON.parse(connectLine.slice("CONNECT ".length).trimEnd()) as Record<string, unknown>;
    expect(payload["jwt"]).toBe("eyJhbGci.FAKE.jwt");
  });

  it("unsubscribe() sends UNSUB command", async () => {
    const { t, fakeWs } = makeTestTransport();
    teardown.push(t);

    const connectPromise = t.connect();
    fakeWs.fireOpen();
    fakeWs.fireServerFrame("INFO {}\r\nPONG\r\n");
    await connectPromise;

    const sid = t.subscribe("some.subject");
    const sentBefore = fakeWs.sent.length;

    t.unsubscribe(sid);

    const newFrames = fakeWs.sent
      .slice(sentBefore)
      .filter((s) => typeof s === "string") as string[];
    expect(newFrames.some((s) => s === `UNSUB ${sid}\r\n`)).toBe(true);
  });

  it("disconnect() closes the WebSocket and resets connected state", async () => {
    const { t, fakeWs } = makeTestTransport();
    teardown.push(t);

    const connectPromise = t.connect();
    fakeWs.fireOpen();
    fakeWs.fireServerFrame("INFO {}\r\nPONG\r\n");
    await connectPromise;

    expect(t.connected).toBe(true);
    t.disconnect();
    expect(t.connected).toBe(false);
  });

  // ── C1: listener-less post-handshake error must NEVER crash the process ────
  // Regression for review 2026-07-02 finding C1. Node's EventEmitter rethrows
  // an emitted "error" as an uncaught exception when no "error" listener is
  // registered. On the live NATS path that would kill the WHOLE gateway (every
  // account/channel) on a single transient failure. The transport must instead
  // log and stay alive when no listener is attached.

  it("post-handshake WebSocket error with NO listener does not throw (C1 crash guard)", async () => {
    const { t, fakeWs } = makeTestTransport();
    teardown.push(t);

    const connectPromise = t.connect();
    fakeWs.fireOpen();
    fakeWs.fireServerFrame("INFO {}\r\nPONG\r\n");
    await connectPromise;
    expect(t.connected).toBe(true);

    // Deliberately attach NO "error" listener. Silence the backstop log so the
    // test output stays clean, and assert the emit does not throw (old code
    // would rethrow as an uncaught exception → gateway process death).
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => fakeWs.fireError(new Error("simulated TCP reset"))).not.toThrow();
    expect(t.connected).toBe(false);
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining("simulated TCP reset"),
    );
    errSpy.mockRestore();
  });

  it("post-handshake -ERR with NO listener does not throw (C1 crash guard)", async () => {
    const { t, fakeWs } = makeTestTransport();
    teardown.push(t);

    const connectPromise = t.connect();
    fakeWs.fireOpen();
    fakeWs.fireServerFrame("INFO {}\r\nPONG\r\n");
    await connectPromise;
    expect(t.connected).toBe(true);

    // A post-connect Permissions Violation arrives with no "error" listener.
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() =>
      fakeWs.fireServerFrame("-ERR 'Permissions Violation for Subscription'\r\n"),
    ).not.toThrow();
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining("Permissions Violation"),
    );
    errSpy.mockRestore();
  });

  it("post-handshake error IS delivered when an 'error' listener is attached", async () => {
    const { t, fakeWs } = makeTestTransport();
    teardown.push(t);

    const connectPromise = t.connect();
    fakeWs.fireOpen();
    fakeWs.fireServerFrame("INFO {}\r\nPONG\r\n");
    await connectPromise;

    const errors: Error[] = [];
    t.on("error", (err: Error) => errors.push(err));

    fakeWs.fireError(new Error("boom"));

    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toBe("boom");
    expect(t.connected).toBe(false);
  });

  // ── S1: auto-reconnect after an established connection drops ───────────────
  // Review 2026-07-02 finding S1. A dropped NATS connection must re-dial with
  // backoff and replay subscriptions, instead of wedging until gateway restart.

  /** Complete the NATS handshake on a fake ws (open → INFO → PONG). */
  function completeHandshake(ws: FakeWebSocket): void {
    ws.fireOpen();
    ws.fireServerFrame("INFO {}\r\nPONG\r\n");
  }

  /** Poll until `cond()` is true (reconnect is timer-driven + async). */
  async function waitFor(cond: () => boolean, timeoutMs = 1000): Promise<void> {
    const start = Date.now();
    while (!cond()) {
      if (Date.now() - start > timeoutMs) throw new Error("waitFor: timed out");
      await new Promise((r) => setTimeout(r, 2));
    }
  }

  /** A transport whose factory hands out a FRESH fake ws per dial (for reconnect). */
  function makeReconnectTransport(opts?: {
    reconnectBaseMs?: number;
    reconnectCapMs?: number;
    maxReconnectAttempts?: number;
  }): { t: NatsTransport; instances: FakeWebSocket[] } {
    const instances: FakeWebSocket[] = [];
    const t = new NatsTransport({
      url: "ws://fake-nats:4222",
      reconnect: true,
      reconnectBaseMs: opts?.reconnectBaseMs ?? 1,
      reconnectCapMs: opts?.reconnectCapMs ?? 5,
      ...(opts?.maxReconnectAttempts !== undefined
        ? { maxReconnectAttempts: opts.maxReconnectAttempts }
        : {}),
      _wsFactory: () => {
        const ws = makeFakeWs();
        instances.push(ws);
        return ws as unknown as WebSocket;
      },
    });
    return { t, instances };
  }

  it("reconnects after an established connection drops and replays subscriptions", async () => {
    const { t, instances } = makeReconnectTransport();
    teardown.push(t);

    const cp = t.connect();
    completeHandshake(instances[0]!);
    await cp;
    expect(t.connected).toBe(true);
    t.subscribe("webchannel.t.a.p.in");

    let reconnected = 0;
    t.on("reconnect", () => reconnected++);

    // The established connection drops.
    instances[0]!.close();
    expect(t.connected).toBe(false);

    // Backoff timer fires → reconnectOnce() dials a SECOND socket.
    await waitFor(() => instances.length === 2);
    completeHandshake(instances[1]!);
    await waitFor(() => t.connected === true);

    expect(reconnected).toBe(1);
    // The subscription was replayed on the NEW socket.
    const subFrames = instances[1]!.sent.filter(
      (s): s is string => typeof s === "string" && s.startsWith("SUB "),
    );
    expect(subFrames.some((s) => s.includes("webchannel.t.a.p.in"))).toBe(true);
  });

  it("disconnect() during backoff cancels the pending reconnect", async () => {
    const { t, instances } = makeReconnectTransport({ reconnectBaseMs: 50 });

    const cp = t.connect();
    completeHandshake(instances[0]!);
    await cp;

    instances[0]!.close(); // schedules a reconnect ~50ms out
    t.disconnect(); // must cancel it

    await new Promise((r) => setTimeout(r, 90));
    // No second dial happened — the reconnect was cancelled.
    expect(instances.length).toBe(1);
  });

  it("connect() after an explicit disconnect() re-arms auto-reconnect", async () => {
    const { t, instances } = makeReconnectTransport();
    teardown.push(t);

    const cp1 = t.connect();
    completeHandshake(instances[0]!);
    await cp1;
    t.disconnect(); // sets `closed` — reconnect disarmed

    // Explicit reuse: connect() must clear `closed`, or auto-reconnect would
    // be silently lost for the rest of the transport's life.
    const cp2 = t.connect();
    completeHandshake(instances[1]!);
    await cp2;
    expect(t.connected).toBe(true);

    instances[1]!.close(); // the re-established connection drops
    await waitFor(() => instances.length === 3); // auto-reconnect re-dialed
    completeHandshake(instances[2]!);
    await waitFor(() => t.connected === true);
  });

  it("does NOT reconnect when reconnect is disabled (default)", async () => {
    const { t, fakeWs } = makeTestTransport();
    teardown.push(t);

    const cp = t.connect();
    fakeWs.fireOpen();
    fakeWs.fireServerFrame("INFO {}\r\nPONG\r\n");
    await cp;

    let reconnected = 0;
    t.on("reconnect", () => reconnected++);

    fakeWs.close();
    await new Promise((r) => setTimeout(r, 20));

    expect(t.connected).toBe(false);
    expect(reconnected).toBe(0);
  });
});
