# Changelog — @mir-stream/webchannel-client

## Unreleased

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
  `@mir-stream/webchannel-plugin` — upgrade both together.
- `WebChannelErrorCause` adds the `"capacity"` member. This is wire-compatible,
  but downstream exhaustive switches over the union must add the new terminal,
  non-reauth case.

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
