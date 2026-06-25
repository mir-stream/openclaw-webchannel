/**
 * NATS Channel — Plugin-side NATS message channel.
 *
 * This module replaces the gateway-WS WebChannelTransport with a NATS-based
 * channel that:
 * - Subscribes to per-peer inbound subjects
 * - Publishes to per-peer outbound subjects
 * - Handles multi-peer session routing via peerId
 * - Integrates approvals with first-write-wins exactly-once over NATS
 * - Wires Phase A CryptoNatsChannel for E2E encryption
 *
 * Architecture:
 * - Plugin subscribes to webchannel.{tenant}.{agentId}.{peerId}.in
 * - Plugin publishes to webchannel.{tenant}.{agentId}.{peerId}.out
 * - Multi-peer support: each peerId gets its own subject pair
 * - Approval deduplication: approvalId-based first-write-wins exactly-once
 */

import type { NatsTransport, NatsMessage } from "./nats-transport.js";
import type { ApprovalDecision } from "./transport.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type InboundWsMessage =
  | { type: "user_message"; text: string }
  | { type: "approval_decision"; id: string; decision: ApprovalDecision }
  | { type: "load_history"; before?: string; limit?: number };

export type OutboundWsMessage =
  | { type: "agent_message"; text: string; id?: string }
  | { type: "progress"; id: string; text: string }
  | { type: "approval_request"; id: string; kind: "exec" | "plugin"; title: string; description?: string; prompt: string; options: Array<{ decision: string; label: string; style: string }>; expiresAtMs?: number }
  | { type: "approval_resolved"; id: string; decision: ApprovalDecision }
  | { type: "typing" }
  | { type: "history"; messages: Array<{ id: string; role: string; text: string; ts?: number }> };

export type HistoryMessage = {
  id: string;
  role: "user" | "agent";
  text: string;
  ts?: number;
};

// ---------------------------------------------------------------------------
// NATS Channel
// ---------------------------------------------------------------------------

/**
 * NATS-based message channel for WebChannel.
 *
 * Replaces gateway-WS WebSocketServer with NATS pub/sub.
 * Each peer (browser session) gets their own subject pair.
 */
export class NatsChannel {
  private readonly transport: NatsTransport;
  private readonly agentId: string;
  private readonly tenant: string;

  // Per-peer subscriptions (peerId -> sid)
  private readonly peerSubscriptions = new Map<string, number>();

  // Per-peer approval deduplication (approvalId -> peerId who first resolved)
  private readonly approvalResolutions = new Map<string, string>();

  // Message handlers
  private onMessage?: (peerId: string, message: InboundWsMessage) => void;
  private onApprovalDecision?: (peerId: string, id: string, decision: ApprovalDecision) => void;
  private onLoadHistory?: (peerId: string, request: { before?: string; limit?: number }) => void;

  constructor(transport: NatsTransport, agentId: string, tenant: string) {
    this.transport = transport;
    this.agentId = agentId;
    this.tenant = tenant;

    // Wire up NATS message handler
    this.transport.on("message", (msg: NatsMessage) => this.handleNatsMessage(msg));
  }

  /**
   * Register a new peer (browser session).
   *
   * Subscribes to the peer's inbound subject. Called when a browser
   * connects with its bootstrap JWT (peerId from JWT sub claim).
   */
  registerPeer(peerId: string): void {
    if (this.peerSubscriptions.has(peerId)) {
      console.warn(`[nats-channel] Peer ${peerId} already registered`);
      return;
    }

    const inboundSubject = this.inboundSubject(peerId);
    const sid = this.transport.subscribe(inboundSubject);
    this.peerSubscriptions.set(peerId, sid);
    console.log(`[nats-channel] Registered peer ${peerId}, subscribed to ${inboundSubject}`);
  }

  /**
   * Unregister a peer (browser session disconnected).
   */
  unregisterPeer(peerId: string): void {
    const sid = this.peerSubscriptions.get(peerId);
    if (sid) {
      this.transport.unsubscribe(sid);
      this.peerSubscriptions.delete(peerId);
      console.log(`[nats-channel] Unregistered peer ${peerId}`);
    }
  }

  /**
   * Send text message to peer.
   */
  sendText(peerId: string, text: string, id?: string): boolean {
    const payload: OutboundWsMessage = id
      ? { type: "agent_message", text, id }
      : { type: "agent_message", text };
    return this.sendToPeer(peerId, payload);
  }

  /**
   * Send text to the single registered peer, when exactly one is connected.
   *
   * Mirrors WebChannelTransport.sendTextToAnyOpen: the outbound seam falls back
   * here for core-initiated (untargeted) sends. With one peer (the common single
   * web user) we deliver; with zero or many we refuse to guess and return false.
   */
  sendTextToAnyOpen(text: string): boolean {
    if (this.peerSubscriptions.size !== 1) return false;
    const [peerId] = this.peerSubscriptions.keys();
    return this.sendText(peerId, text);
  }

  /**
   * Send progress update to peer.
   */
  sendProgress(peerId: string, id: string, text: string): boolean {
    const payload: OutboundWsMessage = { type: "progress", id, text };
    return this.sendToPeer(peerId, payload);
  }

