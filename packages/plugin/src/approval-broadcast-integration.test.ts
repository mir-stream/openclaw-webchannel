/**
 * Approval Multi-device Broadcast Integration Tests — Sub-AC 7.2
 *
 * Sub-AC 7.2: Multi-device broadcast delivery of approval_request.
 *
 * Implements and verifies the NATS subject/subscription pattern that delivers
 * an encrypted `approval_request` to ALL concurrently subscribed devices of
 * the same user (same JWT `sub`) in a single publish.
 *
 * ## NATS Subject Pattern
 *
 * All devices of user `<sub>` subscribe to the same approval subject:
 *
 *   chat.<tenant>.<accountId>.<sub>.approval
 *
 * The agent publishes ONE encrypted `approval_request` envelope to this
 * subject. The NATS broker fans it out to every subscriber. No per-device
 * publish loop, no wildcards needed — a single subject serves the 1:N fanout.
 *
 * Subject segments are plaintext routing metadata (allowed per the security
 * model). The encrypted content block is opaque to the NATS relay operator.
 *
 * ## Security invariants verified
 *
 *   (a) EXACTLY-ONCE DELIVERY: each of the N subscriber devices receives
 *       the `approval_request` exactly once — no duplicates, no misses.
 *
 *   (b) BYTE-IDENTICAL CIPHERTEXT: every device receives the exact same
 *       wire bytes. The relay operator cannot inject per-device variants.
 *
 *   (c) DECRYPTABLE BY ALL DEVICES: every device that holds the shared
 *       approval key (distributed via device-key-wrap, same as conversation
 *       key) can successfully decrypt and parse the `approval_request` body.
 *       The relay operator, who lacks the session key, cannot decrypt.
 *
 *   (d) APPROVAL ID BINDING (AAD): the `approvalId` is authenticated as
 *       additional data — a relay operator cannot swap one approval's
 *       ciphertext into a different approval slot without breaking the
 *       Poly1305 tag.
 *
 *   (e) CROSS-USER ISOLATION: devices subscribed to user-A's approval subject
 *       do not receive `approval_request` messages published to user-B's
 *       subject. No wildcard subscriptions bleed across users.
 *
 *   (f) RELAY OPERATOR OPACITY: the serialized wire bytes passed to NATS
 *       contain ZERO plaintext approval content (no title, prompt, options,
 *       decision value). The relay observes only routing metadata and
 *       `envelopeType: "approval_request"`.
 *
 * ## Architecture
 *
 * Uses the same FakeNatsBroker (in-process NATS text-protocol relay) used
 * across all prior sub-AC tests. All N NatsTransport instances (devices) and
 * the agent connect to the same broker via the `_wsFactory` seam — zero real
 * TCP sockets. Delivery is synchronous within the FakeNatsBroker's call stack.
 *
 * ## Tests
 *
 *  1.  N=3 devices all receive approval_request exactly once (core fan-out)
 *  2.  N=5 devices — all receive byte-identical ciphertext
 *  3.  N=8 devices — all can decrypt approval_request to exact body
 *  4.  Relay operator CANNOT decrypt (wrong key, throws)
 *  5.  approvalId AAD binding — wrong approvalId breaks decryption
 *  6.  Multiple concurrent approval_requests fan out independently
 *  7.  Cross-user isolation — user-A approval not received by user-B devices
 *  8.  Device that disconnects misses subsequent approval_request
 *  9.  Wire bytes contain zero plaintext approval content
 * 10.  Single device (N=1) still receives exactly once
 */

import { describe, it, expect, afterEach } from "vitest";
import WebSocket from "ws";

import { NatsTransport } from "./nats-transport.js";
import type { NatsMessage } from "./nats-transport.js";
import {
  encryptApprovalRequest,
  decryptApprovalRequest,
  serializeApprovalEnvelope,
  deserializeApprovalEnvelope,
  APPROVAL_KEY_INFO,
} from "./approval-e2e-crypto.js";
import type { ApprovalRequestBody } from "./approval-e2e-crypto.js";
import {
  generateKeyPair,
  deriveSharedSecret,
  hkdfSha256,
} from "./e2e-crypto.js";

