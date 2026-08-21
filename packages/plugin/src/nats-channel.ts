/**
 * NATS Channel — Plugin-side NATS message channel.
 *
 * This module replaces the gateway-WS NATS peer channel with a NATS-based
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

import { inspect } from "node:util";
import type { NatsTransport, NatsMessage } from "./nats-transport.js";
import type { ApprovalDecision, ApprovalRequestPayload, HistoryMessage, InboundWsMessage, OutboundWsMessage, WebChannelPeerChannel } from "./channel-contract.js";
import type { KeyPair } from "./e2e-crypto.js";
import type { ConversationKeyStore } from "./conversation-key-store.js";
import { wrapConversationKey } from "./late-join-decryptor.js";
import type { WrappedConversationKey } from "./late-join-decryptor.js";
import { sealEnvelope, openEnvelope } from "./e2e-session.js";
import { isValidSubjectToken } from "./subject-token.js";
import type { CommandCatalogEntry } from "./commands-catalog.js";
import { createIngressResultChunkWriter } from "./ingress-result-chunks.js";
import type { IngressResultFrame } from "./ingress-result-chunks.js";
import { logSafe } from "./log-safe.js";

/** Preserve caught-error detail without changing primitive thrown-value rendering. */
function formatCaughtDiagnostic(value: unknown): unknown {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") {
    return value;
  }
  try {
    return inspect(value, {
      breakLength: Number.POSITIVE_INFINITY,
      colors: false,
      compact: true,
      customInspect: false,
      depth: 5,
      getters: false,
      maxArrayLength: 50,
      maxStringLength: 8_192,
    });
  } catch {
    return "<uninspectable>";
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type { HistoryMessage, InboundWsMessage, OutboundWsMessage } from "./channel-contract.js";

// ---------------------------------------------------------------------------
// NATS Channel
// ---------------------------------------------------------------------------

/**
 * Encrypt-by-construction options for `NatsChannel`.
 *
 * When supplied, the channel runs in E2E-encrypted mode (the production NATS
 * entry's required mode): every peer must complete authenticated registration
 * before any message flows, all outbound is ChaCha20-Poly1305-sealed, all inbound is
 * decrypted, and the channel is FAIL-CLOSED — it never publishes or processes
 * plaintext on the relay. Omit to keep the legacy plaintext-JSON behaviour.
 */
export type NatsChannelCryptoOptions = {
  /**
   * Agent-owned per-peerId conversation-key store.
   *
   * The channel runs the REGISTER-admission key model: `registerPeer`
   * loads/creates the peer's stable key K from this store (so a second device of
   * the same user never overwrites the first one's key), and devices receive K
   * wrapped to their JWT-cnf pubkey via the register response — there is no
   * per-device handshake (the unauthenticated X25519 negotiation was removed).
   */
  keyStore?: ConversationKeyStore;
  /**
   * F2 — the agent's SaaS-ATTESTED static X25519 identity key pair, loaded from
   * the enrolled per-account `credentials.json` (`enrollment-client.ts` persists
   * it; the browser pins its PUBLIC half via the SaaS bootstrap response). Used
   * ONLY by `wrapConversationKeyForDevice` to wrap K static-static so the browser
   * can authenticate that K came from the genuine agent (closes the register-hop
   * MITM). REQUIRED whenever `keyStore` is set — the channel refuses to construct
   * a keyStore channel without it (fail-closed).
   */
  identityKeyPair?: KeyPair;
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
  /**
   * F4 anti-replay: half-width of the accepted inbound `ts` skew window, in ms
   * (default 10 min). A sealed frame whose authenticated `ts` (browser wall
   * clock) is more than this before/after the agent's `now` is dropped as a
   * replay-or-skew. Generous by design — the messageId LRU is the PRIMARY
   * defense; this window is the coarse secondary bound that also caps how far
   * back the LRU must remember (see `maxSeenMessageIdsPerPeer`).
   */
  replayWindowMs?: number;
  /**
   * F4 anti-replay: per-peer cap on remembered seen-messageIds before the
   * oldest is LRU-evicted (default 2_000). Strictly per-peer so one peer's
   * churn can never evict another peer's window. Safe to evict the oldest: a
   * genuine replay of an evicted (old) messageId is re-caught by the `ts`
   * window, which by construction only admits frames newer than the window.
   */
  maxSeenMessageIdsPerPeer?: number;
};

/** S2 defaults — high enough that normal operation never evicts. */
const DEFAULT_MAX_PEERS = 10_000;
const DEFAULT_MAX_APPROVAL_RESOLUTIONS = 10_000;
/**
 * F4 defaults. The ±10-min window tolerates a badly-skewed browser clock while
 * still bounding replay memory; 2_000 remembered ids/peer covers a very busy
 * conversation within that window without unbounded growth.
 */
const DEFAULT_REPLAY_WINDOW_MS = 10 * 60 * 1_000;
const DEFAULT_MAX_SEEN_MESSAGE_IDS_PER_PEER = 2_000;
const RESULT_LIMIT_WARNING_INTERVAL_MS = 60_000;

/**
 * NATS-based message channel for WebChannel.
 *
 * Replaces gateway-WS WebSocketServer with NATS pub/sub.
 * Each peer (browser session) gets their own subject pair.
 */
export class NatsChannel implements WebChannelPeerChannel {
  private readonly transport: NatsTransport;
  private readonly accountId: string;
  private readonly tenant: string;
  private disposed = false;
  private registerSid: number | undefined;
  private readonly transportMessageListener: (msg: NatsMessage) => void;

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

  /**
   * F4 anti-replay state. The untrusted relay can re-publish a captured sealed
   * `user_message` verbatim; it decrypts under the same per-peer key with an
   * unchanged AAD, so nothing downstream distinguishes it from a genuine send —
   * the agent would RE-RUN the turn (duplicate tool calls / side effects / cost).
   * We enforce freshness on the AUTHENTICATED envelope fields (`messageId`,
   * `ts`, both inside the AEAD-bound AAD, so a relay can't forge them):
   *  - a per-peer sliding window of seen messageIds (PRIMARY defense), and
   *  - a generous ±`replayWindowMs` bound on `ts` (SECONDARY — tolerates a
   *    skewed browser clock, and caps how far back the LRU must remember).
   * NOTE: this cache is IN-MEMORY. A replay that arrives AFTER an agent restart
   * (empty cache) is only stopped by the `ts` window — replay within that window
   * across a restart is the accepted residual, bounded to `replayWindowMs`.
   * Keyed per-peer (peerId -> insertion-ordered messageId -> ts) so eviction is
   * strictly local; cleaned up alongside `peerSessionKeys`.
   */
  private readonly replayWindowMs: number;
  private readonly maxSeenMessageIdsPerPeer: number;
  private readonly seenMessageIds = new Map<string, Map<string, number>>();

  /**
   * P0-6: whether `sendTyping(...)` may emit a `typing` frame. Defaults enabled
   * so the "Bot is typing…" affordance works out of the box; an operator
   * disables it per-account via `capabilities.typing = "off"`. Toggled once at
   * channel start (index-nats) from the account's RESOLVED config — unlike the
   * legacy WS gate (`transport.ts`), which reads the channel-level flat section,
   * because each `NatsChannel` IS a single account's channel (가-1 Cycle 2).
   * Previously ungated on NATS, so `typing: "off"` was silently ignored.
   */
  private typingEnabled = true;

  // ---- Encrypt-by-construction state (only populated in crypto mode) --------

  /** When true, the channel is E2E-encrypted and fail-closed (no plaintext). */
  private readonly encryptionRequired: boolean;
  /**
   * Phase 6: agent-owned conversation-key store. Non-null on every encrypted
   * channel (the constructor requires it when `encryptionRequired`); null only
   * in the non-encrypted test construction. See NatsChannelCryptoOptions.
   */
  private readonly keyStore: ConversationKeyStore | null;
  /**
   * F2: agent SaaS-attested static identity key pair used to wrap K to a device
   * (keyStore mode only). Non-null exactly when `keyStore` is non-null.
   */
  private readonly identityKeyPair: KeyPair | null;
  /** Per-peer established conversation keys (peerId -> 32-byte session key). */
  private readonly peerSessionKeys = new Map<string, Uint8Array>();

  // Message handlers
  private onMessage?: (peerId: string, message: InboundWsMessage) => void;
  private onApprovalDecision?: (peerId: string, id: string, decision: ApprovalDecision) => void;
  private onLoadHistory?: (peerId: string, request: { before?: string; limit?: number }) => void;
  private onLoadCommands?: (peerId: string) => void;
  private onPeerUnregister?: (peerId: string) => void;
  /** Bounded, content-free configuration-warning state for result max_payload. */
  private lastResultLimitWarningAt = Number.NEGATIVE_INFINITY;
  private suppressedResultLimitWarnings = 0;
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
    this.keyStore = crypto?.keyStore ?? null;
    // F2 fail-closed: a keyStore (register-hop) channel MUST have the attested
    // identity key to wrap K authentically. The entry (index-nats) already skips
    // serving a register-hop account with no persisted identity key; this is the
    // last-line assertion so the channel can never be constructed to wrap K under
    // an unattested key.
    this.identityKeyPair = crypto?.identityKeyPair ?? null;
    if (this.encryptionRequired && (!this.keyStore || !this.identityKeyPair)) {
      throw new Error(
        "webchannel: encrypted channel requires crypto.keyStore and crypto.identityKeyPair " +
          "(the SaaS-attested agent identity key) to wrap the conversation key — refusing " +
          "to serve without it (fail-closed; the browser could not authenticate K otherwise).",
      );
    }
    this.maxPeers = limits?.maxPeers ?? DEFAULT_MAX_PEERS;
    this.maxApprovalResolutions =
      limits?.maxApprovalResolutions ?? DEFAULT_MAX_APPROVAL_RESOLUTIONS;
    this.replayWindowMs = limits?.replayWindowMs ?? DEFAULT_REPLAY_WINDOW_MS;
    this.maxSeenMessageIdsPerPeer =
      limits?.maxSeenMessageIdsPerPeer ?? DEFAULT_MAX_SEEN_MESSAGE_IDS_PER_PEER;

    // Retain the exact listener identity so account teardown can detach it.
    this.transportMessageListener = (msg: NatsMessage) => {
      if (!this.disposed) this.handleNatsMessage(msg);
    };
    this.transport.on("message", this.transportMessageListener);
  }

  /**
   * Register a new peer (browser session).
   *
   * Subscribes to the peer's inbound subject. Called when a browser
   * connects with its bootstrap JWT (peerId from JWT sub claim).
   */
  registerPeer(peerId: string): void {
    if (this.disposed) throw new Error("NatsChannel is disposed");
    // Phase 6 (keyStore mode): establish the peer's STABLE conversation key K
    // from the agent-owned store — load if known, generate-once if new. Runs
    // even for an already-registered peer so a lost in-memory key (never
    // expected) self-heals on re-register. Crucially this SETS but never
    // re-derives: a second device registering the same peerId leaves K
    // untouched, which is the whole multi-device fix.
    // Acquire (or create+durably commit) K before ANY live-session mutation.
    // In particular, a full key store must reject before the maxPeers policy can
    // evict an unrelated live peer.
    const conversationKey =
      this.encryptionRequired && this.keyStore
        ? this.keyStore.getOrCreate(peerId)
        : null;

    if (this.peerSubscriptions.has(peerId)) {
      if (conversationKey) this.peerSessionKeys.set(peerId, conversationKey);
      console.warn(`[nats-channel] Peer ${logSafe(peerId)} already registered`);
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
        `[nats-channel] peer cap ${this.maxPeers} reached; evicting oldest peer ${logSafe(oldest)}`,
      );
      this.unregisterPeer(oldest);
    }

    const inboundSubject = this.inboundSubject(peerId);
    const sid = this.transport.subscribe(inboundSubject);
    this.peerSubscriptions.set(peerId, sid);
    if (conversationKey) this.peerSessionKeys.set(peerId, conversationKey);

    console.log(
      `[nats-channel] Registered peer ${logSafe(peerId)}, subscribed to ${logSafe(inboundSubject)}`,
    );
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
  subscribeRegister(): () => void {
    if (this.disposed) throw new Error("NatsChannel is disposed");
    if (this.registerSid !== undefined) {
      return this.registerDisposer(this.registerSid);
    }
    const regWild = `webchannel.${this.tenant}.${this.accountId}.*.register`;
    const sid = this.transport.subscribe(regWild);
    this.registerSid = sid;
    console.log(`[nats-channel] Subscribed to register wildcard ${logSafe(regWild)}`);
    return this.registerDisposer(sid);
  }

  private registerDisposer(sid: number): () => void {
    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      if (this.registerSid === sid) {
        this.transport.unsubscribe(sid);
        this.registerSid = undefined;
      }
    };
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
    // Release this peer's retained ingress work before retiring its key/window.
    // Called for explicit unregister and peer-cap eviction alike.
    this.onPeerUnregister?.(peerId);
    const sid = this.peerSubscriptions.get(peerId);
    if (sid) {
      this.transport.unsubscribe(sid);
      this.peerSubscriptions.delete(peerId);
      console.log(`[nats-channel] Unregistered peer ${logSafe(peerId)}`);
    }
    // Drop the in-memory session key: a reconnecting peer must re-register,
    // which reloads the stable key K from the
    // keyStore (Phase 6 mode — the persisted K itself is never dropped here).
    this.peerSessionKeys.delete(peerId);
    // F4: drop the peer's replay window with it (bounded memory; a genuine
    // reconnect re-establishes a fresh window).
    this.seenMessageIds.delete(peerId);
  }

  /** Idempotently detach all NATS ownership and fail closed for later sends. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.transport.off("message", this.transportMessageListener);
    if (this.registerSid !== undefined) {
      this.transport.unsubscribe(this.registerSid);
      this.registerSid = undefined;
    }
    for (const sid of this.peerSubscriptions.values()) this.transport.unsubscribe(sid);
    this.peerSubscriptions.clear();
    this.peerSessionKeys.clear();
    this.seenMessageIds.clear();
    this.approvalResolutions.clear();
    this.onMessage = undefined;
    this.onApprovalDecision = undefined;
    this.onLoadHistory = undefined;
    this.onLoadCommands = undefined;
    this.onPeerUnregister = undefined;
    this.onRegisterRequest = undefined;
  }

  /** Backward-compatible lifecycle name; shares the same idempotent teardown. */
  close(): void {
    this.dispose();
  }

  setPeerUnregisterHandler(handler: (peerId: string) => void): void {
    this.onPeerUnregister = handler;
  }

  /**
   * Send text message to peer.
   */
  sendText(
    peerId: string,
    text: string,
    id?: string,
    turnId?: string,
    assistantMessageIndex?: number,
  ): boolean {
    const payload: OutboundWsMessage = {
      type: "agent_message",
      text,
      ...(id ? { id } : {}),
      ...(turnId ? { turnId } : {}),
      ...(assistantMessageIndex !== undefined ? { assistantMessageIndex } : {}),
    };
    return this.sendToPeer(peerId, payload);
  }

  /**
   * Send progress update to peer.
   */
  sendProgress(peerId: string, id: string, text: string, turnId?: string): boolean {
    const payload: OutboundWsMessage = { type: "progress", id, text, ...(turnId ? { turnId } : {}) };
    return this.sendToPeer(peerId, payload);
  }

  /**
   * Finalize progress draft to final answer.
   */
  finalizeDraft(
    peerId: string,
    id: string,
    text: string,
    turnId?: string,
    assistantMessageIndex?: number,
  ): boolean {
    return this.sendText(peerId, text, id, turnId, assistantMessageIndex);
  }

  sendReasoning(peerId: string, id: string, turnId: string, text: string): boolean {
    return this.sendToPeer(peerId, { type: "reasoning", id, turnId, text });
  }

  sendToolActivity(
    peerId: string,
    activity: {
      id: string;
      turnId: string;
      name?: string;
      phase?: string;
      status?: string;
      summary?: string;
      argKeys?: string[];
    },
  ): boolean {
    const payload: OutboundWsMessage = {
      type: "tool_activity",
      id: activity.id,
      turnId: activity.turnId,
      ...(activity.name !== undefined ? { name: activity.name } : {}),
      ...(activity.phase !== undefined ? { phase: activity.phase } : {}),
      ...(activity.status !== undefined ? { status: activity.status } : {}),
      ...(activity.summary !== undefined ? { summary: activity.summary } : {}),
      ...(activity.argKeys !== undefined ? { argKeys: activity.argKeys } : {}),
    };
    return this.sendToPeer(peerId, payload);
  }

  sendTurnSettled(peerId: string, turnId: string, outcome: "ok" | "error"): boolean {
    return this.sendToPeer(peerId, { type: "turn_settled", turnId, outcome });
  }

  /**
   * P0-6: toggle the typing-indicator wire frame for this account's channel.
   * Called once at channel start (index-nats) with the account's resolved
   * `capabilities.typing` (default "on"). When disabled, `sendTyping` is a
   * no-op returning `false`, so callers need not gate at the call site.
   */
  setTypingEnabled(enabled: boolean): void {
    this.typingEnabled = enabled;
  }

  /**
   * Send typing indicator to peer.
   */
  sendTyping(peerId: string): boolean {
    if (!this.typingEnabled) return false;
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
   * Send the slash-command catalog to peer (P0-3 discovery). Rides the same
   * sealed `.out` path as every other outbound frame.
   */
  sendCommands(peerId: string, commands: CommandCatalogEntry[]): boolean {
    const payload: OutboundWsMessage = { type: "commands", commands };
    return this.sendToPeer(peerId, payload);
  }

  /**
   * P0-7b: acknowledge the ingress receipt of `user_message` ids to a peer, so
   * the client can drain its unacked replay ledger. Rides the same sealed `.out`
   * path as every other outbound frame — fail-closed before the peer's session
   * key exists (returns false, never plaintext). An EMPTY `ids` is a no-op that
   * returns true without publishing (nothing to ack — e.g. an all-id-less batch).
   */
  sendAck(peerId: string, ids: string[]): boolean {
    return this.sendIngressResult(peerId, "ack", ids);
  }

  sendInboundRejected(peerId: string, ids: string[]): boolean {
    return this.sendIngressResult(peerId, "inbound_rejected", ids);
  }

  /** Actual serialized/sealed length for result-frame admission chunking. */
  outboundWireSize(peerId: string, payload: OutboundWsMessage): number | undefined {
    if (!this.encryptionRequired) return Buffer.byteLength(JSON.stringify(payload), "utf8");
    const key = this.peerSessionKeys.get(peerId);
    if (!key) return undefined;
    return sealEnvelope(
      { accountId: this.accountId, tenant: this.tenant, sub: peerId },
      key,
      payload,
    ).length;
  }

  effectiveOutboundLimit(): number { return this.transport.effectiveOutboundLimit; }

  /**
   * Send approval request to peer.
   */
  sendApprovalRequest(
    peerId: string,
    request: ApprovalRequestPayload,
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
        console.log(
          `[nats-channel] Approval ${logSafe(id)} already resolved by ${logSafe(existingResolver)}, dropping duplicate from ${logSafe(peerId)}`,
        );
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
   * Send the authoritative pending-approval snapshot to a peer (#15).
   *
   * Emitted on every successful register (right after the history snapshot) so a
   * reloaded/reconnected widget re-hydrates its still-pending approval cards and
   * retires any it kept actionable after a missed `approval_resolved`. Rides the
   * same sealed `.out` path as every other outbound frame — fail-closed before
   * the key is established, E2E-encrypted, and fanned out to all of the peer's
   * devices for free. An EMPTY `approvals` array is sent deliberately (it is the
   * "nothing pending" reconciliation signal, not a no-op).
   *
   * `resolved` (#19) carries recently-RESOLVED outcomes so the client's Leg B can
   * render the actual decision instead of a neutral "resolved (elsewhere)". The
   * field is OMITTED when there is nothing to report (empty/absent), keeping an
   * old-plugin-shaped frame byte-identical for the back-compat path.
   */
  sendApprovalSnapshot(
    peerId: string,
    approvals: ApprovalRequestPayload[],
    resolved?: Array<{ id: string; decision: ApprovalDecision }>,
  ): boolean {
    const payload: OutboundWsMessage = {
      type: "approval_snapshot",
      approvals,
      ...(resolved && resolved.length > 0 ? { resolved } : {}),
    };
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
   * Set the command-catalog load handler (P0-3 discovery). Fires on a
   * `load_commands` request; the handler builds the catalog and calls
   * `sendCommands`.
   */
  setLoadCommandsHandler(handler: (peerId: string) => void): void {
    this.onLoadCommands = handler;
  }

  /**
   * Phase 6 (keyStore mode): wrap the peer's conversation key K to a specific
   * device's X25519 public key for delivery in the NATS register reply.
   *
   * Must be called AFTER `registerPeer(peerId)` (which establishes K). The
   * wrap targets exactly the key presented in THIS request's verified JWT cnf
   * claim — never a stored/pinned lookup, so two devices of the same peerId
   * can never receive a wrap meant for the other (audit F2).
   *
   * @param peerId - registered peer whose K to wrap.
   * @param devicePublicKey - raw 32-byte X25519 device public key (from cnf.jwk).
   * @param clientNonce - the BROWSER-generated per-attempt freshness anchor from
   *        THIS register request. MANDATORY (protocol v3): it is bound into the
   *        wrap AAD so a captured register reply cannot be replayed onto a later
   *        attempt. The register handler validates its format before calling.
   * @returns the wrapped key, or `null` when the channel is not in keyStore
   *          mode or the peer has no established key (caller treats as a
   *          server-side registration fault).
   */
  wrapConversationKeyForDevice(
    peerId: string,
    devicePublicKey: Uint8Array,
    clientNonce: string,
  ): WrappedConversationKey | null {
    if (!this.encryptionRequired || !this.keyStore) return null;
    if (devicePublicKey.length !== 32) {
      throw new Error(
        `webchannel: device public key must be 32 bytes (got ${devicePublicKey.length})`,
      );
    }
    const key = this.peerSessionKeys.get(peerId);
    if (!key) return null;
    // F2 + v3: static-static wrap under the agent's attested identity key, with
    // the AAD bound to BOTH the peerId (anti-lift) and this attempt's
    // browser-chosen clientNonce (anti-replay). `identityKeyPair` is guaranteed
    // non-null here (constructor asserts it whenever `keyStore` is set), so the
    // browser can authenticate K against the SaaS-pinned agent public key and no
    // relay-injected K′ can pass.
    return wrapConversationKey(key, devicePublicKey, {
      agentIdentityKeyPair: this.identityKeyPair!,
      peerId,
      clientNonce,
    });
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

  private sendToPeer(peerId: string, payload: OutboundWsMessage): boolean {
    if (this.disposed || !this.transport.connected) {
      console.warn("[nats-channel] Transport not connected, cannot send");
      return false;
    }

    const subject = this.outboundSubject(peerId);

    try {
      if (this.encryptionRequired) {
        // Fail-closed: refuse to publish until registration established a
        // session key. We NEVER fall back to plaintext on the relay.
        const key = this.peerSessionKeys.get(peerId);
        if (!key) {
          console.warn(
            `[nats-channel] Refusing to send to ${logSafe(peerId)}: no session key yet (fail-closed, no plaintext)`,
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
      console.error(
        `[nats-channel] Failed to send to peer ${logSafe(peerId)}: ${logSafe(formatCaughtDiagnostic(err))}`,
      );
      return false;
    }
  }

  /**
   * One boundary for every ingress ACK/rejection producer: validate ids, split
   * at 64 ids and 64 KiB, and honor the server's effective max_payload using the
   * actual sealed size. A failed chunk never prevents later chunks from being
   * attempted. Invalid ids are silently omitted and are never reflected.
   */
  private sendIngressResult(
    peerId: string,
    type: IngressResultFrame["type"],
    candidates: readonly unknown[],
  ): boolean {
    if (candidates.length === 0) return true;
    const advertisedLimit = this.transport.effectiveOutboundLimit;
    const effectiveOutboundLimit = Number.isSafeInteger(advertisedLimit) && advertisedLimit >= 0
      ? advertisedLimit
      : undefined;
    try {
      const writer = createIngressResultChunkWriter({
        type,
        publish: (frame) => this.sendToPeer(peerId, frame),
        measureWireBytes: (frame) =>
          this.outboundWireSize(peerId, frame)
            ?? Buffer.byteLength(JSON.stringify(frame), "utf8"),
        ...(effectiveOutboundLimit !== undefined ? { effectiveOutboundLimit } : {}),
        onTooSmall: () => this.warnResultLimitTooSmall(),
      });
      for (const candidate of candidates) writer.add(candidate);
      return writer.finish();
    } catch (err) {
      console.error(
        `[nats-channel] Failed to prepare bounded ingress result frame: ${logSafe(formatCaughtDiagnostic(err))}`,
      );
      return false;
    }
  }

  private warnResultLimitTooSmall(): void {
    const now = Date.now();
    if (now - this.lastResultLimitWarningAt < RESULT_LIMIT_WARNING_INTERVAL_MS) {
      this.suppressedResultLimitWarnings++;
      return;
    }
    const suppressed = this.suppressedResultLimitWarnings;
    this.lastResultLimitWarningAt = now;
    this.suppressedResultLimitWarnings = 0;
    console.warn(
      "[nats-channel] ingress result frame cannot fit effective NATS max_payload; " +
        `increase the server limit (suppressed=${suppressed})`,
    );
  }

  private handleNatsMessage(msg: NatsMessage): void {
    // Subject format: webchannel.{tenant}.{accountId}.{peerId}.{in|register}
    const parts = msg.subject.split(".");
    if (parts.length < 5) {
      console.warn(`[nats-channel] Invalid subject format: ${logSafe(msg.subject)}`);
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
      this.handleEncryptedInbound(msg, peerId);
      return;
    }

    // Plaintext mode (legacy / gateway-parity): payload is JSON.
    try {
      const message = JSON.parse(msg.payload.toString()) as InboundWsMessage;
      this.dispatchInbound(peerId, message);
    } catch (err) {
      console.error(
        `[nats-channel] Failed to parse message from ${logSafe(peerId)}: ${logSafe(formatCaughtDiagnostic(err))}`,
      );
    }
  }

  /**
   * Register-hop admission over NATS: hand the plaintext request to the
   * registered handler and route its reply to the NATS reply-to inbox.
   *
   * The reply is published to `msg.replyTo` (the browser's request-scoped inbox
   * subject). A request with no reply-to (e.g. fire-and-forget `unregister`)
   * simply gets a no-op reply callback.
   *
   * SECURITY (reply-to redirect): NATS does NOT constrain a requester's reply-to
   * against its publish permissions, and the agent publishes with tenant-wide
   * creds — an unchecked reply-to would let a caller aim the agent's plaintext
   * register reply at an arbitrary subject (another peer's E2E-encrypted `.out`
   * → decrypt-failure/reconnect churn, or any subject the caller can't publish
   * to itself, riding the agent's broader creds). The guard is an ALLOWLIST of
   * the ONE shape every real consumer uses: the requester's own
   * `webchannel.{tenant}.{accountId}.{peerId}.reginbox.{token}` (production
   * client `nats-client.ts` and all e2e/demo drivers; the reginbox is
   * in-namespace precisely so browser creds need no `_INBOX.>` grant — the
   * agent's own creds may not even cover `_INBOX.*`). Everything else is
   * dropped with a warn: another peer's subtree, the requester's own
   * `.in`/`.register` (a self-bounce through the agent's handlers),
   * `_INBOX.*`, foreign namespaces. `peerId` here is the subject-routing
   * segment, NOT the JWT identity (that is verified later, in
   * `handleRegisterRequest`); the confinement is nonetheless sound because a
   * browser's NATS creds are scoped `webchannel.{tenant}.*.{peerId}.>`, pinning
   * the peerId segment it can publish a `.register` on to its OWN peerId — so
   * the reply can only reach that requester's own reginbox.
   *
   * The token AFTER `reginbox.` must itself be a single valid subject token (no
   * `.`/`*`/`>`/whitespace). A crafted reply-to like `…reginbox.>` would start
   * with the prefix yet make the agent PUBLISH a wildcard/malformed subject —
   * harmless to other peers (it stays in the requester's own subtree) but it
   * emits an invalid-publish `-ERR` the transport only logs, so we reject it
   * here. A real client's token is always dotless (`randomInboxToken`).
   */
  private handleRegister(msg: NatsMessage, peerId: string): void {
    if (!this.onRegisterRequest) return;
    const replyTo = msg.replyTo;
    const ownReginboxPrefix = `webchannel.${this.tenant}.${this.accountId}.${peerId}.reginbox.`;
    const reply = (response: string): void => {
      if (!replyTo) return; // fire-and-forget (e.g. unregister)
      // Allowlist: own reginbox prefix + a single valid subject token (the token
      // check also rejects the empty token, so `…reginbox.` alone is dropped).
      if (
        !replyTo.startsWith(ownReginboxPrefix) ||
        !isValidSubjectToken(replyTo.slice(ownReginboxPrefix.length))
      ) {
        console.warn(
          `[nats-channel] Dropping register reply for ${logSafe(peerId)}: reply-to ${logSafe(replyTo)} ` +
            `is not the requester's own reginbox (expected ${logSafe(ownReginboxPrefix + "{token}")})`,
        );
        return;
      }
      this.transport.publish(replyTo, response);
    };
    this.onRegisterRequest(peerId, msg.payload.toString(), reply);
  }

  /**
   * Crypto mode: decrypt an inbound envelope and dispatch it.
   *
   * Fail-closed: a message that arrives before registration completes (no
   * session key) or that fails to decrypt/parse is dropped — never processed as
   * plaintext.
   */
  private handleEncryptedInbound(msg: NatsMessage, peerId: string): void {
    const key = this.peerSessionKeys.get(peerId);
    if (!key) {
      console.warn(
        `[nats-channel] Dropping inbound from ${logSafe(peerId)}: no registered session key`,
      );
      return;
    }
    let message: InboundWsMessage;
    let messageId: string;
    let ts: number;
    try {
      const opened = openEnvelope(msg.payload, key);
      message = opened.message as InboundWsMessage;
      messageId = opened.routing.messageId;
      ts = opened.routing.ts;
    } catch (err) {
      console.warn(
        `[nats-channel] Dropping inbound from ${logSafe(peerId)}: decrypt/parse failed: ${logSafe(err)}`,
      );
      return;
    }
    // F4: anti-replay. `messageId`/`ts` are in the AEAD-authenticated AAD, so a
    // relay can neither forge nor mutate them — a replay is a byte-identical
    // re-publish. Enforce freshness BEFORE dispatch so a captured frame can't
    // re-run the turn.
    if (!this.acceptFreshInbound(peerId, messageId, ts)) {
      return;
    }
    this.dispatchInbound(peerId, message);
  }

  /**
   * F4 freshness gate for an already-decrypted inbound envelope.
   *
   * Returns false (caller drops) when the frame is a replay: either its
   * `messageId` was already seen from this peer, or its `ts` falls outside the
   * ±`replayWindowMs` window. The messageId LRU is the PRIMARY defense; the ts
   * window is a generous secondary bound tolerating a skewed browser clock and
   * capping how far back the LRU must remember. Logging distinguishes the two so
   * a chronically-skewed client (every frame ts-rejected) is diagnosable versus
   * a genuine duplicate-id replay. Strictly per-peer: one peer's window can
   * never evict or admit another's.
   */
  private acceptFreshInbound(peerId: string, messageId: string, ts: number): boolean {
    const skew = Date.now() - ts;
    if (Math.abs(skew) > this.replayWindowMs) {
      console.warn(
        `[nats-channel] Dropping inbound from ${logSafe(peerId)}: ts outside ±${this.replayWindowMs}ms window ` +
          `(skew=${skew}ms) — stale replay or client clock skew; messageId=${logSafe(messageId)}`,
      );
      return false;
    }
    let seen = this.seenMessageIds.get(peerId);
    if (!seen) {
      seen = new Map<string, number>();
      this.seenMessageIds.set(peerId, seen);
    }
    if (seen.has(messageId)) {
      console.warn(
        `[nats-channel] Dropping inbound from ${logSafe(peerId)}: replayed messageId ${logSafe(messageId)}`,
      );
      return false;
    }
    seen.set(messageId, ts);
    // Per-peer LRU eviction. Map is insertion-ordered, so the first key is the
    // oldest-recorded; dropping it is safe because the ts window (which only
    // admits frames within ±replayWindowMs of now) re-catches any replay of an
    // evicted old messageId.
    while (seen.size > this.maxSeenMessageIdsPerPeer) {
      const oldest = seen.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      seen.delete(oldest);
    }
    return true;
  }

  /** Route a decoded inbound message to the registered handler. */
  private dispatchInbound(peerId: string, message: InboundWsMessage): void {
    switch (message.type) {
      case "user_message":
        this.onMessage?.(peerId, message);
        break;

      case "approval_decision":
        if (
          typeof message.id !== "string" ||
          !(["allow-once", "allow-always", "deny"] as const).includes(message.decision)
        ) {
          console.warn(`[nats-channel] Invalid approval_decision from ${logSafe(peerId)}`);
          break;
        }
        this.onApprovalDecision?.(peerId, message.id, message.decision);
        break;

      case "load_history":
        this.onLoadHistory?.(peerId, { before: message.before, limit: message.limit });
        break;

      case "load_commands":
        this.onLoadCommands?.(peerId);
        break;

      default:
        console.warn(
          `[nats-channel] Unknown message type: ${logSafe((message as { type: string }).type)}`,
        );
    }
  }
}

/**
 * The exact `NatsChannel` method surface the register-hop wiring reaches to feed
 * `RegisterHandlerDeps` (see index-nats.ts). The register deps are function-
 * injected, and index-nats.ts sits OUTSIDE this package's `tsc` include set, so
 * without this contract nothing would force these methods to keep existing on
 * `NatsChannel`. Derived via `Pick`, so dropping any listed method from the
 * class turns THIS type into a compile error in a type-checked file.
 */
export type RegisterChannelSurface = Pick<
  NatsChannel,
  | "registerPeer"
  | "unregisterPeer"
  | "wrapConversationKeyForDevice"
  | "sendApprovalSnapshot"
>;

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
