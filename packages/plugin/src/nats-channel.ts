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
import type { ConversationKeyStore } from "./conversation-key-store.js";
import { wrapConversationKey } from "./late-join-decryptor.js";
import type { WrappedConversationKey } from "./late-join-decryptor.js";
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

/**
 * Plain byte-equality for two locally-derived session keys. NOT constant-time —
 * this only decides whether a handshake produced a NEW session (fire the initial
 * snapshot) or a duplicate (skip it); both operands are values the agent computed
 * itself, so there is no secret to leak by timing.
 */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

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
  /**
   * Phase 6 (multi-device): agent-owned per-peerId conversation-key store.
   *
   * When supplied, the channel runs the REGISTER-admission key model:
   * `registerPeer` loads/creates the peer's stable key K from this store (so a
   * second device of the same user never overwrites the first one's key), and
   * the per-device X25519 `.handshake` negotiation is DISABLED — devices
   * receive K wrapped to their JWT-cnf pubkey via the register HTTP response
   * (`wrapConversationKeyForDevice`) instead. Omit for auto-admission accounts,
   * which keep the legacy handshake (F5 decision — see PHASE6_MULTIDEVICE_PLAN §8).
   */
  keyStore?: ConversationKeyStore;
};

/**
 * S2: optional memory ceilings, decoupled from crypto mode so a caller can tune
 * the bounds (or a test can exercise them) without turning on encryption.
 */
export type NatsChannelLimits = {
  /**
   * Upper bound on concurrently-tracked peers before the oldest-registered one
   * is evicted (default 10_000). The NATS path has no disconnect signal, so
   * without a cap peer subscriptions/session keys grow with churn. Real
   * single-tenant load stays far below this.
   */
  maxPeers?: number;
  /**
   * Upper bound on remembered approval resolutions before the oldest is evicted
   * (default 10_000). Resolutions are additive per approval and were never
   * cleaned, so this map was the clearest unbounded leak.
   */
  maxApprovalResolutions?: number;
};

