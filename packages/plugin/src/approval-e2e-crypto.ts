/**
 * Approval E2E Crypto — Sub-AC 7.1
 *
 * Typed helpers for encrypt-before-publish / decrypt-on-receive of approval
 * request/decision/resolved payloads over the NATS relay bus.
 *
 * All approval content is encrypted with X25519+HKDF-SHA256+ChaCha20-Poly1305
 * via the e2e-envelope codec. The `approvalId` is used as AAD (additional
 * authenticated data) to cryptographically bind each encrypted envelope to its
 * correlation key — a relay operator cannot swap one approval's ciphertext
 * into another approval's message slot without breaking the Poly1305 auth tag.
 *
 * Key derivation
 * ──────────────
 * The approval session key MUST be derived with a distinct HKDF info string
 * (`APPROVAL_KEY_INFO = "webchannel-approval-v1"`) from the conversation key
 * (`"webchannel-conversation-v1"`) so the two keys are cryptographically
 * independent even when derived from the same ECDH shared secret.
 *
 *   const rawSecret   = deriveSharedSecret(myPriv, theirPub);
 *   const approvalKey = hkdfSha256(rawSecret, null, APPROVAL_KEY_INFO, 32);
 *
 * Encrypt-before-publish pattern
 * ───────────────────────────────
 *   // Agent — send approval request:
 *   const env = encryptApprovalRequest(routing, requestBody, approvalKey);
 *   natsTransport.publish(subject, serializeApprovalEnvelope(env));
 *
 * Decrypt-on-receive pattern
 * ──────────────────────────
 *   // Browser — receive and render approval widget:
 *   const env  = deserializeApprovalEnvelope(rawNatsPayload);
 *   const body = decryptApprovalRequest(env, approvalKey);
 *   // body.title / body.options now available for rendering
 *
 * Zero-plaintext guarantee
 * ────────────────────────
 * The serialized envelope passed to NatsTransport.publish() contains ONLY:
 *   - Plaintext routing fields (accountId / tenant / sub / messageId /
 *     envelopeType / ts) — visible to the NATS relay operator for routing.
 *   - Encrypted content block (nonce / ciphertext / tag) — opaque to the relay.
 *
 * No approval payload field (title / prompt / options / decision / body)
 * appears in the NATS wire bytes.  The relay operator learns ONLY that an
 * approval message of type `approval_request|approval_decision|approval_resolved`
 * was exchanged for the given accountId/tenant/sub combination; the actual
 * content is sealed inside the ciphertext.
 */

import {
  encodeEnvelope,
  decryptEnvelopeContent,
  serializeEnvelope,
  deserializeEnvelope,
} from "./e2e-envelope.js";
import type { EnvelopeRouting, MessageEnvelope } from "./e2e-envelope.js";
import type { ApprovalRequestPayload, ApprovalDecision } from "./transport.js";

// ---------------------------------------------------------------------------
// HKDF info string for approval key derivation (domain-separated from chat)
// ---------------------------------------------------------------------------

/**
 * HKDF-SHA256 info string for deriving the approval session key.
 *
 * Use this as the `info` parameter to `hkdfSha256()` when deriving the
 * approval encryption key from the raw X25519 ECDH shared secret. This
 * ensures the approval key is cryptographically independent of the
 * conversation key (derived with "webchannel-conversation-v1").
 */
export const APPROVAL_KEY_INFO = "webchannel-approval-v1" as const;

// ---------------------------------------------------------------------------
// Approval payload types (wire / at-rest content — encrypted)
// ---------------------------------------------------------------------------

/**
 * The agent-to-browser approval request body that is JSON-serialized and
 * encrypted as the `content` block of an `approval_request` envelope.
 *
 * Mirrors `ApprovalRequestPayload` from transport.ts. Typed explicitly here
 * so this module has no dependency on the WebSocket transport layer.
 */
export type ApprovalRequestBody = ApprovalRequestPayload;

/**
 * The browser-to-agent approval decision body that is JSON-serialized and
 * encrypted as the `content` block of an `approval_decision` envelope.
 */
export type ApprovalDecisionBody = {
  readonly approvalId: string;
  readonly decision: ApprovalDecision;
};

