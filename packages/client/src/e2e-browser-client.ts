/**
 * Browser-side E2E encrypted NATS client for the live E2E gate.
 *
 * This module is the browser dial seam for the Playwright E2E test:
 *   - Connects to NATS via the hand-rolled text protocol over native WebSocket
 *   - Generates X25519 key pair via Web Crypto API
 *   - Performs ECDH key exchange with agent via NATS handshake subject
 *   - Derives session key via HKDF-SHA256 (Web Crypto API)
 *   - Encrypts outbound MessageEnvelope v1 content with ChaCha20-Poly1305
 *   - Decrypts inbound MessageEnvelope v1 content
 *
 * IMPORTANT: This module runs in a REAL browser (headless Chromium).
 * It uses ONLY browser-native APIs:
 *   - crypto.subtle (Web Crypto API) for X25519 + HKDF-SHA256
 *   - WebSocket (native browser WebSocket API)
 *   - TextEncoder / TextDecoder
 *   - BigInt (ES2020)
 * Plus the pure-JS ChaCha20-Poly1305 from chacha20poly1305.ts.
 */

import { chacha20poly1305Encrypt, chacha20poly1305Decrypt } from "./chacha20poly1305.js";

// ---------------------------------------------------------------------------
// Base64url helpers (browser-native)
// ---------------------------------------------------------------------------

function base64urlEncode(bytes: Uint8Array): string {
  // btoa takes a binary string
  const binary = Array.from(bytes, (b) => String.fromCharCode(b)).join("");
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function base64urlDecode(b64url: string): Uint8Array {
  // Pad and un-URL-safe
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const binary = atob(padded);
  return new Uint8Array(binary.length).map((_, i) => binary.charCodeAt(i));
}

// ---------------------------------------------------------------------------
// Web Crypto helpers
// ---------------------------------------------------------------------------

async function generateX25519KeyPair(): Promise<{
  privateKey: CryptoKey;
  publicKeyBytes: Uint8Array;
  publicKeyB64url: string;
}> {
  const kp = await crypto.subtle.generateKey(
    { name: "X25519" },
    true,
    ["deriveBits"],
  ) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey("jwk", kp.publicKey);
  const x = (jwk as { x: string }).x;
  return {
    privateKey: kp.privateKey,
    publicKeyBytes: base64urlDecode(x),
    publicKeyB64url: x,
  };
}

async function deriveX25519SharedSecret(
  myPrivateKey: CryptoKey,
  theirPubKeyB64url: string,
): Promise<Uint8Array> {
  const theirPubJwk = { kty: "OKP", crv: "X25519", x: theirPubKeyB64url };
  const theirPubKey = await crypto.subtle.importKey(
    "jwk",
    theirPubJwk,
    { name: "X25519" },
    false,
    [],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "X25519", public: theirPubKey },
    myPrivateKey,
    256,
  );
  return new Uint8Array(bits);
}

async function hkdfSha256(
  ikm: Uint8Array,
  salt: Uint8Array | null,
  info: string,
  length: number,
): Promise<Uint8Array> {
  const baseKey = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: salt ?? new Uint8Array(32), // RFC 5869: default salt = 32 zero bytes for SHA-256
      info: new TextEncoder().encode(info),
    },
    baseKey,
    length * 8,
  );
  return new Uint8Array(bits);
}

// ---------------------------------------------------------------------------
// Random bytes (crypto-random)
// ---------------------------------------------------------------------------

function randomBytes(n: number): Uint8Array {
  const buf = new Uint8Array(n);
  crypto.getRandomValues(buf);
  return buf;
}

// ---------------------------------------------------------------------------
// Minimalistic hand-rolled NATS client (browser-native WebSocket)
//
// Mirrors the wire protocol from packages/client/src/nats-client.ts.
// Uses ONLY browser-native APIs (no Buffer, no Node.js globals).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// PKCS#8 Ed25519 signing for NATS JWT challenge-response (browser-native)
// ---------------------------------------------------------------------------

/**
 * Import a raw 32-byte Ed25519 seed as a CryptoKey for signing.
 *
 * Uses the PKCS#8 DER encoding (RFC 8410) which Chrome 130+ supports:
 *   SEQUENCE {
 *     INTEGER 0 (version)
 *     SEQUENCE { OID 1.3.101.112 (Ed25519) }
 *     OCTET STRING { OCTET STRING { <32 seed bytes> } }
 *   }
 */
