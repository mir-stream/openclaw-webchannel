/**
 * WebChannel NATS Client — Browser-side NATS connection.
 *
 * This module provides a browser-compatible NATS WebSocket client that:
 * - Connects to NATS server with bootstrap JWT authentication
 * - Subscribes to inbound message subjects
 * - Publishes to outbound message subjects
 * - Handles reconnection with exponential backoff
 * - Integrates with Phase A crypto (handshake + E2E encryption)
 *
 * Architecture:
 * - Outbound-only connection (browser dials NATS)
 * - JWT-based authentication (bootstrap JWT from SaaS)
 * - Per-peer NATS subjects (tenant-keyed routing)
 * - E2E encryption: per-peer X25519 handshake + MessageEnvelope v1 sealing,
 *   matching the agent (`packages/plugin/src/nats-channel.ts` crypto mode). The
 *   client is FAIL-CLOSED — it buffers sends until the handshake completes and
 *   never publishes or accepts plaintext on the relay.
 */

import {
  generateX25519KeyPair,
  deriveConversationKey,
  keyExchangeFrame,
  parseKeyExchange,
  sealMessage,
  openMessage,
  base64urlDecode,
  unwrapConversationKey,
  type BrowserKeyPair,
} from "./e2e-crypto-browser.js";
import { importEd25519SeedKey, signNonce } from "./nats-nkey-browser.js";
import { registerWithPop } from "./pop-register.js";

// Handshake retry (core NATS has no retention — the one-shot key_exchange can be
// dropped if the agent's per-peer SUB is not yet server-active when we publish,
// which a real, higher-latency relay makes possible). Republish a few times until
// the agent answers. ~2.6s total worst case (500ms × 5) — well under any human
// perception of "did it connect?", and it stops instantly once the key arrives.
const HANDSHAKE_RETRY_MS = 500;
const HANDSHAKE_MAX_RETRIES = 5;

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
  /**
   * Optional PoP HTTP registration. When present, the client performs the
   * JWT + Proof-of-Possession registration against the plugin's HTTP register
   * route after connecting (and before the handshake), so the agent subscribes
   * to this peer's subjects. When absent, registration is skipped (dev/open-NATS
   * uses the agent's wildcard auto-register instead). `jwt` and `peerId` come
   * from the existing NatsClientOptions fields.
   */
  registration?: {
    /** Base URL where the plugin serves its register routes (no trailing slash). */
    registerBaseUrl: string;
    /** Device Ed25519 private key paired with the bootstrap JWT's pop_jwk. */
    devicePrivateKey: CryptoKey;
    /**
     * Phase 6 (multi-device): the device X25519 PRIVATE key whose PUBLIC half
     * was minted into the bootstrap JWT `cnf.jwk`. When present, the session
     * key is the agent-owned conversation key K delivered WRAPPED to this key
     * in the register response (`unwrapConversationKey`) — no `.handshake`
     * negotiation happens at all, so one user's multiple devices share one
     * stable K. When absent, the legacy per-connection X25519 handshake runs
     * (old-plugin compat; the auto-admission path never registers anyway).
     */
    deviceX25519PrivateKey?: CryptoKey;
    /** Injectable fetch (tests / non-browser hosts). Defaults to global fetch. */
    fetchImpl?: typeof fetch;
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
  type: "agent_message" | "progress" | "approval_request" | "approval_resolved" | "typing" | "history";
  id?: string;
  text?: string;
  kind?: "exec" | "plugin";
  title?: string;
  description?: string;
  prompt?: string;
  options?: Array<{ decision: string; label: string; style: string }>;
  expiresAtMs?: number;
  decision?: string;
  messages?: Array<{ id: string; role: string; text: string; ts?: number }>;
  before?: string;
  limit?: number;
};

export type OutboundMessage =
  | { type: "user_message"; text: string }
  | { type: "approval_decision"; id: string; decision: string }
  | { type: "load_history"; before?: string; limit?: number };

/** Message listener callback (decrypted, high-level). */
export type MessageListener = (msg: InboundMessage) => void;

/** Raw NATS message listener: (subject, payload) before any decryption. */
export type RawMessageListener = (subject: string, payload: string) => void;

/** Connection state listener callback */
export type StateListener = (connected: boolean) => void;

