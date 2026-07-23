# Issues #52 + #59 plan adversarial review — round 7

> Verdict: **NOT CONVERGED**
> Findings: P0 0, P1 1, P2 1, P3 0
> Reviewer: sub-agent `/root/plan_adversarial_review`

## P1 — A failed cleanup-probe invocation had no host-lifetime contract

rev7 kept the quarantine-causing task and pre-existing waiters dormant, but did
not define what a post-quarantine lifecycle invocation did after its bounded
probe again failed to prove closure. Returning/rejecting would make pinned core
report an account exit and manufacture finite auto-restart probes, contradicting
terminal quarantine and `restartPending: false`. Probe success also did not
define whether the probe was an ordinary eligible waiter or whether pre-
quarantine waiters were frozen/thawed.

**Required fix:** model every invocation as a waiter with an arrival token,
serialize one probe lease, keep failed-probe/current arrivals pending until their
own host abort, and permit only a strictly later arrival to probe. Define the
exact success eligibility set and probe self-promotion. Test failed-probe non-
settlement/no core-restart behavior, exact-once lease release/cutoff, concurrent
arrivals, abort, and self-promotion.

## P2 — Blanket transient early-close classification included structured permanent/unknown codes

rev7 made every pre-PONG close with no earlier cause transient, despite
separately declaring protocol violations permanent and unknown causes terminal.
RFC 6455 code 1002 is a structured protocol error and 1008 is policy violation;
retrying them forever violated the fixed retry decision.

**Required fix:** classify close codes before the disappearance default. Treat
protocol/data/size/extension incompatibilities as permanent, policy/reserved/
private/TLS-ambiguous codes as terminal unknown absent an explicit allowlist,
and only disappearance/server-restart/try-later codes as transient. Earlier
typed NATS/TLS/HTTP cause wins. Never expose raw close reasons. Add full matrix
and redaction tests.

## Prior-round verification

The rev7 subscriber-based, signal-aware JWKS operation contract closed round 6:
URL headers/body and file/injected waits were bounded by both lifecycle abort and
source deadline; subscriber cancellation did not cancel survivors; last-
subscriber abort fenced late cache writes/clears; lifecycle abort immediately
disposed the private connected attempt with no readiness diagnostic or commit.
All round 1–6 findings otherwise remained closed.

**Final verdict: NOT CONVERGED.**
