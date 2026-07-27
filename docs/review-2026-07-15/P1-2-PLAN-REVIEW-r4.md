# P1-2 plan adversarial review — round 4

Reviewed the r3 plan against all three prior reviews, the P1/P1-1 requirements, and the required current source files. Previously accepted product and architecture decisions were treated as fixed.

## Round-3 finding verification

| r3 finding | Status | Verification |
|---|---|---|
| M1 exact committed `AgentKeyRecord` recovery | **RESOLVED** | `EnrollmentRecord.committedRecord` is an immutable snapshot persisted by the same commit transaction; fencing rule 1 and `CommitApprovalOutcome` require returning it after later supersession/revocation, test 3 exercises that case, and the completion conditions repeat the exact-result guarantee. |
| M2 portable retention configuration | **RESOLVED** | §2.3 makes `retentionMs` a normative configured value with a 300,000 ms product default and AUTH.md floor guidance; §2.7 requires `create({ retentionMs, autoSweep: false })`, and tests 9/17 plus the completion conditions use that configured horizon. |
| m1 `claimApproval` precedence | **RESOLVED** | The ordered first-match decision table completely specifies absent, terminal, pending, and approving records across expiry and lease boundaries; test 2-v covers all three formerly ambiguous approving cases. |
| m2 consecutive post-commit throws | **RESOLVED** | §2.7 defines `throwAfterCommit({ times })` as a counted, auto-clearing hook that fires only after a `committed` outcome; test 14 explicitly uses `times:1` and `times:2`. |

## State × time coherence matrix

No contradictions or undefined cells. `pending` has no lease dimension; `approved`, `denied`, and `expired` ignore both expiry and lease for claim purposes; every `approving` combination is covered by live/exhausted lease first and then expiry. The differing live-lease/past-`expiresAt` effects of `claimApproval`/`tryExpire`, `tryDeny`, and owner `commitApproval` are explicit policy choices, not conflicting rules: another claimant and poll cannot terminate live work, an operator may deny it, and the live owner may reach commit rule 3 and expire it.

## BLOCKER

None.

## MAJOR

None.

## MINOR

### n1. The exact sweep boundary is described with conflicting inclusivity

§2.3 says approved records cannot be evicted **before** `approvedAt + retentionMs`, which permits eviction at equality, while the same section and completion conditions say recovery is guaranteed **through** that horizon (`...까지`), which implies equality is retained. Test 9 asks for equality/strictly-after comparisons but does not state the expected equality result. The same operator should also be made explicit for `expiresAt + retentionMs` on pending/denied/expired records. Different adapters could otherwise disagree at the exact millisecond while passing a plausible reading of the contract.

**Fix:** define one operator normatively, preferably “retain while `now <= base + retentionMs`; evict only when `now > base + retentionMs`,” and state those expected outcomes in test 9 (and test 17 where applicable).

## Verdict

**CONVERGED** — 0 blocker, 0 major, 1 minor.
