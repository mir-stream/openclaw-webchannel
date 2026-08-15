/**
 * Late-join envelope decryptor — Sub-AC 2b.
 *
 * Client-side (device-side) routine for late-join backlog decryption.
 *
 * Problem
 * ───────
 * A device that joins an existing conversation after some messages have already
 * been exchanged has missed live broadcasts.  The agent is the single history
 * authority, but it keeps no ciphertext store of its own: it reads the past
 * messages from OpenClaw core's session transcript (plaintext, core-owned) and
 * encrypts them with the current K as it paginates them out over NATS (history
 * subject).  See `history.ts` and `docs/ISSUE_72_CONTAINMENT_PLAN.md` §1.4.
 *
 * But ciphertext alone is not enough: the device also needs the conversation key
 * used to encrypt those envelopes.  That key is delivered out-of-band, wrapped
 * (encrypted) for the specific device's X25519 public key so that the NATS relay
 * operator never observes it in plaintext.
 *
 * Key-wrap scheme (X25519 ECDH + HKDF-SHA256 + ChaCha20-Poly1305)
 * ─────────────────────────────────────────────────────────────────
 * Two modes share one wire format (`WrappedConversationKey`):
 *
 *   • STATIC-STATIC (F2, production register/keyStore path). The agent wraps K
 *     with its SaaS-ATTESTED static identity key so the browser can AUTHENTICATE
 *     that K came from the genuine agent — the browser derives the unwrap key
 *     SOLELY from the SaaS-pinned agent public key (never from the wire), so an
 *     untrusted relay that injects its own K′ wrapped under a relay-chosen key
 *     fails Poly1305. The peerId AND the browser-chosen per-attempt clientNonce
 *     are bound into the AAD (`wrapAad`).
 *       Agent (wrapConversationKey with opts.agentIdentityKeyPair):
 *         1. ECDH: sharedSecret = X25519(agentIdentity.private, device.publicKey).
 *         2. wrapKey = HKDF(sharedSecret, null, "webchannel-key-wrap-v1", 32).
 *         3. {ciphertext,nonce,tag} =
 *            Encrypt(wrapKey, K, aad=wrapAad(peerId, clientNonce)).
 *         4. `ephemeralPublicKey` field carries the agent IDENTITY public key —
 *            a field-name alias only (a new browser IGNORES it and derives from
 *            the SaaS-pinned key). This gives NO old-client interop: the agent
 *            ALWAYS binds peerId into the wrap AAD, so an old (pre-F2, no-AAD)
 *            browser's unwrap fails Poly1305 → old-client + new-agent is a HARD
 *            break. Strict 3-way lockstep (client+agent+SaaS ship together); the
 *            alias only keeps the wire field NAME stable.
 *       Device (unwrapConversationKey with opts.agentPublicKey = pinned key):
 *         1. ECDH: sharedSecret = X25519(device.privateKey, PINNED agentPublicKey).
 *         2. wrapKey = HKDF(...);
 *         3. Decrypt(wrapKey, …, aad=wrapAad(peerId, clientNonce)) — with the
 *            clientNonce THIS browser generated for THIS register attempt, never
 *            a value read back off the wire.
 *
 *   • EPHEMERAL (legacy, no identity key supplied). A fresh ephemeral key pair
 *     is generated per wrap and its public half travels in `ephemeralPublicKey`;
 *     the device derives from that field. Kept ONLY for the self-test / any
 *     non-attested caller — the production wrap path always supplies the
 *     identity key. This mode gives NO agent authentication (the field is
 *     attacker-substitutable), which is exactly the MITM F2 closes.
 *
 * Full late-join pipeline (decryptBacklog):
 *   1. Unwrap the conversation key from the WrappedConversationKey.
 *   2. For each envelope in the paginated backlog: decrypt with the recovered key.
 *   3. Return plaintext payloads in insertion order.
 *
 * Security invariants
 * ───────────────────
 *   • The conversation key never travels in plaintext over NATS or any public bus.
 *   • The wrapped key is targeted at exactly one device (ECDH binds to that
 *     device's public key); another device's private key cannot unwrap it.
 *   • In the STATIC-STATIC (F2) mode the wrap is AUTHENTICATED to the agent: the
 *     browser derives the unwrap key from the SaaS-pinned agent identity public
 *     key, so a wrap NOT produced by the agent's identity private key fails
 *     Poly1305 — closing the register-relay MITM. The peerId is bound into the
 *     AAD so a wrap cannot be lifted to another peer.
 *   • FRESHNESS (v3): the wrap is also bound to a per-attempt, BROWSER-generated
 *     `clientNonce`. Authentication alone left the register reply REPLAYABLE — a
 *     relay could re-serve a captured reply verbatim. That is inert only while K
 *     never rotates; the anchor is added now so a future rotation cannot turn a
 *     captured reply into a session hijack.
 *   • The Poly1305 tag prevents undetected tampering of the wrapped key.
 *   • Forward secrecy: static-static drops the distribution-step ephemeral, but
 *     this is a NON-loss — K is already persisted on the agent's disk
 *     (conversation-key-store), so the ephemeral never gave end-to-end FS. A
 *     fresh random 12-byte nonce per Encrypt (e2e-crypto.ts) keeps the static
 *     wrap key safe at register frequency.
 *   • The device private key never leaves the device.
 *
 * Deferred
 * ────────
 *   • Message-level forward secrecy: the shared conversation key covers the
 *     entire backlog — compromise of the key exposes all stored messages.
 *     Per-message ratchets (e.g. Double Ratchet) are deferred (see Seed).
 *   • Key rotation / revocation rekey: rotating the conversation key and
 *     re-wrapping all stored envelopes is deferred.
 *   • Operator-keyless enterprise mode: deferred.
 */

