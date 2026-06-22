/**
 * E2E Message Envelope Codec — Sub-AC 2.
 *
 * Serializes / deserializes the NATS wire format where:
 *  - Routing metadata (agentId, tenant, sub, messageId, envelopeType, ts)
 *    is PLAINTEXT — visible to the NATS relay operator and needed for subject
 *    routing / account isolation.
 *  - Message content is the ChaCha20-Poly1305 CIPHERTEXT produced by the
 *    e2e-crypto module — the relay operator sees only bytes, never the payload.
 *
 * Wire format (JSON-serialized for NATS publish):
 *
 *   {
 *     "v": 1,                         // schema version
 *     "agentId": "agent-abc",         // plaintext — NATS subject routing
 *     "tenant": "tenant-xyz",         // plaintext — NATS account isolation
 *     "sub": "user-42",               // plaintext — JWT sub (user scope)
 *     "messageId": "msg-uuid-...",    // plaintext — correlation / dedup
 *     "envelopeType": "conversation", // plaintext — message kind discriminator
 *     "ts": 1718000000000,            // plaintext — Unix ms timestamp
 *     "content": {
 *       "nonce": "<base64url>",       // 12-byte ChaCha20 nonce (CIPHERTEXT)
 *       "ciphertext": "<base64url>",  // encrypted payload bytes (CIPHERTEXT)
 *       "tag": "<base64url>"          // 16-byte Poly1305 auth tag (CIPHERTEXT)
 *     }
 *   }
 *
 * Zero-plaintext guarantee
 * ────────────────────────
 * The "content" object contains ONLY binary-encoded ciphertext components.
 * No field inside "content" holds any part of the original message text.
 * The relay operator may observe agentId / tenant / sub (routing metadata)
 * but cannot observe any conversation or approval content.
 *
 * AAD binding
 * ───────────
 * Callers may pass an `aad` (additional authenticated data) to `encodeEnvelope`.
 * The AAD is authenticated but NOT included in the envelope (e.g. the NATS
 * subject or an approvalId). The same `aad` MUST be passed to
 * `decryptEnvelopeContent` for authentication to succeed.
 *
 * At-rest storage
 * ───────────────
 * The `MessageEnvelope` is the same format used for at-rest storage — the
 * agent stores encrypted envelopes and replays them outbound during backlog
 * replay. No conversion is needed between at-rest and wire formats.
 */

import { encrypt, decrypt } from "./e2e-crypto.js";
import type { EncryptResult } from "./e2e-crypto.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Schema version for the envelope wire format.
 * Bump when the layout changes in a backward-incompatible way.
 */
export const ENVELOPE_VERSION = 1 as const;

/**
 * Supported envelope content types. Determines how the decrypted payload
 * should be parsed by the recipient. Transmitted as plaintext for routing
 * decisions — does NOT reveal any content.
 */
export type EnvelopeType =
  | "conversation"       // user_message / agent_message / progress
  | "approval_request"   // agent → browser: render approval widget
  | "approval_decision"  // browser → agent: user clicked a button
  | "approval_resolved"  // agent → browser: decision confirmed
  | "history"            // backlog replay snapshot
  | "typing";            // ephemeral typing signal (content may be empty bytes)

/**
 * Plaintext routing metadata present in every envelope.
 * This is what the NATS relay operator can observe; it contains ZERO content.
 */
export type EnvelopeRouting = {
  /** SaaS-issued agent identity (agentId claim). Plaintext — used for NATS subject routing. */
  readonly agentId: string;
  /** Tenant scope (tenant claim). Plaintext — used for NATS account isolation. */
  readonly tenant: string;
  /** JWT `sub` claim — stable per-user identity across devices. Plaintext. */
  readonly sub: string;
  /** Unique message identifier for dedup / correlation. Plaintext. */
  readonly messageId: string;
  /** Content type discriminator (plaintext; reveals message KIND, never CONTENT). */
  readonly envelopeType: EnvelopeType;
  /** Unix millisecond timestamp (sender wall clock). Plaintext. */
  readonly ts: number;
};

/**
 * The encrypted content block embedded in every `MessageEnvelope`.
 *
 * ALL three fields are base64url-encoded binary; NONE contains plaintext.
 * Together they encode a ChaCha20-Poly1305 AEAD ciphertext. Decryption
 * requires all three plus the correct 32-byte key (and optional AAD).
 */
