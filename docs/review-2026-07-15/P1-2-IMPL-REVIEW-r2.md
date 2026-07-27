# P1-2 implementation review r2

Reviewed HEAD `4351a8f` against `P1-2-PLAN.md` (CONVERGED r4), including the full implementation range `66605aa..4351a8f` and the r1 remediation range. The implementation itself is substantially aligned, but the exported adapter certification surface still does not enforce several atomicity/race clauses it advertises.

## r1 verification

| r1 item | Status | Verification |
|---|---|---|
| MAJOR — workspace typecheck failed | **RESOLVED** | The duplicate minimal-consumer import is removed; root `npm run typecheck` exits 0 across all workspaces, examples, and demo. |
| MAJOR — exported conformance suite was incomplete | **PARTIAL** | Cases 1–10 plus fault, mandatory controlled clock, configured retention boundaries, and public cases/types/barrier exports now exist. However, cases 4, 9, and 10 still permit materially broken atomic/race implementations; see the MAJOR finding below. |
| MAJOR — opId violated the identity contract | **RESOLVED** | `device-flow-enrollment.ts:504-508` uses 16 crypto-random bytes encoded as unpadded base64url; `device-flow-enrollment.test.ts:942-958` checks 22-character format, 16 decoded bytes, and uniqueness. `generatePeerId()` correctly remains UUID-based. |
| MINOR — stale four-state documentation/comments | **RESOLVED** | `packages/saas/README.md:108-121` and `device-flow-enrollment.ts:438-461,551-565` describe the five-state machine, repository fencing/clock, advisory lock, retention, and deny-of-approving. |
| Plan-test mapping audit | **PARTIAL** | The strengthened repository/integration/consumer tests now materially cover the flagged 2, 3, 6, 11, 15–17, 18–20, 22, 23, and 25 clauses. Cases 9 and 10 are named and partially exercised, but their exported race assertions remain vacuous or too weak; exported case 4 also does not prove failure atomicity. |

## New findings

### MAJOR — The public conformance runner can still certify non-atomic and resurrection-prone adapters

The expanded suite has the right case names and deterministic clock plumbing, but important assertions do not observe the prohibited side effects:

- In case 4, conflict and revoked only assert the returned outcome and that the enrollment returned to `pending` (`packages/saas/src/enrollment-repository-conformance.ts:161-168`). They never assert that active/history are unchanged. An adapter that activates a key and then returns `conflict` or `revoked` passes. The `claim_lost` branch checks only its outcome and does not bind it to an existing enrollment or assert mutation-free state. Thus a non-atomic commit adapter can pass the advertised failure-atomicity case.
- The sweep/commit “race” in case 9 starts both calls immediately while the claim and enrollment are still live, accepts three outcomes, and asserts no final-state/history invariant (`enrollment-repository-conformance.ts:214-216`). It neither advances to a sweep boundary nor uses the exported barrier, so it cannot detect sweep loss or partial commit behavior.
- The reconcile/register “races” are sequential calls, not interposed races, and the assertion merely requires that *some* result look successful plus one active row (`enrollment-repository-conformance.ts:225-231`). A broken reconciliation that overwrites/supersedes a register-first different key can still leave one active row and pass, even though register-first must force reconciliation to `noop("active_present")`; reconcile-first must make the later `register(expect=null)` conflict.
- Case 6 labels itself “both orders” but uses ordinary sequential calls and does not assert history/credentials for both serializations (`enrollment-repository-conformance.ts:177-185`). The memory-specific integration test is stronger, but it cannot certify a third-party adapter.

This is public API correctness, not merely test thoroughness: README directs durable adapter authors to this runner. A passing result currently overstates what was verified, including the central atomic-enrollment guarantee.

Concrete fix: strengthen the exported cases with before/after enrollment, active, and append-only history snapshots for every failure outcome; make claim-lost use a real claimed record; drive sweep/commit and deny/commit serializations with controlled clock plus barriers and assert the exact allowed terminal projection; and assert exact loser outcomes/key identity in both reconcile/register orders. Add harness self-tests using deliberately broken repository decorators/fakes (register-before-conflict, stale-commit acceptance, retention ignored, and reconcile overwrite) and require each relevant case to reject them.

### MINOR — The exported clock contract is stricter than the settled plan and its own README

`EnrollmentRepositoryConformanceOptions.create()` now requires `clock` unconditionally (`packages/saas/src/enrollment-repository-conformance.ts:43-46`), while the converged plan §2.7 and README describe clock support as optional for durable adapters and clock cases as skippable/recommended. This makes the public type incompatible with the documented durable-adapter contract and may force integrators to expose a controllable database clock even to run core/fault cases.

Concrete fix: either restore optional `clock` and have the convenience runner explicitly select/skip clock cases while still requiring it for direct clock-case execution, or update the converged public documentation and provide separate `runCoreAndFault`/`runClock` entry points so the requirement is honest and usable.

## Additional attack notes

- Memory fencing order matches plan §2.2: approved idempotent recovery precedes fencing; lease ownership/equality precedes enrollment expiry; payload binding precedes registry precedence (`enrollment-repository.ts:158-190`).
- The claim decision table and retention equality are correctly ordered in the memory implementation (`enrollment-repository.ts:121-144,220-230`).
- Digest construction explicitly orders all required logical fields, including `expect` and permissions (`enrollment-repository.ts:71-83`); no collision between distinct well-typed payloads was found.
- `interpose` throws only after a resolved committed result and preserves target method binding (`enrollment-repository-conformance.ts:18-40`). `barrier()` is deterministic and idempotently resumable; no wall-clock sleeps are used by the exported cases.
- DeviceFlowEnrollment retries an ambiguous commit once with the same payload and propagates a second throw (`device-flow-enrollment.ts:541-548`), and the strengthened integration tests cover one- and two-fault behavior.
- Barrel exports now include cases, option/case/fault types, `interpose`, and `barrier` (`packages/saas/src/index.ts:60-72`); consumer dispatch tests cover the shared handler, webchannel app, and minimal consumer.

## Validation

- Root workspace typecheck: **PASS** (`npm run typecheck`, exit 0).
- Broad test run with the four instructed exclusions: **1,483 passed across 105 files**. Two additional socket-bound suites (`packages/plugin/src/nats-cutover-e2e.test.ts` and `packages/plugin/src/nats-transport-realserver.test.ts`) failed/skipped solely because listening/real-server startup is unavailable in this sandbox (11 failed, 3 skipped). No non-socket failure was observed.
- Advisor-provided full SaaS result: **242 passed across 21 files**, noted but not independently claimed.

## Verdict

**NEEDS_CHANGES** — 0 BLOCKER, 1 MAJOR, 1 MINOR.
