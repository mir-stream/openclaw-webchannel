/**
 * Relay-opacity compliance tests — Sub-AC 3.
 *
 * Publishes conversation and approval messages through the NATS bus,
 * captures raw payloads at the relay/subscriber level (simulating an
 * operator with no session keys), and asserts:
 *
 *   (a) Zero plaintext content fields appear in transit payloads —
 *       the relay operator sees only base64url-encoded ciphertext blobs,
 *       never any readable message text, decision values, or body content.
 *
 *   (b) At-rest stored documents contain only ciphertext for content fields —
 *       the MessageEnvelope (at-rest format identical to wire format) stores
 *       only nonce/ciphertext/tag inside `content`; no plaintext bytes at rest.
 *
 *   (c) Routing metadata fields (agentId/tenant/sub) remain readable in
 *       plaintext — the relay operator can observe them (used for NATS subject
 *       routing / account isolation) but cannot read any content.
 *
 * Architecture
 * ────────────
 * A `RelayObserver` plays the role of the NATS relay operator: it connects
 * to the same FakeNatsBroker, subscribes to all conversation subjects, and
 * captures every raw `NatsMessage` payload it receives.  It deliberately holds
 * NO session key and makes NO attempt to decrypt.  Tests then inspect these
 * captured raw JSON strings to validate the three compliance assertions.
 *
 * The FakeNatsBroker (same in-process relay used for Sub-AC 2 integration
 * tests) ensures zero real TCP sockets.  All encryption is performed with the
 * X25519+HKDF-SHA256+ChaCha20-Poly1305 stack from `e2e-crypto` and
 * `e2e-envelope`.
 */

import { describe, it, expect, afterEach } from "vitest";
import WebSocket from "ws";

import { NatsTransport } from "./nats-transport.js";
import type { NatsMessage } from "./nats-transport.js";
import {
  encodeEnvelope,
  serializeEnvelope,
  deserializeEnvelope,
  decryptEnvelopeContent,
} from "./e2e-envelope.js";
import type { MessageEnvelope, EnvelopeRouting } from "./e2e-envelope.js";
import {
  generateKeyPair,
  deriveSharedSecret,
  hkdfSha256,
} from "./e2e-crypto.js";

// ---------------------------------------------------------------------------
// FakeNatsBroker — in-process NATS text-protocol relay
// (same semantics as Sub-AC 2 integration tests, isolated instance per suite)
// ---------------------------------------------------------------------------

class FakeNatsBroker {
  private readonly clients = new Map<string, (data: string) => void>();
  private readonly buffers = new Map<string, string>();
  private subscriptions: Array<{ subject: string; clientId: string; sid: number }> = [];
  private nextClientId = 0;

  createFactory(): (url: string) => WebSocket {
    return (_url: string) => {
      const clientId = `c${++this.nextClientId}`;
      const handlers = new Map<string, Array<(...args: unknown[]) => void>>();

      const pushToClient = (data: string): void => {
        handlers.get("message")?.forEach((fn) => fn(data));
      };
      this.clients.set(clientId, pushToClient);
      this.buffers.set(clientId, "");

      const broker = this;

      const fakeWs: any = {
        readyState: WebSocket.CONNECTING as number,
        on(event: string, fn: (...args: unknown[]) => void): typeof fakeWs {
          const list = handlers.get(event) ?? [];
          list.push(fn);
          handlers.set(event, list);
          return fakeWs;
        },
        send(data: string | Buffer): void {
          const str = Buffer.isBuffer(data) ? data.toString("utf8") : (data as string);
          broker.processClientData(clientId, str, pushToClient);
        },
        close(): void {
          fakeWs.readyState = WebSocket.CLOSED;
          broker.subscriptions = broker.subscriptions.filter((s) => s.clientId !== clientId);
          broker.clients.delete(clientId);
          broker.buffers.delete(clientId);
          handlers.get("close")?.forEach((fn) => fn());
        },
      };

      queueMicrotask(() => {
        fakeWs.readyState = WebSocket.OPEN;
        handlers.get("open")?.forEach((fn) => fn());
      });

      return fakeWs as unknown as WebSocket;
    };
  }

  private processClientData(
    clientId: string,
    data: string,
    pushToClient: (s: string) => void,
  ): void {
    const existing = this.buffers.get(clientId) ?? "";
    let buffer = existing + data;

    let crlfPos: number;
    while ((crlfPos = buffer.indexOf("\r\n")) !== -1) {
      const line = buffer.slice(0, crlfPos);
      buffer = buffer.slice(crlfPos + 2);

      if (!line) continue;
      if (line.startsWith("CONNECT ")) continue;

      if (line === "PING") {
        pushToClient(`INFO {"server_id":"fake-nats-broker","version":"2.10.0"}\r\nPONG\r\n`);
        continue;
      }

      if (line === "PONG") continue;

      if (line.startsWith("SUB ")) {
        const parts = line.split(" ");
        const subject = parts[1] ?? "";
        const sid = parseInt(parts[2] ?? "0", 10);
        if (subject) this.subscriptions.push({ subject, clientId, sid });
        continue;
      }

      if (line.startsWith("UNSUB ")) {
        const sid = parseInt(line.split(" ")[1] ?? "0", 10);
        this.subscriptions = this.subscriptions.filter(
          (s) => !(s.clientId === clientId && s.sid === sid),
        );
        continue;
      }

      if (line.startsWith("PUB ")) {
        const parts = line.split(" ");
        const subject = parts[1] ?? "";
        const byteCount = parseInt(parts[2] ?? "0", 10);

        if (isNaN(byteCount) || byteCount < 0 || !subject) continue;

        if (buffer.length < byteCount + 2) {
          buffer = `${line}\r\n${buffer}`;
          break;
        }

        const payload = buffer.slice(0, byteCount);
        buffer = buffer.slice(byteCount + 2);

        for (const sub of this.subscriptions) {
          if (sub.subject === subject) {
            const push = this.clients.get(sub.clientId);
            if (push) push(`MSG ${subject} ${sub.sid} ${byteCount}\r\n${payload}\r\n`);
          }
        }
        continue;
      }

      if (line === "+OK") continue;
    }

    this.buffers.set(clientId, buffer);
  }

