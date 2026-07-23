# Issues #52 + #59 plan adversarial review — round 3

> Verdict: **NOT CONVERGED**
> Findings: P0 0, P1 1, P2 2, P3 2
> Reviewer: sub-agent `/root/plan_adversarial_review`

The reviewer verified round 2, then re-read rev3 against current source and the
exact pinned host. No files were modified by the reviewer.

## P1 — Immediate takeover conflicted with owner-fenced cleanup

rev3 allowed a newer generation to replace an aborted owner before its disposer
released the lease, while old cleanup required current-owner identity. The old
runtime could remain in the map/primary forever if the new account retried or
failed permanently.

**Required fix:** an owner retains its lease through cleanup. Host abort first
synchronously unpublishes its runtime, then awaits disposal and releases. Only
release promotes the newest eligible waiter. Cover delayed cleanup and same-
generation replacement.

## P2-1 — Invalid-ID reporting could break enumeration without full install

The injected `listAccountIds` reporter was generation-scoped but discovery mode
registers the channel without calling `registerFull`. A missing snapshot or a
throwing reporter/logger could make enumeration throw and suppress valid IDs.

**Required fix:** compute IDs independently, make each report best-effort and
exception-isolated, and no-op without a full snapshot. Test discovery/no-snapshot,
throwing reporter/logger, mixed valid/invalid, and all-invalid.

## P2-2 — Auto-reconnect could hide a pre-commit disconnect

Checking only current `transport.connected` permits PONG -> drop -> reconnect ->
commit during awaited JWKS work.

**Required fix:** a sticky pre-commit disconnect/connection-epoch fence poisons
the attempt even if it reconnects. The private listener should also disconnect
to suppress its reconnect loop. Test full reconnect before JWKS resolution.

## P3-1 — Phase A used stale wording

“Installed config generation” contradicted authoritative `ctx.cfg`.

## P3-2 — A stale-completion test omitted the host-abort/release prerequisite

The test implied a new generation could start while the old live owner still
held the slot, contrary to the wait policy.

## Round-2 verification

- Structural full-install token and authoritative `ctx.cfg`: resolved.
- `A -> B -> A`: resolved.
- Live-host supersession/composition: partially resolved; aborted-owner transfer
  was inconsistent.
- Async flush fences, commit rollback, listener ownership, and unknown failure:
  resolved.

All round-3 findings are accepted for rev4.