async function importEd25519SeedKey(rawSeed: Uint8Array): Promise<CryptoKey> {
  // PKCS#8 DER header for Ed25519 (RFC 8410)
  const header = new Uint8Array([
    0x30, 0x2e,                          // SEQUENCE (46 bytes follow)
    0x02, 0x01, 0x00,                    // INTEGER 0 (version)
    0x30, 0x05,                          // SEQUENCE
    0x06, 0x03, 0x2b, 0x65, 0x70,        // OID 1.3.101.112 (id-EdDSA / Ed25519)
    0x04, 0x22,                          // OCTET STRING (34 bytes follow)
    0x04, 0x20,                          // OCTET STRING (32 bytes = seed)
  ]);
  const pkcs8 = new Uint8Array(header.length + rawSeed.length);
  pkcs8.set(header, 0);
  pkcs8.set(rawSeed, header.length);
  return crypto.subtle.importKey(
    "pkcs8",
    pkcs8,
    { name: "Ed25519" },
    false,
    ["sign"],
  );
}

/**
 * Sign a nonce string with an Ed25519 private key and return base64url.
 */
async function signNonce(privateKey: CryptoKey, nonce: string): Promise<string> {
  const sigBytes = await crypto.subtle.sign(
    { name: "Ed25519" },
    privateKey,
    new TextEncoder().encode(nonce),
  );
  return base64urlEncode(new Uint8Array(sigBytes));
}

// ---------------------------------------------------------------------------
// Minimalistic hand-rolled NATS client (browser-native WebSocket)
//
// Mirrors the wire protocol from packages/client/src/nats-client.ts.
// Uses ONLY browser-native APIs (no Buffer, no Node.js globals).
// ---------------------------------------------------------------------------

type NatsMessageCallback = (subject: string, payload: string) => void;

type BrowserNatsClientOptions = {
  url: string;
  /**
   * NATS user JWT for enrolled-JWT mode. When provided together with
   * rawNkeyPrivateKey, the client performs challenge-response authentication.
   */
  userJwt?: string;
  /**
   * Raw 32-byte Ed25519 seed for the NATS user NKEY.
   * Used to sign the server's nonce in the CONNECT handshake.
   * Must be provided when userJwt is set.
   */
  rawNkeyPrivateKey?: number[];
};

class BrowserNatsClient {
  private ws: WebSocket | null = null;
  private buffer = "";
  private sidCounter = 0;
  private _connected = false;
  private messageCallbacks: NatsMessageCallback[] = [];
  private readonly url: string;
  private readonly userJwt?: string;
  private readonly rawNkeyPrivateKey?: number[];

  constructor(options: BrowserNatsClientOptions) {
    this.url = options.url;
    this.userJwt = options.userJwt;
    this.rawNkeyPrivateKey = options.rawNkeyPrivateKey;
  }

  connect(): Promise<void> {
    const useJwtAuth = !!(this.userJwt && this.rawNkeyPrivateKey);
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.url);
      // nats-server sends the NATS protocol over BINARY WebSocket frames. The
      // default binaryType is "blob", which coerces to "[object Blob]" when
      // appended to the text buffer. Request ArrayBuffer and decode to UTF-8 so
      // the protocol parser sees real INFO/PONG/MSG lines.
      ws.binaryType = "arraybuffer";
      this.ws = ws;
      let settled = false;
      // Guard: only send CONNECT once even if INFO arrives multiple times.
      let connectSent = false;
      const settle = (err?: Error): void => {
        if (settled) return;
        settled = true;
        if (err) reject(err);
        else resolve();
      };

      ws.onopen = () => {
        if (!useJwtAuth) {
          // Open NATS mode: send CONNECT immediately without any JWT/sig.
          const connectPayload = JSON.stringify({
            verbose: false, pedantic: false,
            lang: "javascript", version: "1.0.0",
            protocol: 1, echo: false,
            name: "e2e-browser-client",
          });
          ws.send(`CONNECT ${connectPayload}\r\n`);
          ws.send("PING\r\n");
        }
        // JWT mode: wait for INFO in onmessage to get the nonce before CONNECT.
      };

