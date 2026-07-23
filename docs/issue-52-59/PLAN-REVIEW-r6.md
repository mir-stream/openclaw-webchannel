# Issues #52 + #59 plan adversarial review — round 6

> Verdict: **NOT CONVERGED**
> Findings: P0 0, P1 1, P2 0, P3 0
> Reviewer: sub-agent `/root/plan_adversarial_review`

## P1 — Host abort could not cancel Phase-C JWKS readiness work

rev6 moved JWKS readiness into private Phase C but did not thread the child/host
`AbortSignal` into it. Current `preflightResolveJwks` awaits
`JWKSCache.warm(10_000)` (`src/auth.ts:192-199`); URL fetch uses only its own
deadline (`src/jwks.ts:135-187`), and file/injected operations likewise had no
lifecycle cancellation. An abort after NATS handshake but during the warm could
therefore retain the established NATS socket and owner task past the pinned
host's five-second stop limit, because the attempt disposer was reached only
after the warm settled. Existing abort tests covered backoff/handshake, not this
only awaited Phase-C operation.

**Required fix:** make every Phase-C await, specifically JWKS URL headers/body
and file/injected reads, child-signal abortable while preserving the cache's
independent deadline and safe inflight sharing. Lifecycle abort must not be
logged as a JWKS readiness outage; it must immediately enter full attempt
disposal, publish no SUB/map/status, and fence all late results/cache effects.
Test never-settling URL headers/body/file operations, shared-subscriber
cancellation, prompt (<5s) task/transport settlement, and no late commit.

## Prior-round verification

rev6 otherwise closed round 5: reconnect suppression and physical socket
closure were distinct; graceful/forced shutdown was bounded and ready-state-
specific; closure evidence was close-event/`CLOSED` only; an unconfirmed close
released once, quarantined the account, retained a bounded cleanup handle, and
prohibited promotion/dial until a later probe proved closure. Round 1–4
ownership, commit, teardown, host-config, status/log, and isolation findings
remained resolved.

**Final verdict: NOT CONVERGED.**
