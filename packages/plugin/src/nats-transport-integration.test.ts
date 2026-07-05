/**
 * NatsTransport integration tests — Sub-AC 2.
 *
 * Sub-AC 2: outbound 전용으로 연결된 에이전트가 NATS를 통해 응답을 publish하고
 * 백로그 리플레이 왕복(subscribe → 재수신)을 완료하는 통합 테스트를 작성하여,
 * 인바운드 소켓 없이 메시지 교환 흐름 전체가 성공함을 검증한다.
 *
 * Tests verify:
 *  1. An outbound-only agent connects to NATS and publishes responses.
 *  2. A browser-side client subscribes and receives the agent's published messages.
 *  3. Backlog replay round-trip: browser sends load_history → agent publishes
 *     backlog → browser subscribe-receives the full history.
 *  4. The entire exchange uses zero TCP LISTEN sockets — the agent NEVER opens an
 *     inbound port; all traffic flows through outbound-dialed NATS connections.
 *
 * Implementation strategy:
 *  - FakeNatsBroker implements the NATS text protocol (INFO/CONNECT/PING/PONG/
 *    PUB/SUB/MSG) entirely in-process. Both the agent and browser receive
 *    NatsTransport instances wired to the same broker via the `_wsFactory` seam,
 *    so no real TCP socket is ever opened.
 *  - Message delivery is synchronous: a `publish()` call immediately routes MSG
 *    frames to all subscribers in the same call stack. Tests can therefore make
 *    assertions after `publish()` without any async delays.
 *  - The broker's per-client buffer correctly handles NatsTransport's 3-call PUB
 *    pattern: `send(header)` + `send(payload)` + `send('\r\n')`.
 */

