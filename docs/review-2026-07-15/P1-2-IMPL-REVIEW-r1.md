# P1-2 implementation review r1

Reviewed commit `a1c5608` against `P1-2-PLAN.md` (CONVERGED r4). I inspected the implementation and numbered tests and ran the non-socket focused suite (113 tests passed). The workspace typecheck did **not** pass.

## Findings

### MAJOR — The committed workspace does not typecheck

Evidence: `examples/minimal-consumer/src/operator.ts:17-18` imports `MemoryEnrollmentRepository` twice. `npm run typecheck` fails in `@mir-stream/webchannel-example-consumer` with `TS2300: Duplicate identifier 'MemoryEnrollmentRepository'` at both lines. This contradicts the plan's consumer-migration/typecheck gate and means a shipped example consumer cannot compile.

Concrete fix: remove the duplicate import, then rerun the root `npm run typecheck` (including examples and demo) from a clean checkout of the reviewed commit.

### MAJOR — The exported conformance suite can certify adapters that violate most repository contracts

Evidence: `packages/saas/src/enrollment-repository-conformance.ts:58-88` exports only four cases: claim exclusivity, a partial lease-boundary case, basic payload-bound idempotency, and one ambiguous-commit fault. The plan §2.7/§3 requires the exported adapter suite—not merely tests coupled to `MemoryEnrollmentRepository`—to enforce retention configuration/boundaries, the full claim table and fencing cases, all failure atomicity, registry precedence, deny/expire matrices, insertion collisions, reconciliation precedence/races, live-lease sweep protection, and history invariants. Those checks mostly appear only in `enrollment-repository.test.ts`, which directly constructs the memory implementation and therefore cannot validate a third-party adapter. In particular, `runEnrollmentRepositoryConformance()` passes `retentionMs: 50` and `autoSweep:false` at `enrollment-repository-conformance.ts:91`, but no exported case calls `sweep()` or proves either setting is honored. An adapter that ignores both settings and implements deny/expire/reconcile incorrectly can still pass the advertised conformance runner.

The public barrel compounds the portability gap: `packages/saas/src/index.ts:60` exports the runner, decorator, and hook type, but not `enrollmentRepositoryConformanceCases`, `EnrollmentRepositoryConformanceOptions`, `EnrollmentRepositoryConformanceCase`, or `barrier`, despite the source comment at `enrollment-repository-conformance.ts:54-57` claiming third-party runners can expose the individually named cases.

Concrete fix: move/encode all plan §3 repository cases 1-10 in `enrollmentRepositoryConformanceCases`, including deterministic clock and race variants; make clock availability mandatory for clock cases rather than silently returning; export the cases, option/case types, barrier, and fault-control type through the barrel. Keep memory-specific tests as tests of the reference implementation, not substitutes for adapter conformance.

### MAJOR — Approval operation IDs do not meet the fixed identity contract

Evidence: `packages/saas/src/device-flow-enrollment.ts:514` uses `crypto.randomUUID()`. Plan §2.3/§2.4 requires a crypto-random **128-bit base64url** opId per call. UUID v4 fixes version/variant bits (122 random bits) and is hyphenated hexadecimal, not base64url. This is a direct divergence in the identifier that provides global operation identity for fencing/idempotent recovery.

Concrete fix: generate `randomBytes(16).toString("base64url")` (or equivalent Web Crypto 16-byte generation with base64url encoding) once per `approveInner` invocation, and add a test that captures opIds and asserts 16 decoded bytes, base64url form, and per-call uniqueness.

### MINOR — Shipped documentation and source comments still describe the removed state machine

Evidence: `packages/saas/README.md:97-115` says the server creates `PendingEnrollment` and documents only `pending -> approved | expired | denied`, omitting `approving`, claims, leases, and deny-of-approving. `packages/saas/src/device-flow-enrollment.ts:441-462` likewise says correctness comes from the process-local lock, says approval past `expiresAt` is rejected before the approved guard, and describes transitions from only pending/approved. The implementation now correctly treats the lock as advisory and returns already-approved independent of `expiresAt`, so these comments actively misstate shipped behavior.

