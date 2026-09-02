# Changelog — openclaw-webchannel-client

## Unreleased

### Breaking (wire protocol v4)

- **`WEBCHANNEL_PROTOCOL_VERSION` goes 3 → 4 (#246).** The exported constant
  changes value; no client API changes. The client sends it on the register
  request and requires it on the register reply, both already exact-match and
  both already terminal (`pop-register.ts`), so this release adds no new gate —
  it changes the number those gates compare against. Against a `0.7.0` (v3)
  agent this client now fails with a terminal `protocol-mismatch` and no re-auth
  affordance, instead of connecting. Upgrade the gateway plugin and the browser
  bundle together.

  **Why this is a bump and not another additive frame.** The v6 frames stayed
  safely ignorable for RENDERING and are not for CORRECTNESS. A `0.7.0` browser
  also declares `3`, so it passed the old gate and then ignored the durable
  `seq` and the `get_difference`/`difference` gap-sync (#244), `user_committed`
  (#245), the `reasoning`/`tool`/`approval` `history` rows (#242), and
  `ack.committed[]` (#243). The transport is core NATS pub/sub — at-most-once,
  no retention — so a browser with no `seq` cannot detect a dropped frame and
  never asks for the heal. Its transcript is then invisibly wrong. The one thing
  that reaches it unasked is the history snapshot requested on every successful
  register, carrying only the newest `history.limit` projected rows (50 by
  default) — incidental, not a repair path: a bounded window, folded by id, so it
  neither reaches an older hole nor overwrites a bubble it already holds. It also
  drops role-less `history` rows, which stalls "load older" forever once the agent
  has `capabilities.reasoningDurable` on (**#309**, closed by this).

  **No capability negotiation was added.** Under an exact-match gate every peer
  is at this exact version, so there is nothing to withhold per peer, and the one
  frame shape that would need it — a live delete/edit — is not on this wire
  (`messageDeleted`/`messageEdited` are durable event kinds with no producer).
  `protocol.ts` carries v4 as the second worked example under "When to bump", and
  the next slice that adds a frame an equal-version peer must act on decides
  bump-vs-negotiate there.

## 0.7.0

### Added

- **The client now renders the agent's authoritative answer order (#174,
  #215).** A `0.7.0` agent emits one new inbound frame at settlement —
  `turn_snapshot`, carrying `{ turnId, answers: Array<{ id, text }>, remove:
  string[] }`, delivered after the turn's last answer frame and immediately
  before `turn_settled`. The client reconciles the agent **answer** bubbles of
  the turn the snapshot names to it, and clears the typing indicator. Previously
  the transcript order was whatever order the frames arrived in, which is why a
  later assistant message could sit above an earlier one (#174) and why a middle
  answer whose frames failed left a corrupted bubble plus a stray duplicate
  (#215).
  - The reduction is explicit, never a blanket "drop anything not listed":
    `remove` ids are dropped; each `answers` entry is upserted by id — an id the
    client does not hold yet is **minted**, which is how an answer whose own
    frames never arrived is recovered; and answer bubbles are then reordered
    **among the slots answer bubbles already occupy**.
  - **Everything else is preserved as the same object reference.** User bubbles
    and their send state (receipts, held, `sendState`), notices and errors,
    reasoning, tool activity, and an adopted durable-history agent row sharing
    the turn all keep their identity and their slot. Only answer bubbles move,
    and only past each other — so a `useSyncExternalStore` / memo consumer sees
    no spurious change on the rows the snapshot did not touch.
  - **No protocol break.** `WEBCHANNEL_PROTOCOL_VERSION` stays `3`; the frame is
    additive in both directions. A `0.6.x` agent simply never sends it, and this
    client behaves exactly as `0.6.1` did against one. Upgrading only the client
    changes nothing on its own — the frame comes from the agent.
  - **Known limitation: a snapshot that crosses durable history is not
    reconciled correctly.** The upsert above matches on the bubble id the client
    currently holds, and history adoption renames those ids. That read is
    detached, so either order is legal: a snapshot arriving **before** adoption
    is overwritten by it and the authoritative correction is lost for the
    session (**#227**), and one arriving **after** adoption misses the renamed
    bubble, so the "minted" path above adds a duplicate instead of recovering a
    lane (**#228**, heals on reload). Neither is fixed here, on purpose —
    resolving them inside the client means matching on text or position, which
    is the guessing the delivery-journal redesign (**#236**) exists to retire,
    and which adversarial review found could delete another device's answer
    outright. Reaching either needs a durable-history read for the turn to
    interleave with the snapshot — a second device, a reconnect, and a
    cursor-less `loadHistory()` refresh around a live turn all produce that.

### Changed

- **BREAKING (package name): `@mir-stream/webchannel-client` is now
  `openclaw-webchannel-client`.** The `@mir-stream` scope was only ever a GitHub
  Packages requirement (scope must equal repo owner); these packages moved to
  public npm in `0.6.1`, so the scope is a vestige of a registry they no longer
  use. All three published packages now share the `openclaw-webchannel` prefix.
  No API, behaviour, or protocol change — only the specifier you import.
  **The old scoped name will be unpublished after this release**, so migration
  is not optional — and a plain `npm update` will not do it, because nothing
  resolves an old name to a new one. Follow the pinned, ordered procedure in
  [Migrating an existing consumer](../../docs/PUBLISHING.md#migrating-an-existing-consumer);
  it also covers rewriting your import specifiers.
- **`InboundMessage` gained the shape of the new frame.** `type` adds the
  `"turn_snapshot"` member and two optional fields appear —
  `answers?: Array<{ id: string; text: string }>` and `remove?: string[]` — both
  meaningful only on a `turn_snapshot`. This is additive: existing
  `InboundMessage` values stay valid. It is only a source break if you
  exhaustively `switch` on `InboundMessage["type"]` with no `default`, in which
  case TypeScript will now point at the missing case. The client re-declares the
  wire type rather than importing it (this package stays dependency-free), so
  the field docs live here too.
- If you write your own frame handler rather than using
  `WebChannelNATSClient`, **an unrecognized `turn_snapshot` must stay inert** —
  do not treat it as a message-bearing frame.

## 0.6.1

- **No client behaviour changed in this release.** `0.6.1` is a lockstep version
  bump so that tag, plugin, client, and saas stay identical. The only source
  change since `0.6.0` is one doc comment on `InboundMessage.messages`; the
  public entry point and every exported type are untouched.
- The `0.6.1` fixes (#172 duplicate bubbles, #173 finals overwriting the wrong
  bubble) are **plugin side only** — they change which frames the agent sends,
  not how the client reduces them. A `0.6.0` client already renders them
  correctly; upgrading is optional and carries no behaviour change on its own.
- Note for anyone who tracked the `develop` branch: the client-side keyframe
  resync frame explored for #173 was **retired before release** and never
  shipped. There is no `keyframe` inbound frame type in any published version,
  and none is planned — the plugin is the source of truth for delivery, and the
  remaining #212 phase keeps it there.

## 0.6.0

### Added

- **Live tool activity is now a first-class client surface (#97).**
  `WebChannelState` adds optional `toolActivity?: ToolActivityItem[]`, and the
  new exported type `ToolActivityItem` (`{ id, turnId, name?, phase?, status?,
  summary?, argKeys? }`) describes one tool call the agent is making. Until now
  the only signal a product could render was the agent's progress-draft text — a
  transient string a short tool call can finish without ever producing, and
  which turn settlement replaces with the final answer. The lane arrives on its
  own additive `tool_activity` frame, independent of the progress-draft path, so
  the existing progress text is unchanged.
  - It behaves like `reasoning[]`, not like `messages[]`: items are upserted by
    `id`, correlated by `turnId`, bounded to the most recent 100, and
    **ephemeral**. This is NOT durable history — it does not survive a reload
    and does not come back in a register-time history snapshot. Render it as
    live decoration, never as the record of what happened.
  - `argKeys` carries argument **key names only**, never argument values. Tool
    arguments can hold file contents, paths, and secrets, so the agent never
    puts values on the wire; do not present `argKeys` as if it were the call's
    input.
  - The field is optional on `WebChannelState` purely so existing
    `WebChannelState` object literals stay source compatible. Snapshots produced
    by the high-level wrapper always initialize it to an array, so a consumer
    reading `state.toolActivity` from a real client never sees `undefined`.
- **`ChatMessage.assistantMessageIndex?: number` (#111).** `agent_message`
  frames may now carry an observed per-assistant-message ordinal, and the client
  uses it as a tier-0 exact match — scoped through the anchor's live `turnId` —
  when reconciling a history snapshot against the bubbles already on screen,
  falling back to the existing text/positional heuristic, untouched, whenever
  the field is absent. The agent populates it only for authorized block
  deliveries; final, notice, and error deliveries omit it.
  - **It is not an identifier.** The ordinal is run/attempt-local, can repeat
    within one user turn after model fallback, is not globally unique, and is
    deliberately not part of `HistoryMessage`. Do not use it as a durable
    history or hydration key.
- The package is now **MIT licensed** — it was previously published as
  `UNLICENSED` — and ships a `LICENSE` file in the tarball.

### Notes

- **No protocol break.** `WEBCHANNEL_PROTOCOL_VERSION` stays `3`. Both additions
  are optional and additive in both directions: this client ignores their
  absence against an older agent, and an older client ignores them against a
  `0.6.0` agent. Lockstep with `openclaw-webchannel` at `0.6.0` is
  still the supported configuration and is required to see the new surface, but
  nothing in this release refuses a mismatched peer.

## 0.5.0

### Added

- **Next minor, non-breaking — turn-scoped in-flight signal.**
  `WebChannelState` adds optional `turnActive?: boolean`: `true` while at least
  one turn this client started is still open. A turn opens when the user message
  that starts it is published — immediately, or later when a held follow-up is
  released — and closes when that turn settles (an outcome-less legacy
  `turn_settled` closes it too). It is unaffected by `progress`, `agent_message`,
  and `reasoning`, and an actionable approval keeps it `true` while `isTyping`
  goes `false`, so the whole of a multi-step turn is covered rather than only the
  window before the first agent bubble. `isTyping` is unchanged in every respect;
  the two are complementary ("composing an answer right now" vs "still working on
  this turn"). Abort text (`/stop` and the NL abort vocabulary) rides the agent's
  control lane, which never settles, so it opens no turn.
  Turns are **not** one-per-send: messages arriving during a running turn are
  coalesced into one turn keyed by the LAST of them (`inbound-queue.ts`
  `coalesceUserMessages`). The current plugin emits one same-outcome
  `turn_settled` per member in arrival order, anchor last, and the client promotes
  each exact named receipt. A settle also closes the turn it names and every turn
  published before it (publish order is processing order); that prefix sweep
  remains for older anchor-only v3 plugin builds and lost/missing
  earlier member frames. A settle for an unknown turn sweeps nothing; both
  outcomes and an outcome-less legacy settle sweep alike. A failed send closes
  its own turn ONLY for the failure that is a good proxy for the agent never
  having received it — `overloaded`, an ingress rejection. A proxy, not a proof: the
  agent can also reject a message it already admitted (a live same-connection
  retry of an unacked id whose accepted marker was lost), whose turn is already
  running. Anything a settle might still name is otherwise left to the sweep,
  since removing such an id early would break the sweep for every turn behind it:
  notably `turn-failed` (it arrives FROM a settle that already sweeps) and
  `evicted` (a CLIENT-side unacked-ledger cap drop — a lost ack is not a failed
  delivery, so the message may have reached the agent, been coalesced, and be the
  very id its turn settles under).
  The flag is advisory: it does not gate `send()`, the P1-9 held-message FIFO,
  send receipts, or reconnect, and nothing inside the client reads it back.
  **The guarantee is bounded, not absolute.** A terminal error, `close()`, an
  explicit `/stop`, and the transition to disconnected each force-close every
  open turn; the post-reconnect staleness valve does too, but only where it arms
  at all (a `working` draft live at session re-establishment), so it is an extra
  rescue rather than a general timeout. The residual has one shape and its causes
  are deliberately not enumerated: any published turn whose settle never arrives,
  or arrives naming an id this client cannot place, stays `true` until a later
  settle sweeps it as part of the prefix or a safety point fires — `turn_settled`
  delivery is itself best-effort (warn-logged and dropped on failure, unlike
  acks), and several agent-side paths ack at ingress then abandon the message.
  Named examples, not a complete list: text the agent routes to its control lane
  while this client's pinned abort vocabulary — a deliberate subset
  (`abort-mirror.ts`) — does not recognize it; a message denied by the agent's DM
  allowlist, already acked at ingress but dropped without dispatching a turn
  (`packages/plugin/src/inbound.ts` sets `settlementEligible = false` on denial;
  the admission/settlement asymmetry is a separate defect, not addressed here);
  a lost coalesced-member frame whose remaining frames belong to a second device
  on the same peer id (or the same shape from an older anchor-only plugin); and a
  post-admission `overloaded` rejection, closed
  eagerly while its turn is still running. Force-closing is also one-way — no
  inbound frame re-opens a turn, so a mid-turn reconnect leaves `turnActive`
  false for the rest of that turn. Render it as a soft hint, never a hard gate.
- **Next minor, non-breaking — reactive application-session liveness.** The
  high-level `WebChannelNATSClientOptions` adds `ackStallTimeoutMs` (default
  `30_000`; integer `0..2_147_483_647`; `0` disables both automatic lanes).
  Published work with no owned authenticated ingress result and ordinary
  follow-ups held with no authenticated live-turn activity each request at most
  one existing soft reconnect per continuous stall episode. Both use the same
  reconnect/register/key/replay/session path. Published work keeps its original
  ID and remains `sent` while delivery is unknown; held work remains `queued`
  without a wire ID and is never failed, retracted, stopped, or auto-released by
  the detector. Long legitimately silent turns can cause one redundant reconnect,
  so deployments may raise the timeout or disable it.
- Public `connected: true` now means authenticated-session readiness after
  registration, key installation, and ledger replay. A raw-open socket remains
  `connecting/false` initially or `reconnecting/false` after a prior session;
  this readiness correction is active even when `ackStallTimeoutMs` is `0`.

## 0.4.0

### BREAKING

- **Protocol v3 — register-hop wire break.** Ships lockstep with plugin/SaaS
  `0.4.0`. Four changes, all mandatory:
  1. The register request carries a new required `clientNonce`: a fresh random
     value this package generates per register *attempt*, which the agent binds
     into the wrapped-conversation-key AAD. It closes a register-reply replay:
     the wrapped key was authenticated but not fresh, so a hostile relay could
     re-serve a captured reply. The agent never echoes it and the client never
     reads it back off the wire.
  2. `unregister` now requires the same proof-of-possession as `register`; a
     token-only teardown was replayable off the relay. Use the new
     `unregisterWithPop()` — a hand-rolled token-only `unregister` against a v3
     agent is a **silent no-op** (fire-and-forget, no reply on any path, and the
     version check sits after the unregister branch, so there is no 426).
  3. **Exported signatures changed:** `popSignedMessage(peerId, nonce)` →
     `popSignedMessage(op, peerId, nonce)` and `signPop(key, peerId, nonce)` →
     `signPop(key, op, peerId, nonce)`. The signed message is now
     `webchannel-pop:{op}:{peerId}:{nonce}`. Without the op a proof minted for
     `register` also authorized an `unregister`, since both verify against the
     same per-peer nonce bucket.
  4. `WEBCHANNEL_PROTOCOL_VERSION` is `3`; a mismatch in either direction is a
     terminal `protocol-mismatch`.
  New export: `unregisterWithPop` (+ `PopOp`, `UnregisterWithPopOptions`,
  `RegisterPublishFn`). `generateClientNonce` is intentionally **not** exported —
  the anchor has exactly one legitimate producer, `registerWithPop`.
- Reference JWT bootstrap consumers no longer submit a tenant/account choice.
  They require the server-returned fixed tuple and treat optional caller values
  only as pre-construction test assertions. This ships lockstep with plugin/SaaS
  `0.4.0` (incident context #72; durable storage follow-up #71).
- **Protocol v2:** a matching plugin is required; missing, malformed, or
  mismatched register reply versions and authenticated 426 replies are terminal
  `protocol-mismatch` failures. `inbound_rejected` maps
  overload to `failed{reason:"overloaded",retryable:true}`. Published unresolved
  ids are live-retried with one capped exponential-backoff timer.
- **P0-4 send-result contract.** `ChatMessage.delivered?: boolean` is **removed**,
  replaced by `sendState?: "queued" | "sent" | "accepted" | "completed" | "failed"`
  and `sendFailure?: SendFailure`. Migration: `delivered === true` ↔
  `sendState === "accepted" || sendState === "completed"`. Lockstep with
  `openclaw-webchannel` — upgrade both together.
- `WebChannelErrorCause` adds the `"capacity"` member. This is wire-compatible,
  but downstream exhaustive switches over the union must add the new terminal,
  non-reauth case.

### Added

- Agent account capacity replies (`capacity_exceeded`, code 507) now surface as
  terminal `WebChannelErrorCause: "capacity"` and do not enter a retry or
  re-authentication loop.

- `send()` now returns a `SendReceipt` (`{ id, snapshot(), subscribe() }`) — an
  observable, retract-surviving handle for a message's terminal outcome
  (`undefined` for trimmed-empty input). New exported types `SendState`,
  `SendFailure`, `SendReceipt`.
- Authoritative monotonic send tracker: every user message resolves to an
  observable `queued → sent → accepted → completed` (or `failed{reason,retryable,
  cause,lastAttemptAt}`) — no more console-only drops or fabricated success.
- `completed` is promoted **only** when an explicit
  `turn_settled{outcome:"ok"}` names that message's exact wire id. The current
  plugin emits one same-outcome frame per coalesced member, anchor last; older
  anchor-only v3 plugin builds leave non-anchors at `accepted`, and
  a legacy frame with no `outcome` leaves its named message there too.

### Fixed

- Low-level `publish()` returns a boolean and forces a reconnect on a
  send-throw (half-open liveness); a queued/ledgered/held send no longer strands
  silently on disconnect, eviction, or a terminal auth/register failure — each
  now emits an observable `failed` transition.

### Notes

- No disk-backed queue: `queued`/`sent` states die with the page (durability
  boundary documented in the README). Recovery lanes for un-resolvable in-session
  windows are tabulated in the README.
