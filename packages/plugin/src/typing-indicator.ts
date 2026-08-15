/**
 * TypingIndicator — ephemeral client↔client signals over NATS-WebSocket.
 *
 * Sub-AC 2: Implement typing indicators as ephemeral client↔client signals
 * on the NATS-WebSocket transport that are explicitly excluded from message
 * persistence and replay.
 *
 * NOT WIRED IN PRODUCTION. All four exports here — `TYPING_ENVELOPE_TYPE`,
 * `isEphemeralEnvelope`, `sendTypingSignal`, `persistIfNotEphemeral` — have
 * zero references outside this file and its test. The typing frame that
 * actually ships is `NatsChannel.sendTyping` / `setTypingEnabled` in
 * `nats-channel.ts`, which does not go through this module. Everything below
 * describes the Phase 6 Sub-AC 2 design paired with `history-store.ts`; that
 * pairing was never connected, so read it as a design record, not as the
 * behaviour of the running channel.
 *
 * Design
 * ──────
 * Typing signals use the existing `MessageEnvelope` wire format with
 * `envelopeType === "typing"`.  They transit over the same E2E-encrypted NATS
 * bus as conversation messages (content is ciphertext — relay operator cannot
 * read it), but are NEVER written to the HistoryStore.
 *
 * The single choke-point for persistence exclusion is `persistIfNotEphemeral`:
 *   - Typing envelopes: forwarded to live listeners, skipped on store.append().
 *   - All other envelopes: forwarded AND appended to the HistoryStore.
 *
 * This means:
 *   1. A typing signal fired while a peer is connected IS delivered live.
 *   2. A typing signal is NEVER present in `loadHistory` output.
 *   3. A typing signal is NEVER replayed to a late-joining device.
 *
 * Persistence invariant (testable)
 * ──────────────────────────────────
 *   After N typing signals are sent and received:
 *     store.size(conv) === 0       // zero typing envelopes persisted
 *     store.loadHistory(conv, null, 100).envelopes.length === 0
 *
 * Security
 * ────────
 * Typing signals are encrypted like any other envelope (ChaCha20-Poly1305 via
 * CryptoNatsChannel).  The relay operator sees only ciphertext and the plaintext
 * routing metadata (`envelopeType: "typing"`, subject, accountId/tenant/sub).
 * Content (`{ typing: true }`) is not observable without the session key.
 *
 * Deferred
 * ────────
 * Rate-limiting / debouncing of typing signals is a UI concern deferred to the
 * client integration layer.  This module only provides the transport primitives.
 */

import { randomBytes } from "node:crypto";

import type { CryptoNatsChannel } from "./crypto-nats-channel.js";
import type { HistoryStore, ConversationId } from "./history-store.js";
import type { MessageEnvelope } from "./e2e-envelope.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * The envelope type discriminator for typing signals.
 *
 * Envelopes with this `envelopeType` are ephemeral: they are delivered live
 * over NATS but MUST NOT be appended to the HistoryStore.  This constant is
 * the single source of truth for the ephemeral-vs-persistent boundary.
 */
export const TYPING_ENVELOPE_TYPE = "typing" as const;

// ---------------------------------------------------------------------------
// Ephemeral envelope predicate
// ---------------------------------------------------------------------------

/**
 * Returns `true` if `envelope` is an ephemeral signal that MUST NOT be
 * persisted to the HistoryStore or included in history replay.
 *
 * Currently, only `typing` envelopes are ephemeral.  Any future ephemeral
 * signal type (e.g. presence pings) should be added here so the persistence
 * filter automatically excludes them without caller-side type-switching.
 *
 * @param envelope - Any `MessageEnvelope` (deserialized from the NATS wire).
 * @returns `true` if the envelope should NOT be stored; `false` otherwise.
 */
export function isEphemeralEnvelope(envelope: MessageEnvelope): boolean {
  return envelope.envelopeType === TYPING_ENVELOPE_TYPE;
}

// ---------------------------------------------------------------------------
// Send a typing signal
// ---------------------------------------------------------------------------

/**
 * Publish an ephemeral typing signal to a NATS subject via the E2E-encrypted
 * `CryptoNatsChannel`.
 *
 * The signal is delivered live to all currently-subscribed peers. Because
 * `envelopeType === "typing"`, any caller using `persistIfNotEphemeral` will
 * automatically skip appending it to the HistoryStore.
 *
 * The payload is `{ typing: true }` when the user is actively typing, or
 * `{ typing: false }` when they have stopped (e.g. deleted their draft).
 *
 * @param channel   - A connected `CryptoNatsChannel` (auto-encrypts the payload).
 * @param subject   - NATS typing subject, e.g. `"chat.<tenant>.<accountId>.<sub>.typing"`.
 * @param typing    - `true` = user is typing; `false` = user stopped typing.
 * @param messageId - Optional stable message ID (defaults to random 8-byte hex).
 *                    Callers that need dedup or idempotency may supply a fixed id.
 */
export function sendTypingSignal(
  channel: CryptoNatsChannel,
  subject: string,
  typing: boolean,
  messageId?: string,
): void {
  const payload = JSON.stringify({ typing });
  channel.sendMessage(subject, payload, {
    envelopeType: TYPING_ENVELOPE_TYPE,
    messageId: messageId ?? randomBytes(8).toString("hex"),
  });
}

// ---------------------------------------------------------------------------
// Persistence filter — the single choke-point for ephemeral exclusion
// ---------------------------------------------------------------------------

/**
 * Append an envelope to the `HistoryStore` ONLY if it is not ephemeral.
 *
 * This was the intended integration point for inbound message handlers on the
 * agent side: wire it into the `'message'` event callback so that ephemeral
 * envelopes (typing signals, future presence pings) are silently excluded from
 * storage without requiring caller-side type checks. **No caller ever wired
 * it**, and the store it appends to (`HistoryStore`) is in-memory and equally
 * unwired — so the invariant below is proven by the test suite, not by the
 * running agent.
 *
 * Example wiring:
 *
 *   ```ts
 *   channel.on('message', ({ envelope }) => {
 *     persistIfNotEphemeral(store, conv, envelope);
 *     // ... further processing (render, approval dispatch, etc.)
 *   });
 *   ```
 *
 * Invariant: after any sequence of calls, `store` will contain ZERO envelopes
 * whose `envelopeType === "typing"`.
 *
 * @param store    - An in-memory `HistoryStore` instance (tests only today).
 * @param conv     - Conversation identifier (accountId + tenant + sub).
 * @param envelope - The raw `MessageEnvelope` (always ciphertext; never plaintext).
 */
export function persistIfNotEphemeral(
  store: HistoryStore,
  conv: ConversationId,
  envelope: MessageEnvelope,
): void {
  if (!isEphemeralEnvelope(envelope)) {
    store.append(conv, envelope);
  }
}