/** S2 defaults — high enough that normal operation never evicts. */
const DEFAULT_MAX_PEERS = 10_000;
const DEFAULT_MAX_APPROVAL_RESOLUTIONS = 10_000;

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

  /**
   * S2: unconditional memory bounds. The NATS path has no peer-disconnect
   * signal, so these maps would otherwise grow monotonically with peer/session
   * churn on a long-lived gateway. We cap each by size and evict the OLDEST
   * entry (Map is insertion-ordered, so the oldest is the most likely to be
   * already-disconnected) when a cap is exceeded. Under normal load (few peers,
   * approvals resolved and forgotten) the caps NEVER trigger, so there is no
   * behavior change for real operation — the bound only engages under genuine
   * unbounded growth (churn or abuse), turning a slow OOM into a fixed ceiling.
   */
  private readonly maxPeers: number;
  private readonly maxApprovalResolutions: number;

  // ---- Encrypt-by-construction state (only populated in crypto mode) --------

  /** When true, the channel is E2E-encrypted and fail-closed (no plaintext). */
  private readonly encryptionRequired: boolean;
  /** Agent X25519 key pair used to answer per-peer handshakes (null = plaintext mode). */
  private readonly agentKeyPair: KeyPair | null;
  /**
   * Phase 6: agent-owned conversation-key store (register-admission accounts
   * only; null = legacy handshake key model). See NatsChannelCryptoOptions.
   */
  private readonly keyStore: ConversationKeyStore | null;
  /** Per-peer established conversation keys (peerId -> 32-byte session key). */
  private readonly peerSessionKeys = new Map<string, Uint8Array>();
  /** Per-peer handshake subscriptions (peerId -> sid). */
  private readonly handshakeSubscriptions = new Map<string, number>();

  // Message handlers
  private onMessage?: (peerId: string, message: InboundWsMessage) => void;
  private onApprovalDecision?: (peerId: string, id: string, decision: ApprovalDecision) => void;
  private onLoadHistory?: (peerId: string, request: { before?: string; limit?: number }) => void;
  private onHandshakeComplete?: (peerId: string) => void;
  /**
   * Register-hop admission over NATS (replaces the deleted HTTP register routes).
   * Fired for a plaintext JSON request on `…{peerId}.register`; the handler runs
   * the full JWT + Proof-of-Possession verify and replies via the `reply`
   * callback (published to the request's NATS reply-to inbox). See
   * `subscribeRegister` and `handleRegister`.
   */
  private onRegisterRequest?: (
    peerId: string,
    payload: string,
    reply: (response: string) => void,
  ) => void;

  constructor(
    transport: NatsTransport,
    accountId: string,
    tenant: string,
    crypto?: NatsChannelCryptoOptions,
    limits?: NatsChannelLimits,
  ) {
    this.transport = transport;
    this.accountId = accountId;
    this.tenant = tenant;
    this.encryptionRequired = crypto != null;
    this.agentKeyPair = crypto ? (crypto.keyPair ?? generateKeyPair()) : null;
    this.keyStore = crypto?.keyStore ?? null;
    this.maxPeers = limits?.maxPeers ?? DEFAULT_MAX_PEERS;
    this.maxApprovalResolutions =
      limits?.maxApprovalResolutions ?? DEFAULT_MAX_APPROVAL_RESOLUTIONS;

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
    // Phase 6 (keyStore mode): establish the peer's STABLE conversation key K
    // from the agent-owned store — load if known, generate-once if new. Runs
    // even for an already-registered peer so a lost in-memory key (never
    // expected) self-heals on re-register. Crucially this SETS but never
    // re-derives: a second device registering the same peerId leaves K
    // untouched, which is the whole multi-device fix.
    if (this.encryptionRequired && this.keyStore) {
      this.peerSessionKeys.set(peerId, this.keyStore.getOrCreate(peerId));
    }
    if (this.peerSubscriptions.has(peerId)) {
      console.warn(`[nats-channel] Peer ${peerId} already registered`);
      return;
    }

    // S2: enforce the peer ceiling BEFORE adding. Evict the oldest-registered
    // peer(s) — most likely already disconnected (no NATS leave signal) — so a
    // churn/abuse stream can't grow the peer maps without bound. Logged, never
    // silent. NOTE: if the evicted peer is in fact still live, this DROPS its
    // session until it reconnects (the browser only re-registers in onConnected,
    // and the client heartbeat keeps a healthy socket from reconnecting) — an
    // acceptable last-resort under abuse-level churn, not self-healing. The 10k
    // default keeps this off the path for real single-tenant load.
    while (this.peerSubscriptions.size >= this.maxPeers) {
      const oldest = this.peerSubscriptions.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      console.warn(
        `[nats-channel] peer cap ${this.maxPeers} reached; evicting oldest peer ${oldest}`,
      );
      this.unregisterPeer(oldest);
    }

    const inboundSubject = this.inboundSubject(peerId);
    const sid = this.transport.subscribe(inboundSubject);
    this.peerSubscriptions.set(peerId, sid);

    // Legacy crypto mode (no keyStore) also subscribes the peer's handshake
    // subject so the X25519 key exchange can complete before any message is
    // sealed/opened. In keyStore mode there is NO handshake: K was established
    // from the store above and is wrap-delivered in the register HTTP response,
    // so the register path must never answer handshake frames (F5 divergence).
    if (this.encryptionRequired && !this.keyStore) {
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
    // keyStore mode never listens for handshakes (F5: handshake is the AUTO
    // path's key model; a keyStore channel delivers K via the register hop).
    if (this.encryptionRequired && !this.keyStore) {
      const hsWild = `webchannel.${this.tenant}.${this.accountId}.*.handshake`;
      this.transport.subscribe(hsWild);
    }
    console.log(`[nats-channel] Subscribed to wildcard ${inWild}`);
  }

  /**
   * Subscribe to the register-admission wildcard `webchannel.{tenant}.{accountId}.*.register`.
   *
   * This is the always-on NATS analogue of the deleted HTTP register routes:
   * register-hop accounts call it at channel start so a browser can drive the
   * JWT + Proof-of-Possession admission round-trip over NATS request/reply
   * (browser publishes with a reply-to inbox; `handleRegister` replies there).
   * The subject namespace already encodes tenant+accountId, so the request is
   * pinned to THIS account — identity still comes only from the verified JWT.
   */
  subscribeRegister(): void {
    const regWild = `webchannel.${this.tenant}.${this.accountId}.*.register`;
    this.transport.subscribe(regWild);
    console.log(`[nats-channel] Subscribed to register wildcard ${regWild}`);
  }

  /**
   * Set the register-request handler (register-hop admission over NATS).
   *
   * The handler receives the subject's peerId segment, the raw request payload
   * (plaintext JSON — the browser has no session key yet), and a `reply` callback
   * that publishes the response to the request's NATS reply-to inbox. Identity
   * MUST be derived from the verified JWT inside the handler, never from the
   * subject peerId (see the register handler's subject-spoofing guard).
   */
  setRegisterRequestHandler(
    handler: (peerId: string, payload: string, reply: (response: string) => void) => void,
  ): void {
    this.onRegisterRequest = handler;
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
    // Drop the in-memory session key: a reconnecting peer must re-handshake
    // (legacy mode) or re-register, which reloads the STABLE key K from the
    // keyStore (Phase 6 mode — the persisted K itself is never dropped here).
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
      // S2: bound the dedup map. It only needs to remember an id long enough to
      // drop near-simultaneous duplicate resolutions; evicting the oldest once
      // over the cap keeps memory fixed without weakening that window.
      while (this.approvalResolutions.size > this.maxApprovalResolutions) {
        const oldest = this.approvalResolutions.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        this.approvalResolutions.delete(oldest);
      }
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

  /**
   * Set the handshake-complete handler.
   *
   * Fires once the per-peer E2E session key is established (see
   * `handleHandshake`) — the earliest point at which `sendHistory` can actually
   * encrypt a frame to this peer. The initial history snapshot MUST be sent from
   * here, not from the register hop: registration completes before the crypto
   * handshake, so a snapshot sent at register time is fail-closed dropped ("no
   * session key yet").
   */
  setHandshakeCompleteHandler(handler: (peerId: string) => void): void {
    this.onHandshakeComplete = handler;
  }

  /**
   * Phase 6 (keyStore mode): wrap the peer's conversation key K to a specific
   * device's X25519 public key for delivery in the register HTTP response.
   *
   * Must be called AFTER `registerPeer(peerId)` (which establishes K). The
   * wrap targets exactly the key presented in THIS request's verified JWT cnf
   * claim — never a stored/pinned lookup, so two devices of the same peerId
   * can never receive a wrap meant for the other (audit F2).
   *
   * @param peerId - registered peer whose K to wrap.
   * @param devicePublicKey - raw 32-byte X25519 device public key (from cnf.jwk).
   * @returns the wrapped key, or `null` when the channel is not in keyStore
   *          mode or the peer has no established key (caller treats as a
   *          server-side registration fault).
   */
  wrapConversationKeyForDevice(
    peerId: string,
    devicePublicKey: Uint8Array,
  ): WrappedConversationKey | null {
    if (!this.encryptionRequired || !this.keyStore) return null;
    if (devicePublicKey.length !== 32) {
      throw new Error(
        `webchannel: device public key must be 32 bytes (got ${devicePublicKey.length})`,
      );
    }
    const key = this.peerSessionKeys.get(peerId);
    if (!key) return null;
    return wrapConversationKey(key, devicePublicKey);
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

    // Register-hop admission (plaintext JSON, no session key yet) is handled
    // before the crypto branch: the browser can't encrypt until it has K, and
    // K is delivered BY this round-trip. Routing is by subject; identity comes
    // from the verified JWT inside the handler.
    if (suffix === "register") {
      this.handleRegister(msg, peerId);
      return;
    }

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
   * Register-hop admission over NATS: hand the plaintext request to the
   * registered handler and route its reply to the NATS reply-to inbox.
   *
   * The reply is published to `msg.replyTo` (the browser's request-scoped inbox
   * subject), never to a peerId-derived subject, so a spoofed subject peerId can
   * never redirect a reply. A request with no reply-to (e.g. fire-and-forget
   * `unregister`) simply gets a no-op reply callback.
   */
  private handleRegister(msg: NatsMessage, peerId: string): void {
    if (!this.onRegisterRequest) return;
    const replyTo = msg.replyTo;
    const reply = (response: string): void => {
      if (replyTo) this.transport.publish(replyTo, response);
    };
    this.onRegisterRequest(peerId, msg.payload.toString(), reply);
  }

  /**
   * Crypto mode: answer a peer's X25519 handshake.
   *
   * Derives the conversation key from the browser's public key, stores it, and
   * publishes the agent's public key back on the same handshake subject.
   */
  private handleHandshake(msg: NatsMessage, peerId: string): void {
    if (!this.agentKeyPair) return;
    // Phase 6 defense-in-depth: a keyStore-mode channel never subscribes a
    // handshake subject, so no frame should arrive here — but if one does
    // (misuse/misconfig), REFUSE it. Answering would let a relay-level writer
    // overwrite the agent-owned stable key K with an attacker-derived one.
    if (this.keyStore) {
      console.warn(
        `[nats-channel] Dropping handshake from ${peerId}: channel uses the ` +
          `register-delivered conversation key (keyStore mode, no handshake)`,
      );
      return;
    }
    const browserPubKey = parseKeyExchange(msg.payload);
    if (!browserPubKey) {
      console.warn(`[nats-channel] Ignoring malformed handshake from ${peerId}`);
      return;
    }
    const sessionKey = deriveConversationKey(this.agentKeyPair.privateKey, browserPubKey);
    // Capture the prior key BEFORE we overwrite it, to decide whether this is a
    // NEW session (fresh key) or a duplicate handshake (client republished the
    // same key_exchange — e.g. the browser's bounded handshake retry when the
    // first frame was dropped, or a relay RTT > the retry interval). Only a new
    // session should trigger the initial history snapshot below.
    const prevKey = this.peerSessionKeys.get(peerId);
    // S2: this is the ONLY writer of peerSessionKeys and — on the wildcard /
    // `admission:"auto"` path (the live gateway's mode), where peers never call
    // registerPeer — the only per-peer growth vector at all. So the session-key
    // ceiling must be enforced HERE, not just in registerPeer (which the
    // wildcard path bypasses). Evict the oldest peer when a NEW peerId would
    // exceed the cap; a returning peer simply re-handshakes.
    if (!this.peerSessionKeys.has(peerId)) {
      while (this.peerSessionKeys.size >= this.maxPeers) {
        const oldest = this.peerSessionKeys.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        console.warn(
          `[nats-channel] session-key cap ${this.maxPeers} reached; evicting oldest peer ${oldest}`,
        );
        // Registered-mode peer → full teardown (also unsubscribes); wildcard-mode
        // peer has no subscription, so just drop its key.
        if (this.peerSubscriptions.has(oldest)) {
          this.unregisterPeer(oldest);
        } else {
          this.peerSessionKeys.delete(oldest);
        }
      }
    }
    this.peerSessionKeys.set(peerId, sessionKey);
    this.transport.publish(
      this.handshakeSubject(peerId),
      keyExchangeFrame(this.agentKeyPair.publicKey),
    );
    console.log(`[nats-channel] Completed handshake with peer ${peerId}`);
    // Session key is now established → the initial history snapshot can finally
    // be encrypted to this peer. (Sent from here, not the register hop, which
    // runs before the handshake — see setHandshakeCompleteHandler.) TWO guards:
    //  1. REGISTERED peers only (`peerSubscriptions` — the register-hop / PoP-
    //     authenticated path). The wildcard / `admission:"auto"` path never calls
    //     registerPeer, so a peer there is unauthenticated (any tenant-creds holder
    //     can handshake for any peerId); it must NOT receive stored history.
    //  2. NEW session key only — a duplicate handshake (client retry / RTT race)
    //     derives the SAME key, so we skip re-sending the whole backlog. A genuine
    //     reconnect brings a fresh browser key → new session → re-hydrates.
    const isNewSession = !prevKey || !bytesEqual(prevKey, sessionKey);
    if (this.peerSubscriptions.has(peerId) && isNewSession) {
      this.onHandshakeComplete?.(peerId);
    }
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