export type EncryptedContentBlock = {
  /** base64url-encoded 12-byte ChaCha20-Poly1305 nonce. */
  readonly nonce: string;
  /** base64url-encoded ciphertext (same byte-length as original plaintext). */
  readonly ciphertext: string;
  /** base64url-encoded 16-byte Poly1305 authentication tag. */
  readonly tag: string;
};

/**
 * The complete wire-format / at-rest envelope.
 *
 * Invariants:
 *  - `v` is always `1` (schema version, this revision).
 *  - Routing fields (agentId / tenant / sub / messageId / envelopeType / ts)
 *    are PLAINTEXT and MUST NOT carry any conversation content.
 *  - `content` is CIPHERTEXT only — zero plaintext content anywhere inside it.
 */
export type MessageEnvelope = {
  readonly v: typeof ENVELOPE_VERSION;
} & EnvelopeRouting & {
  readonly content: EncryptedContentBlock;
};

// ---------------------------------------------------------------------------
// Encoding (plaintext → encrypted envelope)
// ---------------------------------------------------------------------------

/**
 * Encode a plaintext message payload into an E2E encrypted `MessageEnvelope`.
 *
 * The `plaintext` may be a JSON-serialized string (e.g. the body of a
 * conversation turn or an approval request object) or raw bytes. It is
 * encrypted with ChaCha20-Poly1305 using a 12-byte random nonce; the
 * resulting ciphertext is base64url-encoded and stored in `content`.
 *
 * The routing fields (agentId, tenant, sub, messageId, envelopeType, ts) are
 * embedded as-is in the plaintext JSON envelope — they are never encrypted.
 *
 * @param routing   - Plaintext routing metadata (agentId, tenant, sub, …).
 * @param plaintext - Content to encrypt. Pass a string (UTF-8) or Uint8Array.
 * @param key       - 32-byte ChaCha20-Poly1305 encryption key (output of
 *                    `hkdfSha256(sharedSecret, …)`).
 * @param aad       - Optional additional authenticated data. Authenticated but
 *                    NOT stored in the envelope. The same value MUST be passed
 *                    to `decryptEnvelopeContent` or decryption will fail.
 * @returns A `MessageEnvelope` ready to be JSON-serialized and published.
 */
export function encodeEnvelope(
  routing: EnvelopeRouting,
  plaintext: Uint8Array | string,
  key: Uint8Array,
  aad?: Uint8Array,
): MessageEnvelope {
  const plaintextBytes =
    typeof plaintext === "string"
      ? new TextEncoder().encode(plaintext)
      : plaintext;

  const { ciphertext, nonce, tag }: EncryptResult = encrypt(
    key,
    plaintextBytes,
    aad,
  );

  const content: EncryptedContentBlock = {
    nonce: uint8ToBase64Url(nonce),
    ciphertext: uint8ToBase64Url(ciphertext),
    tag: uint8ToBase64Url(tag),
  };

  return {
    v: ENVELOPE_VERSION,
    ...routing,
    content,
  };
}

// ---------------------------------------------------------------------------
// Routing extraction (no key required)
// ---------------------------------------------------------------------------

/**
 * Extract plaintext routing metadata from an envelope WITHOUT a decryption key.
 *
 * The routing fields (agentId, tenant, sub, messageId, envelopeType, ts) are
 * always plaintext. Use this for dispatch / routing logic at the receiver
 * before deciding whether and how to decrypt the content.
 *
 * @param env - A validated `MessageEnvelope` (e.g. from `deserializeEnvelope`).
 * @returns The `EnvelopeRouting` extracted from the envelope.
 */
export function getEnvelopeRouting(env: MessageEnvelope): EnvelopeRouting {
  return {
    agentId: env.agentId,
    tenant: env.tenant,
    sub: env.sub,
    messageId: env.messageId,
    envelopeType: env.envelopeType,
    ts: env.ts,
  };
}

// ---------------------------------------------------------------------------
// Decoding (encrypted envelope → plaintext)
// ---------------------------------------------------------------------------