/**
 * The agent-to-browser approval resolved body that is JSON-serialized and
 * encrypted as the `content` block of an `approval_resolved` envelope.
 */
export type ApprovalResolvedBody = {
  readonly approvalId: string;
  readonly decision: ApprovalDecision;
};

// ---------------------------------------------------------------------------
// Routing metadata type (omits envelopeType — set by the encrypt functions)
// ---------------------------------------------------------------------------

/** Routing fields provided by the caller; envelopeType is set automatically. */
export type ApprovalRouting = Omit<EnvelopeRouting, "envelopeType">;

// ---------------------------------------------------------------------------
// Internal: encode approval payload to AAD bytes
// ---------------------------------------------------------------------------

function toAad(approvalId: string): Uint8Array {
  return new TextEncoder().encode(approvalId);
}

function toPlaintext(body: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(body));
}

function fromPlaintext<T>(bytes: Uint8Array): T {
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}

// ---------------------------------------------------------------------------
// Encrypt helpers (plaintext → sealed MessageEnvelope)
// ---------------------------------------------------------------------------

/**
 * Encrypt an `ApprovalRequestBody` into a sealed `MessageEnvelope`.
 *
 * The `approvalId` (defaulting to `routing.messageId`) is used as AAD to
 * cryptographically bind the ciphertext to this specific approval correlation
 * key. A relay operator who observes the ciphertext cannot:
 *   - Read the title, prompt, options, expiresAtMs, or any other payload field.
 *   - Replay this envelope as a different approval (AAD mismatch would break
 *     the Poly1305 tag).
 *
 * @param routing    - Plaintext routing metadata (`envelopeType` is set to
 *                     `"approval_request"` automatically).
 * @param body       - The `ApprovalRequestBody` to encrypt (JSON-serialized).
 * @param key        - 32-byte approval session key derived via
 *                     `hkdfSha256(sharedSecret, null, APPROVAL_KEY_INFO, 32)`.
 * @param approvalId - AAD. Defaults to `routing.messageId`. Pass explicitly
 *                     when the approvalId differs from the messageId.
 * @returns A sealed `MessageEnvelope` ready for NATS publish.
 */
export function encryptApprovalRequest(
  routing: ApprovalRouting,
  body: ApprovalRequestBody,
  key: Uint8Array,
  approvalId?: string,
): MessageEnvelope {
  const id = approvalId ?? routing.messageId;
  const fullRouting: EnvelopeRouting = { ...routing, envelopeType: "approval_request" };
  return encodeEnvelope(fullRouting, toPlaintext(body), key, toAad(id));
}

/**
 * Encrypt an `ApprovalDecisionBody` into a sealed `MessageEnvelope`.
 *
 * The `decision` value ("allow-once" / "allow-always" / "deny") and the
 * `approvalId` correlation key are both encrypted — the relay operator sees
 * only `envelopeType: "approval_decision"` and the plaintext routing metadata;
 * it cannot learn what the user decided.
 *
 * @param routing    - Plaintext routing metadata (`envelopeType` is set to
 *                     `"approval_decision"` automatically).
 * @param body       - The `ApprovalDecisionBody` to encrypt (JSON-serialized).
 * @param key        - 32-byte approval session key.
 * @param approvalId - AAD. Defaults to `routing.messageId`.
 * @returns A sealed `MessageEnvelope` ready for NATS publish.
 */
export function encryptApprovalDecision(
  routing: ApprovalRouting,
  body: ApprovalDecisionBody,
  key: Uint8Array,
  approvalId?: string,
): MessageEnvelope {
  const id = approvalId ?? routing.messageId;
  const fullRouting: EnvelopeRouting = { ...routing, envelopeType: "approval_decision" };
  return encodeEnvelope(fullRouting, toPlaintext(body), key, toAad(id));
}

/**
 * Encrypt an `ApprovalResolvedBody` into a sealed `MessageEnvelope`.
 *
 * The resolved decision value is encrypted; the relay operator sees only the
 * `envelopeType: "approval_resolved"` discriminator and plaintext routing.
 *
 * @param routing    - Plaintext routing metadata (`envelopeType` is set to
 *                     `"approval_resolved"` automatically).
 * @param body       - The `ApprovalResolvedBody` to encrypt (JSON-serialized).
 * @param key        - 32-byte approval session key.
 * @param approvalId - AAD. Defaults to `routing.messageId`.
 * @returns A sealed `MessageEnvelope` ready for NATS publish.
 */
