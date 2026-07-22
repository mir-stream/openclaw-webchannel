# P1-2 implementation review r3

| Finding | Status (RESOLVED / PARTIAL / NOT RESOLVED) | one-line evidence |
|---|---|---|
| r2 MAJOR — exported conformance cases 4/6/9/10 could certify non-atomic or resurrection-prone adapters | RESOLVED | Case 4 compares enrollment, active key, and history projections for conflict/revoked/expired/real reclaimed-claim fencing (`packages/saas/src/enrollment-repository-conformance.ts:174-198`); cases 6, 9, and 10 force both call orders with barriers and assert terminal credentials plus activation/history identity (`packages/saas/src/enrollment-repository-conformance.ts:207-230,248-307`). The honest full suite and all four negative self-tests passed when run. |
| r2 MINOR — controlled clock was mandatory contrary to the plan | RESOLVED | The capability is optional, direct clock-case execution fails through `requireClock`, and the runner visibly reports and returns every skip (`packages/saas/src/enrollment-repository-conformance.ts:43-63,318-334`); its self-test covers both paths (`packages/saas/src/enrollment-repository-conformance.selftest.test.ts:72-77`). README and AUTH state core+fault mandatory and clock recommended (`packages/saas/README.md:251-273`; `docs/AUTH.md:39-43`). |

## New findings

### MINOR — The non-atomic-conflict negative adapter fails before proving that the registry projection assertion detects its advertised defect

The proxy says it models a split transaction that durably activates a key and then reports `conflict`, but it registers the new key and returns without releasing the approval claim (`packages/saas/src/enrollment-repository-conformance.selftest.test.ts:22-29`). Consequently case 4 first rejects it because the enrollment remains `approving` instead of the required claim-released `pending` state (`packages/saas/src/enrollment-repository-conformance.ts:181-185`); the later active/history assertion is never reached. Thus the exported case is substantively strong, but this particular mutation test does not prove the newly added registry-side assertion is what kills the split-write defect. Make the broken proxy release the matching claim (or otherwise produce the exact expected pending enrollment) before leaving the unauthorized activation durable, and assert the rejection message is `conflict mutated registry/history` rather than accepting any conformance error (`packages/saas/src/enrollment-repository-conformance.selftest.test.ts:66-69`). Apply the same message-specific pattern to the other negative adapters so fixture drift cannot create false-positive mutation coverage.

No source regression was introduced by `8d66ff8`: the remediation range changes only conformance/self-test/barrel/docs (`docs/AUTH.md`, `packages/saas/README.md`, `packages/saas/src/enrollment-repository-conformance.selftest.test.ts`, `packages/saas/src/enrollment-repository-conformance.ts`, and `packages/saas/src/index.ts`, plus the r2 review report). Static review found README, AUTH, and CHANGELOG consistent with the shipped atomic repository, deny-of-approving, approved-retention, optional-clock, and breaking-export semantics (`packages/saas/README.md:111-119,148-151,249-282`; `docs/AUTH.md:35-45`; `CHANGELOG.md:26-34`). Executed verification: the non-socket SaaS subset passed 18 files / 202 tests with 2 sandbox-related HTTP skips, and root `npm run typecheck` exited 0.

PASS

The r2 correctness gaps are resolved and no blocker or major remains; the sole new issue is a mutation-test fidelity weakness, not a shipped SPI or conformance assertion defect.
