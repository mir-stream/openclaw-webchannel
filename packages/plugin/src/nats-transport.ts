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

export class NatsLifecycleAbortError extends Error {
  constructor() { super("NATS startup aborted"); this.name = "NatsLifecycleAbortError"; }
}

export class NatsHandshakeTimeoutError extends Error {
  constructor(public readonly phase: string) {
    super(`NatsTransport: handshake timeout in phase ${phase}`);
    this.name = "NatsHandshakeTimeoutError";
  }
}

export class NatsConnectionClosedError extends Error {
  constructor(
    public readonly closeCode: number,
    public readonly reasonPresent: boolean,
  ) {
    super(`NatsTransport: connection closed before NATS handshake (code=${closeCode || 1005}, reasonPresent=${reasonPresent})`);
    this.name = "NatsConnectionClosedError";
  }
}

export class NatsUnexpectedResponseError extends Error {
  constructor(public readonly statusCode: number) {
    super(`NatsTransport: WebSocket upgrade rejected (HTTP ${statusCode})`);
    this.name = "NatsUnexpectedResponseError";
  }
}

export type NatsServerErrorCode =
  | "authorization-violation"
  | "credentials-expired"
  | "authentication-timeout"
  | "protocol-error"
  | "unknown";

export class NatsServerError extends Error {
  constructor(public readonly code: NatsServerErrorCode, detail?: string) {
    const label = code === "authorization-violation" ? "Permissions Violation"
      : code === "authentication-timeout" ? "Authentication Timeout"
      : code === "credentials-expired" ? "Credentials Expired"
      : code === "protocol-error" ? "Protocol Error" : "Unknown";
    super(`NATS server error: ${detail ?? label}`);
    this.name = "NatsServerError";
  }
}

export type TransportCloseReport = {
  reconnectSuppressed: boolean;
  socketClosed: boolean;
  forcedTerminationAttempted: boolean;
  gracefulTimedOut: boolean;
  closeHandle?: { probe: () => Promise<TransportCloseReport> };
};

function parseNatsServerError(line: string): NatsServerError {
  const normalized = line.toLowerCase();
  const detail = line.replace(/^-ERR\s+'?/, "").replace(/'$/, "").replace(/[\u0000-\u001f\u007f]/g, "?").slice(0, 1024);
  if (normalized.includes("authorization violation") || normalized.includes("permissions violation")) return new NatsServerError("authorization-violation", detail);
  if (normalized.includes("authentication timeout")) return new NatsServerError("authentication-timeout", detail);
  const credentialExpired = /\bcredentials?\s+expired\b/.test(normalized);
  const authenticationExpired = /\b(?:user|account)\s+authentication\s+expired\b/.test(normalized);
  if (credentialExpired || authenticationExpired) return new NatsServerError("credentials-expired", detail);
  if (normalized.includes("protocol")) return new NatsServerError("protocol-error", detail);
  return new NatsServerError("unknown", detail);
}

function reconnectFailureLabel(error: unknown): string {
  if (error instanceof NatsServerError) return `NATS ${error.code}`;
  if (error instanceof NatsUnexpectedResponseError) return `WebSocket upgrade HTTP ${error.statusCode}`;
  if (error instanceof NatsConnectionClosedError) return `WebSocket close code ${error.closeCode || 1005}`;
  if (error instanceof NatsHandshakeTimeoutError) return `handshake timeout (${error.phase})`;
  const code = typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
  return code ? `transport ${code.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64)}` : "unclassified transport failure";
}

