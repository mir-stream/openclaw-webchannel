/**
 * NatsTransport — outbound-only NATS WebSocket client.
 *
 * Sub-AC 1 compliance: this module NEVER opens a TCP listening socket.
 * It connects as a WebSocket CLIENT (outbound) to a NATS server. Inbound
 * messages arrive via NATS subscriptions (server-push), not via any
 * inbound TCP connection to this process.
 *
 * Design rationale:
 *  - `new WebSocket(url)` is a CLIENT dial — it connects to a remote address,
 *    never binds a local port for listening.
 *  - No `WebSocketServer`, `net.createServer()`, `http.createServer()`, or
 *    `listen()` call anywhere in this module.
 *  - The agent publishes responses and backlog replays via `publish()`.
 *    The agent receives browser messages via the 'message' event fired by
 *    NATS subscriptions. There is no inbound network surface.
 *
 * Protocol: NATS text protocol over WebSocket (compatible with nats-server v2+
 * `websocket:` listener mode). Wire format is identical to TCP NATS — the
 * WebSocket framing layer is transparent.
 */

import WebSocket from "ws";
import { EventEmitter } from "node:events";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type NatsConnectOptions = {
  /** WebSocket URL of the NATS server, e.g. ws://nats:4222 or wss://nats:8443 */
  url: string;
  /**
   * NATS user JWT (from SaaS-issued credentials for this agent). Passed in the
   * CONNECT command's `jwt` field. Required when the NATS account enforces JWT
   * authentication (production). May be omitted for open dev servers.
   */
  jwtCredential?: string;
  /**
   * NKEY challenge-response signing callback for enrolled-JWT mode.
   *
   * When the NATS server requires JWT authentication, it sends a nonce in the
   * INFO message. The client must sign the nonce with the user's NKEY private
   * key and include the signature in the CONNECT command.
   *
   * This callback receives the nonce string and returns a base64url-encoded
   * Ed25519 signature. When provided, the transport waits for the server's
   * INFO message before sending CONNECT (rather than sending immediately on
   * WebSocket open) — this is the correct NATS JWT auth flow.
   *
   * Example (using @nats-io/nkeys, allowed in packages/saas):
   *   const kp = fromSeed(new TextEncoder().encode(userSeed));
   *   nkeySigningCallback: (nonce) =>
   *     Promise.resolve(Buffer.from(kp.sign(new TextEncoder().encode(nonce))).toString("base64url"))
   */
  nkeySigningCallback?: (nonce: string) => Promise<string>;
  /**
   * Client name reported to the NATS server (INFO-visible, debug aid only).
   * Defaults to 'openclaw-webchannel-agent'.
   */
  clientName?: string;
  /**
   * Seam for dependency injection in tests. When provided, this factory is
   * called instead of `new WebSocket(url)`. Allows tests to drive the
   * transport with a fake WebSocket without spying on the module's default
   * export (which is non-writable in ESM).
   *
   * @internal — not part of the public API; may change without semver notice.
   */
  _wsFactory?: (url: string) => WebSocket;
};

/** An inbound NATS message delivered on a subscribed subject. */
export type NatsMessage = {
  subject: string;
  /** The reply-to subject if this message was published with a reply. */
  replyTo?: string;
  /** Raw message payload (UTF-8 text or binary). */
  payload: Buffer;
};

// ---------------------------------------------------------------------------
// NatsTransport
// ---------------------------------------------------------------------------

/**
 * Outbound-only NATS WebSocket client.
 *
 * The agent uses this to:
 *  1. Connect to the shared untrusted NATS bus (outbound-only; no listen()).
 *  2. Subscribe to per-user inbound subjects (browser → agent).
 *  3. Publish to per-user outbound subjects (agent → browser).
 *
 * Events:
 *  - 'connect'    (): NATS handshake complete, ready to pub/sub.
 *  - 'disconnect' (): connection dropped (network or server close).
 *  - 'message'    (NatsMessage): inbound message on a subscribed subject.
 *  - 'error'      (Error): protocol or connection error.
 */
export class NatsTransport extends EventEmitter {
  // The underlying WebSocket CLIENT connection. null when disconnected.
  private ws: WebSocket | null = null;

  // Monotone subscription-id counter. Incremented on each SUB command.
  private sidCounter = 0;

  // Active subscriptions: sid → subject. Used for cleanup on disconnect.
  private readonly subs: Map<number, string> = new Map();

  // Partial-line buffer for NATS protocol parsing (text frames may split).
  private buffer = "";

