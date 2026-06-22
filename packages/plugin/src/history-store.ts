/**
 * HistoryStore — at-rest authority store for E2E ciphertext history envelopes.
 *
 * Sub-AC 2a: load_history cursor-pagination.
 *
 * The agent is the single authority for conversation and approval history.
 * Inbound messages are stored as opaque `MessageEnvelope` ciphertext blobs;
 * the store never sees or stores plaintext content. Decryption keys remain
 * exclusively with the communicating parties (browser devices + agent).
 *
 * Storage model
 * ─────────────
 * Envelopes are stored per-conversation in insertion order (append-only).
 * A conversation is identified by the triple (agentId, tenant, sub):
 *   - agentId — SaaS-issued agent identity.
 *   - tenant  — Tenant scope (NATS account boundary).
 *   - sub     — JWT sub claim (stable per-user identity across devices).
 *
 * Pagination model (forward cursor, oldest-first)
 * ────────────────────────────────────────────────
 * `load_history` returns pages of envelopes in insertion order (oldest first),
 * which is the natural order for backlog replay to a late-joining device:
 *
 *   // Replay the full backlog in order:
 *   let cursor: string | null = null;
 *   do {
 *     const page = store.loadHistory(conv, cursor, PAGE_SIZE);
 *     for (const env of page.envelopes) replayToDevice(env);
 *     cursor = page.nextCursor;
 *   } while (cursor !== null);
 *
 * Cursor semantics:
 *   - `before = null`        → first page: the oldest `limit` envelopes.
 *   - `before = messageId`   → next page: the `limit` envelopes stored AFTER
 *                               the one identified by `messageId`.
 *   - returned `nextCursor`  → the `messageId` of the LAST envelope in the
 *                               current page; pass as `before` next call.
 *                               `null` when all envelopes have been returned.
 *
 * The parameter is named `before` per the seed specification; semantically it
 * identifies the boundary BEFORE which the store was already returned (i.e., the
 * last-seen cursor), not a temporal "before" filter.
 *
 * Zero-plaintext guarantee
 * ─────────────────────────
 * The store holds only `MessageEnvelope` objects whose `content` block is always
 * E2E ciphertext (nonce + ciphertext + tag). No plaintext content is ever stored,
 * retrieved, or logged by this module.
 *
 * Deferred: persistence (this implementation is in-process only).
 * Deferred: key rotation / revocation rekey of stored envelopes.
 */

import type { MessageEnvelope } from "./e2e-envelope.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Identifies a conversation stored in the HistoryStore.
 *
 * The triple (agentId, tenant, sub) uniquely scopes a conversation:
 *   - agentId: SaaS-issued agent identity (from JWT agentId claim).
 *   - tenant:  Tenant scope (from JWT tenant claim; NATS account boundary).
 *   - sub:     Stable per-user JWT sub claim (multi-device invariant).
 */
export type ConversationId = {
  readonly agentId: string;
  readonly tenant: string;
  readonly sub: string;
};

/**
 * A single page of ciphertext envelopes returned by `loadHistory`.
 */
export type HistoryPage = {
  /**
   * Ordered ciphertext envelopes for this page (insertion order, oldest-first).
   * Empty array when the conversation has no more envelopes past the cursor.
   */
  readonly envelopes: readonly MessageEnvelope[];
  /**
   * Cursor for the next `loadHistory` call. Pass this value as `before` to
   * retrieve the next page.  `null` when all envelopes have been returned
   * (the store is exhausted for this conversation).
   */
  readonly nextCursor: string | null;
};

// ---------------------------------------------------------------------------
// HistoryStore
// ---------------------------------------------------------------------------

/**
 * In-process authority store for E2E ciphertext `MessageEnvelope` history.
 *
 * Implements append-only insertion and forward-cursor pagination via
 * `loadHistory(conv, before, limit)` for backlog replay.
 *
 * Thread-safety: this is a single-process, synchronous store. Node.js's
 * single-threaded event loop guarantees mutual exclusion between async
 * operations without locks.
 */
export class HistoryStore {
  /**
   * Per-conversation envelope lists (insertion order, oldest-first).
   * Keys are derived from ConversationId via `#conversationKey()`.
   */
  readonly #store = new Map<string, MessageEnvelope[]>();

