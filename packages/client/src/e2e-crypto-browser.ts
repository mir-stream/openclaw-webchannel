/**
 * Browser-native E2E crypto helpers — the single crypto source for the browser
 * dial seam (X25519 + HKDF-SHA256 via Web Crypto, ChaCha20-Poly1305 via the
 * pure-JS `chacha20poly1305.ts`, MessageEnvelope v1 codec, canonical AAD).
 *
 * Uses ONLY browser-native APIs (crypto.subtle, WebSocket, TextEncoder/Decoder,
 * BigInt) so it runs identically in a real browser and in Node ≥18 (which also
 * exposes `globalThis.crypto.subtle` with X25519). It speaks the exact same wire
 * protocol the agent (`packages/plugin/src/e2e-session.ts` + `nats-channel.ts`)
 * and the live-gate browser seam (`e2e-browser-client.ts`) use:
 *   - handshake frame: {type:"key_exchange", pubKey:<b64url X25519>}
 *   - session key:     hkdfSha256(ecdh, null, "webchannel-conversation-v1", 32)
 *   - wire envelope:   MessageEnvelope v1 JSON, content = ChaCha20-Poly1305
 *   - AAD:             canonical(routing) = {tenant,accountId,sub,messageId,envelopeType,ts}
 */

import { chacha20poly1305Encrypt, chacha20poly1305Decrypt } from "./chacha20poly1305.js";

/**
 * HKDF `info` for the conversation key. MUST match the agent and the live gate.
 */
export const CONVERSATION_KDF_INFO = "webchannel-conversation-v1";

// ---------------------------------------------------------------------------
// base64url + random
// ---------------------------------------------------------------------------

