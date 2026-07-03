/**
 * Production browser NATS client — PoP registration wiring tests (NATS transport).
 *
 * Proves that `WebChannelNatsClient.onConnected()` runs the PoP registration
 * over NATS request/reply in the right ORDER relative to the X25519 handshake:
 *   - it subscribes to .out/.handshake, THEN completes the challenge+register
 *     request/reply round-trips, and only AFTER that publishes its key-exchange
 *     frame (NATS has no retention, so a handshake published before the agent
 *     registers/subscribes would be lost);
 *   - it is FAIL-CLOSED — a rejected proof (generic `unauthorized` reply →
 *     PopRejectedError) publishes no handshake and no .in frame, and surfaces via
 *     onError;
 *   - with no `registration` config the current behaviour is unchanged (handshake
 *     published immediately, no register round-trip).
 *
 * The fake nats-server (over a fake WebSocket) mirrors the crypto test harness
 * and additionally answers the register subject: a browser PUB with a reply-to
 * inbox is answered by delivering a MSG to that inbox. The device key is a real
 * Ed25519 key from generateDevicePopKeyPair(), so signPop runs for real.
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
// Fake nats-server over a fake WebSocket (mirrors nats-client-crypto.test.ts)
// ---------------------------------------------------------------------------

type ServerHandler = (
  subject: string,
  payload: string,
  server: FakeNatsWS,
  replyTo?: string,
) => void | Promise<void>;

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
  readonly published: Array<{ subject: string; payload: string; replyTo?: string }> = [];
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
      const header = data.slice(0, idx).split(" "); // PUB <subject> [reply-to] <len>
      const subject = header[1];
      const replyTo = header.length === 4 ? header[2] : undefined;
      const payload = data.slice(idx + 2).replace(/\r\n$/, "");
      this.published.push({ subject, payload, replyTo });
      void this.handler(subject, payload, this, replyTo);
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

/**
 * An "agent" that mirrors the plugin: answers the register subject over the
 * reply-to inbox (challenge → nonce, register → registered), then answers the
 * X25519 handshake. `state.registered` flips true once the register op is
 * handled — the ordering wiretap keys off it.
 */
function makeRegisterAndHandshakeAgent(
  tenant: string,
  accountId: string,
  peerId: string,
  opts?: { rejectRegister?: boolean },
): { handler: ServerHandler; state: { registered: boolean } } {
  const reg = registerSubject(tenant, accountId, peerId);
  const hs = handshakeSubject(tenant, accountId, peerId);
  const state = { registered: false };
  const handler: ServerHandler = async (subject, payload, server, replyTo) => {
    if (subject === reg && replyTo) {
      const body = JSON.parse(payload) as { op?: string };
      if (body.op === "challenge") {
        server.deliverToClient(replyTo, JSON.stringify({ nonce: "nonce-abc" }));
        return;
      }
      if (body.op === "register") {
        if (opts?.rejectRegister) {
          server.deliverToClient(replyTo, JSON.stringify({ error: "unauthorized", code: 401 }));
          return;
        }
        state.registered = true;
        server.deliverToClient(replyTo, JSON.stringify({ peerId, registered: true }));
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
  return { handler, state };
}

const TENANT = "acme";
const AGENT = "agent-1";
const PEER = "user-42";
const JWT = "bootstrap.jwt.token";

async function settle(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 5));
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

describe("WebChannelNatsClient PoP registration wiring (NATS)", () => {
  it("registers (challenge → register) BEFORE publishing the handshake frame", async () => {
    const device = await generateDevicePopKeyPair();
    const reg = registerSubject(TENANT, AGENT, PEER);
    const hs = handshakeSubject(TENANT, AGENT, PEER);

    const client = new WebChannelNatsClient({
      url: "ws://127.0.0.1:4222",
      jwt: JWT,
      accountId: AGENT,
      tenant: TENANT,
      peerId: PEER,
      registration: { devicePrivateKey: device.privateKey },
    });
    client.connect();
    const server = FakeNatsWS.instances.at(-1)!;
    const agent = makeRegisterAndHandshakeAgent(TENANT, AGENT, PEER);

    // Wiretap: capture whether the register op had completed at the moment the
    // handshake frame was published.
    let handshakePublishedBeforeRegister = false;
    server.handler = (subject, payload, srv, replyTo) => {
      if (subject === hs && !agent.state.registered) handshakePublishedBeforeRegister = true;
      return agent.handler(subject, payload, srv, replyTo);
    };

    await settle();

    // Both register round-trips happened, in order, on the register subject with
    // a reply-to inbox, carrying the JWT/op/nonce/signature.
    const regPubs = server.published.filter((p) => p.subject === reg);
    expect(regPubs).toHaveLength(2);
    const challenge = JSON.parse(regPubs[0].payload) as { op?: string; token?: string };
    const register = JSON.parse(regPubs[1].payload) as {
      op?: string;
      token?: string;
      nonce?: string;
      signature?: string;
    };
    expect(challenge.op).toBe("challenge");
    expect(challenge.token).toBe(JWT);
    expect(regPubs[0].replyTo).toMatch(/reginbox/);
    expect(register.op).toBe("register");
    expect(register.token).toBe(JWT);
    expect(register.nonce).toBe("nonce-abc");
    expect(typeof register.signature).toBe("string");

    // The handshake was published only AFTER the register round-trip resolved.
    expect(handshakePublishedBeforeRegister).toBe(false);
    expect(server.published.some((p) => p.subject === hs)).toBe(true);

    client.disconnect();
  });

  it("fail-closed: a rejected proof (unauthorized → PopRejectedError) publishes no handshake / no .in, and fires onError", async () => {
    const device = await generateDevicePopKeyPair();
    const errors: Error[] = [];
    const client = new WebChannelNatsClient({
      url: "ws://127.0.0.1:4222",
      jwt: JWT,
      accountId: AGENT,
      tenant: TENANT,
      peerId: PEER,
      registration: { devicePrivateKey: device.privateKey },
    });
    client.onError((err) => errors.push(err));
    client.connect();
    const server = FakeNatsWS.instances.at(-1)!;
    server.handler = makeRegisterAndHandshakeAgent(TENANT, AGENT, PEER, {
      rejectRegister: true,
    }).handler;

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
    const states: boolean[] = [];
    const client = new WebChannelNatsClient({
      url: "ws://127.0.0.1:4222",
      jwt: JWT,
      accountId: AGENT,
      tenant: TENANT,
      peerId: PEER,
      registration: { devicePrivateKey: device.privateKey },
    });
    client.onState((connected) => states.push(connected));
    client.connect();
    const server = FakeNatsWS.instances.at(-1)!;
    server.handler = makeRegisterAndHandshakeAgent(TENANT, AGENT, PEER, {
      rejectRegister: true,
    }).handler;

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

  it("no registration config → handshake published immediately, no register round-trip", async () => {
    const hs = handshakeSubject(TENANT, AGENT, PEER);
    const reg = registerSubject(TENANT, AGENT, PEER);

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
    server.handler = makeRegisterAndHandshakeAgent(TENANT, AGENT, PEER).handler;

    await settle();

    // Handshake published (current behaviour preserved) and the register subject
    // was never touched (no challenge/register round-trip).
    expect(server.published.some((p) => p.subject === hs)).toBe(true);
    expect(server.published.some((p) => p.subject === reg)).toBe(false);

    client.disconnect();
  });
});
