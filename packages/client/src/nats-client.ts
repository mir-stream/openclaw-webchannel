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
  PopRejectedError,
  PopServerError,
  ProtocolVersionMalformedError,
} from "./pop-register.js";
import type { CommandCatalogEntry, WebChannelErrorCause } from "./types.js";
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
    | "ack";
  id?: string;
  /** P0-7b: the acknowledged `user_message` ids on an `ack` frame. */
  ids?: string[];
  text?: string;
  turnId?: string;
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

export type WebChannelNatsClientOptions = Omit<NatsClientOptions, "jwt" | "registration"> & {
  jwt: string;
  registration: NonNullable<NatsClientOptions["registration"]>;
};

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
        if (this.ws === ws) this.forceReconnect();
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
        // CONNECT goes out synchronously here — mark it on-wire BEFORE the send so
        // a server that answers our PING with a PONG in the same tick (the test
        // fake does) is not mistaken for an unsolicited PONG and dropped.
        dial.connectOnWire = true;
        this.sendConnect(ws);
        armDeadline("first PONG");
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
          this.notifyStateListeners();
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
        const result = this.handleMessage(line, lineBytes, buffer);
        if (!result) return new Uint8Array(0);
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
  private handleMessage(line: string, lineBytes: Uint8Array, buffer: Uint8Array): { buffer: Uint8Array; complete: boolean } | null {
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
    this.notifyRawListeners(subject, payload);
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
    this.scheduleReconnect();
    this.notifyStateListeners();
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

  private sessionKey: Uint8Array | null = null;
  private outboundQueue: OutboundMessage[] = [];
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
  private readonly unackedLedger = new Map<string, OutboundMessage>();
  /** P0-7b: cap on the unacked ledger; the oldest entry is evicted (with a warn) past this. */
  private static readonly MAX_UNACKED = 100;
  /** P0-7b: one-shot guard so a full ledger warns once per session, not per evicted send. */
  private warnedUnackedEvict = false;
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
    this.client.onError((err, cause) => this.notifyErrorListeners(err, cause));
  }

  /** Connect to NATS (registration begins automatically once connected). */
  connect(): void {
    this.client.connect();
  }

  /** Disconnect from NATS and drop the session. */
  disconnect(): void {
    this.connectionEpoch++;
    if (this.outSub >= 0) this.client.unsubscribe(this.outSub);
    this.outSub = -1;
    this.resetSession();
    // P0-7b: an explicit disconnect retires this instance — drop the unacked
    // ledger (unlike resetSession, which keeps it across a mid-session drop).
    this.unackedLedger.clear();
    this.client.disconnect();
  }

  /**
   * Send user message (buffered until the handshake completes). Returns the
   * stable wire `id` stamped on the frame so the caller can correlate a later
   * `ack` (P0-7b) back to its local echo.
   */
  sendUserMessage(text: string): string {
    // P0-7a: stamp a stable, unique id per logical send. The agent records it at
    // ingress and drops a duplicate frame (rapid double-submit; the P0-7b replay
    // queue re-send after reconnect) so it never runs the turn twice. Reuse the
    // package's existing randomness helper (WebCrypto-preferring, Math.random
    // fallback) rather than `crypto.randomUUID` so we match the client's
    // established host assumptions; the id only needs to be collision-unguessable,
    // not a UUID.
    const id = randomInboxToken();
    this.enqueue({ type: "user_message", text, id });
    return id;
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
   * register with the agent-plugin's protocol/plugin version (either may be
   * null against a pre-v1/pre-reporting plugin). A version MISMATCH does not
   * fire this — it flows through `onError` as a terminal failure.
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

  // ---------------------------------------------------------------------------
  // Internal — handshake + crypto
  // ---------------------------------------------------------------------------

  private resetSession(): void {
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
    this.notifyMessageListeners(msg);
  }

  /** P0-7b: remove acked ids from the unacked ledger; unknown ids are a no-op. */
  private drainAcked(ids?: string[]): void {
    if (!ids) return;
    for (const id of ids) this.unackedLedger.delete(id);
  }

  private async onConnected(): Promise<void> {
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
        if (this.connectionEpoch !== epoch) return;
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
            : err instanceof ProtocolVersionMalformedError ? "protocol-mismatch"
            : err instanceof PopServerError ? "server"
            : "unknown";
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
      if (this.connectionEpoch !== epoch) return;

      // Wire-protocol handshake (mirrors the :1080 pin-failure style). The plugin
      // echoes its protocol + package versions in the register reply:
      //   - absent protocolVersion  → pre-v1 plugin; NON-FATAL, expose null.
      //   - present but mismatched   → TERMINAL: the two sides speak incompatible
      //     wire contracts, so surface a two-sided diagnostic and disconnect
      //     (only upgrading the older side, or a fresh client, can recover).
      //   - match                    → proceed; expose both versions on state.
      const agentProtocolVersion =
        typeof registerResult.protocolVersion === "number" ? registerResult.protocolVersion : null;
      const agentPluginVersion =
        typeof registerResult.pluginVersion === "string" ? registerResult.pluginVersion : null;
      if (agentProtocolVersion !== null && agentProtocolVersion !== WEBCHANNEL_PROTOCOL_VERSION) {
        const err = new Error(
          `webchannel protocol mismatch: client=${WEBCHANNEL_PROTOCOL_VERSION} ` +
            `agent-plugin=${agentProtocolVersion}; upgrade the older side`,
        );
        // P1-7: re-auth cannot reconcile incompatible wire versions.
        this.failConnectionEpoch(epoch, connectionGeneration, err, "protocol-mismatch");
        return;
      }
      this.notifyProtocolListeners({
        protocolVersion: agentProtocolVersion,
        pluginVersion: agentPluginVersion,
      });
      if (this.connectionEpoch !== epoch) return;

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
          this.failConnectionEpoch(epoch, connectionGeneration, err, "secure-channel-failed");
          return;
        }
        let key: Uint8Array;
        try {
          key = await unwrapConversationKey(
            wrapped,
            registration.deviceX25519PrivateKey,
            registration.pinnedAgentPublicKey,
            peerId,
          );
        } catch (err) {
          if (this.connectionEpoch !== epoch) return;
          console.error("[nats-client] conversation-key unwrap failed:", err);
          // P1-7: the E2E session could not be established (bad/tampered key or a
          // stale pin) — re-auth to retry with fresh keys.
          this.failConnectionEpoch(epoch, connectionGeneration, err as Error, "secure-channel-failed");
          return;
        }
        if (this.connectionEpoch !== epoch) return;
        this.sessionKey = key;
        // drainPendingInbound() synchronously invokes message listeners; one that
        // calls disconnect()+connect() advances the epoch under us. Re-check before
        // flushing/notifying so a stale flow never publishes on — or fires a false
        // "session established" for — a connection generation that is no longer
        // current (session listeners gate P1-9 unsend-hold release).
        this.drainPendingInbound();
        if (this.connectionEpoch !== epoch) return;
        this.flushQueue();
        if (this.connectionEpoch !== epoch) return;
        // P1-9: notify AFTER flushQueue so a released hold is ordered behind the
        // P0-7b ledger replay (drain → flush → notify; see onSession).
        this.notifySessionListeners();
        return;
      }
    }
  }

  /** Guard terminal handling across both stale async flows and sync listener re-entry. */
  private failConnectionEpoch(
    epoch: number, connectionGeneration: number, err: Error, cause: WebChannelErrorCause,
  ): void {
    if (this.connectionEpoch !== epoch) return;
    // Retire the failed generation BEFORE invoking embedder code. An error
    // listener may synchronously call connect() after the failed socket has
    // already closed; that creates a replacement dial whose onConnected() has
    // not run yet, so it cannot advance the epoch for itself. Keeping `epoch`
    // current through notification would let this old terminal continuation's
    // post-listener guard pass and disconnect that replacement socket.
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
    if (!this.sessionKey) {
      this.outboundQueue.push(message);
      return;
    }
    this.seal(message);
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
      const replay = [...this.unackedLedger.values()];
      this.unackedLedger.clear();
      this.outboundQueue = [...replay, ...this.outboundQueue];
    }
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
    // P0-7b: record a user_message in the unacked ledger BEFORE publishing so it
    // can be replayed if the session drops before the agent acks it. Recording
    // first (not after publish) means a fast ack can't race ahead of the record
    // and leave a drained id re-inserted. Only user_messages (see `unackedLedger`);
    // an id-less frame from a caller that bypassed sendUserMessage is not
    // replayable and is skipped.
    if (message.type === "user_message" && message.id) {
      this.recordUnacked(message.id, message);
    }
    const wire = sealMessage({ accountId, tenant, sub: peerId }, this.sessionKey, message);
    this.client.publish(inboundSubject(tenant, accountId, peerId), wire);
  }

  /** P0-7b: record an unacked user_message, evicting the oldest past the cap. */
  private recordUnacked(id: string, message: OutboundMessage): void {
    this.unackedLedger.set(id, message);
    while (this.unackedLedger.size > WebChannelNatsClient.MAX_UNACKED) {
      const oldest = this.unackedLedger.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.unackedLedger.delete(oldest);
      if (!this.warnedUnackedEvict) {
        // Warn ONCE per session (re-armed in resetSession) — a full ledger means
        // an unusually long delivery stall; a per-send warn would spam a burst.
        this.warnedUnackedEvict = true;
        console.warn(
          `[nats-client] unacked ledger exceeded ${WebChannelNatsClient.MAX_UNACKED}; ` +
            `evicting the oldest unacked message(s) — they will not be replayed on reconnect`,
        );
      }
    }
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

  private notifySessionListeners(): void {
    this.sessionListeners.forEach((listener) => {
      try {
        listener();
      } catch (e) {
        console.error("[nats-client] Session listener error:", e);
      }
    });
  }
}
