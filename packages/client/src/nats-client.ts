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
  type BrowserKeyPair,
} from "./e2e-crypto-browser.js";
import { importEd25519SeedKey, signNonce } from "./nats-nkey-browser.js";
import { registerWithPop } from "./pop-register.js";

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

  constructor(options: NatsClientOptions) {
    this.options = options;
  }

  /** Connect to NATS server */
  connect(): void {
    this.connectInternal();
  }

  /** Disconnect and cleanup */
  disconnect(): void {
    this.clearReconnectTimer();
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
        if (!this.connected) {
          this.connected = true;
          this.reconnectAttempts = 0;
          console.log("[nats-client] Connected to NATS");
          this.notifyStateListeners();
          this.resubscribeAll();
        }
        continue;
      }

      if (line === "PING") {
        this.ws?.send("PONG\r\n");
        continue;
      }

      if (line.startsWith("MSG ")) {
        this.handleMessage(line);
        continue;
      }

      if (line.startsWith("-ERR ")) {
        console.error("[nats-client] NATS error:", line);
        continue;
      }
    }
  }

  private handleMessage(line: string): void {
    const parts = line.split(" ");
    const hasReplyTo = parts.length === 5;
    const subject = parts[1] ?? "";
    const byteCount = parseInt(parts[hasReplyTo ? 4 : 3] ?? "0", 10);

    if (isNaN(byteCount) || byteCount < 0) return;

    if (this.buffer.length < byteCount + 2) {
      this.buffer = `${line}\r\n${this.buffer}`;
      return;
    }

    const payload = this.buffer.slice(0, byteCount);
    this.buffer = this.buffer.slice(byteCount + 2);

    // Deliver the raw payload; decryption/parsing happens in WebChannelNatsClient
    // (the envelope must be decrypted before it is meaningful).
    this.notifyRawListeners(subject, payload);
  }

  private resubscribeAll(): void {
    this.subscriptions.forEach((subject, sid) => {
      if (this.connected && this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(`SUB ${subject} ${sid}\r\n`);
      }
    });
  }

  private scheduleReconnect(): void {
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
  private outSub = -1;
  private handshakeSub = -1;
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
    this.sessionKey = null;
    this.keyPair = null;
  }

  private async onConnected(): Promise<void> {
    const { tenant, accountId, peerId } = this.options;
    // Mark this flow as the current connection generation. Any `await` below
    // re-checks `this.connectionEpoch === epoch` so a continuation resumed after
    // a drop+reconnect bails instead of clobbering the fresh flow's state.
    const epoch = ++this.connectionEpoch;
    // (Re)subscribe idempotently: unsubscribe stale sids so a reconnect never
    // leaves duplicate subscriptions delivering the same MSG twice.
    if (this.outSub >= 0) this.client.unsubscribe(this.outSub);
    if (this.handshakeSub >= 0) this.client.unsubscribe(this.handshakeSub);
    this.outSub = this.client.subscribe(outboundSubject(tenant, accountId, peerId));
    this.handshakeSub = this.client.subscribe(handshakeSubject(tenant, accountId, peerId));

    // Fresh connection → fresh key exchange.
    this.resetSession();

    // PoP HTTP registration (production). MUST complete AFTER we subscribe to
    // .out/.handshake (above) but BEFORE we publish the handshake — the agent
    // only subscribes to this peer's subjects once registered, and NATS has no
    // retention, so a handshake published earlier would be lost. Fail-closed: if
    // registration throws, registration failure is TERMINAL for this connection.
    // A PoP/JWT rejection is typically a permanent credential problem, so we do
    // NOT silently retry (no auto-retry/hammering): we tear the connection fully
    // down via the raw NatsClient.disconnect() (clears the reconnect timer +
    // closes the socket, leaving connected === false). The application must react
    // to onError and re-initialize with fresh credentials (a new bootstrap JWT).
    const { registration } = this.options;
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
      try {
        await registerWithPop({
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
      // publish a handshake for a connection generation that is no longer current.
      if (this.connectionEpoch !== epoch) return;
    }

    const keyPair = await generateX25519KeyPair();
    // Same guard after the keygen await: do not clobber a fresher flow's keyPair
    // or publish a stale handshake.
    if (this.connectionEpoch !== epoch) return;
    this.keyPair = keyPair;
    this.client.publish(
      handshakeSubject(tenant, accountId, peerId),
      keyExchangeFrame(this.keyPair.publicKeyB64url),
    );
  }

  private async handleRaw(subject: string, payload: string): Promise<void> {
    const { tenant, accountId, peerId } = this.options;

    if (subject === handshakeSubject(tenant, accountId, peerId)) {
      if (this.sessionKey || !this.keyPair) return; // already established / not ready
      const agentPubKey = parseKeyExchange(payload);
      if (!agentPubKey) return;
      this.sessionKey = await deriveConversationKey(this.keyPair.privateKey, agentPubKey);
      this.flushQueue();
      return;
    }

    if (subject === outboundSubject(tenant, accountId, peerId)) {
      if (!this.sessionKey) return; // fail-closed: cannot read before handshake
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
