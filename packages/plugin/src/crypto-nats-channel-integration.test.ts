/**
 * CryptoNatsChannel — NATS-WebSocket E2E crypto integration tests (Sub-AC 2).
 *
 * Sub-AC 2: Integrate the crypto envelope module into the NATS-WebSocket chat
 * message send/receive path so all outbound payloads are sealed ciphertext and
 * inbound payloads are decrypted before delivery.
 *
 * Verification strategy
 * ─────────────────────
 * These tests use the FakeNatsBroker (in-process NATS text-protocol relay from
 * the Sub-AC 1 / Sub-AC 2 integration test suite) together with a WireTap
 * NatsTransport that captures every raw on-wire frame.  This allows us to:
 *
 *   1. Prove the outbound path seals ciphertext:
 *      • `channel.sendMessage(plaintext)` → the wire tap captures a raw frame.
 *      • The raw frame MUST NOT contain the plaintext string.
 *      • The raw frame MUST be a valid `MessageEnvelope` v1 with an opaque
 *        `content` block (nonce / ciphertext / tag — no plaintext fields).
 *
 *   2. Prove the inbound path decrypts correctly:
 *      • The receiving `CryptoNatsChannel` fires a `'message'` event.
 *      • The `DecryptedMessage.plaintext` MUST match the original plaintext.
 *
 *   3. Prove wrong-key isolation:
 *      • A third party with a different session key receives the same raw frame
 *        but cannot decrypt it (decryption emits `'error'`, no `'message'`).
 *
 * Tests cover:
 *   1. Chat message send → on-wire frame is opaque ciphertext
 *   2. Receiver decrypts ciphertext back to original plaintext
 *   3. Agent → browser and browser → agent directions
 *   4. Full approval flow (request → decision → resolved) all as ciphertext
 *   5. Full round-trip: browser sends → agent decrypts + re-publishes → browser
 *      decrypts the reply
 *   6. Backlog replay: agent replays encrypted history; browser decrypts each item
 *   7. Wrong-session-key isolation: third party cannot decrypt intercepted frame
 *   8. Multi-message fan-out: all subscribers receive ciphertext; keyed party decrypts
 *   9. Large payload (4 KB): round-trip integrity
 *  10. Typing signal (empty/minimal content): envelope structure correct
 */

import { describe, it, expect, afterEach } from "vitest";
import WebSocket from "ws";

import { NatsTransport } from "./nats-transport.js";
import type { NatsMessage } from "./nats-transport.js";
import { CryptoNatsChannel } from "./crypto-nats-channel.js";
import type { DecryptedMessage } from "./crypto-nats-channel.js";
import { deserializeEnvelope } from "./e2e-envelope.js";
import type { MessageEnvelope } from "./e2e-envelope.js";
import {
  generateKeyPair,
  deriveSharedSecret,
  hkdfSha256,
} from "./e2e-crypto.js";

// ---------------------------------------------------------------------------
// FakeNatsBroker — in-process NATS text-protocol relay (zero TCP sockets)
// (same implementation as nats-transport-integration.test.ts and
//  relay-opacity.test.ts, isolated instance per test suite)
//
// This version adds `echo: false` support: when a client sends
// `CONNECT {"echo":false,...}` it will NOT receive back messages that it
// published — matching the real NATS server behavior and how NatsTransport
// always configures itself.
// ---------------------------------------------------------------------------

class FakeNatsBroker {
  private readonly clients    = new Map<string, (data: string) => void>();
  private readonly buffers    = new Map<string, string>();
  private readonly noEchoSet  = new Set<string>(); // clients that sent echo:false
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
          broker.noEchoSet.delete(clientId);
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

      if (line.startsWith("CONNECT ")) {
        // Parse echo flag: NatsTransport always sends echo:false.
        // When echo is false the broker must NOT deliver a client's own PUBs
        // back to that client (exactly like a real NATS server).
        try {
          const payload = JSON.parse(line.slice("CONNECT ".length)) as Record<string, unknown>;
          if (payload["echo"] === false) {
            this.noEchoSet.add(clientId);
          }
        } catch { /* ignore malformed CONNECT body */ }
        continue;
      }

