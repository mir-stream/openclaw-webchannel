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
- `completed` is promoted **only** on an explicit `turn_settled{outcome:"ok"}` for
  the anchor message; a legacy plugin (no `outcome`) honestly rests at `accepted`.

### Fixed

- Low-level `publish()` returns a boolean and forces a reconnect on a
  send-throw (half-open liveness); a queued/ledgered/held send no longer strands
  silently on disconnect, eviction, or a terminal auth/register failure — each
  now emits an observable `failed` transition.

### Notes

- No disk-backed queue: `queued`/`sent` states die with the page (durability
  boundary documented in the README). Recovery lanes for un-resolvable in-session
  windows are tabulated in the README.
