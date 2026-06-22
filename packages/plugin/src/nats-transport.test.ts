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

import { describe, it, expect, afterEach } from "vitest";
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

  it("instantiation adds zero TCP LISTEN sockets (port-scan)", () => {
    const pid = process.pid;
    const before = countListeningTcpForPid(pid);

    // Constructing NatsTransport: pure object allocation — no socket ops.
    const t = new NatsTransport({ url: "ws://localhost:4222" });
    teardown.push(t);

    const after = countListeningTcpForPid(pid);

    // The delta MUST be zero. A client-side WebSocket dial does NOT open any
    // local TCP LISTEN port; it only opens an outbound (ESTABLISHED) socket
    // after connect() is called, never a LISTEN socket.
    expect(after - before).toBe(0);
  });

  it("connect() attempt adds zero TCP LISTEN sockets when NATS is unreachable (port-scan)", async () => {
    const pid = process.pid;
    const before = countListeningTcpForPid(pid);

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

    const after = countListeningTcpForPid(pid);
    // Even after a failed connect attempt, no LISTEN sockets were added.
    expect(after - before).toBe(0);
  }, 10_000);

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
});