/**
 * Decrypt the content block of an E2E `MessageEnvelope`.
 *
 * Verifies the Poly1305 authentication tag over the ciphertext (and any AAD)
 * before returning plaintext. Throws on:
 *  - Wrong key
 *  - Tampered ciphertext or tag
 *  - AAD mismatch (if AAD was used during encryption)
 *
 * @param env - The `MessageEnvelope` to decrypt.
 * @param key - 32-byte decryption key (same as used in `encodeEnvelope`).
 * @param aad - Optional AAD (must exactly match what was passed to `encodeEnvelope`).
 * @returns Decrypted plaintext as `Uint8Array`.
 * @throws `Error` if the authentication tag verification fails.
 */
export function decryptEnvelopeContent(
  env: MessageEnvelope,
  key: Uint8Array,
  aad?: Uint8Array,
): Uint8Array {
  const nonce = base64UrlToUint8(env.content.nonce);
  const ciphertext = base64UrlToUint8(env.content.ciphertext);
  const tag = base64UrlToUint8(env.content.tag);
  return decrypt(key, nonce, ciphertext, tag, aad);
}

// ---------------------------------------------------------------------------
// Serialization / deserialization (wire format ↔ MessageEnvelope)
// ---------------------------------------------------------------------------

/**
 * Serialize a `MessageEnvelope` to a UTF-8 JSON Buffer for NATS publish.
 *
 * The resulting bytes can be passed directly to `NatsTransport.publish()`.
 * The relay operator who receives these bytes observes only routing metadata
 * and ciphertext — no content plaintext.
 *
 * @param env - A `MessageEnvelope` to serialize.
 * @returns UTF-8 encoded JSON buffer.
 */
export function serializeEnvelope(env: MessageEnvelope): Buffer {
  return Buffer.from(JSON.stringify(env), "utf8");
}

/**
 * Deserialize a `MessageEnvelope` from a NATS MSG payload (Buffer or string).
 *
 * Performs structural validation:
 *  - Top-level is a JSON object.
 *  - `v === 1` (schema version match).
 *  - All routing fields are non-empty strings (or finite number for `ts`).
 *  - `content` has non-empty string fields `nonce`, `ciphertext`, `tag`.
 *
 * @param payload - Raw NATS MSG payload (Buffer or string).
 * @returns A validated `MessageEnvelope`.
 * @throws `Error` if the payload is not a valid `MessageEnvelope` v1.
 */
export function deserializeEnvelope(payload: Buffer | string): MessageEnvelope {
  const json =
    typeof payload === "string" ? payload : payload.toString("utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("MessageEnvelope: invalid JSON payload");
  }
  return validateEnvelope(parsed);
}

// ---------------------------------------------------------------------------
// Internal validation
// ---------------------------------------------------------------------------

function validateEnvelope(raw: unknown): MessageEnvelope {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("MessageEnvelope: expected a JSON object");
  }
  const obj = raw as Record<string, unknown>;

  if (obj["v"] !== ENVELOPE_VERSION) {
    throw new Error(
      `MessageEnvelope: unsupported schema version ${String(obj["v"])} (expected ${ENVELOPE_VERSION})`,
    );
  }

  const stringFields = [
    "agentId",
    "tenant",
    "sub",
    "messageId",
    "envelopeType",
  ] as const;
  for (const field of stringFields) {
    if (typeof obj[field] !== "string" || !(obj[field] as string).length) {
      throw new Error(`MessageEnvelope: missing or empty field "${field}"`);
    }
  }

  if (typeof obj["ts"] !== "number" || !Number.isFinite(obj["ts"])) {
    throw new Error('MessageEnvelope: "ts" must be a finite number');
  }

  const content = obj["content"];
  if (!content || typeof content !== "object" || Array.isArray(content)) {
    throw new Error('MessageEnvelope: "content" must be a non-null object');
  }
  const c = content as Record<string, unknown>;
  for (const field of ["nonce", "ciphertext", "tag"] as const) {
    if (typeof c[field] !== "string" || !(c[field] as string).length) {
      throw new Error(
        `MessageEnvelope: content.${field} must be a non-empty string`,
      );
    }
  }

  return obj as unknown as MessageEnvelope;
}

// ---------------------------------------------------------------------------
// Base64url helpers (internal)
// ---------------------------------------------------------------------------

function uint8ToBase64Url(buf: Uint8Array): string {
  return Buffer.from(buf).toString("base64url");
}

function base64UrlToUint8(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, "base64url"));
}
