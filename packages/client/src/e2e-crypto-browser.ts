/**
 * Browser-native E2E crypto helpers — the single crypto source for the browser
 * dial seam (X25519 + HKDF-SHA256 via Web Crypto, ChaCha20-Poly1305 via the
 * pure-JS `chacha20poly1305.ts`, MessageEnvelope v1 codec, canonical AAD).
 *
 * Uses ONLY browser-native APIs (crypto.subtle, WebSocket, TextEncoder/Decoder,
 * BigInt) so it runs identically in a real browser and in Node ≥18 (which also
 * exposes `globalThis.crypto.subtle` with X25519). It speaks the exact same wire
 * protocol the agent (`packages/plugin/src/e2e-session.ts` + `nats-channel.ts`)
 * uses:
 *   - conversation key K: register-delivered, unwrapped via the key-wrap ECDH
 *                         (KEY_WRAP_INFO = "webchannel-key-wrap-v1")
 *   - wire envelope:   MessageEnvelope v1 JSON, content = ChaCha20-Poly1305
 *   - AAD:             canonical(routing) = {tenant,accountId,sub,messageId,envelopeType,ts}
 */

import { chacha20poly1305Encrypt, chacha20poly1305Decrypt } from "./chacha20poly1305.js";

/**
 * HKDF `info` for the conversation key. MUST match the agent and the live gate.
 */
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

export async function deriveX25519SharedSecret(
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
// ---------------------------------------------------------------------------
// Conversation-key unwrap (Phase 6 multi-device — register-delivered key)
// ---------------------------------------------------------------------------

/**
 * HKDF `info` for the key-wrap path. MUST match the agent's
 * `late-join-decryptor.ts` (`KEY_WRAP_INFO`) — domain-separated from the
 * conversation KDF so one ECDH secret can never serve both purposes.
 */
export const KEY_WRAP_INFO = "webchannel-key-wrap-v1";

/** AAD domain/version prefix. MUST match the agent constant of the same name. */
export const WRAP_AAD_VERSION = "webchannel-wrap-v2";

/**
 * Field delimiter — ASCII 0x1F UNIT SEPARATOR. Written as a numeric constant on
 * purpose: a literal control character in source is invisible and survives
 * copy/paste badly, and this byte must be identical on both sides of the wire.
 */
export const WRAP_AAD_SEPARATOR = 0x1f;

/**
 * F2 + v3 — build the key-wrap AAD that binds K to exactly ONE peerId AND ONE
 * register attempt:
 *
 *   UTF-8("webchannel-wrap-v2") ‹0x1F› UTF-8(peerId) ‹0x1F› UTF-8(clientNonce)
 *
 * MUST be byte-identical to the agent's `wrapAad`
 * (packages/plugin/src/late-join-decryptor.ts) — asserted by
 * `wrap-aad-parity.test.ts`.
 *
 *   - `peerId` (anti-LIFT): a wrap minted for peerA cannot be lifted into peerB's
 *     register reply — peerB computes a different AAD and Poly1305 fails.
 *   - `clientNonce` (anti-REPLAY): this browser generated it locally for THIS
 *     register attempt, so a register reply the relay captured earlier cannot
 *     open under the current AAD.
 *
 * The `0x1F` delimiter needs no escaping: peerId is a NATS subject token and
 * clientNonce is base64url, and neither alphabet contains it.
 */
export function wrapAad(peerId: string, clientNonce: string): Uint8Array {
  const enc = new TextEncoder();
  const version = enc.encode(WRAP_AAD_VERSION);
  const peer = enc.encode(peerId);
  const nonce = enc.encode(clientNonce);
  const out = new Uint8Array(version.length + 1 + peer.length + 1 + nonce.length);
  let at = 0;
  out.set(version, at);
  at += version.length;
  out[at++] = WRAP_AAD_SEPARATOR;
  out.set(peer, at);
  at += peer.length;
  out[at++] = WRAP_AAD_SEPARATOR;
  out.set(nonce, at);
  return out;
}

/**
 * Wire format of a wrapped conversation key, as returned by the plugin's
 * register route (`wrappedConversationKey` in the register HTTP response).
 * All four fields are base64url. Mirrors the agent-side type in
 * `packages/plugin/src/late-join-decryptor.ts`.
 */
export type WrappedConversationKey = {
  /**
   * b64url 32-byte agent X25519 public key. It must equal the independently
   * SaaS-pinned key before that pin is used for wrap ECDH.
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
 * AAD (`wrapAad`) so a genuine wrap cannot be lifted to another peer, and the
 * per-attempt `clientNonce` is bound alongside it so a genuine wrap captured from
 * an EARLIER attempt cannot be replayed onto this one (v3 freshness anchor).
 *
 * ECDH(device.private, PINNED agent.public) → HKDF-SHA256(KEY_WRAP_INFO) →
 * ChaCha20-Poly1305 open (aad = wrapAad(peerId, clientNonce)). Poly1305 is verified
 * before anything is returned; a wrong key, tampered payload, peerId mismatch, or
 * stale clientNonce throws and the caller MUST treat the session as failed
 * (fail-closed).
 *
 * @param agentPublicKeyB64url - the SaaS-pinned agent X25519 identity public key
 *        (base64url, 32 bytes). The caller obtains it from the bootstrap response
 *        (`parseBootstrapResponse`) and MUST NOT source it from any NATS frame.
 * @param peerId - this device's authenticated peerId (JWT `sub`), bound into the AAD.
 * @param clientNonce - the freshness anchor THIS browser generated and sent on the
 *        register request. It MUST be the locally-held value — NEVER one read back
 *        out of the register reply. If it ever came off the wire the relay would
 *        choose the anchor and a captured register reply would replay cleanly,
 *        which is exactly what this parameter exists to prevent.
 */
export async function unwrapConversationKey(
  wrapped: WrappedConversationKey,
  devicePrivateKey: CryptoKey,
  agentPublicKeyB64url: string,
  peerId: string,
  clientNonce: string,
): Promise<Uint8Array> {
  const wireAgentKey = base64urlDecode(wrapped.ephemeralPublicKey);
  const pinnedAgentKey = base64urlDecode(agentPublicKeyB64url);
  if (
    wireAgentKey.length !== pinnedAgentKey.length ||
    wireAgentKey.some((value, index) => value !== pinnedAgentKey[index])
  ) {
    throw new Error("wrapped conversation key agent identity does not match the pinned key");
  }
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
    wrapAad(peerId, clientNonce),
  );
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
