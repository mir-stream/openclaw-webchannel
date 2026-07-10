/**
 * F5: transient register-hop failure must not permanently brick the client.
 *
 * A relay outage or an agent-offline window that overlaps the PoP register hop
 * used to be misclassified as terminal: the wrapper caught ANY register error →
 * `NatsClient.disconnect()`, which clears the reconnect timer and nulls
 * `ws.onclose`, so nothing ever redialed and the client sat keyless forever.
 *
 * These tests drive the register hop over a fake nats-server that SURVIVES
 * reconnects (a single shared handler is installed on every socket instance, so
 * a redial is answered like the first connect). They assert:
 *   - a TRANSIENT failure (agent offline → register replies 503 until it clears)
 *     actively RE-ATTEMPTS registration across redials, and RECOVERS to a live
 *     session once the agent returns;
 *   - a TERMINAL failure (401 → PopRejectedError, or a non-401/503 server code →
 *     PopServerError) tears the socket down for good with no redial.
 *
 * Mirrors the fake-WS harness in nats-client-register.test.ts, adding a shared
 * cross-reconnect handler and a test-tunable reconnect backoff.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  WebChannelNatsClient,
  inboundSubject,
  handshakeSubject,
  registerSubject,
} from "./nats-client.js";
import {
  generateX25519KeyPair,
  deriveConversationKey,
  keyExchangeFrame,
  parseKeyExchange,
} from "./e2e-crypto-browser.js";
import { generateDevicePopKeyPair } from "./pop-register.js";

// ---------------------------------------------------------------------------
// Fake nats-server over a fake WebSocket — shared handler across reconnects
// ---------------------------------------------------------------------------

type ServerHandler = (
  subject: string,
  payload: string,
  server: FakeNatsWS,
  replyTo?: string,
) => void | Promise<void>;

class FakeNatsWS {
  static instances: FakeNatsWS[] = [];
  /** Installed on EVERY new socket so a redial is answered like the first. */
  static sharedHandler: ServerHandler = () => {};
  static readonly OPEN = 1;
  static readonly CLOSED = 3;

  url: string;
  binaryType = "blob";
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  onclose: (() => void) | null = null;

  private readonly subs = new Map<string, number>();
  readonly published: Array<{ subject: string; payload: string; replyTo?: string }> = [];
  handler: ServerHandler;

  constructor(url: string) {
    this.url = url;
    this.handler = FakeNatsWS.sharedHandler;
    FakeNatsWS.instances.push(this);
    queueMicrotask(() => {
      this.readyState = FakeNatsWS.OPEN;
      this.onopen?.();
    });
  }

  send(data: string): void {
    if (data.startsWith("CONNECT")) return;
    if (data.startsWith("PING")) {
      this.emit("PONG\r\n");
      return;
    }
    if (data.startsWith("PONG")) return;
    if (data.startsWith("SUB ")) {
      const [, subject, sid] = data.trim().split(" ");
      this.subs.set(subject, Number(sid));
      return;
    }
    if (data.startsWith("UNSUB ")) {
      const sid = Number(data.trim().split(" ")[1]);
      for (const [subject, id] of this.subs) if (id === sid) this.subs.delete(subject);
      return;
    }
    if (data.startsWith("PUB ")) {
      const idx = data.indexOf("\r\n");
      const header = data.slice(0, idx).split(" ");
      const subject = header[1];
      const replyTo = header.length === 4 ? header[2] : undefined;
      const payload = data.slice(idx + 2).replace(/\r\n$/, "");
      this.published.push({ subject, payload, replyTo });
      void this.handler(subject, payload, this, replyTo);
      return;
    }
  }

  deliverToClient(subject: string, payload: string): void {
    const sid = this.subs.get(subject);
    if (sid === undefined) return;
    const len = new TextEncoder().encode(payload).length;
    this.emit(`MSG ${subject} ${sid} ${len}\r\n${payload}\r\n`);
  }

  close(): void {
    this.readyState = FakeNatsWS.CLOSED;
    this.onclose?.();
  }

  private emit(frame: string): void {
    this.onmessage?.({ data: frame });
  }
}

const TENANT = "acme";
const AGENT = "agent-1";
const PEER = "user-42";
const JWT = "bootstrap.jwt.token";

async function settle(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 2));
}

/** Sum of challenge PUBs across every socket instance (register re-attempts). */
function totalChallenges(): number {
  const reg = registerSubject(TENANT, AGENT, PEER);
  let n = 0;
  for (const s of FakeNatsWS.instances) {
    for (const p of s.published) {
      if (p.subject === reg && (JSON.parse(p.payload) as { op?: string }).op === "challenge") n++;
    }
  }
  return n;
}

let originalWebSocket: unknown;

beforeEach(() => {
  originalWebSocket = (globalThis as { WebSocket?: unknown }).WebSocket;
  (globalThis as { WebSocket: unknown }).WebSocket = FakeNatsWS;
  FakeNatsWS.instances = [];
  FakeNatsWS.sharedHandler = () => {};
});

afterEach(() => {
  (globalThis as { WebSocket: unknown }).WebSocket = originalWebSocket;
});

