# Answer delivery identity

The plugin owns both delivery and durable storage. An accepted draft keeps the ID
reserved by its delivery act. A boundary closes that draft with its own authored
text. The first ordinary final can complete the currently streamed draft on that
handle; consuming the handle makes later finals independent acts. Errors and
notices use the existing independent path.

When the current assistant message has no answer draft, turn-end finals cannot
reopen past drafts. Finals held behind visible predecessors are buffered only for
delivery timing. Each buffered act claims/mints its own ID through
`sendIndependent`; storage retries retain that reservation and exact payload.
The snapshot includes only accepted terminal draft content and leaves these
independent IDs intact. No event schema or client identity rule changes.

This replaces the old `streamed.length === finals.length` routing. Equal counts
cannot prove ownership: two independent messages stream A, a third acquires B
only at message-end, and a fourth ends without text. Core dispatch dedupes
`[A,A,B]` to `[A,B]`. Both A IDs now keep A, and final-only B has a separate ID.
The unclaimed final A also remains separately visible; its equality to past text
does not authorize merging or editing those messages. The same rule covers one
final, multiple finals, missing middle partials, and failed prior previews.

## Source contracts and deliberate differences

Verified checkout: OpenClaw `0790d9f593ad30c940ed93b5872a8cf6d6f3cf8c`.

- [Embedded message-end](https://github.com/openclaw/openclaw/blob/0790d9f593ad30c940ed93b5872a8cf6d6f3cf8c/src/agents/embedded-agent-subscribe.handlers.messages.ts#L1173)
  can emit final visible text through the assistant event without requesting the
  [partial callback](https://github.com/openclaw/openclaw/blob/0790d9f593ad30c940ed93b5872a8cf6d6f3cf8c/src/agents/embedded-agent-subscribe.ts#L285).
- [Answer payload construction](https://github.com/openclaw/openclaw/blob/0790d9f593ad30c940ed93b5872a8cf6d6f3cf8c/src/agents/embedded-agent-runner/run/payloads.ts#L820)
  prefers canonical last-message text when available, otherwise uses collected
  assistant text. The [dispatch loop](https://github.com/openclaw/openclaw/blob/0790d9f593ad30c940ed93b5872a8cf6d6f3cf8c/src/auto-reply/reply/dispatch-from-config.ts#L3910)
  filters and dedupes before delivery. It does not promise one final per draft.
- Telegram's [lane type](https://github.com/openclaw/openclaw/blob/0790d9f593ad30c940ed93b5872a8cf6d6f3cf8c/extensions/telegram/src/lane-delivery-text-deliverer.ts#L19)
  is answer/reasoning. It retains the platform
  [send/edit message ID](https://github.com/openclaw/openclaw/blob/0790d9f593ad30c940ed93b5872a8cf6d6f3cf8c/extensions/telegram/src/draft-stream.ts#L329),
  [rotates finalized streams](https://github.com/openclaw/openclaw/blob/0790d9f593ad30c940ed93b5872a8cf6d6f3cf8c/extensions/telegram/src/lane-delivery-text-deliverer.ts#L276),
  and [finalizes the current stream or sends a new message](https://github.com/openclaw/openclaw/blob/0790d9f593ad30c940ed93b5872a8cf6d6f3cf8c/extensions/telegram/src/lane-delivery-text-deliverer.ts#L548).

We preserve separately authored assistant drafts and also operate the server's
journal. Telegram's one-current-stream delivery cursor therefore does not justify
pairing an array of final payloads with our closed drafts. We can edit by server
ID, but the delivery act must own that handle first. Partial-only text rejected
before durable acceptance does not become a completed answer through a snapshot.

## Validation evidence

`durable-send.test.ts` reproduces #262 against the unchanged Round 2 base with real
SQLite and the production channel/controller: the second A snapshot ID incorrectly
contains B. It checks the corrected final frames, snapshot, journal projection,
and the client shared reducer. `inbound.test.ts` drives the same callback sequence
through `handleInboundMessage`, including successful turn completion.

These are controlled callback/transport fixtures. The source trace above
establishes reachability with partial mode and core block streaming off; the tests
do not measure provider frequency or claim a live Telegram reproduction. Existing
Round 2 storage tests retain same-ID recovery, the newly rejected snapshot after
buffered-output recovery, honest error state, and unfinished-preview protection.
Older M173/M212 fixtures now retain their full final text under independent IDs
instead of asserting the obsolete count-based assignment. M340b also verifies
that a defensive late partial cannot capture or erase an already buffered final.
