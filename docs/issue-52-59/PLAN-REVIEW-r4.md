# Issues #52 + #59 plan adversarial review — round 4

> Verdict: **NOT CONVERGED**
> Findings: P0 0, P1 1, P2 0, P3 0
> Reviewer: sub-agent `/root/plan_adversarial_review`

## P1 — Cleanup failure could orphan the owner lease forever

rev4 retained the lease through disposal, but did not guarantee release and
waiter promotion if status, primary recomputation, listener cleanup, cancellation,
or `dispose()` rejected. Core would see a still-live replacement task dormant
behind an owner whose code had exited, so neither plugin nor finite core restart
could recover it.

**Required fix:** release in `finally`, exactly once. `dispose()` is an idempotent
shared promise that attempts every cleanup phase and forces transport closure in
its own `finally`. Intentional-stop cleanup errors are sanitized/logged but do
not block release. Retry/rollback proceeds only when closure is proven; otherwise
it becomes a terminal invariant/unknown failure without retaining the lease.
Promotion errors cannot leave a half owner.

Tests inject failure at every cleanup phase and prove all remaining phases run,
runtime/primary remain unpublished, release settles once, one highest eligible
waiter is promoted, stale/aborted waiters are not, and old cleanup cannot delete
the promoted runtime.

## Round-3 verification

All round-3 findings were resolved for successful cleanup. Only cleanup-failure
release remained open. This finding is accepted for rev5.