describe("WebChannelNatsClient register-hop recovery (F5)", () => {
  it("a transient failure (agent offline) re-attempts registration and recovers when the agent returns", async () => {
    const device = await generateDevicePopKeyPair();
    const reg = registerSubject(TENANT, AGENT, PEER);
    const hs = handshakeSubject(TENANT, AGENT, PEER);
    const inS = inboundSubject(TENANT, AGENT, PEER);

    // Shared agent: register replies 503 while `offline`, then succeeds. The
    // handshake path is always answered so the session can complete on recovery.
    const state = { offline: true, registered: false };
    FakeNatsWS.sharedHandler = async (subject, payload, server, replyTo) => {
      if (subject === reg && replyTo) {
        const body = JSON.parse(payload) as { op?: string };
        if (body.op === "challenge") {
          server.deliverToClient(replyTo, JSON.stringify({ nonce: "nonce-abc" }));
          return;
        }
        if (body.op === "register") {
          if (state.offline) {
            // Agent unreachable → transient 503 (retried, then exhausted → a
            // plain Error the wrapper must classify TRANSIENT, not terminal).
            server.deliverToClient(replyTo, JSON.stringify({ error: "unavailable", code: 503 }));
            return;
          }
          state.registered = true;
          server.deliverToClient(replyTo, JSON.stringify({ peerId: PEER, registered: true }));
          return;
        }
        return;
      }
      if (subject === hs) {
        const browserPub = parseKeyExchange(payload);
        if (!browserPub) return;
        const agentKP = await generateX25519KeyPair();
        await deriveConversationKey(agentKP.privateKey, browserPub);
        server.deliverToClient(hs, keyExchangeFrame(agentKP.publicKeyB64url));
      }
    };

    const errors: Error[] = [];
    const client = new WebChannelNatsClient({
      url: "ws://127.0.0.1:4222",
      jwt: JWT,
      accountId: AGENT,
      tenant: TENANT,
      peerId: PEER,
      registration: { devicePrivateKey: device.privateKey },
      // Tight backoff so several redials happen inside settle().
      reconnectBaseMs: 1,
      reconnectCapMs: 2,
    });
    client.onError((err) => errors.push(err));
    client.connect();

    // While the agent is offline the client keeps RE-ATTEMPTING registration
    // (redials → fresh onConnected → new challenge), and never goes terminal.
    await settle();
    expect(state.registered).toBe(false);
    expect(FakeNatsWS.instances.length).toBeGreaterThan(1); // it redialed
    expect(totalChallenges()).toBeGreaterThan(1); // registration re-attempted
    expect(errors).toEqual([]); // a transient failure is NOT surfaced as terminal

    // Agent comes back → the next re-attempt registers and the session works.
    state.offline = false;
    await settle();
    expect(state.registered).toBe(true);
    const live = FakeNatsWS.instances.at(-1)!;
    expect(live.published.some((p) => p.subject === hs)).toBe(true);

    // A user message now reaches .in (a live, keyed session — no silent hang).
    client.sendUserMessage("recovered");
    await settle();
    expect(FakeNatsWS.instances.some((s) => s.published.some((p) => p.subject === inS))).toBe(true);

    client.disconnect();
  });

  it("a 401 rejection (PopRejectedError) is terminal — socket torn down, no redial", async () => {
    const device = await generateDevicePopKeyPair();
    const reg = registerSubject(TENANT, AGENT, PEER);
    FakeNatsWS.sharedHandler = (subject, payload, server, replyTo) => {
      if (subject === reg && replyTo) {
        const body = JSON.parse(payload) as { op?: string };
        if (body.op === "challenge") {
          server.deliverToClient(replyTo, JSON.stringify({ nonce: "nonce-abc" }));
          return;
        }
        if (body.op === "register") {
          server.deliverToClient(replyTo, JSON.stringify({ error: "unauthorized", code: 401 }));
        }
      }
    };

    const errors: Error[] = [];
    const client = new WebChannelNatsClient({
      url: "ws://127.0.0.1:4222",
      jwt: JWT,
      accountId: AGENT,
      tenant: TENANT,
      peerId: PEER,
      registration: { devicePrivateKey: device.privateKey },
      reconnectBaseMs: 1,
      reconnectCapMs: 2,
    });
    client.onError((err) => errors.push(err));
    client.connect();

    await settle();
    expect(errors).toHaveLength(1);
    expect(errors[0].name).toBe("PopRejectedError"); // original error preserved
    const instancesAfterFail = FakeNatsWS.instances.length;
    expect(FakeNatsWS.instances.at(-1)!.readyState).toBe(FakeNatsWS.CLOSED);

    // Terminal: no redial spawns another socket.
    await settle();
    expect(FakeNatsWS.instances.length).toBe(instancesAfterFail);

    client.disconnect();
  });

  it("a non-401/503 server error (PopServerError) is terminal — no redial", async () => {
    const device = await generateDevicePopKeyPair();
    const reg = registerSubject(TENANT, AGENT, PEER);
    FakeNatsWS.sharedHandler = (subject, payload, server, replyTo) => {
      if (subject === reg && replyTo) {
        const body = JSON.parse(payload) as { op?: string };
        if (body.op === "challenge") {
          server.deliverToClient(replyTo, JSON.stringify({ nonce: "nonce-abc" }));
          return;
        }
        if (body.op === "register") {
          server.deliverToClient(replyTo, JSON.stringify({ error: "server error", code: 500 }));
        }
      }
    };

    const errors: Error[] = [];
    const client = new WebChannelNatsClient({
      url: "ws://127.0.0.1:4222",
      jwt: JWT,
      accountId: AGENT,
      tenant: TENANT,
      peerId: PEER,
      registration: { devicePrivateKey: device.privateKey },
      reconnectBaseMs: 1,
      reconnectCapMs: 2,
    });
    client.onError((err) => errors.push(err));
    client.connect();

    await settle();
    expect(errors).toHaveLength(1);
    expect(errors[0].name).toBe("PopServerError");
    const instancesAfterFail = FakeNatsWS.instances.length;

    await settle();
    expect(FakeNatsWS.instances.length).toBe(instancesAfterFail); // no redial

    client.disconnect();
  });
});