import {
  generateKeyPair,
  deriveSharedSecret,
  hkdfSha256,
  encrypt,
  decrypt,
} from "./e2e-crypto.js";
import type { KeyPair } from "./e2e-crypto.js";
import { decryptEnvelopeContent } from "./e2e-envelope.js";
import { wrapAad } from "./wrap-aad.js";
import type { MessageEnvelope } from "./e2e-envelope.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * HKDF-SHA256 domain-separation info string for the key-wrap path.
 *
 * Distinct from the conversation-encryption info ("webchannel-conversation-v1")
 * so that a single ECDH shared secret cannot be used interchangeably for both
 * purposes — cryptographic domain separation ensures independence.
 */
export const KEY_WRAP_INFO = "webchannel-key-wrap-v1" as const;

// The AAD encoding lives in its own dependency-free module so the cross-package
// parity test can import it under the client's browser-only lib set. Re-exported
// here because this is where wrap/unwrap callers reach it.
export { wrapAad, WRAP_AAD_VERSION, WRAP_AAD_SEPARATOR } from "./wrap-aad.js";

/**
 * The pair that binds a wrap to one peer AND one register attempt. Both halves
 * are mandatory together: see `WrapBindingOpts`.
 */
export type WrapBinding = {
  /** Verified JWT `sub` of the target peer (F2 anti-lift). */
  peerId: string;
  /** The BROWSER-generated per-attempt freshness anchor (v3 anti-replay). */
  clientNonce: string;
};

/**
 * Binding options for wrap/unwrap. The union makes it a COMPILE error to supply
 * `peerId` without `clientNonce` — the production path must never fall into an
 * `undefined`-AAD branch, which would silently drop the freshness anchor. The
 * "neither" arm exists only for the legacy/self-test ephemeral mode, which is
 * not agent-authenticated and never used by the register hop.
 */
export type WrapBindingOpts = WrapBinding | { peerId?: undefined; clientNonce?: undefined };

/**
 * Resolve the AAD from the binding options. Returns `undefined` ONLY for the
 * legacy "neither supplied" arm. A half-supplied binding is a programming error
 * that the type system already rejects; this throw catches an untyped/JS caller
 * so it can never degrade into an anchorless wrap.
 */
