/**
 * Production browser NATS client — register-delivered conversation key tests
 * (Phase 6 multi-device).
 *
 * When `registration.deviceX25519PrivateKey` is supplied, the session key is the
 * agent-owned conversation key K, delivered WRAPPED in the register reply (now
 * over NATS request/reply, not HTTP). Proves:
 *   - the client unwraps K and seals/opens with it, publishing NO `.handshake`
 *     frame and never subscribing the handshake subject (register↔auto
 *     divergence, client half);
 *   - two clients (devices) given the SAME K each decrypt the same broadcast
 *     ciphertext — the multi-device property end-to-end at the client layer;
 *   - fail-closed terminals: a register reply with NO wrapped key, or a TAMPERED
 *     wrapped key, never falls back to the handshake and surfaces via onError with
 *     the socket torn down;
 *   - wrap conformance: a wrap produced the AGENT's way (node:crypto X25519 +
 *     HKDF-SHA256 "webchannel-key-wrap-v1" + chacha20-poly1305, mirroring
 *     packages/plugin/src/late-join-decryptor.ts) unwraps byte-identically in the
 *     browser implementation.
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
  registerSubject,
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

/**
 * A node:crypto X25519 identity key pair standing in for the AGENT's SaaS-attested
 * identity key. `privatePem` feeds `diffieHellman`; `publicB64url` is what the
 * SaaS pins into the bootstrap response (and the browser passes as
 * `registration.pinnedAgentPublicKey`).
 */
function makeAgentIdentity(): { privatePem: string; publicRaw: Uint8Array; publicB64url: string } {
  const kp = generateKeyPairSync("x25519");
  const publicRaw = new Uint8Array(
    (kp.publicKey.export({ type: "spki", format: "der" }) as Buffer).subarray(-32),
  );
  return {
    privatePem: kp.privateKey.export({ type: "pkcs8", format: "pem" }) as string,
    publicRaw,
    publicB64url: Buffer.from(publicRaw).toString("base64url"),
  };
}

/**
 * Wrap K the AGENT's way (F2 static-static): ECDH(agentIdentity.private,
 * device.public) → HKDF "webchannel-key-wrap-v1" → chacha20-poly1305 sealing K
 * with AAD = UTF-8(peerId). The `ephemeralPublicKey` field carries the agent
 * identity PUBLIC key (the one-release compat alias). Mirrors
 * packages/plugin/src/late-join-decryptor.ts exactly, independent of the browser
 * impl under test. `wrapPrivatePem` defaults to the agent identity but a test can
 * pass a DIFFERENT key (a relay's key) to prove the browser rejects it.
 */
function wrapLikeAgent(
  conversationKey: Uint8Array,
  devicePublicKeyRaw: Uint8Array,
  agentIdentity: { privatePem: string; publicRaw: Uint8Array },
  peerId: string,
  wrapPrivatePem: string = agentIdentity.privatePem,
): WrappedConversationKey {
  // ECDH: wrap private × device public. The public half emitted in the wire field
  // is always the agent identity public (compat alias), even when a relay wraps
  // under a different private key — the browser IGNORES the field anyway.
  const devicePub = createPublicKey({
    key: x25519RawToSpki(devicePublicKeyRaw),
    type: "spki",
    format: "der",
  });
  const shared = diffieHellman({
    privateKey: createPrivateKey(wrapPrivatePem),
    publicKey: devicePub,
  });

  // HKDF-SHA256 with the shared key-wrap info (32 zero-byte default salt).
  const wrapKey = Buffer.from(
    hkdfSync("sha256", shared, Buffer.alloc(32), "webchannel-key-wrap-v1", 32),
  );

  // ChaCha20-Poly1305 seal, binding peerId into the AAD (F2 anti-lift) — matches
  // the plugin's encrypt(wrapKey, K, wrapAad(peerId)).
  const nonce = randomBytes(12);
  const cipher = createCipheriv("chacha20-poly1305", wrapKey, nonce, { authTagLength: 16 });
  cipher.setAAD(Buffer.from(peerId, "utf8"), { plaintextLength: conversationKey.length });
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(conversationKey)), cipher.final()]);
  const tag = cipher.getAuthTag();

  const b64 = (b: Buffer | Uint8Array) => Buffer.from(b).toString("base64url");
  return {
    ephemeralPublicKey: b64(agentIdentity.publicRaw),
    nonce: b64(nonce),
    ciphertext: b64(ciphertext),
    tag: b64(tag),
  };
}

// ---------------------------------------------------------------------------
// Fake nats-server over a fake WebSocket (mirrors nats-client-register.test.ts)
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

  private readonly subs = new Map<string, number>();
  readonly published: Array<{ subject: string; payload: string; replyTo?: string }> = [];
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