Concrete fix: update the README state diagram and approve documentation to the five-state repository machine, repository-clock authority, advisory lock, lease fencing, approved retention behavior, and deny-of-approving semantics.

## Plan-test mapping audit

The following numbered plan tests are missing or materially weaker than specified:

- **2** — no deterministic commit-vs-reclaim both-order barrier case; no assertion that the stale commit leaves state unchanged in every fencing branch.
- **3** — revoke snapshot recovery exists, but the required supersede-then-retry snapshot case is absent; exact persisted creds/peerId are not inspected in the repository test; the exported conformance case omits supersede/revoke, other-opId, and opId-reuse clauses.
- **4** — memory tests cover several outcomes, but the exported conformance suite does not cover conflict/revoked/expired/claim_lost failure atomicity.
- **5** — same-key and tombstone cases are memory-only; the exported adapter suite does not test commit-path precedence/CAS outcomes.
- **6** — no deterministic deny-vs-commit both-order barrier case in conformance; several terminal cells and deny-vs-mint are only indirectly or incompletely covered.
- **7** — the complete expire matrix is memory-only and absent from exported conformance.
- **8** — name-matched cross-package collision errors and “new insert only” are not fully asserted; collision checks are absent from exported conformance.
- **9** — equality poll response is not checked alongside sweep, approved base-at-`approvedAt` near-expiry is not pinned, sweep-vs-commit is absent, and all retention checks are absent from exported conformance despite `create(config)` being its normative purpose.
- **10** — reconcile-vs-register both orders are absent; precedence is checked as separate setups rather than adversarial combined-state precedence; all reconciliation checks are absent from exported conformance.
- **11** — the lock-bypass test asserts one approved/one in-progress and one history row, but does not count mint calls or retry the loser and compare exact creds with the winner and poll result as required.
- **12** — approve/deny orders are covered, but not with the specified commit barrier and exact terminal/creds assertions for both serializations.
- **15** — conflict gate is tested; the revoked-key gate's release/pending/no-mint clauses are not mapped equivalently.
- **16** — only the ordinary active-present already-approved path is exercised; the four reconciliation outcomes inherited from the planned A2 integration coverage are not exercised through `DeviceFlowEnrollment`.
- **17** — approved-after-expiry and pending expiry are tested, but the required issuer-clock-skew sub-assertion is missing (repository and mocked issuer clocks move together); retention-boundary poll behavior is also not tied to configured sweep boundaries.
- **18** — deny/late-commit is exercised, but the required explicit “mint completed, then deny, then commit” ordering is not pinned separately from the paused mint case.
- **19** — the named test merely observes an already-approved `tryExpire` result; it does not force the stale-expiry/commit interleaving in both orders.
- **20** — claim loss/no fake approval is covered, but the planned sweep-loss interleaving and allowed terminal outcomes are not exercised.
- **21** — `approveInner` bypasses the lock, but the test remains weaker than test 11's required exact credential/mint invariants.
- **22** — shared handler has a focused test, but there are no equivalent runtime dispatch tests for the webchannel app; the minimal-consumer test is undermined by that consumer not compiling.
- **23** — the boundary test checks selected removed/new runtime symbols but does not prove the complete promised barrel, notably the public conformance cases/options/case/barrier exports.
- **25** — the plugin test mocks a successful late poll response; it does not integrate the real SaaS poll/repository behavior that makes a post-`expiresAt` arrival succeed.
- **26** — real-server/e2e execution was outside this sandbox, as expected; no independent result is claimed here.

## Validation

- Focused non-socket tests: **113 passed** across enrollment repository, atomic integration, device flow, HTTP dispatch, plugin polling, and minimal-consumer handler selections.
- Root typecheck: **failed** with the duplicate identifier described above. The remaining workspace typechecks continued, but the root command exited nonzero.
- `git diff --check 66605aa..a1c5608`: clean.

## Verdict

**NEEDS_CHANGES** — 0 BLOCKER, 3 MAJOR, 1 MINOR.
