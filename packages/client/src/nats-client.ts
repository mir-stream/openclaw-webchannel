/**
 * WebChannel NATS Client — Browser-side NATS connection.
 *
 * This module provides a browser-compatible NATS WebSocket client that:
 * - Connects to NATS server with bootstrap JWT authentication
 * - Subscribes to inbound message subjects
 * - Publishes to outbound message subjects
 * - Handles reconnection with exponential backoff
 * - Integrates with register-delivered E2E encryption
 *
 * Architecture:
 * - Outbound-only connection (browser dials NATS)
 * - JWT-based authentication (bootstrap JWT from SaaS)
 * - Per-peer NATS subjects (tenant-keyed routing)
 * - E2E encryption: authenticated register-delivered key + MessageEnvelope v1 sealing,
 *   matching the agent (`packages/plugin/src/nats-channel.ts` crypto mode). The
 *   client is FAIL-CLOSED — it buffers sends until registration completes and
 *   never publishes or accepts plaintext on the relay.
 */

import {
  sealMessage,
  openMessage,
  base64urlDecode,
  unwrapConversationKey,
} from "./e2e-crypto-browser.js";
import { importEd25519SeedKey, signNonce } from "./nats-nkey-browser.js";
import {
  registerWithPop,
  isTerminalRegisterError,
  PopCapacityError,
  PopRejectedError,
  PopServerError,
  ProtocolMismatchError,
} from "./pop-register.js";
import type { CommandCatalogEntry, WebChannelErrorCause, SendState, SendFailure } from "./types.js";
import { WEBCHANNEL_PROTOCOL_VERSION } from "./protocol.js";

export const MAX_CONTROL_LINE = 64 * 1024;
export const MAX_PAYLOAD = 8 * 1024 * 1024;
export const MAX_BUFFERED_BYTES = MAX_CONTROL_LINE + MAX_PAYLOAD + 4;

/**
 * A random, subject-safe token for a request/reply inbox segment (hex only, so
 * it never contains a `.`/`*`/`>` that would break the subject hierarchy).
 * Prefers `crypto.getRandomValues`; falls back to `Math.random` in hosts without
 * WebCrypto (the reply subject is not a secret — it only needs to be unguessable
 * enough to avoid collisions).
 */
