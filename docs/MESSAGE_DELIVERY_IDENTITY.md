# Answer and reasoning delivery identity

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

## Reasoning accumulator boundaries (#373)

`onAssistantMessageStart` is wired whenever reasoning is enabled, including off,
block, and progress answer-streaming modes. Native live updates consume this
boundary before replacing text, closing any prior accepted preview and clearing
the previous message's raw accumulator. `onReasoningEnd` closes only a burst;
it does not itself mean the producer reset its accumulator. Thus `Check the file.`
followed by either the same text or `Check the file. Then run tests.` in another
assistant message is delivered whole under a separate ID.

| Producer path | Actual callback contract | Controller behavior |
| --- | --- | --- |
| Embedded | Message-start resets state; live reasoning is unmarked text. Full partial thinking can accumulate over thinking blocks within that message. | Reset at message-start; subtract already closed cumulative text only within that message. |
| Btw | One assistant-start per attempt, `reasoningText += delta`, an end callback at each thinking-end. | Preserve its cumulative baseline across burst closes until a new message/run. |
| Codex app-server | `isReasoningSnapshot: true` aggregates reasoning items; its answer-start can occur after initial reasoning; reasoning-end fires once at turn completion. | Full snapshots keep the live ID across the answer-start callback. Never strip a prefix from a marked snapshot. |
| CLI bridge | Forwards marked thinking snapshots; emits the last snapshot again as a durable `isReasoning:true` result, without an assistant-start or reasoning-end callback between them. | An exact accepted open marked snapshot can be closed on its own ID by that replay. A later equal durable block gets a new ID. |

These are payload forms and real callback boundaries, not a guessed provider
identity. A new `onAgentRunStart(runId)` resets either accumulator; repeat
notification for the same run is inert. A complete durable block cannot inherit
replay ownership across a pending message boundary, and equality with an unmarked
live update is insufficient for CLI replay suppression. `requiresReasoningProgressOptIn`
is not used as a source discriminator: native non-stream reasoning can carry it too.

Source evidence at the same verified checkout:

- Embedded [message-start/reset](https://github.com/openclaw/openclaw/blob/0790d9f593ad30c940ed93b5872a8cf6d6f3cf8c/src/agents/embedded-agent-subscribe.handlers.messages.ts#L638),
  [reasoning extraction/end](https://github.com/openclaw/openclaw/blob/0790d9f593ad30c940ed93b5872a8cf6d6f3cf8c/src/agents/embedded-agent-subscribe.handlers.messages.ts#L726),
  and [live callback payload](https://github.com/openclaw/openclaw/blob/0790d9f593ad30c940ed93b5872a8cf6d6f3cf8c/src/agents/embedded-agent-subscribe.ts#L1209).
- [Btw accumulation and callbacks](https://github.com/openclaw/openclaw/blob/0790d9f593ad30c940ed93b5872a8cf6d6f3cf8c/src/agents/btw.ts#L853).
- Codex [answer-start](https://github.com/openclaw/openclaw/blob/0790d9f593ad30c940ed93b5872a8cf6d6f3cf8c/extensions/codex/src/app-server/event-projector.ts#L941),
  [marked cumulative snapshot](https://github.com/openclaw/openclaw/blob/0790d9f593ad30c940ed93b5872a8cf6d6f3cf8c/extensions/codex/src/app-server/event-projector.ts#L1018),
  and [one end callback](https://github.com/openclaw/openclaw/blob/0790d9f593ad30c940ed93b5872a8cf6d6f3cf8c/extensions/codex/src/app-server/event-projector.ts#L1615).
- CLI [snapshot production](https://github.com/openclaw/openclaw/blob/0790d9f593ad30c940ed93b5872a8cf6d6f3cf8c/src/agents/cli-output.ts#L888)
  and [live/result bridge](https://github.com/openclaw/openclaw/blob/0790d9f593ad30c940ed93b5872a8cf6d6f3cf8c/src/auto-reply/reply/agent-runner-cli-dispatch.ts#L526).
- The separately named ACP dispatch route uses
  [an ACP projector](https://github.com/openclaw/openclaw/blob/0790d9f593ad30c940ed93b5872a8cf6d6f3cf8c/src/auto-reply/reply/dispatch-acp.ts#L517)
  that [filters non-output thought deltas](https://github.com/openclaw/openclaw/blob/0790d9f593ad30c940ed93b5872a8cf6d6f3cf8c/src/auto-reply/reply/acp-projector.ts#L438).
  It does not supply this live reasoning callback. Older descriptions calling the
  Codex snapshot producer an “ACP runner” should not be used to infer another contract.

The new public inbound tests fail on the pre-#373 implementation in all four
streaming modes: the longer second message becomes `Then run tests.` and the
equal next message disappears. Controller and inbound fixtures cover native,
btw, Codex snapshots, CLI durable replay, empty/missing ends, repeated runs,
and independent equal durable blocks. Real SQLite tests verify repeated text and
IDs through close failures, stop retries, the client reducer, and journal history.
The older CLI fixtures now include the snapshot marker the actual producer sends;
the old unmarked raw-equality fixture now requires independent durable delivery.

Reasoning previews remain ephemeral; a close authors only the last accepted
preview, and `reasoningDurable` still controls whether the close is journaled.
No reasoning placement/order redesign (#353), event change, history merge change,
or hidden core import is included. The pinned public `GetReplyOptions` contract
compile-checks the callback wiring. Producer changes should be checked against
these boundaries and markers, rather than inferred from overlapping text.
