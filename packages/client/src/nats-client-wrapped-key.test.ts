/**
 * Production browser NATS client — register-delivered conversation key tests
 * (Phase 6 multi-device).
 *
 * When `registration.deviceX25519PrivateKey` is supplied, the session key is
 * the agent-owned conversation key K, delivered WRAPPED in the register HTTP
 * response. Proves:
 *   - the client unwraps K and seals/opens with it, publishing NO `.handshake`
 *     frame and never subscribing the handshake subject (register↔auto
 *     divergence, client half);
 *   - two clients (devices) given the SAME K each decrypt the same broadcast
 *     ciphertext — the multi-device property end-to-end at the client layer;
 *   - fail-closed terminals: a register response with NO wrapped key, or a
 *     TAMPERED wrapped key, never falls back to the handshake and surfaces via
 *     onError with the socket torn down;
 *   - wrap conformance: a wrap produced the AGENT's way (node:crypto X25519 +
 *     HKDF-SHA256 "webchannel-key-wrap-v1" + chacha20-poly1305, mirroring
 *     packages/plugin/src/late-join-decryptor.ts) unwraps byte-identically in
 *     the browser implementation.
 */

import {
  createCipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  WebChannelNatsClient,
  inboundSubject,
  outboundSubject,
  handshakeSubject,
} from "./nats-client.js";
import {
  generateX25519KeyPair,
  unwrapConversationKey,
  sealMessage,
  openMessage,
  base64urlDecode,
  type WrappedConversationKey,
} from "./e2e-crypto-browser.js";
import { generateDevicePopKeyPair } from "./pop-register.js";

// ---------------------------------------------------------------------------
// Agent-side wrap, implemented EXACTLY like the plugin's late-join-decryptor
// (node:crypto, independent of the browser implementation under test).
// ---------------------------------------------------------------------------

/** Build a DER SPKI from a raw 32-byte X25519 public key (RFC 8410 prefix). */
function x25519RawToSpki(raw: Uint8Array): Buffer {
  const prefix = Buffer.from("302a300506032b656e032100", "hex");
  return Buffer.concat([prefix, Buffer.from(raw)]);
}

function wrapLikeAgent(
  conversationKey: Uint8Array,
  devicePublicKeyRaw: Uint8Array,
): WrappedConversationKey {
  // Fresh ephemeral X25519 pair.
  const ephemeral = generateKeyPairSync("x25519");
  const ephemeralRaw = (
    ephemeral.publicKey.export({ type: "spki", format: "der" }) as Buffer
  ).subarray(-32);

  // ECDH: ephemeral private × device public.
  const devicePub = createPublicKey({
    key: x25519RawToSpki(devicePublicKeyRaw),
    type: "spki",
    format: "der",
  });
  const shared = diffieHellman({
    privateKey: createPrivateKey(
      ephemeral.privateKey.export({ type: "pkcs8", format: "pem" }) as string,
    ),
    publicKey: devicePub,
  });

  // HKDF-SHA256 with the shared key-wrap info (32 zero-byte default salt).
  const wrapKey = Buffer.from(
    hkdfSync("sha256", shared, Buffer.alloc(32), "webchannel-key-wrap-v1", 32),
  );

  // ChaCha20-Poly1305 seal (no AAD — matches the plugin's encrypt()).
  const nonce = randomBytes(12);
  const cipher = createCipheriv("chacha20-poly1305", wrapKey, nonce, { authTagLength: 16 });
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(conversationKey)), cipher.final()]);
  const tag = cipher.getAuthTag();

  const b64 = (b: Buffer | Uint8Array) => Buffer.from(b).toString("base64url");
  return {
    ephemeralPublicKey: b64(ephemeralRaw),
    nonce: b64(nonce),
    ciphertext: b64(ciphertext),
    tag: b64(tag),
  };
}