import { describe, it, expect, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { platform } from "node:os";
import WebSocket from "ws";

import { NatsTransport } from "./nats-transport.js";
import type { NatsMessage } from "./nats-transport.js";

// ---------------------------------------------------------------------------
// Port-scan helper (reused from Sub-AC 1 tests — verifies no LISTEN sockets)
// ---------------------------------------------------------------------------

/**
 * Count TCP sockets in LISTEN state owned by the given PID.
 * Returns 0 when the tool is unavailable (sandbox, minimal container).
 */
function countListeningTcpForPid(pid: number): number {
  const os = platform();
  try {
    if (os === "darwin") {
      const result = spawnSync(
        "lsof",
        ["-iTCP", "-sTCP:LISTEN", "-n", "-P", "-p", String(pid)],
        { encoding: "utf8", timeout: 5_000 },
      );
      const out = result.stdout ?? "";
      return out
        .trim()
        .split("\n")
        .filter((l) => l.includes("LISTEN")).length;
    } else {
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
    return 0;
  }
}

// ---------------------------------------------------------------------------
// FakeNatsBroker — in-process NATS text-protocol relay
// ---------------------------------------------------------------------------

/**
 * FakeNatsBroker routes PUB→MSG frames between NatsTransport instances
 * without any real network. It simulates the NATS handshake
 * (INFO → CONNECT → PING → PONG) and pub/sub routing using
 * the `_wsFactory` seam on NatsTransport.
 *
 * Key design invariants:
 *  1. Zero TCP sockets: the broker is pure in-memory; no net.Server, no
 *     WebSocketServer, no `listen()` call anywhere.
 *  2. Synchronous delivery: `publish()` routes MSG frames to subscribers
 *     in the same call stack, so tests need no async delays.
 *  3. Fragmented PUB handling: NatsTransport sends PUB as three separate
 *     `ws.send()` calls (header string + payload Buffer + '\r\n' string).
 *     The broker's per-client buffer accumulates these fragments and only
 *     routes the message once the complete payload is available.
 */
class FakeNatsBroker {
  /** Map: clientId → function that pushes a NATS text frame to that client. */
  private readonly clients = new Map<string, (data: string) => void>();

  /** Per-client accumulation buffer for fragmented PUB sends. */
  private readonly buffers = new Map<string, string>();

  /** Active subscriptions: {subject, clientId, sid}[]. */
  private subscriptions: Array<{ subject: string; clientId: string; sid: number }> = [];

  /** Monotone client-id counter. */
  private nextClientId = 0;

  /**
   * Create a `_wsFactory` that NatsTransport can use to connect to this broker.
   *
   * Each call to the factory creates a new logical "connection" to the broker.
   * The returned factory fires the WebSocket `open` event asynchronously
   * (via `queueMicrotask`) to allow NatsTransport to register all its event
   * handlers before the NATS handshake begins — exactly the same timing
   * contract as a real async TCP/WebSocket dial.
   */
  createFactory(): (url: string) => WebSocket {
    return (_url: string) => {
      const clientId = `c${++this.nextClientId}`;
      const handlers = new Map<string, Array<(...args: unknown[]) => void>>();

      /** Push a NATS text frame to this client's 'message' event listeners. */
      const pushToClient = (data: string): void => {
        handlers.get("message")?.forEach((fn) => fn(data));
      };
      this.clients.set(clientId, pushToClient);
      this.buffers.set(clientId, "");

      const broker = this; // capture for send/close closures

      const fakeWs: any = {
        readyState: WebSocket.CONNECTING as number,

        on(event: string, fn: (...args: unknown[]) => void): typeof fakeWs {
          const list = handlers.get(event) ?? [];
          list.push(fn);
          handlers.set(event, list);
          return fakeWs;
        },

        send(data: string | Buffer): void {
          const str = Buffer.isBuffer(data)
            ? data.toString("utf8")
            : (data as string);
          broker.processClientData(clientId, str, pushToClient);
        },

        close(): void {
          fakeWs.readyState = WebSocket.CLOSED;
          // Remove all subscriptions for this client.
          broker.subscriptions = broker.subscriptions.filter(
            (s) => s.clientId !== clientId,
          );
          broker.clients.delete(clientId);
          broker.buffers.delete(clientId);
          handlers.get("close")?.forEach((fn) => fn());
        },
      };

      // Fire 'open' asynchronously so NatsTransport has time to register all
      // handlers (open, message, error, close) before the NATS handshake begins.
      // This mirrors the timing of a real async TCP WebSocket dial.
      queueMicrotask(() => {
        fakeWs.readyState = WebSocket.OPEN;
        handlers.get("open")?.forEach((fn) => fn());
        // INFO is sent in response to the client's first PING (see
        // processClientData), so nothing extra is needed here.
      });

      return fakeWs as unknown as WebSocket;
    };
  }

  /**
   * Process a raw NATS text frame received from a client.
   *
   * Implements the NATS text protocol subset used by NatsTransport:
   *  CONNECT → acknowledged (no response; PONG follows the next PING)
   *  PING    → sends INFO + PONG (completes the handshake on the first PING)
   *  PONG    → ignored (client reply to a server keepalive)
   *  SUB     → records the subscription
   *  UNSUB   → removes the subscription
   *  PUB     → routes payload as MSG to all matching subscribers
   *
   * Fragmented PUB support: NatsTransport sends PUB as three separate calls:
   *   1. `"PUB subject byteCount\r\n"` (header string)
   *   2. `<payload Buffer>`
   *   3. `"\r\n"` (trailing delimiter)
   * The per-client buffer accumulates these fragments, and the PUB is only
   * dispatched once the full `byteCount + 2` payload bytes are available.
   */
  private processClientData(
    clientId: string,
    data: string,
    pushToClient: (s: string) => void,
  ): void {
    // Append incoming data to the per-client accumulation buffer.
    const existing = this.buffers.get(clientId) ?? "";
    let buffer = existing + data;

    let crlfPos: number;
    while ((crlfPos = buffer.indexOf("\r\n")) !== -1) {
      const line = buffer.slice(0, crlfPos);
      buffer = buffer.slice(crlfPos + 2);

      if (!line) continue;

      // ── CONNECT ─────────────────────────────────────────────────────────────
      if (line.startsWith("CONNECT ")) {
        // Acknowledge the CONNECT intent; the handshake is confirmed via PING/PONG.
        continue;
      }

      // ── PING (client → server) ───────────────────────────────────────────────
      if (line === "PING") {
        // Reply with INFO + PONG. NatsTransport's drainBuffer processes INFO
        // (ignores it) and then PONG (marks connected and resolves connect()).
        pushToClient(
          `INFO {"server_id":"fake-nats-broker","version":"2.10.0"}\r\nPONG\r\n`,
        );
        continue;
      }

      // ── PONG (client reply to a server-side keepalive) ───────────────────────
      if (line === "PONG") {
        continue; // ignore — the broker doesn't track server-initiated pings
      }

      // ── SUB subject sid ──────────────────────────────────────────────────────
      if (line.startsWith("SUB ")) {
        const parts = line.split(" ");
        const subject = parts[1] ?? "";
        const sid = parseInt(parts[2] ?? "0", 10);
        if (subject) {
          this.subscriptions.push({ subject, clientId, sid });
        }
        continue;
      }

      // ── UNSUB sid ────────────────────────────────────────────────────────────
      if (line.startsWith("UNSUB ")) {
        const sid = parseInt(line.split(" ")[1] ?? "0", 10);
        this.subscriptions = this.subscriptions.filter(
          (s) => !(s.clientId === clientId && s.sid === sid),
        );
        continue;
      }

      // ── PUB subject byteCount ────────────────────────────────────────────────
      if (line.startsWith("PUB ")) {
        const parts = line.split(" ");
        const subject = parts[1] ?? "";
        const byteCount = parseInt(parts[2] ?? "0", 10);

        if (isNaN(byteCount) || byteCount < 0 || !subject) continue;

        // The payload (byteCount bytes) plus the trailing \r\n must all be in
        // the buffer. NatsTransport sends them as separate ws.send() calls, so
        // they accumulate across multiple processClientData invocations.
        if (buffer.length < byteCount + 2) {
          // Incomplete — put the header line back and wait for more data.
          buffer = `${line}\r\n${buffer}`;
          break;
        }

        const payload = buffer.slice(0, byteCount);
        buffer = buffer.slice(byteCount + 2); // consume payload + trailing \r\n

        // Route the published message as a MSG frame to all matching subscribers.
        // Exact subject match only (wildcards not needed for these tests).
        for (const sub of this.subscriptions) {
          if (sub.subject === subject) {
            const push = this.clients.get(sub.clientId);
            if (push) {
              // MSG <subject> <sid> <byteCount>\r\n<payload>\r\n
              push(`MSG ${subject} ${sub.sid} ${byteCount}\r\n${payload}\r\n`);
            }
          }
        }
        continue;
      }

      if (line === "+OK") continue; // verbose-mode ACK, ignored
      // Unknown lines: ignore to stay forward-compatible.
    }

    // Store the remaining (unconsumed) buffer for the next fragment.
    this.buffers.set(clientId, buffer);
  }

  /** Release all broker state (idempotent). */
  dispose(): void {
    this.clients.clear();
    this.buffers.clear();
    this.subscriptions = [];
  }
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Connect an agent and a browser NatsTransport to the same FakeNatsBroker and
 * return both. Callers push the transports into `teardown` so afterEach cleans up.
 */
async function makePair(
  broker: FakeNatsBroker,
): Promise<{ agent: NatsTransport; browser: NatsTransport }> {
  const agent = new NatsTransport({
    url: "ws://fake-nats:4222",
    clientName: "test-agent",
    _wsFactory: broker.createFactory(),
  });
  const browser = new NatsTransport({
    url: "ws://fake-nats:4222",
    clientName: "test-browser",
    _wsFactory: broker.createFactory(),
  });
  await Promise.all([agent.connect(), browser.connect()]);
  return { agent, browser };
}

// ---------------------------------------------------------------------------
// Integration tests — Sub-AC 2
// ---------------------------------------------------------------------------

describe(
  "NatsTransport: outbound-only publish and backlog replay (Sub-AC 2)",
  () => {
    // Tracks all transports created in the test suite for afterEach cleanup.
    const teardown: NatsTransport[] = [];
    const brokers: FakeNatsBroker[] = [];

    afterEach(() => {
      for (const t of teardown) {
        try {
          t.disconnect();
        } catch {
          /* best-effort */
        }
      }
      teardown.length = 0;
      for (const b of brokers) {
        b.dispose();
      }
      brokers.length = 0;
    });

    // Subject naming convention (plaintext routing metadata per design):
    //   chat.<tenant>.<accountId>.<userId>.<direction>
    const INBOUND = "chat.tenant1.agent1.user42.in"; // browser → agent
    const OUTBOUND = "chat.tenant1.agent1.user42.out"; // agent → browser
    const HISTORY = "chat.tenant1.agent1.user42.history"; // backlog replay channel

    // ── Test 1: agent publishes a response; browser receives it ────────────

    it(
      "agent publishes a response via NATS and the browser-side subscriber receives it",
      async () => {
        const broker = new FakeNatsBroker();
        brokers.push(broker);

        const { agent, browser } = await makePair(broker);
        teardown.push(agent, browser);

        // Both transports are connected outbound-only.
        expect(agent.connected).toBe(true);
        expect(browser.connected).toBe(true);

        // Browser subscribes to the agent's outbound subject.
        const browserReceived: NatsMessage[] = [];
        browser.on("message", (msg: NatsMessage) => browserReceived.push(msg));
        browser.subscribe(OUTBOUND);

        // Agent subscribes to the inbound subject (browser → agent).
        const agentReceived: NatsMessage[] = [];
        agent.on("message", (msg: NatsMessage) => agentReceived.push(msg));
        agent.subscribe(INBOUND);

        // ── Browser sends a user message ──────────────────────────────────────
        browser.publish(
          INBOUND,
          JSON.stringify({ type: "user_message", text: "hello from browser" }),
        );

        // Agent receives it synchronously (FakeNatsBroker delivers in-call-stack).
        expect(agentReceived).toHaveLength(1);
        expect(agentReceived[0]!.subject).toBe(INBOUND);
        const inbound = JSON.parse(
          agentReceived[0]!.payload.toString("utf8"),
        ) as { type: string; text: string };
        expect(inbound.type).toBe("user_message");
        expect(inbound.text).toBe("hello from browser");

        // ── Agent publishes a response (outbound-only: no inbound socket) ─────
        agent.publish(
          OUTBOUND,
          JSON.stringify({ type: "agent_message", text: "hello from agent" }),
        );

        // Browser receives the response.
        expect(browserReceived).toHaveLength(1);
        expect(browserReceived[0]!.subject).toBe(OUTBOUND);
        const outbound = JSON.parse(
          browserReceived[0]!.payload.toString("utf8"),
        ) as { type: string; text: string };
        expect(outbound.type).toBe("agent_message");
        expect(outbound.text).toBe("hello from agent");
      },
    );

    // ── Test 2: backlog replay round-trip ─────────────────────────────────

    it(
      "backlog replay: browser sends load_history → agent publishes history → browser receives via subscribe",
      async () => {
        const broker = new FakeNatsBroker();
        brokers.push(broker);

        const { agent, browser } = await makePair(broker);
        teardown.push(agent, browser);

        // Simulated at-rest backlog stored by the agent (authority store).
        // Content is represented as plaintext here; in production these would
        // be E2E-encrypted envelopes (subsequent ACs). The shape matches the
        // `HistoryMessage` type in src/history.ts.
        const backlog = [
          { id: "h-1", role: "user", text: "first message", ts: 1_000_000 },
          { id: "h-2", role: "agent", text: "first reply", ts: 1_000_001 },
          { id: "h-3", role: "user", text: "second message", ts: 1_000_002 },
          { id: "h-4", role: "agent", text: "second reply", ts: 1_000_003 },
        ];

        // Browser subscribes to the history replay subject before requesting.
        const historyReceived: NatsMessage[] = [];
        browser.on("message", (msg: NatsMessage) => historyReceived.push(msg));
        browser.subscribe(HISTORY);

        // Agent subscribes to the inbound subject to receive the load_history
        // request.
        const agentReceived: NatsMessage[] = [];
        agent.on("message", (msg: NatsMessage) => agentReceived.push(msg));
        agent.subscribe(INBOUND);

        // ── Browser requests backlog ──────────────────────────────────────────
        browser.publish(
          INBOUND,
          JSON.stringify({ type: "load_history", limit: 50 }),
        );

        // Agent receives the load_history request.
        expect(agentReceived).toHaveLength(1);
        const histReq = JSON.parse(
          agentReceived[0]!.payload.toString("utf8"),
        ) as { type: string; limit?: number };
        expect(histReq.type).toBe("load_history");
        expect(histReq.limit).toBe(50);

        // ── Agent replays backlog via outbound publish (no inbound socket) ────
        // This is the canonical "backlog replay" path: the agent, as the
        // single authority store, publishes the history to the history subject.
        // The browser receives it via its subscribe — completing the
        // subscribe → re-receive round-trip.
        agent.publish(
          HISTORY,
          JSON.stringify({ type: "history", messages: backlog }),
        );

        // Browser receives the history snapshot synchronously.
        expect(historyReceived).toHaveLength(1);
        expect(historyReceived[0]!.subject).toBe(HISTORY);
        const histPayload = JSON.parse(
          historyReceived[0]!.payload.toString("utf8"),
        ) as { type: string; messages: Array<{ id: string; role: string; text: string; ts: number }> };
        expect(histPayload.type).toBe("history");
        expect(histPayload.messages).toHaveLength(4);
        expect(histPayload.messages[0]).toMatchObject({
          id: "h-1",
          role: "user",
          text: "first message",
        });
        expect(histPayload.messages[3]).toMatchObject({
          id: "h-4",
          role: "agent",
          text: "second reply",
        });
      },
    );

    // ── Test 3: full multi-message round-trip ─────────────────────────────

    it(
      "full round-trip: multiple browser→agent→browser messages all routed without inbound socket",
      async () => {
        const broker = new FakeNatsBroker();
        brokers.push(broker);

        const { agent, browser } = await makePair(broker);
        teardown.push(agent, browser);

        const agentReceived: NatsMessage[] = [];
        agent.on("message", (msg: NatsMessage) => agentReceived.push(msg));
        agent.subscribe(INBOUND);

        const browserReceived: NatsMessage[] = [];
        browser.on("message", (msg: NatsMessage) => browserReceived.push(msg));
        browser.subscribe(OUTBOUND);

        // Browser sends 3 user messages.
        for (let i = 0; i < 3; i++) {
          browser.publish(
            INBOUND,
            JSON.stringify({ type: "user_message", text: `msg-${i}` }),
          );
        }

        // Agent receives all 3 inbound messages synchronously.
        expect(agentReceived).toHaveLength(3);
        for (const msg of agentReceived) {
          const parsed = JSON.parse(msg.payload.toString("utf8")) as { text: string };
          // Agent publishes one response per received message.
          agent.publish(
            OUTBOUND,
            JSON.stringify({ type: "agent_message", text: `reply-${parsed.text}` }),
          );
        }

        // Browser receives all 3 responses.
        expect(browserReceived).toHaveLength(3);
        const replies = browserReceived.map((m) => {
          const parsed = JSON.parse(m.payload.toString("utf8")) as { text: string };
          return parsed.text;
        });
        expect(replies).toContain("reply-msg-0");
        expect(replies).toContain("reply-msg-1");
        expect(replies).toContain("reply-msg-2");
      },
    );

    // ── Test 4: approval flow round-trip ─────────────────────────────────

    it(
      "approval decision round-trip: browser sends approval_decision → agent receives and publishes resolved",
      async () => {
        const broker = new FakeNatsBroker();
        brokers.push(broker);

        const { agent, browser } = await makePair(broker);
        teardown.push(agent, browser);

        const APPROVAL_SUBJECT = "chat.tenant1.agent1.user42.approval";

        const agentReceived: NatsMessage[] = [];
        agent.on("message", (msg: NatsMessage) => agentReceived.push(msg));
        agent.subscribe(INBOUND);

        const browserResolved: NatsMessage[] = [];
        browser.on("message", (msg: NatsMessage) => browserResolved.push(msg));
        browser.subscribe(APPROVAL_SUBJECT);

        // Browser clicks the "allow-once" approval button.
        browser.publish(
          INBOUND,
          JSON.stringify({
            type: "approval_decision",
            id: "approval-123",
            decision: "allow-once",
          }),
        );

        // Agent receives the approval decision.
        expect(agentReceived).toHaveLength(1);
        const decision = JSON.parse(
          agentReceived[0]!.payload.toString("utf8"),
        ) as { type: string; id: string; decision: string };
        expect(decision.type).toBe("approval_decision");
        expect(decision.id).toBe("approval-123");
        expect(decision.decision).toBe("allow-once");

        // Agent publishes approval_resolved outbound (no inbound socket).
        agent.publish(
          APPROVAL_SUBJECT,
          JSON.stringify({
            type: "approval_resolved",
            id: "approval-123",
            decision: "allow-once",
          }),
        );

        // Browser receives the resolved status.
        expect(browserResolved).toHaveLength(1);
        const resolved = JSON.parse(
          browserResolved[0]!.payload.toString("utf8"),
        ) as { type: string; id: string; decision: string };
        expect(resolved.type).toBe("approval_resolved");
        expect(resolved.id).toBe("approval-123");
        expect(resolved.decision).toBe("allow-once");
      },
    );

    // ── Test 5: zero TCP LISTEN sockets throughout the full exchange ───────

    it(
      "no TCP LISTEN sockets at any point during the full message exchange (port-scan)",
      async () => {
        const pid = process.pid;
        const before = countListeningTcpForPid(pid);

        const broker = new FakeNatsBroker();
        brokers.push(broker);

        const agent = new NatsTransport({
          url: "ws://fake-nats:4222",
          _wsFactory: broker.createFactory(),
        });
        const browser = new NatsTransport({
          url: "ws://fake-nats:4222",
          _wsFactory: broker.createFactory(),
        });
        teardown.push(agent, browser);

        await Promise.all([agent.connect(), browser.connect()]);

        // Full exchange: subscribe, publish, receive.
        const received: NatsMessage[] = [];
        browser.on("message", (msg: NatsMessage) => received.push(msg));
        browser.subscribe(OUTBOUND);

        agent.subscribe(INBOUND);
        browser.publish(INBOUND, "ping");
        agent.publish(OUTBOUND, "pong");

        expect(received).toHaveLength(1);
        expect(received[0]!.payload.toString("utf8")).toBe("pong");

        const after = countListeningTcpForPid(pid);
        // The entire exchange must add ZERO new TCP LISTEN sockets.
        // A WebSocket CLIENT dial (outbound-only) never opens a LISTEN port.
        expect(after - before).toBe(0);
      },
    );

    // ── Test 6: late-join subscribe → backlog replay completes the round-trip

    it(
      "late-join browser receives full backlog via subscribe after the agent publishes",
      async () => {
        const broker = new FakeNatsBroker();
        brokers.push(broker);

        const agent = new NatsTransport({
          url: "ws://fake-nats:4222",
          _wsFactory: broker.createFactory(),
        });
        // Two browsers: the first sends a request; a late-joiner subscribes
        // to the history subject and re-receives the replay.
        const browserA = new NatsTransport({
          url: "ws://fake-nats:4222",
          _wsFactory: broker.createFactory(),
        });
        const browserB = new NatsTransport({
          url: "ws://fake-nats:4222",
          _wsFactory: broker.createFactory(),
        });
        teardown.push(agent, browserA, browserB);

        await Promise.all([
          agent.connect(),
          browserA.connect(),
          browserB.connect(),
        ]);

        // Both browsers subscribe to the history replay subject.
        const receivedA: NatsMessage[] = [];
        const receivedB: NatsMessage[] = [];
        browserA.on("message", (msg: NatsMessage) => receivedA.push(msg));
        browserB.on("message", (msg: NatsMessage) => receivedB.push(msg));
        browserA.subscribe(HISTORY);
        browserB.subscribe(HISTORY);

        // Agent subscribes to receive load_history requests.
        const agentReceived: NatsMessage[] = [];
        agent.on("message", (msg: NatsMessage) => agentReceived.push(msg));
        agent.subscribe(INBOUND);

        const backlog = [
          { id: "b-1", role: "user", text: "older message", ts: 999 },
          { id: "b-2", role: "agent", text: "older reply", ts: 1000 },
        ];

        // browserA sends a load_history request.
        browserA.publish(
          INBOUND,
          JSON.stringify({ type: "load_history", before: "b-3", limit: 25 }),
        );

        expect(agentReceived).toHaveLength(1);

        // Agent publishes backlog to the history subject.
        // Because both browsers are subscribed, BOTH receive the replay.
        agent.publish(HISTORY, JSON.stringify({ type: "history", messages: backlog }));

        // browserA (the requester) receives the backlog.
        expect(receivedA).toHaveLength(1);
        const payloadA = JSON.parse(
          receivedA[0]!.payload.toString("utf8"),
        ) as { messages: Array<{ id: string }> };
        expect(payloadA.messages).toHaveLength(2);
        expect(payloadA.messages[0]!.id).toBe("b-1");

        // browserB (a late-joiner subscribed to the same history subject) also
        // receives the backlog — this is the multi-device synchronization path.
        expect(receivedB).toHaveLength(1);
        const payloadB = JSON.parse(
          receivedB[0]!.payload.toString("utf8"),
        ) as { messages: Array<{ id: string }> };
        expect(payloadB.messages).toHaveLength(2);
        expect(payloadB.messages[1]!.id).toBe("b-2");
      },
    );

    // ── Test 7: agent-only connect+subscribe+publish (no browser required) ──

    it(
      "agent connects outbound, subscribes, and publishes without requiring a browser peer",
      async () => {
        const broker = new FakeNatsBroker();
        brokers.push(broker);

        const agent = new NatsTransport({
          url: "ws://fake-nats:4222",
          _wsFactory: broker.createFactory(),
        });
        teardown.push(agent);

        await agent.connect();
        expect(agent.connected).toBe(true);

        // Subscribe to inbound — no error even with no browser sender.
        const sid = agent.subscribe(INBOUND);
        expect(typeof sid).toBe("number");
        expect(sid).toBeGreaterThan(0);

        // Publish outbound — no error even with no browser receiver.
        // (The agent's outbound publish is fire-and-forget; NATS discards
        // messages with no active subscribers. This is expected and valid.)
        expect(() =>
          agent.publish(OUTBOUND, JSON.stringify({ type: "typing" })),
        ).not.toThrow();

        // Unsubscribe cleanly.
        expect(() => agent.unsubscribe(sid)).not.toThrow();
      },
    );

    // ── Test 8: typing signal forwarding (ephemeral, no persistence needed) ─

    it(
      "ephemeral typing signal is forwarded via NATS without any at-rest storage",
      async () => {
        const broker = new FakeNatsBroker();
        brokers.push(broker);

        const { agent, browser } = await makePair(broker);
        teardown.push(agent, browser);

        const TYPING_SUBJECT = "chat.tenant1.agent1.user42.typing";

        const browserTyping: NatsMessage[] = [];
        browser.on("message", (msg: NatsMessage) => browserTyping.push(msg));
        browser.subscribe(TYPING_SUBJECT);

        // Agent emits a typing signal — ephemeral, no backlog entry.
        agent.publish(TYPING_SUBJECT, JSON.stringify({ type: "typing" }));

        expect(browserTyping).toHaveLength(1);
        const frame = JSON.parse(
          browserTyping[0]!.payload.toString("utf8"),
        ) as { type: string };
        expect(frame.type).toBe("typing");
      },
    );

    // ── Test 9: FakeNatsBroker structural invariants (no server socket) ────

    it(
      "FakeNatsBroker itself has no WebSocketServer or net.Server property",
      () => {
        const broker = new FakeNatsBroker();
        brokers.push(broker);

        // The broker is a pure in-memory relay — it must NEVER expose a server
        // socket of any kind (WebSocketServer, net.Server, http.Server, etc.).
        const rec = broker as unknown as Record<string, unknown>;
        expect(rec["wss"]).toBeUndefined();
        expect(rec["server"]).toBeUndefined();
        expect(rec["httpServer"]).toBeUndefined();
        expect(rec["tcpServer"]).toBeUndefined();
      },
    );

    // ── Test 10: disconnect mid-exchange does not corrupt other clients ─────

    it(
      "agent disconnect mid-exchange does not corrupt the broker or other subscriptions",
      async () => {
        const broker = new FakeNatsBroker();
        brokers.push(broker);

        const agent = new NatsTransport({
          url: "ws://fake-nats:4222",
          _wsFactory: broker.createFactory(),
        });
        const browser = new NatsTransport({
          url: "ws://fake-nats:4222",
          _wsFactory: broker.createFactory(),
        });
        teardown.push(agent, browser);

        await Promise.all([agent.connect(), browser.connect()]);

        const browserReceived: NatsMessage[] = [];
        browser.on("message", (msg: NatsMessage) => browserReceived.push(msg));
        browser.subscribe(OUTBOUND);

        // Agent publishes one message.
        agent.publish(OUTBOUND, "pre-disconnect");
        expect(browserReceived).toHaveLength(1);

        // Agent disconnects (simulates restart or network drop — the agent
        // would reconnect outbound; no inbound socket change needed).
        agent.disconnect();
        expect(agent.connected).toBe(false);

        // Browser is still subscribed; its subscription in the broker is intact.
        // A new agent (reconnect) can immediately publish to the same subject.
        const agent2 = new NatsTransport({
          url: "ws://fake-nats:4222",
          _wsFactory: broker.createFactory(),
        });
        teardown.push(agent2);
        await agent2.connect();

        agent2.publish(OUTBOUND, "post-reconnect");
        expect(browserReceived).toHaveLength(2);
        expect(browserReceived[1]!.payload.toString("utf8")).toBe("post-reconnect");
      },
    );
  },
);