  // Whether the NATS handshake (INFO→CONNECT→PONG) has completed.
  private _connected = false;

  // Prevents sending CONNECT twice in JWT mode (INFO may arrive in fragments).
  private _connectSent = false;

  private readonly url: string;
  private readonly jwtCredential?: string;
  private readonly nkeySigningCallback?: (nonce: string) => Promise<string>;
  private readonly clientName: string;
  private readonly wsFactory: (url: string) => WebSocket;

  constructor(options: NatsConnectOptions) {
    super();
    this.url = options.url;
    this.jwtCredential = options.jwtCredential;
    this.nkeySigningCallback = options.nkeySigningCallback;
    this.clientName = options.clientName ?? "openclaw-webchannel-agent";
    // Default factory: real outbound WebSocket CLIENT connection.
    this.wsFactory = options._wsFactory ?? ((url) => new WebSocket(url));
  }

  /** `true` once the NATS CONNECT/PONG handshake has completed. */
  get connected(): boolean {
    return this._connected;
  }

  // ---------------------------------------------------------------------------
  // Connection lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Connect outbound to the NATS server over WebSocket.
   *
   * Creates a WebSocket CLIENT connection (never a server socket).
   * Resolves when the NATS handshake (INFO → CONNECT → PONG) is complete.
   * Rejects on connection failure, TCP refuse, or NATS error.
   *
   * Port-scan invariant: after this call (success or failure) the current
   * process has ZERO new TCP sockets in LISTEN state.
   */
  connect(): Promise<void> {
    this._connectSent = false;
    return new Promise<void>((resolve, reject) => {
      // ── Outbound WebSocket CLIENT connection ────────────────────────────
      // `wsFactory(url)` dials the remote NATS server. The default factory
      // calls `new WebSocket(url)` — a CLIENT connect, NOT a server bind.
      // No local port is opened for listening; there is NO inbound socket.
      const ws = this.wsFactory(this.url);
      this.ws = ws;
      this.buffer = "";

      // `handshakeDone` gates whether we emit errors to EventEmitter listeners.
      // Before the handshake completes, errors reject the connect() promise;
      // after it completes, errors are emitted so callers can react.
      let handshakeDone = false;
      let settled = false;
      const settle = (err?: Error): void => {
        if (settled) return;
        settled = true;
        if (err) {
          reject(err);
        } else {
          handshakeDone = true;
          resolve();
        }
      };

      ws.on("open", () => {
        if (this.nkeySigningCallback) {
          // ── JWT auth mode: wait for INFO with nonce before sending CONNECT ──
          // In enrolled-JWT mode the real nats-server sends INFO (containing a
          // challenge nonce) as the first message. We MUST sign that nonce and
          // include the signature in CONNECT before the server will accept us.
          // Nothing to send here — drainBuffer will fire sendConnectWithJwt()
          // when the first INFO line arrives.
        } else {
          // ── Open NATS mode: send CONNECT immediately on WebSocket open ──────
          // For unauthenticated / open servers (dev mode) we can send CONNECT
          // right away. The FakeNatsBroker used in integration tests also relies
          // on this ordering (it responds to PING with INFO + PONG).
          const connectPayload: Record<string, unknown> = {
            verbose: false,
            pedantic: false,
            lang: "typescript",
            version: "1.0.0",
            protocol: 1,
            echo: false,
            name: this.clientName,
          };
          if (this.jwtCredential) {
            connectPayload["jwt"] = this.jwtCredential;
          }
          ws.send(`CONNECT ${JSON.stringify(connectPayload)}\r\n`);
          // Initiate the round-trip that proves the connection is ready.
          ws.send("PING\r\n");
        }
      });

      ws.on("message", (data: Buffer | string) => {
        const chunk =
          Buffer.isBuffer(data) ? data.toString("utf8") : (data as string);
        this.buffer += chunk;
        this.drainBuffer(settle);
      });

      ws.on("error", (err: Error) => {
        // Network-level error (refused, DNS fail, TLS fail, etc.).
        // If the handshake hasn't finished yet, reject the connect() promise
        // (the caller handles it via await/catch — no need to also throw via
        // EventEmitter 'error', which would be an unhandled error if the
        // caller hasn't added a listener yet).
        if (!handshakeDone) {
          settle(err);
        } else {
          // Post-handshake error — emit to registered listeners.
          this._connected = false;
          this.emitError(err);
        }
      });

      ws.on("close", () => {
        this._connected = false;
        this.emit("disconnect");
        // If the socket closed before the handshake completed, the promise
        // is still pending — reject it.
        settle(new Error("NatsTransport: connection closed before NATS handshake"));
      });
    });
  }