export const MAX_CONTROL_LINE = 64 * 1024;
export const MAX_PAYLOAD = 8 * 1024 * 1024;
export const MAX_BUFFERED_BYTES = MAX_CONTROL_LINE + MAX_PAYLOAD + 4;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type NatsConnectOptions = {
  /** WebSocket URL of the NATS server, e.g. ws://nats:4222 or wss://nats:8443 */
  url: string;
  /**
   * NATS user JWT (from SaaS-issued credentials for this agent). Passed in the
   * CONNECT command's `jwt` field. Required when the NATS account enforces JWT
   * authentication in production. May be omitted only by isolated tests and
   * low-level transport consumers; plugin serving always resolves credentials.
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
  /** Per-handshake-phase deadline in ms. Default 10,000; 0 disables it. */
  handshakeTimeoutMs?: number;
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

type FlushWaiter = {
  socket: WebSocket;
  settle: (error?: Error) => void;
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

  // Whether the NATS handshake (INFO→CONNECT→PONG) has completed.
  private _connected = false;

  private readonly url: string;
  private readonly jwtCredential?: string;
  private readonly nkeySigningCallback?: (nonce: string) => Promise<string>;
  private readonly clientName: string;
  private readonly wsFactory: (url: string) => WebSocket;
  private readonly handshakeTimeoutMs: number;
  /** Valid server-advertised INFO.max_payload, capped by our local 8 MiB ceiling. */
  private serverMaxPayload = MAX_PAYLOAD;

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
  private shutdownPromise: Promise<TransportCloseReport> | undefined;
  private retainedSocket: WebSocket | null = null;
  private readonly socketCleanup = new WeakMap<WebSocket, () => void>();
  /** In-order PING/PONG barriers used to prove server command admission. */
  private readonly flushWaiters: FlushWaiter[] = [];

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
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? 10_000;
    // Default factory: real outbound WebSocket CLIENT connection. Cap the ws
    // frame size at our own buffer bound so a hostile relay cannot make Node
    // allocate a ~100 MiB frame (ws's default maxPayload) before our per-message
    // MAX_BUFFERED_BYTES guard — which only sees data AFTER ws reassembles the
    // frame — gets a chance to reject it.
    this.wsFactory =
      options._wsFactory ?? ((url) => new WebSocket(url, { maxPayload: MAX_BUFFERED_BYTES }));
  }

  /** `true` once the NATS CONNECT/PONG handshake has completed. */
  get connected(): boolean {
    return this._connected;
  }

  get effectiveOutboundLimit(): number {
    return Math.min(MAX_PAYLOAD, this.serverMaxPayload);
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
  connect(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(new NatsLifecycleAbortError());
    if (this.retainedSocket) return Promise.reject(new Error("NatsTransport: previous socket closure is unconfirmed"));
    this.shutdownPromise = undefined;
    // Re-arm auto-reconnect: an explicit connect() undoes a prior explicit
    // disconnect(). Without this, a transport reused via disconnect() →
    // connect() would silently lose S1 auto-reconnect forever (`closed` was
    // only ever set, never cleared).
    this.closed = false;
    this.serverMaxPayload = MAX_PAYLOAD;
    return new Promise<void>((resolve, reject) => {
      // ── Outbound WebSocket CLIENT connection ────────────────────────────
      // `wsFactory(url)` dials the remote NATS server. The default factory
      // calls `new WebSocket(url)` — a CLIENT connect, NOT a server bind.
      // No local port is opened for listening; there is NO inbound socket.
      const ws = this.wsFactory(this.url);
      this.ws = ws;
      let buffer = Buffer.alloc(0);
      let connectSent = false;
      // Set only once CONNECT is actually on the wire (no-creds open-handler, or
      // sendConnectWithJwt's onSent). A PONG before this is unsolicited and must
      // not settle the dial — the phase deadline stays armed.
      let connectOnWire = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let phase = "WebSocket open";
      let established = false;

      // `handshakeDone` gates whether we emit errors to EventEmitter listeners.
      // Before the handshake completes, errors reject the connect() promise;
      // after it completes, errors are emitted so callers can react.
      let handshakeDone = false;
      let settled = false;
      const removeSocketListener = (event: string, listener: (...args: any[]) => void): void => {
        const detachable = ws as WebSocket & {
          off?: (name: string, fn: (...args: any[]) => void) => unknown;
          removeListener?: (name: string, fn: (...args: any[]) => void) => unknown;
        };
        if (typeof detachable.off === "function") detachable.off(event, listener);
        else detachable.removeListener?.(event, listener);
      };
      const cleanupHandshakeListeners = (): void => {
        removeSocketListener("open", onOpen);
        removeSocketListener("unexpected-response", onUnexpectedResponse);
      };
      const cleanupSocketListeners = (): void => {
        cleanupHandshakeListeners();
        removeSocketListener("message", onMessage);
        removeSocketListener("error", onError);
        removeSocketListener("close", onClose);
        this.socketCleanup.delete(ws);
      };
      const settle = (err?: Error): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        cleanupHandshakeListeners();
        if (err) {
          reject(err);
        } else {
          handshakeDone = true;
          resolve();
        }
      };
      const onAbort = (): void => {
        settle(new NatsLifecycleAbortError());
        this.disconnect();
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      const armDeadline = (nextPhase: string): void => {
        phase = nextPhase;
        if (timer) clearTimeout(timer);
        if (this.handshakeTimeoutMs === 0 || settled) return;
        timer = setTimeout(() => {
          const err = new NatsHandshakeTimeoutError(phase);
          settle(err);
          try { ws.close(); } catch { /* own socket already closed */ }
        }, this.handshakeTimeoutMs);
        if (typeof timer.unref === "function") timer.unref();
      };
      const protocolViolation = (reason: string): void => {
        const err = new NatsServerError("protocol-error", `protocol violation: ${reason}`);
        this.rejectFlushesForSocket(ws, err);
        // During the handshake the rejection IS the signal (mirrors the -ERR
        // branch): reject the connect() promise WITHOUT also emitting 'error',
        // which — with no listener attached yet — Node would rethrow as an
        // uncaught exception. Post-handshake, emit so live callers can react.
        if (established) this.emitError(err, ws);
        settle(err);
        try { ws.close(); } catch { /* already closed */ }
      };
      armDeadline("WebSocket open");

      const onOpen = () => {
        if (this.ws !== ws) return;
        if (this.nkeySigningCallback) {
          armDeadline("INFO");
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
          connectOnWire = true;
          // Initiate the round-trip that proves the connection is ready.
          ws.send("PING\r\n");
          armDeadline("first PONG");
        }
      };

      const onMessage = (data: Buffer | string) => {
        if (this.ws !== ws) return;
        const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
        if (buffer.length + chunk.length > MAX_BUFFERED_BYTES) {
          protocolViolation(`buffer exceeds ${MAX_BUFFERED_BYTES} bytes`);
          return;
        }
        buffer = Buffer.concat([buffer, chunk]);
        const result = this.drainBuffer(ws, buffer, (err?: Error) => {
          if (err) {
            settle(err);
            try { ws.close(); } catch { /* already closed */ }
            return;
          }
          if (!established) {
            established = true;
            settle();
            if (this.ws === ws) {
              this._connected = true;
              this.safeEmitFor(ws, "connect");
            }
          } else if (this.ws === ws) {
            this.safeEmitFor(ws, "pong");
          }
        }, () => established, protocolViolation, () => {
          if (connectSent) return false;
          connectSent = true;
          armDeadline("CONNECT signing");
          return true;
        }, () => { connectOnWire = true; armDeadline("first PONG"); }, () => connectOnWire);
        buffer = result;
      };

      const onError = (err: Error) => {
        // Network-level error (refused, DNS fail, TLS fail, etc.).
        // If the handshake hasn't finished yet, reject the connect() promise
        // (the caller handles it via await/catch — no need to also throw via
        // EventEmitter 'error', which would be an unhandled error if the
        // caller hasn't added a listener yet).
        if (!handshakeDone) {
          settle(err);
          try { ws.close(); } catch { try { ws.terminate(); } catch { /* disposer confirms */ } }
        } else if (this.ws === ws) {
          // Post-handshake error — emit to registered listeners. Identity
          // guard: after disconnect() (ws → null) or a newer connect(), this
          // is a STALE socket's error — it must not touch the live state.
          this._connected = false;
          this.rejectFlushesForSocket(ws, err);
          this.emitError(err);
        }
      };

      const onUnexpectedResponse = (_request: unknown, response: { statusCode?: number; resume?: () => void; destroy?: () => void; socket?: { destroy?: () => void } }) => {
        const statusCode = response.statusCode ?? 0;
        try { response.resume?.(); } catch { /* best effort */ }
        try { response.destroy?.(); } catch { /* best effort */ }
        try { response.socket?.destroy?.(); } catch { /* best effort */ }
        settle(new NatsUnexpectedResponseError(statusCode));
        try { ws.terminate(); } catch { /* shutdown owns confirmation */ }
      };

      const onClose = (code: number = 1005, reason?: Buffer) => {
        const closeCause = new NatsConnectionClosedError(code, (reason?.length ?? 0) > 0);
        this.rejectFlushesForSocket(ws, closeCause);
        // If the socket closed before the handshake completed, the promise
        // is still pending — reject it. Always settle OUR OWN dial's promise,
        // even if the transport has since moved on to a newer socket.
        settle(closeCause);
        // Stale-socket guard: ws close events fire ASYNC, so after an explicit
        // disconnect() (ws → null) or a newer connect() replaced this.ws, this
        // close belongs to a PREVIOUS socket — it must not flip the live
        // connection's state, emit a spurious "disconnect", or schedule a
        // reconnect alongside the live socket.
        if (this.ws !== ws) {
          cleanupSocketListeners();
          return;
        }
        this._connected = false;
        this.emit("disconnect", closeCause);
        // S1: auto-reconnect ONLY for an ESTABLISHED connection that dropped.
        // `handshakeDone` is per-socket, so a close during the INITIAL connect
        // (or a failed reconnect attempt's own handshake) does NOT schedule here
        // — first-connect failure is the caller's to handle, and a failed
        // reconnect attempt reschedules from reconnectOnce()'s catch instead.
        if (this.reconnectEnabled && !this.closed && handshakeDone) {
          this.scheduleReconnect();
        }
        if (this.ws === ws) this.ws = null;
        cleanupSocketListeners();
      };

      this.socketCleanup.set(ws, cleanupSocketListeners);
      ws.on("open", onOpen);
      ws.on("message", onMessage);
      ws.on("error", onError);
      ws.on("unexpected-response", onUnexpectedResponse);
      ws.on("close", onClose);
    });
  }

  /**
   * Drain the internal line buffer and dispatch complete NATS protocol lines.
   *
   * `onFirstPong` is the one-shot callback (resolve/reject) for the `connect()`
   * Promise. It is called exactly once — on the first PONG (success) or on any
   * -ERR before that (failure).
   */
  private drainBuffer(
    ws: WebSocket,
    initialBuffer: Buffer,
    onFirstPong: (err?: Error) => void,
    isEstablished: () => boolean,
    protocolViolation: (reason: string) => void,
    beginJwtConnect: () => boolean,
    connectSent: () => void,
    isConnectOnWire: () => boolean,
  ): Buffer {
    // NATS lines are terminated by \r\n. MSG payloads follow immediately after
    // the MSG header line (also terminated by \r\n).
    let buffer = initialBuffer;
    let crlfPos: number;
    while ((crlfPos = buffer.indexOf("\r\n")) !== -1) {
      if (crlfPos > MAX_CONTROL_LINE) {
        protocolViolation(`control line exceeds ${MAX_CONTROL_LINE} bytes`);
        return Buffer.alloc(0);
      }
      const lineBytes = buffer.subarray(0, crlfPos);
      const line = lineBytes.toString("utf8");
      buffer = buffer.subarray(crlfPos + 2);

      if (!line) continue;

      if (line.startsWith("INFO ")) {
        // Server INFO — carried as JSON after "INFO ".
        // In JWT auth mode, the INFO contains a challenge nonce that we must
        // sign before sending CONNECT. sendConnectWithJwt() is idempotent
        // (guarded by _connectSent) so repeated INFO lines are safe.
        try {
          const info = JSON.parse(line.slice(5).trim()) as { max_payload?: unknown };
          if (
            typeof info.max_payload === "number"
            && Number.isSafeInteger(info.max_payload)
            && info.max_payload > 0
          ) {
            this.serverMaxPayload = Math.min(MAX_PAYLOAD, info.max_payload);
          }
        } catch {
          // Existing protocol handling tolerates nonessential malformed INFO.
        }
        if (this.nkeySigningCallback && beginJwtConnect()) {
          void this.sendConnectWithJwt(ws, line, onFirstPong, connectSent);
        }
        continue;
      }

      if (line === "PONG") {
        // A PONG is only legitimate once our CONNECT+PING is actually on the wire.
        // An unsolicited PONG (JWT mode: INFO arrived, signing still pending) is
        // ignored — the phase deadline stays armed and connect() does not settle.
        if (!isConnectOnWire()) continue;
        // PONG is the server's reply to our PING, confirming the connection.
        // Establishment belongs to this dial, not to the transport-wide state:
        // overlapping connect() calls must each settle on their own first PONG.
        onFirstPong();
        if (this.ws !== ws) return Buffer.alloc(0);
        this.resolveNextFlushForSocket(ws);
        continue;
      }

      if (line === "PING") {
        // Server-side keepalive ping — reply immediately.
        ws.send("PONG\r\n");
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
        if ((parts.length !== 4 && parts.length !== 5) || parts.some((part) => part === "")) {
          protocolViolation("malformed MSG header");
          return Buffer.alloc(0);
        }
        const hasReplyTo = parts.length === 5;
        const subject = parts[1];
        const replyTo = hasReplyTo ? parts[3] : undefined;
        const lengthToken = parts[hasReplyTo ? 4 : 3];
        if (!/^\d+$/.test(lengthToken)) {
          protocolViolation("malformed MSG byte count");
          return Buffer.alloc(0);
        }
        const byteCount = Number(lengthToken);
        if (!Number.isSafeInteger(byteCount) || byteCount > MAX_PAYLOAD) {
          protocolViolation(`MSG payload exceeds ${MAX_PAYLOAD} bytes`);
          return Buffer.alloc(0);
        }

        // The payload plus the trailing \r\n must be in the buffer.
        if (buffer.length < byteCount + 2) {
          // Incomplete payload — put the header line back and wait.
          buffer = Buffer.concat([lineBytes, Buffer.from("\r\n"), buffer]);
          break;
        }

        if (buffer[byteCount] !== 13 || buffer[byteCount + 1] !== 10) {
          protocolViolation("MSG payload missing trailing CRLF");
          return Buffer.alloc(0);
        }
        const payload = Buffer.from(buffer.subarray(0, byteCount));
        buffer = buffer.subarray(byteCount + 2);

        const msg: NatsMessage = { subject, replyTo, payload };
        this.safeEmitFor(ws, "message", msg);
        if (this.ws !== ws) return Buffer.alloc(0);
        continue;
      }

      if (line.startsWith("-ERR ")) {
        const err = parseNatsServerError(line);
        if (!isEstablished()) {
          // Still in handshake — reject the connect() promise directly.
          // Do NOT also emit 'error' here: the promise rejection IS the error
          // signal, and emitting 'error' with no listener would throw.
          onFirstPong(err);
          return Buffer.alloc(0);
        } else {
          // Post-handshake NATS error (e.g. Permissions Violation for Publish/
          // Subscription) — emit to registered listeners so callers can react.
          this.rejectFlushesForSocket(ws, err);
          this.emitError(err, ws);
          if (this.ws !== ws) return Buffer.alloc(0);
        }
        continue;
      }

      if (line === "+OK") {
        // Verbose-mode ACK — safe to ignore (we disable verbose).
        continue;
      }

      // Unknown line — ignore to stay forward-compatible.
    }
    if (buffer.indexOf("\r\n") === -1 && buffer.length > MAX_CONTROL_LINE) {
      protocolViolation(`control line exceeds ${MAX_CONTROL_LINE} bytes`);
      return Buffer.alloc(0);
    }
    return buffer;
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
   * Wait until the server has processed every command sent before this call.
   *
   * NATS processes a connection in order, so SUB + PING followed by PONG proves
   * the subscription command reached the server. A permissions `-ERR` delivered
   * before that PONG rejects the barrier, allowing startup to remain private.
   */
  flush(signal?: AbortSignal): Promise<void> {
    this.assertOpen();
    if (signal?.aborted) return Promise.reject(new NatsLifecycleAbortError());
    const socket = this.ws!;
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const remove = () => {
        const index = this.flushWaiters.indexOf(waiter);
        if (index >= 0) this.flushWaiters.splice(index, 1);
        signal?.removeEventListener("abort", onAbort);
        if (timer) clearTimeout(timer);
      };
      const waiter: FlushWaiter = {
        socket,
        settle: (error) => {
          if (settled) return;
          settled = true;
          remove();
          if (error) reject(error);
          else resolve();
        },
      };
      const onAbort = () => waiter.settle(new NatsLifecycleAbortError());
      this.flushWaiters.push(waiter);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (this.handshakeTimeoutMs > 0) {
        timer = setTimeout(
          () => waiter.settle(new NatsHandshakeTimeoutError("flush PONG")),
          this.handshakeTimeoutMs,
        );
        if (typeof timer.unref === "function") timer.unref();
      }
      try {
        socket.send("PING\r\n");
      } catch (error) {
        waiter.settle(
          error instanceof Error ? error : new Error("NATS flush send failed"),
        );
      }
    });
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
    if (buf.length > this.effectiveOutboundLimit) {
      throw new RangeError(
        `NatsTransport: outbound payload ${buf.length} exceeds effective max_payload ${this.effectiveOutboundLimit}`,
      );
    }
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
    if (buf.length > this.effectiveOutboundLimit) {
      throw new RangeError(
        `NatsTransport: outbound payload ${buf.length} exceeds effective max_payload ${this.effectiveOutboundLimit}`,
      );
    }
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
    void this.closeGracefully().catch(() => {});
  }

  /** Await the bounded physical-close protocol. Concurrent callers share it. */
  closeGracefully(graceMs = 250, forceMs = 250): Promise<TransportCloseReport> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this._connected = false;
    this.subs.clear();
    const socket = this.ws ?? this.retainedSocket;
    if (socket) {
      this.rejectFlushesForSocket(
        socket,
        new NatsConnectionClosedError(1005, false),
      );
    }
    this.retainedSocket = socket;
    this.ws = null;
    this.shutdownPromise = this.confirmSocketClosed(socket, graceMs, forceMs).catch(() => ({
      reconnectSuppressed: true,
      socketClosed: false,
      forcedTerminationAttempted: false,
      gracefulTimedOut: false,
      closeHandle: { probe: () => this.probePhysicalClose(graceMs, forceMs) },
    }));
    return this.shutdownPromise;
  }

  private async confirmSocketClosed(
    socket: WebSocket | null,
    graceMs: number,
    forceMs: number,
  ): Promise<TransportCloseReport> {
    if (!socket || socket.readyState === WebSocket.CLOSED) {
      this.retainedSocket = null;
      return { reconnectSuppressed: true, socketClosed: true, forcedTerminationAttempted: false, gracefulTimedOut: false };
    }
    let closed = false;
    const onClose = () => { closed = true; };
    socket.on("close", onClose);
    const removeCloseListener = (listener: (...args: unknown[]) => void): void => {
      const detachable = socket as WebSocket & {
        off?: (event: string, fn: (...args: unknown[]) => void) => unknown;
        removeListener?: (event: string, fn: (...args: unknown[]) => void) => unknown;
      };
      if (typeof detachable.off === "function") detachable.off("close", listener);
      else detachable.removeListener?.("close", listener);
    };
    const wait = (ms: number) => {
      if (closed || socket.readyState === WebSocket.CLOSED) return Promise.resolve();
      return new Promise<void>((resolve) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          if (timer) clearTimeout(timer);
          removeCloseListener(onObservedClose);
          resolve();
        };
        const onObservedClose = () => { closed = true; finish(); };
        socket.on("close", onObservedClose);
        timer = setTimeout(finish, ms);
        if (typeof timer.unref === "function") timer.unref();
        if (closed || socket.readyState === WebSocket.CLOSED) finish();
      });
    };
    let forcedTerminationAttempted = false;
    let gracefulTimedOut = false;
    const state = (): number => socket.readyState as number;
    try {
      let forceNow = state() === WebSocket.CONNECTING;
      if (state() === WebSocket.OPEN) {
        try { socket.close(); } catch { forceNow = true; }
      }
      if (!forceNow && !closed && state() !== WebSocket.CLOSED) {
        await wait(graceMs);
        if (!closed && state() !== WebSocket.CLOSED) {
          gracefulTimedOut = true;
          forceNow = true;
        }
      }
      if (forceNow && !closed && state() !== WebSocket.CLOSED) {
        forcedTerminationAttempted = true;
        try { socket.terminate(); } catch { /* report unconfirmed */ }
        if (!closed && state() !== WebSocket.CLOSED) await wait(forceMs);
      }
      const socketClosed = closed || state() === WebSocket.CLOSED;
      if (socketClosed) {
        this.socketCleanup.get(socket)?.();
        if (this.retainedSocket === socket) this.retainedSocket = null;
      }
      return {
        reconnectSuppressed: true,
        socketClosed,
        forcedTerminationAttempted,
        gracefulTimedOut,
        ...(!socketClosed ? { closeHandle: { probe: () => this.probePhysicalClose(graceMs, forceMs) } } : {}),
      };
    } finally {
      removeCloseListener(onClose);
    }
  }

  /** Retry physical cleanup only; never reconnects or creates a socket. */
  async probePhysicalClose(graceMs = 250, forceMs = 250): Promise<TransportCloseReport> {
    const socket = this.retainedSocket;
    this.shutdownPromise = undefined;
    return this.closeGracefully(graceMs, forceMs);
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
            `${reconnectFailureLabel(err)} — retrying with backoff`,
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
    // A sid is a stable logical subscription id for this transport instance.
    // Replay every entry verbatim: duplicate subjects intentionally retain
    // their independent subscriptions and callers' unsubscribe handles.
    for (const [sid, subject] of this.subs) {
      this.ws!.send(`SUB ${subject} ${sid}\r\n`);
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
    ws: WebSocket,
    infoLine: string,
    settle?: (err?: Error) => void,
    onSent?: () => void,
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

      if (this.ws !== ws || ws.readyState !== WebSocket.OPEN) return;
      // Mark CONNECT on-wire and arm the "first PONG" deadline BEFORE the sync
      // sends: a server that answers our PING with a PONG in the same tick must
      // not have that legitimate PONG dropped as unsolicited.
      onSent?.();
      ws.send(`CONNECT ${JSON.stringify(connectPayload)}\r\n`);
      ws.send("PING\r\n");
    } catch (err) {
      settle?.(err instanceof Error ? err : new Error(String(err)));
      try { ws.close(); } catch { try { ws.terminate(); } catch { /* disposer confirms */ } }
    }
  }

  private assertOpen(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("NatsTransport: not connected — call connect() first");
    }
  }

  private resolveNextFlushForSocket(socket: WebSocket): void {
    const waiter = this.flushWaiters.find(
      (candidate) => candidate.socket === socket,
    );
    waiter?.settle();
  }

  private rejectFlushesForSocket(socket: WebSocket, error: Error): void {
    for (const waiter of [...this.flushWaiters]) {
      if (waiter.socket === socket) waiter.settle(error);
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
  private emitError(err: Error, ws?: WebSocket): void {
    if (this.listenerCount("error") > 0) {
      // Dial-aware when called from the drain loop: an error listener that tears
      // the dial down must not have the remaining error listeners fired for a
      // socket that is already gone (see safeEmitFor).
      this.safeEmitFor(ws, "error", err);
    } else {
      // Last-resort backstop — a consumer forgot to attach an "error" listener.
      // Log instead of letting Node rethrow as an uncaught exception.
      console.error(
        `[NatsTransport] unhandled connection error (no "error" listener attached): ${reconnectFailureLabel(err)}`,
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
    this.safeEmitFor(undefined, event, ...args);
  }

  /**
   * As `safeEmit`, but when `ws` is given the dial is re-checked BEFORE each
   * listener rather than only after the whole fan-out.
   *
   * `EventEmitter.emit()` runs every listener before returning, so a listener that
   * synchronously retires the dial (disconnect()/a replacement connect()) would
   * still have the REMAINING listeners invoked for a socket that no longer exists
   * — the drain loop's post-dispatch guard cannot see inside `emit`. Iterating
   * `rawListeners()` keeps `once` semantics intact (Node's once-wrapper is bound
   * and removes itself when invoked) while making the fan-out abortable.
   */
  private safeEmitFor(ws: WebSocket | undefined, event: string, ...args: unknown[]): void {
    for (const listener of this.rawListeners(event)) {
      if (ws !== undefined && this.ws !== ws) return;
      try {
        (listener as (...a: unknown[]) => void)(...args);
      } catch (err) {
        console.error(
          `[NatsTransport] listener for "${event}" threw (frame dropped, read pump continues): ${String(err)}`,
        );
      }
    }
  }
}