  dispose(): void {
    this.clients.clear();
    this.buffers.clear();
    this.subscriptions = [];
  }
}

// ---------------------------------------------------------------------------
// RelayObserver — simulates a NATS relay operator with NO session keys.
//
// The relay operator can:
//  • Subscribe to any subject and receive raw NatsMessage payloads.
//  • Parse the envelope JSON and read routing metadata (agentId/tenant/sub).
//  • Observe the ciphertext blob inside content.
//
// The relay operator CANNOT:
//  • Decrypt any content (no session key).
//  • Read any conversation text, approval decisions, or agent responses.
// ---------------------------------------------------------------------------

type CapturedMessage = {
  subject: string;
  rawJson: string;
  parsed: MessageEnvelope | null;
};

class RelayObserver {
  private readonly transport: NatsTransport;
  readonly captured: CapturedMessage[] = [];

  constructor(broker: FakeNatsBroker) {
    this.transport = new NatsTransport({
      url: "ws://fake-nats:4222",
      clientName: "relay-observer",
      _wsFactory: broker.createFactory(),
    });
  }

  async connect(): Promise<void> {
    await this.transport.connect();
    this.transport.on("message", (msg: NatsMessage) => {
      const rawJson = msg.payload.toString("utf8");
      let parsed: MessageEnvelope | null = null;
      try {
        parsed = deserializeEnvelope(rawJson);
      } catch {
        // Not a valid MessageEnvelope — captured as raw-only.
      }
      this.captured.push({ subject: msg.subject, rawJson, parsed });
    });
  }

  subscribe(subject: string): void {
    this.transport.subscribe(subject);
  }

  disconnect(): void {
    this.transport.disconnect();
  }
}

// ---------------------------------------------------------------------------
// Crypto helpers
// ---------------------------------------------------------------------------

/**
 * Derive a 32-byte session key via ECDH(myPriv, theirPub) + HKDF-SHA256.
 * Commutative: both sides produce the same key.
 */
function deriveSessionKey(
  myPriv: Uint8Array,
  theirPub: Uint8Array,
  info: string,
): Uint8Array {
  return hkdfSha256(deriveSharedSecret(myPriv, theirPub), null, info, 32);
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

/** Canonical NATS subjects used in relay-opacity tests (plaintext routing metadata). */
const SUBJECTS = {
  INBOUND:  "chat.tenant1.agent1.user42.in",
  OUTBOUND: "chat.tenant1.agent1.user42.out",
  HISTORY:  "chat.tenant1.agent1.user42.history",
  APPROVAL: "chat.tenant1.agent1.user42.approval",
  TYPING:   "chat.tenant1.agent1.user42.typing",
} as const;

/** Plaintext routing metadata embedded in every envelope header. */
const BASE_ROUTING: EnvelopeRouting = {
  agentId:      "agent1",
  tenant:       "tenant1",
  sub:          "user42",
  messageId:    "msg-opacity-base",
  envelopeType: "conversation",
  ts:           1_718_000_000_000,
};

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);

/**
 * Assert that the content block of a MessageEnvelope is structurally opaque:
 *  - Exactly the three ciphertext fields (nonce, ciphertext, tag).
 *  - No plaintext content fields (text, body, decision, …).
 */
function assertContentBlockIsOpaque(env: MessageEnvelope, label: string): void {
  const content = env.content as Record<string, unknown>;
  const keys = Object.keys(content).sort();

  expect(keys, `[${label}] content must have exactly {ciphertext, nonce, tag}`).toEqual(
    ["ciphertext", "nonce", "tag"],
  );

  expect(typeof content["nonce"],      `[${label}] content.nonce must be string`).toBe("string");
  expect(typeof content["ciphertext"], `[${label}] content.ciphertext must be string`).toBe("string");
  expect(typeof content["tag"],        `[${label}] content.tag must be string`).toBe("string");
  expect((content["nonce"] as string).length,      `[${label}] content.nonce non-empty`).toBeGreaterThan(0);
  expect((content["ciphertext"] as string).length, `[${label}] content.ciphertext non-empty`).toBeGreaterThan(0);
  expect((content["tag"] as string).length,        `[${label}] content.tag non-empty`).toBeGreaterThan(0);

  // No content-semantic fields allowed inside the content block.
  for (const k of ["text", "body", "message", "plaintext", "decision", "reason", "prompt", "data", "payload"]) {
    expect(content[k], `[${label}] content must not have "${k}" field`).toBeUndefined();
  }
}

/**
 * Assert that routing metadata fields are readable in plaintext in a raw
 * JSON NATS payload string, and that known secret strings are absent.
 */
