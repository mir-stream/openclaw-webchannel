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
   * Auto-reconnect after an ESTABLISHED connection drops (review 2026-07-02 S1).
   *
   * When `true`, a post-handshake close/error schedules a re-dial with
   * exponential backoff and, on success, replays the active subscriptions so
   * inbound delivery resumes transparently. When `false` (default) a dropped
   * connection stays down until the caller calls `connect()` again — the
   * pre-S1 behaviour, preserved so existing callers/tests are unaffected.
   *
   * NOTE: this governs only reconnection of an already-established connection.
   * The INITIAL `connect()` never auto-retries — its promise resolves/rejects
   * so the caller keeps control of first-connect failure handling.
   */
  reconnect?: boolean;
  /** Base backoff before the first reconnect attempt, ms. Default 500. */
  reconnectBaseMs?: number;
  /** Maximum backoff between reconnect attempts, ms. Default 15_000. */
  reconnectCapMs?: number;
  /**
   * Give up after this many consecutive failed reconnect attempts (then emit a
   * terminal `error`). Default `Infinity` — keep retrying with capped backoff.
   */
  maxReconnectAttempts?: number;
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
 *  - 'reconnect'  (): a dropped connection was re-established and its
 *                     subscriptions replayed (only when `reconnect: true`).
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

  // ── Reconnect state (S1) ───────────────────────────────────────────────────
  private readonly reconnectEnabled: boolean;
  private readonly reconnectBaseMs: number;
  private readonly reconnectCapMs: number;
  private readonly maxReconnectAttempts: number;
  // Set once disconnect() is called — stops any further reconnection.
  private closed = false;
  // Consecutive failed reconnect attempts; reset to 0 on a successful reconnect.
  private reconnectAttempts = 0;
  // Pending backoff timer, if a reconnect is scheduled.
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: NatsConnectOptions) {
    super();
    this.url = options.url;
    this.jwtCredential = options.jwtCredential;
    this.nkeySigningCallback = options.nkeySigningCallback;
    this.clientName = options.clientName ?? "openclaw-webchannel-agent";
    this.reconnectEnabled = options.reconnect ?? false;
    this.reconnectBaseMs = options.reconnectBaseMs ?? 500;
    this.reconnectCapMs = options.reconnectCapMs ?? 15_000;
    this.maxReconnectAttempts = options.maxReconnectAttempts ?? Infinity;
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
    // Re-arm auto-reconnect: an explicit connect() undoes a prior explicit
    // disconnect(). Without this, a transport reused via disconnect() →
    // connect() would silently lose S1 auto-reconnect forever (`closed` was
    // only ever set, never cleared).
    this.closed = false;
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
        } else if (this.ws === ws) {
          // Post-handshake error — emit to registered listeners. Identity
          // guard: after disconnect() (ws → null) or a newer connect(), this
          // is a STALE socket's error — it must not touch the live state.
          this._connected = false;
          this.emitError(err);
        }
      });

      ws.on("close", () => {
        // If the socket closed before the handshake completed, the promise
        // is still pending — reject it. Always settle OUR OWN dial's promise,
        // even if the transport has since moved on to a newer socket.
        settle(new Error("NatsTransport: connection closed before NATS handshake"));
        // Stale-socket guard: ws close events fire ASYNC, so after an explicit
        // disconnect() (ws → null) or a newer connect() replaced this.ws, this
        // close belongs to a PREVIOUS socket — it must not flip the live
        // connection's state, emit a spurious "disconnect", or schedule a
        // reconnect alongside the live socket.
        if (this.ws !== ws) return;
        this._connected = false;
        this.emit("disconnect");
        // S1: auto-reconnect ONLY for an ESTABLISHED connection that dropped.
        // `handshakeDone` is per-socket, so a close during the INITIAL connect
        // (or a failed reconnect attempt's own handshake) does NOT schedule here
        // — first-connect failure is the caller's to handle, and a failed
        // reconnect attempt reschedules from reconnectOnce()'s catch instead.
        if (this.reconnectEnabled && !this.closed && handshakeDone) {
          this.scheduleReconnect();
        }
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
          this.safeEmit("connect");
          onFirstPong?.();
        } else {
          // Subsequent PONGs are heartbeat replies.
          this.safeEmit("pong");
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
        this.safeEmit("message", msg);
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

  /**
   * Publish with a NATS reply-to subject (the requester half of request/reply):
   *   PUB <subject> <reply-to> <byte-count>\r\n<payload>\r\n
   * The subscriber sees `msg.replyTo` and publishes its response there. Symmetric
   * with the receive-side reply-to parsing already in the MSG handler. Used by
   * e2e drivers that drive the NATS register hop (`…{peerId}.register`).
   */
  publishWithReply(subject: string, replyTo: string, payload: string | Buffer): void {
    this.assertOpen();
    const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, "utf8");
    this.ws!.send(`PUB ${subject} ${replyTo} ${buf.length}\r\n`);
    this.ws!.send(buf);
    this.ws!.send("\r\n");
  }

  // ---------------------------------------------------------------------------
  // Teardown
  // ---------------------------------------------------------------------------

  /**
   * Disconnect from the NATS server and clean up. Idempotent.
   *
   * Marks the transport permanently closed so any in-flight or scheduled
   * reconnect (S1) is cancelled — an explicit disconnect must never be
   * undone by the auto-reconnect loop.
   */
  disconnect(): void {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
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
  // Auto-reconnect (S1)
  // ---------------------------------------------------------------------------

  /**
   * Schedule a reconnect attempt with exponential backoff (capped).
   *
   * Idempotent while a timer is already pending. The timer is `unref`'d so a
   * pending reconnect never keeps the process alive on its own. After
   * `maxReconnectAttempts` consecutive failures it stops and emits a terminal
   * `error` (crash-safe via `emitError`).
   */
  private scheduleReconnect(): void {
    if (this.closed) return;
    if (this.reconnectTimer) return; // already scheduled
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.emitError(
        new Error(
          `NatsTransport: giving up reconnect after ${this.reconnectAttempts} attempts`,
        ),
      );
      return;
    }
    // Exponential backoff: base * 2^attempts, capped. attempts starts at 0.
    const delay = Math.min(
      this.reconnectBaseMs * 2 ** this.reconnectAttempts,
      this.reconnectCapMs,
    );
    this.reconnectAttempts++;
    const timer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.reconnectOnce();
    }, delay);
    if (typeof timer.unref === "function") timer.unref();
    this.reconnectTimer = timer;
  }

  /**
   * Perform a single reconnect attempt: re-dial, redo the NATS handshake, and
   * on success replay the active subscriptions so inbound delivery resumes.
   * On failure, schedule the next backoff.
   */
  private async reconnectOnce(): Promise<void> {
    if (this.closed) return;
    // Capture the subjects we WANT subscribed. We do NOT clear `this.subs` yet:
    // if this attempt fails, the entries must survive so the NEXT attempt can
    // still recover them (clearing early would lose all subscriptions after a
    // single failed re-dial). Dedupe — a subject may map to several sids.
    const desiredSubjects = [...new Set(this.subs.values())];
    try {
      await this.connect();
    } catch (err) {
      // Handshake failed — the fresh socket's close handler won't reschedule
      // (its handshakeDone stayed false), so we do it here with backoff.
      // Throttled visibility: an outage that outlives the backoff cap retries
      // forever (maxReconnectAttempts defaults to Infinity) — e.g. a JWT that
      // expired during a long outage fails every attempt — and would otherwise
      // do so in total silence. Log the 1st and every 10th failed attempt.
      if (this.reconnectAttempts === 1 || this.reconnectAttempts % 10 === 0) {
        console.error(
          `[NatsTransport] reconnect attempt ${this.reconnectAttempts} failed: ` +
            `${err instanceof Error ? err.message : String(err)} — retrying with backoff`,
        );
      }
      this.scheduleReconnect();
      return;
    }
    if (this.closed) {
      // Raced with an explicit disconnect() during the handshake — stand down.
      this.disconnect();
      return;
    }
    // Success — replace the stale sid→subject entries with fresh subscriptions
    // on the new socket, then reset the backoff counter.
    this.subs.clear();
    for (const subject of desiredSubjects) {
      this.subscribe(subject);
    }
    this.reconnectAttempts = 0;
    this.emit("reconnect");
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

  /**
   * Emit an event without letting a throwing listener kill the read pump.
   *
   * `drainBuffer` runs synchronously inside the `ws.on("message")` callback, so
   * an uncaught throw from ANY listener (e.g. a malformed-frame crypto path in
   * the channel's `"message"` handler) would propagate out of the socket
   * callback as an uncaught exception → process death for every account and
   * user. This is the true root cause of the malformed-handshake crash: a single
   * peer's bad frame must never be able to take down the whole gateway. Contain
   * every listener throw here (log + continue); a bad frame degrades to a warn.
   */
  private safeEmit(event: string, ...args: unknown[]): void {
    try {
      this.emit(event, ...args);
    } catch (err) {
      console.error(
        `[NatsTransport] listener for "${event}" threw (frame dropped, read pump continues): ${String(err)}`,
      );
    }
  }
}
