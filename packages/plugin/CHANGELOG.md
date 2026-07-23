# Changelog — @mir-stream/webchannel-plugin

## Unreleased

### BREAKING

- Removed configurable `auth.jwt.audience`. The account-bound verifier always
  expects the runtime account id, and a raw removed key is rejected before any
  credential or relay I/O. Delete the key from shared and named account blocks.
- Generic/shared IdP audiences are no longer accepted. `aud` is the account id
  or an array of authorized account ids in one tenant; this supersedes #65's
  partial audience-pin proposal.
- Register admission now requires a non-empty signed tenant claim matching the
  configured tenant for challenge, register, and unregister.

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
