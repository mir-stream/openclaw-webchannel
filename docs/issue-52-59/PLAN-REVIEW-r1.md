# Issues #52 + #59 plan adversarial review — round 1

> Verdict: **NOT CONVERGED**
> Findings: P0 0, P1 5, P2 3, P3 1
> Reviewer: sub-agent `/root/plan_adversarial_review`

The reviewer read the complete plan, current source, and the exact pinned
`openclaw@2026.6.10` package. No files were modified by the reviewer.

## P1-1 — The proposed commit was externally visible before it was atomic

The draft subscribed the register subject in private Phase C, then awaited JWKS
readiness before the Phase D ownership/abort fence. `subscribeRegister()` calls
`transport.subscribe(...)` immediately, so a browser could register, create peer
state, and trigger snapshots before the runtime appeared in the coordinator.

**Required fix:** keep handlers and JWKS warming private, but move the register
subscription into the final synchronous commit: fence -> subscribe -> map/status/
primary publication, with no `await`. If subscribe throws, publish nothing and
dispose the transport. Add delayed-JWKS and pre-commit-abort tests.

## P1-2 — Disconnecting the transport did not dispose queued inbound work

The current builder creates an inbound debouncer and serialized dispatcher. The
pinned debouncer has no bulk disposer. Disconnecting NATS alone can leave a
debounce timer or queued follow-up that later dispatches an inbound turn or ACK.

**Required fix:** every private/published runtime must own an idempotent async
`dispose()`. Track observed peer keys, cancel all debounce keys, clear dispatcher
pending work, gate already scheduled flushes/handlers after disposal, remove
transport listeners, then disconnect. Add a pending-debounce teardown test that
advances timers and observes no inbound/publish/remaining timer.

## P1-3 — Registration mode and generation identity were underspecified

The exact pinned entry wrapper calls `registerFull` in `tool-discovery` as well
as `full` registration. Tool-discovery does not provide a live hydrated channel
runtime and must not replace a live coordinator generation. The draft also did
not define how two full calls represent the same generation.

**Required fix:** ignore every `api.registrationMode !== "full"` call for
runtime installation. Tie generation identity to explicit config identity, not
invocation count. Same-config full re-registration may refresh a future-start API
reference but must not invalidate active work. Add pinned-contract tests showing
tool-discovery and same-config full calls leave active owner/runtime state intact.

## P1-4 — Shared-audience behavior changed without approval

Current runtime behavior warns on duplicate effective `(issuer, audience)` and
continues serving. The draft made the lexicographically later account terminal,
contradicting its own non-goal of preserving auth/admission semantics and allowing
another account's state to suppress a healthy account.

**Required fix:** retain the current warning plus doctor error behavior in this
scope. Do not include shared audience in terminal preflight. A fail-closed winner
policy requires a separate product decision/change.

## P1-5 — Common early-close failures could still become terminal unknowns

Current pre-handshake close is a plain error and there is no structured
`unexpected-response` error. Because unknowns are terminal, an early close or
HTTP 503 upgrade could reproduce #59. The commit fence also omitted a live
`transport.connected` check, so a PONG followed by a drop during JWKS warming
could publish a disconnected runtime.

**Required fix:** define typed initial-connect errors for early close,
unexpected HTTP response, socket/DNS/TLS/timeout, and NATS `-ERR`. Preserve an
earlier permanent cause instead of overwriting it with a later close. Treat
408/429/5xx upgrade failures as transient and define 401/403 as permanent auth.
Require `transport.connected` at commit; a post-PONG/pre-commit disconnect starts
a fresh attempt. Test early close, HTTP 503, 401/403, and PONG-drop-before-commit.

## P2-1 — Serving snapshots would become stale after disconnect

The draft covered startup status only. Current established disconnect/reconnect
listeners log but do not update OpenClaw status, leaving `connected: true` after
a drop.

**Required fix:** fenced listeners update `connected`, `lastDisconnect`,
`lastConnectedAt`, and `lastError`; stale/aborted listeners do nothing and are
removed by `dispose()`. Every `ctx.setStatus` call includes `accountId`, as
required by the pinned SDK type. Add disconnect/reconnect/stale-owner tests.

## P2-2 — The duplicate task's lifetime was undefined

The draft prevented a second owner but did not say what the second
`startNatsAccount` call returns. Early return would look like an unexpected
channel exit and trigger core restart behavior.

**Required fix:** a duplicate same-generation/account invocation does no work
and waits dormant for its own abort before resolving normally. Test both the
absence of a second dial and the duplicate task's settle behavior.

## P2-3 — Secret-safe logging omitted URL userinfo/path and log injection

URL username/password/path/fragment can contain secrets even when query strings
are hidden. Invalid account IDs can contain control characters; the current
doctor formatter interpolates `accountId` raw into its prefix.

**Required fix:** display only URL protocol, hostname, and explicit port. Render
invalid IDs through one control-safe JSON encoder in every boot/doctor fallback,
including the doctor prefix. Add URL userinfo/query and newline-ID tests.

## P3-1 — Full-jitter interval notation

`Math.random()` produces `[0, 1)`, so the test interval is `[0, ceiling)`, not
`[0, ceiling]`.

## Round-1 disposition

All P1/P2 findings are accepted as behavior-affecting. P3-1 is accepted as an
editorial correction. The plan must be revised and reviewed in full again.
