/**
 * 1:N Multi-device Broadcast Sync tests — Sub-AC 5.1 (MultiDeviceConsistency).
 *
 * Verifies that multiple browser clients sharing the same JWT `sub` (same user,
 * multiple devices or tabs) all receive identical ciphertext when a message is
 * published to the shared conversation NATS subject.
 *
 * Key invariants validated by this suite:
 *
 *   (a) EXACTLY-ONCE PER DEVICE: N devices subscribed to the same NATS subject
 *       each receive exactly one MSG frame per publish call — no duplicates,
 *       no missed deliveries.
 *
 *   (b) IDENTICAL CIPHERTEXT: the raw byte payload received by every device is
 *       byte-for-byte identical to every other device's copy.  The NATS relay
 *       cannot alter or inject per-recipient ciphertext variants.
 *
 *   (c) ALL-DEVICES-DECRYPTABLE: every device that holds the shared conversation
 *       key (distributed out-of-band via device-key-wrap) can successfully
 *       decrypt the ciphertext to the identical plaintext.
 *
 *   (d) SYNCHRONOUS SLA: delivery completes within the same call stack as the
 *       publish — assertions are made immediately after `agent.publish()` with
 *       no awaits or timers.  The FakeNatsBroker delivers synchronously, proving
 *       that the NATS fan-out model meets the at-most-one-network-hop SLA.
 *
 *   (e) ORDERING: multiple sequential publishes are received in publication
 *       order by every device.
 *
 *   (f) CROSS-USER ISOLATION: devices subscribed to user-A's subject do not
 *       receive messages published to user-B's subject (different JWT sub →
 *       different NATS subject → no cross-contamination).
 *
 * Architecture
 * ────────────
 * Uses the same FakeNatsBroker in-process relay used across all Sub-AC tests.
 * All N NatsTransport instances (devices) and the agent connect to the same
 * broker via the `_wsFactory` seam — zero real TCP sockets.
 *
 * The shared conversation key simulates what a real session delivers to each
 * device via the device-key-wrap distribution: the agent generates a symmetric
 * conversationKey, wraps it for each device's X25519 public key (bound via
 * SaaS cnf claim), and ships the wrapped key over the SaaS-authenticated
 * bootstrap path.  Once unwrapped, every device of the same `sub` holds the
 * same symmetric conversationKey and can decrypt any broadcast envelope.
 *
 * Subject schema (plaintext routing metadata per design):
 *   chat.<tenant>.<accountId>.<sub>.<direction>
 *
 * All devices of the same user share the same subject because `sub` is the
 * stable per-user identity (JWT sub claim, multi-device-invariant).
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
import type { EnvelopeRouting } from "./e2e-envelope.js";
import {
  generateKeyPair,
  deriveSharedSecret,
  hkdfSha256,
} from "./e2e-crypto.js";

// ---------------------------------------------------------------------------
// FakeNatsBroker — in-process NATS text-protocol relay
//
// Zero TCP sockets.  Synchronous delivery: a publish() call routes MSG frames
// to all subscribers in the same call stack, so tests assert immediately after
// publish() with no async delays.  Identical semantics as the broker used in
// Sub-AC 2 / 3 integration tests.
// ---------------------------------------------------------------------------

class FakeNatsBroker {
  private readonly clients = new Map<string, (data: string) => void>();
  private readonly buffers = new Map<string, string>();
  private subscriptions: Array<{
    subject: string;
    clientId: string;
    sid: number;
  }> = [];
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

        on(
          event: string,
          fn: (...args: unknown[]) => void,
        ): typeof fakeWs {
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
          broker.subscriptions = broker.subscriptions.filter(
            (s) => s.clientId !== clientId,
          );
          broker.clients.delete(clientId);
          broker.buffers.delete(clientId);
          handlers.get("close")?.forEach((fn) => fn());
        },
      };

      // Fire 'open' asynchronously — same timing contract as a real TCP dial.
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
        pushToClient(
          `INFO {"server_id":"fake-nats-broker","version":"2.10.0"}\r\nPONG\r\n`,
        );
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
          // Incomplete payload — put header back and wait for more data.
          buffer = `${line}\r\n${buffer}`;
          break;
        }

        const payload = buffer.slice(0, byteCount);
        buffer = buffer.slice(byteCount + 2); // consume payload + trailing \r\n

        // Fan out to all matching subscribers (exact subject match).
        for (const sub of this.subscriptions) {
          if (sub.subject === subject) {
            const push = this.clients.get(sub.clientId);
            if (push) {
              push(`MSG ${subject} ${sub.sid} ${byteCount}\r\n${payload}\r\n`);
            }
          }
        }
        continue;
      }

      if (line === "+OK") continue;
      // Unknown lines: ignore (forward-compatibility).
    }

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
// Crypto helpers
// ---------------------------------------------------------------------------

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);

/**
 * Derive a 32-byte conversation key by performing a fresh X25519 ECDH exchange
 * and running HKDF-SHA256 over the raw shared secret.
 *
 * This simulates the conversationKey that a real session delivers to each device
 * via device-key-wrap: the agent generates a random symmetric key, wraps it for
 * each device's X25519 public key (cnf-bound), and ships the wrapped key over
 * the SaaS-authenticated bootstrap path.  Once each device unwraps using its
 * own private key, all devices of the same `sub` hold the same conversationKey.
 *
 * @param info - HKDF domain-separation info string.
 */