function assertRoutingIsPlaintext(
  rawJson: string,
  routing: EnvelopeRouting,
  label: string,
): void {
  expect(rawJson, `[${label}] agentId in plaintext`).toContain(routing.agentId);
  expect(rawJson, `[${label}] tenant in plaintext`).toContain(routing.tenant);
  expect(rawJson, `[${label}] sub in plaintext`).toContain(routing.sub);
  expect(rawJson, `[${label}] messageId in plaintext`).toContain(routing.messageId);
  expect(rawJson, `[${label}] envelopeType in plaintext`).toContain(routing.envelopeType);
}

// ---------------------------------------------------------------------------
// Shared test-rig factory
// ---------------------------------------------------------------------------

type TestRig = {
  agent:              NatsTransport;
  browser:            NatsTransport;
  relay:              RelayObserver;
  agentReceived:      NatsMessage[];
  browserReceived:    NatsMessage[];
  sessionKeyConv:     Uint8Array;
  sessionKeyApproval: Uint8Array;
  agentKP:            ReturnType<typeof generateKeyPair>;
  browserKP:          ReturnType<typeof generateKeyPair>;
};

async function makeRig(broker: FakeNatsBroker): Promise<TestRig> {
  const agentKP   = generateKeyPair();
  const browserKP = generateKeyPair();

  const sessionKeyConv = deriveSessionKey(
    agentKP.privateKey, browserKP.publicKey, "webchannel-conversation-v1",
  );
  const sessionKeyApproval = deriveSessionKey(
    agentKP.privateKey, browserKP.publicKey, "webchannel-approval-v1",
  );

  const agent   = new NatsTransport({ url: "ws://fake-nats:4222", clientName: "relay-test-agent",   _wsFactory: broker.createFactory() });
  const browser = new NatsTransport({ url: "ws://fake-nats:4222", clientName: "relay-test-browser",  _wsFactory: broker.createFactory() });
  const relay   = new RelayObserver(broker);

  await Promise.all([agent.connect(), browser.connect(), relay.connect()]);

  // Relay observer subscribes to all test subjects (simulates operator-level access).
  for (const subject of Object.values(SUBJECTS)) {
    relay.subscribe(subject);
  }

  const agentReceived:   NatsMessage[] = [];
  const browserReceived: NatsMessage[] = [];

  agent.on("message",   (m: NatsMessage) => agentReceived.push(m));
  browser.on("message", (m: NatsMessage) => browserReceived.push(m));

  agent.subscribe(SUBJECTS.INBOUND);
  agent.subscribe(SUBJECTS.APPROVAL);
  browser.subscribe(SUBJECTS.OUTBOUND);
  browser.subscribe(SUBJECTS.HISTORY);
  browser.subscribe(SUBJECTS.APPROVAL);

  return { agent, browser, relay, agentReceived, browserReceived, sessionKeyConv, sessionKeyApproval, agentKP, browserKP };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Relay-opacity compliance (Sub-AC 3)", () => {
  const teardown: Array<NatsTransport | RelayObserver> = [];
  const brokers:  FakeNatsBroker[] = [];

  afterEach(() => {
    for (const t of teardown) {
      try { t.disconnect(); } catch { /* best-effort */ }
    }
    teardown.length = 0;
    for (const b of brokers) b.dispose();
    brokers.length = 0;
  });

  // ── Test 1: Conversation message transit — relay sees no plaintext ─────────

  it(
    "(a) relay observer captures zero plaintext content in a conversation message transit",
    async () => {
      const broker = new FakeNatsBroker();
      brokers.push(broker);
      const rig = await makeRig(broker);
      teardown.push(rig.agent, rig.browser, rig.relay);

      const secretText = "top-secret conversation payload — relay must not read this!";
      const routing: EnvelopeRouting = {
        ...BASE_ROUTING,
        envelopeType: "conversation",
        messageId: "msg-conv-001",
      };
      rig.browser.publish(
        SUBJECTS.INBOUND,
        serializeEnvelope(encodeEnvelope(routing, enc(secretText), rig.sessionKeyConv)),
      );

      // Relay captured exactly one message.
      expect(rig.relay.captured).toHaveLength(1);
      const { rawJson, subject, parsed } = rig.relay.captured[0]!;
      expect(subject).toBe(SUBJECTS.INBOUND);
      expect(parsed).not.toBeNull();

      // (a) Secret content must not appear anywhere in the raw transit JSON.
      expect(rawJson).not.toContain("top-secret");
      expect(rawJson).not.toContain("relay must not read");
      expect(rawJson).not.toContain(secretText);

      // Content block is structurally opaque.
      assertContentBlockIsOpaque(parsed!, "conversation transit");

      // Content block JSON string must not expose any content-level keywords.
      const contentJson = JSON.stringify(parsed!.content);
      expect(contentJson).not.toContain("top-secret");
      expect(contentJson).not.toContain("relay must not");
    },
  );

  // ── Test 2: Approval decision transit — relay sees no plaintext ───────────

  it(
    "(a) relay observer captures zero plaintext content in an approval_decision transit",
    async () => {
      const broker = new FakeNatsBroker();
      brokers.push(broker);
      const rig = await makeRig(broker);
      teardown.push(rig.agent, rig.browser, rig.relay);

      const approvalId = "approval-7a8b9c";
      const aad = enc(approvalId);
      const secretDecisionBody = JSON.stringify({
        decision: "allow-once",
        reason: "User clicked approve — relay must not see this",
      });

      const routing: EnvelopeRouting = {
        ...BASE_ROUTING,
        envelopeType: "approval_decision",
        messageId: approvalId,
      };
      rig.browser.publish(
        SUBJECTS.APPROVAL,
        serializeEnvelope(encodeEnvelope(routing, enc(secretDecisionBody), rig.sessionKeyApproval, aad)),
      );

      expect(rig.relay.captured).toHaveLength(1);
      const { rawJson, parsed } = rig.relay.captured[0]!;

      // (a) No decision-content plaintext in transit.
      expect(rawJson).not.toContain("allow-once");
      expect(rawJson).not.toContain("User clicked");
      expect(rawJson).not.toContain("relay must not see");

      assertContentBlockIsOpaque(parsed!, "approval_decision transit");

      // The approvalId appears only in routing (messageId) — NOT inside content.
      const contentJson = JSON.stringify(parsed!.content);
      expect(contentJson).not.toContain("allow-once");
      expect(contentJson).not.toContain("7a8b9c");

      // (c) Routing discriminator and messageId are plaintext.
      expect(rawJson).toContain("approval_decision");
      expect(rawJson).toContain(approvalId);  // messageId routing
    },
  );

  // ── Test 3: Approval request transit — relay sees no plaintext ────────────

  it(
    "(a) relay observer captures zero plaintext content in an approval_request transit",
    async () => {
      const broker = new FakeNatsBroker();
      brokers.push(broker);
      const rig = await makeRig(broker);
      teardown.push(rig.agent, rig.browser, rig.relay);

      const secretRequestBody = JSON.stringify({
        prompt: "Agent wants to send a confidential email — relay must not read this",
        options: ["allow-once", "deny"],
      });

      const routing: EnvelopeRouting = {
        ...BASE_ROUTING,
        envelopeType: "approval_request",
        messageId: "approval-req-001",
      };
      rig.agent.publish(
        SUBJECTS.APPROVAL,
        serializeEnvelope(encodeEnvelope(routing, enc(secretRequestBody), rig.sessionKeyApproval)),
      );

      expect(rig.relay.captured).toHaveLength(1);
      const { rawJson, parsed } = rig.relay.captured[0]!;

      // (a) No content plaintext in transit.
      expect(rawJson).not.toContain("confidential email");
      expect(rawJson).not.toContain("relay must not read");
      expect(rawJson).not.toContain("allow-once");

      assertContentBlockIsOpaque(parsed!, "approval_request transit");

      // (c) envelopeType routing is readable.
      expect(rawJson).toContain("approval_request");
      expect(rawJson).toContain("approval-req-001");
    },
  );

  // ── Test 4: Agent response transit — relay sees no plaintext ─────────────

  it(
    "(a) relay observer captures zero plaintext content in an agent response transit",
    async () => {
      const broker = new FakeNatsBroker();
      brokers.push(broker);
      const rig = await makeRig(broker);
      teardown.push(rig.agent, rig.browser, rig.relay);

      const secretAgentReply = JSON.stringify({
        type: "agent_message",
        text: "Confidential agent reply — relay operator must not read this!",
      });

      const routing: EnvelopeRouting = {
        ...BASE_ROUTING,
        envelopeType: "conversation",
        messageId: "msg-agent-reply-001",
      };
      rig.agent.publish(
        SUBJECTS.OUTBOUND,
        serializeEnvelope(encodeEnvelope(routing, enc(secretAgentReply), rig.sessionKeyConv)),
      );

      expect(rig.relay.captured).toHaveLength(1);
      const { rawJson, parsed } = rig.relay.captured[0]!;

      // (a) No content plaintext in transit.
      expect(rawJson).not.toContain("Confidential agent reply");
      expect(rawJson).not.toContain("relay operator must not read");
      expect(rawJson).not.toContain("agent_message");

      assertContentBlockIsOpaque(parsed!, "agent response transit");

      // (c) Routing readable.
      expect(rawJson).toContain("agent1");
      expect(rawJson).toContain("tenant1");
      expect(rawJson).toContain("user42");
    },
  );

  // ── Test 5: At-rest storage opacity ──────────────────────────────────────

  it(
    "(b) at-rest stored MessageEnvelope contains only ciphertext for content fields",
    async () => {
      const broker = new FakeNatsBroker();
      brokers.push(broker);
      const rig = await makeRig(broker);
      teardown.push(rig.agent, rig.browser, rig.relay);

      // Simulate the agent's authority store: stores received envelopes as-is.
      // MessageEnvelope is the at-rest format (identical to wire format).
      const atRestStore: MessageEnvelope[] = [];

      rig.agent.on("message", (msg: NatsMessage) => {
        try {
          atRestStore.push(deserializeEnvelope(msg.payload));
        } catch { /* skip non-envelope messages */ }
      });

      const secretMessages = [
        "Secret message #1 — at-rest MUST be ciphertext only!",
        "Secret message #2 — confidential historical content",
        "Secret message #3 — sensitive stored payload",
      ];

      for (let i = 0; i < secretMessages.length; i++) {
        const routing: EnvelopeRouting = {
          ...BASE_ROUTING,
          messageId: `msg-atrest-${i + 1}`,
          envelopeType: "conversation",
        };
        rig.browser.publish(
          SUBJECTS.INBOUND,
          serializeEnvelope(
            encodeEnvelope(routing, enc(secretMessages[i]!), rig.sessionKeyConv),
          ),
        );
      }

      // Agent stored all three envelopes.
      expect(atRestStore).toHaveLength(3);

      for (let i = 0; i < atRestStore.length; i++) {
        const stored = atRestStore[i]!;
        const label = `at-rest[${i + 1}]`;

        // (b) Content block is opaque.
        assertContentBlockIsOpaque(stored, label);

        // Serialize the stored document and check for plaintext content leaks.
        const atRestJson = JSON.stringify(stored);
        expect(atRestJson, `[${label}] secret text #1 not at rest`).not.toContain("Secret message");
        expect(atRestJson, `[${label}] "at-rest MUST be ciphertext" not at rest`).not.toContain("at-rest MUST be");
        expect(atRestJson, `[${label}] "confidential historical" not at rest`).not.toContain("confidential historical");
        expect(atRestJson, `[${label}] "sensitive stored" not at rest`).not.toContain("sensitive stored");

        // Routing metadata IS present at rest (needed for replay/pagination).
        expect(atRestJson, `[${label}] agentId at rest`).toContain("agent1");
        expect(atRestJson, `[${label}] tenant at rest`).toContain("tenant1");
        expect(atRestJson, `[${label}] sub at rest`).toContain("user42");
        expect(atRestJson, `[${label}] messageId at rest`).toContain(`msg-atrest-${i + 1}`);

        // At-rest top-level keys are exactly the envelope schema keys.
        const storedKeys = new Set(Object.keys(stored));
        const allowedKeys = new Set(["v", "agentId", "tenant", "sub", "messageId", "envelopeType", "ts", "content"]);
        for (const k of storedKeys) {
          expect(allowedKeys.has(k), `[${label}] unexpected top-level at-rest key "${k}"`).toBe(true);
        }
      }
    },
  );

  // ── Test 6: Routing metadata is plaintext-readable by the relay operator ──

  it(
    "(c) routing metadata (agentId, tenant, sub, envelopeType) is plaintext-readable in all transit payloads",
    async () => {
      const broker = new FakeNatsBroker();
      brokers.push(broker);
      const rig = await makeRig(broker);
      teardown.push(rig.agent, rig.browser, rig.relay);

      // Publish one envelope of every supported type.
      const cases: Array<{
        type: EnvelopeRouting["envelopeType"];
        subject: (typeof SUBJECTS)[keyof typeof SUBJECTS];
        sender: "agent" | "browser";
      }> = [
        { type: "conversation",      subject: SUBJECTS.INBOUND,   sender: "browser" },
        { type: "conversation",      subject: SUBJECTS.OUTBOUND,  sender: "agent"   },
        { type: "approval_request",  subject: SUBJECTS.APPROVAL,  sender: "agent"   },
        { type: "approval_decision", subject: SUBJECTS.APPROVAL,  sender: "browser" },
        { type: "approval_resolved", subject: SUBJECTS.APPROVAL,  sender: "agent"   },
        { type: "history",           subject: SUBJECTS.HISTORY,   sender: "agent"   },
      ];

      for (let i = 0; i < cases.length; i++) {
        const { type, subject, sender } = cases[i]!;
        const routing: EnvelopeRouting = {
          agentId: "agent1", tenant: "tenant1", sub: "user42",
          messageId: `msg-routing-${i + 1}`,
          envelopeType: type,
          ts: 1_718_000_000_000 + i,
        };
        const wireBytes = serializeEnvelope(
          encodeEnvelope(routing, enc(`secret-payload-${i}`), rig.sessionKeyConv),
        );
        if (sender === "browser") {
          rig.browser.publish(subject, wireBytes);
        } else {
          rig.agent.publish(subject, wireBytes);
        }
      }

      expect(rig.relay.captured).toHaveLength(cases.length);

      for (let i = 0; i < rig.relay.captured.length; i++) {
        const { rawJson, parsed } = rig.relay.captured[i]!;
        const label = `routing-check-${i + 1}`;

        // (c) All routing metadata is plaintext-readable.
        assertRoutingIsPlaintext(rawJson, {
          agentId: "agent1", tenant: "tenant1", sub: "user42",
          messageId: `msg-routing-${i + 1}`,
          envelopeType: cases[i]!.type,
          ts: 1_718_000_000_000 + i,
        }, label);

        // (a) But the content is NOT plaintext.
        expect(rawJson, `[${label}] content secret must not appear`).not.toContain(`secret-payload-${i}`);
        assertContentBlockIsOpaque(parsed!, label);
      }
    },
  );

  // ── Test 7: Full conversation round-trip — relay sees ciphertext throughout ─

  it(
    "(a,c) full conversation round-trip: browser→agent→browser all transit as ciphertext; relay reads routing only",
    async () => {
      const broker = new FakeNatsBroker();
      brokers.push(broker);
      const rig = await makeRig(broker);
      teardown.push(rig.agent, rig.browser, rig.relay);

      // Step 1: Browser sends an encrypted user message.
      const userSecret = "User says: relay must not read this conversation turn!";
      const routingUser: EnvelopeRouting = { ...BASE_ROUTING, envelopeType: "conversation", messageId: "conv-turn-1" };
      rig.browser.publish(
        SUBJECTS.INBOUND,
        serializeEnvelope(encodeEnvelope(routingUser, enc(userSecret), rig.sessionKeyConv)),
      );

      // Agent received the envelope; it CAN decrypt (holds the session key).
      expect(rig.agentReceived).toHaveLength(1);
      const agentDecrypted = dec(
        decryptEnvelopeContent(
          deserializeEnvelope(rig.agentReceived[0]!.payload),
          rig.sessionKeyConv,
        ),
      );
      expect(agentDecrypted).toBe(userSecret);  // Agent CAN read it.

      // Step 2: Agent publishes an encrypted reply.
      const agentSecret = "Agent replies: relay must not read this either!";
      const routingAgent: EnvelopeRouting = { ...BASE_ROUTING, envelopeType: "conversation", messageId: "conv-turn-2" };
      rig.agent.publish(
        SUBJECTS.OUTBOUND,
        serializeEnvelope(encodeEnvelope(routingAgent, enc(agentSecret), rig.sessionKeyConv)),
      );

      // Browser received the envelope; it CAN decrypt (holds the session key).
      expect(rig.browserReceived).toHaveLength(1);
      const browserDecrypted = dec(
        decryptEnvelopeContent(
          deserializeEnvelope(rig.browserReceived[0]!.payload),
          rig.sessionKeyConv,
        ),
      );
      expect(browserDecrypted).toBe(agentSecret);  // Browser CAN read it.

      // Relay captured both transit messages.
      expect(rig.relay.captured).toHaveLength(2);

      for (const { rawJson, parsed, subject } of rig.relay.captured) {
        // (a) No plaintext content in either transit payload.
        expect(rawJson, `[${subject}] user secret must not appear`).not.toContain("relay must not read");
        expect(rawJson, `[${subject}] user text must not appear`).not.toContain("User says");
        expect(rawJson, `[${subject}] agent text must not appear`).not.toContain("Agent replies");

        assertContentBlockIsOpaque(parsed!, `full-conv[${subject}]`);

        // (c) Routing metadata is readable in every captured payload.
        expect(rawJson).toContain("agent1");
        expect(rawJson).toContain("tenant1");
        expect(rawJson).toContain("user42");
        expect(rawJson).toContain("conversation");
      }
    },
  );

  // ── Test 8: Full approval flow opacity (request → decision → resolved) ────

  it(
    "(a,c) full approval flow (request→decision→resolved): all transit as ciphertext; routing readable",
    async () => {
      const broker = new FakeNatsBroker();
      brokers.push(broker);
      const rig = await makeRig(broker);
      teardown.push(rig.agent, rig.browser, rig.relay);

      const approvalId = "approval-opacity-test-1";
      const aad = enc(approvalId);

      // Step 1: Agent → browser: approval_request.
      rig.agent.publish(
        SUBJECTS.APPROVAL,
        serializeEnvelope(encodeEnvelope(
          { ...BASE_ROUTING, envelopeType: "approval_request", messageId: approvalId },
          enc(JSON.stringify({ prompt: "Approve confidential action? — relay must not see", options: ["allow-once", "deny"] })),
          rig.sessionKeyApproval, aad,
        )),
      );

      // Step 2: Browser → agent: approval_decision.
      rig.browser.publish(
        SUBJECTS.APPROVAL,
        serializeEnvelope(encodeEnvelope(
          { ...BASE_ROUTING, envelopeType: "approval_decision", messageId: approvalId },
          enc(JSON.stringify({ decision: "allow-once" })),
          rig.sessionKeyApproval, aad,
        )),
      );

      // Step 3: Agent → browser: approval_resolved.
      rig.agent.publish(
        SUBJECTS.APPROVAL,
        serializeEnvelope(encodeEnvelope(
          { ...BASE_ROUTING, envelopeType: "approval_resolved", messageId: approvalId },
          enc(JSON.stringify({ decision: "allow-once", resolvedBy: "first-write-wins" })),
          rig.sessionKeyApproval, aad,
        )),
      );

      // Relay captured all three approval messages.
      expect(rig.relay.captured).toHaveLength(3);

      const [reqCapture, decCapture, resCapture] = rig.relay.captured;

      // (a) No content plaintext in any of the three transit payloads.
      for (const { rawJson, parsed, subject } of rig.relay.captured) {
        expect(rawJson, `[${subject}] "confidential action" must not appear`).not.toContain("confidential action");
        expect(rawJson, `[${subject}] "relay must not see" must not appear`).not.toContain("relay must not see");
        expect(rawJson, `[${subject}] "allow-once" decision must not appear`).not.toContain("allow-once");
        expect(rawJson, `[${subject}] "resolvedBy" field must not appear`).not.toContain("resolvedBy");

        assertContentBlockIsOpaque(parsed!, `approval-flow[${subject}]`);

        // The AAD / approvalId must NOT leak into the content block.
        const contentJson = JSON.stringify(parsed!.content);
        expect(contentJson).not.toContain("allow-once");
        expect(contentJson).not.toContain("resolvedBy");
      }

      // (c) envelopeType discriminators are readable as plaintext routing.
      expect(reqCapture!.rawJson).toContain("approval_request");
      expect(decCapture!.rawJson).toContain("approval_decision");
      expect(resCapture!.rawJson).toContain("approval_resolved");

      // (c) The approvalId appears in routing (messageId) — allowed.
      for (const { rawJson } of rig.relay.captured) {
        expect(rawJson).toContain(approvalId);  // messageId routing
        expect(rawJson).toContain("agent1");
        expect(rawJson).toContain("tenant1");
        expect(rawJson).toContain("user42");
      }
    },
  );

  // ── Test 9: Relay operator cannot decrypt with a third-party key ───────────

  it(
    "(a) relay operator with a third-party X25519 key cannot decrypt any transit payload",
    async () => {
      const broker = new FakeNatsBroker();
      brokers.push(broker);
      const rig = await makeRig(broker);
      teardown.push(rig.agent, rig.browser, rig.relay);

      // Relay operator generates their OWN key pair (not part of the session).
      const relayOperatorKP = generateKeyPair();

      // The relay operator's attempted session key (derived from their private
      // key plus an observable agent public key).  This yields a DIFFERENT key
      // from the real session key because the ECDH secret is different.
      const relayAttemptedKey = deriveSessionKey(
        relayOperatorKP.privateKey,
        rig.agentKP.publicKey,
        "webchannel-conversation-v1",
      );

      // Verify the relay operator's key is genuinely different.
      expect(
        Buffer.from(relayAttemptedKey).toString("hex"),
      ).not.toBe(
        Buffer.from(rig.sessionKeyConv).toString("hex"),
      );

      // Browser sends an encrypted message.
      const secretText = "Relay-key-attack: operator must not decrypt this payload!";
      rig.browser.publish(
        SUBJECTS.INBOUND,
        serializeEnvelope(encodeEnvelope(
          { ...BASE_ROUTING, envelopeType: "conversation", messageId: "msg-key-attack" },
          enc(secretText),
          rig.sessionKeyConv,
        )),
      );

      expect(rig.relay.captured).toHaveLength(1);
      const { rawJson, parsed } = rig.relay.captured[0]!;

      // Relay operator CAN read routing metadata (it's plaintext).
      expect(parsed!.agentId).toBe("agent1");
      expect(parsed!.tenant).toBe("tenant1");
      expect(parsed!.sub).toBe("user42");

      // But relay operator CANNOT decrypt with their attempted key.
      expect(() => decryptEnvelopeContent(parsed!, relayAttemptedKey)).toThrow();

      // Nor with an all-zeros key.
      expect(() => decryptEnvelopeContent(parsed!, new Uint8Array(32))).toThrow();

      // Nor with a deterministic non-zero key.
      const deterministicKey = new Uint8Array(32);
      for (let i = 0; i < 32; i++) deterministicKey[i] = (i * 7 + 13) % 256;
      expect(() => decryptEnvelopeContent(parsed!, deterministicKey)).toThrow();

      // The secret text is nowhere in the raw transit JSON.
      expect(rawJson).not.toContain("Relay-key-attack");
      expect(rawJson).not.toContain("operator must not decrypt");
    },
  );

  // ── Test 10: History backlog replay — relay sees ciphertext in history ─────

  it(
    "(a,b,c) history backlog replay: relay captures history envelopes as ciphertext; routing readable",
    async () => {
      const broker = new FakeNatsBroker();
      brokers.push(broker);
      const rig = await makeRig(broker);
      teardown.push(rig.agent, rig.browser, rig.relay);

      const historyItems = [
        { id: "h-1", text: "History entry 1 — at-rest must not leak to relay" },
        { id: "h-2", text: "History entry 2 — confidential backlog item" },
        { id: "h-3", text: "History entry 3 — sensitive historical record" },
      ];

      // Agent replays encrypted backlog envelopes outbound.
      for (const item of historyItems) {
        rig.agent.publish(
          SUBJECTS.HISTORY,
          serializeEnvelope(encodeEnvelope(
            { ...BASE_ROUTING, envelopeType: "history", messageId: item.id },
            enc(JSON.stringify({ id: item.id, text: item.text, role: "user" })),
            rig.sessionKeyConv,
          )),
        );
      }

      expect(rig.relay.captured).toHaveLength(3);

      for (let i = 0; i < rig.relay.captured.length; i++) {
        const { rawJson, parsed, subject } = rig.relay.captured[i]!;
        const label = `history[${i + 1}]`;

        // (a) No content plaintext in transit.
        expect(rawJson, `[${label}] text must not appear`).not.toContain(historyItems[i]!.text);
        expect(rawJson, `[${label}] "History entry" must not appear`).not.toContain("History entry");
        expect(rawJson, `[${label}] "confidential backlog" must not appear`).not.toContain("confidential backlog");

        // (b) At-rest format (same as wire) is opaque.
        assertContentBlockIsOpaque(parsed!, label);

        // (c) Routing metadata readable.
        expect(rawJson).toContain("agent1");
        expect(rawJson).toContain("tenant1");
        expect(rawJson).toContain("user42");
        expect(rawJson).toContain("history");             // envelopeType
        expect(rawJson).toContain(historyItems[i]!.id);  // messageId routing
        expect(subject).toBe(SUBJECTS.HISTORY);
      }
    },
  );

  // ── Test 11: Typing signal — envelope structure remains opaque ────────────

  it(
    "(a,c) ephemeral typing signal: envelope is opaque; routing readable; no content leak",
    async () => {
      const broker = new FakeNatsBroker();
      brokers.push(broker);
      const rig = await makeRig(broker);
      teardown.push(rig.agent, rig.browser, rig.relay);

      // Typing signals carry a minimal JSON payload (the "typing" indicator).
      // Even though the semantic is ephemeral, the envelope still wraps the
      // content as ciphertext so the relay operator cannot observe it.
      rig.agent.publish(
        SUBJECTS.TYPING,
        serializeEnvelope(encodeEnvelope(
          { ...BASE_ROUTING, envelopeType: "typing", messageId: "typing-001" },
          enc(JSON.stringify({ typing: true })),
          rig.sessionKeyConv,
        )),
      );

      expect(rig.relay.captured).toHaveLength(1);
      const { rawJson, parsed } = rig.relay.captured[0]!;

      // Envelope structure is still valid and opaque.
      assertContentBlockIsOpaque(parsed!, "typing signal");

      // (c) Routing is readable.
      expect(rawJson).toContain("typing");
      expect(rawJson).toContain("agent1");
      expect(rawJson).toContain("tenant1");
      expect(rawJson).toContain("user42");
    },
  );

  // ── Test 12: Schema version is plaintext (needed for protocol evolution) ───

  it(
    "(c) schema version (v: 1) is plaintext-readable by relay for protocol evolution",
    async () => {
      const broker = new FakeNatsBroker();
      brokers.push(broker);
      const rig = await makeRig(broker);
      teardown.push(rig.agent, rig.browser, rig.relay);

      rig.browser.publish(
        SUBJECTS.INBOUND,
        serializeEnvelope(encodeEnvelope(
          { ...BASE_ROUTING, messageId: "msg-version-check" },
          enc("secret payload"),
          rig.sessionKeyConv,
        )),
      );

      expect(rig.relay.captured).toHaveLength(1);
      const { rawJson, parsed } = rig.relay.captured[0]!;

      // Schema version is plaintext for relay-level protocol routing.
      expect(parsed!.v).toBe(1);
      const topLevel = JSON.parse(rawJson) as Record<string, unknown>;
      expect(topLevel["v"]).toBe(1);

      // But the payload is still opaque.
      expect(rawJson).not.toContain("secret payload");
    },
  );

  // ── Test 13: Multi-device fan-out — all device subscribers see ciphertext ─

  it(
    "(a,c) multi-device fan-out: all device subscribers see ciphertext; relay captures no plaintext",
    async () => {
      const broker = new FakeNatsBroker();
      brokers.push(broker);

      // Three browser devices subscribed to the same outbound subject.
      const deviceA = new NatsTransport({ url: "ws://fake-nats:4222", clientName: "device-a", _wsFactory: broker.createFactory() });
      const deviceB = new NatsTransport({ url: "ws://fake-nats:4222", clientName: "device-b", _wsFactory: broker.createFactory() });
      const deviceC = new NatsTransport({ url: "ws://fake-nats:4222", clientName: "device-c", _wsFactory: broker.createFactory() });
      const agentT  = new NatsTransport({ url: "ws://fake-nats:4222", clientName: "agent",     _wsFactory: broker.createFactory() });
      const relayT  = new RelayObserver(broker);

      await Promise.all([deviceA.connect(), deviceB.connect(), deviceC.connect(), agentT.connect(), relayT.connect()]);

      const devicesReceived: Array<NatsMessage[]> = [[], [], []];
      deviceA.on("message", (m: NatsMessage) => devicesReceived[0]!.push(m));
      deviceB.on("message", (m: NatsMessage) => devicesReceived[1]!.push(m));
      deviceC.on("message", (m: NatsMessage) => devicesReceived[2]!.push(m));

      deviceA.subscribe(SUBJECTS.OUTBOUND);
      deviceB.subscribe(SUBJECTS.OUTBOUND);
      deviceC.subscribe(SUBJECTS.OUTBOUND);
      relayT.subscribe(SUBJECTS.OUTBOUND);

      teardown.push(deviceA, deviceB, deviceC, agentT, relayT);
      brokers.push(broker);

      // Agent publishes an encrypted message to all devices.
      const agentKP   = generateKeyPair();
      const browserKP = generateKeyPair();
      const sessionKey = deriveSessionKey(agentKP.privateKey, browserKP.publicKey, "webchannel-conversation-v1");

      const secretMulti = "Multi-device secret: all devices receive ciphertext, relay included!";
      agentT.publish(
        SUBJECTS.OUTBOUND,
        serializeEnvelope(encodeEnvelope(
          { ...BASE_ROUTING, envelopeType: "conversation", messageId: "msg-fanout-001" },
          enc(secretMulti),
          sessionKey,
        )),
      );

      // All three devices received the message.
      expect(devicesReceived[0]).toHaveLength(1);
      expect(devicesReceived[1]).toHaveLength(1);
      expect(devicesReceived[2]).toHaveLength(1);

      // Relay also captured it (operator sees all traffic on subscribed subjects).
      expect(relayT.captured).toHaveLength(1);
      const { rawJson, parsed } = relayT.captured[0]!;

      // (a) Relay sees no plaintext content even in fan-out scenario.
      expect(rawJson).not.toContain("Multi-device secret");
      expect(rawJson).not.toContain("relay included");

      assertContentBlockIsOpaque(parsed!, "multi-device fan-out");

      // (c) Routing is plaintext for all subscribers including relay.
      expect(rawJson).toContain("agent1");
      expect(rawJson).toContain("tenant1");
      expect(rawJson).toContain("user42");

      // Each device receives the SAME encrypted envelope (ciphertext, not plaintext).
      for (let d = 0; d < 3; d++) {
        const deviceMsg = devicesReceived[d]![0]!;
        const deviceJson = deviceMsg.payload.toString("utf8");
        expect(deviceJson).not.toContain("Multi-device secret");
        expect(deviceJson).not.toContain("relay included");
        // Devices that hold the key CAN decrypt; relay (without key) cannot.
        const deviceEnv = deserializeEnvelope(deviceJson);
        expect(() => decryptEnvelopeContent(deviceEnv, sessionKey)).not.toThrow();
      }
    },
  );
});
