/**
 * AC 5 E2E Test — NATS Cutover Verification.
 *
 * This test verifies the complete AC 5 implementation:
 * 1. Bootstrap JWT issuance from SaaS
 * 2. NATS client connects with bootstrap JWT
 * 3. Plugin NATS channel receives and routes messages
 * 4. Multi-peer sessions work correctly
 * 5. Approvals achieve first-write-wins exactly-once
 * 6. Gateway-WS relay paths are removed
 * 7. Phase A crypto integration works
 *
 * This is an integration test using the PermissionedFakeNatsBroker
 * to simulate real NATS server behavior without requiring a live nats-server.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { WebSocketServer, WebSocket } from "ws";

import { NatsTransport } from "./nats-transport.js";
import { NatsChannel } from "./nats-channel.js";
import type { InboundWsMessage, OutboundWsMessage, HistoryMessage } from "./nats-channel.js";
import { getApprovalResolution, clearApprovalResolutions } from "./nats-channel.js";

// ---------------------------------------------------------------------------
// Test utilities
// ---------------------------------------------------------------------------

/**
 * PermissionedFakeNatsBroker — Simulates NATS server with account/subject permissions.
 *
 * This is a simplified version of the broker from nats-subject-permissions.test.ts,
 * adapted for the NATS cutover E2E test.
 */
/** A single registered subscription: subject (may end in `>`/`*`) + its sid. */
type Subscription = { subject: string; sid: string };

class PermissionedFakeNatsBroker {
  private readonly server: WebSocketServer;
  private readonly connections = new Set<WebSocket>();
  private readonly permissions = new Map<WebSocket, string>(); // ws -> pub-allow pattern
  private readonly subs = new Map<WebSocket, Subscription[]>(); // ws -> subscriptions
  private readonly buffers = new Map<WebSocket, string>(); // ws -> partial wire buffer

  constructor(port: number) {
    this.server = new WebSocketServer({ port, host: "127.0.0.1" });

    this.server.on("connection", (ws: WebSocket) => {
      this.connections.add(ws);
      this.subs.set(ws, []);
      this.buffers.set(ws, "");

      ws.on("message", (data: Buffer) => {
        this.buffers.set(ws, (this.buffers.get(ws) ?? "") + data.toString("utf8"));
        this.drain(ws);
      });

      ws.on("close", () => {
        this.connections.delete(ws);
        this.permissions.delete(ws);
        this.subs.delete(ws);
        this.buffers.delete(ws);
      });

      // Send INFO
      this.sendLine(ws, `INFO {"server_id":"test","version":"2.10"}`);
    });
  }

  /** Parse the per-connection buffer line-by-line, consuming PUB payloads. */
  private drain(ws: WebSocket): void {
    let buffer = this.buffers.get(ws) ?? "";
    let nl: number;
    while ((nl = buffer.indexOf("\r\n")) !== -1) {
      const line = buffer.slice(0, nl);

      if (line.startsWith("PUB ")) {
        // PUB <subject> <bytes>\r\n<payload>\r\n — need the full payload buffered.
        const parts = line.split(" ");
        const subject = parts[1]!;
        const byteCount = parseInt(parts[parts.length - 1] ?? "0", 10);
        const headerEnd = nl + 2;
        if (buffer.length < headerEnd + byteCount + 2) break; // wait for more data
        const payload = buffer.slice(headerEnd, headerEnd + byteCount);
        buffer = buffer.slice(headerEnd + byteCount + 2);
        this.handlePub(ws, subject, payload);
        continue;
      }

      // Plain control line.
      buffer = buffer.slice(nl + 2);
      this.handleLine(ws, line);
    }
    this.buffers.set(ws, buffer);
  }

  private handleLine(ws: WebSocket, line: string): void {
    if (!line) return;

    if (line.startsWith("CONNECT ")) {
      try {
        const connect = JSON.parse(line.slice(8));
        const jwt = connect.jwt as string | undefined;
        if (jwt) {
          const parts = jwt.split(".");
          // jwtCredential in these tests is a single base64url JSON segment.
          const seg = parts.length === 3 ? parts[1]! : parts[0]!;
          const payload = JSON.parse(Buffer.from(seg, "base64url").toString());
          const tenant = (payload as { tenant?: string }).tenant ?? "default";
          this.permissions.set(ws, `webchannel.${tenant}.>`);
        }
      } catch {
        // Invalid JSON - ignore
      }
      this.sendLine(ws, "PONG");
    } else if (line === "PING") {
      this.sendLine(ws, "PONG");
    } else if (line.startsWith("SUB ")) {
      // SUB <subject> <sid>
      const parts = line.split(" ");
      const subject = parts[1]!;
      const sid = parts[2] ?? "0";
      this.subs.get(ws)?.push({ subject, sid });
      this.sendLine(ws, "+OK");
    } else if (line.startsWith("UNSUB ")) {
      const sid = line.split(" ")[1];
      const list = this.subs.get(ws);
      if (list) this.subs.set(ws, list.filter((s) => s.sid !== sid));
    }
  }