function makeConversationKey(
  info = "webchannel-conversation-v1",
): Uint8Array {
  const agentKP = generateKeyPair();
  const deviceKP = generateKeyPair();
  const rawSecret = deriveSharedSecret(agentKP.privateKey, deviceKP.publicKey);
  return hkdfSha256(rawSecret, null, info, 32);
}

// ---------------------------------------------------------------------------
// Canonical NATS subjects (plaintext routing metadata per design).
//
// Subject schema:  chat.<tenant>.<accountId>.<sub>.<direction>
//
// All devices of the same user share the SAME outbound subject because `sub`
// is the stable per-user JWT identity.  Publishing to `chat.t.a.user42.out`
// broadcasts to every device of user42 that is subscribed — this is the
// 1:N broadcast channel.
// ---------------------------------------------------------------------------

const TENANT   = "tenant1";
const AGENT_ID = "agent1";
const USER_SUB = "user42";          // JWT sub — stable per-user, multi-device

const OUTBOUND = `chat.${TENANT}.${AGENT_ID}.${USER_SUB}.out`;
const INBOUND  = `chat.${TENANT}.${AGENT_ID}.${USER_SUB}.in`;
const HISTORY  = `chat.${TENANT}.${AGENT_ID}.${USER_SUB}.history`;
const APPROVAL = `chat.${TENANT}.${AGENT_ID}.${USER_SUB}.approval`;

// Separate user — different JWT sub → different NATS subject → no cross-contamination.
const OTHER_USER_SUB = "user99";
const OTHER_OUTBOUND = `chat.${TENANT}.${AGENT_ID}.${OTHER_USER_SUB}.out`;

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Create and connect N device NatsTransport instances plus one agent, all
 * wired to the same FakeNatsBroker.  Callers push all returned transports
 * into the `teardown` array so afterEach can clean up.
 */
async function makeDevicePool(
  broker: FakeNatsBroker,
  n: number,
): Promise<{ devices: NatsTransport[]; agent: NatsTransport }> {
  const agent = new NatsTransport({
    url: "ws://fake-nats:4222",
    clientName: "test-agent",
    _wsFactory: broker.createFactory(),
  });

  const devices: NatsTransport[] = [];
  for (let i = 0; i < n; i++) {
    devices.push(
      new NatsTransport({
        url: "ws://fake-nats:4222",
        clientName: `device-${i}`,
        _wsFactory: broker.createFactory(),
      }),
    );
  }

  await Promise.all([agent.connect(), ...devices.map((d) => d.connect())]);
  return { agent, devices };
}