// ---------------------------------------------------------------------------
// Fake nats-server over a fake WebSocket (mirrors nats-client-register.test.ts)
// ---------------------------------------------------------------------------

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

  private readonly subs = new Map<string, number>();
  readonly published: Array<{ subject: string; payload: string }> = [];

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
      const header = data.slice(0, idx).split(" ");
      const subject = header[1];
      const payload = data.slice(idx + 2).replace(/\r\n$/, "");
      this.published.push({ subject, payload });
      return;
    }
  }

  subscribedSubjects(): string[] {
    return [...this.subs.keys()];
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

/** Register-route mock returning `wrapped` (or omitting it when null). */
function makeRegisterFetch(wrapped: () => WrappedConversationKey | null): typeof fetch {
  return (async (url: string | URL | Request) => {
    const u = String(url);
    if (u.endsWith("/webchannel/nats/register/challenge")) {
      return jsonResponse({ nonce: "nonce-abc" });
    }
    if (u.endsWith("/webchannel/nats/register")) {
      const w = wrapped();
      return jsonResponse(
        w
          ? { peerId: PEER, registered: true, wrappedConversationKey: w }
          : { peerId: PEER, registered: true },
      );
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

async function makeClient(wrapped: () => WrappedConversationKey | null): Promise<{
  client: WebChannelNatsClient;
  deviceKP: Awaited<ReturnType<typeof generateX25519KeyPair>>;
}> {
  const pop = await generateDevicePopKeyPair();
  const deviceKP = await generateX25519KeyPair();
  const client = new WebChannelNatsClient({
    url: "ws://127.0.0.1:4222",
    jwt: JWT,
    accountId: AGENT,
    tenant: TENANT,
    peerId: PEER,
    registration: {
      registerBaseUrl: BASE,
      devicePrivateKey: pop.privateKey,
      deviceX25519PrivateKey: deviceKP.privateKey,
      fetchImpl: makeRegisterFetch(wrapped),
    },
  });
  return { client, deviceKP };
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

describe("WebChannelNatsClient register-delivered conversation key (Phase 6)", () => {
  it("unwraps K from the register response, seals with it, and never touches .handshake", async () => {
    const K = new Uint8Array(randomBytes(32));
    let deviceKPRef: Awaited<ReturnType<typeof generateX25519KeyPair>> | null = null;
    const { client, deviceKP } = await makeClient(() =>
      wrapLikeAgent(K, deviceKPRef!.publicKeyBytes),
    );
    deviceKPRef = deviceKP;

    const received: unknown[] = [];
    client.onMessage((m) => received.push(m));
    client.connect();
    const server = FakeNatsWS.instances.at(-1)!;
    client.sendUserMessage("hello agent");
    await settle();

    // Divergence, client half: handshake subject neither subscribed nor published.
    const hs = handshakeSubject(TENANT, AGENT, PEER);
    expect(server.subscribedSubjects()).not.toContain(hs);
    expect(server.published.some((p) => p.subject === hs)).toBe(false);

    // The buffered send flushed as ciphertext sealed with EXACTLY K.
    const inS = inboundSubject(TENANT, AGENT, PEER);
    const sent = server.published.filter((p) => p.subject === inS);
    expect(sent).toHaveLength(1);
    expect(sent[0].payload).not.toContain("hello agent");
    expect(openMessage(sent[0].payload, K)).toEqual({ type: "user_message", text: "hello agent" });

    // Inbound sealed with K decrypts and is delivered.
    const outS = outboundSubject(TENANT, AGENT, PEER);
    server.deliverToClient(
      outS,
      sealMessage({ accountId: AGENT, tenant: TENANT, sub: PEER }, K, {
        type: "agent_message",
        text: "hi device",
      }),
    );
    await settle(2);
    expect(received).toEqual([{ type: "agent_message", text: "hi device" }]);

    client.disconnect();
  });

  it("multi-device: two clients with the SAME K both decrypt one broadcast ciphertext", async () => {
    const K = new Uint8Array(randomBytes(32));
    let kpA: Awaited<ReturnType<typeof generateX25519KeyPair>> | null = null;
    let kpB: Awaited<ReturnType<typeof generateX25519KeyPair>> | null = null;
    const a = await makeClient(() => wrapLikeAgent(K, kpA!.publicKeyBytes));
    kpA = a.deviceKP;
    const b = await makeClient(() => wrapLikeAgent(K, kpB!.publicKeyBytes));
    kpB = b.deviceKP;

    const gotA: unknown[] = [];
    const gotB: unknown[] = [];
    a.client.onMessage((m) => gotA.push(m));
    b.client.onMessage((m) => gotB.push(m));
    a.client.connect();
    const serverA = FakeNatsWS.instances.at(-1)!;
    b.client.connect();
    const serverB = FakeNatsWS.instances.at(-1)!;
    await settle();

    // ONE ciphertext, fanned out to both device sockets.
    const outS = outboundSubject(TENANT, AGENT, PEER);
    const wire = sealMessage({ accountId: AGENT, tenant: TENANT, sub: PEER }, K, {
      type: "agent_message",
      text: "fanout",
    });
    serverA.deliverToClient(outS, wire);
    serverB.deliverToClient(outS, wire);
    await settle(2);

    expect(gotA).toEqual([{ type: "agent_message", text: "fanout" }]);
    expect(gotB).toEqual([{ type: "agent_message", text: "fanout" }]);

    a.client.disconnect();
    b.client.disconnect();
  });

  it("fail-closed terminal: register response without wrappedConversationKey → onError, no handshake fallback", async () => {
    const { client } = await makeClient(() => null);
    const errors: Error[] = [];
    client.onError((e) => errors.push(e));
    client.connect();
    const server = FakeNatsWS.instances.at(-1)!;
    client.sendUserMessage("never-sent");
    await settle();

    expect(errors).toHaveLength(1);
    expect(errors[0].message).toMatch(/wrappedConversationKey/);
    expect(server.readyState).toBe(FakeNatsWS.CLOSED);
    // NO downgrade: no handshake frame, no plaintext, nothing on .in.
    expect(server.published.some((p) => p.subject === handshakeSubject(TENANT, AGENT, PEER))).toBe(false);
    expect(server.published.some((p) => p.subject === inboundSubject(TENANT, AGENT, PEER))).toBe(false);
  });

  it("fail-closed terminal: tampered wrapped key (Poly1305 reject) → onError, nothing published", async () => {
    const K = new Uint8Array(randomBytes(32));
    let kpRef: Awaited<ReturnType<typeof generateX25519KeyPair>> | null = null;
    const { client, deviceKP } = await makeClient(() => {
      const w = wrapLikeAgent(K, kpRef!.publicKeyBytes);
      // Flip a ciphertext byte → tag verification must fail on unwrap.
      const bad = base64urlDecode(w.ciphertext);
      bad[0] ^= 0xff;
      return { ...w, ciphertext: Buffer.from(bad).toString("base64url") };
    });
    kpRef = deviceKP;

    const errors: Error[] = [];
    client.onError((e) => errors.push(e));
    client.connect();
    const server = FakeNatsWS.instances.at(-1)!;
    client.sendUserMessage("never-sent");
    await settle();

    expect(errors).toHaveLength(1);
    expect(server.readyState).toBe(FakeNatsWS.CLOSED);
    expect(server.published.some((p) => p.subject === inboundSubject(TENANT, AGENT, PEER))).toBe(false);
  });
});

describe("unwrapConversationKey conformance (agent wrap ↔ browser unwrap)", () => {
  it("recovers exactly K from an agent-style wrap", async () => {
    const K = new Uint8Array(randomBytes(32));
    const deviceKP = await generateX25519KeyPair();
    const wrapped = wrapLikeAgent(K, deviceKP.publicKeyBytes);
    const recovered = await unwrapConversationKey(wrapped, deviceKP.privateKey);
    expect(Buffer.from(recovered).equals(Buffer.from(K))).toBe(true);
  });

  it("a different device's private key cannot unwrap (Poly1305 reject)", async () => {
    const K = new Uint8Array(randomBytes(32));
    const deviceKP = await generateX25519KeyPair();
    const otherKP = await generateX25519KeyPair();
    const wrapped = wrapLikeAgent(K, deviceKP.publicKeyBytes);
    await expect(unwrapConversationKey(wrapped, otherKP.privateKey)).rejects.toThrow();
  });
});