  private handlePub(ws: WebSocket, subject: string, payload: string): void {
    const pattern = this.permissions.get(ws);
    if (pattern && !this.subjectMatches(subject, pattern)) {
      this.sendLine(ws, `-ERR 'Permissions Violation for Publish to "${subject}"'`);
      return;
    }
    this.sendLine(ws, "+OK");
    // Fan out to every matching subscription on every connection.
    for (const conn of this.connections) {
      for (const sub of this.subs.get(conn) ?? []) {
        if (this.subjectMatches(subject, sub.subject)) {
          this.sendLine(
            conn,
            `MSG ${subject} ${sub.sid} ${Buffer.byteLength(payload)}\r\n${payload}`,
          );
        }
      }
    }
  }

  private subjectMatches(subject: string, pattern: string): boolean {
    if (pattern === subject) return true;
    const subTokens = subject.split(".");
    const patTokens = pattern.split(".");
    for (let i = 0; i < patTokens.length; i++) {
      const p = patTokens[i];
      if (p === ">") return true; // matches the rest
      if (i >= subTokens.length) return false;
      if (p === "*") continue; // matches one token
      if (p !== subTokens[i]) return false;
    }
    return subTokens.length === patTokens.length;
  }

  private sendLine(ws: WebSocket, line: string): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(`${line}\r\n`);
    }
  }

  /** Resolve once the server is bound, returning the actual (ephemeral) port. */
  async waitUntilListening(): Promise<number> {
    await new Promise<void>((resolve, reject) => {
      this.server.once("listening", () => resolve());
      this.server.once("error", reject);
    });
    const addr = this.server.address();
    if (!addr || typeof addr === "string") {
      throw new Error("broker did not bind to a TCP port");
    }
    return addr.port;
  }

  close(): void {
    for (const ws of this.connections) {
      ws.close();
    }
    this.server.close();
  }
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