/**
 * Subscribe all device transports to `subject` and return a per-device array
 * of received NatsMessages.  Message arrays are pushed to synchronously by the
 * FakeNatsBroker as the agent publishes.
 */
function subscribeAll(
  devices: NatsTransport[],
  subject: string,
): NatsMessage[][] {
  return devices.map((device) => {
    const received: NatsMessage[] = [];
    device.on("message", (msg: NatsMessage) => received.push(msg));
    device.subscribe(subject);
    return received;
  });
}

/**
 * Build a minimal EnvelopeRouting record for a given messageId.
 */
function routing(
  messageId: string,
  envelopeType: EnvelopeRouting["envelopeType"] = "conversation",
  ts = 1_718_000_000_000,
): EnvelopeRouting {
  return {
    accountId: AGENT_ID,
    tenant: TENANT,
    sub: USER_SUB,
    messageId,
    envelopeType,
    ts,
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("1:N Multi-device Broadcast Sync (Sub-AC 5.1)", () => {
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
    for (const b of brokers) b.dispose();
    brokers.length = 0;
  });

  // ── Test 1: core 1:N invariant — 5 subscribers, 1 publish, all receive once ─

  it(
    "5 devices subscribed to the same subject all receive the message exactly once (core 1:N invariant)",
    async () => {
      const N = 5;
      const broker = new FakeNatsBroker();
      brokers.push(broker);

      const { devices, agent } = await makeDevicePool(broker, N);
      teardown.push(agent, ...devices);

      const convKey = makeConversationKey();

      // All N devices subscribe to the shared outbound subject.
      // This mirrors each device of user42 subscribing to chat.tenant1.agent1.user42.out.
      const perDeviceReceived = subscribeAll(devices, OUTBOUND);

      // Agent publishes one E2E-encrypted message.
      const secretText = "Hello all 5 devices — 1:N broadcast payload";
      agent.publish(
        OUTBOUND,
        serializeEnvelope(
          encodeEnvelope(routing("msg-broadcast-n5"), enc(secretText), convKey),
        ),
      );

      // (a) Every device received exactly one message — no duplicates, no misses.
      for (let i = 0; i < N; i++) {
        expect(
          perDeviceReceived[i],
          `device-${i} must receive exactly 1 message`,
        ).toHaveLength(1);
        expect(
          perDeviceReceived[i]![0]!.subject,
          `device-${i} message subject must match OUTBOUND`,
        ).toBe(OUTBOUND);
      }
    },
  );

  // ── Test 2: large-N (10 subscribers) — all receive identical ciphertext ────

  it(
    "10 devices all receive byte-for-byte identical ciphertext from a single publish",
    async () => {
      const N = 10;
      const broker = new FakeNatsBroker();
      brokers.push(broker);

      const { devices, agent } = await makeDevicePool(broker, N);
      teardown.push(agent, ...devices);

      const convKey = makeConversationKey();
      const perDeviceReceived = subscribeAll(devices, OUTBOUND);

      agent.publish(
        OUTBOUND,
        serializeEnvelope(
          encodeEnvelope(
            routing("msg-large-n-001"),
            enc("Large-N broadcast — 10 devices"),
            convKey,
          ),
        ),
      );

      // (a) All 10 devices received exactly 1 message each.
      for (let i = 0; i < N; i++) {
        expect(perDeviceReceived[i], `device-${i} must receive 1 message`).toHaveLength(1);
      }

      // (b) All payloads are byte-for-byte identical (relay cannot inject variants).
      const referenceHex = perDeviceReceived[0]![0]!.payload.toString("hex");
      for (let i = 1; i < N; i++) {
        expect(
          perDeviceReceived[i]![0]!.payload.toString("hex"),
          `device-${i} payload must be byte-for-byte identical to device-0`,
        ).toBe(referenceHex);
      }
    },
  );

  // ── Test 3: identical ciphertext bytes across N=7 receivers ─────────────────

  it(
    "raw ciphertext received by every device is byte-identical to the published wire bytes",
    async () => {
      const N = 7;
      const broker = new FakeNatsBroker();
      brokers.push(broker);

      const { devices, agent } = await makeDevicePool(broker, N);
      teardown.push(agent, ...devices);

      const convKey = makeConversationKey();
      const perDeviceReceived = subscribeAll(devices, OUTBOUND);

      // Capture the wire bytes that were published.
      const envelope = encodeEnvelope(
        routing("msg-ciphertext-identity"),
        enc("Ciphertext identity check — 7 devices"),
        convKey,
      );
      const wireBytes = serializeEnvelope(envelope);
      agent.publish(OUTBOUND, wireBytes);

      // All N devices received exactly 1 message.
      for (let i = 0; i < N; i++) {
        expect(perDeviceReceived[i]).toHaveLength(1);
      }

      // Every device's payload is byte-for-byte identical to the wire bytes.
      const expectedBase64 = wireBytes.toString("base64");
      for (let i = 0; i < N; i++) {
        const devicePayload = perDeviceReceived[i]![0]!.payload;
        expect(
          devicePayload.length,
          `device-${i} payload length matches wire bytes length`,
        ).toBe(wireBytes.length);
        expect(
          devicePayload.toString("base64"),
          `device-${i} payload is byte-identical to published wire bytes`,
        ).toBe(expectedBase64);
      }
    },
  );

  // ── Test 4: all N receivers successfully decrypt with the shared key ─────────

  it(
    "all N devices holding the shared conversation key decrypt to identical plaintext",
    async () => {
      const N = 5;
      const broker = new FakeNatsBroker();
      brokers.push(broker);

      const { devices, agent } = await makeDevicePool(broker, N);
      teardown.push(agent, ...devices);

      // The shared conversationKey is what each device receives via device-key-wrap.
      // All devices of the same `sub` unwrap to the same symmetric key.
      const convKey = makeConversationKey();
      const secretText = "Shared-key decryption: all 5 devices must read this identical plaintext";

      const perDeviceReceived = subscribeAll(devices, OUTBOUND);

      agent.publish(
        OUTBOUND,
        serializeEnvelope(
          encodeEnvelope(routing("msg-decrypt-all"), enc(secretText), convKey),
        ),
      );

      // (c) Every device received the message and can decrypt to the original plaintext.
      for (let i = 0; i < N; i++) {
        expect(perDeviceReceived[i]).toHaveLength(1);

        const env = deserializeEnvelope(perDeviceReceived[i]![0]!.payload);
        const plaintext = dec(decryptEnvelopeContent(env, convKey));

        expect(
          plaintext,
          `device-${i} decrypted plaintext must match original secret`,
        ).toBe(secretText);
      }
    },
  );

  // ── Test 5: M sequential publishes received in order by all N devices ────────

  it(
    "N devices each receive M sequential messages in publication order",
    async () => {
      const N = 4;
      const M = 5; // 5 sequential messages
      const broker = new FakeNatsBroker();
      brokers.push(broker);

      const { devices, agent } = await makeDevicePool(broker, N);
      teardown.push(agent, ...devices);

      const convKey = makeConversationKey();
      const perDeviceReceived = subscribeAll(devices, OUTBOUND);

      const messages = Array.from(
        { length: M },
        (_, i) => `Sequential-message-${i + 1}-of-${M}`,
      );

      // Agent publishes M messages in sequence.
      for (let i = 0; i < M; i++) {
        agent.publish(
          OUTBOUND,
          serializeEnvelope(
            encodeEnvelope(
              routing(`msg-seq-${i + 1}`, "conversation", 1_718_000_000_010 + i),
              enc(messages[i]!),
              convKey,
            ),
          ),
        );
      }

      // (e) Every device received all M messages, in publication order.
      for (let d = 0; d < N; d++) {
        expect(
          perDeviceReceived[d],
          `device-${d} must receive all ${M} messages`,
        ).toHaveLength(M);

        for (let i = 0; i < M; i++) {
          const env = deserializeEnvelope(perDeviceReceived[d]![i]!.payload);
          const plaintext = dec(decryptEnvelopeContent(env, convKey));
          expect(
            plaintext,
            `device-${d} message[${i}] must match published order`,
          ).toBe(messages[i]!);
        }
      }
    },
  );

  // ── Test 6: late-join device — subscribes before new publish, misses earlier ─

  it(
    "late-join device (subscribed before second publish) receives only messages published after subscription",
    async () => {
      const broker = new FakeNatsBroker();
      brokers.push(broker);

      const convKey = makeConversationKey();

      // Three original devices connect and subscribe from the start.
      const { devices: origDevices, agent } = await makeDevicePool(broker, 3);
      teardown.push(agent, ...origDevices);

      const origReceived = subscribeAll(origDevices, OUTBOUND);

      // First publish — only the 3 original devices are subscribed.
      agent.publish(
        OUTBOUND,
        serializeEnvelope(
          encodeEnvelope(
            routing("msg-early", "conversation", 1_718_000_000_020),
            enc("Early message — late-joiner misses this one"),
            convKey,
          ),
        ),
      );

      // Original devices each received 1 message.
      for (let i = 0; i < 3; i++) {
        expect(origReceived[i]).toHaveLength(1);
      }

      // Late-joiner connects and subscribes NOW (after the first publish).
      const lateDevice = new NatsTransport({
        url: "ws://fake-nats:4222",
        clientName: "late-join-device",
        _wsFactory: broker.createFactory(),
      });
      teardown.push(lateDevice);
      await lateDevice.connect();

      const lateReceived: NatsMessage[] = [];
      lateDevice.on("message", (m: NatsMessage) => lateReceived.push(m));
      lateDevice.subscribe(OUTBOUND);

      // Second publish — all 4 devices (3 original + late-joiner) are subscribed.
      agent.publish(
        OUTBOUND,
        serializeEnvelope(
          encodeEnvelope(
            routing("msg-late", "conversation", 1_718_000_000_021),
            enc("Late message — all 4 devices including late-joiner receive this"),
            convKey,
          ),
        ),
      );

      // Original devices now have 2 messages each.
      for (let i = 0; i < 3; i++) {
        expect(origReceived[i]).toHaveLength(2);
      }

      // Late-joiner received only the second message (after subscription).
      expect(lateReceived).toHaveLength(1);
      const lateEnv = deserializeEnvelope(lateReceived[0]!.payload);
      expect(lateEnv.messageId).toBe("msg-late");

      // Late-joiner can decrypt (holds the shared conversationKey).
      const latePlaintext = dec(decryptEnvelopeContent(lateEnv, convKey));
      expect(latePlaintext).toBe(
        "Late message — all 4 devices including late-joiner receive this",
      );
    },
  );

  // ── Test 7: disconnected device stops receiving — exactly-once per subscriber ─

  it(
    "device that disconnects stops receiving subsequent messages while remaining devices continue",
    async () => {
      const broker = new FakeNatsBroker();
      brokers.push(broker);

      const { devices, agent } = await makeDevicePool(broker, 3);
      // Push only devices[0] and devices[2] into teardown; devices[1] will be
      // disconnected manually and is left to teardown gracefully (disconnect is
      // idempotent).
      teardown.push(agent, devices[0]!, devices[1]!, devices[2]!);

      const convKey = makeConversationKey();
      const perDeviceReceived = subscribeAll(devices, OUTBOUND);

      // First publish — all 3 devices are subscribed.
      agent.publish(
        OUTBOUND,
        serializeEnvelope(
          encodeEnvelope(
            routing("msg-pre-disconnect", "conversation", 1_718_000_000_030),
            enc("Before disconnect — 3 devices"),
            convKey,
          ),
        ),
      );

      for (let i = 0; i < 3; i++) {
        expect(perDeviceReceived[i]).toHaveLength(1);
      }

      // Device 1 disconnects (tab close / network drop).
      // FakeNatsBroker.close() removes device-1's subscriptions.
      devices[1]!.disconnect();

      // Second publish — only devices 0 and 2 are still subscribed.
      agent.publish(
        OUTBOUND,
        serializeEnvelope(
          encodeEnvelope(
            routing("msg-post-disconnect", "conversation", 1_718_000_000_031),
            enc("After disconnect — devices 0 and 2 only"),
            convKey,
          ),
        ),
      );

      // Devices 0 and 2 received the second message.
      expect(perDeviceReceived[0]).toHaveLength(2);
      expect(perDeviceReceived[2]).toHaveLength(2);

      // Device 1 (disconnected) received only the first message.
      expect(perDeviceReceived[1]).toHaveLength(1);
    },
  );

  // ── Test 8: approval_request fan-out to all N devices ───────────────────────

  it(
    "approval_request from agent broadcasts to all N subscribed devices (approval fan-out)",
    async () => {
      const N = 4;
      const broker = new FakeNatsBroker();
      brokers.push(broker);

      const { devices, agent } = await makeDevicePool(broker, N);
      teardown.push(agent, ...devices);

      const approvalKey = makeConversationKey("webchannel-approval-v1");
      const approvalId = "approval-fanout-001";
      const aad = enc(approvalId);

      const perDeviceReceived = subscribeAll(devices, APPROVAL);

      // Agent broadcasts an encrypted approval_request to all N devices.
      // In a real session, all devices render the approval widget simultaneously.
      agent.publish(
        APPROVAL,
        serializeEnvelope(
          encodeEnvelope(
            routing(approvalId, "approval_request", 1_718_000_000_040),
            enc(
              JSON.stringify({
                prompt: "Agent wants to read email — secret from relay operator",
                options: ["allow-once", "deny"],
              }),
            ),
            approvalKey,
            aad,
          ),
        ),
      );

      // (a) All N devices received the approval_request exactly once.
      for (let i = 0; i < N; i++) {
        expect(
          perDeviceReceived[i],
          `device-${i} must receive approval_request once`,
        ).toHaveLength(1);

        const env = deserializeEnvelope(perDeviceReceived[i]![0]!.payload);
        expect(env.envelopeType).toBe("approval_request");
        expect(env.messageId).toBe(approvalId);

        // (c) Each device can decrypt (holds the shared approval key).
        expect(
          () => decryptEnvelopeContent(env, approvalKey, aad),
          `device-${i} must decrypt approval_request successfully`,
        ).not.toThrow();
      }

      // (b) All devices received byte-identical ciphertext.
      const refHex = perDeviceReceived[0]![0]!.payload.toString("hex");
      for (let i = 1; i < N; i++) {
        expect(
          perDeviceReceived[i]![0]!.payload.toString("hex"),
          `device-${i} approval ciphertext must match device-0`,
        ).toBe(refHex);
      }
    },
  );

  // ── Test 9: cross-user isolation — user42 and user99 subjects are separated ──

  it(
    "broadcast to user42 subject does not reach user99 devices, and vice versa",
    async () => {
      const broker = new FakeNatsBroker();
      brokers.push(broker);

      const convKeyUser42 = makeConversationKey("webchannel-conversation-v1-u42");
      const convKeyUser99 = makeConversationKey("webchannel-conversation-v1-u99");

      // user42's devices (3 of them) connect to the broker.
      const { devices: devUser42, agent } = await makeDevicePool(broker, 3);
      teardown.push(agent, ...devUser42);

      // user99's devices (2 of them) connect to the SAME broker but different subject.
      const devUser99a = new NatsTransport({
        url: "ws://fake-nats:4222",
        clientName: "user99-device-a",
        _wsFactory: broker.createFactory(),
      });
      const devUser99b = new NatsTransport({
        url: "ws://fake-nats:4222",
        clientName: "user99-device-b",
        _wsFactory: broker.createFactory(),
      });
      teardown.push(devUser99a, devUser99b);
      await Promise.all([devUser99a.connect(), devUser99b.connect()]);

      // user42's devices subscribe to user42's outbound subject.
      const user42Received = subscribeAll(devUser42, OUTBOUND);

      // user99's devices subscribe to user99's outbound subject (different sub).
      const user99aReceived: NatsMessage[] = [];
      const user99bReceived: NatsMessage[] = [];
      devUser99a.on("message", (m: NatsMessage) => user99aReceived.push(m));
      devUser99b.on("message", (m: NatsMessage) => user99bReceived.push(m));
      devUser99a.subscribe(OTHER_OUTBOUND);
      devUser99b.subscribe(OTHER_OUTBOUND);

      // ── Publish to user42's subject ───────────────────────────────────────
      agent.publish(
        OUTBOUND,
        serializeEnvelope(
          encodeEnvelope(
            routing("msg-user42-private", "conversation", 1_718_000_000_050),
            enc("User42 private message — user99 must not receive this"),
            convKeyUser42,
          ),
        ),
      );

      // (f) user42's 3 devices each received 1 message.
      for (let i = 0; i < 3; i++) {
        expect(user42Received[i], `user42 device-${i}`).toHaveLength(1);
      }

      // (f) user99's devices received nothing.
      expect(
        user99aReceived,
        "user99 device-a must not receive user42 message",
      ).toHaveLength(0);
      expect(
        user99bReceived,
        "user99 device-b must not receive user42 message",
      ).toHaveLength(0);

      // ── Publish to user99's subject ───────────────────────────────────────
      devUser99a.publish(
        OTHER_OUTBOUND,
        serializeEnvelope(
          encodeEnvelope(
            {
              accountId: AGENT_ID,
              tenant: TENANT,
              sub: OTHER_USER_SUB,
              messageId: "msg-user99-private",
              envelopeType: "conversation",
              ts: 1_718_000_000_051,
            },
            enc("User99 private message — user42 must not receive this"),
            convKeyUser99,
          ),
        ),
      );

      // (f) user99's devices each received 1 message.
      expect(user99aReceived).toHaveLength(1);
      expect(user99bReceived).toHaveLength(1);

      // (f) user42's devices still have only the 1 message from their own publish.
      for (let i = 0; i < 3; i++) {
        expect(
          user42Received[i],
          `user42 device-${i} must not receive user99 message`,
        ).toHaveLength(1);
      }
    },
  );

  // ── Test 10: N=1 degenerate case — single device still receives once ─────────

  it(
    "single-device (N=1) subscription still receives the broadcast message exactly once",
    async () => {
      const broker = new FakeNatsBroker();
      brokers.push(broker);

      const { devices, agent } = await makeDevicePool(broker, 1);
      teardown.push(agent, ...devices);

      const convKey = makeConversationKey();
      const secretText = "Single-device broadcast — degenerate N=1 case";

      const [deviceReceived] = subscribeAll(devices, OUTBOUND);

      agent.publish(
        OUTBOUND,
        serializeEnvelope(
          encodeEnvelope(routing("msg-single"), enc(secretText), convKey),
        ),
      );

      // N=1: single device received exactly once.
      expect(deviceReceived).toHaveLength(1);

      // Device can decrypt the message.
      const env = deserializeEnvelope(deviceReceived![0]!.payload);
      expect(dec(decryptEnvelopeContent(env, convKey))).toBe(secretText);
    },
  );

  // ── Test 11: backlog history fan-out to all subscribed devices ───────────────

  it(
    "agent history replay broadcasts to all N devices subscribed to the history subject",
    async () => {
      const N = 4;
      const broker = new FakeNatsBroker();
      brokers.push(broker);

      const { devices, agent } = await makeDevicePool(broker, N);
      teardown.push(agent, ...devices);

      const convKey = makeConversationKey();

      // All N devices subscribe to the history replay subject (all devices of the
      // same user want history sync on reconnect).
      const perDeviceHistory = subscribeAll(devices, HISTORY);

      // Also subscribe one device to the INBOUND subject to send the request.
      const inboundReceived: NatsMessage[] = [];
      agent.on("message", (m: NatsMessage) => inboundReceived.push(m));
      agent.subscribe(INBOUND);

      // Device 0 sends a load_history request.
      // (In production this is encrypted; here we verify the fan-out delivery.)
      devices[0]!.publish(
        INBOUND,
        serializeEnvelope(
          encodeEnvelope(
            routing("load-history-req-1", "conversation"),
            enc(JSON.stringify({ type: "load_history", limit: 20 })),
            convKey,
          ),
        ),
      );

      // Agent received the request.
      expect(inboundReceived).toHaveLength(1);

      // Agent replays backlog to the history subject — this fans out to ALL devices.
      const histItems = [
        { id: "h-1", text: "First history entry", role: "user" },
        { id: "h-2", text: "First agent reply", role: "agent" },
        { id: "h-3", text: "Second user message", role: "user" },
      ];

      for (const item of histItems) {
        agent.publish(
          HISTORY,
          serializeEnvelope(
            encodeEnvelope(
              routing(item.id, "history"),
              enc(JSON.stringify(item)),
              convKey,
            ),
          ),
        );
      }

      // (a) All N devices received all 3 history envelopes.
      for (let d = 0; d < N; d++) {
        expect(
          perDeviceHistory[d],
          `device-${d} must receive ${histItems.length} history envelopes`,
        ).toHaveLength(histItems.length);

        // (c) Each device can decrypt all history items.
        for (let i = 0; i < histItems.length; i++) {
          const env = deserializeEnvelope(perDeviceHistory[d]![i]!.payload);
          expect(env.envelopeType).toBe("history");
          expect(env.messageId).toBe(histItems[i]!.id);
          const plaintext = dec(decryptEnvelopeContent(env, convKey));
          const parsed = JSON.parse(plaintext) as { id: string; text: string };
          expect(parsed.id).toBe(histItems[i]!.id);
          expect(parsed.text).toBe(histItems[i]!.text);
        }
      }

      // (b) All devices received identical ciphertext for each history item.
      for (let i = 0; i < histItems.length; i++) {
        const refHex = perDeviceHistory[0]![i]!.payload.toString("hex");
        for (let d = 1; d < N; d++) {
          expect(
            perDeviceHistory[d]![i]!.payload.toString("hex"),
            `history[${i}] device-${d} ciphertext must match device-0`,
          ).toBe(refHex);
        }
      }
    },
  );

  // ── Test 12: SLA — all deliveries are synchronous within the publish call ────

  it(
    "all N deliveries complete synchronously within the same call stack as publish (SLA)",
    async () => {
      // This test proves (d): no awaits or timers are needed after publish.
      // The FakeNatsBroker delivers synchronously, matching the at-most-one-
      // network-hop latency guarantee of a co-located NATS server.
      const N = 8;
      const broker = new FakeNatsBroker();
      brokers.push(broker);

      const { devices, agent } = await makeDevicePool(broker, N);
      teardown.push(agent, ...devices);

      const convKey = makeConversationKey();
      const perDeviceReceived = subscribeAll(devices, OUTBOUND);

      // Verify arrays are empty BEFORE publish.
      for (let i = 0; i < N; i++) {
        expect(perDeviceReceived[i]).toHaveLength(0);
      }

      // Publish — NO await, no setTimeout, no microtask yield.
      agent.publish(
        OUTBOUND,
        serializeEnvelope(
          encodeEnvelope(
            routing("msg-sla-check"),
            enc("SLA synchronous delivery check"),
            convKey,
          ),
        ),
      );

      // Assert immediately — delivery was synchronous.
      for (let i = 0; i < N; i++) {
        expect(
          perDeviceReceived[i],
          `device-${i} must have received the message synchronously`,
        ).toHaveLength(1);
      }
    },
  );
});