  /**
   * Drain the internal line buffer and dispatch complete NATS protocol lines.
   *
   * `onFirstPong` is the one-shot callback (resolve/reject) for the `connect()`
   * Promise. It is called exactly once — on the first PONG (success) or on any
   * -ERR before that (failure).
   */
  private drainBuffer(onFirstPong?: (err?: Error) => void): void {
    // NATS lines are terminated by \r\n. MSG payloads follow immediately after
    // the MSG header line (also terminated by \r\n).
    let crlfPos: number;
    while ((crlfPos = this.buffer.indexOf("\r\n")) !== -1) {
      const line = this.buffer.slice(0, crlfPos);
      this.buffer = this.buffer.slice(crlfPos + 2);

      if (!line) continue;

      if (line.startsWith("INFO ")) {
        // Server INFO — carried as JSON after "INFO ".
        // In JWT auth mode, the INFO contains a challenge nonce that we must
        // sign before sending CONNECT. sendConnectWithJwt() is idempotent
        // (guarded by _connectSent) so repeated INFO lines are safe.
        if (this.nkeySigningCallback && !this._connectSent) {
          this._connectSent = true;
          void this.sendConnectWithJwt(line, onFirstPong);
        }
        continue;
      }

      if (line === "PONG") {
        // PONG is the server's reply to our PING, confirming the connection.
        if (!this._connected) {
          this._connected = true;
          this.emit("connect");
          onFirstPong?.();
        } else {
          // Subsequent PONGs are heartbeat replies.
          this.emit("pong");
        }
        continue;
      }

      if (line === "PING") {
        // Server-side keepalive ping — reply immediately.
        this.ws?.send("PONG\r\n");
        continue;
      }

      if (line.startsWith("MSG ")) {
        // MSG <subject> <sid> [reply-to] <byte-count>\r\n<payload>\r\n
        //
        // We parse the header and consume exactly <byte-count> bytes for the
        // payload from the buffer. If the buffer doesn't yet hold the full
        // payload we put everything back and wait for the next chunk.
        const parts = line.split(" ");
        // parts[0]="MSG" parts[1]=subject parts[2]=sid
        // With reply-to: parts[3]=reply-to parts[4]=byteCount
        // Without:       parts[3]=byteCount
        const hasReplyTo = parts.length === 5;
        const subject = parts[1] ?? "";
        const replyTo = hasReplyTo ? parts[3] : undefined;
        const byteCount = parseInt(parts[hasReplyTo ? 4 : 3] ?? "0", 10);

        if (isNaN(byteCount) || byteCount < 0) continue; // malformed, skip

        // The payload plus the trailing \r\n must be in the buffer.
        if (this.buffer.length < byteCount + 2) {
          // Incomplete payload — put the header line back and wait.
          this.buffer = `${line}\r\n${this.buffer}`;
          break;
        }

        const payload = Buffer.from(this.buffer.slice(0, byteCount));
        this.buffer = this.buffer.slice(byteCount + 2); // consume payload + \r\n

        const msg: NatsMessage = { subject, replyTo, payload };
        this.emit("message", msg);
        continue;
      }

      if (line.startsWith("-ERR ")) {
        const err = new Error(`NATS server error: ${line}`);
        if (!this._connected && onFirstPong) {
          // Still in handshake — reject the connect() promise directly.
          // Do NOT also emit 'error' here: the promise rejection IS the error
          // signal, and emitting 'error' with no listener would throw.
          onFirstPong(err);
        } else {
          // Post-handshake NATS error (e.g. Permissions Violation for Publish/
          // Subscription) — emit to registered listeners so callers can react.
          this.emitError(err);
        }
        continue;
      }

      if (line === "+OK") {
        // Verbose-mode ACK — safe to ignore (we disable verbose).
        continue;
      }

      // Unknown line — ignore to stay forward-compatible.
    }
  }

  // ---------------------------------------------------------------------------
  // Pub/sub API
  // ---------------------------------------------------------------------------

  /**
   * Subscribe to a NATS subject.
   *
   * Inbound messages are delivered via the 'message' event. Subjects may
   * include wildcards: `*` (single token) or `>` (multi-token tail).
   *
   * @returns numeric sid for use in `unsubscribe()`.
   */
  subscribe(subject: string): number {
    this.assertOpen();
    const sid = ++this.sidCounter;
    this.subs.set(sid, subject);
    this.ws!.send(`SUB ${subject} ${sid}\r\n`);
    return sid;
  }