export function base64urlEncode(bytes: Uint8Array): string {
  const binary = Array.from(bytes, (b) => String.fromCharCode(b)).join("");
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

export function base64urlDecode(b64url: string): Uint8Array {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const binary = atob(padded);
  return new Uint8Array(binary.length).map((_, i) => binary.charCodeAt(i));
}

export function randomBytes(n: number): Uint8Array {
  const buf = new Uint8Array(n);
  crypto.getRandomValues(buf);
  return buf;
}

// ---------------------------------------------------------------------------
// X25519 key exchange (Web Crypto)
// ---------------------------------------------------------------------------

export type BrowserKeyPair = {
  privateKey: CryptoKey;
  publicKeyBytes: Uint8Array;
  publicKeyB64url: string;
};

export async function generateX25519KeyPair(): Promise<BrowserKeyPair> {
  const kp = (await crypto.subtle.generateKey({ name: "X25519" }, true, [
    "deriveBits",
  ])) as CryptoKeyPair;
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
  const theirPubKey = await crypto.subtle.importKey(
    "jwk",
    { kty: "OKP", crv: "X25519", x: theirPubKeyB64url },
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

export async function hkdfSha256(
  ikm: Uint8Array,
  salt: Uint8Array | null,
  info: string,
  length: number,
): Promise<Uint8Array> {
  // Copy into fresh ArrayBuffer-backed views so the Web Crypto `BufferSource`
  // typing is satisfied across TS versions (TS 5.7+ makes Uint8Array generic
  // over ArrayBufferLike, which excludes SharedArrayBuffer-backed views).
  const baseKey = await crypto.subtle.importKey("raw", new Uint8Array(ikm), "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(salt ?? new Uint8Array(32)), // RFC 5869 default salt = 32 zero bytes
      info: new TextEncoder().encode(info),
    },
    baseKey,
    length * 8,
  );
  return new Uint8Array(bits);
}

/**
 * Derive the 32-byte conversation key from our X25519 private key and the peer's
 * base64url public key (ECDH → HKDF-SHA256), using the shared KDF info.
 */
export async function deriveConversationKey(
  myPrivateKey: CryptoKey,
  theirPubKeyB64url: string,
): Promise<Uint8Array> {
  const rawSecret = await deriveX25519SharedSecret(myPrivateKey, theirPubKeyB64url);
  return hkdfSha256(rawSecret, null, CONVERSATION_KDF_INFO, 32);
}

// ---------------------------------------------------------------------------
// Conversation-key unwrap (Phase 6 multi-device — register-delivered key)
// ---------------------------------------------------------------------------

/**
 * HKDF `info` for the key-wrap path. MUST match the agent's
 * `late-join-decryptor.ts` (`KEY_WRAP_INFO`) — domain-separated from the
 * conversation KDF so one ECDH secret can never serve both purposes.
 */
export const KEY_WRAP_INFO = "webchannel-key-wrap-v1";

/**
 * F2 — build the key-wrap AAD that binds K to exactly ONE peerId. MUST be
 * byte-identical to the agent's `wrapAad` (packages/plugin/src/late-join-decryptor.ts):
 * plain UTF-8 of the peerId (ASCII on both sides). A wrap minted for peerA cannot
 * be lifted into peerB's register reply — peerB unwraps with `wrapAad(peerB)` and
 * Poly1305 fails.
 */
export function wrapAad(peerId: string): Uint8Array {
  return new TextEncoder().encode(peerId);
}

/**
 * Wire format of a wrapped conversation key, as returned by the plugin's
 * register route (`wrappedConversationKey` in the register HTTP response).
 * All four fields are base64url. Mirrors the agent-side type in
 * `packages/plugin/src/late-join-decryptor.ts`.
 */
export type WrappedConversationKey = {
  /**
   * b64url 32-byte X25519 public key used for the wrap ECDH. IGNORED here (F2):
   * the browser derives the unwrap key from the SaaS-PINNED agent public key,
   * never from this wire field (which an untrusted relay could substitute). Kept
   * in the type only because an OLD (pre-F2) browser read it — but there is NO
   * interop with an old browser: the new agent always binds the peerId AAD, which
   * an old no-AAD unwrap can't satisfy, so old-client + new-agent is a HARD break
   * (strict 3-way lockstep). The field name is retained; its value is vestigial.
   */
  ephemeralPublicKey: string;
  /** b64url 12-byte ChaCha20-Poly1305 nonce. */
  nonce: string;
  /** b64url 32-byte ciphertext of the conversation key. */
  ciphertext: string;
  /** b64url 16-byte Poly1305 tag. */
  tag: string;
};

/**
 * Unwrap (decrypt) the agent-delivered conversation key K with this device's
 * X25519 private key (the `cnf` key minted into the bootstrap JWT).
 *
 * F2 — the shared secret is derived from the SaaS-PINNED `agentPublicKeyB64url`
 * (the agent's identity key attested in the first-party HTTPS bootstrap response),
 * NEVER from any NATS-carried field. So a relay that injects its own K′ — wrapped
 * under a relay-chosen key — fails Poly1305 under ECDH(device.private, pinnedAgent):
 * this single invariant closes the register-hop MITM. The peerId is bound into the
 * AAD (`wrapAad`) so a genuine wrap cannot be lifted to another peer.
 *
 * ECDH(device.private, PINNED agent.public) → HKDF-SHA256(KEY_WRAP_INFO) →
 * ChaCha20-Poly1305 open (aad = wrapAad(peerId)). Poly1305 is verified before
 * anything is returned; a wrong key, tampered payload, or peerId mismatch throws
 * and the caller MUST treat the session as failed (fail-closed).
 *
 * @param agentPublicKeyB64url - the SaaS-pinned agent X25519 identity public key
 *        (base64url, 32 bytes). The caller obtains it from the bootstrap response
 *        (`parseBootstrapResponse`) and MUST NOT source it from any NATS frame.
 * @param peerId - this device's authenticated peerId (JWT `sub`), bound into the AAD.
 */
export async function unwrapConversationKey(
  wrapped: WrappedConversationKey,
  devicePrivateKey: CryptoKey,
  agentPublicKeyB64url: string,
  peerId: string,
): Promise<Uint8Array> {
  const rawSecret = await deriveX25519SharedSecret(
    devicePrivateKey,
    agentPublicKeyB64url,
  );
  const wrapKey = await hkdfSha256(rawSecret, null, KEY_WRAP_INFO, 32);
  return chacha20poly1305Decrypt(
    wrapKey,
    base64urlDecode(wrapped.nonce),
    base64urlDecode(wrapped.ciphertext),
    base64urlDecode(wrapped.tag),
    wrapAad(peerId),
  );
}

// ---------------------------------------------------------------------------
// Handshake frame codec
// ---------------------------------------------------------------------------

/** Build the `{type:"key_exchange", pubKey}` handshake frame as a JSON string. */
export function keyExchangeFrame(publicKeyB64url: string): string {
  return JSON.stringify({ type: "key_exchange", pubKey: publicKeyB64url });
}

/** Parse a handshake frame; returns the peer public key (b64url) or null. */
export function parseKeyExchange(payload: string): string | null {
  try {
    const frame = JSON.parse(payload) as { type?: unknown; pubKey?: unknown };
    if (frame.type !== "key_exchange" || typeof frame.pubKey !== "string" || !frame.pubKey) {
      return null;
    }
    // An X25519 public key is exactly 32 bytes; a non-32-byte key would throw in
    // importKey downstream. Reject it here so a malformed frame is ignorable,
    // mirroring the agent's `parseKeyExchange` (e2e-session.ts).
    if (base64urlDecode(frame.pubKey).length !== 32) {
      return null;
    }
    return frame.pubKey;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// MessageEnvelope v1 codec
// ---------------------------------------------------------------------------

export type EnvelopeRouting = {
  accountId: string;
  tenant: string;
  sub: string;
  messageId: string;
  envelopeType: string;
  ts: number;
};

export type MessageEnvelope = {
  v: 1;
  accountId: string;
  tenant: string;
  sub: string;
  messageId: string;
  envelopeType: string;
  ts: number;
  content: { nonce: string; ciphertext: string; tag: string };
};

/**
 * Canonical AAD: UTF-8(JSON.stringify({tenant,accountId,sub,messageId,envelopeType,ts}))
 * with fixed key order. Must match every other endpoint byte-for-byte.
 */
export function canonicalAad(routing: EnvelopeRouting): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      tenant: routing.tenant,
      accountId: routing.accountId,
      sub: routing.sub,
      messageId: routing.messageId,
      envelopeType: routing.envelopeType,
      ts: routing.ts,
    }),
  );
}

