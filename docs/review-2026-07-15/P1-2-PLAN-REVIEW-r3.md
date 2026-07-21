# P1-2 plan adversarial review — round 3

Reviewed the r2 revision against both prior reviews, the P1/P1-1 requirements and inherited semantics, the current enrollment/registry/HTTP/plugin implementations, and repository-wide consumer sweeps. Fixed product and scope decisions were treated as constraints.

## Round-2 finding verification

| r2 finding | Status | Verification |
|---|---|---|
| N1 pickup window / real plugin loop | **RESOLVED** | The plan now honestly keeps `expires_in` as the client deadline and limits retention to boundary grace plus idempotent recovery; test 25 is implementable without plugin source changes because the real loop checks the deadline **before** sleeping and can therefore send a final request after the sleep crosses it (`enrollment-client.ts:395–408`). |
| N2 committed payload binding | **PARTIAL** | Digest-before-recovery, all four inputs (including `expect`), and `CommitPayloadMismatchError` are coherent, but the persisted approved record still lacks the exact `AgentKeyRecord` that idempotent recovery promises to return (M1 below). |
| N3 repository-clock judgments | **RESOLVED** | Poll is exclusively `tryExpire`-based; claim/commit/deny/expire/sweep judgments are assigned to repository time, while issuer time only stamps `createdAt`/`expiresAt`. The expire-on-deny rule explicitly makes the transition repository-side. |
| N4 approve dispatch inventory | **RESOLVED** | `rg` finds three production dispatch files: the shared SaaS handler, webchannel example, and minimal consumer; the shared handler covers reference+demo. The plan names all three, requires exhaustive `never` guards, and adds direct handler test 22. Existing test `.approve()` calls inspect outcomes rather than dispatching them and are already covered by the test migration matrix. |
| N5 conformance harness | **PARTIAL** | Instance-scoped async clock and the harness-owned decorator are sufficient to order the listed public-operation/mint boundaries, but the factory does not expose the adapter's `retentionMs`, so tests 9/17 cannot portably drive the promised retention boundary (M2 below). |
| n1 diagram edge | **RESOLVED** | The diagram now explicitly includes `approving --tryDeny--> denied`. |
| n2 reconcile noop precedence | **RESOLVED** | Exact precedence is specified, including both-present → `active_present` and tombstone-only → `history_present`, and test 10 covers it. |
| n3 caller-supplied sweep time | **RESOLVED** | `sweep()` has no time argument and is required to use repository time; the current no-caller/background-timer model is carried forward without exposing a production caller clock. |

## BLOCKER

None.

## MAJOR

### M1. The approved operation result cannot reproduce the exact committed `AgentKeyRecord`

The idempotent branch promises to return the saved commit result exactly, including `CommitApprovalOutcome.record` (`P1-2-PLAN.md:152–155,215–222,552–559`). But the proposed `EnrollmentRecord` persists only `creds`, `peerId`, `approvedAt`, `committedBy`, and `commitDigest` (`:128–133,233–235,298–304`). It does not persist the committed registry `activationId` or an immutable copy/reference of the `AgentKeyRecord`.

Looking up history by public key is not an equivalent recovery contract. P1-1 permits same-key idempotency against the then-active record and later supersession; a key can also appear in more than one activation event unless it has been tombstoned. After later slot changes, neither `getActive` nor an unlinked history scan identifies which record this enrollment's commit returned. Thus an adapter cannot always satisfy “stored result 그대로” or test 3's “exactly same ... record” from the specified persisted fields.

**Concrete fix.** Persist `committedActivationId` (sufficient only if history lookup by unique activation ID is normative and history is permanent) or, more directly, persist the committed `AgentKeyRecord` snapshot as part of the approved operation result in the same transaction. State that idempotent recovery returns that snapshot even if the registry record is later superseded/revoked. Add a test: commit, supersede or revoke the slot, then retry the original opId+payload and require the exact originally returned record.

### M2. The portable harness cannot know or configure the retention boundary it must test

The conformance factory returns only `{ repo, close, clock? }` (`P1-2-PLAN.md:501–510`). Yet the normative eviction point and recovery horizon are expressed in terms of adapter-specific `retentionMs` (`:298–304`), and tests 9 and 17 require advancing to immediately before/after that point (`:580–585,612–614`). The harness has neither a requested configuration passed to `create()` nor returned retention metadata. It therefore cannot calculate those instants for a third-party adapter. Assuming Memory's inherited five-minute default would make the exported suite non-portable and would not verify an integrator's actual policy.

This also leaves the public guarantee quantitatively weak: an adapter can choose zero retention while still nominally satisfying “before `approvedAt + retentionMs`,” eliminating meaningful boundary grace and making ambiguous-commit recovery practically useless.

**Concrete fix.** Make retention a normative configured value, for example `create({ retentionMs, autoSweep: false })`, or return an authoritative `retentionMs` capability used by the suite. Specify a minimum/default recovery horizon (the inherited Memory default is five minutes if that is the intended product contract). Then have the clock suite test equality and strictly-after behavior against that known value, including idempotent recovery on both sides of the boundary.

## MINOR

### m1. `claimApproval` precedence is still ambiguous for an expired, live `approving` record

`ClaimApprovalOutcome.expired` says an elapsed `expiresAt` is transitioned when observed (`P1-2-PLAN.md:145–149`), while `tryExpire` protects `approving` until its lease expires (`:194–198`). `tryDeny` intentionally expires any past-`expiresAt` pending/approving record regardless of lease (`:190–193`), and `commitApproval` expires it after ownership/lease fencing (`:223–231`). The desired individual behaviors can be coherent, but `claimApproval` does not say whether a different claimant observing `expiresAt < now <= leaseUntil` gets `in_progress` or transitions to `expired`.

**Concrete fix.** Give `claimApproval` an explicit ordered decision table. A natural alignment with `tryExpire` is: approved/terminal handling; past-expiry pending → expired; live approving → in_progress even if `expiresAt` passed; expired-lease approving → expired if past `expiresAt`, otherwise reclaim. Add the live-lease/past-expiry boundary case.

### m2. The two-consecutive-throw integration case is not defined by the stated one-shot decorator

Test 14 requires two consecutive post-commit throws (`P1-2-PLAN.md:603–607`), while §2.7 defines the ambiguous-commit hook specifically as one-shot and auto-clearing (`:514–519`). This is implementable by stacking decorators or arming a counted hook, but neither mechanism is part of the proposed `interpose` contract.

**Concrete fix.** Publish the hook type and allow an explicit throw count/queue, or state that test 14 composes two one-shot decorators. Keep the after-hook conditional on a `committed` result so it models loss of a successful commit response rather than an arbitrary failed outcome.

## Predecessor consistency

The revised plan covers P1's P1-2 requirements: conditional claim/commit/deny transitions, operation ID and lease fencing, exact-result retry intent, approval plus registry activation in one commit, crash recovery, collision behavior, and an exported conformance suite. `recordPoll`/`slow_down` is explicitly deferred with the fixed plugin-compatibility justification; durable adapters remain integrator-owned as required.

P1-1 semantics are preserved: registry ordering remains tombstone > same-key idempotency > CAS; account remains the isolation axis; A2 reconciliation writes only for an approved record with both active and history empty; history/tombstones remain permanent; and reconciliation cannot resurrect a superseded or revoked key. Deny-of-approving is an explicit later product decision and does not alter approved/denied tombstone semantics.

## Verdict

**NEEDS_CHANGES** — 0 BLOCKER, 2 MAJOR, 2 MINOR.