  // ---------------------------------------------------------------------------
  // Write path
  // ---------------------------------------------------------------------------

  /**
   * Append a ciphertext envelope to the conversation's history.
   *
   * Envelopes are stored in the order they are appended. The caller MUST
   * ensure `envelope.content` is a valid E2E ciphertext block (never plaintext).
   *
   * @param conv     - Conversation identifier (agentId + tenant + sub).
   * @param envelope - The `MessageEnvelope` to store. Content must be ciphertext.
   */
  append(conv: ConversationId, envelope: MessageEnvelope): void {
    const key = this.#conversationKey(conv);
    let list = this.#store.get(key);
    if (list === undefined) {
      list = [];
      this.#store.set(key, list);
    }
    list.push(envelope);
  }

  // ---------------------------------------------------------------------------
  // Read path (cursor-paginated)
  // ---------------------------------------------------------------------------

  /**
   * Load a page of ciphertext envelopes from the conversation history.
   *
   * Returns envelopes in insertion order (oldest-first), starting from the
   * position immediately after the cursor (`before`). This supports forward
   * pagination for full backlog replay in chronological order.
   *
   * @param conv   - Conversation to query (agentId + tenant + sub).
   * @param before - Cursor from the previous page's `nextCursor`. Pass `null`
   *                 to start from the beginning (oldest envelopes first).
   *                 Pass the `nextCursor` from a previous `loadHistory` call
   *                 to retrieve the next page of envelopes.
   * @param limit  - Maximum number of envelopes to return. Must be ≥ 1.
   *                 Values ≤ 0 return an empty page.
   * @returns A `HistoryPage` containing ordered envelopes and the cursor for
   *          the next call. `nextCursor` is `null` when no more pages exist.
   */
  loadHistory(
    conv: ConversationId,
    before: string | null,
    limit: number,
  ): HistoryPage {
    // Defensive: non-positive limit → empty page (no error, per history.ts contract).
    if (limit <= 0) return { envelopes: [], nextCursor: null };

    const key = this.#conversationKey(conv);
    const all = this.#store.get(key) ?? [];

    if (all.length === 0) return { envelopes: [], nextCursor: null };

    // Determine the starting index.
    let startIndex: number;
    if (before === null) {
      // No cursor — start from the very beginning (oldest envelope).
      startIndex = 0;
    } else {
      // Locate the cursor envelope by messageId.
      const cursorIdx = all.findIndex((e) => e.messageId === before);
      if (cursorIdx === -1) {
        // Stale / unknown cursor — return empty page (safe fallback).
        // The caller should restart from null or treat this as exhausted.
        return { envelopes: [], nextCursor: null };
      }
      // Start from the envelope AFTER the cursor.
      startIndex = cursorIdx + 1;
    }

    if (startIndex >= all.length) {
      // Cursor was the very last envelope — store is exhausted.
      return { envelopes: [], nextCursor: null };
    }

    const endIndex = Math.min(startIndex + limit, all.length);
    const envelopes = all.slice(startIndex, endIndex);

    // nextCursor is the messageId of the LAST envelope in this page.
    // Pass it as `before` in the next call to get the following page.
    // null when we've reached the end of the store.
    const nextCursor = endIndex < all.length
      ? envelopes[envelopes.length - 1]!.messageId
      : null;

    return { envelopes, nextCursor };
  }

  // ---------------------------------------------------------------------------
  // Introspection (tests / monitoring)
  // ---------------------------------------------------------------------------

  /**
   * Return the total number of stored envelopes for a conversation.
   * Useful for monitoring and test assertions.
   */
  size(conv: ConversationId): number {
    return this.#store.get(this.#conversationKey(conv))?.length ?? 0;
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  /**
   * Derive a stable string key from a ConversationId.
   *
   * Uses NUL bytes as field separators to prevent collisions between fields
   * that might otherwise compose to the same string (e.g., agentId="a\0b",
   * tenant="c" vs agentId="a", tenant="b\0c").
   */
  #conversationKey(id: ConversationId): string {
    return `${id.agentId}\0${id.tenant}\0${id.sub}`;
  }
}
