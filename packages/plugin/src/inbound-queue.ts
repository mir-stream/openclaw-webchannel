/**
 * Per-session FIFO serialization for inbound user messages.
 *
 * WHY THIS EXISTS
 * ---------------
 * The transport's `onMessage` callback is fire-and-forget: every inbound
 * `user_message` frame immediately kicks off a `handleInboundMessage` →
 * `channelRuntime.inbound.run` turn (see index.ts / inbound.ts). If a user
 * sends two messages back-to-back on the SAME socket, two such turns would run
 * CONCURRENTLY for the same `sessionKey`.
 *
 * OpenClaw core does not tolerate that. Its per-session reply-operation
 * admission gate (`admitReplyTurn`, dispatch-DO0Fpkbp.js) assumes the channel
 * serializes its OWN inbound — that one session never has two turns in flight
 * at once. The bundled Telegram channel satisfies this implicitly: its
 * long-poll offset spool only ever hands the runtime one update at a time, so
 * a turn fully settles before the next is fetched. We have no such natural
 * spool — a WebSocket delivers frames as fast as the client sends them — so two
 * same-session turns collide on that gate and the channel wedges (a "working"
 * progress bubble that never settles).
 *
 * The fix is to give each `sessionKey` its own promise-chain FIFO queue: a new
 * message chains onto the tail of its session's chain and only starts once the
 * previous turn for that session has settled. DIFFERENT sessions keep their own
 * independent chains, so distinct users still run fully in parallel — we only
 * serialize WITHIN a session, matching the one-turn-at-a-time invariant core
 * expects.
 */

/**
 * A per-session serializing dispatcher.
 *
 * `dispatch` has the same fire-and-forget shape the transport's
 * `setMessageHandler` expects, but internally enqueues each call onto a
 * promise chain keyed by `sessionKey`, so same-session calls run strictly in
 * order, one at a time.
 *
 * `pendingSessions` is a minimal introspection accessor for tests and
 * diagnostics ONLY — it reports how many sessions currently have an
 * undrained chain entry. Production code must not depend on it; it exists so
 * the drain/cleanup invariant (the map returns to 0 once a session fully
 * drains) is observable and testable.
 */
export interface SerializedInboundDispatcher<Message> {
  dispatch: (sessionKey: string, message: Message) => void;
  /** Permanently reject new work and discard every queued follow-up. */
  close: () => void;
  /** Test/diagnostics only: number of sessions with a live (undrained) chain. */
  pendingSessions: () => number;
  /**
   * P1-8b: drop a session's busy-time coalesce buffer, returning how many
   * pending (not-yet-run) messages were discarded. Used by the `/stop` control
   * lane — a user who aborts wants the text queued behind the running turn gone
   * too. Returns 0 when the dispatcher has no `coalesce` (no buffer exists) or
   * the session has nothing buffered.
   */
  clearPending: (sessionKey: string) => number;
  /**
   * Test/diagnostics only: number of messages currently sitting in a session's
   * coalesce buffer (arrived while its turn was running, not yet merged/run).
   * Always 0 for a dispatcher built without `coalesce`.
   */
  pendingBuffered: (sessionKey: string) => number;
}

/** The inbound frame shape the coalesce merge understands. */
export type UserMessageLike = { type: "user_message"; text: string; id?: string };

/**
 * Merge several buffered `user_message` frames into ONE turn's message.
 *
 * P1-8b coalesce (Telegram parity): when a user fires several messages faster
 * than a turn can run, we run a single turn over their concatenation rather than
 * one turn each. Texts are joined with a blank line (`"\n\n"`) so the agent sees
 * them as distinct paragraphs of one prompt, in arrival order.
 *
 * Non-text fields of the FIRST frame are preserved (spread) EXCEPT `id`, which is
 * taken from the LAST frame: since the turn-correlated reasoning lane, the
 * coalesced message's `id` becomes the turn's `turnId` (inbound.ts), and the
 * widget anchors reasoning and its typing-text suppression to the LATEST user
 * bubble. Carrying the first id would anchor the turn to the earlier bubble and
 * the widget would miss. Ingress dedupe/ack run per-message BEFORE coalescing
 * (src/ingress-dedupe.ts iterates `items` before this merge), so no dedupe
 * consumer depends on the merged id. A single message is returned as-is
 * (identity), so the no-burst path is a pure pass through. Callers only ever pass
 * a non-empty array (a flush batch / a drained buffer); an empty array is a
 * contract violation and returns `undefined`.
 */