export function encodeEnvelope(
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
      nonce: base64urlEncode(nonce),
      ciphertext: base64urlEncode(ciphertext),
      tag: base64urlEncode(tag),
    },
  };
}

export function decodeEnvelope(env: MessageEnvelope, sessionKey: Uint8Array): string {
  const routing: EnvelopeRouting = {
    accountId: env.accountId,
    tenant: env.tenant,
    sub: env.sub,
    messageId: env.messageId,
    envelopeType: env.envelopeType,
    ts: env.ts,
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

/**
 * Seal a structured message object into a serialized envelope JSON string ready
 * for `publish()`. `messageId`/`ts` are generated per call.
 */
export function sealMessage(
  routing: { accountId: string; tenant: string; sub: string },
  sessionKey: Uint8Array,
  message: unknown,
  envelopeType = "conversation",
): string {
  const fullRouting: EnvelopeRouting = {
    accountId: routing.accountId,
    tenant: routing.tenant,
    sub: routing.sub,
    messageId: Array.from(randomBytes(8), (b) => b.toString(16).padStart(2, "0")).join(""),
    envelopeType,
    ts: Date.now(),
  };
  return JSON.stringify(encodeEnvelope(fullRouting, JSON.stringify(message), sessionKey));
}

/**
 * Open a serialized envelope JSON string back into its structured message
 * object. Returns null if the payload is not a v1 envelope or fails to
 * decrypt/parse (callers treat null as "drop").
 */
export function openMessage(payloadJson: string, sessionKey: Uint8Array): unknown | null {
  try {
    const env = JSON.parse(payloadJson) as MessageEnvelope;
    if (env.v !== 1 || !env.content) return null;
    return JSON.parse(decodeEnvelope(env, sessionKey)) as unknown;
  } catch {
    return null;
  }
}
