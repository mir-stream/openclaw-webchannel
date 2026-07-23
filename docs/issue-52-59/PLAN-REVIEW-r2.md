# Issues #52 + #59 plan adversarial review — round 2

> Verdict: **NOT CONVERGED**
> Findings: P0 1, P1 2, P2 2, P3 1
> Reviewer: sub-agent `/root/plan_adversarial_review`

The reviewer verified every round-1 disposition, then re-read rev2 against the
current source and exact pinned `openclaw@2026.6.10` package. No files were
modified by the reviewer.

## P0 — Full API config and account-task config are not identity-equal

rev2 keyed generation records by `api.config` object identity and required an
exact `ctx.cfg` WeakMap lookup. The pinned host independently derives the config
passed through full plugin registration and the runtime config passed to account
startup. They can be structurally equal but are normally different objects when
activation sections are merged. Every account could therefore fail with a
missing-generation invariant.

**Required fix:** make `ctx.cfg` authoritative for all account configuration.
Full registration stores only durable runtime/logger dependencies. Derive
generation from a stable structural fingerprint or explicit install token, with
same effective config reusing a generation. Test different object references
with equal content.

## P1-1 — New-generation supersession contradicted composed task lifetime

rev2 aborted an older owner-local controller when a newer generation arrived,
but composition treated any NATS task settlement before host abort as an
unexpected exit and core-restart error.

**Required fix:** either keep a superseded owner dormant until its own host abort
or teach composition a typed superseded result. Test supersession while the old
host signal is still live and prove no early composite exit/restart.

## P1-2 — An already-running async flush could cross the disposed fence

A debounce flush may already be awaiting persistent dedupe when disposal sets
the gate. `createIngressOnFlush` can then resume and ACK/dispatch without a
second fence, while the serialized dispatcher's settle callback can recursively
start a buffered follow-up.

**Required fix:** re-check activity after every await and immediately before ACK
or dispatch in flush/cancellation paths. Add a dispatcher-level close gate so
settle callbacks cannot start a follow-up. Pause a dedupe promise, dispose, then
resolve it and assert no ACK/dispatch/follow-up.

## P2-1 — Commit rollback could leave serving status or background cleanup

rev2 ordered map -> serving status -> primary. A primary failure after status
could leave `connected: true`. It also only started async disposal before
propagating, allowing the account task to terminate while resources remained.

**Required fix:** complete throwable internal publication and primary binding
before the final status write. On any failure, synchronously unpublish/fence,
rollback status, then await disposal before propagating. Test a post-status
failure seam and delayed disposer.

## P2-2 — Listener cleanup scope was contradictory

The plan said all listeners are removed on every connect settle, but a successful
connection must retain operational message/error/close listeners.

**Required fix:** remove only handshake abort/timeout/unexpected-response
listeners on connect settle. Keep operational listeners until socket close or
explicit disconnect. Drain/destroy unexpected HTTP upgrade responses/sockets and
test failure, abort, success, and disconnect listener ownership.

## P3-1 — `unknown` was absent from the failure discriminant

The policy used unknown as a separate branch while the type allowed only
transient/permanent/aborted.

## Round-1 verification

- Atomic register subscription: resolved.
- Complete teardown: partially resolved; in-flight async race remained.
- Registration-mode gate: resolved; generation identity regressed into the P0.
- Shared-audience semantics: resolved.
- Typed early close/connected fence: resolved.
- Established status: resolved.
- Same-generation duplicate lifetime: resolved; newer-generation composition
  was a new conflict.
- Secret-safe formatting and jitter interval: resolved.

All round-2 findings are accepted for rev3.
