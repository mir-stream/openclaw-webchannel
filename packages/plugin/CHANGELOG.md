# Changelog — @mir-stream/webchannel-plugin

## Unreleased

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