      if (line === "PING") {
        pushToClient(`INFO {"server_id":"fake-nats","version":"2.10.0"}\r\nPONG\r\n`);
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

        const noEcho = this.noEchoSet.has(clientId);
        for (const sub of this.subscriptions) {
          if (sub.subject !== subject) continue;
          // Skip echoing back to the publisher when echo:false was negotiated.
          if (noEcho && sub.clientId === clientId) continue;
          const push = this.clients.get(sub.clientId);
          if (push) push(`MSG ${subject} ${sub.sid} ${byteCount}\r\n${payload}\r\n`);
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
    this.noEchoSet.clear();
    this.subscriptions = [];
  }
}

// ---------------------------------------------------------------------------
// WireTap — captures raw NatsMessage frames (simulates relay operator view)
// ---------------------------------------------------------------------------

/**
 * WireTap connects to the FakeNatsBroker as a regular NatsTransport subscriber
 * and captures every raw `NatsMessage` payload. Unlike `RelayObserver` in
 * relay-opacity.test.ts, WireTap works at the NatsTransport level (not the
 * CryptoNatsChannel level) so it sees pre-decryption wire frames.
 */
class WireTap {
  readonly transport: NatsTransport;
  readonly captured: Array<{ subject: string; rawJson: string; parsed: MessageEnvelope | null }> = [];

