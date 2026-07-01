/**
 * Production browser NATS client — PoP HTTP registration wiring tests.
 *
 * Proves that `WebChannelNatsClient.onConnected()` runs the PoP HTTP
 * registration in the right ORDER relative to the X25519 handshake:
 *   - it subscribes to .out/.handshake, THEN awaits the register HTTP 200,
 *     and only AFTER that publishes its key-exchange frame (NATS has no
 *     retention, so a handshake published before the agent registers/subscribes
 *     would be lost);
 *   - it is FAIL-CLOSED — a rejected proof (401 → PopRejectedError) publishes no
 *     handshake and no .in frame, and surfaces via onError;
 *   - with no `registration` config the current behaviour is unchanged (handshake
 *     published immediately, fetch never called).
 *
 * The fake nats-server (over a fake WebSocket) mirrors the crypto test harness;
 * a mock fetch is injected via `registration.fetchImpl` (global fetch untouched).
 * The device key is a real Ed25519 key from generateDevicePopKeyPair(), so
 * signPop runs for real (Node ≥18 webcrypto has Ed25519).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  WebChannelNatsClient,
  inboundSubject,
  handshakeSubject,
} from "./nats-client.js";
import {
  generateX25519KeyPair,
  deriveConversationKey,
  keyExchangeFrame,
  parseKeyExchange,
} from "./e2e-crypto-browser.js";
import { generateDevicePopKeyPair } from "./pop-register.js";

// ---------------------------------------------------------------------------
// Fake nats-server over a fake WebSocket (mirrors nats-client-crypto.test.ts)
// ---------------------------------------------------------------------------

type ServerHandler = (subject: string, payload: string, server: FakeNatsWS) => void | Promise<void>;

class FakeNatsWS {
  static instances: FakeNatsWS[] = [];
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  url: string;
  binaryType = "blob";
  readyState: number = FakeNatsWS.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  onclose: (() => void) | null = null;

  /** subject -> sid the client subscribed with. */
  private readonly subs = new Map<string, number>();
  /** Every PUB the client sent, in order (for wiretap assertions). */
  readonly published: Array<{ subject: string; payload: string }> = [];
  /** Agent-side behaviour injected by the test. */
  handler: ServerHandler = () => {};

  constructor(url: string) {
    this.url = url;
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
      const header = data.slice(0, idx).split(" "); // PUB <subject> <len>
      const subject = header[1];
      const payload = data.slice(idx + 2).replace(/\r\n$/, "");
      this.published.push({ subject, payload });
      void this.handler(subject, payload, this);
      return;
    }
  }

  /** Deliver a MSG to the client iff it is subscribed to `subject`. */
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

// An "agent" that mirrors the plugin: handshake → derive key → (no echo needed). */
function makeHandshakeAgent(tenant: string, accountId: string, peerId: string): ServerHandler {
  const hs = handshakeSubject(tenant, accountId, peerId);
  return async (subject, payload, server) => {
    if (subject === hs) {
      const browserPub = parseKeyExchange(payload);
      if (!browserPub) return;
      const agentKP = await generateX25519KeyPair();
      await deriveConversationKey(agentKP.privateKey, browserPub);
      server.deliverToClient(hs, keyExchangeFrame(agentKP.publicKeyB64url));
      return;
    }
  };
}

const TENANT = "acme";
const AGENT = "agent-1";
const PEER = "user-42";
const JWT = "bootstrap.jwt.token";
const BASE = "http://127.0.0.1:18789";

async function settle(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 5));
}

