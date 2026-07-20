# Changelog — @mir-stream/webchannel-plugin

## Unreleased

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
