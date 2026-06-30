/**
 * TypingIndicator — ephemeral signal tests (Sub-AC 2).
 *
 * Sub-AC 2: Implement typing indicators as ephemeral client↔client signals on
 * the NATS-WebSocket transport that are explicitly excluded from message
 * persistence and replay.
 *
 * Acceptance criteria for this test suite
 * ─────────────────────────────────────────
 * ✓ A typing event fires and is delivered live to connected peers.
 * ✓ A typing event does NOT appear in the stored message log (HistoryStore).
 * ✓ A typing event does NOT appear in the replay / backlog stream.
 *
 * Strategy
 * ────────
 * All tests use the FakeNatsBroker (in-process NATS text-protocol relay, zero
 * real TCP sockets) shared across all Sub-AC integration test suites. The
 * broker delivers messages synchronously — assertions are made immediately
 * after `sendTypingSignal()` with no async delays.
 *
 * Wiring model
 * ────────────
 *   browser ──[CryptoNatsChannel]──► NATS ──[CryptoNatsChannel]──► agent
 *
 *   Agent-side inbound handler:
 *     channel.on('message', ({ envelope }) => {
 *       persistIfNotEphemeral(store, conv, envelope);  // skip typing envelopes
 *     });
 *
 *   Persistence invariant (all tests assert this after typing events):
 *     store.size(conv) === 0
 *     store.loadHistory(conv, null, 100).envelopes.length === 0
 *
 * Tests in this suite
 * ───────────────────
 *  1. Typing signal delivered live — typing=true reaches connected peer
 *  2. Typing stop signal delivered — typing=false reaches connected peer
 *  3. Typing signal NOT stored in HistoryStore (store.size === 0)
 *  4. Typing signal NOT in loadHistory replay stream (empty page)
 *  5. Conversation messages ARE persisted (non-typing baseline)
 *  6. Mixed stream: typing signals excluded, conversation messages persisted
 *  7. N devices all receive typing signal live; none persist it
 *  8. Disconnected peer does not receive late typing signal
 *  9. isEphemeralEnvelope predicate — typing returns true; others return false
 * 10. persistIfNotEphemeral — typing skipped, conversation appended to store
 */

import { describe, it, expect, afterEach } from "vitest";
import WebSocket from "ws";

import { NatsTransport } from "./nats-transport.js";
import type { NatsMessage } from "./nats-transport.js";
import { CryptoNatsChannel } from "./crypto-nats-channel.js";
import type { DecryptedMessage } from "./crypto-nats-channel.js";
import { HistoryStore } from "./history-store.js";
import type { ConversationId } from "./history-store.js";
import { encodeEnvelope, serializeEnvelope } from "./e2e-envelope.js";
import type { MessageEnvelope } from "./e2e-envelope.js";
import {
  generateKeyPair,
  deriveSharedSecret,
  hkdfSha256,
} from "./e2e-crypto.js";
import {
  sendTypingSignal,
  persistIfNotEphemeral,
  isEphemeralEnvelope,
  TYPING_ENVELOPE_TYPE,
} from "./typing-indicator.js";

// ---------------------------------------------------------------------------
// FakeNatsBroker — in-process NATS text-protocol relay (zero TCP sockets)
//
// Identical semantics to the broker in nats-transport-integration.test.ts and
// crypto-nats-channel-integration.test.ts.  Synchronous delivery: assertions
// can be made immediately after publish() with no async delays.
// Supports echo:false — a client's own PUBs are not echoed back to itself.
// ---------------------------------------------------------------------------