// ---------------------------------------------------------------------------
// FakeNatsBroker — in-process NATS text-protocol relay (zero TCP sockets)
//
// Synchronous delivery: a publish() call routes MSG frames to all subscribers
// in the same call stack — tests assert immediately after publish() with no
// async delays. Exact-match subject routing (no wildcard support needed here).
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

        on(event: string, fn: (...args: unknown[]) => void): typeof fakeWs {
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
          `INFO {"server_id":"fake-nats","version":"2.10.0"}\r\nPONG\r\n`,
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
          buffer = `${line}\r\n${buffer}`;
          break;
        }

        const payload = buffer.slice(0, byteCount);
        buffer = buffer.slice(byteCount + 2);

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
// Canonical routing constants
// ---------------------------------------------------------------------------

const TENANT = "acme";
const AGENT_ID = "agent-007";
const USER_A_SUB = "user-alice";
const USER_B_SUB = "user-bob";

/** Approval subject for user A — all user-A devices subscribe here. */
const APPROVAL_A = `chat.${TENANT}.${AGENT_ID}.${USER_A_SUB}.approval`;
/** Approval subject for user B — all user-B devices subscribe here. */
const APPROVAL_B = `chat.${TENANT}.${AGENT_ID}.${USER_B_SUB}.approval`;

// ---------------------------------------------------------------------------
// Crypto helpers
// ---------------------------------------------------------------------------

/**
 * Derive a 32-byte approval session key via X25519 ECDH + HKDF-SHA256 using
 * the canonical APPROVAL_KEY_INFO domain-separation string.
 *
 * This simulates the shared approval key that every device of the same user
 * receives via device-key-wrap (agent wraps the key for each device's cnf
 * public key; each device unwraps with its own private key). After unwrapping
 * all devices of the same `sub` hold the same 32-byte key.
 */
function makeApprovalKey(): Uint8Array {
  const agentKP = generateKeyPair();
  const deviceKP = generateKeyPair();
  const rawSecret = deriveSharedSecret(agentKP.privateKey, deviceKP.publicKey);
  return hkdfSha256(rawSecret, null, APPROVAL_KEY_INFO, 32);
}

/** Build an `ApprovalRequestBody` fixture with recognizable sensitive strings. */
function makeApprovalBody(approvalId: string, index = 0): ApprovalRequestBody {
  return {
    id: approvalId,
    kind: "exec",
    title: `Approval[${index}]: confidential shell command — ${approvalId}`,
    description: `Run secret-command-${approvalId} with elevated privileges`,
    prompt: `Secret-prompt-${approvalId}: do you allow this?`,
    options: [
      { decision: "allow-once",   label: "Allow Once",   style: "success" },
      { decision: "allow-always", label: "Allow Always", style: "primary" },
      { decision: "deny",         label: "Deny",         style: "danger"  },
    ],
    expiresAtMs: 1_718_000_060_000 + index,
  };
}

/**
 * Build an `ApprovalRouting` record for the given approvalId + user.
 */