export function coalesceUserMessages<M extends UserMessageLike>(
  messages: readonly M[],
): M {
  const first = messages[0];
  if (messages.length <= 1) return first;
  const text = messages.map((m) => m.text).join("\n\n");
  return { ...first, id: messages[messages.length - 1].id, text };
}

/**
 * Build a per-session serializing dispatcher around `handler`.
 *
 * @param handler Runs one inbound turn. It is expected to settle (resolve or
 *   reject) when the turn is fully done; the NEXT same-session message waits on
 *   that settlement. `handleInboundMessage` already catches its own errors
 *   internally, but we defend against rejection — AND synchronous throws — here
 *   too (a poisoned link must never block the rest of the chain or leak its map
 *   entry; see below).
 */
export function createSerializedInboundDispatcher<Message>(
  handler: (sessionKey: string, message: Message) => Promise<void>,
  options?: {
    /**
     * P1-8b busy-time coalesce (Telegram parity). When provided, a message that
     * arrives while its session already has a turn RUNNING is NOT chained as a
     * second turn — it is buffered. When the running turn settles, the ENTIRE
     * buffer is drained, merged via this function, and run as ONE follow-up turn
     * (which itself becomes the new running turn, so messages arriving during IT
     * buffer again). When omitted, behavior is exactly the legacy per-session
     * FIFO below (one queued turn per message).
     */
    coalesce?: (messages: Message[]) => Message;
  },
): SerializedInboundDispatcher<Message> {
  const coalesce = options?.coalesce;
  let closed = false;

  // sessionKey -> tail of that session's promise chain. The value is the
  // promise for the LAST-enqueued turn; the next message chains off it. Entries
  // are removed when a session's chain fully drains (see cleanup below) so this
  // map does not grow without bound as transient sessions come and go.
  //
  // Used ONLY on the legacy (no-`coalesce`) path. The coalesce path uses
  // `running` + `pending` below instead; the two paths are mutually exclusive
  // for the life of a dispatcher, so at most one of these structures is ever
  // populated.
  const chains = new Map<string, Promise<unknown>>();

  // --- Coalesce path state (P1-8b) -----------------------------------------
  // `running`: sessionKey -> the settled-promise of the turn currently in
  //   flight for that session. Presence == BUSY. Unlike `chains`, we never queue
  //   a SECOND turn behind it — at most one turn runs per session at a time; the
  //   rest wait in `pending`.
  // `pending`: sessionKey -> messages that arrived while the session was busy,
  //   in arrival order. Drained (merged into one follow-up turn) when the
  //   running turn settles. Kept as full Message objects because later phases
  //   (P0-7 dedupe, P1-9 retraction) will reuse this buffer.
  const running = new Map<string, Promise<unknown>>();
  const pending = new Map<string, Message[]>();

  // Start a fresh turn for `message` as the session's running turn, and wire its
  // settlement to drain the coalesce buffer (or go idle). Recurses to run the
  // merged follow-up turn, so messages that arrived during THIS turn are handled
  // as a single next turn. Mirrors the legacy path's poisoned-link defenses:
  // the handler is invoked inside `Promise.resolve().then(...)` so a SYNCHRONOUS
  // throw is funneled into the rejection path, and `.catch(() => {})` makes the
  // stored promise non-rejecting so the drain/cleanup ALWAYS runs (a failed turn
  // must not wedge the session or strand its buffer).
  const startCoalesceTurn = (sessionKey: string, message: Message) => {
    if (closed) return;
    const settled = Promise.resolve()
      .then(() => closed ? undefined : handler(sessionKey, message))
      .catch(() => {});
    running.set(sessionKey, settled);

    void settled.then(() => {
      if (closed) {
        if (running.get(sessionKey) === settled) running.delete(sessionKey);
        pending.delete(sessionKey);
        return;
      }
      // Identity guard, matching the legacy cleanup: only this turn's own
      // settlement may advance the session. (Nothing else overwrites `running`
      // for a live session — dispatch only appends to `pending` while busy — but
      // keep the guard defensive.)
      if (running.get(sessionKey) !== settled) return;
      const buffered = pending.get(sessionKey);
      if (buffered && buffered.length > 0) {
        pending.delete(sessionKey);
        // Recurse: the merged follow-up becomes the new running turn. Messages
        // that arrive during it will buffer against THIS same session again.
        startCoalesceTurn(sessionKey, coalesce!(buffered));
      } else {
        running.delete(sessionKey);
      }
    });
  };

  const dispatchCoalesced = (sessionKey: string, message: Message) => {
    if (closed) return;
    if (running.has(sessionKey)) {
      // Busy: buffer instead of chaining a second turn. `startCoalesceTurn` sets
      // `running` synchronously, so a same-tick burst reliably lands here.
      const buf = pending.get(sessionKey);
      if (buf) buf.push(message);
      else pending.set(sessionKey, [message]);
      return;
    }
    startCoalesceTurn(sessionKey, message);
  };

  const dispatchLegacy = (sessionKey: string, message: Message) => {
    if (closed) return;
    // Chain off whatever is currently queued for this session (or a resolved
    // promise if the session is idle). We attach via `.then` with NO rejection
    // handler on `previous` itself — instead the previous link is made
    // non-rejecting before being stored (see `settled` below), so a failed turn
    // never blocks the ones queued behind it. Defensive even though
    // `handleInboundMessage` already swallows its own errors.
    const previous = chains.get(sessionKey) ?? Promise.resolve();

    // `settled` resolves when THIS turn is fully done, success or failure. We
    // store this (not the raw handler promise) as the new tail so the next
    // message waits for completion regardless of outcome, and the chain never
    // carries a rejection forward.
    //
    // We invoke `handler` inside `Promise.resolve().then(...)` so that even a
    // SYNCHRONOUS throw (a non-async handler that throws before returning a
    // promise) is funneled into the promise's rejection path rather than
    // escaping the `previous.then()` callback. Without this, a sync throw would
    // reject `settled` directly — permanently poisoning the chain tail (wedging
    // every later same-session turn) AND skipping the success-only cleanup
    // below (leaking the map entry). The trailing `.catch(() => {})` then
    // swallows both async rejections and the funneled sync throw: a single
    // failed turn must not wedge the session's queue. The handler is responsible
    // for its own user-facing error recovery (inbound.ts finalizes the working
    // bubble on failure).
    const settled = previous.then(() =>
      closed ? undefined : Promise.resolve()
        .then(() => closed ? undefined : handler(sessionKey, message))
        .catch(() => {}),
    );

    chains.set(sessionKey, settled);

    // Drain cleanup: once THIS turn settles, drop the map entry IF it is still
    // the tail — i.e. no newer message has replaced it in the meantime. Without
    // the identity check we would race-delete an entry a later message already
    // overwrote, orphaning that message's chain and losing serialization.
    // Because `settled` is non-rejecting (see above), this cleanup runs for
    // EVERY turn, including ones whose handler threw synchronously.
    void settled.then(() => {
      if (chains.get(sessionKey) === settled) {
        chains.delete(sessionKey);
      }
    });
  };

  const dispatch = coalesce ? dispatchCoalesced : dispatchLegacy;

  return {
    dispatch,
    close: () => {
      if (closed) return;
      closed = true;
      chains.clear();
      pending.clear();
      running.clear();
    },
    // Only one of the two structures is ever populated for a given dispatcher
    // (coalesce is fixed at construction), so summing is correct for both paths:
    // legacy counts live chains; coalesce counts running turns.
    pendingSessions: () => chains.size + running.size,
    clearPending: (sessionKey: string) => {
      const buf = pending.get(sessionKey);
      if (!buf) return 0;
      pending.delete(sessionKey);
      return buf.length;
    },
    pendingBuffered: (sessionKey: string) => pending.get(sessionKey)?.length ?? 0,
  };
}