function jsonResponse(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

let originalWebSocket: unknown;

beforeEach(() => {
  originalWebSocket = (globalThis as { WebSocket?: unknown }).WebSocket;
  (globalThis as { WebSocket: unknown }).WebSocket = FakeNatsWS;
  FakeNatsWS.instances = [];
});

afterEach(() => {
  (globalThis as { WebSocket: unknown }).WebSocket = originalWebSocket;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("WebChannelNatsClient PoP HTTP registration wiring", () => {
  it("registers (challenge → register) BEFORE publishing the handshake frame", async () => {
    const device = await generateDevicePopKeyPair();
    const hs = handshakeSubject(TENANT, AGENT, PEER);

    let registered = false; // flipped once the register POST resolves
    const calls: Array<{ url: string; auth?: string; body?: { nonce?: string; signature?: string } }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      const auth = (init?.headers as Record<string, string> | undefined)?.["Authorization"];
      if (u.endsWith("/webchannel/nats/register/challenge")) {
        calls.push({ url: u, auth });
        return jsonResponse({ nonce: "nonce-abc" });
      }
      if (u.endsWith("/webchannel/nats/register")) {
        const body = JSON.parse(String(init?.body)) as { nonce?: string; signature?: string };
        calls.push({ url: u, auth, body });
        registered = true;
        return jsonResponse({ peerId: PEER, registered: true });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    const client = new WebChannelNatsClient({
      url: "ws://127.0.0.1:4222",
      jwt: JWT,
      accountId: AGENT,
      tenant: TENANT,
      peerId: PEER,
      registration: { registerBaseUrl: BASE, devicePrivateKey: device.privateKey, fetchImpl },
    });
    client.connect();
    const server = FakeNatsWS.instances.at(-1)!;
    // Wiretap: capture whether `registered` was already true at the moment the
    // handshake frame was published.
    let handshakePublishedBeforeRegister = false;
    server.handler = makeHandshakeAgent(TENANT, AGENT, PEER);
    const baseHandler = server.handler;
    server.handler = (subject, payload, srv) => {
      if (subject === hs && !registered) handshakePublishedBeforeRegister = true;
      return baseHandler(subject, payload, srv);
    };

    await settle();

    // Both HTTP calls happened, in order, with the right URLs/headers/body.
    expect(calls.map((c) => c.url)).toEqual([
      `${BASE}/webchannel/nats/register/challenge`,
      `${BASE}/webchannel/nats/register`,
    ]);
    expect(calls[0].auth).toBe(`Bearer ${JWT}`);
    expect(calls[1].auth).toBe(`Bearer ${JWT}`);
    expect(calls[1].body?.nonce).toBe("nonce-abc");
    expect(typeof calls[1].body?.signature).toBe("string");

    // The handshake was published only AFTER the register POST resolved.
    expect(handshakePublishedBeforeRegister).toBe(false);
    expect(server.published.some((p) => p.subject === hs)).toBe(true);

    client.disconnect();
  });

  it("fail-closed: a rejected proof (401 → PopRejectedError) publishes no handshake / no .in, and fires onError", async () => {
    const device = await generateDevicePopKeyPair();
    const fetchImpl = (async (url: string | URL | Request) => {
      const u = String(url);
      if (u.endsWith("/webchannel/nats/register/challenge")) return jsonResponse({ nonce: "nonce-xyz" });
      if (u.endsWith("/webchannel/nats/register")) return new Response("", { status: 401 });
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    const errors: Error[] = [];
    const client = new WebChannelNatsClient({
      url: "ws://127.0.0.1:4222",
      jwt: JWT,
      accountId: AGENT,
      tenant: TENANT,
      peerId: PEER,
      registration: { registerBaseUrl: BASE, devicePrivateKey: device.privateKey, fetchImpl },
    });
    client.onError((err) => errors.push(err));
    client.connect();
    const server = FakeNatsWS.instances.at(-1)!;
    server.handler = makeHandshakeAgent(TENANT, AGENT, PEER);

    await settle();

    // No handshake and no .in frame ever hit the wire (session never establishes).
    const hs = handshakeSubject(TENANT, AGENT, PEER);
    const inS = inboundSubject(TENANT, AGENT, PEER);
    expect(server.published.some((p) => p.subject === hs)).toBe(false);
    expect(server.published.some((p) => p.subject === inS)).toBe(false);

    // onError received the PoP rejection.
    expect(errors.length).toBe(1);
    expect(errors[0].name).toBe("PopRejectedError");

    // The session never establishes: a send stays buffered, nothing on .in.
    client.sendUserMessage("after-reject");
    await settle();
    expect(server.published.some((p) => p.subject === inS)).toBe(false);

    client.disconnect();
  });

  it("registration failure is terminal: tears the socket down (connected === false), no handshake, no reconnect", async () => {
    const device = await generateDevicePopKeyPair();
    const fetchImpl = (async (url: string | URL | Request) => {
      const u = String(url);
      if (u.endsWith("/webchannel/nats/register/challenge")) return jsonResponse({ nonce: "nonce-term" });
      if (u.endsWith("/webchannel/nats/register")) return new Response("", { status: 401 });
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    const states: boolean[] = [];
    const client = new WebChannelNatsClient({
      url: "ws://127.0.0.1:4222",
      jwt: JWT,
      accountId: AGENT,
      tenant: TENANT,
      peerId: PEER,
      registration: { registerBaseUrl: BASE, devicePrivateKey: device.privateKey, fetchImpl },
    });
    client.onState((connected) => states.push(connected));
    client.connect();
    const server = FakeNatsWS.instances.at(-1)!;
    server.handler = makeHandshakeAgent(TENANT, AGENT, PEER);

    await settle();

    // The socket connected, then registration failed and tore it back down:
    // the last state observed is `false` (not reconnecting in some wedged state).
    expect(states.at(-1)).toBe(false);
    // The underlying fake WebSocket was actually closed.
    expect(server.readyState).toBe(FakeNatsWS.CLOSED);
    // No handshake was published (fail-closed).
    const hs = handshakeSubject(TENANT, AGENT, PEER);
    expect(server.published.some((p) => p.subject === hs)).toBe(false);

    // Terminal: no reconnect loop spawns a second socket after the teardown.
    const instanceCountAfterTeardown = FakeNatsWS.instances.length;
    await settle();
    expect(FakeNatsWS.instances.length).toBe(instanceCountAfterTeardown);

    client.disconnect();
  });

  it("no registration config → handshake published immediately, fetch never called", async () => {
    const hs = handshakeSubject(TENANT, AGENT, PEER);

    // With no `registration` config there is nowhere to inject a fetchImpl, and
    // registerWithPop is never reached. Guard it by stubbing GLOBAL fetch to
    // throw (registerWithPop would fall back to it) and asserting the handshake
    // still publishes — i.e. fetch is never touched. Restored in finally.
    let fetchCalled = false;
    const realFetch = (globalThis as { fetch?: unknown }).fetch;
    (globalThis as { fetch: unknown }).fetch = (() => {
      fetchCalled = true;
      throw new Error("fetch must not be called without a registration config");
    }) as unknown as typeof fetch;

    try {
      const client = new WebChannelNatsClient({
        url: "ws://127.0.0.1:4222",
        jwt: JWT,
        accountId: AGENT,
        tenant: TENANT,
        peerId: PEER,
        // Note: NO `registration` field.
      });
      client.connect();
      const server = FakeNatsWS.instances.at(-1)!;
      server.handler = makeHandshakeAgent(TENANT, AGENT, PEER);

      await settle();

      // Handshake published (current behaviour preserved) and fetch untouched.
      expect(server.published.some((p) => p.subject === hs)).toBe(true);
      expect(fetchCalled).toBe(false);

      client.disconnect();
    } finally {
      (globalThis as { fetch: unknown }).fetch = realFetch;
    }
  });
});