function approvalRouting(
  approvalId: string,
  sub = USER_A_SUB,
  ts = 1_718_000_000_000,
) {
  return { accountId: AGENT_ID, tenant: TENANT, sub, messageId: approvalId, ts };
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Connect N device NatsTransport instances + one agent to the same broker.
 * Returns all transports in the teardown array.
 */
async function makePool(
  broker: FakeNatsBroker,
  n: number,
  teardown: NatsTransport[],
): Promise<{ agent: NatsTransport; devices: NatsTransport[] }> {
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
  teardown.push(agent, ...devices);
  return { agent, devices };
}

/**
 * Subscribe all devices to `subject`; return per-device received-message arrays.
 * The FakeNatsBroker delivers synchronously, so arrays are filled immediately
 * on `agent.publish()`.
 */
function subscribeAll(
  devices: NatsTransport[],
  subject: string,
): NatsMessage[][] {
  return devices.map((d) => {
    const received: NatsMessage[] = [];
    d.on("message", (m: NatsMessage) => received.push(m));
    d.subscribe(subject);
    return received;
  });
}

// ---------------------------------------------------------------------------
// Test suite: Approval Multi-device Broadcast (Sub-AC 7.2)
// ---------------------------------------------------------------------------

describe("Approval Multi-device Broadcast (Sub-AC 7.2)", () => {
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

  // ── Test 1: N=3 core fan-out — each device receives exactly once ─────────

  it(
    "(1) N=3 devices: each receives the approval_request exactly once (core fan-out)",
    async () => {
      const N = 3;
      const broker = new FakeNatsBroker();
      brokers.push(broker);

      const { agent, devices } = await makePool(broker, N, teardown);
      const approvalKey = makeApprovalKey();
      const approvalId = "approval-fanout-n3";
      const body = makeApprovalBody(approvalId);
      const routing = approvalRouting(approvalId);
      const aad = new TextEncoder().encode(approvalId);

      // All N devices subscribe to the shared approval subject.
      // This is the NATS subject/subscription pattern: one subject per (tenant,
      // accountId, sub) — all devices of the same user share it.
      const perDeviceReceived = subscribeAll(devices, APPROVAL_A);

      // Agent publishes ONE encrypted approval_request.
      const env = encryptApprovalRequest(routing, body, approvalKey, approvalId);
      agent.publish(APPROVAL_A, serializeApprovalEnvelope(env));

      // (a) Every device received exactly one message.
      for (let i = 0; i < N; i++) {
        expect(
          perDeviceReceived[i],
          `device-${i} must receive approval_request exactly once`,
        ).toHaveLength(1);
        expect(
          perDeviceReceived[i]![0]!.subject,
          `device-${i} subject must be ${APPROVAL_A}`,
        ).toBe(APPROVAL_A);
      }

      // (c) Every device can decrypt the approval_request.
      for (let i = 0; i < N; i++) {
        const received = deserializeApprovalEnvelope(
          perDeviceReceived[i]![0]!.payload,
        );
        expect(received.envelopeType).toBe("approval_request");
        expect(received.messageId).toBe(approvalId);

        const decrypted = decryptApprovalRequest(received, approvalKey, approvalId);
        expect(decrypted.id).toBe(approvalId);
        expect(decrypted.title).toBe(body.title);
        expect(decrypted.options).toHaveLength(3);
      }
    },
  );

  // ── Test 2: N=5 — byte-identical ciphertext at every device ─────────────

  it(
    "(2) N=5 devices: all receive byte-for-byte identical ciphertext (relay cannot inject variants)",
    async () => {
      const N = 5;
      const broker = new FakeNatsBroker();
      brokers.push(broker);

      const { agent, devices } = await makePool(broker, N, teardown);
      const approvalKey = makeApprovalKey();
      const approvalId = "approval-byte-identical-n5";
      const body = makeApprovalBody(approvalId, 1);
      const routing = approvalRouting(approvalId);

      const perDeviceReceived = subscribeAll(devices, APPROVAL_A);

      const env = encryptApprovalRequest(routing, body, approvalKey, approvalId);
      agent.publish(APPROVAL_A, serializeApprovalEnvelope(env));

      // All 5 devices received exactly 1 message.
      for (let i = 0; i < N; i++) {
        expect(
          perDeviceReceived[i],
          `device-${i} must receive 1 approval_request`,
        ).toHaveLength(1);
      }

      // (b) All payloads are byte-for-byte identical.
      const referenceHex = perDeviceReceived[0]![0]!.payload.toString("hex");
      for (let i = 1; i < N; i++) {
        expect(
          perDeviceReceived[i]![0]!.payload.toString("hex"),
          `device-${i} ciphertext must be byte-identical to device-0`,
        ).toBe(referenceHex);
      }
    },
  );

  // ── Test 3: N=8 — all devices decrypt to identical approval body ─────────

  it(
    "(3) N=8 devices: all decrypt approval_request to the exact original body",
    async () => {
      const N = 8;
      const broker = new FakeNatsBroker();
      brokers.push(broker);

      const { agent, devices } = await makePool(broker, N, teardown);
      const approvalKey = makeApprovalKey();
      const approvalId = "approval-decrypt-n8";
      const body = makeApprovalBody(approvalId, 2);
      const routing = approvalRouting(approvalId);

      const perDeviceReceived = subscribeAll(devices, APPROVAL_A);

      const env = encryptApprovalRequest(routing, body, approvalKey, approvalId);
      agent.publish(APPROVAL_A, serializeApprovalEnvelope(env));

      for (let i = 0; i < N; i++) {
        expect(
          perDeviceReceived[i],
          `device-${i} must receive 1 message`,
        ).toHaveLength(1);

        const received = deserializeApprovalEnvelope(
          perDeviceReceived[i]![0]!.payload,
        );
        const decrypted = decryptApprovalRequest(received, approvalKey, approvalId);

        // (c) Every device decrypts to the exact same body.
        expect(decrypted.id, `device-${i} id`).toBe(approvalId);
        expect(decrypted.title, `device-${i} title`).toBe(body.title);
        expect(decrypted.description, `device-${i} description`).toBe(body.description);
        expect(decrypted.prompt, `device-${i} prompt`).toBe(body.prompt);
        expect(decrypted.options, `device-${i} options`).toHaveLength(3);
        expect(decrypted.options[0]!.decision, `device-${i} option[0]`).toBe("allow-once");
        expect(decrypted.options[1]!.decision, `device-${i} option[1]`).toBe("allow-always");
        expect(decrypted.options[2]!.decision, `device-${i} option[2]`).toBe("deny");
      }
    },
  );

  // ── Test 4: relay operator CANNOT decrypt ────────────────────────────────

  it(
    "(4) relay operator with own key cannot decrypt any device's received ciphertext",
    async () => {
      const N = 3;
      const broker = new FakeNatsBroker();
      brokers.push(broker);

      const { agent, devices } = await makePool(broker, N, teardown);

      // Legitimate session key (shared by agent and all user devices).
      const agentKP   = generateKeyPair();
      const browserKP = generateKeyPair();
      const sessionKey = hkdfSha256(
        deriveSharedSecret(agentKP.privateKey, browserKP.publicKey),
        null,
        APPROVAL_KEY_INFO,
        32,
      );

      // Relay operator generates their OWN key pair.
      const relayKP  = generateKeyPair();
      const relayKey = hkdfSha256(
        deriveSharedSecret(relayKP.privateKey, agentKP.publicKey),
        null,
        APPROVAL_KEY_INFO,
        32,
      );

      // Relay key must be genuinely different from the session key.
      expect(Buffer.from(relayKey).toString("hex")).not.toBe(
        Buffer.from(sessionKey).toString("hex"),
      );

      const approvalId = "approval-relay-opacity";
      const body = makeApprovalBody(approvalId, 3);
      const routing = approvalRouting(approvalId);

      const perDeviceReceived = subscribeAll(devices, APPROVAL_A);
      const env = encryptApprovalRequest(routing, body, sessionKey, approvalId);
      agent.publish(APPROVAL_A, serializeApprovalEnvelope(env));

      // All devices received exactly 1 message.
      for (let i = 0; i < N; i++) {
        expect(perDeviceReceived[i]).toHaveLength(1);
      }

      // Relay operator tries to decrypt device-0's received ciphertext.
      const intercepted = deserializeApprovalEnvelope(
        perDeviceReceived[0]![0]!.payload,
      );
      expect(
        () => decryptApprovalRequest(intercepted, relayKey, approvalId),
        "relay operator MUST NOT be able to decrypt",
      ).toThrow();

      // Legitimate device CAN decrypt.
      const legitimate = decryptApprovalRequest(intercepted, sessionKey, approvalId);
      expect(legitimate.title).toBe(body.title);
    },
  );

  // ── Test 5: approvalId AAD binding ───────────────────────────────────────

  it(
    "(5) approvalId AAD binding: correct approvalId succeeds; swapped approvalId breaks Poly1305 tag",
    async () => {
      const N = 2;
      const broker = new FakeNatsBroker();
      brokers.push(broker);

      const { agent, devices } = await makePool(broker, N, teardown);
      const approvalKey = makeApprovalKey();

      const approvalId = "approval-aad-binding";
      const body = makeApprovalBody(approvalId, 4);
      const routing = approvalRouting(approvalId);

      const perDeviceReceived = subscribeAll(devices, APPROVAL_A);
      const env = encryptApprovalRequest(routing, body, approvalKey, approvalId);
      agent.publish(APPROVAL_A, serializeApprovalEnvelope(env));

      for (let i = 0; i < N; i++) {
        expect(perDeviceReceived[i]).toHaveLength(1);
        const received = deserializeApprovalEnvelope(
          perDeviceReceived[i]![0]!.payload,
        );

        // (d) Correct approvalId succeeds.
        expect(
          () => decryptApprovalRequest(received, approvalKey, approvalId),
          `device-${i} correct AAD must succeed`,
        ).not.toThrow();

        // (d) Wrong approvalId breaks the Poly1305 auth tag.
        expect(
          () => decryptApprovalRequest(received, approvalKey, "approval-WRONG-ID"),
          `device-${i} wrong AAD must throw`,
        ).toThrow();
      }
    },
  );

  // ── Test 6: multiple concurrent approval_requests fan out independently ──

  it(
    "(6) multiple concurrent approval_requests fan out independently to N devices",
    async () => {
      const N = 4;
      const APPROVALS = 3;
      const broker = new FakeNatsBroker();
      brokers.push(broker);

      const { agent, devices } = await makePool(broker, N, teardown);
      const approvalKey = makeApprovalKey();

      const perDeviceReceived = subscribeAll(devices, APPROVAL_A);

      // Agent publishes APPROVALS different approval_requests sequentially.
      const approvalIds = Array.from(
        { length: APPROVALS },
        (_, i) => `approval-concurrent-${i + 1}`,
      );

      for (let i = 0; i < APPROVALS; i++) {
        const id = approvalIds[i]!;
        const body = makeApprovalBody(id, i + 10);
        const routing = approvalRouting(id);
        const env = encryptApprovalRequest(routing, body, approvalKey, id);
        agent.publish(APPROVAL_A, serializeApprovalEnvelope(env));
      }

      // Every device received all APPROVALS messages.
      for (let d = 0; d < N; d++) {
        expect(
          perDeviceReceived[d],
          `device-${d} must receive all ${APPROVALS} approval_requests`,
        ).toHaveLength(APPROVALS);

        // Each received in publication order with correct approvalId.
        for (let i = 0; i < APPROVALS; i++) {
          const received = deserializeApprovalEnvelope(
            perDeviceReceived[d]![i]!.payload,
          );
          expect(received.envelopeType).toBe("approval_request");
          expect(received.messageId).toBe(approvalIds[i]);

          const decrypted = decryptApprovalRequest(
            received,
            approvalKey,
            approvalIds[i]!,
          );
          expect(decrypted.id).toBe(approvalIds[i]);
        }
      }
    },
  );

  // ── Test 7: cross-user isolation ─────────────────────────────────────────

  it(
    "(7) cross-user isolation: user-A approval_request not received by user-B devices",
    async () => {
      const broker = new FakeNatsBroker();
      brokers.push(broker);

      const approvalKeyA = makeApprovalKey();
      const approvalKeyB = makeApprovalKey();

      // User-A: 3 devices + agent.
      const { agent, devices: devA } = await makePool(broker, 3, teardown);

      // User-B: 2 independent devices.
      const devB0 = new NatsTransport({
        url: "ws://fake-nats:4222",
        clientName: "user-b-device-0",
        _wsFactory: broker.createFactory(),
      });
      const devB1 = new NatsTransport({
        url: "ws://fake-nats:4222",
        clientName: "user-b-device-1",
        _wsFactory: broker.createFactory(),
      });
      teardown.push(devB0, devB1);
      await Promise.all([devB0.connect(), devB1.connect()]);

      // User-A devices subscribe to user-A's approval subject.
      const aReceived = subscribeAll(devA, APPROVAL_A);

      // User-B devices subscribe to user-B's approval subject (different `sub`).
      const bReceived0: NatsMessage[] = [];
      const bReceived1: NatsMessage[] = [];
      devB0.on("message", (m: NatsMessage) => bReceived0.push(m));
      devB1.on("message", (m: NatsMessage) => bReceived1.push(m));
      devB0.subscribe(APPROVAL_B);
      devB1.subscribe(APPROVAL_B);

      // ── Publish user-A approval_request ─────────────────────────────────
      const idA = "approval-user-a-private";
      const envA = encryptApprovalRequest(
        approvalRouting(idA, USER_A_SUB),
        makeApprovalBody(idA, 20),
        approvalKeyA,
        idA,
      );
      agent.publish(APPROVAL_A, serializeApprovalEnvelope(envA));

      // (e) user-A's 3 devices each received 1 message.
      for (let i = 0; i < 3; i++) {
        expect(aReceived[i], `user-A device-${i}`).toHaveLength(1);
      }
      // (e) user-B's devices received nothing from user-A's publish.
      expect(
        bReceived0,
        "user-B device-0 must not receive user-A approval_request",
      ).toHaveLength(0);
      expect(
        bReceived1,
        "user-B device-1 must not receive user-A approval_request",
      ).toHaveLength(0);

      // ── Publish user-B approval_request ─────────────────────────────────
      const idB = "approval-user-b-private";
      const envB = encryptApprovalRequest(
        approvalRouting(idB, USER_B_SUB),
        makeApprovalBody(idB, 21),
        approvalKeyB,
        idB,
      );
      devB0.publish(APPROVAL_B, serializeApprovalEnvelope(envB));

      // (e) user-B's devices each received 1 message.
      expect(bReceived0).toHaveLength(1);
      expect(bReceived1).toHaveLength(1);
      // (e) user-A's devices still have only their own 1 message.
      for (let i = 0; i < 3; i++) {
        expect(
          aReceived[i],
          `user-A device-${i} must not receive user-B approval_request`,
        ).toHaveLength(1);
      }
    },
  );

  // ── Test 8: disconnected device misses subsequent approval_requests ───────

  it(
    "(8) device that disconnects misses subsequent approval_requests; remaining devices still receive",
    async () => {
      const broker = new FakeNatsBroker();
      brokers.push(broker);

      const { agent, devices } = await makePool(broker, 3, teardown);
      const approvalKey = makeApprovalKey();

      const perDeviceReceived = subscribeAll(devices, APPROVAL_A);

      // First approval — all 3 devices subscribed.
      const id1 = "approval-pre-disconnect";
      const env1 = encryptApprovalRequest(
        approvalRouting(id1),
        makeApprovalBody(id1),
        approvalKey,
        id1,
      );
      agent.publish(APPROVAL_A, serializeApprovalEnvelope(env1));

      for (let i = 0; i < 3; i++) {
        expect(perDeviceReceived[i]).toHaveLength(1);
      }

      // Device 1 disconnects (tab close / network drop).
      devices[1]!.disconnect();

      // Second approval — only devices 0 and 2 are still subscribed.
      const id2 = "approval-post-disconnect";
      const env2 = encryptApprovalRequest(
        approvalRouting(id2),
        makeApprovalBody(id2),
        approvalKey,
        id2,
      );
      agent.publish(APPROVAL_A, serializeApprovalEnvelope(env2));

      // Device 0 and 2 received the second approval.
      expect(perDeviceReceived[0]).toHaveLength(2);
      expect(perDeviceReceived[2]).toHaveLength(2);
      // Device 1 (disconnected) missed the second approval.
      expect(
        perDeviceReceived[1],
        "disconnected device must NOT receive the second approval_request",
      ).toHaveLength(1);
    },
  );

  // ── Test 9: wire bytes contain zero plaintext approval content ────────────

  it(
    "(9) serialized approval_request wire bytes contain zero plaintext content (relay opacity)",
    async () => {
      const N = 2;
      const broker = new FakeNatsBroker();
      brokers.push(broker);

      const { agent, devices } = await makePool(broker, N, teardown);
      const approvalKey = makeApprovalKey();
      const approvalId = "approval-wire-opacity";

      // Sensitive strings that MUST NOT appear in the wire bytes.
      const secretTitle    = "Confidential DB migration approval";
      const secretPrompt   = "secret-command-xyz: should the agent run this?";
      const secretDesc     = "Privileged DB operation — classified";
      const decisionValue  = "allow-once";

      const body: ApprovalRequestBody = {
        id: approvalId,
        kind: "exec",
        title: secretTitle,
        description: secretDesc,
        prompt: secretPrompt,
        options: [
          { decision: "allow-once",   label: "Allow Once", style: "success" },
          { decision: "allow-always", label: "Allow",      style: "primary" },
          { decision: "deny",         label: "Deny",       style: "danger"  },
        ],
      };

      const perDeviceReceived = subscribeAll(devices, APPROVAL_A);
      const env = encryptApprovalRequest(
        approvalRouting(approvalId),
        body,
        approvalKey,
        approvalId,
      );
      const wireBytes = serializeApprovalEnvelope(env);
      agent.publish(APPROVAL_A, wireBytes);

      for (let i = 0; i < N; i++) {
        expect(perDeviceReceived[i]).toHaveLength(1);
      }

      // (f) Inspect the raw wire bytes for zero-plaintext guarantee.
      const wireJson = wireBytes.toString("utf8");

      expect(wireJson, "title must not appear on wire").not.toContain(secretTitle);
      expect(wireJson, "prompt must not appear on wire").not.toContain(secretPrompt);
      expect(wireJson, "description must not appear on wire").not.toContain(secretDesc);
      expect(wireJson, "decision value must not appear on wire").not.toContain(decisionValue);
      expect(wireJson, "option label must not appear on wire").not.toContain("Allow Once");

      // Routing metadata IS plaintext (per design).
      expect(wireJson).toContain("approval_request");    // envelopeType
      expect(wireJson).toContain(approvalId);             // messageId
      expect(wireJson).toContain(AGENT_ID);               // accountId
      expect(wireJson).toContain(TENANT);                 // tenant

      // Content block is structurally opaque: exactly {nonce, ciphertext, tag}.
      const deserialized = deserializeApprovalEnvelope(wireBytes);
      const contentKeys = Object.keys(deserialized.content).sort();
      expect(contentKeys).toEqual(["ciphertext", "nonce", "tag"]);
    },
  );

  // ── Test 10: N=1 degenerate case ─────────────────────────────────────────

  it(
    "(10) single device (N=1) still receives the approval_request exactly once",
    async () => {
      const broker = new FakeNatsBroker();
      brokers.push(broker);

      const { agent, devices } = await makePool(broker, 1, teardown);
      const approvalKey = makeApprovalKey();
      const approvalId = "approval-single-device";
      const body = makeApprovalBody(approvalId);
      const routing = approvalRouting(approvalId);

      const [deviceReceived] = subscribeAll(devices, APPROVAL_A);

      const env = encryptApprovalRequest(routing, body, approvalKey, approvalId);
      agent.publish(APPROVAL_A, serializeApprovalEnvelope(env));

      // N=1: the single device received exactly once.
      expect(deviceReceived).toHaveLength(1);

      // Device can decrypt.
      const received = deserializeApprovalEnvelope(deviceReceived![0]!.payload);
      const decrypted = decryptApprovalRequest(received, approvalKey, approvalId);
      expect(decrypted.id).toBe(approvalId);
      expect(decrypted.title).toBe(body.title);
    },
  );
});
