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
 * - Plugin subscribes to webchannel.{tenant}.{accountId}.{peerId}.in
 * - Plugin publishes to webchannel.{tenant}.{accountId}.{peerId}.out
 * - Multi-peer support: each peerId gets its own subject pair
 * - Approval deduplication: approvalId-based first-write-wins exactly-once
 */

import type { NatsTransport, NatsMessage } from "./nats-transport.js";
import type { ApprovalDecision } from "./transport.js";
import { generateKeyPair } from "./e2e-crypto.js";
import type { KeyPair } from "./e2e-crypto.js";
import {
  deriveConversationKey,
  keyExchangeFrame,
  parseKeyExchange,
  sealEnvelope,
  openEnvelope,
} from "./e2e-session.js";

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
 * Encrypt-by-construction options for `NatsChannel`.
 *
 * When supplied, the channel runs in E2E-encrypted mode (the production NATS
 * entry's required mode): every peer must complete an X25519 handshake before
 * any message flows, all outbound is ChaCha20-Poly1305-sealed, all inbound is
 * decrypted, and the channel is FAIL-CLOSED — it never publishes or processes
 * plaintext on the relay. Omit to keep the legacy plaintext-JSON behaviour.
 */
export type NatsChannelCryptoOptions = {
  /**
   * Optional pre-generated agent X25519 key pair. One is generated per channel
   * instance when omitted (the common case).
   */
  keyPair?: KeyPair;
};

/**
 * NATS-based message channel for WebChannel.
 *
 * Replaces gateway-WS WebSocketServer with NATS pub/sub.
 * Each peer (browser session) gets their own subject pair.
 */
export class NatsChannel {
  private readonly transport: NatsTransport;
  private readonly accountId: string;
  private readonly tenant: string;

  // Per-peer subscriptions (peerId -> sid)
  private readonly peerSubscriptions = new Map<string, number>();

  // Per-peer approval deduplication (approvalId -> peerId who first resolved)
  private readonly approvalResolutions = new Map<string, string>();

  // ---- Encrypt-by-construction state (only populated in crypto mode) --------

  /** When true, the channel is E2E-encrypted and fail-closed (no plaintext). */
  private readonly encryptionRequired: boolean;
  /** Agent X25519 key pair used to answer per-peer handshakes (null = plaintext mode). */
  private readonly agentKeyPair: KeyPair | null;
  /** Per-peer established conversation keys (peerId -> 32-byte session key). */
  private readonly peerSessionKeys = new Map<string, Uint8Array>();
  /** Per-peer handshake subscriptions (peerId -> sid). */
  private readonly handshakeSubscriptions = new Map<string, number>();

  // Message handlers
  private onMessage?: (peerId: string, message: InboundWsMessage) => void;
  private onApprovalDecision?: (peerId: string, id: string, decision: ApprovalDecision) => void;
  private onLoadHistory?: (peerId: string, request: { before?: string; limit?: number }) => void;

  constructor(
    transport: NatsTransport,
    accountId: string,
    tenant: string,
    crypto?: NatsChannelCryptoOptions,
  ) {
    this.transport = transport;
    this.accountId = accountId;
    this.tenant = tenant;
    this.encryptionRequired = crypto != null;
    this.agentKeyPair = crypto ? (crypto.keyPair ?? generateKeyPair()) : null;

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

    // In crypto mode also subscribe to the peer's handshake subject so the
    // X25519 key exchange can complete before any message is sealed/opened.
    if (this.encryptionRequired) {
      const hsSubject = this.handshakeSubject(peerId);
      const hsSid = this.transport.subscribe(hsSubject);
      this.handshakeSubscriptions.set(peerId, hsSid);
    }
    console.log(`[nats-channel] Registered peer ${peerId}, subscribed to ${inboundSubject}`);
  }

  /**
   * Subscribe to the tenant/agent WILDCARD subjects so any peer is handled
   * without an explicit `registerPeer` (peers auto-register on their handshake).
   *
   * Used by the dev/open-NATS path where there is no HTTP registration step.
   * Per-peer routing still works because `handleNatsMessage` derives the peerId
   * from the subject, and the inbound allowlist gate still runs downstream.
   */
  subscribeWildcard(): void {
    const inWild = `webchannel.${this.tenant}.${this.accountId}.*.in`;
    this.transport.subscribe(inWild);
    if (this.encryptionRequired) {
      const hsWild = `webchannel.${this.tenant}.${this.accountId}.*.handshake`;
      this.transport.subscribe(hsWild);
    }
    console.log(`[nats-channel] Subscribed to wildcard ${inWild}`);
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
    const hsSid = this.handshakeSubscriptions.get(peerId);
    if (hsSid) {
      this.transport.unsubscribe(hsSid);
      this.handshakeSubscriptions.delete(peerId);
    }
    // Drop the session key so a reconnecting peer must re-handshake.
    this.peerSessionKeys.delete(peerId);
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
    return `webchannel.${this.tenant}.${this.accountId}.${peerId}.in`;
  }

  private outboundSubject(peerId: string): string {
    return `webchannel.${this.tenant}.${this.accountId}.${peerId}.out`;
  }

  private handshakeSubject(peerId: string): string {
    return `webchannel.${this.tenant}.${this.accountId}.${peerId}.handshake`;
  }

  private sendToPeer(peerId: string, payload: OutboundWsMessage): boolean {
    if (!this.transport.connected) {
      console.warn("[nats-channel] Transport not connected, cannot send");
      return false;
    }

    const subject = this.outboundSubject(peerId);

    try {
      if (this.encryptionRequired) {
        // Fail-closed: refuse to publish until the peer's handshake established a
        // session key. We NEVER fall back to plaintext on the relay.
        const key = this.peerSessionKeys.get(peerId);
        if (!key) {
          console.warn(
            `[nats-channel] Refusing to send to ${peerId}: no session key yet (fail-closed, no plaintext)`,
          );
          return false;
        }
        const wire = sealEnvelope(
          { accountId: this.accountId, tenant: this.tenant, sub: peerId },
          key,
          payload,
        );
        this.transport.publish(subject, wire);
        return true;
      }

      this.transport.publish(subject, JSON.stringify(payload));
      return true;
    } catch (err) {
      console.error(`[nats-channel] Failed to send to peer ${peerId}:`, err);
      return false;
    }
  }

  private handleNatsMessage(msg: NatsMessage): void {
    // Subject format: webchannel.{tenant}.{accountId}.{peerId}.{in|handshake}
    const parts = msg.subject.split(".");
    if (parts.length < 5) {
      console.warn(`[nats-channel] Invalid subject format: ${msg.subject}`);
      return;
    }

    const peerId = parts[3];
    const suffix = parts[parts.length - 1];

    if (this.encryptionRequired) {
      if (suffix === "handshake") {
        this.handleHandshake(msg, peerId);
        return;
      }
      this.handleEncryptedInbound(msg, peerId);
      return;
    }

    // Plaintext mode (legacy / gateway-parity): payload is JSON.
    try {
      const message = JSON.parse(msg.payload.toString()) as InboundWsMessage;
      this.dispatchInbound(peerId, message);
    } catch (err) {
      console.error(`[nats-channel] Failed to parse message from ${peerId}:`, err);
    }
  }

  /**
   * Crypto mode: answer a peer's X25519 handshake.
   *
   * Derives the conversation key from the browser's public key, stores it, and
   * publishes the agent's public key back on the same handshake subject.
   */
  private handleHandshake(msg: NatsMessage, peerId: string): void {
    if (!this.agentKeyPair) return;
    const browserPubKey = parseKeyExchange(msg.payload);
    if (!browserPubKey) {
      console.warn(`[nats-channel] Ignoring malformed handshake from ${peerId}`);
      return;
    }
    const sessionKey = deriveConversationKey(this.agentKeyPair.privateKey, browserPubKey);
    this.peerSessionKeys.set(peerId, sessionKey);
    this.transport.publish(
      this.handshakeSubject(peerId),
      keyExchangeFrame(this.agentKeyPair.publicKey),
    );
    console.log(`[nats-channel] Completed handshake with peer ${peerId}`);
  }

  /**
   * Crypto mode: decrypt an inbound envelope and dispatch it.
   *
   * Fail-closed: a message that arrives before the handshake completes (no
   * session key) or that fails to decrypt/parse is dropped — never processed as
   * plaintext.
   */
  private handleEncryptedInbound(msg: NatsMessage, peerId: string): void {
    const key = this.peerSessionKeys.get(peerId);
    if (!key) {
      console.warn(
        `[nats-channel] Dropping inbound from ${peerId}: no session key (handshake not completed)`,
      );
      return;
    }
    let message: InboundWsMessage;
    try {
      message = openEnvelope(msg.payload, key).message as InboundWsMessage;
    } catch (err) {
      console.warn(
        `[nats-channel] Dropping inbound from ${peerId}: decrypt/parse failed: ${String(err)}`,
      );
      return;
    }
    this.dispatchInbound(peerId, message);
  }

  /** Route a decoded inbound message to the registered handler. */
  private dispatchInbound(peerId: string, message: InboundWsMessage): void {
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