function randomInboxToken(): string {
  const g = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  if (g?.getRandomValues) {
    const b = new Uint8Array(12);
    g.getRandomValues(b);
    return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  }
  return `${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type NatsClientOptions = {
  /** NATS WebSocket URL */
  url: string;
  /**
   * Bootstrap JWT (RS256-signed, contains cnf.jwk claim).
   *
   * Optional: only the SaaS register-hop path needs it (it is the credential the
   * `registration` PoP round-trip presents, and the value CONNECT sends when no
   * NATS-layer `natsCredentials` are supplied). When connecting to a bring-your-
   * own-NATS with `natsCredentials` and NO `registration`, the bootstrap JWT is
   * unused — omit it. REQUIRED whenever `registration` is present.
   */
  jwt?: string;
  /** Account (deployment) id — the wire identity (from JWT) */
  accountId: string;
  /** Tenant ID (from JWT) */
  tenant: string;
  /** Peer ID (JWT sub claim) */
  peerId: string;
  /** Reconnect backoff base delay (ms) */
  reconnectBaseMs?: number;
  /** Reconnect backoff cap (ms) */
  reconnectCapMs?: number;
  /**
   * CL3: client-side keepalive interval (ms). While connected the client sends a
   * PING every interval and expects a PONG before the next tick; a missed PONG
   * means the socket is half-open (tab sleep/wake, NAT/mobile flap) and is torn
   * down so a reconnect fires — otherwise `connected` stays wrongly true and
   * published messages vanish into the retention-less relay. Default 20_000; set
   * to 0 to disable.
   */
  heartbeatIntervalMs?: number;
  /** Per-handshake-phase deadline in ms. Default 10,000; 0 disables it. */
  connectTimeoutMs?: number;
  /**
   * Required PoP registration. The client performs the JWT +
   * Proof-of-Possession registration over NATS request/reply on the account's
   * `…{peerId}.register` subject after connecting (and before any key flows), so
   * the agent subscribes to this peer's subjects.
   * `jwt`, `tenant`, `accountId` and `peerId` come from the existing
   * NatsClientOptions fields — the register subject is derived from them, so
   * there is no gateway URL to configure (the agent is reached over NATS only).
   */
  registration?: {
    /** Device Ed25519 private key paired with the bootstrap JWT's pop_jwk. */
    devicePrivateKey: CryptoKey;
    /**
     * Phase 6 (multi-device): the device X25519 PRIVATE key whose PUBLIC half
     * was minted into the bootstrap JWT `cnf.jwk`. The session
     * key is the agent-owned conversation key K delivered WRAPPED to this key
     * in the register reply (`unwrapConversationKey`) — no `.handshake`
     * negotiation happens at all, so one user's multiple devices share one
     * stable K.
     */
    deviceX25519PrivateKey: CryptoKey;
    /**
     * F2 — the SaaS-PINNED agent X25519 identity public key (base64url, 32 bytes),
     * taken from the first-party HTTPS bootstrap response. REQUIRED whenever
     * `deviceX25519PrivateKey` is present: the register-delivered K is unwrapped
     * by deriving the key SOLELY from THIS pinned value, never from any NATS
     * frame — so a relay's injected K′ (wrapped under a relay-chosen key) fails
     * authentication. Absence on the register-delivered path is fail-closed
     * terminal (the browser cannot authenticate K).
     */
    pinnedAgentPublicKey?: string;
  };
  /**
   * Optional NATS-layer NKEY authentication for a JWT-auth nats-server.
   *
   * When present, the client defers CONNECT until the server's `INFO` line
   * arrives, extracts the `nonce`, signs it with the user NKEY seed, and sends
   * CONNECT carrying `{ jwt: userJwt, sig }` (NATS challenge-response). When
   * ABSENT, the client keeps its original behaviour byte-for-byte: CONNECT is
   * sent on ws-open with `jwt: options.jwt` and no signature (open / dev-NATS).
   *
   * `userSeedRaw` is the **base64url-encoded raw 32-byte Ed25519 seed** (NOT the
   * base32 "SU…" NKEY string), so the browser needs no base32/CRC NKEY decoder.
   */
  natsCredentials?: {
    /** NATS user JWT (compact), signed by the account NKEY. */
    userJwt: string;
    /** base64url of the raw 32-byte Ed25519 user-NKEY seed. */
    userSeedRaw: string;
  };
};

export type InboundMessage = {
  type:
    | "agent_message"
    | "progress"
    | "reasoning"
    | "turn_settled"
    | "approval_request"
    | "approval_resolved"
    // #15: authoritative pending-approval snapshot (carries `approvals`).
    | "approval_snapshot"
    | "typing"
    | "history"
    // P0-3: slash-command discovery catalog (carries `commands`).
    | "commands"
    // P0-7b: ingress acknowledgement (carries `ids`). The agent acks every
    // id-carrying `user_message` at ingress so the client can drain its unacked
    // replay ledger; unknown ids are a silent no-op.
    | "ack"
    | "inbound_rejected";
  id?: string;
  /** P0-7b: the acknowledged `user_message` ids on an `ack` frame. */
  ids?: string[];
  reason?: "overloaded";
  text?: string;
  turnId?: string;
  /**
   * Optional observed run/attempt-local ordinal on an `agent_message` emitted
   * for an authorized block. It can repeat after fallback and is not a durable
   * hydration key.
   */
  assistantMessageIndex?: number;
  /**
   * P0-4 (additive; older plugins omit it): on a `turn_settled` frame, whether
   * the turn settled cleanly. `"ok"` promotes the message whose wire id exactly
   * matches `turnId` from `accepted → completed`; `"error"` fails that message
   * `turn-failed`. The current plugin emits one such frame per coalesced member.
   * ABSENT means a legacy plugin that fires `turn_settled` from a `finally`
   * regardless of outcome — the client then leaves the named message at
   * `accepted` (an honest degradation) and never fabricates `completed`. Client
   * re-declares this wire type (zero-dep package), so a new field here needs no
   * plugin import.
   */
  outcome?: "ok" | "error";
  kind?: "exec" | "plugin";
  title?: string;
  description?: string;
  prompt?: string;
  options?: Array<{ decision: string; label: string; style: string }>;
  expiresAtMs?: number;
  decision?: string;
  messages?: Array<{ id: string; role: string; text: string; ts?: number }>;
  /** #15: the still-pending approval set on an `approval_snapshot` frame. */
  approvals?: Array<{
    id: string;
    kind?: "exec" | "plugin";
    title?: string;
    description?: string;
    prompt?: string;
    options?: Array<{ decision: string; label: string; style: string }>;
    expiresAtMs?: number;
  }>;
  /**
   * #19: recently-RESOLVED outcomes on an `approval_snapshot` frame. Optional —
   * an older plugin omits it, and the wrapper falls back to "unknown" for a card
   * absent from `approvals` but with no matching `resolved` entry.
   */
  resolved?: Array<{ id: string; decision: string }>;
  before?: string;
  limit?: number;
  /** P0-3: the slash-command catalog on a `commands` frame. */
  commands?: CommandCatalogEntry[];
};

export type OutboundMessage =
  // P0-7a: `id` is a stable, unique id stamped per logical send so the agent can
  // dedupe a re-delivered frame at ingress. Always set on the send path below;
  // typed optional to mirror the wire union (older clients omit it).
  | { type: "user_message"; text: string; id?: string }
  | { type: "approval_decision"; id: string; decision: string }
  | { type: "load_history"; before?: string; limit?: number }
  // P0-3: request the slash-command discovery catalog.
  | { type: "load_commands" };

/** Message listener callback (decrypted, high-level). */
export type MessageListener = (msg: InboundMessage) => void;

/** Raw NATS message listener: (subject, payload) before any decryption. */
export type RawMessageListener = (subject: string, payload: string) => void;

/** Connection state listener callback */
export type StateListener = (connected: boolean) => void;

/**
 * Error listener callback (e.g. PoP registration failure). The optional second
 * arg is a machine-readable cause tag (P1-7): a foreign error (a `PopRejectedError`
 * thrown by `registerWithPop`, a WebCrypto unwrap throw) keeps its own class
 * identity and carries the cause alongside — an additive trailing param, so every
 * existing 1-arg listener still typechecks and behaves identically.
 */
export type ErrorListener = (err: Error, cause?: WebChannelErrorCause) => void;

/**
 * The agent-plugin versions learned from a successful register handshake.
 * Both are `null` until a register completes (or against a pre-reporting
 * plugin). A protocol version that DISAGREES with the client's
 * `WEBCHANNEL_PROTOCOL_VERSION` never reaches here — it is surfaced as a
 * terminal error instead.
 */
export type ProtocolInfo = {
  protocolVersion: number | null;
  pluginVersion: string | null;
};

/** Register-handshake protocol/version listener. */
export type ProtocolListener = (info: ProtocolInfo) => void;

/**
 * P1-9: fired once per session KEY-establishment (the register-delivered-K
 * path — P0-2 removed the legacy handshake path), strictly AFTER `flushQueue()`.
 * Lets the wrapper release held sends only when the conversation key exists AND
 * the P0-7b unacked ledger has already been replayed to the front of the wire —
 * see the `drain → flush → notify` ordering in `onConnected`.
 */
export type SessionListener = () => void;

/**
 * P0-4: authoritative send-state listener. Fires on every VALID monotonic
 * transition of a tracked `user_message`, keyed by its wire `id`. Invalid inputs
 * (duplicate ack, ack after eviction, any event after `failed`) are silent
 * no-ops — the tracker is the guard, so a consumer never has to re-derive
 * validity. `failure` is present only for `state === "failed"`.
 */
export type SendStateListener = (id: string, state: SendState, failure?: SendFailure) => void;

export type WebChannelNatsClientOptions = Omit<NatsClientOptions, "jwt" | "registration"> & {
  jwt: string;
  registration: NonNullable<NatsClientOptions["registration"]>;
  /**
   * Maximum time published or locally-held application work may receive no
   * authenticated ingress/turn activity before one soft reconnect is requested.
   * Default 30,000ms; 0 disables both automatic application-recovery lanes.
   */
  ackStallTimeoutMs?: number;
  /** Deterministic live ingress-outcome retry seams (tests/embedded runtimes). */
  _retryNow?: () => number;
  _retryRandom?: () => number;
  _retrySetTimeout?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  _retryClearTimeout?: (timer: ReturnType<typeof setTimeout>) => void;
};

type UnackedLedgerEntry = {
  message: Extract<OutboundMessage, { type: "user_message" }>;
  retryCount: number;
  nextRetryAt: number | null;
  published: boolean;
};

type LedgerSchedulingSnapshot = Array<{
  id: string;
  entry: UnackedLedgerEntry;
  nextRetryAt: number | null;
  published: boolean;
}>;

// ---------------------------------------------------------------------------
// WebSocket-based NATS client (browser-compatible)
// -----------------------------------------------------------------

/**
 * Browser-compatible NATS WebSocket client.
 *
 * This is a simplified NATS client that implements the wire protocol
 * over WebSocket in the browser. It supports:
 * - JWT authentication in CONNECT
 * - PUB/SUB commands
 * - Automatic reconnection
 * - Per-peer subject routing
 */
export class NatsClient {
  private readonly options: NatsClientOptions;
  private ws: WebSocket | null = null;
  private connectionGeneration = 0;
  private connected = false;
  private rawListeners = new Set<RawMessageListener>();
  private stateListeners = new Set<StateListener>();
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private subscriptions = new Map<number, string>(); // sid -> subject
  private sidCounter = 0;

  /** CL2: terminal auth failure — stop reconnecting; only a fresh client helps. */
  private terminal = false;
  /** CL2: listeners notified on a terminal (non-retryable) failure. */
  private readonly errorListeners = new Set<ErrorListener>();
  /** CL3: keepalive timer + outstanding-PING flag. */
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private pongPending = false;
  /**
   * The CURRENT dial's deadline-timer cleanup. disconnect()/forceReconnect() null
   * ws.onclose before close(), so the dial's onclose→clearDeadline never runs;
   * invoking this cancels the armed deadline directly. Only ever points at the
   * current dial's cleanup — a stale dial self-cleans via its own onclose/timeout.
   */
  private activeDialCleanup: (() => void) | null = null;
  /**
   * P0-4 (R2b-2): lifecycle generation, bumped by `disconnect()`. `forceReconnect`
   * captures it BEFORE notifying state listeners and re-checks it AFTER: if a
   * listener synchronously called `disconnect()` (advancing the generation and
   * clearing the reconnect timer), forceReconnect must NOT re-arm the timer and
   * resurrect a connection the embedder explicitly closed. This surface became
   * reachable once `publish()` (D3) can drive `forceReconnect` from a send-throw
   * whose state event a listener may respond to with `disconnect()`.
   */
  private lifecycleGeneration = 0;

  constructor(options: NatsClientOptions) {
    this.options = options;
  }

  /**
   * CL2: subscribe to terminal (non-retryable) connection failures — an
   * authoritative auth rejection where reconnecting with the same credentials
   * cannot succeed. After this fires the client has stopped reconnecting.
   */
  onError(listener: ErrorListener): () => void {
    this.errorListeners.add(listener);
    return () => { this.errorListeners.delete(listener); };
  }

  /** Connect to NATS server */
  connect(): void {
    this.connectInternal();
  }

  /** @internal Bind higher-level terminal cleanup to the dial that failed. */
  currentConnectionGeneration(): number { return this.connectionGeneration; }

  /** @internal Never let stale higher-level cleanup tear down a replacement dial. */
  disconnectConnectionGeneration(generation: number): void {
    if (this.connectionGeneration === generation) this.disconnect();
  }

  /** Disconnect and cleanup */
  disconnect(): void {
    // P0-4 (R2b-2): advance the lifecycle generation so an in-flight
    // forceReconnect (mid state-listener notification) does not re-arm the timer.
    this.lifecycleGeneration++;
    this.clearReconnectTimer();
    this.stopHeartbeat();
    // Cancel the active dial's armed deadline before we null its onclose below
    // (which would otherwise strand the timer until it fires as a guarded no-op).
    if (this.activeDialCleanup) { this.activeDialCleanup(); this.activeDialCleanup = null; }
    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onerror = null;
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
    this.notifyStateListeners();
  }

  /**
   * Publish message to NATS subject. Returns whether the frame was written to
   * the socket (P0-4 B1 — the old void signature silently dropped sends).
   *
   * - Not connected → `false` (keep the warn). The caller keeps the frame queued
   *   / ledgered so a reconnect+flush replays it (no false success).
   * - Socket not OPEN, or `ws.send` throws → `false` AND force a reconnect. A
   *   CLOSING/CLOSED browser socket may silently discard sends, and a synchronous
   *   send-throw does not guarantee an `onclose` (a half-open socket). Without the
   *   forced teardown a live process could sit `connected===true` while publishes
   *   vanished. `forceReconnect` tears the socket down, redials, and the fresh
   *   `onConnected` re-registers + replays the queue (mirrors heartbeat recovery).
   */
  publish(subject: string, payload: string): boolean {
    if (!this.connected || !this.ws) {
      console.warn("[nats-client] Not connected, cannot publish");
      return false;
    }

    // `connected` is updated by socket callbacks and can briefly lag the native
    // WebSocket state. Browsers are allowed to silently discard `send()` calls
    // once a socket is CLOSING/CLOSED, so only OPEN is a successful write. Drive
    // the same reconnect path as a synchronous send throw; higher layers already
    // ledgered the user message and will replay it with the same id.
    if (this.ws.readyState !== WebSocket.OPEN) {
      console.warn("[nats-client] Socket is not open, forcing reconnect before publish");
      this.forceReconnect();
      return false;
    }

    // Use TextEncoder for byte-length (browser-compatible; Node.js ≥18 also
    // has globalThis.TextEncoder). NATS PUB requires the UTF-8 byte count.
    const byteLen = new TextEncoder().encode(payload).length;
    try {
      this.ws.send(`PUB ${subject} ${byteLen}\r\n${payload}\r\n`);
      return true;
    } catch (err) {
      console.warn("[nats-client] publish send threw — forcing reconnect", err);
      this.forceReconnect();
      return false;
    }
  }

  /**
   * Publish with a NATS reply-to subject (`PUB <subject> <reply-to> <len>`).
   * The subscriber's transport surfaces `reply-to`, so the agent can publish its
   * response back to it — this is the request half of `request()`.
   */
  publishWithReply(subject: string, replyTo: string, payload: string): void {
    if (!this.connected || !this.ws) {
      console.warn("[nats-client] Not connected, cannot publish");
      return;
    }
    const byteLen = new TextEncoder().encode(payload).length;
    this.ws.send(`PUB ${subject} ${replyTo} ${byteLen}\r\n${payload}\r\n`);
  }

  /**
   * NATS request/reply: publish `payload` to `subject` with a fresh reply-to
   * inbox, and resolve with the first reply payload (or reject on timeout).
   *
   * The reply inbox is derived from `replyPrefix` (an in-namespace subject the
   * browser's tenant-wide creds already cover for BOTH pub and sub — so no
   * `_INBOX.>` grant is needed). A single round-trip with NO internal retry:
   * the caller (registerWithPop) owns the retry/backoff policy so it can restart
   * from a fresh challenge on a lost reply.
   */
  request(
    subject: string,
    payload: string,
    opts: { timeoutMs?: number; replyPrefix: string },
  ): Promise<string> {
    const timeoutMs = opts.timeoutMs ?? 5000;
    if (!this.connected || !this.ws) {
      return Promise.reject(new Error("[nats-client] request: not connected"));
    }
    const replySubject = `${opts.replyPrefix}.${randomInboxToken()}`;
    const sid = this.subscribe(replySubject);
    return new Promise<string>((resolve, reject) => {
      let settled = false;
      let off: () => void = () => {};
      let timer: ReturnType<typeof setTimeout>;
      const cleanup = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        off();
        this.unsubscribe(sid);
      };
      off = this.onRawMessage((subj, pl) => {
        if (subj !== replySubject) return;
        cleanup();
        resolve(pl);
      });
      timer = setTimeout(() => {
        cleanup();
        reject(new Error("[nats-client] request timeout"));
      }, timeoutMs);
      this.publishWithReply(subject, replySubject, payload);
    });
  }

  /** Subscribe to NATS subject */
  subscribe(subject: string): number {
    if (!this.connected || !this.ws) {
      console.warn("[nats-client] Not connected, cannot subscribe");
      return -1;
    }

    const sid = ++this.sidCounter;
    this.subscriptions.set(sid, subject);
    this.ws.send(`SUB ${subject} ${sid}\r\n`);
    return sid;
  }

  /** Unsubscribe from subject */
  unsubscribe(sid: number): void {
    this.subscriptions.delete(sid);
    if (this.connected && this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(`UNSUB ${sid}\r\n`);
    }
  }

  /** Add a raw (subject, payload) message listener. */
  onRawMessage(listener: RawMessageListener): () => void {
    this.rawListeners.add(listener);
    return () => { this.rawListeners.delete(listener); };
  }

  /** Add connection state listener */
  onState(listener: StateListener): () => void {
    this.stateListeners.add(listener);
    return () => { this.stateListeners.delete(listener); };
  }

  // ---------------------------------------------------------------------------
  // Internal implementation
  // ---------------------------------------------------------------------------

  private connectInternal(): void {
    // CL2: a terminal auth failure is not retryable — refuse to redial.
    if (this.terminal) return;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    const ws = new WebSocket(this.options.url);
    this.connectionGeneration++;
    // nats-server speaks the NATS protocol over BINARY WebSocket frames. The
    // default binaryType ("blob") coerces to "[object Blob]" in the text buffer
    // and breaks the parser — request ArrayBuffer and decode to UTF-8.
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    // NOTE: `buffer` is annotated as bare `Uint8Array` (generic default) — under
    // TS ≥5.7 typed-array generics, letting it infer `Uint8Array<ArrayBuffer>`
    // from `new Uint8Array(0)` rejects later assignments of encoder/slice results
    // typed `Uint8Array<ArrayBufferLike>` (packages/client resolves a newer local
    // TypeScript than the workspace root, so this must compile under both).
    const dial: {
      buffer: Uint8Array;
      connectSent: boolean;
      connectOnWire: boolean;
      timer: ReturnType<typeof setTimeout> | null;
      phase: string;
    } = { buffer: new Uint8Array(0), connectSent: false, connectOnWire: false, timer: null, phase: "WebSocket open" };
    const armDeadline = (phase: string): void => {
      dial.phase = phase;
      if (dial.timer) clearTimeout(dial.timer);
      const timeout = this.options.connectTimeoutMs ?? 10_000;
      if (timeout === 0) return;
      dial.timer = setTimeout(() => {
        if (this.ws === ws) {
          console.warn(`[nats-client] Handshake timeout in phase ${dial.phase}`);
          this.forceReconnect();
        }
        else try { ws.close(); } catch { /* stale dial owns its socket */ }
      }, timeout);
    };
    const clearDeadline = (): void => {
      if (dial.timer) clearTimeout(dial.timer);
      dial.timer = null;
    };
    // Expose THIS dial's timer cleanup on the instance. disconnect()/forceReconnect()
    // null ws.onclose BEFORE close(), so the dial's own onclose→clearDeadline never
    // runs and the armed deadline would otherwise survive up to connectTimeoutMs and
    // fire as a guarded no-op. Each new dial reassigns this slot; a stale dial still
    // self-cleans via its own onclose/timeout.
    this.activeDialCleanup = clearDeadline;
    armDeadline("WebSocket open");

    ws.onopen = () => {
      if (this.ws !== ws) return;
      console.log("[nats-client] WebSocket connected");
      // No NKEY auth: send CONNECT immediately (original path, byte-for-byte).
      // With NKEY auth we MUST wait for the server's INFO nonce before signing,
      // so CONNECT is deferred to the INFO handler in drainBuffer().
      if (!this.options.natsCredentials) {
        // Mark CONNECT on-wire and arm the "first PONG" deadline BEFORE the send
        // (matching the signed-connect path): a server — or the test fake — that
        // answers our PING with a PONG in the SAME synchronous tick would settle
        // the connection and clear the deadline inside sendConnect(); arming after
        // that would strand a fresh timer that fires ~10s later and force-reconnects
        // a healthy link. Arm-then-send lets the sync PONG clear it and stay clear.
        dial.connectOnWire = true;
        armDeadline("first PONG");
        this.sendConnect(ws);
      } else {
        armDeadline("INFO");
      }
    };

    ws.onmessage = (event: MessageEvent<string | ArrayBuffer>) => {
      if (this.ws !== ws) return;
      const chunk = typeof event.data === "string"
        ? new TextEncoder().encode(event.data)
        : new Uint8Array(event.data);
      if (dial.buffer.length + chunk.length > MAX_BUFFERED_BYTES) {
        this.forceReconnect();
        return;
      }
      const joined = new Uint8Array(dial.buffer.length + chunk.length);
      joined.set(dial.buffer);
      joined.set(chunk, dial.buffer.length);
      dial.buffer = joined;
      dial.buffer = this.drainBuffer(ws, dial.buffer, () => {
        clearDeadline();
      }, () => { dial.connectOnWire = true; armDeadline("first PONG"); }, () => {
        if (dial.connectSent) return false;
        dial.connectSent = true;
        armDeadline("CONNECT signing");
        return true;
      }, () => dial.connectOnWire);
    };

    ws.onerror = (err) => {
      console.error("[nats-client] WebSocket error:", err);
    };

    ws.onclose = () => {
      clearDeadline();
      if (this.ws !== ws) return;
      this.connected = false;
      this.stopHeartbeat();
      this.scheduleReconnect();
      this.notifyStateListeners();
    };
  }

  private sendConnect(ws: WebSocket): void {

    const connectPayload: Record<string, unknown> = {
      verbose: false,
      pedantic: false,
      lang: "typescript",
      version: "1.0.0",
      protocol: 1,
      echo: false,
    };
    // Include the bootstrap JWT only when present. When set, the wire output is
    // byte-for-byte the original; when absent (BYO-NATS via natsCredentials, which
    // takes the deferred-CONNECT path instead) the field is simply omitted.
    if (this.options.jwt) connectPayload["jwt"] = this.options.jwt;

    ws.send(`CONNECT ${JSON.stringify(connectPayload)}\r\n`);
    ws.send("PING\r\n");
  }

  /**
   * NKEY-auth CONNECT: triggered by the server's INFO line. Extracts the nonce,
   * signs it with the user NKEY seed, and sends CONNECT carrying the user JWT +
   * signature (NATS challenge-response), then PING to provoke the PONG that
   * flips us to `connected`. Only invoked when `natsCredentials` is set.
   */
  private async sendSignedConnect(ws: WebSocket, infoLine: string, onSent: () => void): Promise<void> {
    const creds = this.options.natsCredentials;
    // `ws` is threaded in lexically by the caller: CONNECT must be sent on the
    // exact socket that produced this INFO nonce, never a replacement that a
    // reconnect during the crypto await below may have swapped into `this.ws`
    // (re-checked against `this.ws` right before the send).
    if (!creds) return;

    let nonce = "";
    try {
      nonce = (JSON.parse(infoLine.slice(5).trim()) as { nonce?: string }).nonce ?? "";
    } catch {
      /* INFO without a parseable nonce — sign nothing (server will reject). */
    }

    let sig = "";
    if (nonce) {
      try {
        const privateKey = await importEd25519SeedKey(base64urlDecode(creds.userSeedRaw));
        sig = await signNonce(privateKey, nonce);
      } catch (err) {
        // A malformed user seed (or any WebCrypto failure) can never produce a
        // valid signature — the SAME credentials fail on every re-dial. Left
        // unguarded, `void sendSignedConnect(...)` turns this into an unhandled
        // rejection, CONNECT is never sent, and the armed "CONNECT signing"
        // deadline silently force-reconnects into an endless ~10s loop. Retire
        // terminally instead (mirrors the plugin's settle(err)), but only for the
        // CURRENT dial — a reconnect during the await may have moved on, and that
        // replacement runs its own signing.
        if (this.ws !== ws) return;
        this.failTerminally(
          `NATS NKEY signing failed: ${err instanceof Error ? err.message : String(err)} ` +
            `(invalid user seed — reconnecting cannot help; re-authenticate)`,
          "auth-rejected",
        );
        return;
      }
    }

    const connectPayload: Record<string, unknown> = {
      verbose: false,
      pedantic: false,
      lang: "typescript",
      version: "1.0.0",
      protocol: 1,
      echo: false,
      jwt: creds.userJwt,
    };
    if (sig) connectPayload["sig"] = sig;

    if (this.ws !== ws || ws.readyState !== WebSocket.OPEN) return;
    // Mark CONNECT on-wire and arm the "first PONG" deadline BEFORE the synchronous
    // sends: a server (or test fake) that answers our PING with a PONG in the same
    // tick must not have that legitimate PONG dropped as unsolicited.
    onSent();
    ws.send(`CONNECT ${JSON.stringify(connectPayload)}\r\n`);
    ws.send("PING\r\n");
  }

  private drainBuffer(
    ws: WebSocket,
    initialBuffer: Uint8Array,
    onPong: () => void,
    onConnectSent: () => void,
    beginSignedConnect: () => boolean,
    isConnectOnWire: () => boolean,
  ): Uint8Array {
    let buffer = initialBuffer;
    const decoder = new TextDecoder();
    const crlfIndex = (bytes: Uint8Array): number => {
      for (let i = 0; i + 1 < bytes.length; i++) if (bytes[i] === 13 && bytes[i + 1] === 10) return i;
      return -1;
    };
    let crlfPos: number;
    while ((crlfPos = crlfIndex(buffer)) !== -1) {
      if (crlfPos > MAX_CONTROL_LINE) { this.forceReconnect(); return new Uint8Array(0); }
      const lineBytes = buffer.slice(0, crlfPos);
      const line = decoder.decode(lineBytes);
      buffer = buffer.slice(crlfPos + 2);

      if (!line) continue;

      if (line.startsWith("INFO ")) {
        // NKEY auth: the INFO nonce is our cue to send the signed CONNECT (once).
        if (this.options.natsCredentials && beginSignedConnect()) {
          void this.sendSignedConnect(ws, line, onConnectSent);
        }
        continue;
      }

      if (line === "PONG") {
        // A PONG is only legitimate once our CONNECT+PING is actually on the wire.
        // An unsolicited PONG (NKEY mode: INFO arrived, signing still pending) must
        // not clear the deadline, flip us connected, or touch pongPending — ignore
        // it entirely and keep the armed phase deadline running.
        if (!isConnectOnWire()) continue;
        onPong();
        // CL3: any PONG proves the link is alive — clear the outstanding-ping
        // flag so the next heartbeat tick does not declare a dead link.
        this.pongPending = false;
        if (!this.connected) {
          this.connected = true;
          this.reconnectAttempts = 0;
          console.log("[nats-client] Connected to NATS");
          // Order is deliberately UNCHANGED (notify -> resubscribe -> heartbeat):
          // nats-client-wrapper's P1-9 ledger/hold release observes this sequence.
          // The leak this fixes is a state listener that synchronously disconnects:
          // it ran stopHeartbeat(), and the unguarded startHeartbeat() below then
          // armed a fresh interval on a dead client. Bail instead of reordering.
          this.notifyStateListeners(() => this.ws === ws);
          if (this.ws !== ws) return new Uint8Array(0);
          this.resubscribeAll();
          this.startHeartbeat();
        }
        continue;
      }

      if (line === "PING") {
        ws.send("PONG\r\n");
        continue;
      }

      if (line.startsWith("MSG ")) {
        // handleMessage returns false when the payload hasn't fully arrived yet
        // (it re-buffers the header). We MUST break, not continue: continuing
        // would re-extract the same header from the same buffer forever — a
        // synchronous infinite loop that freezes the tab. Break and wait for the
        // next ws.onmessage to append the rest.
        const result = this.handleMessage(ws, line, lineBytes, buffer);
        if (!result) return new Uint8Array(0);
        if (this.ws !== ws) return new Uint8Array(0);
        buffer = result.buffer;
        if (!result.complete) break;
        continue;
      }

      if (line.startsWith("-ERR ")) {
        console.error("[nats-client] NATS error:", line);
        // CL2: distinguish an authoritative AUTH rejection (terminal — the same
        // credentials will never be accepted) from failures that a reconnect CAN
        // fix. Terminal = "Authorization Violation" (bad creds/perms) or
        // "Authentication Expired" (User/Account expired). NON-terminal and
        // deliberately excluded: "Authentication Timeout"/"Cancelled" (a slow or
        // sleeping client that just missed the auth window — retrying works) and
        // "Permissions Violation" (per-subject, connection stays up).
        // P1-7: split the two terminal literals into distinct cause tags. The
        // match stays a case-insensitive SUBSTRING test — real nats-server lines
        // are quoted (e.g. `-ERR 'User/Account Authentication Expired'`), so an
        // anchored/exact test would miss them. "expired" = a valid credential
        // whose TTL lapsed (benign); "violation" = a credential never/no-longer
        // acceptable (possibly revoked). Same terminal recovery, different trust
        // story — see WebChannelErrorCause.
        if (/authentication expired/i.test(line)) {
          this.failTerminally(
            `NATS credentials expired: ${line.slice(5).trim()} ` +
              `(credential TTL lapsed — reconnecting cannot help; re-authenticate)`,
            "auth-expired",
          );
          return new Uint8Array(0);
        } else if (/authorization violation/i.test(line)) {
          this.failTerminally(
            `NATS authorization rejected: ${line.slice(5).trim()} ` +
              `(credentials invalid/expired — reconnecting cannot help)`,
            "auth-rejected",
          );
          return new Uint8Array(0);
        }
        continue;
      }
    }
    if (crlfIndex(buffer) === -1 && buffer.length > MAX_CONTROL_LINE) {
      this.forceReconnect();
      return new Uint8Array(0);
    }
    return buffer;
  }

  /**
   * Parse a `MSG` line + its payload. Returns `true` when a full message was
   * consumed (caller continues draining) and `false` when the payload has not
   * fully arrived yet (the header is re-buffered; caller must STOP draining and
   * wait for more socket data — see the break in drainBuffer).
   */
  private handleMessage(ws: WebSocket, line: string, lineBytes: Uint8Array, buffer: Uint8Array): { buffer: Uint8Array; complete: boolean } | null {
    const parts = line.split(" ");
    if ((parts.length !== 4 && parts.length !== 5) || parts.some((part) => part === "")) {
      this.forceReconnect(); return null;
    }
    const hasReplyTo = parts.length === 5;
    const subject = parts[1]!;
    const lengthToken = parts[hasReplyTo ? 4 : 3]!;
    if (!/^\d+$/.test(lengthToken)) { this.forceReconnect(); return null; }
    const byteCount = Number(lengthToken);
    if (!Number.isSafeInteger(byteCount) || byteCount > MAX_PAYLOAD) { this.forceReconnect(); return null; }

    if (buffer.length < byteCount + 2) {
      const restored = new Uint8Array(lineBytes.length + 2 + buffer.length);
      restored.set(lineBytes); restored.set([13, 10], lineBytes.length); restored.set(buffer, lineBytes.length + 2);
      return { buffer: restored, complete: false };
    }

    if (buffer[byteCount] !== 13 || buffer[byteCount + 1] !== 10) { this.forceReconnect(); return null; }
    const payload = new TextDecoder().decode(buffer.slice(0, byteCount));
    buffer = buffer.slice(byteCount + 2);

    // Deliver the raw payload; decryption/parsing happens in WebChannelNatsClient
    // (the envelope must be decrypted before it is meaningful).
    this.notifyRawListeners(subject, payload, () => this.ws === ws);
    return { buffer, complete: true };
  }

  private resubscribeAll(): void {
    this.subscriptions.forEach((subject, sid) => {
      if (this.connected && this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(`SUB ${subject} ${sid}\r\n`);
      }
    });
  }

  private scheduleReconnect(): void {
    // CL2: never reconnect after a terminal auth failure.
    if (this.terminal) return;
    if (this.reconnectTimer) return;

    const baseMs = this.options.reconnectBaseMs ?? 500;
    const capMs = this.options.reconnectCapMs ?? 10000;
    const exp = Math.min(capMs, baseMs * Math.pow(2, this.reconnectAttempts));
    const delay = Math.random() * exp;

    this.reconnectAttempts++;
    console.log(`[nats-client] Reconnecting in ${Math.round(delay)}ms (attempt ${this.reconnectAttempts})`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connectInternal();
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  /**
   * F5: drop the current socket and schedule a reconnect WITHOUT entering the
   * terminal state — a SOFT reconnect. The register-hop owner
   * (`WebChannelNatsClient`) calls this to recover from a TRANSIENT registration
   * failure: the socket may still be healthy (agent offline, relay up) so
   * `onclose` never fires, and just returning would sit connected-but-keyless
   * forever. Redialing makes a fresh `onConnected` re-run registration. No-op
   * once terminal.
   */
  reconnect(): void {
    if (this.terminal) return;
    this.forceReconnect();
  }

  /**
   * CL2: enter the terminal state. Stops all reconnect activity, tears the
   * socket down, and notifies error listeners. No further redial happens until a
   * brand-new client is constructed.
   */
  private failTerminally(message: string, cause?: WebChannelErrorCause): void {
    if (this.terminal) return; // fire once
    this.terminal = true;
    this.clearReconnectTimer();
    this.stopHeartbeat();
    // Cancel the active dial's armed deadline before we null its onclose below.
    if (this.activeDialCleanup) { this.activeDialCleanup(); this.activeDialCleanup = null; }
    this.connected = false;
    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onerror = null;
      this.ws.onclose = null; // suppress the onclose→scheduleReconnect path
      try { this.ws.close(); } catch { /* already closing */ }
      this.ws = null;
    }
    // Notify the ERROR first so a downstream wrapper is already in its terminal
    // "error" status before the state event lands — otherwise the state event
    // (connected=false) would momentarily flash "reconnecting" (the wrapper's
    // sticky-error guard keys off the already-set "error" status).
    this.notifyErrorListeners(new Error(message), cause);
    this.notifyStateListeners();
  }

  /**
   * CL3: start the keepalive loop. Each tick, if the previous PING is still
   * unanswered the link is half-open → force a reconnect; otherwise send a fresh
   * PING and expect a PONG before the next tick.
   */
  private startHeartbeat(): void {
    const interval = this.options.heartbeatIntervalMs ?? 20_000;
    if (interval <= 0) return; // disabled
    this.stopHeartbeat();
    this.pongPending = false;
    this.heartbeatTimer = setInterval(() => {
      if (!this.connected || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      if (this.pongPending) {
        // No PONG since the last tick → the socket is dead but never fired
        // onclose (half-open). Force the teardown+reconnect ourselves.
        console.warn("[nats-client] heartbeat timeout — link is half-open, forcing reconnect");
        this.forceReconnect();
        return;
      }
      this.pongPending = true;
      try {
        this.ws.send("PING\r\n");
      } catch {
        this.forceReconnect();
      }
    }, interval);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.pongPending = false;
  }

  /**
   * CL3: tear a half-open socket down and schedule a reconnect. Unlike a clean
   * onclose we must drive it manually because the browser never signalled close.
   */
  private forceReconnect(): void {
    this.stopHeartbeat();
    // Cancel the active dial's armed deadline before we null its onclose below.
    if (this.activeDialCleanup) { this.activeDialCleanup(); this.activeDialCleanup = null; }
    this.connected = false;
    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onerror = null;
      this.ws.onclose = null; // we drive the reconnect; avoid a double-fire
      try { this.ws.close(); } catch { /* already closing */ }
      this.ws = null;
    }
    // R2b-2: notify EXACTLY ONCE, here — before the generation/terminal check.
    // The observable state (`connected: false`) is already final at this point,
    // and `scheduleReconnect()` below changes nothing a listener can observe, so
    // a second notify after it would be a duplicate identical `onState(false)`
    // (P0-4 review: embedders re-render twice, and the wrapper runs its release
    // gate twice). Placement is load-bearing: the generation must be captured
    // BEFORE the notification, because a listener that responds to this teardown
    // by calling disconnect() bumps it (and clears the timer).
    const gen = this.lifecycleGeneration;
    this.notifyStateListeners();
    // If disconnect() ran during the notification (generation changed) or a
    // terminal failure intervened, honor it: do NOT schedule a reconnect.
    if (this.lifecycleGeneration !== gen || this.terminal) return;
    this.scheduleReconnect();
  }

  private notifyErrorListeners(err: Error, cause?: WebChannelErrorCause): void {
    this.errorListeners.forEach((listener) => {
      try {
        listener(err, cause);
      } catch (e) {
        console.error("[nats-client] Error listener threw:", e);
      }
    });
  }

  /**
   * `isCurrent` (drain-loop callers only) is re-checked BEFORE each listener, not
   * just after the batch: a listener that synchronously retires the dial
   * (disconnect()/reconnect()) must not have the remaining listeners delivered to
   * afterwards. Partial fan-out is already the norm here — each listener is
   * independently try/caught — and an explicit teardown outranks the rest of a
   * fan-out for a socket that no longer exists.
   */
  private notifyRawListeners(subject: string, payload: string, isCurrent?: () => boolean): void {
    for (const listener of [...this.rawListeners]) {
      if (isCurrent && !isCurrent()) return;
      try {
        listener(subject, payload);
      } catch (err) {
        console.error("[nats-client] Listener error:", err);
      }
    }
  }

  /** See notifyRawListeners for why `isCurrent` is checked before EACH listener. */
  private notifyStateListeners(isCurrent?: () => boolean): void {
    for (const listener of [...this.stateListeners]) {
      if (isCurrent && !isCurrent()) return;
      try {
        listener(this.connected);
      } catch (err) {
        console.error("[nats-client] State listener error:", err);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Subject helpers
// ---------------------------------------------------------------------------

/**
 * Derive inbound NATS subject for a peer.
 * Format: webchannel.{tenant}.{accountId}.{peerId}.in
 */
export function inboundSubject(tenant: string, accountId: string, peerId: string): string {
  return `webchannel.${tenant}.${accountId}.${peerId}.in`;
}

/**
 * Derive outbound NATS subject for a peer.
 * Format: webchannel.{tenant}.{accountId}.{peerId}.out
 */
export function outboundSubject(tenant: string, accountId: string, peerId: string): string {
  return `webchannel.${tenant}.${accountId}.${peerId}.out`;
}

/**
 * Derive the register-admission NATS subject for a peer (register-hop mode).
 * Format: webchannel.{tenant}.{accountId}.{peerId}.register
 *
 * The browser drives challenge/register/unregister here via request/reply; the
 * agent subscribes the `…*.register` wildcard.
 */
export function registerSubject(tenant: string, accountId: string, peerId: string): string {
  return `webchannel.${tenant}.${accountId}.${peerId}.register`;
}

// ---------------------------------------------------------------------------
// WebChannel NATS client (high-level API)
// ---------------------------------------------------------------------------

/**
 * High-level, E2E-encrypted WebChannel NATS client.
 *
 * Wraps `NatsClient` and adds authenticated registration + MessageEnvelope v1
 * sealing the agent expects. It is FAIL-CLOSED:
 *   - outbound sends are buffered until registration establishes a session key,
 *     and are only ever published as ciphertext (never plaintext);
 *   - inbound frames are dropped until the session key exists and are decrypted
 *     before delivery.
 *
 * Subject direction (matching the agent): the browser PUBLISHES to `.in`,
 * SUBSCRIBES to `.out`, and receives its wrapped key from `.register`.
 */
export class WebChannelNatsClient {
  private readonly client: NatsClient;
  private readonly options: WebChannelNatsClientOptions;
  private readonly messageListeners = new Set<MessageListener>();
  private readonly errorListeners = new Set<ErrorListener>();
  private readonly protocolListeners = new Set<ProtocolListener>();
  private readonly sessionListeners = new Set<SessionListener>();
  private readonly sendStateListeners = new Set<SendStateListener>();
  /**
   * Send-state callbacks are public synchronous callouts. A listener may tear the
   * client down while an earlier transition is still fanning out, which can
   * synchronously produce a later transition for the same id. Drain events FIFO
   * so every listener observes the same monotonic order. Tracker mutation remains
   * synchronous at the transition site; only callback delivery is serialized.
   */
  private readonly pendingSendStateEvents: Array<{
    id: string;
    state: SendState;
    failure?: SendFailure;
  }> = [];
  private drainingSendStateEvents = false;

  /**
   * P0-4 (D4): the authoritative send-state tracker, keyed by wire `id`. The
   * SOLE authority for the monotonic guard (queued < sent < accepted; `failed`
   * terminal) — every transition point routes through `trackerAdvance`/
   * `trackerFail`, which mutate the entry BEFORE notifying and reject any invalid
   * input. Entries are retained after reaching `accepted`/`failed` so a late
   * duplicate ack (or an ack after eviction) is correctly rejected; the set is
   * conversation-bounded (the same order of magnitude as `state.messages`).
   */
  private readonly sendTracker = new Map<string, { state: SendState; failure?: SendFailure; lastAttemptAt?: number }>();
  /** Forward rank for the monotonic guard; `failed` is handled separately (terminal). */
  private static readonly SEND_RANK: Record<"queued" | "sent" | "accepted", number> = {
    queued: 0,
    sent: 1,
    accepted: 2,
  };
  /**
   * P0-4 (R5-1/R6-1): wire ids minted by `reserveWireId()` but not yet consumed
   * by `sendUserMessage`. A reserved id is guaranteed unique across this set, the
   * tracker, the outbound queue, and the unacked ledger — so no arbitrary string
   * can enter the ledger `Map` and overwrite/mis-dedupe an existing send.
   */
  private readonly reservedWireIds = new Set<string>();
  /**
   * P0-4 (D4 terminal sequence): set once a terminal (non-retryable) failure is
   * observed. After this, a new `sendUserMessage` is NOT queued — it resolves
   * immediately to an observable `failed{terminal}` receipt (so a send that
   * arrives while error listeners run cannot escape the terminal sweep).
   */
  private terminalReached = false;
  private terminalCause: WebChannelErrorCause = "unknown";
  /**
   * P0-4: connection-scoped closed gate (unlike the PERMANENT `terminalReached`).
   * Set by `disconnect()` (the only production caller is the wrapper's `close()`)
   * and cleared by a successful non-terminal `connect()`. Gates `sendUserMessage`
   * so a send registered onto an explicitly-closed instance fails observably with
   * `failed{closed}` instead of stranding at `queued` on a dead instance — closing
   * the register-before-send window where a state subscriber calls `close()` mid-
   * render (its sweep runs before this send's `sendUserMessage`), or a plain
   * `send()` lands after `close()`. Initially false: a never-connected instance is
   * NOT "disconnected", so a pre-connect send still queues and flushes on connect.
   */
  private disconnected = false;

  private sessionKey: Uint8Array | null = null;
  private outboundQueue: OutboundMessage[] = [];
  /** Non-reentrant drain: callbacks may enqueue more work, which stays at the tail. */
  private drainingOutboundQueue = false;
  /**
   * P0-7b: published-but-unacked `user_message` ledger (insertion-ordered).
   *
   * `seal()` records every published user_message that carries an `id` here; the
   * agent acks it at ingress (`ack` frame → `drainAcked`) and the entry drops. A
   * `user_message` sealed but then lost to a mid-session relay outage stays in the
   * ledger and is REPLAYED at the next `flushQueue()` (session re-establishment)
   * with the SAME id — 4a's server-side dedupe makes that replay exactly-once.
   * Only user_messages are tracked: `approval_decision` has its own loss-recovery
   * (#15 Leg C), and `load_history`/`load_commands` are stale after reconnect (the
   * register snapshot re-hydrates). `resetSession()` deliberately KEEPS this (a
   * mid-session drop is exactly when the entries are needed); `disconnect()`
   * clears it (dead instance).
   */
  private readonly unackedLedger = new Map<string, UnackedLedgerEntry>();
  /** P0-7b: cap on the unacked ledger; the oldest entry is evicted (with a warn) past this. */
  private static readonly MAX_UNACKED = 100;
  /** P0-7b: one-shot guard so a full ledger warns once per session, not per evicted send. */
  private warnedUnackedEvict = false;
  private liveRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private liveRetryTimerGeneration = 0;
  private readonly retryNow: () => number;
  private readonly retryRandom: () => number;
  private readonly retrySetTimeout: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly retryClearTimeout: (timer: ReturnType<typeof setTimeout>) => void;
  /** One resolved policy value shared with the wrapper-held recovery lane. */
  private readonly resolvedAckStallTimeoutMs: number;
  /** Start of the current per-client interval with no owned ingress result. */
  private ackStallSinceAt: number | null = null;
  /** One recovery allowance per continuous no-owned-result interval. */
  private ackStallRecoveryIssued = false;
  /** Semantic transaction fence, separate from timer and connection epochs. */
  private ackStallMutationEpoch = 0;
  /**
   * Ciphertext `.out` frames that arrived BEFORE the session key existed.
   *
   * Phase 6 race: the wrapped conversation key travels the HTTP register
   * response while the register-triggered history snapshot travels NATS —
   * two transports with no ordering guarantee, so the snapshot can land a
   * beat before `unwrapConversationKey` resolves. Dropping it would silently
   * lose the primary hydration path until the next reconnect. We buffer a
   * bounded number of frames and drain them the moment the key is set;
   * frames that still fail to decrypt are dropped (fail-closed, as ever).
   */
  private pendingInbound: string[] = [];
  private static readonly MAX_PENDING_INBOUND = 64;
  /** One-time guard so a full pre-key buffer warns once, not per dropped frame. */
  private warnedPreKeyDrop = false;
  private outSub = -1;
  /**
   * Bumped on every `onConnected()` so a stale async continuation (resumed after
   * the socket dropped and a reconnect spawned a fresh flow) can detect it is no
   * longer current and bail instead of installing stale registration state.
   */
  private connectionEpoch = 0;

  constructor(options: WebChannelNatsClientOptions) {
    if (!options.registration) {
      throw new Error("[nats-client] registration is required");
    }
    if (!options.registration.devicePrivateKey) {
      throw new Error("[nats-client] registration.devicePrivateKey is required");
    }
    if (!options.registration.deviceX25519PrivateKey) {
      throw new Error("[nats-client] registration.deviceX25519PrivateKey is required");
    }
    if (typeof options.jwt !== "string" || options.jwt.trim().length === 0) {
      throw new Error("[nats-client] non-empty bootstrap jwt is required");
    }
    const ackStallTimeoutMs = options.ackStallTimeoutMs === undefined
      ? 30_000
      : options.ackStallTimeoutMs;
    if (
      !Number.isInteger(ackStallTimeoutMs)
      || ackStallTimeoutMs < 0
      || ackStallTimeoutMs > 2_147_483_647
    ) {
      throw new RangeError(
        "[nats-client] ackStallTimeoutMs must be an integer between 0 and 2147483647",
      );
    }
    this.options = options;
    this.resolvedAckStallTimeoutMs = ackStallTimeoutMs;
    this.retryNow = options._retryNow ?? (() => Date.now());
    this.retryRandom = options._retryRandom ?? Math.random;
    this.retrySetTimeout = options._retrySetTimeout ?? ((fn, ms) => setTimeout(fn, ms));
    this.retryClearTimeout = options._retryClearTimeout ?? ((timer) => clearTimeout(timer));
    this.client = new NatsClient(options);
    this.client.onRawMessage((subject, payload) => {
      void this.handleRaw(subject, payload);
    });
    this.client.onState((connected) => {
      if (connected) void this.onConnected();
      else {
        // Raw false retires every async registration continuation before session
        // reset or the wrapper's later raw-state callback can run.
        this.connectionEpoch++;
        // A genuine socket loss is itself this episode's one recovery attempt.
        // Explicit close and terminal teardown retire the episode elsewhere.
        if (
          !this.disconnected && !this.terminalReached
          && this.hasPublishedUnackedOwnership()
          && !this.ackStallRecoveryIssued
        ) {
          this.ackStallMutationEpoch++;
          this.ackStallRecoveryIssued = true;
        }
        this.resetSession();
      }
    });
    // CL2 + P0-4: forward the low-level client's terminal auth failures. The
    // terminal SEQUENCE (D4) is mandatory: ① mark terminal so a re-entrant send
    // resolves to an immediate failed receipt, ② sweep pending (queue + ledger)
    // to failed{terminal}, THEN ③ notify error listeners (the wrapper's onError
    // fails its own held[] here) — a send arriving during ③ is immediately failed
    // by step ①, never left orphaned in a dead instance.
    this.client.onError((err, cause) => this.handleTerminal(err, cause));
  }

  /** Connect to NATS (registration begins automatically once connected). */
  connect(): void {
    // P0-4 (R5): a terminally-retired instance must not dial at all. Without this
    // a post-terminal connect() opens a raw socket whose eventual close makes the
    // low-level client (whose own `terminal` flag stays false on registration-path
    // terminals) schedule reconnects forever. Recovery is a fresh client.
    if (this.terminalReached) {
      console.warn("[nats-client] connect() ignored — this instance is terminally retired; construct a fresh client with fresh credentials");
      return;
    }
    // P0-4: a non-terminal reconnect reopens the send path — clear the closed gate
    // (AFTER the terminal guard above, so a retired instance stays retired).
    this.disconnected = false;
    this.client.connect();
  }

  /** Disconnect from NATS and drop the session. */
  disconnect(): void {
    this.connectionEpoch++;
    // P0-4: gate `sendUserMessage` BEFORE anything else so a send that arrives
    // AFTER this returns (a state subscriber calling close() mid-render, then
    // control resuming into publish()'s `sendUserMessage`; or a plain send() after
    // close()) fails observably with `failed{closed}` rather than queuing onto the
    // dead instance after its old ownership snapshot has been detached below.
    this.disconnected = true;
    // Detach ownership of THIS lifecycle's pending work before the raw transport
    // notifies state listeners. Such a listener may synchronously connect() and
    // send on the replacement lifecycle; that fresh queue/ledger must not be
    // consumed by this disconnect's trailing failure notifications.
    const pendingIds = this.takePendingSendIds();
    if (this.outSub >= 0) this.client.unsubscribe(this.outSub);
    this.outSub = -1;
    this.resetSession();
    this.client.disconnect();
    // P0-4 (B2): an explicit disconnect retires this instance — every pending
    // user_message (queued in `outboundQueue` AND published-but-unacked in the
    // ledger) fails observably with `failed{closed}`, then BOTH structures clear
    // (the old code cleared only the ledger, stranding queued sends in a dead
    // instance with no terminal transition).
    //
    // Notify only the detached lifecycle after teardown. Re-entrant replacement
    // work created by the state notification above remains live and drainable.
    this.failPendingIds(pendingIds, { reason: "closed", retryable: false });
  }

  /**
   * Send user message (buffered until the handshake completes). Returns the
   * stable wire `id` stamped on the frame so the caller can correlate a later
   * `ack` (P0-7b) or a send-state transition (P0-4) back to its local echo.
   *
   * `reservedId` (P0-4/R5-1): a wire id previously minted by `reserveWireId()`.
   * Passing it lets the wrapper register the bubble/receipt BEFORE the id's
   * synchronous state transitions fire (commit order, D4). It is consumed exactly
   * once and MUST be currently reserved and absent from the tracker/queue/ledger
   * — a violation THROWS (a programmer error, never a fabricated receipt). Omit
   * it (direct callers, tests) to self-reserve a fresh id.
   */
  sendUserMessage(text: string, reservedId?: string): string {
    const id = reservedId === undefined ? this.reserveWireId() : reservedId;
    this.consumeReservedId(id);
    // Seed without notifying. For a live send, its queue position must be owned
    // BEFORE the public queued callback: a listener can synchronously send B, and
    // B must never commit/publish ahead of A. Terminal/closed sends intentionally
    // never enter a live queue, but still expose queued→failed below.
    this.trackerInsert(id);
    if (this.terminalReached) {
      // D4 terminal sequence ①: a send arriving after a terminal failure is NOT
      // queued into a dead instance — it resolves immediately to an observable
      // failed receipt (reject-throw would break the observable-failed contract).
      this.emitSendState(id, "queued");
      this.trackerFail(id, {
        reason: "terminal",
        cause: this.terminalCause,
        retryable: false,
        lastAttemptAt: this.sendTracker.get(id)?.lastAttemptAt,
      });
      return id;
    }
    if (this.disconnected) {
      // P0-4: an explicitly-closed instance never queues a send — it resolves
      // immediately to `failed{closed}` (observable, never stuck at `queued`).
      // The wireId→receiptKey alias is set BEFORE sendUserMessage (publish/
      // maybeRelease), so the wrapper's `onSendState` handler patches the receipt
      // AND the render bubble. Fixes both the re-entrant close()-mid-render race
      // and a plain send() after close(), at the low-level layer.
      this.emitSendState(id, "queued");
      this.trackerFail(id, {
        reason: "closed",
        retryable: false,
        lastAttemptAt: this.sendTracker.get(id)?.lastAttemptAt,
      });
      return id;
    }
    // Authoritative outbound ownership precedes every public callback. A nested
    // send appends behind this entry; whichever stack frame starts the drain will
    // therefore publish in logical call order.
    this.outboundQueue.push({ type: "user_message", text, id });
    this.emitSendState(id, "queued");
    this.drainOutboundQueue();
    return id;
  }

  /**
   * P0-4: validate + consume a wire id. It must be currently reserved and not yet
   * present in the tracker/queue/ledger; on success it leaves `reservedWireIds`.
   * Any violation throws (programmer error — an unreserved/reused/in-flight id
   * must never reach the ledger `Map`).
   */
  private consumeReservedId(id: string): void {
    if (!this.reservedWireIds.has(id)) {
      throw new Error("[nats-client] sendUserMessage: wire id was not reserved via reserveWireId()");
    }
    if (
      this.sendTracker.has(id) ||
      this.unackedLedger.has(id) ||
      this.outboundQueue.some((m) => m.type === "user_message" && m.id === id)
    ) {
      throw new Error("[nats-client] sendUserMessage: reserved wire id is already in use");
    }
    this.reservedWireIds.delete(id);
  }

  /** Send approval decision (buffered until the handshake completes). */
  sendApprovalDecision(id: string, decision: string): void {
    this.enqueue({ type: "approval_decision", id, decision });
  }

  /** Request history page (buffered until the handshake completes). */
  loadHistory(before?: string, limit?: number): void {
    this.enqueue({ type: "load_history", before, limit });
  }

  /** Request the slash-command catalog (buffered until the handshake completes). */
  loadCommands(): void {
    this.enqueue({ type: "load_commands" });
  }

  /** Add decrypted-message listener. */
  onMessage(listener: MessageListener): () => void {
    this.messageListeners.add(listener);
    return () => { this.messageListeners.delete(listener); };
  }

  /** Add connection state listener. */
  onState(listener: StateListener): () => void {
    return this.client.onState(listener);
  }

  /** Add error listener (e.g. PoP registration failure). */
  onError(listener: ErrorListener): () => void {
    this.errorListeners.add(listener);
    return () => { this.errorListeners.delete(listener); };
  }

  /**
   * Add a register-handshake protocol listener. Fires once per successful
   * protocol-v2 register with the agent-plugin's required protocol version and
   * optional package version. Missing, malformed, or mismatched protocol values
   * do not fire this — they flow through `onError` as terminal failures.
   */
  onProtocol(listener: ProtocolListener): () => void {
    this.protocolListeners.add(listener);
    return () => { this.protocolListeners.delete(listener); };
  }

  /**
   * P1-9: add a session-established listener. Fires once per key establishment
   * (register-delivered K and legacy handshake), strictly AFTER `flushQueue()`
   * — so a listener that publishes (releasing held sends) is ordered behind the
   * P0-7b ledger replay that `flushQueue()` moved to the front of the wire.
   */
  onSession(listener: SessionListener): () => void {
    this.sessionListeners.add(listener);
    return () => { this.sessionListeners.delete(listener); };
  }

  /** @internal The constructor-resolved shared application stall policy. */
  getAckStallTimeoutMs(): number {
    return this.resolvedAckStallTimeoutMs;
  }

  /**
   * @internal Request the existing reconnect/register/replay recovery path.
   * The caller owns its lane allowance; this method also consumes an active
   * published-work allowance and retires live scheduling before the callout.
   */
  requestApplicationRecovery(): boolean {
    if (this.disconnected || this.terminalReached) return false;
    if (this.hasPublishedUnackedOwnership() && !this.ackStallRecoveryIssued) {
      this.ackStallMutationEpoch++;
      this.ackStallRecoveryIssued = true;
    }
    const epoch = this.connectionEpoch;
    this.cancelLiveRetryTimer();
    if (
      this.connectionEpoch !== epoch || this.disconnected || this.terminalReached
    ) {
      return false;
    }
    this.client.reconnect();
    return true;
  }

  /**
   * P0-4: subscribe to authoritative send-state transitions (queued/sent/
   * accepted/failed) keyed by wire `id`. Fires only on VALID monotonic
   * transitions; returns an unsubscribe.
   */
  onSendState(listener: SendStateListener): () => void {
    this.sendStateListeners.add(listener);
    return () => { this.sendStateListeners.delete(listener); };
  }

  /**
   * Read the already-mutated authoritative tracker without affecting serialized
   * callback delivery. A higher-level receipt can therefore report a transition
   * that has synchronously happened even when its `onSendState` event is queued
   * behind an older event's fanout. Return copies so callers cannot mutate the
   * tracker through this package-internal seam. @internal
   */
  getSendStateSnapshot(id: string): { state: SendState; failure?: SendFailure } | undefined {
    const entry = this.sendTracker.get(id);
    if (!entry) return undefined;
    return {
      state: entry.state,
      failure: entry.failure ? { ...entry.failure } : undefined,
    };
  }

  /**
   * P0-4 (R5-1/R6-1): mint a unique wire id and RESERVE it, one-shot. The wrapper
   * calls this BEFORE creating the bubble/receipt so a `sendUserMessage(text, id)`
   * lands its synchronous `queued`/immediate-`failed` transition on an
   * already-registered receipt. The candidate is regenerated until it collides
   * with nothing in `reservedWireIds`, the tracker, the outbound queue, or the
   * unacked ledger; a bounded 8-attempt exhaustion throws BEFORE the wrapper
   * records anything (a broken RNG stub can never mint an orphaned receipt).
   *
   * Package-internal — `WebChannelNatsClient` is not exported from the barrel, so
   * this is not public API. @internal
   */
  reserveWireId(): string {
    for (let attempt = 0; attempt < 8; attempt++) {
      const candidate = randomInboxToken();
      if (
        !this.reservedWireIds.has(candidate) &&
        !this.sendTracker.has(candidate) &&
        !this.unackedLedger.has(candidate) &&
        !this.outboundQueue.some((m) => m.type === "user_message" && m.id === candidate)
      ) {
        this.reservedWireIds.add(candidate);
        return candidate;
      }
    }
    throw new Error("[nats-client] reserveWireId: could not mint a unique id after 8 attempts");
  }

  // ---------------------------------------------------------------------------
  // Internal — handshake + crypto
  // ---------------------------------------------------------------------------

  private resetSession(): void {
    this.cancelLiveRetryTimer();
    this.sessionKey = null;
    // Frames buffered for a dead session are ciphertext under a key we no
    // longer (or never will) hold — drop them; fresh registration
    // re-hydrates.
    this.pendingInbound = [];
    // Re-arm the one-time pre-key-drop warning for the next session.
    this.warnedPreKeyDrop = false;
    // P0-7b: re-arm the ledger-eviction warning too (the ledger itself SURVIVES
    // resetSession — this only lets a fresh session warn once again).
    this.warnedUnackedEvict = false;
  }

  /**
   * Decrypt + deliver the `.out` frames that arrived before the session key
   * was established (see `pendingInbound`). Called immediately after the key
   * is set from the register-delivered K.
   */
  private drainPendingInbound(): void {
    if (!this.sessionKey || this.pendingInbound.length === 0) return;
    const pending = this.pendingInbound;
    this.pendingInbound = [];
    for (const payload of pending) {
      // A delivered frame's listener can synchronously tear the session down
      // (disconnect() → resetSession nulls sessionKey). Bail mid-loop rather than
      // decrypting the rest against a key that no longer belongs to this session.
      if (!this.sessionKey) return;
      const msg = openMessage(payload, this.sessionKey) as InboundMessage | null;
      if (msg) this.deliverInbound(msg);
    }
  }

  /**
   * Deliver a decrypted inbound frame. P0-7b: an `ack` frame first drains the
   * matching ids from the unacked ledger, then (like every other frame) is
   * forwarded to the message listeners — the wrapper reducer consumes it too.
   */
  private deliverInbound(msg: InboundMessage): void {
    if (msg.type === "ack") this.drainAcked(msg.ids);
    if (msg.type === "inbound_rejected" && msg.reason === "overloaded") {
      this.drainRejected(msg.ids);
    }
    this.notifyMessageListeners(msg);
  }

  /**
   * P0-7b: remove acked ids from the unacked ledger; unknown ids are a no-op.
   * P0-4: also advance each acked id to `accepted` (the tracker's guard makes a
   * duplicate/late/post-terminal ack a no-op).
   */
  private drainAcked(ids?: string[]): void {
    if (!ids) return;
    this.drainOwnedResult([...new Set(ids)], (id) => {
      this.trackerAdvance(id, "accepted");
    });
  }

  private drainRejected(ids?: string[]): void {
    if (!ids) return;
    this.drainOwnedResult([...new Set(ids)], (id) => {
      this.trackerFail(id, {
        reason: "overloaded",
        retryable: true,
        lastAttemptAt: this.sendTracker.get(id)?.lastAttemptAt,
      });
    });
  }

  /**
   * Detach a complete authenticated result frame before tracker fanout. Only a
   * frame that owned at least one ledger id on entry proves application ingress
   * and starts a fresh interval for any PUBLISHED work that remains.
   */
  private drainOwnedResult(frameIds: string[], apply: (id: string) => void): void {
    const ownedResult = frameIds.some((id) => this.unackedLedger.has(id));
    const epoch = this.connectionEpoch;
    const key = this.sessionKey;
    const lifecycleLive = !this.disconnected && !this.terminalReached;

    for (const id of frameIds) this.unackedLedger.delete(id);

    // Unknown/late ids remain tracker no-ops and do not disturb the live episode
    // or its timer. The frame still fans out authoritatively below.
    if (!ownedResult) {
      for (const id of frameIds) apply(id);
      return;
    }

    const resultEpoch = ++this.ackStallMutationEpoch;
    const publishedOwnershipRemains = this.hasPublishedUnackedOwnership();
    // A final PUBLISHED result retires every episode field before the reentrant
    // clear hook. A null retry deadline is provisional pre-publish ownership
    // installed by seal(); it stays ledgered for that seal's exact rollback, but
    // cannot start or preserve an acknowledgement-stall episode before its first
    // successful raw publish. With genuinely published ownership remaining,
    // resultEpoch already invalidates the old timer semantically, while keeping
    // the old timestamp visible lets a same-episode nested send join without
    // creating a competing episode. The fresh result age is committed after
    // cancellation below.
    if (!publishedOwnershipRemains) {
      this.ackStallSinceAt = null;
      this.ackStallRecoveryIssued = false;
    }
    this.cancelLiveRetryTimer();

    let resultCommitEpoch: number | null = null;
    let resultAt: number | null = null;
    let postCommitTimerGeneration: number | null = null;
    let schedulingSnapshot: LedgerSchedulingSnapshot | null = null;
    if (
      publishedOwnershipRemains && lifecycleLive && key !== null
      && this.connectionEpoch === epoch && this.sessionKey === key
      && !this.disconnected && !this.terminalReached
      && this.ackStallMutationEpoch === resultEpoch
      && this.hasPublishedUnackedOwnership()
    ) {
      const sampledResultAt = this.retryNow();
      if (
        this.connectionEpoch === epoch && this.sessionKey === key
        && !this.disconnected && !this.terminalReached
        && this.ackStallMutationEpoch === resultEpoch
        && this.hasPublishedUnackedOwnership()
      ) {
        resultCommitEpoch = ++this.ackStallMutationEpoch;
        resultAt = sampledResultAt;
        this.ackStallSinceAt = sampledResultAt;
        this.ackStallRecoveryIssued = false;
        // A timer may have been installed reentrantly during cancellation
        // against the old interval. The semantic commit above invalidates its
        // captured fields. Preserve its generation through tracker fanout; the
        // final guarded armer will cancel and recompute it from the fresh age.
        postCommitTimerGeneration = this.liveRetryTimerGeneration;
        schedulingSnapshot = this.captureLedgerScheduling();
      }
    }

    // These outcomes belong to the already-detached authenticated frame even if
    // an injected hook or an earlier tracker listener replaced the lifecycle.
    for (const id of frameIds) apply(id);

    if (
      !publishedOwnershipRemains || resultCommitEpoch === null || resultAt === null
      || postCommitTimerGeneration === null || schedulingSnapshot === null
    ) {
      return;
    }
    if (
      this.connectionEpoch !== epoch || this.sessionKey !== key
      || this.disconnected || this.terminalReached
      || this.ackStallMutationEpoch !== resultCommitEpoch
      || this.ackStallSinceAt !== resultAt || this.ackStallRecoveryIssued
      || this.liveRetryTimerGeneration !== postCommitTimerGeneration
      || !this.ledgerSchedulingMatches(schedulingSnapshot)
    ) {
      return;
    }
    this.armLiveRetryTimer();
  }

  private hasPublishedUnackedOwnership(): boolean {
    for (const entry of this.unackedLedger.values()) {
      if (entry.published) return true;
    }
    return false;
  }

  private async onConnected(): Promise<void> {
    // P0-4 (R4): a terminally-retired instance must NOT re-register. A
    // registration-path terminal sets `terminalReached` but leaves the raw
    // transport non-terminal, so an explicit `connect()` can still redial and fire
    // this handler; without this guard a now-valid register reply would establish
    // a session and fire `onSession` on a dead instance (reviving sessionEstablished
    // / the staleness valve while every send immediate-fails). Recovery is a fresh
    // client, never this one.
    // R5: defensively tear the socket down here too — closing the race where a
    // socket dialed BEFORE the latch was set opens after it (a scheduled reconnect
    // firing, or a connect() that slipped in). disconnect() clears the reconnect
    // timer + nulls onclose, so the low-level client stops redialing for good.
    if (this.terminalReached) {
      this.client.disconnect();
      return;
    }
    const { tenant, accountId, peerId } = this.options;
    // Mark this flow as the current connection generation. Any `await` below
    // re-checks `this.connectionEpoch === epoch` so a continuation resumed after
    // a drop+reconnect bails instead of clobbering the fresh flow's state.
    const epoch = ++this.connectionEpoch;
    const connectionGeneration = this.client.currentConnectionGeneration();
    const { registration } = this.options;

    // (Re)subscribe idempotently: unsubscribe stale sids so a reconnect never
    // leaves duplicate subscriptions delivering the same MSG twice. `.out` MUST
    // be active BEFORE the register hop: the agent sends the initial history
    // snapshot from the register route, and core NATS has no retention.
    if (this.outSub >= 0) this.client.unsubscribe(this.outSub);
    this.outSub = this.client.subscribe(outboundSubject(tenant, accountId, peerId));

    // Fresh connection → fresh key establishment.
    this.resetSession();
    // resetSession() clears an injected timer handle. That clear hook is an
    // embedder callout and may synchronously disconnect/reconnect, replacing the
    // raw generation underneath this stack. Never let the abandoned flow issue
    // registration against the replacement socket.
    if (!this.connectionFlowMatches(epoch, connectionGeneration)) return;

    // PoP registration over NATS request/reply (production). MUST complete AFTER
    // we subscribe to .out (above) but BEFORE any key flows — the agent only
    // subscribes to this peer's subjects once registered, and NATS has no
    // retention. Fail-closed: if registration throws, registration failure is
    // TERMINAL for this connection. A PoP/JWT rejection is typically a permanent
    // credential problem, so beyond registerWithPop's own bounded retry-on-
    // timeout we do NOT silently loop: we tear the connection fully down via the
    // raw NatsClient.disconnect() (clears the reconnect timer + closes the
    // socket, leaving connected === false). The application must react to onError
    // and re-initialize with fresh credentials (a new bootstrap JWT).
    {
      let registerResult: Awaited<ReturnType<typeof registerWithPop>>;
      try {
        const registerSubj = registerSubject(tenant, accountId, peerId);
        // In-namespace reply inbox: the browser's tenant-wide creds already cover
        // pub+sub on `webchannel.{tenant}.>`, so no separate `_INBOX.>` grant is
        // needed (and none is broadened across tenants).
        const replyPrefix = `webchannel.${tenant}.${accountId}.${peerId}.reginbox`;
        registerResult = await registerWithPop({
          request: async (body) => {
            const raw = await this.client.request(registerSubj, JSON.stringify(body), {
              timeoutMs: 5000,
              replyPrefix,
            });
            return JSON.parse(raw) as unknown;
          },
          jwt: this.options.jwt,
          peerId,
          devicePrivateKey: registration.devicePrivateKey,
        });
      } catch (err) {
        // Epoch guard (mirrors the success path below): a reconnect during the
        // register round-trip may have already spawned a newer onConnected, so a
        // stale flow must not tear down or redial the live connection.
        if (!this.connectionFlowMatches(epoch, connectionGeneration)) return;
        console.error("[nats-client] PoP registration failed:", err);
        if (isTerminalRegisterError(err)) {
          // Rejected proof/token or a non-transient server failure — the SAME
          // bootstrap credentials will never be accepted. Terminal: surface the
          // (original) error and tear the socket fully down. disconnect() clears
          // the reconnect timer and nulls onclose, so nothing redials; only a
          // fresh client (new bootstrap JWT) can recover.
          // P1-7: classify the foreign throw into a cause tag (it keeps its own
          // class identity — the cause rides alongside).
          const cause: WebChannelErrorCause =
            err instanceof PopRejectedError ? "auth-rejected"
            : err instanceof ProtocolMismatchError ? "protocol-mismatch"
            : err instanceof PopCapacityError ? "capacity"
            : err instanceof PopServerError ? "server"
            : "unknown";
          // P0-4: failConnectionEpoch now folds the D4 terminal sweep in BEFORE
          // notifying (mark terminal → fail queued/ledgered sends observably →
          // notify → generation-precise disconnect), so a later send resolves to
          // failed{terminal} instead of re-queuing into a dead instance while the
          // P1-3 epoch/generation retirement stays intact.
          this.failConnectionEpoch(epoch, connectionGeneration, err as Error, cause);
          return;
        }
        // TRANSIENT (B4): request timeout, 503, or agent-offline retry-
        // exhaustion. The credentials are fine — the agent/relay was momentarily
        // unreachable. Critically, registerWithPop can exhaust its bounded
        // retries while the WS stays UP (agent offline, relay healthy), so
        // onclose never fires; merely returning here would leave the client
        // connected-but-keyless FOREVER with messages queueing. Actively redial
        // (soft reconnect — reconnection stays armed) so a fresh onConnected
        // re-attempts registration; this loops with backoff until the agent
        // returns.
        console.warn(
          "[nats-client] registration failed transiently — redialing to re-attempt registration",
        );
        this.client.reconnect();
        return;
      }
      // The socket may have dropped during the register round-trip; a reconnect
      // would have spawned a newer onConnected. Bail so this stale flow does not
      // establish a key for a connection generation that is no longer current.
      if (!this.connectionFlowMatches(epoch, connectionGeneration)) return;

      // Wire-protocol handshake (mirrors the :1080 pin-failure style). The plugin
      // echoes its protocol + package versions in the register reply:
      //   - absent/malformed         → already rejected terminally by registerWithPop.
      //   - present but mismatched   → TERMINAL: the two sides speak incompatible
      //     wire contracts, so surface a two-sided diagnostic and disconnect
      //     (only upgrading the older side, or a fresh client, can recover).
      //   - match                    → proceed; expose both versions on state.
      const agentProtocolVersion = registerResult.protocolVersion;
      const agentPluginVersion =
        typeof registerResult.pluginVersion === "string" ? registerResult.pluginVersion : null;
      if (agentProtocolVersion !== WEBCHANNEL_PROTOCOL_VERSION) {
        const err = new Error(
          `webchannel protocol mismatch: client=${WEBCHANNEL_PROTOCOL_VERSION} ` +
            `agent-plugin=${agentProtocolVersion}; upgrade the older side`,
        );
        // P1-7: re-auth cannot reconcile incompatible wire versions.
        // P0-4: failConnectionEpoch folds the terminal sweep in (sweep pending →
        // notify), not a bare notify — and keeps the P1-3 generation retirement.
        this.failConnectionEpoch(epoch, connectionGeneration, err, "protocol-mismatch");
        return;
      }
      this.notifyProtocolListeners({
        protocolVersion: agentProtocolVersion,
        pluginVersion: agentPluginVersion,
      });
      if (!this.connectionFlowMatches(epoch, connectionGeneration)) return;

      {
        // Register-delivered key: unwrap K with the cnf device private key.
        // Fail-closed and TERMINAL on any miss — we never fall back to the
        // handshake here (the plugin does not answer it on this path, and a
        // downgrade would let a tampering relay strip the delivered key).
        const wrapped = registerResult.wrappedConversationKey;
        if (!wrapped) {
          const err = new Error(
            "[nats-client] register response carried no wrappedConversationKey " +
              "(plugin does not support the register-delivered key model)",
          );
          // P1-7: the plugin speaks an incompatible register contract — a
          // capability mismatch, upgrade the older side (re-auth cannot help).
          // P0-4: failConnectionEpoch folds the terminal sweep in (sweep pending
          // → notify), preserving the P1-3 generation retirement.
          this.failConnectionEpoch(epoch, connectionGeneration, err, "protocol-mismatch");
          return;
        }
        // F2 fail-closed: the register-delivered K is authenticated by deriving
        // the unwrap key from the SaaS-pinned agent identity public key. Without
        // it the browser has no way to distinguish the genuine agent's K from a
        // relay-injected K′, so a missing pin is TERMINAL (never derive from the
        // wire). The pin arrives with the first-party HTTPS bootstrap response.
        if (!registration.pinnedAgentPublicKey) {
          const err = new Error(
            "[nats-client] register-delivered key requires a pinned agent public key " +
              "(bootstrap response carried no agentPublicKey) — refusing to unwrap K " +
              "against an unauthenticated wire key",
          );
          // P1-7: NOT "config" — the pin rides the SaaS bootstrap response, so
          // re-auth (which refetches bootstrap) can genuinely deliver it. Hiding
          // the re-auth affordance here would strand a recoverable state.
          // P0-4: failConnectionEpoch folds the terminal sweep in (sweep pending
          // → notify), preserving the P1-3 generation retirement.
          this.failConnectionEpoch(epoch, connectionGeneration, err, "secure-channel-failed");
          return;
        }
        let key: Uint8Array;
        try {
          // v3 freshness anchor: `registerResult.clientNonce` is the value THIS
          // browser generated for the successful register attempt — it is not,
          // and must never become, a field read out of the register reply. An
          // echoed anchor would be a relay-chosen anchor, and a captured register
          // reply would then replay cleanly onto a fresh attempt.
          key = await unwrapConversationKey(
            wrapped,
            registration.deviceX25519PrivateKey,
            registration.pinnedAgentPublicKey,
            peerId,
            registerResult.clientNonce,
          );
        } catch (err) {
          if (!this.connectionFlowMatches(epoch, connectionGeneration)) return;
          console.error("[nats-client] conversation-key unwrap failed:", err);
          // P1-7: the E2E session could not be established (bad/tampered key or a
          // stale pin) — re-auth to retry with fresh keys.
          // P0-4: failConnectionEpoch folds the terminal sweep in (sweep pending
          // → notify), preserving the P1-3 generation retirement.
          this.failConnectionEpoch(epoch, connectionGeneration, err as Error, "secure-channel-failed");
          return;
        }
        if (!this.connectionFlowMatches(epoch, connectionGeneration)) return;
        this.sessionKey = key;
        // drainPendingInbound() synchronously invokes message listeners; one that
        // calls disconnect()+connect() advances the epoch under us. Re-check before
        // flushing/notifying so a stale flow never publishes on — or fires a false
        // "session established" for — a connection generation that is no longer
        // current (session listeners gate P1-9 unsend-hold release).
        this.drainPendingInbound();
        if (!this.sessionFlowMatches(epoch, connectionGeneration, key)) return;
        this.flushQueue();
        if (!this.sessionFlowMatches(epoch, connectionGeneration, key)) return;
        // P1-9: notify AFTER flushQueue so a released hold is ordered behind the
        // P0-7b ledger replay (drain → flush → notify; see onSession).
        this.notifySessionListeners(() => this.sessionFlowMatches(epoch, connectionGeneration, key));
        return;
      }
    }
  }

  private connectionFlowMatches(epoch: number, connectionGeneration: number): boolean {
    return this.connectionEpoch === epoch
      && this.client.currentConnectionGeneration() === connectionGeneration
      && !this.disconnected
      && !this.terminalReached;
  }

  private sessionFlowMatches(
    epoch: number,
    connectionGeneration: number,
    key: Uint8Array,
  ): boolean {
    return this.connectionFlowMatches(epoch, connectionGeneration) && this.sessionKey === key;
  }

  /**
   * Guard terminal handling across both stale async flows and sync listener
   * re-entry (P1-3), AND fold in the P0-4 D4 terminal sweep. Register/handshake
   * terminal sites route here (epoch + generation in scope); the raw transport
   * path routes through `handleTerminal` instead (no epoch).
   */
  private failConnectionEpoch(
    epoch: number, connectionGeneration: number, err: Error, cause: WebChannelErrorCause,
  ): void {
    if (this.connectionEpoch !== epoch) return;
    // P0-4 D4 ①②: mark terminal + sweep queued/ledgered sends to failed{terminal}
    // BEFORE embedder code runs — a send arriving during the notify below is
    // caught by `terminalReached` and immediate-fails, never re-queued into a
    // dead instance. Idempotent, so re-entry through the guard is harmless.
    this.markTerminalAndSweep(cause);
    // Retire the failed epoch BEFORE invoking embedder code, so a stale
    // continuation of THIS flow (e.g. a late unwrap resolve/reject still on the
    // stack) that resumes after notification sees a bumped epoch and stays inert.
    // Note: under the P0-4 retirement contract `markTerminalAndSweep` above has
    // already set `terminalReached`, so an error listener's synchronous
    // `connect()` is refused (no replacement dial is ever created — recovery is a
    // fresh instance); the retire-before-notify here is no longer guarding a
    // replacement socket, but it remains load-bearing for the same-flow late
    // continuations covered by the epoch-guard tests.
    const retiredEpoch = ++this.connectionEpoch;
    this.notifyErrorListeners(err, cause);
    if (this.connectionEpoch !== retiredEpoch) return;
    this.client.disconnectConnectionGeneration(connectionGeneration);
  }

  private async handleRaw(subject: string, payload: string): Promise<void> {
    const { tenant, accountId, peerId } = this.options;

    if (subject === outboundSubject(tenant, accountId, peerId)) {
      if (!this.sessionKey) {
        // Fail-closed, but not lossy: buffer (bounded) until the key exists —
        // the register-triggered snapshot can beat the HTTP-delivered key by a
        // beat (see `pendingInbound`). Never processed as plaintext.
        if (this.pendingInbound.length < WebChannelNatsClient.MAX_PENDING_INBOUND) {
          this.pendingInbound.push(payload);
        } else if (!this.warnedPreKeyDrop) {
          // Buffer full before the key arrived → this sealed frame is dropped
          // (never plaintext-processed). Make it observable — a full pre-key
          // buffer means an unusually slow register/key delivery. Warn once so a
          // burst doesn't spam; the flag re-arms on the next connection.
          this.warnedPreKeyDrop = true;
          console.warn(
            `[nats-client] pre-key inbound buffer full (${WebChannelNatsClient.MAX_PENDING_INBOUND}); ` +
              `dropping a sealed frame received before the conversation key was established`,
          );
        }
        return;
      }
      const msg = openMessage(payload, this.sessionKey) as InboundMessage | null;
      if (msg) this.deliverInbound(msg);
      return;
    }
  }

  private enqueue(message: OutboundMessage): void {
    this.outboundQueue.push(message);
    this.drainOutboundQueue();
  }

  private flushQueue(): void {
    if (!this.sessionKey) return;
    // P0-7b: replay published-but-unacked user_messages FIRST — this choke point
    // runs exactly when a session key is (re)established (register-delivered K and
    // legacy-handshake paths both). Move ledger entries, in insertion order, to
    // the FRONT of the queue (ahead of anything already queued), then clear the
    // ledger; each re-enters it as `seal()` re-publishes. Same id on every replay,
    // so 4a's ingress dedupe makes a re-delivery exactly-once.
    if (this.unackedLedger.size > 0) {
      const replay = [...this.unackedLedger.values()].map((entry) => entry.message);
      this.unackedLedger.clear();
      this.outboundQueue = [...replay, ...this.outboundQueue];
    }
    this.drainOutboundQueue();
  }

  /**
   * Drain only the ordinary outbound queue. Reconnect-only ledger replay is
   * prepended by `flushQueue()` once per established session; live sends must not
   * replay the entire unacked ledger. Nested sends append to this same live queue
   * and the outer drain consumes them FIFO without recursive sealing.
   */
  private drainOutboundQueue(): void {
    if (this.drainingOutboundQueue) return;
    this.drainingOutboundQueue = true;
    try {
      // P0-4 (review R1): drain the queue LIVE — shift one entry per iteration —
      // rather than snapshotting it into a local array and clearing the field up
      // front. `seal()` publishes synchronously, which runs `trackerAdvance(…,
      // "sent")` → the wrapper's receipt/bubble `setState` → the embedder's state
      // subscribers, MID-LOOP. A perfectly ordinary subscriber (route change,
      // unmount, logout) may call `close()` there. With a snapshot the remaining
      // entries live in NEITHER `outboundQueue` NOR `unackedLedger` for the length
      // of the loop, so the `failAllPending()` sweep inside that `disconnect()`
      // cannot see them; the loop then resumes and `seal()` re-pushes them onto a
      // closed instance whose sweep will never run again — permanently `queued`,
      // the exact invariant P0-4 exists to eliminate. (Same hole on the terminal
      // path: `markTerminalAndSweep` would likewise miss the in-flight array.) A
      // live drain keeps the remainder genuinely present in `outboundQueue`, so
      // every sweep sees it. This mirrors the deliberate live-`shift()` discipline
      // in the wrapper's `maybeRelease()`, which is why the release path is immune.
      //
      // The `this.sessionKey` condition is LOAD-BEARING, not a re-check for tidiness:
      // `seal()` fail-closes by re-pushing to the TAIL when the key is gone, so an
      // unconditional `while (length > 0)` would shift-and-re-push the same frame
      // forever. With the guard, a mid-loop session teardown just leaves the
      // remainder queued in order — swept to failed{closed}/failed{terminal} if the
      // instance was closed/retired, or replayed at the next flushQueue() on a plain
      // reconnect (pre-existing behavior), with no reordering either way.
      while (this.sessionKey && this.outboundQueue.length > 0) {
        this.seal(this.outboundQueue.shift()!);
      }
    } finally {
      this.drainingOutboundQueue = false;
    }
  }

  private seal(message: OutboundMessage): void {
    if (!this.sessionKey) {
      // Fail-closed: never publish plaintext; re-queue until the key exists.
      this.outboundQueue.push(message);
      return;
    }
    const sealingKey = this.sessionKey;
    const sealingConnectionEpoch = this.connectionEpoch;
    const sealingMutationEpoch = this.ackStallMutationEpoch;
    const { tenant, accountId, peerId } = this.options;
    // P0-7b: record a user_message in the unacked ledger BEFORE publishing so it
    // can be replayed if the session drops before the agent acks it. Recording
    // first (not after publish) means a fast ack can't race ahead of the record
    // and leave a drained id re-inserted. Only user_messages (see `unackedLedger`);
    // an id-less frame from a caller that bypassed sendUserMessage is not
    // replayable and is skipped.
    //
    // P0-4 (review R2/R3): `recordUnacked` returns inert insertion/eviction
    // metadata rather than notifying or consulting injected retry hooks inline.
    // Nothing between the `sessionKey` fail-closed check above and `sealMessage()` below
    // may call into embedder code: a subscriber reached from here can `close()`,
    // which nulls `sessionKey` mid-seal (TS narrowing from the top-of-function
    // check hides it), and `null` then flows into the AEAD as a raw TypeError
    // thrown straight out of `send()`. Audited: this interval contains only
    // Map/object reads and writes; clock/random/timer/warning work begins after
    // sealing. Keeping it that way makes the seal atomic — hence no
    // defensive re-check before `sealMessage()`, which would be dead code (and a
    // re-queue there would strand the frame on an already-swept closed instance).
    let evicted: string[] = [];
    let warnEviction = false;
    let provisionallyInserted = false;
    if (message.type === "user_message" && message.id) {
      ({ evicted, warnEviction, inserted: provisionallyInserted } =
        this.recordUnacked(message.id, message));
    }
    const wire = sealMessage({ accountId, tenant, sub: peerId }, sealingKey, message);
    const finishPostSeal = () => {
      if (warnEviction) {
        console.warn(
          `[nats-client] unacked ledger exceeded ${WebChannelNatsClient.MAX_UNACKED}; ` +
            `evicting the oldest unacked message(s) — they will not be replayed on reconnect`,
        );
      }
      for (const id of evicted) {
        this.trackerFail(id, {
          reason: "evicted",
          retryable: true,
          lastAttemptAt: this.sendTracker.get(id)?.lastAttemptAt,
        });
      }
    };
    // P0-4 (D3): stamp the attempt time on every publish attempt (R1-F10), then
    // consume the publish result. On success a user_message advances to `sent`;
    // on failure it stays `queued` (no emit) — it remains in the ledger and the
    // publish-driven forceReconnect replays it, so a live process never reports
    // false success. Non-replicated frames only warn on failure (§5 recovery lanes).
    if (message.type === "user_message" && message.id) {
      const messageId = message.id;
      const ledgerEntry = this.unackedLedger.get(messageId);
      const finishInvalidatedPrePublish = () => {
        // An injected retry hook may synchronously deliver an owned result for
        // an OLDER message. That result legitimately advances the episode's
        // mutation epoch, but this newly inserted message still has not been
        // published or given a retry deadline. Put that exact owner back at the
        // front of the live drain (ahead of messages created by result
        // callbacks), then let the next seal establish ordinary scheduling.
        // Every other invalidation is fail-closed: never revive an entry that
        // was itself detached, replaced, scheduled, or moved to another
        // lifecycle.
        if (
          provisionallyInserted && ledgerEntry
          && this.unackedLedger.get(messageId) === ledgerEntry
          && ledgerEntry.nextRetryAt === null
          && this.sessionKey === sealingKey
          && this.connectionEpoch === sealingConnectionEpoch
          && this.ackStallMutationEpoch !== sealingMutationEpoch
          && !this.disconnected && !this.terminalReached
        ) {
          this.unackedLedger.delete(messageId);
          this.outboundQueue.unshift(message);
        }
        finishPostSeal();
      };
      if (
        !ledgerEntry || this.unackedLedger.get(message.id) !== ledgerEntry
        || this.sessionKey !== sealingKey
        || this.connectionEpoch !== sealingConnectionEpoch
        || this.ackStallMutationEpoch !== sealingMutationEpoch
        || this.disconnected || this.terminalReached
      ) {
        finishPostSeal();
        return;
      }
      let initialRetryDelay: number | null = null;
      if (ledgerEntry.nextRetryAt === null) {
        // Resolve injected retry randomness before sampling the one publish
        // clock. Either hook may synchronously replace the lifecycle.
        initialRetryDelay = this.retryDelay(ledgerEntry.retryCount);
        if (
          this.unackedLedger.get(message.id) !== ledgerEntry
          || this.sessionKey !== sealingKey
          || this.connectionEpoch !== sealingConnectionEpoch
          || this.ackStallMutationEpoch !== sealingMutationEpoch
          || this.disconnected || this.terminalReached
        ) {
          finishInvalidatedPrePublish();
          return;
        }
      }
      const attemptAt = this.retryNow();
      if (
        this.unackedLedger.get(message.id) !== ledgerEntry
        || this.sessionKey !== sealingKey
        || this.connectionEpoch !== sealingConnectionEpoch
        || this.ackStallMutationEpoch !== sealingMutationEpoch
        || this.disconnected || this.terminalReached
      ) {
        finishInvalidatedPrePublish();
        return;
      }
      if (initialRetryDelay !== null) ledgerEntry.nextRetryAt = attemptAt + initialRetryDelay;
      const entry = this.sendTracker.get(message.id);
      if (entry) entry.lastAttemptAt = attemptAt;

      // No injected/public hook is allowed between this exact fence and the raw
      // publish. Ciphertext for a retired key or ledger owner is never sent.
      if (
        this.unackedLedger.get(message.id) !== ledgerEntry
        || this.sessionKey !== sealingKey
        || this.connectionEpoch !== sealingConnectionEpoch
        || this.ackStallMutationEpoch !== sealingMutationEpoch
        || this.disconnected || this.terminalReached
      ) {
        finishPostSeal();
        return;
      }
      const ok = this.client.publish(inboundSubject(tenant, accountId, peerId), wire);
      if (ok) {
        let publishedMutationEpoch: number | null = null;
        let schedulingSnapshot: LedgerSchedulingSnapshot | null = null;
        if (
          this.unackedLedger.get(message.id) === ledgerEntry
          && this.sessionKey === sealingKey
          && this.connectionEpoch === sealingConnectionEpoch
          && !this.disconnected && !this.terminalReached
        ) {
          // Retry scheduling is prepared before the raw call, but only a
          // successful raw publish confirms application-published ownership.
          // An older message may be ACKed synchronously inside ws.send(),
          // advancing the mutation epoch while this exact entry remains current;
          // confirming it here is safe. A result for THIS id detached the entry,
          // so the identity fence above prevents resurrection.
          ledgerEntry.published = true;
          const confirmationMutationEpoch = this.ackStallMutationEpoch;
          const publishedAt = this.retryNow();
          if (
            this.unackedLedger.get(message.id) === ledgerEntry
            && this.sessionKey === sealingKey
            && this.connectionEpoch === sealingConnectionEpoch
            && this.ackStallMutationEpoch === confirmationMutationEpoch
            && !this.disconnected && !this.terminalReached
          ) {
            if (this.ackStallSinceAt === null && !this.ackStallRecoveryIssued) {
              this.ackStallMutationEpoch++;
              this.ackStallSinceAt = publishedAt;
              this.ackStallRecoveryIssued = false;
            }
            publishedMutationEpoch = this.ackStallMutationEpoch;
            schedulingSnapshot = this.captureLedgerScheduling();
          }
        }
        this.trackerAdvance(message.id, "sent");
        if (
          publishedMutationEpoch !== null && schedulingSnapshot !== null
          && this.unackedLedger.get(message.id) === ledgerEntry
          && this.sessionKey === sealingKey
          && this.connectionEpoch === sealingConnectionEpoch
          && this.ackStallMutationEpoch === publishedMutationEpoch
          && !this.disconnected && !this.terminalReached
          && this.ledgerSchedulingMatches(schedulingSnapshot)
        ) {
          this.armLiveRetryTimer();
        }
      }
    } else {
      const ok = this.client.publish(inboundSubject(tenant, accountId, peerId), wire);
      if (!ok) {
        console.warn(`[nats-client] publish failed for non-replicated frame '${message.type}' — recovery via reconnect/register snapshot`);
      }
    }
    // P0-4 (review R2): the deferred eviction notifications — the seal is complete,
    // so an embedder that tears the instance down from here can no longer corrupt
    // it. Ordered AFTER this message's own `sent` advance on purpose: a `close()`
    // from an eviction subscriber sweeps the ledger, and THIS message is already
    // recorded in it, so it lands at failed{closed} rather than being stranded.
    finishPostSeal();
  }

  // ---------------------------------------------------------------------------
  // P0-4 — authoritative send-state tracker (D4)
  // ---------------------------------------------------------------------------

  /** Seed a fresh `queued` entry without a public callout. No-op if already tracked. */
  private trackerInsert(id: string): void {
    if (this.sendTracker.has(id)) return;
    this.sendTracker.set(id, { state: "queued" });
  }

  /**
   * Advance a tracked send FORWARD to `queued`/`sent`/`accepted`, enforcing the
   * monotonic guard: the id must be tracked, not terminal (`failed`), and the
   * target must strictly outrank the current state. Invalid inputs are silent
   * no-ops (R1-F5) — duplicate ack, ack after eviction, forward event after a
   * failure. Mutates then notifies.
   */
  private trackerAdvance(id: string, to: "queued" | "sent" | "accepted"): void {
    const entry = this.sendTracker.get(id);
    if (!entry || entry.state === "failed") return;
    if (WebChannelNatsClient.SEND_RANK[entry.state] >= WebChannelNatsClient.SEND_RANK[to]) return;
    entry.state = to;
    this.emitSendState(id, to, entry.failure);
  }

  /**
   * Fail a tracked send terminally. No-op if unknown or already `failed`
   * (`failed`/`accepted`/`sent`→`failed` are all valid; only re-failing is not).
   */
  private trackerFail(id: string, failure: SendFailure): void {
    const entry = this.sendTracker.get(id);
    if (!entry || entry.state === "failed") return;
    entry.state = "failed";
    entry.failure = failure;
    this.emitSendState(id, "failed", failure);
  }

  /**
   * Detach the current lifecycle's entire outbound queue/ledger before any public
   * failure callout, returning only the user-message ids that need a receipt
   * transition. Non-user frames are dropped with the retired lifecycle. Messages
   * already `accepted` are in neither collection and remain untouched.
   */
  private takePendingSendIds(): string[] {
    const ids = new Set<string>();
    for (const m of this.outboundQueue) if (m.type === "user_message" && m.id) ids.add(m.id);
    for (const id of this.unackedLedger.keys()) ids.add(id);
    this.outboundQueue = [];
    this.unackedLedger.clear();
    // Explicit/terminal retirement ends the published episode before the
    // reentrant timer-clear hook and before any failure callback.
    this.ackStallMutationEpoch++;
    this.ackStallSinceAt = null;
    this.ackStallRecoveryIssued = false;
    this.cancelLiveRetryTimer();
    return [...ids];
  }

  /** Fail a previously detached ownership snapshot without touching live queues. */
  private failPendingIds(ids: readonly string[], failure: SendFailure): void {
    for (const id of ids) {
      this.trackerFail(id, { ...failure, lastAttemptAt: this.sendTracker.get(id)?.lastAttemptAt });
    }
  }

  /**
   * Terminal paths retire the current lifecycle wholesale. Detach first, then
   * fail each captured id so listener re-entry cannot be consumed by the sweep.
   */
  private failAllPending(failure: SendFailure): void {
    this.failPendingIds(this.takePendingSendIds(), failure);
  }

  /**
   * P0-4 terminal sequence (D4) steps ①②: mark terminal (so a re-entrant send
   * resolves immediately to failed) then sweep pending → failed{terminal,cause}.
   * Shared by BOTH terminal entry points so neither loses the sweep: the raw
   * transport-death path (`handleTerminal`, no epoch in scope) and the register/
   * handshake path (`failConnectionEpoch`, epoch+generation-guarded). Runs BEFORE
   * any embedder notify — a send arriving while error listeners run is caught by
   * the `terminalReached` mark and never escapes into a dead instance.
   */
  private markTerminalAndSweep(cause?: WebChannelErrorCause): void {
    this.terminalReached = true;
    this.terminalCause = cause ?? "unknown";
    this.failAllPending({ reason: "terminal", cause: this.terminalCause, retryable: false });
  }

  /**
   * P0-4 terminal sequence (D4): transport-death entry point (`client.onError` —
   * no connection epoch in scope, so no generation-targeted disconnect here, same
   * as review's pre-P0-4 routing). ① mark + ② sweep, THEN ③ notify error
   * listeners (the wrapper fails its own held[] there).
   */
  private handleTerminal(err: Error, cause?: WebChannelErrorCause): void {
    this.markTerminalAndSweep(cause);
    this.notifyErrorListeners(err, cause);
  }

  private emitSendState(id: string, state: SendState, failure?: SendFailure): void {
    this.pendingSendStateEvents.push({ id, state, failure });
    if (this.drainingSendStateEvents) return;

    this.drainingSendStateEvents = true;
    try {
      while (this.pendingSendStateEvents.length > 0) {
        const event = this.pendingSendStateEvents.shift()!;
        // Keep Set.forEach's existing live membership semantics (unsubscribe of a
        // not-yet-visited listener suppresses it; an added listener may join this
        // event). FIFO serialization changes only nested-event ordering.
        this.sendStateListeners.forEach((listener) => {
          try {
            listener(event.id, event.state, event.failure);
          } catch (e) {
            console.error("[nats-client] Send-state listener error:", e);
          }
        });
      }
    } finally {
      this.drainingSendStateEvents = false;
    }
  }

  /**
   * P0-7b: record an unacked user_message, evicting the oldest past the cap.
   *
   * Returns inert insertion/eviction metadata instead of failing/warning here
   * (P0-4 R2/R3).
   * `trackerFail` is a synchronous callout into embedder code (emitSendState →
   * the wrapper's receiptTransition → setState → app state subscribers), and the
   * only caller is `seal()`, which runs this BETWEEN its `sessionKey` fail-closed
   * check and the `sealMessage()` that reads `this.sessionKey`. A subscriber
   * calling `close()` from that window nulls the key mid-seal, so `sealMessage`
   * received `null` and threw a raw crypto TypeError out of `send()` — breaking
   * the P0-4 contract that a send RETURNS an observable receipt and never throws
   * (and, on the flush path, escaping `onConnected` as an unhandled rejection
   * that abandoned the rest of the drain). Deferring eviction notifications,
   * warnings, and retry clock/random initialization keeps `seal()`'s critical
   * section free of embedder/injected code. B3's observable behavior is unchanged.
   */
  private recordUnacked(
    id: string,
    message: Extract<OutboundMessage, { type: "user_message" }>,
  ): { evicted: string[]; warnEviction: boolean; inserted: boolean } {
    const evicted: string[] = [];
    let warnEviction = false;
    let inserted = false;
    if (!this.unackedLedger.has(id)) {
      inserted = true;
      this.unackedLedger.set(id, {
        message,
        retryCount: 0,
        // Injected clock/random callbacks run only after sealMessage has
        // completed; null is inert pre-publish ownership metadata.
        nextRetryAt: null,
        published: false,
      });
    }
    while (this.unackedLedger.size > WebChannelNatsClient.MAX_UNACKED) {
      const oldest = this.unackedLedger.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.unackedLedger.delete(oldest);
      // P0-4 (B3): an evicted message will never be replayed → fail it observably
      // (retryable — a fresh send can still succeed) instead of the old
      // console-only drop. Deferred to the caller (see the note above).
      evicted.push(oldest);
      if (!this.warnedUnackedEvict) {
        // Warn ONCE per session (re-armed in resetSession) — a full ledger means
        // an unusually long delivery stall; a per-send warn would spam a burst.
        this.warnedUnackedEvict = true;
        warnEviction = true;
      }
    }
    return { evicted, warnEviction, inserted };
  }

  private retryDelay(retryCount: number): number {
    const base = Math.min(30_000, 1_000 * 2 ** Math.min(retryCount, 30));
    const random = Math.max(0, Math.min(1, this.retryRandom()));
    return Math.min(30_000, Math.round(base * (0.9 + random * 0.2)));
  }

  private captureLedgerScheduling(): LedgerSchedulingSnapshot {
    return [...this.unackedLedger.entries()].map(([id, entry]) => ({
      id,
      entry,
      nextRetryAt: entry.nextRetryAt,
      published: entry.published,
    }));
  }

  private ledgerSchedulingMatches(snapshot: LedgerSchedulingSnapshot): boolean {
    if (this.unackedLedger.size !== snapshot.length) return false;
    for (const item of snapshot) {
      if (
        this.unackedLedger.get(item.id) !== item.entry
        || item.entry.nextRetryAt !== item.nextRetryAt
        || item.entry.published !== item.published
      ) {
        return false;
      }
    }
    return true;
  }

  /** Null ownership before the injected clear hook; return the exact token. */
  private cancelLiveRetryTimer(): number {
    const token = ++this.liveRetryTimerGeneration;
    const timer = this.liveRetryTimer;
    this.liveRetryTimer = null;
    if (timer !== null) this.retryClearTimeout(timer);
    return token;
  }

  private armLiveRetryTimer(): void {
    const cancellationToken = this.cancelLiveRetryTimer();
    if (
      this.liveRetryTimerGeneration !== cancellationToken || this.liveRetryTimer !== null
      || !this.sessionKey || this.unackedLedger.size === 0
      || this.disconnected || this.terminalReached
    ) {
      return;
    }
    const epoch = this.connectionEpoch;
    const key = this.sessionKey;
    const mutationEpoch = this.ackStallMutationEpoch;
    const schedulingSnapshot = this.captureLedgerScheduling();
    const stallSinceAt = this.ackStallSinceAt;
    const stallRecoveryIssued = this.ackStallRecoveryIssued;
    let earliest = Number.POSITIVE_INFINITY;
    for (const entry of this.unackedLedger.values()) {
      if (entry.nextRetryAt !== null) earliest = Math.min(earliest, entry.nextRetryAt);
    }
    const hasStallCandidate =
      this.resolvedAckStallTimeoutMs > 0
      && stallSinceAt !== null
      && !stallRecoveryIssued;
    if (!Number.isFinite(earliest) && !hasStallCandidate) return;

    const now = this.retryNow();
    if (
      this.liveRetryTimerGeneration !== cancellationToken || this.liveRetryTimer !== null
      || this.connectionEpoch !== epoch || this.sessionKey !== key
      || this.ackStallMutationEpoch !== mutationEpoch
      || this.ackStallSinceAt !== stallSinceAt
      || this.ackStallRecoveryIssued !== stallRecoveryIssued
      || this.disconnected || this.terminalReached
      || !this.ledgerSchedulingMatches(schedulingSnapshot)
    ) {
      return;
    }
    const retryRemaining = Number.isFinite(earliest)
      ? Math.max(0, earliest - now)
      : Number.POSITIVE_INFINITY;
    const stallRemaining = hasStallCandidate
      ? Math.max(0, this.resolvedAckStallTimeoutMs - Math.max(0, now - stallSinceAt!))
      : Number.POSITIVE_INFINITY;
    const delay = Math.min(retryRemaining, stallRemaining);
    if (!Number.isFinite(delay)) return;
    const generation = ++this.liveRetryTimerGeneration;
    const timer = this.retrySetTimeout(() => {
      if (generation !== this.liveRetryTimerGeneration) return;
      this.liveRetryTimer = null;
      this.liveRetryTimerGeneration++;
      this.retryDueUnacked();
    }, delay);
    // The injected scheduler is an embedder callout. It may synchronously close
    // or reset this client before returning; do not install a stale timer handle
    // into the retired session in that case.
    if (
      generation !== this.liveRetryTimerGeneration
      || this.liveRetryTimer !== null
      || this.connectionEpoch !== epoch || this.sessionKey !== key
      || this.ackStallMutationEpoch !== mutationEpoch
      || this.ackStallSinceAt !== stallSinceAt
      || this.ackStallRecoveryIssued !== stallRecoveryIssued
      || !this.ledgerSchedulingMatches(schedulingSnapshot)
      || this.disconnected || this.terminalReached
    ) {
      this.retryClearTimeout(timer);
      return;
    }
    this.liveRetryTimer = timer;
    const unrefTimer = timer as ReturnType<typeof setTimeout> & { unref?: () => void };
    unrefTimer.unref?.();
  }

  private retryDueUnacked(): void {
    if (!this.sessionKey || this.disconnected || this.terminalReached) return;
    const timerGeneration = this.liveRetryTimerGeneration;
    const epoch = this.connectionEpoch;
    const key = this.sessionKey;
    const mutationEpoch = this.ackStallMutationEpoch;
    const schedulingSnapshot = this.captureLedgerScheduling();
    const stallSinceAt = this.ackStallSinceAt;
    const stallRecoveryIssued = this.ackStallRecoveryIssued;
    const schedulerNow = this.retryNow();
    if (
      this.liveRetryTimerGeneration !== timerGeneration
      || this.connectionEpoch !== epoch || this.sessionKey !== key
      || this.ackStallMutationEpoch !== mutationEpoch
      || this.ackStallSinceAt !== stallSinceAt
      || this.ackStallRecoveryIssued !== stallRecoveryIssued
      || this.disconnected || this.terminalReached
      || !this.ledgerSchedulingMatches(schedulingSnapshot)
    ) {
      return;
    }

    if (
      this.resolvedAckStallTimeoutMs > 0
      && stallSinceAt !== null && !stallRecoveryIssued
      && this.unackedLedger.size > 0
      && Math.max(0, schedulerNow - stallSinceAt) >= this.resolvedAckStallTimeoutMs
    ) {
      this.ackStallMutationEpoch++;
      this.ackStallRecoveryIssued = true;
      this.requestApplicationRecovery();
      return;
    }

    const { tenant, accountId, peerId } = this.options;
    for (const [id, entry] of this.unackedLedger) {
      if (entry.nextRetryAt === null || entry.nextRetryAt > schedulerNow) continue;
      const entryMutationEpoch = this.ackStallMutationEpoch;
      const entryTimerGeneration = this.liveRetryTimerGeneration;
      const entryKey: Uint8Array | null = this.sessionKey;
      const entryEpoch = this.connectionEpoch;
      if (!entryKey || this.disconnected || this.terminalReached) return;
      // A due retry resolves its randomized next interval before sampling the
      // publish-attempt clock. Both injected hooks are fenced callouts.
      const nextRetryCount = entry.retryCount + 1;
      const delay = this.retryDelay(nextRetryCount);
      if (
        this.unackedLedger.get(id) !== entry
        || this.sessionKey !== entryKey || this.connectionEpoch !== entryEpoch
        || this.ackStallMutationEpoch !== entryMutationEpoch
        || this.liveRetryTimerGeneration !== entryTimerGeneration
        || this.disconnected || this.terminalReached
      ) {
        return;
      }
      const attemptAt = this.retryNow();
      if (
        this.unackedLedger.get(id) !== entry
        || this.sessionKey !== entryKey || this.connectionEpoch !== entryEpoch
        || this.ackStallMutationEpoch !== entryMutationEpoch
        || this.liveRetryTimerGeneration !== entryTimerGeneration
        || this.disconnected || this.terminalReached
      ) {
        return;
      }
      const wire = sealMessage({ accountId, tenant, sub: peerId }, entryKey, entry.message);
      const tracker = this.sendTracker.get(id);
      if (tracker) tracker.lastAttemptAt = attemptAt;
      const ok = this.client.publish(inboundSubject(tenant, accountId, peerId), wire);
      if (!ok) return; // publish forced reconnect/reset; reconnect replay owns recovery.
      if (
        this.unackedLedger.get(id) !== entry
        || this.sessionKey !== entryKey || this.connectionEpoch !== entryEpoch
        || this.ackStallMutationEpoch !== entryMutationEpoch
        || this.liveRetryTimerGeneration !== entryTimerGeneration
        || this.disconnected || this.terminalReached
      ) {
        return;
      }
      entry.retryCount = nextRetryCount;
      entry.nextRetryAt = attemptAt + delay;
    }
    this.armLiveRetryTimer();
  }

  private notifyMessageListeners(msg: InboundMessage): void {
    this.messageListeners.forEach((listener) => {
      try {
        listener(msg);
      } catch (err) {
        console.error("[nats-client] Listener error:", err);
      }
    });
  }

  private notifyErrorListeners(err: Error, cause?: WebChannelErrorCause): void {
    this.errorListeners.forEach((listener) => {
      try {
        listener(err, cause);
      } catch (e) {
        console.error("[nats-client] Error listener error:", e);
      }
    });
  }

  private notifyProtocolListeners(info: ProtocolInfo): void {
    this.protocolListeners.forEach((listener) => {
      try {
        listener(info);
      } catch (e) {
        console.error("[nats-client] Protocol listener error:", e);
      }
    });
  }

  private notifySessionListeners(isCurrent?: () => boolean): void {
    for (const listener of [...this.sessionListeners]) {
      if (isCurrent && !isCurrent()) return;
      try {
        listener();
      } catch (e) {
        console.error("[nats-client] Session listener error:", e);
      }
    }
  }
}