  /**
   * Unsubscribe from a subject by sid.
   */
  unsubscribe(sid: number): void {
    this.subs.delete(sid);
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(`UNSUB ${sid}\r\n`);
    }
  }

  /**
   * Publish a message to a NATS subject.
   *
   * This is the agent's outbound path: all responses, backlog replays, and
   * approval resolutions flow through here. There is no inbound network call
   * required — the NATS server fans the message out to subscribed browsers.
   *
   * @param subject NATS subject (routing metadata; plaintext per design).
   * @param payload Message content. For E2E encrypted envelopes this will be
   *   ciphertext (subsequent ACs); for Sub-AC 1 the payload format is not
   *   yet constrained.
   */
  publish(subject: string, payload: string | Buffer): void {
    this.assertOpen();
    const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, "utf8");
    // NATS PUB wire format:
    //   PUB <subject> <byte-count>\r\n<payload>\r\n
    this.ws!.send(`PUB ${subject} ${buf.length}\r\n`);
    this.ws!.send(buf);
    this.ws!.send("\r\n");
  }

  // ---------------------------------------------------------------------------
  // Teardown
  // ---------------------------------------------------------------------------

  /**
   * Disconnect from the NATS server and clean up. Idempotent.
   */
  disconnect(): void {
    this._connected = false;
    this.subs.clear();
    this.buffer = "";
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // Already closed or in a bad state — nothing to do.
      }
      this.ws = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Build and send CONNECT after receiving the server's INFO (JWT auth mode).
   *
   * Extracts the nonce from the INFO JSON, calls `nkeySigningCallback` to sign
   * it, then sends `CONNECT {jwt, sig, ...}` + `PING`.
   *
   * This method is called asynchronously from drainBuffer (via `void`) and
   * resolves or rejects the outer connect() Promise via the `settle` callback.
   */
  private async sendConnectWithJwt(
    infoLine: string,
    settle?: (err?: Error) => void,
  ): Promise<void> {
    try {
      // Extract nonce from INFO JSON: INFO {"nonce":"abc123",...}
      let nonce = "";
      try {
        const infoJson = JSON.parse(infoLine.slice(5).trim()) as {
          nonce?: string;
        };
        nonce = infoJson.nonce ?? "";
      } catch {
        /* no nonce field — proceed without sig (open NATS on wrong code path) */
      }

      // Sign the nonce with the user NKEY private key.
      let sig = "";
      if (nonce && this.nkeySigningCallback) {
        sig = await this.nkeySigningCallback(nonce);
      }

      const connectPayload: Record<string, unknown> = {
        verbose: false,
        pedantic: false,
        lang: "typescript",
        version: "1.0.0",
        protocol: 1,
        echo: false,
        name: this.clientName,
      };
      if (this.jwtCredential) {
        connectPayload["jwt"] = this.jwtCredential;
      }
      if (sig) {
        connectPayload["sig"] = sig;
      }

      this.ws!.send(`CONNECT ${JSON.stringify(connectPayload)}\r\n`);
      this.ws!.send("PING\r\n");
    } catch (err) {
      settle?.(err instanceof Error ? err : new Error(String(err)));
    }
  }

  private assertOpen(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("NatsTransport: not connected — call connect() first");
    }
  }

  /**
   * Emit a post-handshake `error` event WITHOUT risking a process crash.
   *
   * Node's EventEmitter rethrows an emitted `"error"` as an uncaught exception
   * when NO `"error"` listener is registered. On the live NATS path a single
   * transient failure (NATS restart → TCP reset; a post-connect
   * `-ERR Permissions Violation`) would otherwise kill the WHOLE gateway
   * process — every channel, every account — not just the affected connection
   * (review 2026-07-02 finding C1).
   *
   * This backstop guarantees that can never happen: if a listener is present
   * the error is delivered normally; if not, it is logged instead of thrown.
   * Consumers SHOULD still attach an `"error"` listener (for structured logging
   * and reconnect); this guard only protects against a consumer that forgot to.
   */
  private emitError(err: Error): void {
    if (this.listenerCount("error") > 0) {
      this.emit("error", err);
    } else {
      // Last-resort backstop — a consumer forgot to attach an "error" listener.
      // Log instead of letting Node rethrow as an uncaught exception.
      console.error(
        `[NatsTransport] unhandled connection error (no "error" listener attached): ${err.message}`,
      );
    }
  }
}