/** Error listener callback (e.g. PoP registration failure). */
export type ErrorListener = (err: Error) => void;

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
  private connected = false;
  private rawListeners = new Set<RawMessageListener>();
  private stateListeners = new Set<StateListener>();
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private subscriptions = new Map<number, string>(); // sid -> subject
  private sidCounter = 0;
  private buffer = "";
  /**
   * NKEY-auth only: guards the signed CONNECT so it is sent exactly once per
   * socket even if the server emits multiple INFO lines. Reset on each
   * (re)connect. Unused on the no-natsCredentials path.
   */
  private connectSent = false;

  /** CL2: terminal auth failure — stop reconnecting; only a fresh client helps. */
  private terminal = false;
  /** CL2: listeners notified on a terminal (non-retryable) failure. */
  private readonly errorListeners = new Set<ErrorListener>();
  /** CL3: keepalive timer + outstanding-PING flag. */
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private pongPending = false;

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

  /** Disconnect and cleanup */
  disconnect(): void {
    this.clearReconnectTimer();
    this.stopHeartbeat();
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

  /** Publish message to NATS subject */
  publish(subject: string, payload: string): void {
    if (!this.connected || !this.ws) {
      console.warn("[nats-client] Not connected, cannot publish");
      return;
    }

    // Use TextEncoder for byte-length (browser-compatible; Node.js ≥18 also
    // has globalThis.TextEncoder). NATS PUB requires the UTF-8 byte count.
    const byteLen = new TextEncoder().encode(payload).length;
    this.ws.send(`PUB ${subject} ${byteLen}\r\n${payload}\r\n`);
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
    // nats-server speaks the NATS protocol over BINARY WebSocket frames. The
    // default binaryType ("blob") coerces to "[object Blob]" in the text buffer
    // and breaks the parser — request ArrayBuffer and decode to UTF-8.
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    this.connectSent = false;
    // A fresh socket starts a fresh NATS protocol stream. Any bytes left in the
    // buffer from a socket torn down mid-frame (the half-open case CL3's
    // heartbeat forces a reconnect on) would otherwise corrupt the new stream's
    // INFO/PONG parse — on the NKEY path a mangled INFO means the signed CONNECT
    // is never sent → server auth timeout. Start clean.
    this.buffer = "";

    ws.onopen = () => {
      console.log("[nats-client] WebSocket connected");
      // No NKEY auth: send CONNECT immediately (original path, byte-for-byte).
      // With NKEY auth we MUST wait for the server's INFO nonce before signing,
      // so CONNECT is deferred to the INFO handler in drainBuffer().
      if (!this.options.natsCredentials) {
        this.sendConnect();
      }
    };

    ws.onmessage = (event: MessageEvent<string | ArrayBuffer>) => {
      this.buffer +=
        typeof event.data === "string"
          ? event.data
          : new TextDecoder().decode(new Uint8Array(event.data));
      this.drainBuffer();
    };

    ws.onerror = (err) => {
      console.error("[nats-client] WebSocket error:", err);
    };

    ws.onclose = () => {
      this.connected = false;
      this.stopHeartbeat();
      this.notifyStateListeners();
      this.scheduleReconnect();
    };
  }

  private sendConnect(): void {
    if (!this.ws) return;

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

    this.ws.send(`CONNECT ${JSON.stringify(connectPayload)}\r\n`);
    this.ws.send("PING\r\n");
  }

  /**
   * NKEY-auth CONNECT: triggered by the server's INFO line. Extracts the nonce,
   * signs it with the user NKEY seed, and sends CONNECT carrying the user JWT +
   * signature (NATS challenge-response), then PING to provoke the PONG that
   * flips us to `connected`. Only invoked when `natsCredentials` is set.
   */
  private async sendSignedConnect(infoLine: string): Promise<void> {
    const creds = this.options.natsCredentials;
    // Capture the socket BEFORE the crypto await: a (theoretical) reconnect
    // during the await could swap `this.ws`, and we must send CONNECT on the
    // same socket that produced this INFO nonce — never a replacement.
    const ws = this.ws;
    if (!ws || !creds) return;

    let nonce = "";
    try {
      nonce = (JSON.parse(infoLine.slice(5).trim()) as { nonce?: string }).nonce ?? "";
    } catch {
      /* INFO without a parseable nonce — sign nothing (server will reject). */
    }

    let sig = "";
    if (nonce) {
      const privateKey = await importEd25519SeedKey(base64urlDecode(creds.userSeedRaw));
      sig = await signNonce(privateKey, nonce);
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

    // Send on the captured socket (the one that produced this INFO nonce).
    ws.send(`CONNECT ${JSON.stringify(connectPayload)}\r\n`);
    ws.send("PING\r\n");
  }

  private drainBuffer(): void {
    let crlfPos: number;
    while ((crlfPos = this.buffer.indexOf("\r\n")) !== -1) {
      const line = this.buffer.slice(0, crlfPos);
      this.buffer = this.buffer.slice(crlfPos + 2);

      if (!line) continue;

      if (line.startsWith("INFO ")) {
        // NKEY auth: the INFO nonce is our cue to send the signed CONNECT (once).
        if (this.options.natsCredentials && !this.connectSent) {
          this.connectSent = true;
          void this.sendSignedConnect(line);
        }
        continue;
      }

      if (line === "PONG") {
        // CL3: any PONG proves the link is alive — clear the outstanding-ping
        // flag so the next heartbeat tick does not declare a dead link.
        this.pongPending = false;
        if (!this.connected) {
          this.connected = true;
          this.reconnectAttempts = 0;
          console.log("[nats-client] Connected to NATS");
          this.notifyStateListeners();
          this.resubscribeAll();
          this.startHeartbeat();
        }
        continue;
      }

      if (line === "PING") {
        this.ws?.send("PONG\r\n");
        continue;
      }

      if (line.startsWith("MSG ")) {
        // handleMessage returns false when the payload hasn't fully arrived yet
        // (it re-buffers the header). We MUST break, not continue: continuing
        // would re-extract the same header from the same buffer forever — a
        // synchronous infinite loop that freezes the tab. Break and wait for the
        // next ws.onmessage to append the rest.
        if (!this.handleMessage(line)) break;
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
        if (/authorization violation|authentication expired/i.test(line)) {
          this.failTerminally(
            `NATS authorization rejected: ${line.slice(5).trim()} ` +
              `(credentials invalid/expired — reconnecting cannot help)`,
          );
        }
        continue;
      }
    }
  }

  /**
   * Parse a `MSG` line + its payload. Returns `true` when a full message was
   * consumed (caller continues draining) and `false` when the payload has not
   * fully arrived yet (the header is re-buffered; caller must STOP draining and
   * wait for more socket data — see the break in drainBuffer).
   */
  private handleMessage(line: string): boolean {
    const parts = line.split(" ");
    const hasReplyTo = parts.length === 5;
    const subject = parts[1] ?? "";
    const byteCount = parseInt(parts[hasReplyTo ? 4 : 3] ?? "0", 10);

    if (isNaN(byteCount) || byteCount < 0) return true; // malformed header: drop, keep draining

    if (this.buffer.length < byteCount + 2) {
      this.buffer = `${line}\r\n${this.buffer}`;
      return false; // need more bytes
    }

    const payload = this.buffer.slice(0, byteCount);
    this.buffer = this.buffer.slice(byteCount + 2);

    // Deliver the raw payload; decryption/parsing happens in WebChannelNatsClient
    // (the envelope must be decrypted before it is meaningful).
    this.notifyRawListeners(subject, payload);
    return true;
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
   * CL2: enter the terminal state. Stops all reconnect activity, tears the
   * socket down, and notifies error listeners. No further redial happens until a
   * brand-new client is constructed.
   */
  private failTerminally(message: string): void {
    if (this.terminal) return; // fire once
    this.terminal = true;
    this.clearReconnectTimer();
    this.stopHeartbeat();
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
    this.notifyErrorListeners(new Error(message));
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
    this.connected = false;
    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onerror = null;
      this.ws.onclose = null; // we drive the reconnect; avoid a double-fire
      try { this.ws.close(); } catch { /* already closing */ }
      this.ws = null;
    }
    this.notifyStateListeners();
    this.scheduleReconnect();
  }

  private notifyErrorListeners(err: Error): void {
    this.errorListeners.forEach((listener) => {
      try {
        listener(err);
      } catch (e) {
        console.error("[nats-client] Error listener threw:", e);
      }
    });
  }

  private notifyRawListeners(subject: string, payload: string): void {
    this.rawListeners.forEach((listener) => {
      try {
        listener(subject, payload);
      } catch (err) {
        console.error("[nats-client] Listener error:", err);
      }
    });
  }

  private notifyStateListeners(): void {
    this.stateListeners.forEach((listener) => {
      try {
        listener(this.connected);
      } catch (err) {
        console.error("[nats-client] State listener error:", err);
      }
    });
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
 * Derive handshake NATS subject for a peer.
 * Format: webchannel.{tenant}.{accountId}.{peerId}.handshake
 */
export function handshakeSubject(tenant: string, accountId: string, peerId: string): string {
  return `webchannel.${tenant}.${accountId}.${peerId}.handshake`;
}

// ---------------------------------------------------------------------------
// WebChannel NATS client (high-level API)
// ---------------------------------------------------------------------------

/**
 * High-level, E2E-encrypted WebChannel NATS client.
 *
 * Wraps `NatsClient` and adds the per-peer X25519 handshake + MessageEnvelope v1
 * sealing the agent expects. It is FAIL-CLOSED:
 *   - outbound sends are buffered until the handshake establishes a session key,
 *     and are only ever published as ciphertext (never plaintext);
 *   - inbound frames are dropped until the session key exists and are decrypted
 *     before delivery.
 *
 * Subject direction (matching the agent): the browser PUBLISHES to `.in`,
 * SUBSCRIBES to `.out`, and exchanges keys on `.handshake`.
 */
export class WebChannelNatsClient {
  private readonly client: NatsClient;
  private readonly options: NatsClientOptions;
  private readonly messageListeners = new Set<MessageListener>();
  private readonly errorListeners = new Set<ErrorListener>();

  private keyPair: BrowserKeyPair | null = null;
  private sessionKey: Uint8Array | null = null;
  private outboundQueue: OutboundMessage[] = [];
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
  private outSub = -1;
  private handshakeSub = -1;
  /**
   * Handshake retry timer. The initial `key_exchange` is a one-shot publish, but
   * core NATS has NO retention: if the agent's per-peer subscription is not yet
   * active on the server when we publish (a real, higher-latency relay makes the
   * SUB→handshake ordering non-deterministic even though we register first), the
   * frame is dropped and — with no retry — the session would wedge forever. So we
   * republish on a bounded schedule until the agent answers (sessionKey is set) or
   * the attempt cap is hit. Cleared on session establishment, reconnect, or close.
   */
  private handshakeRetryTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Bumped on every `onConnected()` so a stale async continuation (resumed after
   * the socket dropped and a reconnect spawned a fresh flow) can detect it is no
   * longer current and bail instead of overwriting `keyPair` / publishing a
   * stale handshake.
   */
  private connectionEpoch = 0;

  constructor(options: NatsClientOptions) {
    this.options = options;
    this.client = new NatsClient(options);
    this.client.onRawMessage((subject, payload) => {
      void this.handleRaw(subject, payload);
    });
    this.client.onState((connected) => {
      if (connected) void this.onConnected();
      else this.resetSession();
    });
    // CL2: forward the low-level client's terminal auth failures to our own
    // error listeners, so an embedder learns credentials died (not just PoP
    // registration failures, which already flow through notifyErrorListeners).
    this.client.onError((err) => this.notifyErrorListeners(err));
  }

  /** Connect to NATS (the handshake begins automatically once connected). */
  connect(): void {
    this.client.connect();
  }

  /** Disconnect from NATS and drop the session. */
  disconnect(): void {
    if (this.outSub >= 0) this.client.unsubscribe(this.outSub);
    if (this.handshakeSub >= 0) this.client.unsubscribe(this.handshakeSub);
    this.outSub = -1;
    this.handshakeSub = -1;
    this.resetSession();
    this.client.disconnect();
  }

  /** Send user message (buffered until the handshake completes). */
  sendUserMessage(text: string): void {
    this.enqueue({ type: "user_message", text });
  }

  /** Send approval decision (buffered until the handshake completes). */
  sendApprovalDecision(id: string, decision: string): void {
    this.enqueue({ type: "approval_decision", id, decision });
  }

  /** Request history page (buffered until the handshake completes). */
  loadHistory(before?: string, limit?: number): void {
    this.enqueue({ type: "load_history", before, limit });
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

  // ---------------------------------------------------------------------------
  // Internal — handshake + crypto
  // ---------------------------------------------------------------------------

  private resetSession(): void {
    this.clearHandshakeRetry();
    this.sessionKey = null;
    this.keyPair = null;
    // Frames buffered for a dead session are ciphertext under a key we no
    // longer (or never will) hold — drop them; the fresh register/handshake
    // re-hydrates.
    this.pendingInbound = [];
  }

  /**
   * Decrypt + deliver the `.out` frames that arrived before the session key
   * was established (see `pendingInbound`). Called immediately after the key
   * is set on either path (register-delivered K or legacy handshake).
   */
  private drainPendingInbound(): void {
    if (!this.sessionKey || this.pendingInbound.length === 0) return;
    const pending = this.pendingInbound;
    this.pendingInbound = [];
    for (const payload of pending) {
      const msg = openMessage(payload, this.sessionKey) as InboundMessage | null;
      if (msg) this.notifyMessageListeners(msg);
    }
  }

  private async onConnected(): Promise<void> {
    const { tenant, accountId, peerId } = this.options;
    // Mark this flow as the current connection generation. Any `await` below
    // re-checks `this.connectionEpoch === epoch` so a continuation resumed after
    // a drop+reconnect bails instead of clobbering the fresh flow's state.
    const epoch = ++this.connectionEpoch;
    const { registration } = this.options;
    // Phase 6 (multi-device): when the JWT-cnf X25519 private key is supplied,
    // the session key is the agent-owned conversation key K, delivered WRAPPED
    // in the register response — the `.handshake` subject is never subscribed
    // nor published on this path (the plugin's register-admission channel does
    // not answer handshakes anymore).
    const registerDeliveredKey = Boolean(registration?.deviceX25519PrivateKey);

    // (Re)subscribe idempotently: unsubscribe stale sids so a reconnect never
    // leaves duplicate subscriptions delivering the same MSG twice. `.out` MUST
    // be active BEFORE the register hop: the agent sends the initial history
    // snapshot from the register route, and core NATS has no retention.
    if (this.outSub >= 0) this.client.unsubscribe(this.outSub);
    if (this.handshakeSub >= 0) this.client.unsubscribe(this.handshakeSub);
    this.handshakeSub = -1;
    this.outSub = this.client.subscribe(outboundSubject(tenant, accountId, peerId));
    if (!registerDeliveredKey) {
      this.handshakeSub = this.client.subscribe(handshakeSubject(tenant, accountId, peerId));
    }

    // Fresh connection → fresh key establishment.
    this.resetSession();

    // PoP HTTP registration (production). MUST complete AFTER we subscribe to
    // .out (above) but BEFORE any key flows — the agent only subscribes to this
    // peer's subjects once registered, and NATS has no retention. Fail-closed:
    // if registration throws, registration failure is TERMINAL for this
    // connection. A PoP/JWT rejection is typically a permanent credential
    // problem, so we do NOT silently retry (no auto-retry/hammering): we tear
    // the connection fully down via the raw NatsClient.disconnect() (clears the
    // reconnect timer + closes the socket, leaving connected === false). The
    // application must react to onError and re-initialize with fresh
    // credentials (a new bootstrap JWT).
    if (registration) {
      // The register hop presents the bootstrap JWT; it is REQUIRED here even
      // though the type makes `jwt` optional (it is unused on the BYO-NATS path).
      if (!this.options.jwt) {
        const err = new Error(
          "[nats-client] registration requires a bootstrap `jwt` (none provided)",
        );
        this.notifyErrorListeners(err);
        this.client.disconnect();
        return;
      }
      let registerResult: Awaited<ReturnType<typeof registerWithPop>>;
      try {
        registerResult = await registerWithPop({
          registerBaseUrl: registration.registerBaseUrl,
          jwt: this.options.jwt,
          peerId,
          devicePrivateKey: registration.devicePrivateKey,
          fetchImpl: registration.fetchImpl,
        });
      } catch (err) {
        console.error("[nats-client] PoP registration failed:", err);
        this.notifyErrorListeners(err as Error);
        this.client.disconnect();
        return;
      }
      // The socket may have dropped during the register round-trip; a reconnect
      // would have spawned a newer onConnected. Bail so this stale flow does not
      // establish a key for a connection generation that is no longer current.
      if (this.connectionEpoch !== epoch) return;

      if (registerDeliveredKey) {
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
          this.notifyErrorListeners(err);
          this.client.disconnect();
          return;
        }
        let key: Uint8Array;
        try {
          key = await unwrapConversationKey(
            wrapped,
            registration.deviceX25519PrivateKey!,
          );
        } catch (err) {
          console.error("[nats-client] conversation-key unwrap failed:", err);
          this.notifyErrorListeners(err as Error);
          this.client.disconnect();
          return;
        }
        if (this.connectionEpoch !== epoch) return;
        this.sessionKey = key;
        this.drainPendingInbound();
        this.flushQueue();
        return;
      }
    }

    // Legacy per-connection X25519 handshake (no registration at all — the
    // wildcard/auto-admission path — or an embedder that has not supplied the
    // cnf device key yet).
    const keyPair = await generateX25519KeyPair();
    // Same guard after the keygen await: do not clobber a fresher flow's keyPair
    // or publish a stale handshake.
    if (this.connectionEpoch !== epoch) return;
    this.keyPair = keyPair;
    this.publishHandshakeWithRetry(epoch, 0);
  }

  /**
   * Publish the `key_exchange` handshake frame and, if the agent has not answered
   * (no session key) within a short window, republish — up to `HANDSHAKE_MAX_RETRIES`
   * times. Guarded by the connection epoch so a stale flow never republishes onto a
   * newer connection. Stops as soon as `handleRaw` establishes the session key.
   */
  private publishHandshakeWithRetry(epoch: number, attempt: number): void {
    if (this.connectionEpoch !== epoch || this.sessionKey || !this.keyPair) return;
    const { tenant, accountId, peerId } = this.options;
    this.client.publish(
      handshakeSubject(tenant, accountId, peerId),
      keyExchangeFrame(this.keyPair.publicKeyB64url),
    );
    if (attempt >= HANDSHAKE_MAX_RETRIES) return;
    if (this.handshakeRetryTimer) clearTimeout(this.handshakeRetryTimer);
    this.handshakeRetryTimer = setTimeout(() => {
      this.handshakeRetryTimer = null;
      this.publishHandshakeWithRetry(epoch, attempt + 1);
    }, HANDSHAKE_RETRY_MS);
  }

  private clearHandshakeRetry(): void {
    if (this.handshakeRetryTimer) {
      clearTimeout(this.handshakeRetryTimer);
      this.handshakeRetryTimer = null;
    }
  }

  private async handleRaw(subject: string, payload: string): Promise<void> {
    const { tenant, accountId, peerId } = this.options;

    if (subject === handshakeSubject(tenant, accountId, peerId)) {
      if (this.sessionKey || !this.keyPair) return; // already established / not ready
      const agentPubKey = parseKeyExchange(payload);
      if (!agentPubKey) return;
      this.sessionKey = await deriveConversationKey(this.keyPair.privateKey, agentPubKey);
      this.clearHandshakeRetry();
      this.drainPendingInbound();
      this.flushQueue();
      return;
    }

    if (subject === outboundSubject(tenant, accountId, peerId)) {
      if (!this.sessionKey) {
        // Fail-closed, but not lossy: buffer (bounded) until the key exists —
        // the register-triggered snapshot can beat the HTTP-delivered key by a
        // beat (see `pendingInbound`). Never processed as plaintext.
        if (this.pendingInbound.length < WebChannelNatsClient.MAX_PENDING_INBOUND) {
          this.pendingInbound.push(payload);
        }
        return;
      }
      const msg = openMessage(payload, this.sessionKey) as InboundMessage | null;
      if (msg) this.notifyMessageListeners(msg);
      return;
    }
  }

  private enqueue(message: OutboundMessage): void {
    if (!this.sessionKey) {
      this.outboundQueue.push(message);
      return;
    }
    this.seal(message);
  }

  private flushQueue(): void {
    if (!this.sessionKey) return;
    const queued = this.outboundQueue;
    this.outboundQueue = [];
    for (const message of queued) this.seal(message);
  }

  private seal(message: OutboundMessage): void {
    if (!this.sessionKey) {
      // Fail-closed: never publish plaintext; re-queue until the key exists.
      this.outboundQueue.push(message);
      return;
    }
    const { tenant, accountId, peerId } = this.options;
    const wire = sealMessage({ accountId, tenant, sub: peerId }, this.sessionKey, message);
    this.client.publish(inboundSubject(tenant, accountId, peerId), wire);
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

  private notifyErrorListeners(err: Error): void {
    this.errorListeners.forEach((listener) => {
      try {
        listener(err);
      } catch (e) {
        console.error("[nats-client] Error listener error:", e);
      }
    });
  }
}