class FakeNatsBroker {
  private readonly clients    = new Map<string, (data: string) => void>();
  private readonly buffers    = new Map<string, string>();
  private readonly noEchoSet  = new Set<string>();
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
        try {
          const payload = JSON.parse(line.slice("CONNECT ".length)) as Record<string, unknown>;
          if (payload["echo"] === false) this.noEchoSet.add(clientId);
        } catch { /* ignore malformed CONNECT */ }
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
// Crypto helpers
// ---------------------------------------------------------------------------

/**
 * Derive a 32-byte session key via X25519 ECDH + HKDF-SHA256.
 * Commutative — both sides independently derive the same key.
 */
function deriveSessionKey(myPriv: Uint8Array, theirPub: Uint8Array): Uint8Array {
  return hkdfSha256(deriveSharedSecret(myPriv, theirPub), null, "webchannel-conversation-v1", 32);
}

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const TENANT   = "tenant1";
const AGENT_ID = "agent1";
const USER_SUB = "user42";

/** Conversation identifier for the test user. */
const CONV: ConversationId = { accountId: AGENT_ID, tenant: TENANT, sub: USER_SUB };

/** NATS subjects (plaintext routing metadata per design). */
const SUBJECTS = {
  INBOUND:  `chat.${TENANT}.${AGENT_ID}.${USER_SUB}.in`,
  OUTBOUND: `chat.${TENANT}.${AGENT_ID}.${USER_SUB}.out`,
  HISTORY:  `chat.${TENANT}.${AGENT_ID}.${USER_SUB}.history`,
  TYPING:   `chat.${TENANT}.${AGENT_ID}.${USER_SUB}.typing`,
} as const;

// ---------------------------------------------------------------------------
// Test-rig factory
// ---------------------------------------------------------------------------

type TestRig = {
  browserTransport: NatsTransport;
  agentTransport:   NatsTransport;
  browserChannel:   CryptoNatsChannel;
  agentChannel:     CryptoNatsChannel;
  store:            HistoryStore;
  sessionKey:       Uint8Array;
};

async function makeRig(broker: FakeNatsBroker): Promise<TestRig> {
  const agentKP   = generateKeyPair();
  const browserKP = generateKeyPair();

  const sessionKey = deriveSessionKey(agentKP.privateKey, browserKP.publicKey);
  // Verify commutativity (same key on both sides).
  const browserKey = deriveSessionKey(browserKP.privateKey, agentKP.publicKey);
  // Both sides must agree on the key (fundamental ECDH property).
  expect(sessionKey).toEqual(browserKey);

  const agentTransport   = new NatsTransport({ url: "ws://fake-nats:4222", clientName: "test-agent",   _wsFactory: broker.createFactory() });
  const browserTransport = new NatsTransport({ url: "ws://fake-nats:4222", clientName: "test-browser", _wsFactory: broker.createFactory() });

  await Promise.all([agentTransport.connect(), browserTransport.connect()]);

  const agentChannel   = new CryptoNatsChannel(agentTransport,   sessionKey, { accountId: AGENT_ID, tenant: TENANT, sub: USER_SUB });
  const browserChannel = new CryptoNatsChannel(browserTransport, sessionKey, { accountId: AGENT_ID, tenant: TENANT, sub: USER_SUB });

  const store = new HistoryStore();

  return { agentTransport, browserTransport, agentChannel, browserChannel, store, sessionKey };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("TypingIndicator — ephemeral NATS signals (Sub-AC 2)", () => {
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

  // ── Test 1: Typing signal delivered live (typing=true) ────────────────────

  it(
    "(1) typing=true signal is delivered live to a connected peer via the NATS typing subject",
    async () => {
      const broker = new FakeNatsBroker();
      brokers.push(broker);
      const rig = await makeRig(broker);
      teardown.push(rig.agentTransport, rig.browserTransport);

      // Agent subscribes to the typing subject to receive browser signals.
      const agentReceived: DecryptedMessage[] = [];
      rig.agentChannel.on("message", (m: DecryptedMessage) => agentReceived.push(m));
      rig.agentChannel.subscribe(SUBJECTS.TYPING);

      // Browser fires a typing=true signal.
      sendTypingSignal(rig.browserChannel, SUBJECTS.TYPING, true, "typing-t1-start");

      // ── Assertion: agent receives exactly one decrypted typing message ────────
      expect(agentReceived, "agent must receive exactly one typing signal").toHaveLength(1);

      const received = agentReceived[0]!;
      expect(received.routing.envelopeType, "envelopeType must be 'typing'").toBe("typing");
      expect(received.routing.messageId, "messageId must match").toBe("typing-t1-start");

      // Decrypted payload must be { typing: true }.
      const payload = JSON.parse(dec(received.plaintext)) as { typing: boolean };
      expect(payload.typing, "typing flag must be true").toBe(true);
    },
  );

  // ── Test 2: Typing stop signal delivered (typing=false) ──────────────────

  it(
    "(2) typing=false (stop) signal is delivered live to a connected peer",
    async () => {
      const broker = new FakeNatsBroker();
      brokers.push(broker);
      const rig = await makeRig(broker);
      teardown.push(rig.agentTransport, rig.browserTransport);

      const agentReceived: DecryptedMessage[] = [];
      rig.agentChannel.on("message", (m: DecryptedMessage) => agentReceived.push(m));
      rig.agentChannel.subscribe(SUBJECTS.TYPING);

      // Browser fires a typing=false (stopped) signal.
      sendTypingSignal(rig.browserChannel, SUBJECTS.TYPING, false, "typing-t2-stop");

      expect(agentReceived).toHaveLength(1);
      const payload = JSON.parse(dec(agentReceived[0]!.plaintext)) as { typing: boolean };
      expect(payload.typing, "typing flag must be false").toBe(false);
      expect(agentReceived[0]!.routing.envelopeType).toBe("typing");
    },
  );

  // ── Test 3: Typing signal NOT stored in HistoryStore ─────────────────────

  it(
    "(3) typing signal is NOT stored in HistoryStore — store.size remains 0 after typing event",
    async () => {
      const broker = new FakeNatsBroker();
      brokers.push(broker);
      const rig = await makeRig(broker);
      teardown.push(rig.agentTransport, rig.browserTransport);

      // Agent subscribes and routes ALL inbound envelopes through persistIfNotEphemeral.
      rig.agentChannel.on("message", ({ envelope }: DecryptedMessage) => {
        persistIfNotEphemeral(rig.store, CONV, envelope);
      });
      rig.agentChannel.subscribe(SUBJECTS.TYPING);

      // Fire multiple typing signals.
      sendTypingSignal(rig.browserChannel, SUBJECTS.TYPING, true,  "typing-t3-a");
      sendTypingSignal(rig.browserChannel, SUBJECTS.TYPING, true,  "typing-t3-b");
      sendTypingSignal(rig.browserChannel, SUBJECTS.TYPING, false, "typing-t3-stop");

      // ── Primary assertion: ZERO typing envelopes in the store ─────────────────
      expect(
        rig.store.size(CONV),
        "HistoryStore must contain ZERO typing envelopes after 3 typing signals",
      ).toBe(0);
    },
  );

  // ── Test 4: Typing signal NOT in loadHistory replay stream ────────────────

  it(
    "(4) typing signal does NOT appear in the loadHistory replay stream (empty page returned)",
    async () => {
      const broker = new FakeNatsBroker();
      brokers.push(broker);
      const rig = await makeRig(broker);
      teardown.push(rig.agentTransport, rig.browserTransport);

      // Agent persists all inbound envelopes through the filter.
      rig.agentChannel.on("message", ({ envelope }: DecryptedMessage) => {
        persistIfNotEphemeral(rig.store, CONV, envelope);
      });
      rig.agentChannel.subscribe(SUBJECTS.TYPING);

      // Browser sends 5 typing signals.
      for (let i = 0; i < 5; i++) {
        sendTypingSignal(rig.browserChannel, SUBJECTS.TYPING, true, `typing-t4-${i}`);
      }

      // ── Assertion A: store.size is zero ───────────────────────────────────────
      expect(rig.store.size(CONV)).toBe(0);

      // ── Assertion B: loadHistory returns an empty page ────────────────────────
      const page = rig.store.loadHistory(CONV, null, 100);
      expect(
        page.envelopes,
        "loadHistory must return zero envelopes — typing signals are not in replay",
      ).toHaveLength(0);
      expect(
        page.nextCursor,
        "nextCursor must be null when store is empty",
      ).toBeNull();
    },
  );

  // ── Test 5: Conversation messages ARE persisted (non-typing baseline) ──────

  it(
    "(5) non-typing (conversation) messages ARE persisted — baseline that persistIfNotEphemeral works",
    async () => {
      const broker = new FakeNatsBroker();
      brokers.push(broker);
      const rig = await makeRig(broker);
      teardown.push(rig.agentTransport, rig.browserTransport);

      // Agent subscribes to inbound subject and persists via the filter.
      rig.agentChannel.on("message", ({ envelope }: DecryptedMessage) => {
        persistIfNotEphemeral(rig.store, CONV, envelope);
      });
      rig.agentChannel.subscribe(SUBJECTS.INBOUND);

      // Browser sends 3 conversation messages.
      for (let i = 1; i <= 3; i++) {
        rig.browserChannel.sendMessage(
          SUBJECTS.INBOUND,
          `Conversation message ${i}`,
          { envelopeType: "conversation", messageId: `conv-t5-${i}` },
        );
      }

      // ── Assertion: all 3 conversation messages are stored ─────────────────────
      expect(
        rig.store.size(CONV),
        "HistoryStore must contain 3 conversation messages",
      ).toBe(3);

      const page = rig.store.loadHistory(CONV, null, 10);
      expect(page.envelopes).toHaveLength(3);
      for (let i = 0; i < 3; i++) {
        expect(page.envelopes[i]!.envelopeType).toBe("conversation");
        expect(page.envelopes[i]!.messageId).toBe(`conv-t5-${i + 1}`);
      }
    },
  );

  // ── Test 6: Mixed stream — typing excluded, conversation persisted ─────────

  it(
    "(6) mixed stream: typing signals excluded from persistence; conversation messages retained in correct order",
    async () => {
      const broker = new FakeNatsBroker();
      brokers.push(broker);
      const rig = await makeRig(broker);
      teardown.push(rig.agentTransport, rig.browserTransport);

      const agentReceived: DecryptedMessage[] = [];
      rig.agentChannel.on("message", (m: DecryptedMessage) => {
        agentReceived.push(m);
        persistIfNotEphemeral(rig.store, CONV, m.envelope);
      });
      // Subscribe to both the typing and inbound subjects.
      rig.agentChannel.subscribe(SUBJECTS.TYPING);
      rig.agentChannel.subscribe(SUBJECTS.INBOUND);

      // Interleave: conv-1, typing, conv-2, typing, typing, conv-3
      rig.browserChannel.sendMessage(SUBJECTS.INBOUND, "Hello agent",     { envelopeType: "conversation", messageId: "conv-6-1" });
      sendTypingSignal(rig.browserChannel, SUBJECTS.TYPING, true,  "type-6-a");
      rig.browserChannel.sendMessage(SUBJECTS.INBOUND, "More details...", { envelopeType: "conversation", messageId: "conv-6-2" });
      sendTypingSignal(rig.browserChannel, SUBJECTS.TYPING, true,  "type-6-b");
      sendTypingSignal(rig.browserChannel, SUBJECTS.TYPING, false, "type-6-stop");
      rig.browserChannel.sendMessage(SUBJECTS.INBOUND, "Final message",   { envelopeType: "conversation", messageId: "conv-6-3" });

      // ── Assertion A: agent received all 6 live messages ───────────────────────
      expect(agentReceived, "agent must receive 6 live messages (3 conv + 3 typing)").toHaveLength(6);

      // ── Assertion B: store contains ONLY the 3 conversation messages ──────────
      expect(
        rig.store.size(CONV),
        "store must contain exactly 3 conversation messages (typing signals excluded)",
      ).toBe(3);

      // ── Assertion C: replay contains only conversation messages in order ───────
      const page = rig.store.loadHistory(CONV, null, 10);
      expect(page.envelopes).toHaveLength(3);
      expect(page.envelopes[0]!.messageId).toBe("conv-6-1");
      expect(page.envelopes[1]!.messageId).toBe("conv-6-2");
      expect(page.envelopes[2]!.messageId).toBe("conv-6-3");

      // Verify no typing envelope snuck through.
      for (const env of page.envelopes) {
        expect(env.envelopeType, "no typing envelope in replay stream").not.toBe("typing");
      }

      // ── Assertion D: typing messages were delivered live (not persisted) ───────
      const typingLive = agentReceived.filter((m) => m.routing.envelopeType === "typing");
      expect(typingLive, "3 typing signals received live").toHaveLength(3);
      const typingInStore = page.envelopes.filter((e) => e.envelopeType === "typing");
      expect(typingInStore, "0 typing envelopes in store").toHaveLength(0);
    },
  );

  // ── Test 7: N devices all receive typing signal live; none persist it ─────

  it(
    "(7) N=3 devices all receive a typing signal live; all apply persistIfNotEphemeral and store stays empty",
    async () => {
      const broker = new FakeNatsBroker();
      brokers.push(broker);
      const rig = await makeRig(broker);
      teardown.push(rig.agentTransport, rig.browserTransport);

      // Two more device transports (same user sub — share the same session key).
      const deviceBTransport = new NatsTransport({ url: "ws://fake-nats:4222", clientName: "device-b", _wsFactory: broker.createFactory() });
      const deviceCTransport = new NatsTransport({ url: "ws://fake-nats:4222", clientName: "device-c", _wsFactory: broker.createFactory() });
      await Promise.all([deviceBTransport.connect(), deviceCTransport.connect()]);
      teardown.push(deviceBTransport, deviceCTransport);

      const deviceBChannel = new CryptoNatsChannel(deviceBTransport, rig.sessionKey, { accountId: AGENT_ID, tenant: TENANT, sub: USER_SUB });
      const deviceCChannel = new CryptoNatsChannel(deviceCTransport, rig.sessionKey, { accountId: AGENT_ID, tenant: TENANT, sub: USER_SUB });

      // Each device has its own HistoryStore instance (isolated stores per device).
      const storeB = new HistoryStore();
      const storeC = new HistoryStore();

      const receivedB: DecryptedMessage[] = [];
      const receivedC: DecryptedMessage[] = [];

      deviceBChannel.on("message", (m: DecryptedMessage) => {
        receivedB.push(m);
        persistIfNotEphemeral(storeB, CONV, m.envelope);
      });
      deviceCChannel.on("message", (m: DecryptedMessage) => {
        receivedC.push(m);
        persistIfNotEphemeral(storeC, CONV, m.envelope);
      });

      deviceBChannel.subscribe(SUBJECTS.TYPING);
      deviceCChannel.subscribe(SUBJECTS.TYPING);

      // Browser fires a typing signal to the shared typing subject.
      sendTypingSignal(rig.browserChannel, SUBJECTS.TYPING, true, "typing-t7");

      // ── Assertion A: both devices received the typing signal live ─────────────
      expect(receivedB, "device-B must receive typing signal live").toHaveLength(1);
      expect(receivedC, "device-C must receive typing signal live").toHaveLength(1);

      expect(receivedB[0]!.routing.envelopeType).toBe("typing");
      expect(receivedC[0]!.routing.envelopeType).toBe("typing");

      const typingB = JSON.parse(dec(receivedB[0]!.plaintext)) as { typing: boolean };
      const typingC = JSON.parse(dec(receivedC[0]!.plaintext)) as { typing: boolean };
      expect(typingB.typing, "device-B decrypted typing=true").toBe(true);
      expect(typingC.typing, "device-C decrypted typing=true").toBe(true);

      // ── Assertion B: NEITHER device persisted the typing signal ───────────────
      expect(
        storeB.size(CONV),
        "device-B HistoryStore must be empty — typing signal not persisted",
      ).toBe(0);
      expect(
        storeC.size(CONV),
        "device-C HistoryStore must be empty — typing signal not persisted",
      ).toBe(0);
    },
  );

  // ── Test 8: Disconnected peer does not receive late typing signal ──────────

  it(
    "(8) device that disconnects before a typing signal does NOT receive the signal",
    async () => {
      const broker = new FakeNatsBroker();
      brokers.push(broker);
      const rig = await makeRig(broker);
      teardown.push(rig.agentTransport, rig.browserTransport);

      // A second device that will disconnect.
      const lateDeviceTransport = new NatsTransport({ url: "ws://fake-nats:4222", clientName: "late-device", _wsFactory: broker.createFactory() });
      teardown.push(lateDeviceTransport); // disconnect in afterEach (idempotent)
      await lateDeviceTransport.connect();

      const lateChannel = new CryptoNatsChannel(lateDeviceTransport, rig.sessionKey, { accountId: AGENT_ID, tenant: TENANT, sub: USER_SUB });
      const storeAgent = new HistoryStore();
      const storeLate  = new HistoryStore();

      const agentReceived: DecryptedMessage[] = [];
      const lateReceived:  DecryptedMessage[] = [];

      // Agent subscribes to typing subject and applies persistence filter.
      rig.agentChannel.on("message", (m: DecryptedMessage) => {
        agentReceived.push(m);
        persistIfNotEphemeral(storeAgent, CONV, m.envelope);
      });
      rig.agentChannel.subscribe(SUBJECTS.TYPING);

      lateChannel.on("message", (m: DecryptedMessage) => {
        lateReceived.push(m);
        persistIfNotEphemeral(storeLate, CONV, m.envelope);
      });
      lateChannel.subscribe(SUBJECTS.TYPING);

      // First typing signal — both agent and late-device receive it.
      sendTypingSignal(rig.browserChannel, SUBJECTS.TYPING, true, "typing-t8-first");
      expect(agentReceived).toHaveLength(1);
      expect(lateReceived).toHaveLength(1);

      // Late-device disconnects (tab close / network drop).
      lateDeviceTransport.disconnect();

      // Second typing signal — only agent receives it.
      sendTypingSignal(rig.browserChannel, SUBJECTS.TYPING, true, "typing-t8-second");
      expect(agentReceived, "agent still receives after late-device disconnected").toHaveLength(2);
      expect(lateReceived, "disconnected device does not receive second typing signal").toHaveLength(1);

      // Neither store persisted any typing envelope.
      expect(storeAgent.size(CONV)).toBe(0);
      expect(storeLate.size(CONV)).toBe(0);
    },
  );

  // ── Test 9: isEphemeralEnvelope predicate ────────────────────────────────

  it(
    "(9) isEphemeralEnvelope returns true ONLY for typing envelopes; false for all others",
    () => {
      // Helper to build a minimal MessageEnvelope with a given envelopeType.
      const makeEnv = (type: MessageEnvelope["envelopeType"]): MessageEnvelope => ({
        v: 1,
        accountId: AGENT_ID,
        tenant: TENANT,
        sub: USER_SUB,
        messageId: `msg-${type}`,
        envelopeType: type,
        ts: 1_718_000_000_000,
        content: {
          nonce: Buffer.alloc(12).toString("base64url"),
          ciphertext: Buffer.alloc(1, 0).toString("base64url"),
          tag: Buffer.alloc(16).toString("base64url"),
        },
      } as MessageEnvelope);

      // Typing is ephemeral — MUST NOT be stored.
      expect(isEphemeralEnvelope(makeEnv("typing")),
        "isEphemeralEnvelope('typing') must be true").toBe(true);

      // All other types are persistent — MUST be stored.
      const persistentTypes: MessageEnvelope["envelopeType"][] = [
        "conversation",
        "approval_request",
        "approval_decision",
        "approval_resolved",
        "history",
      ];
      for (const type of persistentTypes) {
        expect(
          isEphemeralEnvelope(makeEnv(type)),
          `isEphemeralEnvelope('${type}') must be false`,
        ).toBe(false);
      }
    },
  );

  // ── Test 10: persistIfNotEphemeral unit test ──────────────────────────────

  it(
    "(10) persistIfNotEphemeral: typing envelope skipped; conversation envelope appended to store",
    () => {
      const store = new HistoryStore();

      const makeEnv = (type: MessageEnvelope["envelopeType"], id: string): MessageEnvelope => ({
        v: 1,
        accountId: AGENT_ID,
        tenant: TENANT,
        sub: USER_SUB,
        messageId: id,
        envelopeType: type,
        ts: 1_718_000_000_000,
        content: {
          nonce: Buffer.alloc(12).toString("base64url"),
          ciphertext: Buffer.from(id, "utf8").toString("base64url"),
          tag: Buffer.alloc(16).toString("base64url"),
        },
      } as MessageEnvelope);

      // Attempt to persist a typing envelope — must be skipped.
      persistIfNotEphemeral(store, CONV, makeEnv("typing", "typing-skip-1"));
      persistIfNotEphemeral(store, CONV, makeEnv("typing", "typing-skip-2"));
      expect(store.size(CONV), "typing envelopes must NOT be stored").toBe(0);

      // Persist a conversation envelope — must be stored.
      persistIfNotEphemeral(store, CONV, makeEnv("conversation", "conv-keep-1"));
      expect(store.size(CONV), "conversation envelope must be stored").toBe(1);

      // Persist another typing — still skipped.
      persistIfNotEphemeral(store, CONV, makeEnv("typing", "typing-skip-3"));
      expect(store.size(CONV), "typing envelope must still be skipped after conversation").toBe(1);

      // Persist another conversation — store grows.
      persistIfNotEphemeral(store, CONV, makeEnv("conversation", "conv-keep-2"));
      expect(store.size(CONV), "second conversation envelope must be stored").toBe(2);

      // Verify loadHistory returns ONLY conversation envelopes.
      const page = store.loadHistory(CONV, null, 10);
      expect(page.envelopes).toHaveLength(2);
      expect(page.envelopes[0]!.messageId).toBe("conv-keep-1");
      expect(page.envelopes[1]!.messageId).toBe("conv-keep-2");
      expect(page.envelopes.every((e) => e.envelopeType !== "typing"),
        "no typing envelopes in loadHistory replay stream").toBe(true);

      // Verify TYPING_ENVELOPE_TYPE constant matches the actual type.
      expect(TYPING_ENVELOPE_TYPE).toBe("typing");
    },
  );
});
