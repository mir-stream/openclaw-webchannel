# Issues #52 + #59 plan adversarial review — round 5

> Verdict: **NOT CONVERGED**
> Findings: P0 0, P1 1, P2 0, P3 0
> Reviewer: sub-agent `/root/plan_adversarial_review`

## P1 — Logical closed state did not prove physical socket closure

rev5 could have reported closure after setting a boolean and clearing the socket
reference even if `ws.close()` threw or never emitted close. A retry or promoted
waiter could then create a second authenticated connection while the first socket
and subscriptions remained live. Intentional abort incorrectly bypassed the same
physical-closure requirement.

**Required fix:** distinguish reconnect suppression from confirmed socket close;
capture the socket, wait a bounded graceful interval, escalate to `terminate()`/
underlying destruction, and confirm close event or `CLOSED`. A logical flag alone
is insufficient. Disposal never waits indefinitely. If closure is still
unproven, release exactly once but quarantine the account and promote/dial no
waiter until a later cleanup attempt proves closure or process exit lets the OS
close it.

Tests cover throwing/hung graceful close, successful/failed force termination,
logical-vs-physical state, conditional promotion, and release without promotion.

## Round-4 verification

All round-4 release/disposer-error findings were resolved except that the
closure evidence used to authorize retry/promotion was too weak. This finding is
accepted for rev6.