export function encryptApprovalResolved(
  routing: ApprovalRouting,
  body: ApprovalResolvedBody,
  key: Uint8Array,
  approvalId?: string,
): MessageEnvelope {
  const id = approvalId ?? routing.messageId;
  const fullRouting: EnvelopeRouting = { ...routing, envelopeType: "approval_resolved" };
  return encodeEnvelope(fullRouting, toPlaintext(body), key, toAad(id));
}

// ---------------------------------------------------------------------------
// Decrypt helpers (sealed MessageEnvelope → typed plaintext body)
// ---------------------------------------------------------------------------

/**
 * Decrypt an `approval_request` envelope and parse the `ApprovalRequestBody`.
 *
 * @param env        - A sealed `MessageEnvelope` (from `deserializeApprovalEnvelope`).
 * @param key        - 32-byte approval session key (same as used to encrypt).
 * @param approvalId - AAD (must exactly match what was used during encryption).
 *                     Defaults to `env.messageId`.
 * @returns Parsed `ApprovalRequestBody`.
 * @throws if the Poly1305 authentication tag fails (wrong key, tampered
 *         ciphertext/tag, or AAD mismatch) or if JSON parsing fails.
 */
export function decryptApprovalRequest(
  env: MessageEnvelope,
  key: Uint8Array,
  approvalId?: string,
): ApprovalRequestBody {
  const id = approvalId ?? env.messageId;
  const plaintext = decryptEnvelopeContent(env, key, toAad(id));
  return fromPlaintext<ApprovalRequestBody>(plaintext);
}

/**
 * Decrypt an `approval_decision` envelope and parse the `ApprovalDecisionBody`.
 *
 * @param env        - A sealed `MessageEnvelope`.
 * @param key        - 32-byte approval session key.
 * @param approvalId - AAD. Defaults to `env.messageId`.
 * @returns Parsed `ApprovalDecisionBody`.
 * @throws on authentication failure or JSON parse error.
 */
export function decryptApprovalDecision(
  env: MessageEnvelope,
  key: Uint8Array,
  approvalId?: string,
): ApprovalDecisionBody {
  const id = approvalId ?? env.messageId;
  const plaintext = decryptEnvelopeContent(env, key, toAad(id));
  return fromPlaintext<ApprovalDecisionBody>(plaintext);
}

/**
 * Decrypt an `approval_resolved` envelope and parse the `ApprovalResolvedBody`.
 *
 * @param env        - A sealed `MessageEnvelope`.
 * @param key        - 32-byte approval session key.
 * @param approvalId - AAD. Defaults to `env.messageId`.
 * @returns Parsed `ApprovalResolvedBody`.
 * @throws on authentication failure or JSON parse error.
 */
export function decryptApprovalResolved(
  env: MessageEnvelope,
  key: Uint8Array,
  approvalId?: string,
): ApprovalResolvedBody {
  const id = approvalId ?? env.messageId;
  const plaintext = decryptEnvelopeContent(env, key, toAad(id));
  return fromPlaintext<ApprovalResolvedBody>(plaintext);
}

// ---------------------------------------------------------------------------
// Serialize / deserialize helpers (NATS wire format)
// ---------------------------------------------------------------------------

/**
 * Serialize a sealed approval envelope to a UTF-8 JSON Buffer for NATS publish.
 *
 * Thin wrapper over `serializeEnvelope` — provided here so callers need only
 * import from this module for the full encrypt-then-publish pipeline.
 */
export { serializeEnvelope as serializeApprovalEnvelope };

/**
 * Deserialize a NATS MSG payload into a `MessageEnvelope`.
 *
 * Thin wrapper over `deserializeEnvelope` — call this on the raw NATS payload
 * before passing the envelope to a `decryptApproval*` function.
 */
export { deserializeEnvelope as deserializeApprovalEnvelope };