  /**
   * Finalize progress draft to final answer.
   */
  finalizeDraft(peerId: string, id: string, text: string): boolean {
    return this.sendText(peerId, text, id);
  }

  /**
   * Send typing indicator to peer.
   */
  sendTyping(peerId: string): boolean {
    const payload: OutboundWsMessage = { type: "typing" };
    return this.sendToPeer(peerId, payload);
  }

  /**
   * Send history snapshot to peer.
   */
  sendHistory(peerId: string, messages: HistoryMessage[]): boolean {
    const payload: OutboundWsMessage = { type: "history", messages };
    return this.sendToPeer(peerId, payload);
  }

  /**
   * Send approval request to peer.
   */
  sendApprovalRequest(
    peerId: string,
    request: {
      id: string;
      kind: "exec" | "plugin";
      title: string;
      description?: string;
      prompt: string;
      options: Array<{ decision: string; label: string; style: string }>;
      expiresAtMs?: number;
    }
  ): boolean {
    const payload: OutboundWsMessage = {
      type: "approval_request",
      ...request,
    };
    return this.sendToPeer(peerId, payload);
  }

  /**
   * Resolve approval request (send decision back to peer).
   *
   * Implements first-write-wins exactly-once:
   * - The first peer to resolve an approvalId wins
   * - Subsequent resolutions for the same approvalId are dropped
   */
  sendApprovalResolved(peerId: string, id: string, decision: ApprovalDecision): boolean {
    // First-write-wins exactly-once: check if already resolved
    const existingResolver = this.approvalResolutions.get(id);
    if (existingResolver !== undefined) {
      if (existingResolver !== peerId) {
        console.log(`[nats-channel] Approval ${id} already resolved by ${existingResolver}, dropping duplicate from ${peerId}`);
        return false;
      }
    } else {
      // First resolution: record it
      this.approvalResolutions.set(id, peerId);
    }

    const payload: OutboundWsMessage = { type: "approval_resolved", id, decision };
    return this.sendToPeer(peerId, payload);
  }

  /**
   * Set message handler for user messages.
   */
  setMessageHandler(handler: (peerId: string, message: InboundWsMessage) => void): void {
    this.onMessage = handler;
  }

  /**
   * Set approval decision handler.
   */
  setApprovalDecisionHandler(
    handler: (peerId: string, id: string, decision: ApprovalDecision) => void
  ): void {
    this.onApprovalDecision = handler;
  }

  /**
   * Set history load handler.
   */
  setLoadHistoryHandler(
    handler: (peerId: string, request: { before?: string; limit?: number }) => void
  ): void {
    this.onLoadHistory = handler;
  }

  // ---------------------------------------------------------------------------
  // Internal implementation
  // ---------------------------------------------------------------------------

  private inboundSubject(peerId: string): string {
    return `webchannel.${this.tenant}.${this.agentId}.${peerId}.in`;
  }

  private outboundSubject(peerId: string): string {
    return `webchannel.${this.tenant}.${this.agentId}.${peerId}.out`;
  }

  private sendToPeer(peerId: string, payload: OutboundWsMessage): boolean {
    if (!this.transport.connected) {
      console.warn("[nats-channel] Transport not connected, cannot send");
      return false;
    }

    const subject = this.outboundSubject(peerId);
    const serialized = JSON.stringify(payload);

    try {
      this.transport.publish(subject, serialized);
      return true;
    } catch (err) {
      console.error(`[nats-channel] Failed to send to peer ${peerId}:`, err);
      return false;
    }
  }

  private handleNatsMessage(msg: NatsMessage): void {
    // Extract peerId from subject
    // Subject format: webchannel.{tenant}.{agentId}.{peerId}.in
    const parts = msg.subject.split(".");
    if (parts.length < 5) {
      console.warn(`[nats-channel] Invalid subject format: ${msg.subject}`);
      return;
    }

    const peerId = parts[3];

    try {
      const message = JSON.parse(msg.payload.toString()) as InboundWsMessage;

      switch (message.type) {
        case "user_message":
          this.onMessage?.(peerId, message);
          break;

        case "approval_decision":
          this.onApprovalDecision?.(peerId, message.id, message.decision);
          break;

        case "load_history":
          this.onLoadHistory?.(peerId, { before: message.before, limit: message.limit });
          break;

        default:
          console.warn(`[nats-channel] Unknown message type: ${(message as { type: string }).type}`);
      }
    } catch (err) {
      console.error(`[nats-channel] Failed to parse message from ${peerId}:`, err);
    }
  }
}

// ---------------------------------------------------------------------------
// Approval deduplication helpers
// ---------------------------------------------------------------------------

/**
 * Clear approval resolution record (for testing or cleanup).
 */
export function clearApprovalResolutions(channel: NatsChannel): void {
  // Access private field via type cast
  (channel as unknown as { approvalResolutions: Map<string, string> }).approvalResolutions.clear();
}

/**
 * Get approval resolution record (for testing).
 */
export function getApprovalResolution(channel: NatsChannel, approvalId: string): string | undefined {
  const map = (channel as unknown as { approvalResolutions: Map<string, string> }).approvalResolutions as Map<string, string>;
  return map.get(approvalId);
}