function bindingAad(opts: WrapBindingOpts): Uint8Array | undefined {
  const hasPeer = opts.peerId !== undefined;
  const hasNonce = opts.clientNonce !== undefined;
  if (hasPeer !== hasNonce) {
    throw new Error(
      "webchannel: wrap binding requires BOTH peerId and clientNonce (or neither) — " +
        "a peerId-only wrap would drop the v3 freshness anchor",
    );
  }
  if (!hasPeer) return undefined;
  return wrapAad(opts.peerId as string, opts.clientNonce as string);
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * The wire format for a wrapped (encrypted) conversation key.
 *
 * All four fields are base64url-encoded binary.  Together they encode:
 *   - The agent's ephemeral X25519 public key (needed for ECDH on the device side).
 *   - A ChaCha20-Poly1305 ciphertext of the 32-byte conversation key.
 *
 * This structure is transmitted from agent → device over the SaaS-authenticated
 * bootstrap or key-distribution channel.  It MUST NOT be transmitted over NATS
 * in plaintext (the relay operator must not see the wrapped key material).
 *
 * Invariants:
 *   - `ephemeralPublicKey` decodes to exactly 32 bytes (X25519 public key).
 *   - `nonce` decodes to exactly 12 bytes (ChaCha20-Poly1305 nonce).
 *   - `ciphertext` decodes to exactly 32 bytes (encrypted conversation key).
 *   - `tag` decodes to exactly 16 bytes (Poly1305 authentication tag).
 */
export type WrappedConversationKey = {
  /**
   * base64url-encoded 32-byte X25519 public key used for the wrap ECDH.
   * In the STATIC-STATIC (F2) mode this is the agent's IDENTITY public key
   * (a field-name alias only — a new browser IGNORES it and derives from the
   * SaaS-pinned key; it does NOT give old-client interop, since the peerId AAD
   * makes old-client + new-agent a hard break); in the legacy mode it is a fresh
   * ephemeral public.
   */
  readonly ephemeralPublicKey: string;
  /**
   * base64url-encoded 12-byte ChaCha20-Poly1305 nonce.
   * Unique per encrypt call (random); MUST be transmitted alongside ciphertext + tag.
   */
  readonly nonce: string;
  /**
   * base64url-encoded 32-byte ciphertext of the conversation key.
   * Decryptable only by the target device (holder of the matching private key).
   */
  readonly ciphertext: string;
  /**
   * base64url-encoded 16-byte Poly1305 authentication tag.
   * Covers the ciphertext; prevents undetected tampering.
   */
  readonly tag: string;
};

/**
 * The result of a successful `decryptBacklog` call.
 *
 * Plaintext payloads are in the same order as the input envelopes.
 * Each `Uint8Array` is the raw plaintext bytes of the corresponding envelope's
 * content — typically a UTF-8 JSON string (conversation message body).
 */
export type DecryptedBacklog = {
  /**
   * Recovered plaintext payloads, one per input envelope, in insertion order.
   * Use `new TextDecoder().decode(plaintexts[i])` to obtain the string payload.
   */
  readonly plaintexts: Uint8Array[];
  /**
   * The recovered 32-byte conversation key (exposed for callers that need to
   * decrypt future envelopes without re-unwrapping the key each time).
   */
  readonly conversationKey: Uint8Array;
};

// ---------------------------------------------------------------------------
// Agent-side: wrap a conversation key for a specific device
// ---------------------------------------------------------------------------

/**
 * Wrap (encrypt) a conversation key for delivery to a specific device.
 *
 * Called by the AGENT when a new device registers or when a late-joining device
 * needs the key distributed.  The result is delivered to the device via the
 * SaaS-authenticated channel — never via NATS in plaintext.
 *
 * The wrapping is device-specific: only the holder of `devicePrivateKey`
 * (corresponding to `devicePublicKey`) can unwrap via `unwrapConversationKey`.
 *
 * A fresh ephemeral X25519 key pair is generated on every call, so two successive
 * wraps of the same conversation key for the same device produce different outputs.
 * This provides forward secrecy for the key-distribution path.
 *
 * @param conversationKey - 32-byte symmetric conversation key to wrap.
 * @param devicePublicKey - 32-byte X25519 public key of the target device (from cnf.jwk).
 * @param opts.agentIdentityKeyPair - the agent's SaaS-attested STATIC identity
 *        key pair. When supplied, the wrap is static-static (agent-authenticated,
 *        F2 production path) and its PUBLIC half is emitted in `ephemeralPublicKey`
 *        (a field-name alias only — NOT old-client-interoperable, see the module
 *        docstring). When OMITTED, a fresh ephemeral key pair is generated (legacy
 *        / self-test — NOT agent-authenticated).
 * @param opts.peerId + opts.clientNonce - the wrap binding. Supplied TOGETHER or
 *        not at all (enforced by the type AND at runtime): they bind the wrap to
 *        one peer (anti-lift) and one register attempt (anti-replay) via
 *        `wrapAad`. The production register path ALWAYS supplies both.
 * @returns WrappedConversationKey — safe to transmit over an authenticated channel.
 */
export function wrapConversationKey(
  conversationKey: Uint8Array,
  devicePublicKey: Uint8Array,
  opts: { agentIdentityKeyPair?: KeyPair } & WrapBindingOpts = {},
): WrappedConversationKey {
  // STATIC-STATIC when an attested identity key is supplied; else a fresh
  // ephemeral key pair (legacy). Either way, the public half of the wrap key
  // travels in `ephemeralPublicKey` (a field-name alias in the static case — a
  // new browser ignores it; there is no old-client interop because of the AAD).
  const wrapKp = opts.agentIdentityKeyPair ?? generateKeyPair();

  // X25519 ECDH: wrap private × device public → raw shared secret.
  const rawSecret = deriveSharedSecret(wrapKp.privateKey, devicePublicKey);

  // HKDF-SHA256: expand to a 32-byte wrapping key with domain separation.
  const wrapKey = hkdfSha256(rawSecret, null, KEY_WRAP_INFO, 32);

  // ChaCha20-Poly1305: authenticate-encrypt the 32-byte conversation key,
  // binding (peerId, clientNonce) into the AAD when provided — F2 anti-lift plus
  // the v3 anti-replay freshness anchor. `bindingAad` refuses a half-binding, so
  // the production path cannot degrade to an anchorless wrap.
  const aad = bindingAad(opts);
  const { ciphertext, nonce, tag } = encrypt(wrapKey, conversationKey, aad);

  return {
    ephemeralPublicKey: uint8ToBase64Url(wrapKp.publicKey),
    nonce: uint8ToBase64Url(nonce),
    ciphertext: uint8ToBase64Url(ciphertext),
    tag: uint8ToBase64Url(tag),
  };
}

// ---------------------------------------------------------------------------
// Device-side: unwrap a conversation key using this device's private key
// ---------------------------------------------------------------------------

/**
 * Unwrap (decrypt) a conversation key using this device's X25519 private key.
 *
 * Called by the DEVICE (browser) upon receiving a `WrappedConversationKey` from
 * the agent via the SaaS-authenticated bootstrap or key-distribution channel.
 *
 * The ECDH operation is symmetric to the agent's wrap:
 *   device.private × ephemeral.public == ephemeral.private × device.public
 * Both sides derive the same raw shared secret and therefore the same wrap key.
 *
 * Authentication (Poly1305) is verified before returning the conversation key.
 * Any tampering of the wrapped key — or use of a wrong private key — causes an
 * exception; the caller MUST NOT use the return value if an exception is thrown.
 *
 * @param wrapped          - WrappedConversationKey received from the agent.
 * @param devicePrivateKey - 32-byte X25519 private key of this device. Keep secret.
 * @param opts.agentPublicKey - the SaaS-PINNED agent identity public key. When
 *        supplied, the shared secret is derived from THIS (never the wire
 *        `ephemeralPublicKey`), so a relay's injected K′ — wrapped under any
 *        non-agent key — fails Poly1305. When OMITTED, derives from the wire
 *        `ephemeralPublicKey` (legacy / self-test).
 * @param opts.peerId + opts.clientNonce - must match the binding the agent put
 *        into the wrap AAD; otherwise the Poly1305 check fails. Supplied
 *        together or not at all. A wrap captured under an EARLIER clientNonce
 *        fails here — that is the v3 replay defence.
 * @returns 32-byte plaintext conversation key.
 * @throws `Error` if authentication fails (wrong key, tampered ciphertext/tag,
 *         peerId or clientNonce mismatch, or malformed base64url in the wrapped
 *         key fields).
 */
export function unwrapConversationKey(
  wrapped: WrappedConversationKey,
  devicePrivateKey: Uint8Array,
  opts: { agentPublicKey?: Uint8Array } & WrapBindingOpts = {},
): Uint8Array {
  // Derive from the PINNED agent key when supplied (F2 — the browser never trusts
  // the wire-carried key); else fall back to the wire field (legacy path).
  const agentPublicKey =
    opts.agentPublicKey ?? base64UrlToUint8(wrapped.ephemeralPublicKey);
  const nonce = base64UrlToUint8(wrapped.nonce);
  const ciphertext = base64UrlToUint8(wrapped.ciphertext);
  const tag = base64UrlToUint8(wrapped.tag);

  // X25519 ECDH: device private × agent public → same raw shared secret as agent.
  const rawSecret = deriveSharedSecret(devicePrivateKey, agentPublicKey);

  // HKDF-SHA256: derive the same 32-byte wrapping key.
  const wrapKey = hkdfSha256(rawSecret, null, KEY_WRAP_INFO, 32);

  // ChaCha20-Poly1305: decrypt and verify the Poly1305 tag (over ciphertext + AAD).
  // Throws if authentication fails — caller must not use output on exception.
  const aad = bindingAad(opts);
  return decrypt(wrapKey, nonce, ciphertext, tag, aad);
}

// ---------------------------------------------------------------------------
// Device-side: full late-join pipeline
// ---------------------------------------------------------------------------

/**
 * Decrypt a full backlog of paginated ciphertext envelopes as a late-joining device.
 *
 * This is the primary late-join API.  It combines key unwrapping and envelope
 * decryption into a single call, matching the late-join device flow:
 *
 *   1. Unwrap the conversation key using this device's X25519 private key.
 *   2. Decrypt every envelope in the (already-paginated) backlog using the key.
 *   3. Return the recovered plaintexts in insertion order.
 *
 * Callers are responsible for paginating the HistoryStore (or history replay
 * subject) and collecting envelopes before calling this function.  The typical
 * pattern for a late-joining device:
 *
 *   ```ts
 *   // (a) Collect all history envelopes via the paginated load_history request.
 *   let cursor: string | null = null;
 *   const allEnvelopes: MessageEnvelope[] = [];
 *   do {
 *     const { envelopes, nextCursor } = await requestHistory(sub, cursor, PAGE_SIZE);
 *     allEnvelopes.push(...envelopes);
 *     cursor = nextCursor;
 *   } while (cursor !== null);
 *
 *   // (b) Unwrap the conversation key and decrypt all envelopes.
 *   const { plaintexts, conversationKey } = decryptBacklog(
 *     allEnvelopes,
 *     wrappedKey,          // delivered via SaaS-authenticated channel
 *     device.privateKey,   // never leaves the device
 *   );
 *
 *   // (c) Use plaintexts[i] to render message i in the conversation history.
 *   for (const pt of plaintexts) {
 *     const message = JSON.parse(new TextDecoder().decode(pt));
 *     renderMessage(message);
 *   }
 *   ```
 *
 * Failure semantics:
 *   - If key unwrapping fails (wrong device key or tampered wrapped key), the
 *     function throws before any envelope is decrypted.
 *   - If any envelope decryption fails (tampered ciphertext, wrong key version),
 *     the function throws at that envelope.  Partially-decrypted results are NOT
 *     returned — the caller receives either all M plaintexts or an exception.
 *
 * @param envelopes        - Ordered ciphertext `MessageEnvelope` array (all history pages
 *                           concatenated, oldest-first as returned by `load_history`).
 * @param wrappedKey       - Conversation key wrapped for this device (from agent key distribution).
 * @param devicePrivateKey - 32-byte X25519 device private key.
 * @returns `DecryptedBacklog` with `plaintexts` (in insertion order) and the recovered key.
 * @throws `Error` if key unwrapping or any envelope decryption fails.
 */
export function decryptBacklog(
  envelopes: readonly MessageEnvelope[],
  wrappedKey: WrappedConversationKey,
  devicePrivateKey: Uint8Array,
  opts: { agentPublicKey?: Uint8Array } & WrapBindingOpts = {},
): DecryptedBacklog {
  // Step 1: Unwrap the conversation key.
  // This is the gatekeeper — if this fails, no plaintexts are produced.
  const conversationKey = unwrapConversationKey(wrappedKey, devicePrivateKey, opts);

  // Step 2: Decrypt each envelope using the recovered conversation key.
  // `decryptEnvelopeContent` throws on auth failure — any tampered envelope
  // propagates the error to the caller.
  const plaintexts = envelopes.map((env) =>
    decryptEnvelopeContent(env, conversationKey),
  );

  return { plaintexts, conversationKey };
}

// ---------------------------------------------------------------------------
// Internal base64url helpers
// ---------------------------------------------------------------------------

function uint8ToBase64Url(buf: Uint8Array): string {
  return Buffer.from(buf).toString("base64url");
}

function base64UrlToUint8(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, "base64url"));
}