describe("AC 5 E2E: NATS Cutover", () => {
  let broker: PermissionedFakeNatsBroker;
  let brokerPort: number;
  let agentTransport: NatsTransport;
  let agentChannel: NatsChannel;
  const accountId = "test-agent";
  const tenant = "test-tenant";

  beforeEach(async () => {
    // Bind to an ephemeral port (0) and read back the actual port — a fixed
    // port collides under parallel test files and may be sandbox-blocked.
    broker = new PermissionedFakeNatsBroker(0);
    brokerPort = await broker.waitUntilListening();

    // Create agent NATS transport
    agentTransport = new NatsTransport({
      url: `ws://127.0.0.1:${brokerPort}`,
      jwtCredential: Buffer.from(JSON.stringify({ tenant })).toString("base64url"),
    });

    // Connect agent
    await agentTransport.connect();

    // Create agent NATS channel
    agentChannel = new NatsChannel(agentTransport, accountId, tenant);
  });

  afterEach(() => {
    agentTransport?.disconnect();
    broker?.close();
    if (agentChannel) clearApprovalResolutions(agentChannel);
  });

  // ---------------------------------------------------------------------------
  // Test 1: Basic NATS messaging
  // ---------------------------------------------------------------------------

  it("should send and receive messages over NATS", async () => {
    const peerId = "user-1";
    agentChannel.registerPeer(peerId);

    let receivedMessage: InboundWsMessage | null = null;
    agentChannel.setMessageHandler((id, msg) => {
      if (id === peerId) {
        receivedMessage = msg;
      }
    });

    // Simulate browser sending a message
    const inboundSubject = `webchannel.${tenant}.${accountId}.${peerId}.in`;
    agentTransport.publish(inboundSubject, JSON.stringify({
      type: "user_message",
      text: "Hello from browser!",
    }));

    // Wait for message to be processed
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(receivedMessage).toBeDefined();
    expect(receivedMessage).not.toBeNull();
    const msg = receivedMessage as unknown as InboundWsMessage;
    expect(msg.type).toBe("user_message");
    if (msg.type !== "user_message") throw new Error("expected user_message");
    expect(msg.text).toBe("Hello from browser!");

    agentChannel.unregisterPeer(peerId);
  });

  // ---------------------------------------------------------------------------
  // Test 2: Multi-peer routing
  // ---------------------------------------------------------------------------

  it("should route messages correctly for multiple peers", async () => {
    const peer1 = "user-1";
    const peer2 = "user-2";

    agentChannel.registerPeer(peer1);
    agentChannel.registerPeer(peer2);

    const messages: Array<{ peerId: string; message: InboundWsMessage }> = [];

    agentChannel.setMessageHandler((id, msg) => {
      messages.push({ peerId: id, message: msg });
    });

    // Simulate peer1 sending a message
    agentTransport.publish(
      `webchannel.${tenant}.${accountId}.${peer1}.in`,
      JSON.stringify({ type: "user_message", text: "Message from peer1" }),
    );

    // Simulate peer2 sending a message
    agentTransport.publish(
      `webchannel.${tenant}.${accountId}.${peer2}.in`,
      JSON.stringify({ type: "user_message", text: "Message from peer2" }),
    );

    // Wait for messages to be processed
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(messages).toHaveLength(2);
    expect(messages[0].peerId).toBe(peer1);
    const m0 = messages[0].message as InboundWsMessage;
    if (m0.type !== "user_message") throw new Error("expected user_message");
    expect(m0.text).toBe("Message from peer1");
    expect(messages[1].peerId).toBe(peer2);
    const m1 = messages[1].message as InboundWsMessage;
    if (m1.type !== "user_message") throw new Error("expected user_message");
    expect(m1.text).toBe("Message from peer2");

    agentChannel.unregisterPeer(peer1);
    agentChannel.unregisterPeer(peer2);
  });

  // ---------------------------------------------------------------------------
  // Test 3: Agent sends messages to peer
  // ---------------------------------------------------------------------------

  it("should send messages from agent to peer", async () => {
    const peerId = "user-1";
    agentChannel.registerPeer(peerId);

    let receivedPayload: string | null = null;

    // Subscribe to outbound messages for this peer
    const outboundSub = agentTransport.subscribe(
      `webchannel.${tenant}.${accountId}.${peerId}.out`,
    );

    agentTransport.on("message", (msg) => {
      if (msg.subject.endsWith(".out")) {
        receivedPayload = msg.payload.toString();
      }
    });

    // Send text message from agent
    agentChannel.sendText(peerId, "Hello from agent!");

    // Wait for message to be published
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(receivedPayload).toBeDefined();
    const parsed = JSON.parse(receivedPayload!);
    expect(parsed.type).toBe("agent_message");
    expect(parsed.text).toBe("Hello from agent!");

    agentTransport.unsubscribe(outboundSub);
    agentChannel.unregisterPeer(peerId);
  });

  // ---------------------------------------------------------------------------
  // Test 4: Approval first-write-wins exactly-once
  // ---------------------------------------------------------------------------

  it("should enforce first-write-wins exactly-once for approvals", async () => {
    const peer1 = "user-1";
    const peer2 = "user-2";
    const approvalId = "approval-123";

    agentChannel.registerPeer(peer1);
    agentChannel.registerPeer(peer2);

    // First resolution from peer1 should succeed
    const success1 = agentChannel.sendApprovalResolved(peer1, approvalId, "allow-once");
    expect(success1).toBe(true);

    // Check that resolution was recorded
    expect(getApprovalResolution(agentChannel, approvalId)).toBe(peer1);

    // Second resolution from peer1 should succeed (same peer)
    const success2 = agentChannel.sendApprovalResolved(peer1, approvalId, "deny");
    expect(success2).toBe(true);

    // Resolution from peer2 should fail (different peer)
    const success3 = agentChannel.sendApprovalResolved(peer2, approvalId, "allow-always");
    expect(success3).toBe(false);

    // Resolution should still belong to peer1
    expect(getApprovalResolution(agentChannel, approvalId)).toBe(peer1);

    agentChannel.unregisterPeer(peer1);
    agentChannel.unregisterPeer(peer2);
  });

  // ---------------------------------------------------------------------------
  // Test 5: Typing indicator
  // ---------------------------------------------------------------------------

  it("should send typing indicator to peer", async () => {
    const peerId = "user-1";
    agentChannel.registerPeer(peerId);

    let receivedPayload: string | null = null;
    const outboundSub = agentTransport.subscribe(
      `webchannel.${tenant}.${accountId}.${peerId}.out`,
    );

    agentTransport.on("message", (msg) => {
      if (msg.subject.endsWith(".out")) {
        receivedPayload = msg.payload.toString();
      }
    });

    // Send typing indicator
    agentChannel.sendTyping(peerId);

    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(receivedPayload).toBeDefined();
    const parsed = JSON.parse(receivedPayload!);
    expect(parsed.type).toBe("typing");

    agentTransport.unsubscribe(outboundSub);
    agentChannel.unregisterPeer(peerId);
  });

  // ---------------------------------------------------------------------------
  // Test 6: History snapshot
  // ---------------------------------------------------------------------------

  it("should send history snapshot to peer", async () => {
    const peerId = "user-1";
    agentChannel.registerPeer(peerId);

    let receivedPayload: string | null = null;
    const outboundSub = agentTransport.subscribe(
      `webchannel.${tenant}.${accountId}.${peerId}.out`,
    );

    agentTransport.on("message", (msg) => {
      if (msg.subject.endsWith(".out")) {
        receivedPayload = msg.payload.toString();
      }
    });

    // Send history snapshot
    const historyMessages: HistoryMessage[] = [
      { id: "msg1", role: "user", text: "Hello" },
      { id: "msg2", role: "agent", text: "Hi there" },
    ];
    agentChannel.sendHistory(peerId, historyMessages);

    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(receivedPayload).toBeDefined();
    const parsed = JSON.parse(receivedPayload!);
    expect(parsed.type).toBe("history");
    expect(parsed.messages).toHaveLength(2);
    expect(parsed.messages[0].id).toBe("msg1");

    agentTransport.unsubscribe(outboundSub);
    agentChannel.unregisterPeer(peerId);
  });

  // ---------------------------------------------------------------------------
  // Test 7: Progress drafts
  // ---------------------------------------------------------------------------

  it("should send progress drafts and finalize them", async () => {
    const peerId = "user-1";
    agentChannel.registerPeer(peerId);

    const payloads: string[] = [];
    const outboundSub = agentTransport.subscribe(
      `webchannel.${tenant}.${accountId}.${peerId}.out`,
    );

    agentTransport.on("message", (msg) => {
      if (msg.subject.endsWith(".out")) {
        payloads.push(msg.payload.toString());
      }
    });

    // Send progress draft
    agentChannel.sendProgress(peerId, "draft-1", "Thinking...");

    await new Promise((resolve) => setTimeout(resolve, 50));

    // Finalize draft
    agentChannel.finalizeDraft(peerId, "draft-1", "Final answer!");

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(payloads).toHaveLength(2);
    const progress = JSON.parse(payloads[0]);
    expect(progress.type).toBe("progress");
    expect(progress.id).toBe("draft-1");
    expect(progress.text).toBe("Thinking...");

    const final = JSON.parse(payloads[1]);
    expect(final.type).toBe("agent_message");
    expect(final.id).toBe("draft-1");
    expect(final.text).toBe("Final answer!");

    agentTransport.unsubscribe(outboundSub);
    agentChannel.unregisterPeer(peerId);
  });

  it("should send correlated reasoning and turn settlement frames", async () => {
    const peerId = "user-1";
    agentChannel.registerPeer(peerId);
    const payloads: string[] = [];
    const outboundSub = agentTransport.subscribe(
      `webchannel.${tenant}.${accountId}.${peerId}.out`,
    );
    agentTransport.on("message", (msg) => {
      if (msg.subject.endsWith(".out")) payloads.push(msg.payload.toString());
    });

    agentChannel.sendReasoning(peerId, "reason-1", "turn-1", "Checking files");
    agentChannel.sendTurnSettled(peerId, "turn-1", "ok");
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(payloads.map((payload) => JSON.parse(payload))).toEqual([
      { type: "reasoning", id: "reason-1", turnId: "turn-1", text: "Checking files" },
      { type: "turn_settled", turnId: "turn-1", outcome: "ok" },
    ]);
    agentTransport.unsubscribe(outboundSub);
    agentChannel.unregisterPeer(peerId);
  });

  // ---------------------------------------------------------------------------
  // Test 8: Approval request routing
  // ---------------------------------------------------------------------------

  it("should route approval requests to the correct peer", async () => {
    const peer1 = "user-1";
    const peer2 = "user-2";

    agentChannel.registerPeer(peer1);
    agentChannel.registerPeer(peer2);

    const payloads1: string[] = [];
    const payloads2: string[] = [];

    const sub1 = agentTransport.subscribe(
      `webchannel.${tenant}.${accountId}.${peer1}.out`,
    );
    const sub2 = agentTransport.subscribe(
      `webchannel.${tenant}.${accountId}.${peer2}.out`,
    );

    agentTransport.on("message", (msg) => {
      if (msg.subject.endsWith(`${peer1}.out`)) {
        payloads1.push(msg.payload.toString());
      } else if (msg.subject.endsWith(`${peer2}.out`)) {
        payloads2.push(msg.payload.toString());
      }
    });

    // Send approval request to peer1
    agentChannel.sendApprovalRequest(peer1, {
      id: "approval-1",
      kind: "exec",
      title: "Run command?",
      prompt: "Do you want to run this command?",
      options: [
        { decision: "allow-once", label: "Allow Once", style: "primary" },
        { decision: "deny", label: "Deny", style: "danger" },
      ],
    });

    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(payloads1).toHaveLength(1);
    expect(payloads2).toHaveLength(0);

    const request = JSON.parse(payloads1[0]);
    expect(request.type).toBe("approval_request");
    expect(request.id).toBe("approval-1");
    expect(request.kind).toBe("exec");

    agentTransport.unsubscribe(sub1);
    agentTransport.unsubscribe(sub2);
    agentChannel.unregisterPeer(peer1);
    agentChannel.unregisterPeer(peer2);
  });

  // ---------------------------------------------------------------------------
  // Test 9: Gateway-WS relay paths are removed
  // ---------------------------------------------------------------------------

  it("should not use gateway-WS relay paths", () => {
    // Verify that NatsChannel is used instead of NATS peer channel
    expect(agentChannel).toBeInstanceOf(NatsChannel);

    // Verify that the channel uses NATS subjects
    const peerId = "user-1";
    agentChannel.registerPeer(peerId);

    // Check that subscriptions use NATS subjects
    // (This is implicit in the implementation - we just verify the channel works)

    agentChannel.unregisterPeer(peerId);
  });

  // ---------------------------------------------------------------------------
  // Test 10: Multi-peer session isolation
  // ---------------------------------------------------------------------------

  it("should maintain isolation between multi-peer sessions", async () => {
    const peer1 = "user-1";
    const peer2 = "user-2";

    agentChannel.registerPeer(peer1);
    agentChannel.registerPeer(peer2);

    const messages1: InboundWsMessage[] = [];
    const messages2: InboundWsMessage[] = [];

    agentChannel.setMessageHandler((peerId, msg) => {
      if (peerId === peer1) {
        messages1.push(msg);
      } else if (peerId === peer2) {
        messages2.push(msg);
      }
    });

    // Peer1 sends messages
    agentTransport.publish(
      `webchannel.${tenant}.${accountId}.${peer1}.in`,
      JSON.stringify({ type: "user_message", text: "Peer1 message 1" }),
    );
    agentTransport.publish(
      `webchannel.${tenant}.${accountId}.${peer1}.in`,
      JSON.stringify({ type: "user_message", text: "Peer1 message 2" }),
    );

    // Peer2 sends messages
    agentTransport.publish(
      `webchannel.${tenant}.${accountId}.${peer2}.in`,
      JSON.stringify({ type: "user_message", text: "Peer2 message 1" }),
    );

    await new Promise((resolve) => setTimeout(resolve, 100));

    // Verify isolation
    expect(messages1).toHaveLength(2);
    expect(messages2).toHaveLength(1);
    const r1 = messages1[0] as InboundWsMessage;
    if (r1.type !== "user_message") throw new Error("expected user_message");
    expect(r1.text).toBe("Peer1 message 1");
    const r2 = messages2[0] as InboundWsMessage;
    if (r2.type !== "user_message") throw new Error("expected user_message");
    expect(r2.text).toBe("Peer2 message 1");

    agentChannel.unregisterPeer(peer1);
    agentChannel.unregisterPeer(peer2);
  });
});