async function settle(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 5));
}

/**
 * Register-agent handler over the reply-to inbox: challenge → nonce, register →
 * `{peerId, registered, wrappedConversationKey?}` from `wrapped()` (omitted when
 * it returns null). `gate`, when provided, holds the register REPLY so a test can
 * race the NATS `.out` snapshot ahead of the delivered key.
 */
function registerAgentHandler(
  peerId: string,
  wrapped: () => WrappedConversationKey | null,
  gate?: Promise<void>,
): ServerHandler {
  const reg = registerSubject(TENANT, AGENT, peerId);
  return async (subject, payload, server, replyTo) => {
    if (subject !== reg || !replyTo) return;
    const body = JSON.parse(payload) as { op?: string };
    if (body.op === "challenge") {
      server.deliverToClient(replyTo, JSON.stringify({ nonce: "nonce-abc" }));
      return;
    }
    if (body.op === "register") {
      if (gate) await gate;
      const w = wrapped();
      server.deliverToClient(
        replyTo,
        JSON.stringify(
          w ? { peerId, registered: true, wrappedConversationKey: w } : { peerId, registered: true },
        ),
      );
    }
  };
}

async function makeClient(agentPublicKeyB64: string): Promise<{
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
      devicePrivateKey: pop.privateKey,
      deviceX25519PrivateKey: deviceKP.privateKey,
      // F2: the browser pins the SaaS-attested agent identity key; K is unwrapped
      // against THIS, never against the wire-carried `ephemeralPublicKey`.
      pinnedAgentPublicKey: agentPublicKeyB64,
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
  it("unwraps K from the register reply, seals with it, and never touches .handshake", async () => {
    const K = new Uint8Array(randomBytes(32));
    const agentId = makeAgentIdentity();
    const { client, deviceKP } = await makeClient(agentId.publicB64url);

    const received: unknown[] = [];
    client.onMessage((m) => received.push(m));
    client.connect();
    const server = FakeNatsWS.instances.at(-1)!;
    server.handler = registerAgentHandler(PEER, () =>
      wrapLikeAgent(K, deviceKP.publicKeyBytes, agentId, PEER),
    );
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
    // ONE agent identity: both devices pin the same attested agent key.
    const agentId = makeAgentIdentity();
    const a = await makeClient(agentId.publicB64url);
    const b = await makeClient(agentId.publicB64url);

    const gotA: unknown[] = [];
    const gotB: unknown[] = [];
    a.client.onMessage((m) => gotA.push(m));
    b.client.onMessage((m) => gotB.push(m));
    a.client.connect();
    const serverA = FakeNatsWS.instances.at(-1)!;
    serverA.handler = registerAgentHandler(PEER, () =>
      wrapLikeAgent(K, a.deviceKP.publicKeyBytes, agentId, PEER),
    );
    b.client.connect();
    const serverB = FakeNatsWS.instances.at(-1)!;
    serverB.handler = registerAgentHandler(PEER, () =>
      wrapLikeAgent(K, b.deviceKP.publicKeyBytes, agentId, PEER),
    );
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

  it("buffers a snapshot that beats the key unwrap, and delivers it once K is set (snapshot-vs-key race)", async () => {
    // Phase 6 race (review finding 2): the register-triggered history snapshot
    // travels NATS `.out` while the wrapped key travels the register reply — if
    // the snapshot lands first it must be BUFFERED, not dropped.
    const K = new Uint8Array(randomBytes(32));
    const agentId = makeAgentIdentity();
    const { client, deviceKP } = await makeClient(agentId.publicB64url);
    let releaseRegister = () => {};
    const gate = new Promise<void>((r) => { releaseRegister = r; });

    const received: unknown[] = [];
    client.onMessage((m) => received.push(m));
    client.connect();
    // Set the handler synchronously (before the challenge/register round-trip)
    // so the register REPLY (the wrapped key) is gated while the snapshot races.
    const server = FakeNatsWS.instances.at(-1)!;
    server.handler = registerAgentHandler(
      PEER,
      () => wrapLikeAgent(K, deviceKP.publicKeyBytes, agentId, PEER),
      gate,
    );
    await settle(4); // connected, .out subscribed, register in-flight (gated)

    const snapshot = {
      type: "history",
      messages: [{ id: "h1", role: "agent", text: "hydrated", ts: 1 }],
    };
    server.deliverToClient(
      outboundSubject(TENANT, AGENT, PEER),
      sealMessage({ accountId: AGENT, tenant: TENANT, sub: PEER }, K, snapshot),
    );
    await settle(2);
    expect(received).toHaveLength(0); // no key yet — buffered, never plaintext-processed

    releaseRegister();
    await settle();
    expect(received).toEqual([snapshot]); // drained right after unwrap

    client.disconnect();
  });

  it("#15: buffers an approval_snapshot that beats the key unwrap and delivers it once K is set", async () => {
    // The register-time `approval_snapshot` rides the SAME pre-key buffer path as
    // the history snapshot (this is the COMMON register ordering, not an edge):
    // it travels `.out` while the wrapped key travels the register reply.
    const K = new Uint8Array(randomBytes(32));
    const agentId = makeAgentIdentity();
    const { client, deviceKP } = await makeClient(agentId.publicB64url);
    let releaseRegister = () => {};
    const gate = new Promise<void>((r) => { releaseRegister = r; });

    const received: unknown[] = [];
    client.onMessage((m) => received.push(m));
    client.connect();
    const server = FakeNatsWS.instances.at(-1)!;
    server.handler = registerAgentHandler(
      PEER,
      () => wrapLikeAgent(K, deviceKP.publicKeyBytes, agentId, PEER),
      gate,
    );
    await settle(4); // connected, .out subscribed, register in-flight (gated)

    const snapshot = {
      type: "approval_snapshot",
      approvals: [
        {
          id: "exec-1",
          kind: "exec",
          title: "Run",
          prompt: "rm -rf /tmp/cache",
          options: [{ decision: "allow-once", label: "Allow", style: "success" }],
          expiresAtMs: 1_000,
        },
      ],
    };
    server.deliverToClient(
      outboundSubject(TENANT, AGENT, PEER),
      sealMessage({ accountId: AGENT, tenant: TENANT, sub: PEER }, K, snapshot),
    );
    await settle(2);
    expect(received).toHaveLength(0); // no key yet — buffered, never plaintext-processed

    releaseRegister();
    await settle();
    expect(received).toEqual([snapshot]); // drained right after unwrap

    client.disconnect();
  });

  it("fail-closed terminal: register reply without wrappedConversationKey → onError, no handshake fallback", async () => {
    const { client } = await makeClient(makeAgentIdentity().publicB64url);
    const errors: Error[] = [];
    client.onError((e) => errors.push(e));
    client.connect();
    const server = FakeNatsWS.instances.at(-1)!;
    server.handler = registerAgentHandler(PEER, () => null);
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
    const agentId = makeAgentIdentity();
    const { client, deviceKP } = await makeClient(agentId.publicB64url);

    const errors: Error[] = [];
    client.onError((e) => errors.push(e));
    client.connect();
    const server = FakeNatsWS.instances.at(-1)!;
    server.handler = registerAgentHandler(PEER, () => {
      const w = wrapLikeAgent(K, deviceKP.publicKeyBytes, agentId, PEER);
      // Flip a ciphertext byte → tag verification must fail on unwrap.
      const bad = base64urlDecode(w.ciphertext);
      bad[0] ^= 0xff;
      return { ...w, ciphertext: Buffer.from(bad).toString("base64url") };
    });
    client.sendUserMessage("never-sent");
    await settle();

    expect(errors).toHaveLength(1);
    expect(server.readyState).toBe(FakeNatsWS.CLOSED);
    expect(server.published.some((p) => p.subject === inboundSubject(TENANT, AGENT, PEER))).toBe(false);
  });

  it("F2 MITM: a relay's K′ wrapped to the device key (under a NON-agent key) is REJECTED → onError, terminal", async () => {
    // The relay reads the victim device public key from the plaintext register
    // request, generates its OWN X25519 key, and wraps its OWN K′ correctly to the
    // device key — but under a key the SaaS never attested. The browser derives the
    // unwrap key from the PINNED agent key, so ECDH(device, pinnedAgent) ≠
    // ECDH(device, relay) → Poly1305 fails. K′ is never adopted (no session MITM).
    const agentId = makeAgentIdentity(); // the genuine agent — its public is pinned
    const relay = makeAgentIdentity(); // the relay's substitute key (NOT pinned)
    const Kprime = new Uint8Array(randomBytes(32));
    const { client, deviceKP } = await makeClient(agentId.publicB64url);

    const errors: Error[] = [];
    client.onError((e) => errors.push(e));
    client.connect();
    const server = FakeNatsWS.instances.at(-1)!;
    // The relay even copies the genuine agent's public key into the wire field
    // (compat alias) to look legitimate — irrelevant, the browser ignores it and
    // derives from the pin. The actual wrap ECDH uses the relay's PRIVATE key.
    server.handler = registerAgentHandler(PEER, () =>
      wrapLikeAgent(Kprime, deviceKP.publicKeyBytes, agentId, PEER, relay.privatePem),
    );
    client.sendUserMessage("never-sent");
    await settle();

    expect(errors).toHaveLength(1);
    expect(server.readyState).toBe(FakeNatsWS.CLOSED);
    // K′ never became the session key → nothing sealed and published inbound.
    expect(server.published.some((p) => p.subject === inboundSubject(TENANT, AGENT, PEER))).toBe(false);
  });

  it("F2 fail-closed: register-delivered key with NO pinned agent key → onError, never derives from the wire", async () => {
    // A new browser against an old SaaS (bootstrap carried no agentPublicKey) must
    // refuse to unwrap rather than trust the wire-carried key.
    const agentId = makeAgentIdentity();
    const pop = await generateDevicePopKeyPair();
    const deviceKP = await generateX25519KeyPair();
    const client = new WebChannelNatsClient({
      url: "ws://127.0.0.1:4222",
      jwt: JWT,
      accountId: AGENT,
      tenant: TENANT,
      peerId: PEER,
      registration: {
        devicePrivateKey: pop.privateKey,
        deviceX25519PrivateKey: deviceKP.privateKey,
        // pinnedAgentPublicKey intentionally OMITTED.
      },
    });
    const errors: Error[] = [];
    client.onError((e) => errors.push(e));
    client.connect();
    const server = FakeNatsWS.instances.at(-1)!;
    const K = new Uint8Array(randomBytes(32));
    server.handler = registerAgentHandler(PEER, () =>
      wrapLikeAgent(K, deviceKP.publicKeyBytes, agentId, PEER),
    );
    client.sendUserMessage("never-sent");
    await settle();

    expect(errors).toHaveLength(1);
    expect(errors[0].message).toMatch(/pinned agent public key/i);
    expect(server.readyState).toBe(FakeNatsWS.CLOSED);
    expect(server.published.some((p) => p.subject === inboundSubject(TENANT, AGENT, PEER))).toBe(false);
  });
});

describe("unwrapConversationKey conformance (agent wrap ↔ browser unwrap)", () => {
  it("recovers exactly K from a genuine agent-identity wrap using the pinned key", async () => {
    const K = new Uint8Array(randomBytes(32));
    const agentId = makeAgentIdentity();
    const deviceKP = await generateX25519KeyPair();
    const wrapped = wrapLikeAgent(K, deviceKP.publicKeyBytes, agentId, PEER);
    const recovered = await unwrapConversationKey(
      wrapped,
      deviceKP.privateKey,
      agentId.publicB64url,
      PEER,
    );
    expect(Buffer.from(recovered).equals(Buffer.from(K))).toBe(true);
  });

  it("a different device's private key cannot unwrap (Poly1305 reject)", async () => {
    const K = new Uint8Array(randomBytes(32));
    const agentId = makeAgentIdentity();
    const deviceKP = await generateX25519KeyPair();
    const otherKP = await generateX25519KeyPair();
    const wrapped = wrapLikeAgent(K, deviceKP.publicKeyBytes, agentId, PEER);
    await expect(
      unwrapConversationKey(wrapped, otherKP.privateKey, agentId.publicB64url, PEER),
    ).rejects.toThrow();
  });

  it("F2: a wrap under a NON-pinned (relay) key is rejected even though it targets the device key", async () => {
    const K = new Uint8Array(randomBytes(32));
    const agentId = makeAgentIdentity(); // pinned
    const relay = makeAgentIdentity(); // the substitute
    const deviceKP = await generateX25519KeyPair();
    // Relay wraps K correctly to the device key, but under the relay's private key.
    const wrapped = wrapLikeAgent(K, deviceKP.publicKeyBytes, agentId, PEER, relay.privatePem);
    // Deriving from the PINNED agent key gives a different secret → Poly1305 fails.
    await expect(
      unwrapConversationKey(wrapped, deviceKP.privateKey, agentId.publicB64url, PEER),
    ).rejects.toThrow();
  });

  it("F2 AAD binding: a wrap for peerA is rejected when unwrapped as peerB", async () => {
    const K = new Uint8Array(randomBytes(32));
    const agentId = makeAgentIdentity();
    const deviceKP = await generateX25519KeyPair();
    const wrappedForA = wrapLikeAgent(K, deviceKP.publicKeyBytes, agentId, "peer-A");
    // Same device key, same pinned agent key, but unwrap claims peer-B → AAD
    // mismatch → Poly1305 fails (a relay cannot lift peerA's wrap onto peerB).
    await expect(
      unwrapConversationKey(wrappedForA, deviceKP.privateKey, agentId.publicB64url, "peer-B"),
    ).rejects.toThrow();
    // Sanity: the SAME wrap unwraps for the correct peer.
    const ok = await unwrapConversationKey(
      wrappedForA,
      deviceKP.privateKey,
      agentId.publicB64url,
      "peer-A",
    );
    expect(Buffer.from(ok).equals(Buffer.from(K))).toBe(true);
  });
});