      ws.onmessage = (evt: MessageEvent<string | ArrayBuffer>) => {
        this.buffer += typeof evt.data === "string"
          ? evt.data
          : new TextDecoder().decode(new Uint8Array(evt.data));
        // In JWT mode, pass an INFO handler so drainBuffer can trigger CONNECT.
        const onInfo = useJwtAuth
          ? (infoLine: string) => {
              if (!connectSent) {
                connectSent = true;
                void this.sendConnectWithJwt(infoLine, settle);
              }
            }
          : undefined;
        this.drainBuffer(settle, onInfo);
      };

      ws.onerror = () => {
        if (!this._connected) settle(new Error("BrowserNatsClient: WebSocket error"));
      };

      ws.onclose = () => {
        this._connected = false;
        if (!settled) settle(new Error("BrowserNatsClient: connection closed before handshake"));
      };
    });
  }

  /**
   * Send CONNECT with JWT + NKEY signature in response to INFO nonce.
   * Called asynchronously when the server sends INFO in JWT auth mode.
   */
  private async sendConnectWithJwt(
    infoLine: string,
    settle?: (err?: Error) => void,
  ): Promise<void> {
    try {
      // Extract nonce from INFO JSON
      let nonce = "";
      try {
        const info = JSON.parse(infoLine.slice(5).trim()) as { nonce?: string };
        nonce = info.nonce ?? "";
      } catch { /* no nonce */ }

      let sig = "";
      if (nonce && this.rawNkeyPrivateKey) {
        const rawSeed = new Uint8Array(this.rawNkeyPrivateKey);
        const privateKey = await importEd25519SeedKey(rawSeed);
        sig = await signNonce(privateKey, nonce);
      }

      const connectPayload: Record<string, unknown> = {
        verbose: false, pedantic: false,
        lang: "javascript", version: "1.0.0",
        protocol: 1, echo: false,
        name: "e2e-browser-client",
      };
      if (this.userJwt) {
        connectPayload["jwt"] = this.userJwt;
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

  private drainBuffer(
    onFirstPong?: (err?: Error) => void,
    onInfo?: (line: string) => void,
  ): void {
    let crlfPos: number;
    while ((crlfPos = this.buffer.indexOf("\r\n")) !== -1) {
      const line = this.buffer.slice(0, crlfPos);
      this.buffer = this.buffer.slice(crlfPos + 2);

      if (!line) continue;

      if (line.startsWith("INFO ")) {
        // In JWT mode, fire the onInfo callback so the caller can send CONNECT.
        onInfo?.(line);
        continue;
      }

      if (line === "+OK") continue;

      if (line === "PONG") {
        if (!this._connected) {
          this._connected = true;
          onFirstPong?.();
        }
        continue;
      }

      if (line === "PING") {
        this.ws?.send("PONG\r\n");
        continue;
      }

      if (line.startsWith("MSG ")) {
        const parts = line.split(" ");
        const hasReplyTo = parts.length === 5;
        const subject = parts[1] ?? "";
        const byteCount = parseInt(parts[hasReplyTo ? 4 : 3] ?? "0", 10);

        if (isNaN(byteCount) || byteCount < 0) continue;

        if (this.buffer.length < byteCount + 2) {
          // Incomplete payload — put the header back
          this.buffer = `${line}\r\n${this.buffer}`;
          break;
        }

        const payload = this.buffer.slice(0, byteCount);
        this.buffer = this.buffer.slice(byteCount + 2);

        for (const cb of this.messageCallbacks) {
          try { cb(subject, payload); } catch { /* best effort */ }
        }
        continue;
      }

      if (line.startsWith("-ERR ")) {
        if (onFirstPong && !this._connected) {
          onFirstPong(new Error(`NATS error: ${line}`));
        }
        continue;
      }
    }
  }

  subscribe(subject: string): number {
    if (!this.ws) throw new Error("not connected");
    const sid = ++this.sidCounter;
    this.ws.send(`SUB ${subject} ${sid}\r\n`);
    return sid;
  }

  publish(subject: string, payload: string): void {
    if (!this.ws) throw new Error("not connected");
    const byteLen = new TextEncoder().encode(payload).length;
    this.ws.send(`PUB ${subject} ${byteLen}\r\n${payload}\r\n`);
  }

  onMessage(cb: NatsMessageCallback): void {
    this.messageCallbacks.push(cb);
  }

  disconnect(): void {
    this._connected = false;
    this.ws?.close();
    this.ws = null;
  }
}

// ---------------------------------------------------------------------------
// MessageEnvelope v1 helpers (browser-side)
// ---------------------------------------------------------------------------

type EnvelopeRouting = {
  agentId: string;
  tenant: string;
  sub: string;
  messageId: string;
  envelopeType: string;
  ts: number;
};

type MessageEnvelope = {
  v: 1;
  agentId: string;
  tenant: string;
  sub: string;
  messageId: string;
  envelopeType: string;
  ts: number;
  content: { nonce: string; ciphertext: string; tag: string };
};

/**
 * Canonical AAD for a message envelope.
 * AAD = UTF-8 bytes of JSON.stringify({tenant, agentId, sub, messageId, envelopeType, ts})
 * with keys in canonical order.
 */
function canonicalAad(routing: EnvelopeRouting): Uint8Array {
  const canonical = JSON.stringify({
    tenant:       routing.tenant,
    agentId:      routing.agentId,
    sub:          routing.sub,
    messageId:    routing.messageId,
    envelopeType: routing.envelopeType,
    ts:           routing.ts,
  });
  return new TextEncoder().encode(canonical);
}

function encodeEnvelope(
  routing: EnvelopeRouting,
  plaintext: string,
  sessionKey: Uint8Array,
): MessageEnvelope {
  const nonce = randomBytes(12);
  const aad = canonicalAad(routing);
  const { ciphertext, tag } = chacha20poly1305Encrypt(
    sessionKey,
    nonce,
    new TextEncoder().encode(plaintext),
    aad,
  );
  return {
    v: 1,
    ...routing,
    content: {
      nonce:      base64urlEncode(nonce),
      ciphertext: base64urlEncode(ciphertext),
      tag:        base64urlEncode(tag),
    },
  };
}

function decodeEnvelope(env: MessageEnvelope, sessionKey: Uint8Array): string {
  const routing: EnvelopeRouting = {
    agentId:      env.agentId,
    tenant:       env.tenant,
    sub:          env.sub,
    messageId:    env.messageId,
    envelopeType: env.envelopeType,
    ts:           env.ts,
  };
  const aad = canonicalAad(routing);
  const plaintext = chacha20poly1305Decrypt(
    sessionKey,
    base64urlDecode(env.content.nonce),
    base64urlDecode(env.content.ciphertext),
    base64urlDecode(env.content.tag),
    aad,
  );
  return new TextDecoder().decode(plaintext);
}

// ---------------------------------------------------------------------------
// Public API — exported for use in Playwright page.evaluate()
// ---------------------------------------------------------------------------

export type RoundTripOptions = {
  /** WebSocket URL of the NATS server, e.g. ws://127.0.0.1:18091 */
  natsUrl: string;
  /** Routing fields for the test envelope */
  tenant: string;
  agentId: string;
  peerId: string;
  /** Timeout for waiting for the agent's reply (ms) */
  timeoutMs?: number;
  /**
   * Pre-shared 32-byte session key as number array.
   * If provided, skip X25519 key exchange and use directly.
   * If omitted, perform full X25519 ECDH key exchange via NATS handshake subject.
   */
  preSharedKey?: number[];
  /** Message text to send to the agent */
  messageText: string;
  /**
   * NATS user JWT for enrolled-JWT mode.
   * When provided (with rawNkeyPrivateKey), the browser performs NATS JWT
   * challenge-response authentication. Omit for open/dev-NATS mode.
   */
  userJwt?: string;
  /**
   * Raw 32-byte Ed25519 seed for the NATS user NKEY (as number array).
   * Used to sign the server's nonce challenge. Must match userJwt.
   * Obtain via `userKp.getRawSeed()` from @nats-io/nkeys on the Node.js side.
   */
  rawNkeyPrivateKey?: number[];
};

export type RoundTripResult = {
  /** Decrypted reply text from agent */
  replyText: string;
  /** Raw wire payload captured from NATS (proves ciphertext opacity) */
  wirePayloadJson: string;
  /** Whether the wire payload is NOT equal to the plaintext (ciphertext proof) */
  isOpaqueOnWire: boolean;
};

/**
 * Run a full encrypted round-trip:
 *  1. Connect to NATS (hand-rolled wire protocol over native WebSocket)
 *  2. Optionally perform X25519 ECDH key exchange via handshake subject
 *  3. Encrypt user message as MessageEnvelope v1 with ChaCha20-Poly1305
 *  4. Publish encrypted envelope to inbound NATS subject
 *  5. Wait for encrypted reply on outbound NATS subject
 *  6. Decrypt reply → return plaintext
 *
 * Called from Playwright via page.evaluate().
 */
export async function runEncryptedRoundTrip(opts: RoundTripOptions): Promise<RoundTripResult> {
  const { natsUrl, tenant, agentId, peerId, messageText, preSharedKey } = opts;
  const timeoutMs = opts.timeoutMs ?? 10000;

  const inboundSubj  = `webchannel.${tenant}.${agentId}.${peerId}.in`;
  const outboundSubj = `webchannel.${tenant}.${agentId}.${peerId}.out`;
  const handshakeSubj = `webchannel.${tenant}.${agentId}.${peerId}.handshake`;

  // --- Connect to NATS (open or enrolled-JWT mode) ---
  const nats = new BrowserNatsClient({
    url: natsUrl,
    userJwt: opts.userJwt,
    rawNkeyPrivateKey: opts.rawNkeyPrivateKey,
  });
  await nats.connect();

  let sessionKey: Uint8Array;

  if (preSharedKey) {
    // Pre-shared key mode (no key exchange)
    sessionKey = new Uint8Array(preSharedKey);
  } else {
    // Full X25519 ECDH key exchange via NATS handshake subject
    const myKP = await generateX25519KeyPair();

    // Subscribe to handshake subject to receive agent's public key
    nats.subscribe(handshakeSubj);

    // Wait for agent key exchange message
    const agentPubKeyB64 = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Key exchange timeout")), timeoutMs);
      nats.onMessage((subj, payload) => {
        if (subj !== handshakeSubj) return;
        try {
          const msg = JSON.parse(payload) as { type: string; pubKey: string };
          if (msg.type === "key_exchange" && msg.pubKey) {
            clearTimeout(timer);
            resolve(msg.pubKey);
          }
        } catch { /* ignore malformed */ }
      });
      // Publish our public key after subscribing
      nats.publish(handshakeSubj, JSON.stringify({
        type: "key_exchange",
        pubKey: myKP.publicKeyB64url,
      }));
    });

    // Derive session key
    const rawSecret = await deriveX25519SharedSecret(myKP.privateKey, agentPubKeyB64);
    sessionKey = await hkdfSha256(rawSecret, null, "webchannel-conversation-v1", 32);
  }

  // --- Subscribe to outbound subject (agent → browser) ---
  nats.subscribe(outboundSubj);

  // --- Wait for encrypted reply ---
  const replyPromise = new Promise<{ replyText: string; wirePayloadJson: string }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Reply timeout after ${timeoutMs}ms`)), timeoutMs);
    nats.onMessage((subj, payload) => {
      if (subj !== outboundSubj) return;
      try {
        const env = JSON.parse(payload) as MessageEnvelope;
        if (env.v !== 1 || !env.content) return; // not an envelope
        const decrypted = decodeEnvelope(env, sessionKey);
        clearTimeout(timer);
        resolve({ replyText: decrypted, wirePayloadJson: payload });
      } catch (err) {
        clearTimeout(timer);
        reject(err);
      }
    });
  });

  // --- Send encrypted message to agent ---
  const routing: EnvelopeRouting = {
    agentId,
    tenant,
    sub:          peerId,
    messageId:    Array.from(randomBytes(8)).map((b) => b.toString(16).padStart(2, "0")).join(""),
    envelopeType: "conversation",
    ts:           Date.now(),
  };
  const envelope = encodeEnvelope(routing, messageText, sessionKey);
  nats.publish(inboundSubj, JSON.stringify(envelope));

  // --- Wait for reply ---
  const { replyText, wirePayloadJson } = await replyPromise;

  nats.disconnect();

  return {
    replyText,
    wirePayloadJson,
    isOpaqueOnWire: !wirePayloadJson.includes(messageText),
  };
}
