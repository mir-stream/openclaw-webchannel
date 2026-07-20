# Changelog — @mir-stream/webchannel-client

## Unreleased

### BREAKING

- **P0-4 send-result contract.** `ChatMessage.delivered?: boolean` is **removed**,
  replaced by `sendState?: "queued" | "sent" | "accepted" | "completed" | "failed"`
  and `sendFailure?: SendFailure`. Migration: `delivered === true` ↔
  `sendState === "accepted" || sendState === "completed"`. Lockstep with
  `@mir-stream/webchannel-plugin` — upgrade both together.

### Added

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
