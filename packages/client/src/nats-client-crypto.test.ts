/**
 * Production browser NATS client — encryption / handshake / fail-closed tests.
 *
 * Drives WebChannelNatsClient against a fake nats-server whose "agent" side uses
 * the SAME e2e-crypto-browser helpers, proving the client:
 *   - performs the X25519 handshake on .handshake,
 *   - seals outbound to .in and decrypts inbound from .out (correct direction),
 *   - is fail-closed: buffers sends until the handshake completes and never puts
 *     plaintext on the wire.
 *
 * Node ≥18 exposes crypto.subtle with X25519, so the full handshake runs here.
 * End-to-end interop with the real plugin agent is covered by the live e2e gate
 * (e2e-browser-client ↔ e2e-roundtrip-agent); this file proves the client wiring.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  WebChannelNatsClient,
  inboundSubject,
  outboundSubject,
  handshakeSubject,
  type InboundMessage,
} from "./nats-client.js";
import {
  CONVERSATION_KDF_INFO,
  canonicalAad,
  generateX25519KeyPair,
  deriveConversationKey,
  keyExchangeFrame,
  parseKeyExchange,
  sealMessage,
  openMessage,
} from "./e2e-crypto-browser.js";

// ---------------------------------------------------------------------------
// Fake nats-server over a fake WebSocket
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

// An "agent" that mirrors the plugin: handshake → derive key → echo replies.
function makeAgentSim(
  tenant: string,
  accountId: string,
  peerId: string,
  echoPrefix = "echo: ",
): ServerHandler {
  let sessionKey: Uint8Array | null = null;
  const hs = handshakeSubject(tenant, accountId, peerId);
  const inS = inboundSubject(tenant, accountId, peerId);
  const outS = outboundSubject(tenant, accountId, peerId);
  return async (subject, payload, server) => {
    if (subject === hs) {
      const browserPub = parseKeyExchange(payload);
      if (!browserPub) return;
      const agentKP = await generateX25519KeyPair();
      sessionKey = await deriveConversationKey(agentKP.privateKey, browserPub);
      server.deliverToClient(hs, keyExchangeFrame(agentKP.publicKeyB64url));
      return;
    }
    if (subject === inS && sessionKey) {
      const msg = openMessage(payload, sessionKey) as { type?: string; text?: string } | null;
      if (msg?.type === "user_message") {
        const reply = sealMessage({ accountId, tenant, sub: peerId }, sessionKey, {
          type: "agent_message",
          text: `${echoPrefix}${msg.text}`,
        });
        server.deliverToClient(outS, reply);
      }
    }
  };
}

const TENANT = "acme";
const AGENT = "agent-1";
const PEER = "user-42";

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

function startClient(): { client: WebChannelNatsClient; server: FakeNatsWS; received: InboundMessage[] } {
  const client = new WebChannelNatsClient({
    url: "ws://127.0.0.1:4222",
    jwt: "",
    accountId: AGENT,
    tenant: TENANT,
    peerId: PEER,
  });
  const received: InboundMessage[] = [];
  client.onMessage((m) => received.push(m));
  client.connect();
  const server = FakeNatsWS.instances.at(-1)!;
  server.handler = makeAgentSim(TENANT, AGENT, PEER);
  return { client, server, received };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("WebChannelNatsClient (E2E encrypted)", () => {
  it("handshakes, seals to .in, and decrypts the agent reply from .out", async () => {
    const { client, server, received } = startClient();
    await settle();

    client.sendUserMessage("hello agent");
    await settle();

    expect(received).toContainEqual({ type: "agent_message", text: "echo: hello agent" });

    // Browser published to .in (not .out) — correct subject direction.
    const inPubs = server.published.filter((p) => p.subject === inboundSubject(TENANT, AGENT, PEER));
    expect(inPubs.length).toBeGreaterThan(0);
    expect(server.published.some((p) => p.subject === outboundSubject(TENANT, AGENT, PEER))).toBe(false);
    client.disconnect();
  });

  it("only ever puts ciphertext on .in (no plaintext on the wire)", async () => {
    const { client, server } = startClient();
    await settle();
    client.sendUserMessage("topsecret-probe");
    await settle();

    const inPubs = server.published.filter((p) => p.subject === inboundSubject(TENANT, AGENT, PEER));
    expect(inPubs.length).toBeGreaterThan(0);
    for (const p of inPubs) {
      expect(p.payload).not.toContain("topsecret-probe");
      expect(p.payload).not.toContain("user_message");
      const env = JSON.parse(p.payload) as { v: number; content?: { ciphertext?: string } };
      expect(env.v).toBe(1);
      expect(typeof env.content?.ciphertext).toBe("string");
    }
    client.disconnect();
  });

  it("fail-closed: a send issued before the handshake is buffered, then sealed (never plaintext)", async () => {
    const { client, server, received } = startClient();
    // Send IMMEDIATELY — the handshake has not completed yet, so this must be
    // buffered and never published as plaintext.
    client.sendUserMessage("early-message");

    // Nothing should hit .in until the handshake-derived key exists.
    const inSubjName = inboundSubject(TENANT, AGENT, PEER);
    expect(server.published.filter((p) => p.subject === inSubjName)).toEqual([]);

    await settle();

    // After the handshake, the buffered message is flushed — as ciphertext — and
    // the agent's reply comes back decrypted.
    const inPubs = server.published.filter((p) => p.subject === inSubjName);
    expect(inPubs.length).toBe(1);
    expect(inPubs[0].payload).not.toContain("early-message");
    expect(received).toContainEqual({ type: "agent_message", text: "echo: early-message" });
    client.disconnect();
  });

  it("drops an inbound .out frame it cannot decrypt", async () => {
    const { client, server, received } = startClient();
    await settle();
    // Garbage on .out → openMessage returns null → no listener notification.
    server.deliverToClient(outboundSubject(TENANT, AGENT, PEER), "not-an-envelope");
    await settle();
    expect(received).toEqual([]);
    client.disconnect();
  });
});

// ---------------------------------------------------------------------------
// Spec conformance (so browser ↔ agent stay byte-compatible)
// ---------------------------------------------------------------------------

describe("e2e-crypto-browser spec conformance", () => {
  it("uses the shared KDF info string", () => {
    expect(CONVERSATION_KDF_INFO).toBe("webchannel-conversation-v1");
  });

  it("computes canonical AAD with the fixed key order", () => {
    const routing = {
      accountId: "a",
      tenant: "t",
      sub: "s",
      messageId: "m",
      envelopeType: "conversation",
      ts: 123,
    };
    const expected = JSON.stringify({
      tenant: "t",
      accountId: "a",
      sub: "s",
      messageId: "m",
      envelopeType: "conversation",
      ts: 123,
    });
    expect(new TextDecoder().decode(canonicalAad(routing))).toBe(expected);
  });

  it("seals and opens a message round-trip with a fixed key", async () => {
    const key = await deriveConversationKey(
      (await generateX25519KeyPair()).privateKey,
      (await generateX25519KeyPair()).publicKeyB64url,
    );
    const wire = sealMessage({ accountId: "a", tenant: "t", sub: "s" }, key, {
      type: "user_message",
      text: "round-trips",
    });
    expect(wire).not.toContain("round-trips"); // ciphertext on the wire
    expect(openMessage(wire, key)).toEqual({ type: "user_message", text: "round-trips" });
  });

  it("openMessage returns null on a wrong key (drop, no throw)", async () => {
    const key = await deriveConversationKey(
      (await generateX25519KeyPair()).privateKey,
      (await generateX25519KeyPair()).publicKeyB64url,
    );
    const otherKey = await deriveConversationKey(
      (await generateX25519KeyPair()).privateKey,
      (await generateX25519KeyPair()).publicKeyB64url,
    );
    const wire = sealMessage({ accountId: "a", tenant: "t", sub: "s" }, key, { type: "user_message", text: "x" });
    expect(openMessage(wire, otherKey)).toBeNull();
  });
});