  constructor(broker: FakeNatsBroker) {
    this.transport = new NatsTransport({
      url: "ws://fake-nats:4222",
      clientName: "wire-tap",
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
        /* not a valid envelope — raw only */
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

/** UTF-8 encode helper. */
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

/** UTF-8 decode helper. */
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);

// ---------------------------------------------------------------------------
// Test subjects (plaintext routing metadata — visible to NATS relay operator)
// ---------------------------------------------------------------------------

const SUBJECTS = {
  INBOUND:  "chat.tenant1.agent1.user42.in",   // browser → agent
  OUTBOUND: "chat.tenant1.agent1.user42.out",  // agent → browser
  HISTORY:  "chat.tenant1.agent1.user42.history",
  APPROVAL: "chat.tenant1.agent1.user42.approval",
  TYPING:   "chat.tenant1.agent1.user42.typing",
} as const;

/** Stable routing defaults for the test rig. */
const ROUTING_DEFAULTS = {
  agentId: "agent1",
  tenant:  "tenant1",
  sub:     "user42",
} as const;

// ---------------------------------------------------------------------------
// Test-rig factory
// ---------------------------------------------------------------------------

type TestRig = {
  agentTransport:   NatsTransport;
  browserTransport: NatsTransport;
  agentChannel:     CryptoNatsChannel;
  browserChannel:   CryptoNatsChannel;
  wireTap:          WireTap;
  sessionKey:       Uint8Array;
};

async function makeRig(broker: FakeNatsBroker): Promise<TestRig> {
  const agentKP   = generateKeyPair();
  const browserKP = generateKeyPair();

  // Both sides independently derive the same session key (commutative ECDH).
  const agentSessionKey   = deriveSessionKey(agentKP.privateKey,   browserKP.publicKey, "webchannel-conversation-v1");
  const browserSessionKey = deriveSessionKey(browserKP.privateKey, agentKP.publicKey,   "webchannel-conversation-v1");

  // Both keys must be identical (this is the fundamental ECDH property).
  // We keep both variables to document the symmetry; we'll use one for the rig.
  const sessionKey = agentSessionKey;

  const agentTransport   = new NatsTransport({ url: "ws://fake-nats:4222", clientName: "test-agent",   _wsFactory: broker.createFactory() });
  const browserTransport = new NatsTransport({ url: "ws://fake-nats:4222", clientName: "test-browser", _wsFactory: broker.createFactory() });
  const wireTap          = new WireTap(broker);

  await Promise.all([agentTransport.connect(), browserTransport.connect(), wireTap.connect()]);

  // Wire tap subscribes to all test subjects so it captures everything.
  for (const subject of Object.values(SUBJECTS)) {
    wireTap.subscribe(subject);
  }

  // CryptoNatsChannel wraps each transport with the shared session key.
  const agentChannel   = new CryptoNatsChannel(agentTransport,   agentSessionKey,   ROUTING_DEFAULTS);
  const browserChannel = new CryptoNatsChannel(browserTransport, browserSessionKey, ROUTING_DEFAULTS);

  return { agentTransport, browserTransport, agentChannel, browserChannel, wireTap, sessionKey };
}

// ---------------------------------------------------------------------------
// Helper: assert envelope content is opaque (only nonce/ciphertext/tag)
// ---------------------------------------------------------------------------

function assertEnvelopeIsOpaque(env: MessageEnvelope | null, label: string): void {
  expect(env, `[${label}] envelope must be a valid MessageEnvelope`).not.toBeNull();
  if (!env) return;

  const contentKeys = Object.keys(env.content).sort();
  expect(contentKeys, `[${label}] content must have exactly {ciphertext, nonce, tag}`).toEqual(
    ["ciphertext", "nonce", "tag"],
  );

  expect(typeof env.content.nonce,      `[${label}] nonce must be a string`).toBe("string");
  expect(typeof env.content.ciphertext, `[${label}] ciphertext must be a string`).toBe("string");
  expect(typeof env.content.tag,        `[${label}] tag must be a string`).toBe("string");
  expect(env.content.nonce.length,      `[${label}] nonce non-empty`).toBeGreaterThan(0);
  expect(env.content.ciphertext.length, `[${label}] ciphertext non-empty`).toBeGreaterThan(0);
  expect(env.content.tag.length,        `[${label}] tag non-empty`).toBeGreaterThan(0);
}

// ---------------------------------------------------------------------------
// Integration tests
// ---------------------------------------------------------------------------

describe("CryptoNatsChannel: E2E crypto integration over NATS-WS (Sub-AC 2)", () => {
  const teardown: Array<{ disconnect: () => void }> = [];
  const brokers:  FakeNatsBroker[] = [];

  afterEach(() => {
    for (const t of teardown) {
      try { t.disconnect(); } catch { /* best-effort */ }
    }
    teardown.length = 0;
    for (const b of brokers) b.dispose();
    brokers.length = 0;
  });

  // ── Test 1: Chat message send → on-wire frame is opaque ciphertext ────────

  it(
    "(1) sendMessage() produces an opaque ciphertext envelope on the wire (plaintext absent from raw frame)",
    async () => {
      const broker = new FakeNatsBroker();
      brokers.push(broker);
      const rig = await makeRig(broker);
      teardown.push(rig.agentTransport, rig.browserTransport, rig.wireTap);

      // Subscribe agent channel to inbound subject BEFORE browser sends.
      rig.agentChannel.subscribe(SUBJECTS.INBOUND);

      const plaintext = "Secret chat message — relay operator must NOT read this!";

      // Browser sends a plaintext message via CryptoNatsChannel (auto-encrypts).
      rig.browserChannel.sendMessage(SUBJECTS.INBOUND, plaintext, { envelopeType: "conversation" });

      // Wire tap captured exactly one frame.
      expect(rig.wireTap.captured).toHaveLength(1);
      const { rawJson, parsed } = rig.wireTap.captured[0]!;

      // ── Assertion A: plaintext does NOT appear in the raw on-wire frame ──────
      expect(rawJson, "plaintext must not appear in raw on-wire JSON").not.toContain("Secret chat message");
      expect(rawJson, "plaintext must not appear in raw on-wire JSON").not.toContain("relay operator must NOT read");
      expect(rawJson, "original text must not appear anywhere on wire").not.toContain(plaintext);

      // ── Assertion B: the frame is a valid MessageEnvelope with opaque content ─
      assertEnvelopeIsOpaque(parsed, "test-1");

      // ── Assertion C: routing metadata IS present (plaintext per design) ───────
      expect(rawJson, "agentId must be in plaintext").toContain("agent1");
      expect(rawJson, "tenant must be in plaintext").toContain("tenant1");
      expect(rawJson, "sub must be in plaintext").toContain("user42");
      expect(rawJson, "envelopeType must be in plaintext").toContain("conversation");
      expect(parsed!.v, "schema version must be 1").toBe(1);
    },
  );

  // ── Test 2: Receiver decrypts ciphertext back to original plaintext ───────

  it(
    "(2) receiving CryptoNatsChannel decrypts the on-wire ciphertext back to original plaintext",
    async () => {
      const broker = new FakeNatsBroker();
      brokers.push(broker);
      const rig = await makeRig(broker);
      teardown.push(rig.agentTransport, rig.browserTransport, rig.wireTap);

      const plaintextSent = "Hello from browser — this is the original plaintext!";

      // Agent subscribes and collects decrypted messages.
      const agentReceived: DecryptedMessage[] = [];
      rig.agentChannel.on("message", (msg: DecryptedMessage) => agentReceived.push(msg));
      rig.agentChannel.subscribe(SUBJECTS.INBOUND);

      // Browser sends (auto-encrypts).
      rig.browserChannel.sendMessage(SUBJECTS.INBOUND, plaintextSent, {
        envelopeType: "conversation",
        messageId:    "msg-test-2",
      });

      // ── Assertion A: wire tap sees ciphertext (Sub-AC 2 core requirement) ────
      expect(rig.wireTap.captured).toHaveLength(1);
      const { rawJson } = rig.wireTap.captured[0]!;
      expect(rawJson, "plaintext must not appear on wire").not.toContain("Hello from browser");
      expect(rawJson, "plaintext must not appear on wire").not.toContain(plaintextSent);

      // ── Assertion B: agent receives DECRYPTED plaintext (Sub-AC 2 core req.) ─
      expect(agentReceived, "agent must receive exactly one decrypted message").toHaveLength(1);
      const received = agentReceived[0]!;

      // The decrypted plaintext must exactly match what the browser sent.
      const decryptedText = dec(received.plaintext);
      expect(decryptedText, "decrypted plaintext must match original").toBe(plaintextSent);

      // Routing metadata must be accessible from the DecryptedMessage.
      expect(received.routing.agentId).toBe("agent1");
      expect(received.routing.tenant).toBe("tenant1");
      expect(received.routing.sub).toBe("user42");
      expect(received.routing.messageId).toBe("msg-test-2");
      expect(received.routing.envelopeType).toBe("conversation");

      // The envelope (at-rest form) must be opaque.
      assertEnvelopeIsOpaque(received.envelope, "test-2-at-rest");
    },
  );

  // ── Test 3: Agent → browser direction ─────────────────────────────────────

  it(
    "(3) agent-to-browser direction: agent sendMessage → wire is ciphertext → browser decrypts",
    async () => {
      const broker = new FakeNatsBroker();
      brokers.push(broker);
      const rig = await makeRig(broker);
      teardown.push(rig.agentTransport, rig.browserTransport, rig.wireTap);

      const agentReply = "Confidential agent reply — only browser can read this!";

      // Browser subscribes to outbound subject.
      const browserReceived: DecryptedMessage[] = [];
      rig.browserChannel.on("message", (msg: DecryptedMessage) => browserReceived.push(msg));
      rig.browserChannel.subscribe(SUBJECTS.OUTBOUND);

      // Agent sends reply (auto-encrypts via CryptoNatsChannel).
      rig.agentChannel.sendMessage(SUBJECTS.OUTBOUND, agentReply, {
        envelopeType: "conversation",
        messageId:    "agent-reply-001",
      });

      // Wire tap sees ciphertext.
      expect(rig.wireTap.captured).toHaveLength(1);
      const { rawJson } = rig.wireTap.captured[0]!;
      expect(rawJson, "agent reply must not appear on wire").not.toContain("Confidential agent reply");
      expect(rawJson, "agent reply must not appear on wire").not.toContain("only browser can read");

      // Browser decrypts the reply.
      expect(browserReceived).toHaveLength(1);
      const decryptedText = dec(browserReceived[0]!.plaintext);
      expect(decryptedText).toBe(agentReply);
      expect(browserReceived[0]!.routing.messageId).toBe("agent-reply-001");
      expect(browserReceived[0]!.routing.envelopeType).toBe("conversation");
    },
  );

  // ── Test 4: Full approval flow (request → decision → resolved) ────────────
  //
  // Note on AAD: the e2e-envelope module supports AAD (additional authenticated
  // data) for approval messages to bind the approvalId cryptographically. That
  // feature is already well-tested in relay-opacity.test.ts and
  // e2e-envelope.test.ts. This test focuses on the CryptoNatsChannel integration
  // path — specifically that all three approval messages transit as ciphertext
  // and are decrypted correctly. AAD is not used here to keep the test simple
  // and to avoid requiring per-message AAD context on the receive path.

  it(
    "(4) full approval flow: all three messages (request → decision → resolved) transit as ciphertext",
    async () => {
      const broker = new FakeNatsBroker();
      brokers.push(broker);
      const rig = await makeRig(broker);
      teardown.push(rig.agentTransport, rig.browserTransport, rig.wireTap);

      const approvalId = "approval-test-4";

      const approvalRequestBody  = JSON.stringify({ prompt: "Approve confidential action?", options: ["allow-once", "deny"] });
      const approvalDecisionBody = JSON.stringify({ decision: "allow-once" });
      const approvalResolvedBody = JSON.stringify({ decision: "allow-once", resolvedBy: "first-write-wins" });

      // Agent subscribes to receive the browser's decision.
      // Note: echo:false is implemented in FakeNatsBroker, so the agent will NOT
      // receive back its own approval_request and approval_resolved messages.
      const agentReceivedApprovals: DecryptedMessage[] = [];
      rig.agentChannel.on("message", (m: DecryptedMessage) => agentReceivedApprovals.push(m));
      rig.agentChannel.subscribe(SUBJECTS.APPROVAL);

      // Browser subscribes to receive the request and resolved.
      // The browser will NOT receive back its own approval_decision (echo:false).
      const browserReceivedApprovals: DecryptedMessage[] = [];
      rig.browserChannel.on("message", (m: DecryptedMessage) => browserReceivedApprovals.push(m));
      rig.browserChannel.subscribe(SUBJECTS.APPROVAL);

      // Step 1: Agent → browser: approval_request (no AAD — kept simple here).
      rig.agentChannel.sendMessage(
        SUBJECTS.APPROVAL,
        enc(approvalRequestBody),
        { envelopeType: "approval_request", messageId: approvalId },
      );

      // Step 2: Browser → agent: approval_decision (no AAD).
      rig.browserChannel.sendMessage(
        SUBJECTS.APPROVAL,
        enc(approvalDecisionBody),
        { envelopeType: "approval_decision", messageId: approvalId },
      );

      // Step 3: Agent → browser: approval_resolved (no AAD).
      rig.agentChannel.sendMessage(
        SUBJECTS.APPROVAL,
        enc(approvalResolvedBody),
        { envelopeType: "approval_resolved", messageId: approvalId },
      );

      // Wire tap captured all 3 approval messages.
      expect(rig.wireTap.captured).toHaveLength(3);

      for (const { rawJson, parsed, subject } of rig.wireTap.captured) {
        // ── All 3 transit frames must contain ZERO content plaintext ───────────
        expect(rawJson, `[${subject}] "confidential action" must not appear`).not.toContain("confidential action");
        expect(rawJson, `[${subject}] "allow-once" decision must not appear on wire`).not.toContain("allow-once");
        expect(rawJson, `[${subject}] "resolvedBy" must not appear on wire`).not.toContain("resolvedBy");
        expect(rawJson, `[${subject}] "first-write-wins" must not appear`).not.toContain("first-write-wins");

        // ── Content block is structurally opaque ──────────────────────────────
        assertEnvelopeIsOpaque(parsed, `approval-${subject}`);

        // ── envelopeType (routing discriminator) is plaintext ─────────────────
        expect(rawJson, `[${subject}] envelopeType must be plaintext`).toMatch(
          /approval_request|approval_decision|approval_resolved/,
        );

        // ── approvalId appears as plaintext messageId (routing correlation) ───
        expect(rawJson, `[${subject}] approvalId in messageId routing`).toContain(approvalId);
      }

      // Wire types in order.
      const [reqCapture, decCapture, resCapture] = rig.wireTap.captured;
      expect(reqCapture!.rawJson).toContain("approval_request");
      expect(decCapture!.rawJson).toContain("approval_decision");
      expect(resCapture!.rawJson).toContain("approval_resolved");

      // Browser received request + resolved (both from agent; echo:false means
      // browser does NOT receive back its own approval_decision).
      expect(browserReceivedApprovals.length).toBeGreaterThanOrEqual(2);
      const browserTypes = browserReceivedApprovals.map((m) => m.routing.envelopeType);
      expect(browserTypes).toContain("approval_request");
      expect(browserTypes).toContain("approval_resolved");
      // Verify browser decrypted the request correctly.
      const browserRequest = browserReceivedApprovals.find(
        (m) => m.routing.envelopeType === "approval_request",
      );
      expect(browserRequest, "browser must receive approval_request").not.toBeUndefined();
      expect(dec(browserRequest!.plaintext)).toContain("Approve confidential action");

      // Agent received decision (from browser; echo:false means agent does NOT
      // receive back its own approval_request and approval_resolved).
      expect(agentReceivedApprovals.length).toBeGreaterThanOrEqual(1);
      const agentDecision = agentReceivedApprovals.find(
        (m) => m.routing.envelopeType === "approval_decision",
      );
      expect(agentDecision, "agent must receive approval_decision").not.toBeUndefined();
      expect(dec(agentDecision!.plaintext)).toContain("allow-once");
    },
  );

  // ── Test 5: Full round-trip — browser sends → agent decrypts → replies → browser decrypts ─

  it(
    "(5) full round-trip: browser→agent (encrypted) → agent decrypts + replies (encrypted) → browser decrypts",
    async () => {
      const broker = new FakeNatsBroker();
      brokers.push(broker);
      const rig = await makeRig(broker);
      teardown.push(rig.agentTransport, rig.browserTransport, rig.wireTap);

      const userMessage  = "User says: relay must not read this conversation turn!";
      const agentMessage = "Agent replies: relay must not read this either!";

      // Browser subscribes for agent's reply.
      const browserReceived: DecryptedMessage[] = [];
      rig.browserChannel.on("message", (m: DecryptedMessage) => browserReceived.push(m));
      rig.browserChannel.subscribe(SUBJECTS.OUTBOUND);

      // Agent subscribes for browser's message.
      const agentReceived: DecryptedMessage[] = [];
      rig.agentChannel.on("message", (m: DecryptedMessage) => agentReceived.push(m));
      rig.agentChannel.subscribe(SUBJECTS.INBOUND);

      // Step 1: Browser → agent.
      rig.browserChannel.sendMessage(SUBJECTS.INBOUND, userMessage, { messageId: "turn-1" });

      // Agent decrypts user message.
      expect(agentReceived).toHaveLength(1);
      const agentDecryptedUser = dec(agentReceived[0]!.plaintext);
      expect(agentDecryptedUser, "agent must decrypt user message").toBe(userMessage);

      // Wire tap: user message is ciphertext.
      expect(rig.wireTap.captured).toHaveLength(1);
      expect(rig.wireTap.captured[0]!.rawJson).not.toContain("relay must not read");
      expect(rig.wireTap.captured[0]!.rawJson).not.toContain(userMessage);

      // Step 2: Agent → browser.
      rig.agentChannel.sendMessage(SUBJECTS.OUTBOUND, agentMessage, { messageId: "turn-2" });

      // Browser decrypts agent reply.
      expect(browserReceived).toHaveLength(1);
      const browserDecryptedAgent = dec(browserReceived[0]!.plaintext);
      expect(browserDecryptedAgent, "browser must decrypt agent reply").toBe(agentMessage);

      // Wire tap total: both messages are ciphertext.
      expect(rig.wireTap.captured).toHaveLength(2);
      for (const { rawJson, parsed } of rig.wireTap.captured) {
        expect(rawJson).not.toContain("relay must not read");
        expect(rawJson).not.toContain("User says");
        expect(rawJson).not.toContain("Agent replies");
        assertEnvelopeIsOpaque(parsed, "full-round-trip");
      }
    },
  );

  // ── Test 6: Backlog replay — agent replays encrypted history; browser decrypts ─

  it(
    "(6) backlog replay: agent replays encrypted history envelopes; browser decrypts each item",
    async () => {
      const broker = new FakeNatsBroker();
      brokers.push(broker);
      const rig = await makeRig(broker);
      teardown.push(rig.agentTransport, rig.browserTransport, rig.wireTap);

      const historyItems = [
        { id: "h-1", text: "History message 1 — at-rest must be ciphertext!" },
        { id: "h-2", text: "History message 2 — confidential historical item" },
        { id: "h-3", text: "History message 3 — sensitive backlog record"     },
      ];

      // Browser subscribes to the history replay subject.
      const browserHistoryReceived: DecryptedMessage[] = [];
      rig.browserChannel.on("message", (m: DecryptedMessage) => browserHistoryReceived.push(m));
      rig.browserChannel.subscribe(SUBJECTS.HISTORY);

      // Agent replays each history item as an encrypted envelope (outbound only).
      for (const item of historyItems) {
        rig.agentChannel.sendMessage(
          SUBJECTS.HISTORY,
          enc(JSON.stringify({ id: item.id, text: item.text, role: "user" })),
          { envelopeType: "history", messageId: item.id },
        );
      }

      // Wire tap captures all 3 history envelopes as ciphertext.
      expect(rig.wireTap.captured).toHaveLength(3);

      for (let i = 0; i < rig.wireTap.captured.length; i++) {
        const { rawJson, parsed } = rig.wireTap.captured[i]!;
        expect(rawJson, `[h-${i + 1}] secret text must not appear on wire`).not.toContain(historyItems[i]!.text);
        expect(rawJson, `[h-${i + 1}] "History message" must not appear`).not.toContain("History message");
        assertEnvelopeIsOpaque(parsed, `history-${i + 1}`);
        // Routing is plaintext.
        expect(rawJson).toContain("history");          // envelopeType
        expect(rawJson).toContain(historyItems[i]!.id); // messageId
      }

      // Browser received all 3 items decrypted.
      expect(browserHistoryReceived).toHaveLength(3);

      for (let i = 0; i < browserHistoryReceived.length; i++) {
        const received = browserHistoryReceived[i]!;
        const body = JSON.parse(dec(received.plaintext)) as { id: string; text: string; role: string };
        expect(body.id).toBe(historyItems[i]!.id);
        expect(body.text).toBe(historyItems[i]!.text);
        expect(body.role).toBe("user");
        expect(received.routing.envelopeType).toBe("history");
      }
    },
  );

  // ── Test 7: Wrong-session-key isolation ───────────────────────────────────

  it(
    "(7) wrong-session-key: third party with different key cannot decrypt the on-wire ciphertext",
    async () => {
      const broker = new FakeNatsBroker();
      brokers.push(broker);
      const rig = await makeRig(broker);
      teardown.push(rig.agentTransport, rig.browserTransport, rig.wireTap);

      const secretPayload = "Top secret — only the keyed parties can read this!";

      // A third-party attacker generates their own key pair and derives a
      // different session key (they don't have access to the real private keys).
      const attackerKP     = generateKeyPair();
      const attackerSK     = deriveSessionKey(attackerKP.privateKey, generateKeyPair().publicKey, "webchannel-conversation-v1");
      const attackerTransport = new NatsTransport({
        url: "ws://fake-nats:4222",
        clientName: "attacker",
        _wsFactory: broker.createFactory(),
      });
      await attackerTransport.connect();
      teardown.push(attackerTransport);

      // Attacker uses their wrong session key.
      const attackerChannel = new CryptoNatsChannel(attackerTransport, attackerSK, ROUTING_DEFAULTS);

      // Subscribe agent's real channel and attacker's channel to the same subject.
      const agentReceived: DecryptedMessage[] = [];
      rig.agentChannel.on("message", (m: DecryptedMessage) => agentReceived.push(m));
      rig.agentChannel.subscribe(SUBJECTS.INBOUND);

      const attackerErrors: Error[] = [];
      const attackerMessages: DecryptedMessage[] = [];
      attackerChannel.on("error",   (e: Error)          => attackerErrors.push(e));
      attackerChannel.on("message", (m: DecryptedMessage) => attackerMessages.push(m));
      attackerChannel.subscribe(SUBJECTS.INBOUND);

      // Browser sends an encrypted message.
      rig.browserChannel.sendMessage(SUBJECTS.INBOUND, secretPayload, { messageId: "msg-isolation-7" });

      // Wire tap captures ciphertext.
      expect(rig.wireTap.captured).toHaveLength(1);
      expect(rig.wireTap.captured[0]!.rawJson).not.toContain("Top secret");

      // Real agent (correct key) decrypts successfully.
      expect(agentReceived, "real agent must receive 1 decrypted message").toHaveLength(1);
      expect(dec(agentReceived[0]!.plaintext)).toBe(secretPayload);

      // Attacker (wrong key) cannot decrypt: gets error, no plaintext message.
      expect(attackerMessages, "attacker must receive NO decrypted messages").toHaveLength(0);
      expect(attackerErrors, "attacker must receive a decryption error").toHaveLength(1);
      expect(attackerErrors[0]!.message).toContain("decryption failed");
    },
  );

  // ── Test 8: Multi-message fan-out — all subscribers see ciphertext ─────────

  it(
    "(8) multi-device fan-out: multiple subscribers each see the ciphertext; keyed devices decrypt correctly",
    async () => {
      const broker = new FakeNatsBroker();
      brokers.push(broker);
      const rig = await makeRig(broker);
      teardown.push(rig.agentTransport, rig.browserTransport, rig.wireTap);

      // Two more browser devices sharing the same session key (same user, same device group).
      const deviceBTransport = new NatsTransport({ url: "ws://fake-nats:4222", clientName: "device-b", _wsFactory: broker.createFactory() });
      const deviceCTransport = new NatsTransport({ url: "ws://fake-nats:4222", clientName: "device-c", _wsFactory: broker.createFactory() });
      await Promise.all([deviceBTransport.connect(), deviceCTransport.connect()]);
      teardown.push(deviceBTransport, deviceCTransport);

      const deviceBChannel = new CryptoNatsChannel(deviceBTransport, rig.sessionKey, ROUTING_DEFAULTS);
      const deviceCChannel = new CryptoNatsChannel(deviceCTransport, rig.sessionKey, ROUTING_DEFAULTS);

      // All three browser instances subscribe to the agent's outbound subject.
      const browserRecv: DecryptedMessage[] = [];
      const deviceBRecv: DecryptedMessage[] = [];
      const deviceCRecv: DecryptedMessage[] = [];

      rig.browserChannel.on("message", (m: DecryptedMessage) => browserRecv.push(m));
      deviceBChannel.on("message",     (m: DecryptedMessage) => deviceBRecv.push(m));
      deviceCChannel.on("message",     (m: DecryptedMessage) => deviceCRecv.push(m));

      rig.browserChannel.subscribe(SUBJECTS.OUTBOUND);
      deviceBChannel.subscribe(SUBJECTS.OUTBOUND);
      deviceCChannel.subscribe(SUBJECTS.OUTBOUND);

      const agentMessage = "Fan-out message — all keyed devices receive and decrypt correctly!";

      // Agent publishes one encrypted message.
      rig.agentChannel.sendMessage(SUBJECTS.OUTBOUND, agentMessage, { envelopeType: "conversation", messageId: "fanout-8" });

      // Wire tap sees exactly one ciphertext envelope.
      expect(rig.wireTap.captured).toHaveLength(1);
      const { rawJson } = rig.wireTap.captured[0]!;
      expect(rawJson).not.toContain("Fan-out message");
      expect(rawJson).not.toContain("keyed devices receive");

      // All three browser devices received and decrypted the same message.
      expect(browserRecv).toHaveLength(1);
      expect(deviceBRecv).toHaveLength(1);
      expect(deviceCRecv).toHaveLength(1);

      expect(dec(browserRecv[0]!.plaintext)).toBe(agentMessage);
      expect(dec(deviceBRecv[0]!.plaintext)).toBe(agentMessage);
      expect(dec(deviceCRecv[0]!.plaintext)).toBe(agentMessage);

      // All received the same routing metadata.
      for (const recv of [browserRecv[0]!, deviceBRecv[0]!, deviceCRecv[0]!]) {
        expect(recv.routing.messageId).toBe("fanout-8");
        expect(recv.routing.envelopeType).toBe("conversation");
      }
    },
  );

  // ── Test 9: Large payload (4 KB) round-trip integrity ─────────────────────

  it(
    "(9) large payload (4 KB): round-trip integrity — ciphertext on wire, exact plaintext recovered",
    async () => {
      const broker = new FakeNatsBroker();
      brokers.push(broker);
      const rig = await makeRig(broker);
      teardown.push(rig.agentTransport, rig.browserTransport, rig.wireTap);

      // 4 KB of non-trivial pseudo-random data (deterministic fill).
      const largePayload = new Uint8Array(4096);
      for (let i = 0; i < largePayload.length; i++) largePayload[i] = (i * 7 + 13) % 256;

      const agentReceived: DecryptedMessage[] = [];
      rig.agentChannel.on("message", (m: DecryptedMessage) => agentReceived.push(m));
      rig.agentChannel.subscribe(SUBJECTS.INBOUND);

      // Browser sends the 4 KB payload.
      rig.browserChannel.sendMessage(SUBJECTS.INBOUND, largePayload, { messageId: "large-9" });

      // Wire tap: one ciphertext envelope.
      expect(rig.wireTap.captured).toHaveLength(1);
      assertEnvelopeIsOpaque(rig.wireTap.captured[0]!.parsed, "large-payload");

      // The ciphertext IS larger than zero (encryption doesn't remove data).
      const ciphertextBytes = Buffer.from(rig.wireTap.captured[0]!.parsed!.content.ciphertext, "base64url");
      expect(ciphertextBytes.length).toBe(largePayload.length);

      // Agent receives and decrypts the 4 KB payload.
      expect(agentReceived).toHaveLength(1);
      const recovered = agentReceived[0]!.plaintext;
      expect(recovered).toEqual(largePayload);  // bit-exact recovery
    },
  );

  // ── Test 10: Typing signal (minimal content) ──────────────────────────────

  it(
    "(10) typing signal: envelope structure is correct and content is opaque even for minimal payloads",
    async () => {
      const broker = new FakeNatsBroker();
      brokers.push(broker);
      const rig = await makeRig(broker);
      teardown.push(rig.agentTransport, rig.browserTransport, rig.wireTap);

      const typingPayload = JSON.stringify({ typing: true });

      const browserReceived: DecryptedMessage[] = [];
      rig.browserChannel.on("message", (m: DecryptedMessage) => browserReceived.push(m));
      rig.browserChannel.subscribe(SUBJECTS.TYPING);

      // Agent sends a typing signal.
      rig.agentChannel.sendMessage(
        SUBJECTS.TYPING,
        enc(typingPayload),
        { envelopeType: "typing", messageId: "typing-10" },
      );

      // Wire tap: typing envelope is opaque.
      expect(rig.wireTap.captured).toHaveLength(1);
      const { rawJson, parsed } = rig.wireTap.captured[0]!;
      expect(rawJson, "typing payload must not appear on wire").not.toContain("typing: true");
      assertEnvelopeIsOpaque(parsed, "typing-signal");

      // envelopeType is plaintext (routing discriminator).
      expect(rawJson).toContain("typing");

      // Browser receives and decrypts the typing signal.
      expect(browserReceived).toHaveLength(1);
      const decryptedTyping = dec(browserReceived[0]!.plaintext);
      expect(JSON.parse(decryptedTyping)).toEqual({ typing: true });
      expect(browserReceived[0]!.routing.envelopeType).toBe("typing");
    },
  );
});
