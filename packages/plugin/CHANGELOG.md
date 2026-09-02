# Changelog — openclaw-webchannel

## Unreleased

### Breaking (wire protocol v4)

- **`WEBCHANNEL_PROTOCOL_VERSION` goes 3 → 4 (#246).** The register gate is
  unchanged in shape — it was already exact-match and already ran before PoP and
  key establishment (`nats-register.ts`) — so this release adds no new gate. It
  changes the number the gate compares against, which is the whole enforcement:
  a browser declaring `3` now gets `{ error: "protocol_mismatch", code: 426,
  protocolVersion: 4 }` and never reaches key delivery, and a `4` plugin is
  refused by a `3` client for the mirror reason. Release the plugin, client, and
  SaaS packages together.

  **Why the v6 frames stopped being "additive and safely ignorable".** They are
  still safely ignorable for RENDERING; they are not for CORRECTNESS. The shipped
  `0.7.0` client also declares `3`, so before this bump it passed the gate and
  then ignored the per-conversation `seq` on durable frames and the
  `get_difference`/`difference` gap-sync (#244), the `user_committed` broadcast
  (#245), the `reasoning`/`tool`/`approval` `history` rows (#242), and
  `ack.committed[]` (#243). The `seq` case is the one that forces the bump:
  transport here is core NATS pub/sub, at-most-once with no retention, so a peer
  that cannot detect a hole never asks to heal one. What reaches it unasked — the
  history snapshot requested on every successful register, a `turn_snapshot` at
  the end of a streamed turn — is incidental, not a repair path: it rides the
  same at-most-once transport and nothing aims it at the hole.

  **#309 is closed by this.** An older client drops role-less `history` rows, so
  its cursor can never cite a reasoning id and "load older" stalls permanently
  once `capabilities.reasoningDurable` is on. #309 named exactly two fixes —
  withhold the row per peer, or refuse the connection — and this is the refusal.
  Its operator-side mitigation ("do not enable `reasoningDurable` while serving
  stale clients") is retired. The forbidden server-side repair is still
  forbidden: "every page must contain at least one role-bearing row" invents a
  supersession rule inside the projection, which is NOT-list N8. See
  `journal-history.ts`'s `historyPageBefore` docblock.

  **No capability negotiation was added.** Under an exact-match gate there is no
  peer to withhold a frame from, and the one shape that would need per-peer
  withholding — a live delete/edit frame — does not exist here:
  `messageDeleted`/`messageEdited` are durable event kinds with no producer. A
  carrier with zero consumers is an unexercised mechanism. The rule for the next
  slice is in `protocol.ts`'s "When to bump", which now carries v4 as its second
  worked example.

### Fixed

- **Approval frames are journaled at the moment the plugin records them, not at
  publish (#341, extends #304).** `approval_request`/`approval_resolved` were
  appended inside `sendToPeer`, below its disposed/transport-down/no-session-key
  refusals, so a refused prompt got no `approval` row while `deliverPending` had
  already written the pending record and the register-time `approval_snapshot`
  re-delivered the card live. The user decided, the `approvalResolution` row
  landed with no `approval` row to fold onto, and history showed neither (N8/N3).
  The append moved up to `NatsChannel.publishApprovalFrame`, which runs above the
  refusals and stamps the row's `seq` onto the frame it then publishes;
  `sendToPeer` skips those two types so no row is written twice, and
  `deliverPending` passes `{ redelivery }` so a re-armed card is not journaled
  again (approval rows carry no `message_id`, so nothing downstream would dedupe
  them — #355). The exception is scoped to these two frame types: an approval's
  state exists server-side whether or not the push lands and its id is core's,
  stable across attempts, neither of which holds for the reasoning residual
  (#304).

  **An account with no live channel has no journal either, and that state is
  TRANSIENT** — `nats-account-runtime.ts` deletes the runtime on stop and
  re-adds it on the next start, so an approval can be delivered with no channel
  and resolved (or expired) with one. Journaling the resolution there would
  reproduce the original orphan, so the invariant is stated as a producer rule
  and enforced at both legs: *a resolution row is journaled only once its request
  row exists.* `deliverPending` records on the pending entry whether the row was
  actually written (`sendApprovalRequest` now returns `{ delivered, journaled }`
  — a refused push journals, a swallowed append does not), and `updateEntry`
  hands the card's payload to `sendApprovalResolved` as `journalRequestFirst`
  when it is still owed. The channel writes the request row first and the
  resolution second; if the request row cannot be written, neither is. The rule
  and its one exception — a pending record already evicted, where the verdict is
  journaled alone and the reducer's no-op is the fallback — are stated once, at
  `approvals.ts`'s `updateEntry`; every other site points there rather than
  restating them.

  Two supporting changes fall out of that. `listPendingApprovalsForPeer` now
  WITHHOLDS an expired card from the snapshot instead of deleting its record —
  deletion is left to the cap and the abandonment backstop (which now covers both
  entry shapes, one grace period after a finalize was due) — because it runs for
  every registering peer and was routinely destroying the payload the expiry
  finalize still needed to write the card's row. And `requestJournaled` is now
  enforced as peer-scoped on the READ side as well as the write: the journal's
  conversation id is the peerId, so a row written for one peer does not satisfy
  another peer's resolution.

  **Disclosed N8-gaining direction.** The journal keeps a card forever while
  `approval_snapshot` replays only what is still pending, so a card created while
  the peer was disconnected, never pushed, and then EXPIRED before it returned is
  served by `projectJournalHistory` with the denial-equivalent verdict
  `buildExpiredResult` produced — history showing a decision live never showed.
  That is the Telegram-server model working as intended (the server created the
  service message and recorded its outcome; the device missed the window), and it
  is accepted knowingly rather than overlooked.

  The same applies to ORDER on the catch-up path: a card whose `approval` row is
  minted at resolution time takes a seq from that moment, so
  `projectJournalHistory` places it after anything delivered while it was open,
  where the client's `approval_snapshot` leg placed it at register time. Same
  card, later slot. Repairing it would mean reordering rows on a timestamp the
  store does not have — the server-side invention N8 forbids — so it is disclosed
  rather than fixed.

- **`ingress-dedupe.ts`'s accept seam treats the delivery journal as the dedupe
  authority (#344, extends #292).** `outcomeStore.record(…, "accepted")` persists
  through the SDK dedupe store at call time while `appendInboundUser` runs in the
  batch footer, so the durable order is marker-first, row-second and a crash
  between them stranded the message: the replay hit the `existing.status ===
  "found"` branch, was re-acked as a duplicate, and never reached the journal.
  The found/accepted branch now calls `lookupUserMessageIdByRandomId` and, when
  the row is missing, falls through to the fresh-accept path — one journal call
  site still, and `appendInboundUser`'s `journal_user_idempotency_once` guard
  keeps it idempotent. The order is deliberately NOT reversed: a row without a
  marker replays as a fresh admission and answers the same text twice.

- **The overflow resolver applies the same journal authority (#344).**
  `inbound-overflow-resolver.ts` is the second door onto a durable `accepted`
  marker — the path an id takes when its raw frame could not be retained — and it
  read the marker as a terminal accept. For a crash-window orphan (or any marker
  orphaned by §15.6's journal cutover) it ACKED, so the client drained its replay
  ledger and the message was lost permanently, which is worse than the accept
  seam's version of the same bug. It now takes an optional `lookupUserRow` dep
  and, when the journal has no row, publishes nothing at all: a resolver can only
  report a verdict, so withholding one leaves the ledger entry for the ordinary
  flush path to admit, journal and answer. It also carries the `committed` echo
  when a row does exist, which that arm never did.

- **…and so does the debouncer's known-outcome fast path (#344).** Withholding a
  verdict only preserves a replay if every reader withholds it.
  `outcomeStore.lookup()` warms the process hot cache on its found path (so does
  `write.commit()`), and `bounded-inbound-debouncer.ts`'s `peekOutcome`
  short-circuit reads that cache *before* charging retention — so the replay the
  resolver had just declined to answer was acked away there instead, and never
  reached `onFlush`, the journal, or the found branch. The short-circuit now
  fires only for a refusal: `onKnownOutcome` and the `known-outcome` push result
  are typed `IngressRefusal` (`Exclude<IngressOutcome, "accepted">`), so a
  fast-path decision on `accepted` no longer typechecks. The cost is a
  retention reservation plus one flush per genuine accepted replay; under full
  retention such replays overflow and drain about one per round instead of all
  at once (nothing is lost — the client re-drains later), on a path only a
  client without `random_id` reaches. This is now one rule with one statement —
  THE READER RULE, on `OutcomeLookup` in `ingress-outcome.ts`: the reader that
  can ADMIT a message is the only one that may answer an `accepted` outcome
  with no row; a reader that cannot admit may answer it only when the row exists.

- **The accept seam's journal question covers older clients too (#344).** The
  lookup is keyed by `randomId ?? wireId` — the dedupe key's body, which is
  exactly what `appendInboundUser` stores as `idempotency_key` — instead of
  `random_id` alone. A client that sends no idempotency token now has its
  crash-window message recovered like any other; it is simply acked bare, since a
  `committed` entry needs a `random_id` to key it by.

- **The dual-marker warning names the outcome that actually won (#344).**
  `createRateLimitedOutcomeInvariantWarning` accepted a message, discarded it,
  and emitted a hardcoded "overloaded wins". Harmless while `overloaded` was the
  only possible winner; with `cancelled` it told the operator the peer had been
  sent `inbound_rejected` when it had been silently acked. It now takes the
  winning outcome — a closed union, so the throttle keyspace stays three static
  entries — and builds the line itself, with one window per winner.

- **A faulted `cancelled` write fails closed (#344).** `record()`'s disk-error
  cleanup was gated on `overloaded`; it now covers both refusals. A memory-only
  suppression dies with the process, and its next replay would run the turn
  `/stop` killed. `accepted` deliberately keeps its memory-only receipt: losing
  that marker only re-admits, which the journal's idempotency collapses.

- **`/stop` suppression is its own terminal outcome (#344).** `IngressOutcome`
  gains `cancelled`, with its own `PersistentDedupe` namespace
  (`webchannel-inbound-cancelled`) and its own rung — above `overloaded`, above
  `accepted` — in the lookup precedence. The three suppression writers
  (`nats-account-runtime.ts`'s `onCancel`, `ingress-dedupe.ts`'s
  cancelled-inbound fallback, `inbound-overflow-resolver.ts`'s `recoverCancelled`)
  record it instead of borrowing `accepted`. They write no journal row on
  purpose, which is byte-identical to the crash window above, so without the split
  a cancelled message whose ack was lost would have been re-admitted and its
  aborted turn re-run. A `cancelled` replay is acked and dropped — never
  `inbound_rejected` and never re-admitted. It still carries the `committed` echo
  when a row happens to exist (a message journaled before the `/stop` landed).
  `record()`'s `replaceOpposite` option is renamed `replaceOthers` and now clears
  every other outcome's marker, which is what its fail-closed comment always
  described. **Upgrade note:** cancellations recorded by an earlier build remain
  in the `accepted` namespace for their 7-day TTL and are indistinguishable from a
  crash-window marker; one whose ack was also lost re-runs its turn once on the
  next replay.

- **A K>=2 count shortfall no longer routes buffered finals onto lanes (#340,
  extends #260).** `flushBufferedOrdinaryFinals` used to fall back to
  `materializedAnswerLanes()` when the finals and the streamed lanes disagreed in
  number; every landing there is non-authoritative, so `emitTurnSnapshot`
  republished the lane with its `streamedAnswerText` and destroyed the final —
  permanently, since #240 removed the core-transcript read that healed it on
  reload. `targets` is now empty in that case and each unpaired final goes out
  through `deliverTerminalIndependent` in order, matching the built-in Telegram
  channel: a final finalizes the one draft it provably owns or becomes a new
  message, never an edit of a past bubble.

## 0.7.0

### Added

- **The plugin is now the authoritative source of the live turn's answer order
  (#174, #215).** It has always known which assistant message produced which
  bubble; it had no way to say so, so the browser's transcript was decided by
  whatever order the wire happened to deliver. At the terminal drain — after
  `flushBufferedOrdinaryFinals`, before `turn_settled` — the channel now emits
  one additional frame:
  `{ type: "turn_snapshot", turnId, answers: Array<{ id, text }>, remove: string[] }`.
  - `answers` is every lane that streamed visible answer text, **in generation
    order**. `id` reuses the lane's materialized wire id, or a freshly minted id
    for a lane that streamed but whose frames never reached the wire — that
    minted entry is what *recovers* the #215 mid-lane, which previously rendered
    as a corrupted bubble. (Across a durable-history read the client turns that
    same mint into a duplicate instead — see the client-side known limitation
    below.)
  - `text` is the lane's new per-lane **`streamedAnswerText`**, captured at
    stream time and never overwritten by a final topping the lane up. That is
    what makes the snapshot immune to #215 final mis-routing: a final landing on
    the wrong lane can no longer corrupt what the snapshot reports. Where the
    routing is *provable* — the immediate collapse / current-lane-has-text /
    lone-message paths, and the buffered path when the finals map one-to-one
    onto materialized targets and every text-bearing message streamed
    (`answerTextIsAuthoritative`) — the snapshot carries the lane's full
    `answerText` instead, so a final's tail beyond the last partial is not
    dropped.
  - `remove` names only bubbles the plugin **can prove** duplicate an `answers`
    entry: an overflow final's independent bubble, and a recovery block for a
    lane already in `answers`. The two carry **independent** proofs — the
    overflow bubble is guarded by a turn-level invariant (a cardinality
    condition — every ordinary final being routed must have a streamed answer
    lane), the recovery block by its own lane having streamed visible text.
    Both rest on `streamedVisibleAnswerText`, the predicate `answers` itself
    filters on, so a marked bubble is provably represented there — as its
    *streamed* text. The one gap that leaves: an overflow bubble named on the
    mis-routable path can carry a final-only tail the last partial never
    emitted (the open VERIFY-1 edge), which the live view then loses and a
    reload restores. Where the relevant proof fails the plugin marks nothing
    and leaves the bubble visible-but-misplaced rather than tell the client to
    delete content that exists nowhere else. A notice, an error, or any stray
    independent bubble is **never** named.
  - Emission is best-effort by design. A transport without `sendTurnSnapshot`
    is skipped, a throw is caught and warned, and either way the drain and
    `turn_settled` proceed — the turn degrades to the pre-#212 arrival-order
    render rather than failing.

### Changed

- **`WebChannelPeerChannel` gains a required `sendTurnSnapshot(peerId, turnId,
  answers, remove)`.** `NatsChannel` and `NullPeerChannel` implement it. This is
  an internal channel contract, not a published entry point — the plugin ships
  no JS API — but an out-of-tree implementer of the interface must add the
  method.
- **The two companion libraries were renamed** —
  `@mir-stream/webchannel-client` → `openclaw-webchannel-client` and
  `@mir-stream/webchannel-saas` → `openclaw-webchannel-saas`. **This plugin's own
  name is unchanged**; it has always been the unscoped `openclaw-webchannel`, and
  all three now share that prefix. No API, behaviour, or protocol change.
  **The old scoped names will be unpublished after this release**, so consumers
  of the client or saas packages must migrate — see
  [Migrating an existing consumer](../../docs/PUBLISHING.md#migrating-an-existing-consumer).

### Notes

- **No protocol break.** `WEBCHANNEL_PROTOCOL_VERSION` stays `3`. `turn_snapshot`
  is purely additive and safely ignorable: no existing frame or field changed,
  and a `0.6.x` client that has never heard of the type ignores it and renders
  exactly as it does today. The order fix does need a `0.7.0` client to be seen,
  but nothing here refuses a mismatched peer.
- **Known limitation, deliberate.** A text-bearing message that streams **zero**
  partials has no `streamedAnswerText`, so it cannot appear in `answers` and the
  snapshot cannot place it — and in a `K>=2` tool-only-last turn its mis-routed
  final can still leave the live view reading `[A][C][C]` with `B` absent. This
  is the same #111 final-identity ceiling as the Case-X shape, not a defect in
  the snapshot: finals are identity-less on the wire, and the pinned core does
  not produce a non-streaming message at the middle position. It reload-heals.
  The `remove` guard above exists precisely so this shape loses *ordering*, never
  *content*. Pinned by tests; do not add mitigation at this layer.
- **Known limitation, client-side.** What the plugin states authoritatively is
  only as good as the client's reconciliation of it, and that reconciliation is
  not yet ordered against durable history. A second device, a reconnect, or a
  cursor-less `loadHistory()` refresh around a live turn can all put a
  `turn_snapshot` across its own turn's history frame, and the snapshot is
  then either overwritten by history adoption (**#227**) or mints a duplicate
  bubble rather than recovering a lane (**#228**). Both are client-side and
  neither is fixed here. Nothing in the emission above changes to work around
  them.
- This snapshot follows #172 and #173, which shipped in `0.6.1`, and corrects
  the one shape #173 left imperfect (3+ text-bearing lanes, a tool-only last
  message, a middle frame dropped mid-turn). **It is not the end of the
  delivery-render work.** That design has since been reboarded onto **#236**,
  which supersedes the older umbrella and absorbs the limitations above. Treat
  #236 as the live tracker; the issue numbers here are historical labels for
  the behaviours they describe.

## 0.6.1

### Fixed

- **Every streamed message reached the browser twice (#172).** In
  partial-streaming mode an assistant message was delivered once as its own
  streamed lane bubble (`onPartialReply`) and then again as an independent
  `agent_message` from the authorized-block delivery, so a two-message turn
  rendered as **four** bubbles. Verified against the pinned core bundle: the
  authorized block is a redundant re-render of the partial stream — core feeds
  the same visible text to `onPartialReply` and to the block chunker — so the
  block carries no content the partials did not already stream. The block's wire
  frame is now suppressed when its own assistant message already streamed
  visible text and has not terminally failed. Disposition and barrier
  bookkeeping are untouched, so the ordering/release gate is unaffected.
  - The match is **identity-first**, not positional: each lane is stamped with
    core's 1-based `assistantMessageIndex`, taken from a boundary counter that
    ticks on every `onAssistantMessageStart` (including the swallowed first), and
    verified in lockstep with core's block ordinal through tool-only middle
    messages. It is deliberately separate from the barrier/reservation system and
    never feeds ordering.
  - Every other shape falls through to independent delivery **unchanged**: an
    indexless block, a stamp with no matching lane, a lane the fail-safe rotated
    (unstamped), or a lane whose own frame failed to ship. The last one is what
    preserves failed-lane recovery.
- **A second final overwrote the wrong bubble (#173).** An ordinary answer final
  always overwrote the *current* lane, so when core emitted one final per
  text-bearing message — the topology where the turn's last assistant message is
  tool-only — the later final landed on top of a message it did not belong to.
  Ordinary finals are now routed to the lane they belong to, in generation order
  over the lanes that streamed visible text and actually reached the client, and
  settle on that lane's **own id** rather than replacing another lane's text. The
  single-final (collapsed) case still settles the current lane, and an overflow
  final still falls back to an independent bubble. Notices, errors, and any final
  after a leading terminal error take the independent/error route unchanged.
  - **Known limitation.** Finals are identity-less on the wire, so this pairing
    is positional over the materialized answer lanes. With 3+ text-bearing lanes
    plus a tool-only last message, if a *middle* lane's frame drops on a
    transient wire failure the pairing shifts and one final surfaces as a stray
    independent bubble instead of topping up its own. It self-heals on reload,
    and the sound fix needs the authoritative snapshot still to come in #212 —
    this is pinned by a test; do not add mitigation at this layer.

### Notes

- **No protocol break and no API change.** `WEBCHANNEL_PROTOCOL_VERSION` stays
  `3`, no frame type or field was added or removed, and no exported type moved.
  Both fixes are entirely internal to how the plugin routes what it already
  sends — the change is visible only as *correct* rendering: fewer duplicate
  bubbles, and finals landing on their own message.
- These are phases 1 and 2 of the delivery-render redesign tracked in **#212**;
  they also remove most of #174 (independent-block ordering) as a consequence.
  The remaining phase is the authoritative snapshot.
- `@mir-stream/webchannel-client` `0.6.1` is a **code-identical** lockstep
  release. No client upgrade is required to get these fixes — they are plugin
  side only — but the 3-way version lockstep means all three artifacts move
  together.

## 0.6.0

### Added

- **A structured tool-activity surface on the channel (#97).** Until now the
  only thing a browser peer learned about the agent's tool work was whatever the
  progress draft happened to be showing: transient text, on a path a short tool
  call can complete without ever flushing, and that turn settlement replaces
  with the final answer. The channel now emits an additive `tool_activity`
  frame per tool call — `{turnId, id, name?, phase?, status?, summary?,
  argKeys?}` — sealed and delivered on the same encrypted peer path as every
  other outbound frame. It is sourced **directly from the run-scoped agent event
  stream**, not from the progress-draft `scaffoldWriter` gate, so the
  pre-existing progress-text path is byte-for-byte unchanged and short calls
  that never flush a draft are still visible. Ids are correlated across a
  call's start/update/terminal phases (by `itemId`/`toolCallId`/`name` within
  the run), so a consumer can upsert one item per call rather than accumulate
  fragments. The lane is ephemeral live state: it is **not** durable history and
  never enters `sendHistory`.
  - **`argKeys` carries argument KEY NAMES only, never argument values.** Tool
    arguments routinely hold file contents, paths, and secrets, so only
    `Object.keys(args)` crosses the wire, and only on non-terminal phases.
  - The same boundary governs everything else on the frame. An item core marks
    `hideFromChannelProgress` is suppressed, and so are the derived
    command/patch companions the pinned runtime emits without re-flagging them —
    the tracker remembers the hidden invocation and its aliases across those
    companions, and retires it only on a fresh unhidden canonical start. Items
    marked `suppressChannelProgress` are dropped. Patch summaries are admitted
    only after reduction to the pinned producer's count-only grammar
    (`3 added, 1 modified`); the path arrays are never read. Command, tool, and
    search summaries can carry output or query/result bodies and are withheld
    entirely.
  - **There is no config gate and no opt-out.** Unlike the reasoning lane, tool
    activity is on for every peer the channel serves. Consider that before
    upgrading if your browser peers are less trusted than your operators: the
    surface is deliberately narrow metadata, but a tool *name* still describes
    what the agent is doing.
  - Deliberate follow-ups, not oversights: the argument-value redactor, the full
    tool outcome (`onToolResult` / `onCommandOutput` / `onPatchSummary`),
    non-streaming-mode wiring, and a durable after-settle record.
- **Stable assistant-message identity on the wire (#111).** `agent_message`
  frames now carry an optional `assistantMessageIndex`, and the
  `WebChannelPeerChannel` methods `sendText` and `finalizeDraft` take it as a
  trailing optional parameter. It lets a client reconcile a register-time
  history snapshot against the bubbles already on screen by exact match instead
  of a text/positional heuristic. It is populated **only** for authorized block
  deliveries, where core's runtime dispatch info carries a true
  per-assistant-message identity; final, notice, and error deliveries omit it,
  because core stamps one turn-level index on every retained final payload and
  reading it there would misattribute one retained message to another. The
  ordinal is run/attempt-local and can repeat within a single user turn after
  model fallback, so it is **live-only and deliberately absent from
  `HistoryMessage`** — it must not be used as a durable history/hydration key.
  - Implementers of `WebChannelPeerChannel` outside this package must widen
    `sendText`/`finalizeDraft` and add `sendToolActivity`. The interface gained
    a required member, so a hand-written implementation will not typecheck until
    it does; `NullPeerChannel` is updated accordingly.
- **Channel-presentation metadata is now complete (#170).** The plugin
  registered without the four channel-presentation fields, so pinned
  openclaw `2026.7.1-2` filled the defaults itself and emitted a
  warning-shaped `channel "webchannel" registered incomplete metadata; filled
  missing label, selectionLabel, docsPath, blurb` diagnostic on **every**
  gateway boot. All four are now supplied on the runtime `plugin.meta` that core
  reads at registration. The separate pre-load `openclaw.channel` catalog block
  in `package.json` — which is what represents this channel to an operator while
  the bundle is not loaded at all — carries the same four values, and a
  cross-assertion of the shipped entry against that block keeps the two surfaces
  from drifting apart again.
- The package is now **MIT licensed**. It previously declared no `license` field
  at all; it now declares `MIT` and ships a `LICENSE` file in the tarball.

### Notes

- **No protocol break.** `WEBCHANNEL_PROTOCOL_VERSION` stays `3`. Both wire
  additions are optional and additive in both directions: an older client
  ignores the new frame type and the new field, and an older agent simply never
  sends them. Lockstep with `@mir-stream/webchannel-client` at `0.6.0` is still
  the supported configuration, and both sides must be upgraded to see the new
  surface — but nothing in this release refuses a mismatched peer.

## 0.5.0

### BREAKING

- **Reasoning is now streamed to browser peers by DEFAULT** (#113). The lane is
  gated on a new channel-private `channels.webchannel.capabilities.reasoning`,
  and an ABSENT key means ON, so every existing deployment starts sending the
  agent's reasoning/thinking stream to its widgets after upgrading — no config
  change required to turn it on, and none was needed to turn it off before,
  because the lane could not previously be enabled at all.
  - **Opt out with `"capabilities": { "reasoning": false }`** in the webchannel
    block (channel-level, or per account under `accounts.<id>`). A persisted,
    explicit session `/reasoning off` also remains a privacy veto for peers an
    operator has authorized through core's command allowlist. The veto reads one
    verified session-store snapshot: only a missing file means empty state;
    every other read, parse, or store-shape failure closes the lane.
  - Consider whether you want this before upgrading. Reasoning is model-internal
    deliberation, not a UI affordance: it can restate file contents, credentials,
    or the user's own prompt, and browser peers are the least trusted surface
    this plugin serves.
  - Only boolean `true` enables it. Every PRESENT value that is not boolean
    `true` fails closed, so a mistyped value disables the lane rather than
    leaking; note the `"on"`/`"off"` strings that the sibling
    `capabilities.typing` accepts are rejected by the channel-level schema.
    Named-account leaves are deliberately schema-unvalidated, so malformed
    values there fail closed at the runtime resolver instead.
  - Enabling is necessary but not sufficient — the agent's own thinking level
    must also be something other than `"off"`, which no channel config can force.
    Authorized mode-`on` sessions receive core's complete durable reasoning
    blocks at full length under distinct ids; they never enter the answer path or
    the live stream's cumulative-prefix normalization.
    When an enabled lane completes a normal turn having received nothing, the
    plugin logs one warning per account per process naming that as the likely
    cause.
  - The lane previously keyed off `agents.*.reasoningDefault`. It no longer reads
    that key at all, and setting it has no effect on this channel; core
    invalidates it for ordinary unauthorized senders. Webchannel leaves ordinary
    turns unauthorized by default, while still supporting operators who
    deliberately authorize named peers through core's command allowlist.
    Requires openclaw `>=2026.7.1`.
- **The tenant is now part of the session-key derivation, so EVERY existing
  session key changes on upgrade** (#112). Webchannel keyed sessions on
  (agent, channel, account, peer) only, but the protocol permits the same
  account id under different tenants — so serving `(tenant=T1, account=A,
  peer=P)`, then reconfiguring that account as `(tenant=T2, account=A)` and
  registering with a valid T2 token for the same peer string, resolved T1's
  session key and returned T1's transcript through the register-time history
  snapshot and `load_history`. Admission could not catch it: it checks the
  signed tenant claim against the *configured* tenant, and after the change T2
  is legitimately that tenant. Keys are now
  `agent:<agent>:webchannel:<account>:direct:<peer>:tenant:<sha256>`, where
  `<sha256>` is the full 64-character lowercase SHA-256 digest of the tenant
  exactly as configured. OpenClaw lowercases the whole session key when it
  stores it, while NATS treats `Acme` and `acme` as different tenants with
  different credentials. Hashing the verbatim tenant before the store fold
  keeps those authorization namespaces separate; the digest is not truncated.
  A lossless UTF-8 hex encoding was rejected because maximum-size validated raw
  agent/account/peer/tenant components, even without an `identityLinks` rewrite,
  could push the resulting key past OpenClaw's 512-character chat-send
  session-key boundary.
  - The serving runtime freezes the tenant selected by its startup account plan
    and uses that same value for inbound writes, register-time snapshots, and
    `load_history`. Temporary process-environment overrides during a skill run
    cannot move one of those routes away from the NATS/admission tenant.
  - **What an operator sees after upgrading:** existing conversations appear
    empty. The history snapshot a widget receives at register time, and every
    `load_history` page, read the new key and find nothing under it. Per-session
    `/reasoning off` opt-outs also reset to the configured default, because that
    preference is stored against the session key.
  - There is no automated transcript migration in this release. `sessions.json`
    contains session metadata and key-to-file mappings, not the message bodies;
    messages live in the referenced per-agent `sessions/*.jsonl` files. To
    preserve pre-upgrade history, stop or otherwise quiesce the gateway and copy
    the complete relevant per-agent sessions directory/session storage before
    upgrading, including both `sessions.json` and its referenced JSONLs. Copying
    `sessions.json` alone is insufficient. The pinned OpenClaw
    `openclaw backup create` command omits active session transcript JSONLs, so
    it is not a substitute for this stopped copy.
  - **No re-enrollment, and no credential or key change.** Conversation keys and
    enrolled credentials are stored per `(tenant, accountId)` and peer id, never
    per session key, so they are unaffected. Browsers reconnect and register
    normally; a fresh conversation simply starts under the new key.
  - This applies to single-tenant deployments too, including any that never set
    `tenant` and use the `default-tenant` fallback. Preserving those keys by
    omitting the component for the default tenant was considered and rejected:
    every deployment that *had* configured a tenant — the entire population the
    bug can affect — breaks either way, so the exception would buy no security
    and would leave a confidentiality boundary conditional on a magic value.

### Fixed

- **#135 — account ids that the OpenClaw SDK normalizes to one value are now
  rejected before serving.** A config such as `accounts.Acme` plus
  `accounts.acme` previously started both authorization namespaces while core
  folded their session keys together. Inspection now groups every raw account
  key through `openclaw/plugin-sdk/account-id` and rejects every member of a
  shared group, including aliases created by case folding, invalid-character
  replacement, whitespace trimming, or the 64-character clamp. Valid ids that
  the SDK keeps distinct remain distinct (`99` and `99-`, for example).
  Startup emits `event=webchannel.invalid_account_id` for each rejected raw id;
  the reason names the normalized value and the complete conflicting id list.
  Operators must rename or remove entries until every normalized account id is
  unique. This does not change the key format, but a deployment that previously
  ran a colliding config will skip all members of that collision after
  restart/reload. Inspection compares one config generation only; a sequential
  case-only rename across a hot reload remains outside this fix.
- **#99 — a coalesced turn now settles EVERY message it merged.** When busy-time
  coalescing folds N buffered user messages into one turn, the turn used to emit
  a single `turn_settled` naming only the last (anchor) wireId, so the other
  N-1 P0-4 receipts sat at `accepted` for the lifetime of the client: an
  embedder awaiting a terminal state waited forever, silently, because the text
  itself was delivered and answered. The merge now carries every member wireId
  plugin-internally and the turn emits one `turn_settled` per member with the
  same outcome, each exactly once, anchor last (it is the id the drafts and
  `agent_message` frames reference). An admission-denied turn still settles
  nothing. A non-coalesced turn still emits exactly one frame, because inbound
  `user_message` frames are now normalized to their known wire fields at ingress
  — a peer cannot supply the internal member list, so a turn's members are only
  ever the messages the plugin itself merged. Both read sites additionally treat
  the field as untrusted (a non-array is inert rather than thrown, members must
  be plausible ids, and the list is capped at the same per-session bound the
  merge itself obeys).
  - **No client change and no protocol change.** `WEBCHANNEL_PROTOCOL_VERSION`
    stays `3`, no new frame type and no new wire field: `turn_settled{turnId,
    outcome}` already exists, and an already-deployed client promotes whichever
    receipt each frame names (its draft finalization is keyed on the anchor
    turnId only, so a member frame is a no-op there). Fixing this on the client
    instead would have required inferring terminality from ordering, which a
    delivery contract must not do.

## 0.4.0

### BREAKING

- **Protocol v3 — register-hop wire break.** Ships lockstep with client/SaaS
  `0.4.0`; `WEBCHANNEL_PROTOCOL_VERSION` is `3` and a mismatched request is
  refused with a terminal `protocol_mismatch` (426) before PoP or key work.
  - Authenticated register requests require a new `clientNonce` (base64url, ≥16
    bytes of entropy), which is bound with the peer id into the
    wrapped-conversation-key AAD. The wrapped key was authenticated but not
    fresh, so a hostile relay could capture a register reply and re-serve it
    verbatim; that is inert only while K never rotates. Validation runs **after**
    the version check, so an outdated browser gets a terminal 426 instead of a
    401 that its embedder would route into a re-login loop.
  - `unregister` now requires the same single-use PoP proof as `register`
    (issue #51), gated on `auth.requirePoP` identically. The bootstrap JWT
    crosses the untrusted relay in plaintext, so a token-only teardown could be
    captured and replayed until the JWT expired, dropping the victim's
    subscription and session key each time with no signal to the victim. Every
    failure remains a silent no-op with no reply.
  - The PoP signed message is now `webchannel-pop:{op}:{peerId}:{nonce}`. Both
    operations draw from the same per-peer nonce bucket, so without the op a
    `register` proof also authorized a teardown — obtainable without any replay
    by *suppressing* the register frame, which is indistinguishable from the
    dropped frame the client retry loop absorbs.
- Removed configurable `auth.jwt.audience`. The account-bound verifier always
  expects the runtime account id, and a raw removed key is rejected before any
  credential or relay I/O. Delete the key from shared and named account blocks.
- Generic/shared IdP audiences are no longer accepted. `aud` is the account id
  or an array of authorized account ids in one tenant; this supersedes #65's
  partial audience-pin proposal.
- Register admission now requires a non-empty signed tenant claim matching the
  configured tenant for challenge, register, and unregister.
- **Protocol v2:** authenticated register requests require v2 and bounded
  retained-work overload uses `inbound_rejected`; client and plugin must upgrade
  together.
- Bound debounce waiting/in-flight plus busy dispatcher pending work by shared
  process and per-session count/charged-byte budgets. Preserve admitted work and
  reject only the newest overflow with durable outcome dedupe.
- `/stop` now cancellation-records and ACKs the exact waiting/in-flight union
  before releasing its reservations; failed suppression writes recover through
  the bounded replay tombstone path. Every ACK/rejection producer shares the
  same 64-id, 64-KiB, effective-`max_payload` result boundary.

### Security upgrade / incident response

A prior deployment that served multiple accounts under the same issuer and
shared audience must be treated as potentially exposed: a token for one account
may have admitted another peer and disclosed that peer's conversation key K and
history. This release prevents new cross-account admission, but cannot make
previously exposed keys or ciphertext secret again.

Drain and stop every vulnerable plugin replica and keep the affected accounts
disabled. Revoke affected issuer/relay bootstrap and NATS authorizations plus
active sessions. Review the complete exposure window and history. Rotate K and
invalidate old encrypted peer state only through a verified control. Removing
`auth.jwt.audience`, partially restarting the fleet, or waiting for token expiry
is not revocation.

The integrated verified rotation/state-invalidation path is tracked by #72. If
it is unavailable, do not invent file-deletion or ad-hoc migration commands;
keep the accounts disabled and escalate through incident response.

### Fixed

- Added per-account pure planning and immutable account-bound auth preparation
  before that account consumes transport credentials or performs network I/O,
  token-only prepared verifiers, Gate-B-before-subscribe activation,
  exact-identity rollback, once-only primary binding, and cleanup of transports
  whose connect handshake rejects. Issuer derivation may read the account's
  memoized enrollment metadata when required. Signed tenant and account-id
  audience claims make token populations distinguishable, so accounts retain
  independent startup and failure isolation.
- Incident context: #72. Durable credential/storage follow-up: #71.

### Added

- **P0-4:** `turn_settled` frames now carry an explicit `outcome: "ok" | "error"`
  (additive — older clients ignore it). A clean turn stamps `"ok"`; a turn that
  throws stamps `"error"`. This is what lets the client promote a message to
  `completed` (ok) or fail it `turn-failed` (error) — never fabricated from a
  bare, outcome-less settle.

### Fixed

- **P0-4 outbound honesty:** core-initiated outbound sends (`sendText` /
  `message.send.text`) now **throw** on failure instead of returning a fabricated
  message id; the draft-finalize path propagates its real boolean into
  `visibleReplySent`. Ack-send and turn-terminal frame-send failures are logged
  (at-least-once recovery via client re-register → replay → dedupe → re-ack), with
  a per-account fallback tombstone closing the cancel-path double-failure window.

### Notes

- Lockstep with `@mir-stream/webchannel-client` — upgrade both together. A
  final-frame send failure does **not** suppress `turn_settled{outcome:"ok"}`: the
  turn genuinely settled, so the client's send-receipt reaches `completed`; the
  dropped answer text is recovered by the register-time history snapshot.
- The outbound **throw-on-failure** behavior above depends on core never
  re-sending a thrown outbound. Traced in `openclaw` 2026.6.10 (the floor of the
  `>=2026.6.10` peer range): core stamps `send_attempt_started` before calling the
  channel, and its durable-delivery drain refuses to blindly replay an entry in
  that state unless the adapter supplies `reconcileUnknownSend` — which this
  channel deliberately does not — so a thrown send moves to failed. A core bump,
  or adding `reconcileUnknownSend`, re-opens the blind-replay path and would cause
  silent duplicate delivery; re-verify then.
